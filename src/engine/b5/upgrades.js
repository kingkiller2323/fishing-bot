// Angler Upgrades (step C.5; P-UPGRADES-*): permanent cash upgrades, several levels each. The level of each
// is a counter on the user (`upgrades.<key>`, additive; absent = 0). Level k+1 unlocks at unlockLevels[k] and
// costs prices[k]. Effects add to the cast's stats (a 5B modifier source); Bait Conservation is a chance per
// bait use that the unit is not used up (the bait still applies).
const { need5b } = require('../balance');
const { User: UserModel } = require('../../schemas/UserSchema');
const { withUserLock } = require('../userLock');
const { gateLevelOf } = require('../levelGate');

const U = () => need5b().upgrades;

/** The player's level in each upgrade (0..levels). */
function levelsOf(user) {
	const out = {};
	for (const key of Object.keys(U().categories)) {
		const n = Number(user?.upgrades?.[key]);
		out[key] = Number.isFinite(n) ? Math.max(0, Math.min(U().levels, Math.floor(n))) : 0;
	}
	return out;
}

/** Stats the upgrades give (baitSave included; it is read by the bait path, not the stat model). */
function upgradeStats(user) {
	const stats = {};
	const levels = levelsOf(user);
	for (const [key, c] of Object.entries(U().categories)) {
		if (levels[key] > 0) stats[c.stat] = Number(((stats[c.stat] || 0) + c.perLevel * levels[key]).toFixed(6));
	}
	return stats;
}

/** The 5B modifier source for the upgrades (null when the player has none). */
function upgradeSource(user) {
	const stats = upgradeStats(user);
	delete stats.baitSave;
	return Object.keys(stats).length ? { source: 'upgrades', levels: levelsOf(user), stats } : null;
}

/** The next level of an upgrade for the player: its price and unlock level, or null at max. */
function nextLevel(user, key) {
	const c = U().categories[key];
	if (!c) return null;
	const current = levelsOf(user)[key];
	if (current >= U().levels) return null;
	return { key, name: c.name, current, next: current + 1, price: c.prices[current], unlockLevel: U().unlockLevels[current], stat: c.stat, perLevel: c.perLevel };
}

/** Buys the next level: guarded on the expected current level and the money, under the player's lock. */
async function buyUpgrade(userId, key) {
	return withUserLock(userId, async () => {
		const user = await UserModel.collection.findOne({ userId: String(userId) });
		if (!user) return { ok: false, code: 'NO_USER', message: 'Player not found.' };
		const n = nextLevel(user, key);
		if (!n) return { ok: false, code: U().categories[key] ? 'MAX' : 'UNKNOWN', message: U().categories[key] ? 'That upgrade is at its maximum level.' : 'Unknown upgrade.' };
		const level = gateLevelOf(user);
		if (level < n.unlockLevel) return { ok: false, code: 'LEVEL_LOCKED', message: `${n.name} L${n.next} unlocks at Lv ${n.unlockLevel}. You are Lv ${level}.` };
		const path = `upgrades.${key}`;
		const expected = n.current === 0 ? { $in: [null, 0] } : n.current;
		const res = await UserModel.collection.updateOne(
			{ userId: String(userId), 'inventory.money': { $gte: n.price }, [path]: expected },
			{ $inc: { 'inventory.money': -n.price }, $set: { [path]: n.next } },
		);
		if (res.modifiedCount !== 1) return { ok: false, code: 'INSUFFICIENT', message: `${n.name} L${n.next} costs $${n.price.toLocaleString()}.`, price: n.price };
		return { ok: true, key, level: n.next, price: n.price };
	});
}

module.exports = { levelsOf, upgradeStats, upgradeSource, nextLevel, buyUpgrade };
