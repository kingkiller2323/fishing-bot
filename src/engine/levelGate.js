// Level gates for gear (rods and bait).
//
// A rod or bait whose `requirements.level` is above the player's level cannot be bought, crafted or
// equipped, and an equipped bait above the player's level has no effect at cast time and is not
// consumed. The level is always the account's real level (User#getLevel = max(levelFloor, curve(xp))),
// never the public level. Gear that is already equipped is never unequipped by these gates.
const { levelOf } = require('./levels');

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

/** A raw user document's real level (same as User#getLevel). */
function levelOfUserDoc(userDoc) {
	return levelOf(userDoc);
}

/**
 * Checks `item` against the player's current real level.
 * @param {import('../class/User').User} userData User wrapper
 * @returns {Promise<{ ok: boolean, level: number, required: number }>}
 */
async function checkLevelGate(userData, item) {
	const level = await userData.getLevel();
	const required = requiredLevel(item);
	return { ok: level >= required, level, required };
}

module.exports = { requiredLevel, meetsLevelRequirement, levelOfUserDoc, checkLevelGate };
