// Public (base / competitive) XP and level: what OTHER players see.
//
// The account's `xp` is the true total, including private profile bonuses (Founder). Public surfaces
// (catch-card level-ups, /profile, /inventory) must never reveal those bonuses, so they read `publicXp`:
// the sum of the base rewards the player was actually shown. For normal and test profiles the profile
// multipliers are 1, so publicXp === xp exactly. The private /fishing-stats shows both.
//
// publicXp is written in the same atomic commit as xp (cast.js) and initialised for existing accounts by
// an additive, idempotent migration (xp minus every profile bonus recorded in the cast journals). A cast
// on a document without the field first sets publicXp = xp in the same session (F4), so it starts from
// the document's own xp, never from 0. A one-time reconcile (reconcilePublicXp) repairs the documents
// the earlier code left wrong, and checkPublicXp reports members whose publicXp != xp at boot.
//
// The public level is max(stored publicLevelFloor, curve(publicXp)), like the real level (levels.js).
const { curveLevel, floorOf, progressText } = require('./levels');

/** The profile XP bonus one cast journal recorded (every result shape since the Phase 2 journal). */
function journalProfileBonus(result) {
	const xp = result?.rewards?.xp;
	if (xp && Number.isFinite(xp.profileBonus)) return Math.max(0, xp.profileBonus);
	// Phase 3 results (before the base/final breakdown): recover the base from the recorded multipliers.
	const m = result?.modifiers;
	const prof = m?.xp?.profile;
	if (Number.isFinite(prof) && prof !== 1 && result.xp) {
		const catchBase = Math.floor((result.xp.base || 0) * ((m.xp.multiplier || prof) / prof));
		const questProfile = (m.sources || []).find((x) => x.source === 'profile')?.multipliers?.questXp || 1;
		const questFinal = (result.quests || []).reduce((a, q) => a + (q.xp || 0), 0);
		const questBase = (result.quests || []).reduce((a, q) => a + Math.floor((q.xp || 0) / questProfile), 0);
		return Math.max(0, (result.xp.catch || 0) - catchBase) + Math.max(0, questFinal - questBase);
	}
	return 0;
}

/** Base (public) XP a cast result awards: rewards.xp.base, or total minus the recorded bonus. */
function publicXpOfResult(result) {
	const base = result?.rewards?.xp?.base;
	if (Number.isFinite(base)) return base;
	return Math.max(0, (result?.xp?.total || 0) - journalProfileBonus(result));
}

/** A player's public XP (falls back to xp for a document the migration has not reached: never ahead of xp). */
function publicXpOf(user) {
	const xp = user?.xp || 0;
	return Number.isFinite(user?.publicXp) ? Math.min(user.publicXp, xp) : xp;
}

/** The public level: max(stored publicLevelFloor, curve(publicXp)). */
const publicLevelOf = (user) => Math.max(floorOf(user?.publicLevelFloor), curveLevel(publicXpOf(user)));

/** "progress / needed" to the next public level (same formula as User.getXPToNextLevel). */
function publicProgressOf(user) {
	return progressText(publicXpOf(user), publicLevelOf(user));
}

/**
 * Migration: every account without publicXp gets xp minus the profile bonuses of its APPLIED cast journals
 * (clamped to [0, xp]). Normal/test accounts therefore get publicXp = xp exactly. Pending journals whose
 * user update has NOT committed are applied later by the cast engine, which adds their base XP then. A
 * pending journal whose user update already committed (crash between the commit and 'applied') is not
 * counted here, so its profile bonus stays in publicXp; reconcilePublicXp counts it (F4). Idempotent:
 * only documents without the field are touched, with a guarded update.
 */
async function migratePublicXp({ UserModel, Cast }) {
	const users = await UserModel.collection.find({ publicXp: { $exists: false } }, { projection: { userId: 1, xp: 1 } }).toArray();
	let withBonus = 0;
	for (const u of users) {
		let bonus = 0;
		const journals = Cast.collection.find({ userId: u.userId, status: 'applied' }, { projection: { result: 1 } });
		for await (const j of journals) bonus += journalProfileBonus(j.result);
		const xp = u.xp || 0;
		const publicXp = Math.min(xp, Math.max(0, xp - bonus));
		if (bonus > 0) withBonus++;
		await UserModel.collection.updateOne({ _id: u._id, publicXp: { $exists: false } }, { $set: { publicXp } });
	}
	return { scanned: users.length, withBonus };
}

