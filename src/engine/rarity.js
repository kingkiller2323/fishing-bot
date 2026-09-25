// RarityEngine: turns a base table plus rarity stats (and pity) into an explicit, normalised
// probability table, and rolls from it. Pure functions - no database, randomness only via rng.
const { RARITIES, RARITY_STAT_TIERS } = require('./balance');

const safe = (n) => (Number.isFinite(n) && n > 0 ? n : 0);

/** Normalises any weight object over RARITIES to probabilities summing to 1. */
function normalize(weights, fallback = null) {
	const total = RARITIES.reduce((sum, r) => sum + safe(weights?.[r]), 0);
	if (total > 0) return Object.fromEntries(RARITIES.map((r) => [r, safe(weights?.[r]) / total]));
	// An empty/invalid table falls back (e.g. to the unmodified base), finally to all-Common.
	if (fallback) return normalize(fallback);
	return Object.fromEntries(RARITIES.map((r) => [r, r === 'common' ? 1 : 0]));
}

/**
 * Builds the probability table for one cast.
 * @param {object} base   base weights or probabilities (profile table)
 * @param {object} stats  { luck, rareFind, trophyChance } as fractions (+1.0 = +100%)
 */
function buildTable(base, stats = {}) {
	const table = normalize(base);
	const weighted = { ...table };
	for (const [stat, tiers] of Object.entries(RARITY_STAT_TIERS)) {
		// A stat can never push a tier below zero weight.
		const factor = Math.max(0, 1 + (Number.isFinite(stats[stat]) ? stats[stat] : 0));
		for (const tier of tiers) weighted[tier] *= factor;
	}
	return normalize(weighted, table);
}

/** Probability mass of a group of tiers. */
const groupMass = (table, tiers) => tiers.reduce((sum, t) => sum + (table[t] || 0), 0);

/**
 * Raises a tier group to `target` total probability, scaling its members proportionally and the
 * rest of the table down proportionally, so the result still sums to 1.
 */
function raiseGroup(table, tiers, target) {
	const mass = groupMass(table, tiers);
	const clamped = Math.min(0.999, Math.max(mass, target));
	if (mass <= 0 || clamped === mass) return { ...table };
	const inside = clamped / mass;
	const outside = (1 - clamped) / (1 - mass);
	return normalize(Object.fromEntries(RARITIES.map((r) => [r, table[r] * (tiers.includes(r) ? inside : outside)])));
}

/**
 * Applies pity to a table.
 * @param {object} table   normalised table
 * @param {object} counters { castsSinceLegendary, castsSinceLucky, ... } before this cast
 * @param {object|null} pityConfig profile pity definition (null = disabled)
 * @returns {{ table, guarantee: string[]|null, applied: object }}
 */
function applyPity(table, counters = {}, pityConfig = null) {
	const applied = {};
	let result = { ...table };
	let guarantee = null;
	if (!pityConfig) return { table: result, guarantee, applied };

	for (const [name, rule] of Object.entries(pityConfig)) {
		const since = counters[rule.counter] || 0;
		const entry = { since, bonus: 0, guaranteed: false };
		if (since >= rule.softStart) {
			entry.bonus = Math.min(rule.maxBonus, rule.rampPerCast * (since - rule.softStart + 1));
			result = raiseGroup(result, rule.tiers, groupMass(result, rule.tiers) + entry.bonus);
		}
		// The cast that reaches `hard` casts without the tier is guaranteed one.
		if (since + 1 >= rule.hard) {
			entry.guaranteed = true;
			// The rarest guarantee wins (lucky is listed after legendaryPlus).
			guarantee = rule.tiers;
		}
		applied[name] = entry;
	}
	return { table: result, guarantee, applied };
}

/** Rolls a rarity key from a normalised table (optionally restricted to some tiers). */
function roll(table, rng, restrictTo = null) {
	const tiers = restrictTo ? RARITIES.filter((r) => restrictTo.includes(r)) : RARITIES;
	const weights = tiers.map((r) => table[r] || 0);
	return rng.weighted(tiers, weights) || (restrictTo ? tiers[tiers.length - 1] : 'common');
}

/** Rounded percentages for display/reporting. */
function toPercent(table, digits = 3) {
	return Object.fromEntries(RARITIES.map((r) => [r, Number(((table[r] || 0) * 100).toFixed(digits))]));
}

module.exports = { normalize, buildTable, applyPity, raiseGroup, roll, toPercent, groupMass };
