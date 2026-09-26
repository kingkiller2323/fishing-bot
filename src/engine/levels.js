// Levels: the level curve and the stored no-demotion floors (P-CURVE-EXISTING, P-FOUNDER-PUBLIC-LEVEL).
//
// Every level READ goes through max(stored floor, curve(xp)): levelOf (real level) and
// publicLevel.js publicLevelOf (public level). Every level WRITE keeps the floors monotonic with `$max`
// (cast commit, /dev xp add). The floors are written for existing accounts by migrateLevelFloors from
// TODAY's curve (levelForXp), whatever curve is active, so a later, steeper curve never demotes anyone.
//
// The active curve is chosen in exactly one place (activeCurve). Today it is the 100·L² curve, so
// floor == curve for every account and nothing visible changes. Step C switches activeCurve by flag.
const { levelForXp } = require('./balance');

/** A level curve: level for a total XP, and the total XP at which a level starts. */
const CURVES = {
	// Today's curve (balance.js levelForXp): xp(L) = 100·L², level = max(floor(0.1·√xp), 1).
	current: {
		name: 'current',
		levelForXp,
		xpForLevel: (level) => 100 * level ** 2,
	},
	// Phase 5B curve (A-CURVE, approved): xp(L) = 100·L² + 0.0525·L⁴. Pure; NOT selected (Step C).
	'5b': {
		name: '5b',
		xpForLevel: (level) => 100 * level ** 2 + 0.0525 * level ** 4,
		levelForXp(xp) {
			const x = Math.max(0, xp || 0);
			const a = 0.0525;
			let level = Math.max(1, Math.floor(Math.sqrt((-100 + Math.sqrt(10000 + 4 * a * x)) / (2 * a))));
			// Exact at the boundaries despite floating-point error in the closed form.
			while (CURVES['5b'].xpForLevel(level + 1) <= x) level++;
			while (level > 1 && CURVES['5b'].xpForLevel(level) > x) level--;
			return level;
		},
	},
};

/** The curve every level read uses. The ONE switch point for the curve change (Step C, by flag). */
function activeCurve() {
	return CURVES.current;
}

/** The active curve's level for a total XP (no floor). */
const curveLevel = (xp) => activeCurve().levelForXp(xp);

/** A stored floor (missing or invalid -> 0, i.e. the curve alone decides). */
const floorOf = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/** A player's real level: max(stored levelFloor, curve(xp)). Works on raw documents and mongoose docs. */
function levelOf(user) {
	return Math.max(floorOf(user?.levelFloor), curveLevel(user?.xp || 0));
}

/** The level after gaining XP: max(stored floor, curve(xp)), never below the floor. */
const levelWithFloor = (floor, xp) => Math.max(floorOf(floor), curveLevel(xp));

/**
 * "progress / needed" to the next level on the active curve, from the DISPLAYED level (which may be
 * the floor, above the curve's own level for this XP: progress then shows 0 until XP catches up).
 */
function progressText(xp, level) {
	const curve = activeCurve();
	const start = curve.xpForLevel(level);
	const progress = Math.max(Math.round((xp || 0) - start), 0);
	const next = Math.round(curve.xpForLevel(level + 1) - start);
	return `${progress.toLocaleString()} / ${next.toLocaleString()}`;
}

/**
 * Migration: every account without a floor gets levelFloor = today's levelForXp(xp) and
 * publicLevelFloor = today's levelForXp(publicXp), ALWAYS on today's curve (the P-CURVE-EXISTING
 * freeze anchor), whatever curve is active. Each field is set only where it is missing (guarded
 * update), so it is idempotent and never lowers a floor a cast has already raised with $max.
 */
/**
 * Additive, idempotent: writes levelFloor = max(stored level, today's curve(xp)) and publicLevelFloor
 * (the same for a member, whose publicXp equals xp; today's curve(publicXp) for an account with private
 * bonuses) where missing. Floors never decrease afterwards.
 */
async function migrateLevelFloors({ UserModel }) {
	const { publicXpOf } = require('./publicLevel');
	const todays = CURVES.current.levelForXp;
	const users = await UserModel.collection.find(
		{ $or: [{ levelFloor: { $exists: false } }, { publicLevelFloor: { $exists: false } }] },
		{ projection: { xp: 1, level: 1, publicXp: 1, levelFloor: 1, publicLevelFloor: 1 } },
	).toArray();
	let levelFloors = 0;
	let publicLevelFloors = 0;
	for (const u of users) {
		// P-CURVE-EXISTING: the floor keeps the level the player has today, max(stored level, today's curve(xp)).
		const stored = Number.isFinite(u.level) ? u.level : 0;
		const realFloor = Math.max(stored, todays(u.xp || 0));
		if (u.levelFloor === undefined) {
			const res = await UserModel.collection.updateOne({ _id: u._id, levelFloor: { $exists: false } }, { $set: { levelFloor: realFloor } });
			levelFloors += res.modifiedCount;
		}
		if (u.publicLevelFloor === undefined) {
			const res = await UserModel.collection.updateOne({ _id: u._id, publicLevelFloor: { $exists: false } }, { $set: { publicLevelFloor: publicXpOf(u) >= (u.xp || 0) ? realFloor : todays(publicXpOf(u)) } });
			publicLevelFloors += res.modifiedCount;
		}
	}
	return { scanned: users.length, levelFloors, publicLevelFloors };
}

module.exports = { migrateLevelFloors, CURVES, activeCurve, curveLevel, floorOf, levelOf, levelWithFloor, progressText };
