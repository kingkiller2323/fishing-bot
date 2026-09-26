// Level gates for gear (rods and bait).
//
// A rod or bait whose `requirements.level` is above the player's level cannot be bought, crafted or
// equipped, and an equipped bait above the player's level has no effect at cast time and is not
// consumed. Every gate reads gateLevelOf: keyed on identity (FOUNDER_IDS), never on a /dev founder profile
// override, so an override cannot change what an account may access (P-FOUNDER-DEV-OVERRIDE). Today both
// branches are the real level (max(levelFloor, curve(xp))); step C switches the Founder branch to the
// public level together with P-FOUNDER-GATE's biome migration. Equipped gear is never unequipped by a gate.
const { levelOf } = require('./levels');
const { isFounderId } = require('./balance');

/** The level an item requires (0 when it has none). Works for mongoose documents and plain objects. */
function requiredLevel(item) {
	if (!item) return 0;
	const raw = item.requirements?.level ?? item._doc?.requirements?.level;
	const level = Number(raw);
	return Number.isFinite(level) && level > 0 ? level : 0;
}

/** True when a player of `level` may use `item`. */
function meetsLevelRequirement(level, item) {
	return (Number(level) || 0) >= requiredLevel(item);
}

/** A real Founder's gate level. The step C switch point (P-FOUNDER-GATE: public level); the real level until then. */
const founderGateLevel = (userDoc) => levelOf(userDoc);

/**
 * The level every gate compares against. Decided by identity (FOUNDER_IDS) only: devOverrides.profile
 * is never read here. Works on raw documents and mongoose documents.
 */
function gateLevelOf(userDoc, cfg) {
	return isFounderId(userDoc?.userId, cfg) ? founderGateLevel(userDoc) : levelOf(userDoc);
}

/** A raw user document's gate level (kept for existing callers). */
function levelOfUserDoc(userDoc) {
	return gateLevelOf(userDoc);
}

/**
 * Checks `item` against the player's gate level.
 * @param {import('../class/User').User} userData User wrapper
 * @returns {Promise<{ ok: boolean, level: number, required: number }>}
 */
async function checkLevelGate(userData, item) {
	const level = await userData.getGateLevel();
	const required = requiredLevel(item);
	return { ok: level >= required, level, required };
}

module.exports = { requiredLevel, meetsLevelRequirement, gateLevelOf, levelOfUserDoc, checkLevelGate };
