// Public (base / competitive) XP and level: what OTHER players see.
//
// The account's `xp` is the true total, including private profile bonuses (Founder). Public surfaces
// (catch-card level-ups, /profile, /inventory) must never reveal those bonuses, so they read `publicXp`:
// the sum of the base rewards the player was actually shown. For normal and test profiles the profile
// multipliers are 1, so publicXp === xp exactly. The private /fishing-stats shows both.
//
// publicXp is written in the same atomic commit as xp (cast.js) and initialised for existing accounts by
// an additive, idempotent migration (xp minus every profile bonus recorded in the cast journals).
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
 * (clamped to [0, xp]). Normal/test accounts therefore get publicXp = xp exactly. Pending journals are
 * applied later by the cast engine, which adds their base XP to publicXp then. Idempotent: only
 * documents without the field are touched, with a guarded update.
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

module.exports = { journalProfileBonus, publicXpOfResult, publicXpOf, publicLevelOf, publicProgressOf, migratePublicXp };