/** True when a journal's user update has committed: applied, or pending with its key on the user's guard. */
function journalCommitted(journal, userDoc) {
	if (journal.status === 'applied') return true;
	const key = String(journal._id);
	return (userDoc.appliedOps || []).includes(key) || (userDoc.appliedCasts || []).includes(key);
}

/**
 * The publicXp an account should have: xp minus the profile bonuses of every cast journal committed to
 * it since its last developer `xp.set` (which sets xp and publicXp to the same value), clamped to [0, xp].
 * Returns { publicXp, bonus }.
 */
async function expectedPublicXp(userDoc, { Cast, DevAudit }) {
	const lastSet = DevAudit
		? await DevAudit.collection.find({ target: userDoc.userId, operation: 'xp.set' }).sort({ timestamp: -1 }).limit(1).next()
		: null;
	let bonus = 0;
	const journals = Cast.collection.find({ userId: userDoc.userId, status: { $in: ['applied', 'pending'] } }, { projection: { result: 1, status: 1, createdAt: 1 } });
	for await (const j of journals) {
		if (!journalCommitted(j, userDoc)) continue;
		const at = j.createdAt || (j.result?.createdAt ? new Date(j.result.createdAt) : null);
		if (lastSet && at && at <= lastSet.timestamp) continue;
		bonus += journalProfileBonus(j.result);
	}
	const xp = userDoc.xp || 0;
	return { publicXp: Math.min(xp, Math.max(0, xp - bonus)), bonus };
}

/**
 * One-time reconcile (F4). Accounts whose committed journals carry no profile bonus (members) get
 * publicXp = xp in one atomic pipeline update. An account with profile bonuses (a Founder) is recomputed
 * from its journals (expectedPublicXp) with a compare-and-set on xp, so a concurrent cast is never
 * overwritten (retried on a fresh read). Every recomputed account is returned for the audit record.
 * Idempotent by construction; the caller guards it with a marker so it runs once.
 */
async function reconcilePublicXp({ UserModel, Cast, DevAudit }) {
	const users = await UserModel.collection.find({}, { projection: { userId: 1, xp: 1, publicXp: 1, appliedOps: 1, appliedCasts: 1 } }).toArray();
	let members = 0;
	let membersChanged = 0;
	const recomputed = [];
	for (let u of users) {
		let { publicXp, bonus } = await expectedPublicXp(u, { Cast, DevAudit });
		if (bonus === 0) {
			members++;
			const res = await UserModel.collection.updateOne({ _id: u._id, $expr: { $ne: ['$publicXp', '$xp'] } }, [{ $set: { publicXp: '$xp' } }]);
			membersChanged += res.modifiedCount;
			continue;
		}
		for (let attempt = 0; attempt < 5; attempt++) {
			const res = await UserModel.collection.updateOne({ _id: u._id, xp: u.xp }, { $set: { publicXp } });
			if (res.matchedCount > 0) {
				recomputed.push({ userId: u.userId, xp: u.xp || 0, before: u.publicXp ?? null, after: publicXp, bonus });
				break;
			}
			u = await UserModel.collection.findOne({ _id: u._id }, { projection: { userId: 1, xp: 1, publicXp: 1, appliedOps: 1, appliedCasts: 1 } });
			if (!u) break;
			({ publicXp, bonus } = await expectedPublicXp(u, { Cast, DevAudit }));
		}
	}
	return { scanned: users.length, members, membersChanged, recomputed };
}

/**
 * Read-only consistency check: members (not FOUNDER_IDS, no Founder override) must have publicXp == xp.
 * Returns { members, mismatched, sample } (sample: up to 10 userIds).
 */
async function checkPublicXp({ UserModel, founders = [] }) {
	const memberFilter = { userId: { $nin: founders.map(String) }, 'devOverrides.profile': { $ne: 'founder' } };
	const mismatch = { ...memberFilter, $expr: { $ne: [{ $ifNull: ['$publicXp', -1] }, { $ifNull: ['$xp', 0] }] } };
	const members = await UserModel.collection.countDocuments(memberFilter);
	const mismatched = await UserModel.collection.countDocuments(mismatch);
	const sample = mismatched > 0
		? (await UserModel.collection.find(mismatch, { projection: { userId: 1 } }).limit(10).toArray()).map((u) => u.userId)
		: [];
	return { members, mismatched, sample };
}

module.exports = {
	journalProfileBonus, publicXpOfResult, publicXpOf, publicLevelOf, publicProgressOf, migratePublicXp,
	journalCommitted, expectedPublicXp, reconcilePublicXp, checkPublicXp,
};
