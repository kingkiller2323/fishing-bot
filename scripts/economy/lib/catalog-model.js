// Exact analytic model of the cast engine's draw (src/engine/cast.js drawTemplates) over the seeded
// catalog. Used by Phase 5B to evaluate rule changes without re-running the engine, and validated
// against the engine measurements (validate-model.js).
//
// Per draw the engine rolls a rarity from the table; a Lucky roll is an item 20% of the time (a random
// Lucky catalog item); otherwise a random fish of that rarity in the biome whose weather/season match
// and whose qualities intersect the cast's. An empty choice is re-rolled (25 attempts, then a fallback
// whose probability is negligible). So the effective distribution is the table restricted to the
// rarities that can produce something, renormalised, and uniform within a rarity.
const baseFish = require('../../../src/bootstrap/data/baseFish');
const weatherFish = require('../../../src/bootstrap/data/weatherFish');
const seasonalFish = require('../../../src/bootstrap/data/seasonalFish');
const seasons = require('../../../src/bootstrap/data/seasons');
const rodParts = require('../../../src/bootstrap/data/rodParts');
const gacha = require('../../../src/bootstrap/data/gacha');
const { RARITIES } = require('../../../src/engine/balance');

const WEATHERS = ['Sunny', 'Rainy', 'Cloudy', 'Snowy', 'Windy'];
const FISH = [...baseFish(), ...weatherFish, ...seasonalFish].map((f) => ({ weather: 'all', season: 'all', qualities: ['weak'], ...f, rarity: String(f.rarity).toLowerCase() }));
// Lucky catalog items (Item.find({ rarity: 'Lucky' })); items default to qualities ['weak'].
const LUCKY_ITEMS = [...rodParts, ...gacha].filter((i) => String(i.rarity).toLowerCase() === 'lucky').map((i) => ({ name: i.name, qualities: i.qualities || ['weak'], kind: 'item' }));
const RARITY_FACTOR = { common: 1, uncommon: 1.35, rare: 1.65, ultra: 2.2, giant: 3.0, legendary: 3.5, lucky: 4.0 };

/** Expected sale value under the CURRENT formula (Fish.calculateSellValue is linear in size/weight). */
const currentValue = (f) => ((f.minSize + f.maxSize) / 2) * f.baseValue * 0.05 + ((f.minWeight + f.maxWeight) / 2) * 1.005 * RARITY_FACTOR[f.rarity];

/** Steady-state environment mix: seasons equally, seasonal weather 5x as likely. */
function envMix() {
	const out = [];
	for (const s of seasons) {
		const w = WEATHERS.map((x) => (s.commonWeatherTypes.includes(x) ? 5 : 1));
		const total = w.reduce((a, b) => a + b, 0);
		WEATHERS.forEach((weather, i) => out.push({ season: s.season, weather, p: 0.25 * (w[i] / total) }));
	}
	return out;
}
const ENV = envMix();

const matches = (qualities, t) => qualities.some((q) => (t.qualities || []).includes(q));

/**
 * Distribution of one draw: [{ kind: 'fish'|'item', template, rarity, p }].
 * @param {string} biome capitalised biome name
 * @param {string[]} qualities cast qualities (weak/strong)
 * @param {object} table normalised rarity probabilities
 */
function drawDistribution(biome, qualities, table) {
	const acc = new Map();
	for (const env of ENV) {
		const byRarity = {};
		for (const r of RARITIES) {
			byRarity[r] = FISH.filter((f) => f.biome === biome && f.rarity === r && [env.weather, 'all'].includes(f.weather) && [env.season, 'all'].includes(f.season) && matches(qualities, f));
		}
		const items = LUCKY_ITEMS;
		// Acceptance probability of a rolled rarity (one attempt).
		const accept = {};
		for (const r of RARITIES) {
			const fishOk = byRarity[r].length > 0 ? 1 : 0;
			if (r === 'lucky') {
				const itemOk = items.length ? items.filter((i) => matches(qualities, i)).length / items.length : 0;
				accept[r] = 0.8 * fishOk + 0.2 * itemOk;
			}
			else {
				accept[r] = fishOk;
			}
		}
		const mass = RARITIES.reduce((s, r) => s + (table[r] || 0) * accept[r], 0);
		if (mass <= 0) continue;
		for (const r of RARITIES) {
			const pr = ((table[r] || 0) * accept[r]) / mass;
			if (!pr) continue;
			const fishShare = r === 'lucky' ? (0.8 * (byRarity[r].length ? 1 : 0)) / accept[r] : 1;
			for (const f of byRarity[r]) {
				const key = `fish:${f.name}`;
				const cur = acc.get(key) || { kind: 'fish', template: f, rarity: r, p: 0 };
				cur.p += env.p * pr * fishShare / byRarity[r].length;
				acc.set(key, cur);
			}
			if (r === 'lucky' && fishShare < 1) {
				const valid = items.filter((i) => matches(qualities, i));
				for (const it of valid) {
					const key = `item:${it.name}`;
					const cur = acc.get(key) || { kind: 'item', template: it, rarity: r, p: 0 };
					cur.p += env.p * pr * (1 - fishShare) / valid.length;
					acc.set(key, cur);
				}
			}
		}
	}
	return [...acc.values()];
}

/** Summary of a draw distribution under a value function and XP-per-rarity weights. */
function summarize(dist, { value = currentValue, xpWeight = null } = {}) {
	const rarity = Object.fromEntries(RARITIES.map((r) => [r, 0]));
	let fishP = 0;
	let valueSum = 0;
	let xpW = 0;
	let strongP = 0;
	for (const d of dist) {
		rarity[d.rarity] += d.p;
		xpW += d.p * (xpWeight ? xpWeight[d.rarity] : 1);
		if (d.kind === 'fish') {
			fishP += d.p;
			valueSum += d.p * value(d.template);
			if (!(d.template.qualities || []).includes('weak')) strongP += d.p;
		}
	}
	return { rarity, fishShare: fishP, valuePerDraw: valueSum, valuePerFish: fishP ? valueSum / fishP : 0, xpWeightPerDraw: xpW, strongOnlyShare: strongP };
}

module.exports = { FISH, LUCKY_ITEMS, ENV, RARITY_FACTOR, currentValue, drawDistribution, summarize };
