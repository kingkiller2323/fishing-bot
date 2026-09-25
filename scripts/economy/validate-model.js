// Validates the analytic catalog model (lib/catalog-model.js) against the real-engine measurements:
// for every normal-profile scenario, predicted vs measured fish/cast, rarity mix and $/fish.
//   node scripts/economy/validate-model.js
const measurements = require('../../docs/economy/measurements.json');
const { resolveModifiers } = require('../../src/engine/modifiers');
const { buildTable } = require('../../src/engine/rarity');
const { PROFILES, NORMAL_RARITY_TABLE } = require('../../src/engine/balance');
const baitData = require('../../src/bootstrap/data/bait');
const rodParts = require('../../src/bootstrap/data/rodParts');
const { drawDistribution, summarize } = require('./lib/catalog-model');
const { FishingRod } = require('../../src/class/FishingRod');

const RODS = {
	'Custom (Common parts)': ['Wooden Rod Piece', 'Plastic Reel', 'Barbed Hook', 'Wooden Handle'],
	'Custom (Uncommon parts)': ['Bamboo Rod Piece', 'Aluminum Reel', 'Circle Hook', 'Cork Handle'],
	'Custom (Rare parts)': ['Graphite Rod Piece', 'Jigging Reel', 'Treble Hook', 'EVA Handle'],
	'Custom (Ultra parts)': ['Carbon Fiber Rod Piece', 'Fly Fishing Reel', 'Jig Hook', 'Carbon Fiber Handle'],
	'Custom (Legendary parts)': ['Composite Rod Piece', 'Sage Green Reel', 'Worm Hook', 'Composite Handle'],
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

async function predict(r) {
	const profile = { name: 'normal', ...PROFILES.normal };
	let rod = { name: 'Old Rod', capabilities: ['weak', '1'] };
	let parts = null;
	if (r.rod && r.rod.name !== 'Old Rod') {
		parts = RODS[r.key.split('|')[1]].map((n) => rodParts.find((p) => p.name === n));
		rod = { name: 'x', type: 'customrod', capabilities: await FishingRod.prototype.combineQualities.call(null, parts) };
	}
	const baitName = r.key.split('|')[2];
	const bait = baitName !== '-' ? baitData.find((b) => b.name === baitName) : null;
	const m = resolveModifiers({ profile, rod, rodParts: parts, bait, baitApplies: Boolean(bait && bait.biomes.includes(r.biome)) });
	const table = buildTable(NORMAL_RARITY_TABLE, m.stats);
	const s = summarize(drawDistribution(cap(r.biome), m.qualities, table));
	const fish = m.draws * m.perDraw;
	return { fish, valuePerFish: s.valuePerFish * (1 + m.stats.sellBonus), rarity: s.rarity, fishShare: s.fishShare };
}

async function main() {
	const rows = [];
	for (const r of measurements.results.filter((x) => x.key.endsWith('|normal'))) {
		const p = await predict(r);
		const measuredVpf = r.valueBase / Math.max(1, r.fishUnits);
		const measuredFish = r.units / r.casts;
		const common = (r.rarityUnits.common || 0) / r.units;
		rows.push({ key: r.key, fishPred: p.fish, fishMeas: +measuredFish.toFixed(2), vpfPred: +p.valuePerFish.toFixed(1), vpfMeas: +measuredVpf.toFixed(1), ratio: +(measuredVpf / p.valuePerFish).toFixed(3), commonPred: +(p.rarity.common * 100).toFixed(1), commonMeas: +(common * 100).toFixed(1) });
	}
	const ratios = rows.map((x) => x.ratio).sort((a, b) => a - b);
	const fishMismatch = rows.filter((x) => Math.abs(x.fishPred - x.fishMeas) > 0.05);
	const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
	const pooledMeas = rows.reduce((s, x) => s + x.vpfMeas, 0);
	const pooledPred = rows.reduce((s, x) => s + x.vpfPred, 0);
	process.stdout.write(JSON.stringify({ scenarios: rows.length, fishPerCastMismatches: fishMismatch, valuePerFishRatio: { min: ratios[0], median: ratios[Math.floor(ratios.length / 2)], max: ratios[ratios.length - 1], mean: +mean.toFixed(3), pooled: +(pooledMeas / pooledPred).toFixed(3) }, rows }, null, 1));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
