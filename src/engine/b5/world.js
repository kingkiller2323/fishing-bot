// The 5B world (step C.3): biome permits and the single access rule. A biome is accessible when the gate
// level has reached its level AND it is free (Ocean) or its permit is held (A-PERMITS, P-WORLD-PERMIT-RULES:
// one-time, account-bound, no chain). Used by /biome, the cast guard and every system that names a biome.
const { need5b } = require('../balance');

const W = () => need5b().world;
const P = () => need5b().permits;

const canonBiome = (name) => W().biomeOrder.find((b) => b.toLowerCase() === String(name || '').toLowerCase()) || null;
const biomeLevel = (biome) => W().biomeLevel[canonBiome(biome)] ?? Infinity;
const isFree = (biome) => P().free.includes(canonBiome(biome));
const permitPrice = (biome) => (isFree(biome) ? 0 : P().prices[canonBiome(biome)] ?? null);
const heldPermits = (permits) => new Set((permits || []).map((p) => canonBiome(p?.biome)).filter(Boolean));

/** True when a player of `gateLevel` holding `permits` may fish `biome`. */
function canFish(gateLevel, permits, biome) {
	const b = canonBiome(biome);
	if (!b) return false;
	return gateLevel >= biomeLevel(b) && (isFree(b) || heldPermits(permits).has(b));
}

/** Every biome the player may fish, in ladder order. */
const accessibleBiomes = (gateLevel, permits) => W().biomeOrder.filter((b) => canFish(gateLevel, permits, b));

/** A biome's status for the player: 'open' | 'permit' (level reached, permit due) | 'level' (level not reached). */
function biomeStatus(gateLevel, permits, biome) {
	if (canFish(gateLevel, permits, biome)) return 'open';
	return gateLevel >= biomeLevel(biome) ? 'permit' : 'level';
}

/** The highest biome the player may fish (Ocean at worst). */
const highestAccessible = (gateLevel, permits) => accessibleBiomes(gateLevel, permits).at(-1) || W().biomeOrder[0];

/**
 * Grandfathered permits of an account without a permits field (P-WORLD-GRANDFATHER): every live non-free biome
 * at or below max(stored level, today's curve level of xp), plus its current biome. null when it has the field.
 */
function grandfatheredPermits(user, { now = new Date(), legacyLevelForXp }) {
	if (user.permits !== undefined) return null;
	const level = Math.max(user.level || 1, legacyLevelForXp(user.xp || 0));
	const live = need5b().value.liveBiomes;
	const current = live.find((b) => b.toLowerCase() === String(user.currentBiome || '').toLowerCase());
	return live.filter((b) => !isFree(b) && (level >= biomeLevel(b) || b === current)).map((biome) => ({ biome, source: 'grandfathered', acquiredAt: now, pricePaid: 0 }));
}

/** The biomes the level range (before, after] opens, with their permit price. */
function unlockedBetween(before, after) {
	return W().biomeOrder.filter((b) => biomeLevel(b) > before && biomeLevel(b) <= after).map((b) => ({ biome: b, price: permitPrice(b) }));
}

module.exports = { canonBiome, biomeLevel, isFree, permitPrice, heldPermits, canFish, accessibleBiomes, biomeStatus, highestAccessible, grandfatheredPermits, unlockedBetween };
