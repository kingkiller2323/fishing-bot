// Phase 5 measurement: runs the REAL cast engine (castLine) against the real seeded catalog on an
// in-memory MongoDB and records per-cast outcomes for every biome x gear setup x profile.
// Nothing here changes balance values; it only observes them.
//
//   node scripts/economy/measure.js [castsPerScenario=1200] > docs/economy/measurements.json
//
// Weather and season are cycled so each scenario sees the steady-state mix: every season equally,
// and within a season the seasonal weather types 5x as likely as the others (Season.getSeasonalWeather).
const mongoose = require('mongoose');
const { startDb, stopDb } = require('../../test/helpers/db');
const { quiet, restore } = require('../../test/helpers/quiet');
const { bootstrap } = require('../../src/bootstrap');
const { User } = require('../../src/class/User');
const { castLine, applyCastResult } = require('../../src/engine/cast');
const { rng } = require('../../src/engine/rng');
const { Item, ItemData } = require('../../src/schemas/ItemSchema');
const { CustomRodData } = require('../../src/schemas/CustomRodSchema');
const { FishingRod } = require('../../src/class/FishingRod');
const { User: UserModel } = require('../../src/schemas/UserSchema');
const { Season: SeasonSchema } = require('../../src/schemas/SeasonSchema');
const { WeatherPattern: WeatherPatternSchema } = require('../../src/schemas/WeatherPatternSchema');
const seasons = require('../../src/bootstrap/data/seasons');
const config = require('../../src/config');

const N = Number(process.argv[2]) || 1200;
const BIOMES = ['ocean', 'river', 'lake', 'pond', 'coast', 'swamp'];
const WEATHERS = ['Sunny', 'Rainy', 'Cloudy', 'Snowy', 'Windy'];
const BAITS = ['Worm', 'Minnow', 'Shrimp', 'Spinner', 'Fly', 'Bloodworm', 'Lure', 'Magic Lure', 'Magnet', 'Strong Magnet'];

// Representative crafted rods, one part tier each (rod piece, reel, hook, handle).
const RODS = {
	'Custom (Common parts)': ['Wooden Rod Piece', 'Plastic Reel', 'Barbed Hook', 'Wooden Handle'],
	'Custom (Uncommon parts)': ['Bamboo Rod Piece', 'Aluminum Reel', 'Circle Hook', 'Cork Handle'],
	'Custom (Rare parts)': ['Graphite Rod Piece', 'Jigging Reel', 'Treble Hook', 'EVA Handle'],
	'Custom (Ultra parts)': ['Carbon Fiber Rod Piece', 'Fly Fishing Reel', 'Jig Hook', 'Carbon Fiber Handle'],
	'Custom (Legendary parts)': ['Composite Rod Piece', 'Sage Green Reel', 'Worm Hook', 'Composite Handle'],
};

/** Steady-state (season, weather) mix with block sizes summing to n. */
function environmentBlocks(n) {
	const blocks = [];
	for (const s of seasons) {
		const w = WEATHERS.map((x) => (s.commonWeatherTypes.includes(x) ? 5 : 1));
		const total = w.reduce((a, b) => a + b, 0);
		WEATHERS.forEach((weather, i) => blocks.push({ season: s.season, weather, p: 0.25 * (w[i] / total) }));
	}
	let assigned = 0;
	for (const b of blocks) {
		b.n = Math.floor(b.p * n);
		assigned += b.n;
	}
	blocks.sort((a, b) => b.p - a.p).slice(0, n - assigned).forEach((b) => b.n++);
	return blocks;
}

async function setEnvironment(season, weather) {
	await SeasonSchema.updateMany({}, { $set: { active: false } });
	await SeasonSchema.updateOne({ season }, { $set: { active: true } });
	await WeatherPatternSchema.updateOne({ type: 'weather', active: true }, { $set: { weather } });
}

async function copyItem(userId, name, extra = {}) {
	const template = await Item.findOne({ name, user: null }).lean();
	if (!template) throw new Error(`No catalog item ${name}`);
	const _id = new mongoose.Types.ObjectId();
	const fields = Object.fromEntries(Object.entries(template).filter(([k]) => !['_id', '__v'].includes(k)));
	const t = { bait: 'BaitData', rod: 'RodData' }[template.type] || 'ItemData';
	await ItemData.collection.insertOne({ ...fields, _id, __t: t, user: userId, count: 1, ...extra });
	return _id;
}

/** Crafts a custom rod exactly like /craft (FishingRod.generateStats) and equips it. */
async function craftRod(userId, parts) {
	const ids = [];
	for (const name of parts) ids.push(await copyItem(userId, name));
	const doc = new CustomRodData({ name: 'Sim Rod', rarity: 'Custom', rod: ids[0], reel: ids[1], hook: ids[2], handle: ids[3], type: 'customrod', user: userId });
	const rod = new FishingRod(doc);
	await rod.generateStats();
	const id = await rod.getId();
	await UserModel.updateOne({ userId }, { $set: { 'inventory.equippedRod': id }, $push: { 'inventory.rods': id } });
	return (await ItemData.findById(id).lean());
}

async function scenarioUser(userId, { biome, rod, bait }) {
	await User.get(userId);
	await UserModel.updateOne({ userId }, { $set: { currentBiome: biome, level: 60, xp: 400000 } });
	let rodDoc = null;
	if (rod) {
		rodDoc = await craftRod(userId, RODS[rod]);
	}
	else {
		const u = await UserModel.findOne({ userId }).lean();
		// Durability high enough that the rod never breaks mid-measurement (cost is recorded per cast).
		await ItemData.collection.updateOne({ _id: u.inventory.equippedRod }, { $set: { durability: 1e9 } });
		rodDoc = await ItemData.findById(u.inventory.equippedRod).lean();
	}
	if (rodDoc && rod) await ItemData.collection.updateOne({ _id: rodDoc._id }, { $set: { durability: 1e9 } });
	if (bait) {
		const id = await copyItem(userId, bait, { count: 1e9 });
		await UserModel.updateOne({ userId }, { $set: { 'inventory.equippedBait': id }, $push: { 'inventory.baits': id } });
	}
	return rodDoc;
}

async function runScenario(key, spec, n) {
	const userId = `sim:${key}`;
	const rodDoc = await scenarioUser(userId, spec);
	const agg = {
		key, ...spec, casts: 0, units: 0, fishUnits: 0, itemUnits: 0,
		xpBase: 0, xpFinal: 0, valueBase: 0, valueFinal: 0, durability: 0,
		cooldownMs: null, draws: 0, perDraw: null,
		rarityUnits: {}, rarityValueBase: {}, species: {}, items: {}, failures: {},
		rod: rodDoc ? { name: rodDoc.name, capabilities: rodDoc.capabilities, maxDurability: rodDoc.maxDurability, repairCost: rodDoc.repairCost, maxRepairs: rodDoc.maxRepairs, level: rodDoc.requirements?.level } : null,
	};
	for (const block of environmentBlocks(n)) {
		if (!block.n) continue;
		await setEnvironment(block.season, block.weather);
		for (let i = 0; i < block.n; i++) {
			const r = await castLine({ userId });
			agg.casts++;
			if (r.status !== 'ok') {
				agg.failures[r.failure.code] = (agg.failures[r.failure.code] || 0) + 1;
				continue;
			}
			// Founder pity only matters when counters advance, so Founder casts are persisted.
			if (spec.apply) await applyCastResult(r);
			agg.cooldownMs = r.cooldownMs;
			agg.draws += r.draws.draws;
			agg.perDraw = r.draws.perDraw;
			agg.units += r.units;
			agg.xpBase += r.rewards.catchXp.base;
			agg.xpFinal += r.rewards.catchXp.final;
			agg.durability += r.rod.durabilityCost;
			for (const c of r.catches) {
				const rar = c.rarity.toLowerCase();
				agg.rarityUnits[rar] = (agg.rarityUnits[rar] || 0) + c.count;
				if (c.kind === 'fish') {
					agg.fishUnits += c.count;
					agg.valueBase += c.reward.base * c.count;
					agg.valueFinal += c.reward.final * c.count;
					agg.rarityValueBase[rar] = (agg.rarityValueBase[rar] || 0) + c.reward.base * c.count;
					agg.species[c.name] = (agg.species[c.name] || 0) + c.count;
				}
				else {
					agg.itemUnits += c.count;
					agg.items[c.name] = (agg.items[c.name] || 0) + c.count;
				}
			}
		}
	}
	return agg;
}

async function main() {
	quiet();
	rng.seed(20260925);
	await startDb();
	await bootstrap();
	config.users.founders = ['sim:founder'];

	const scenarios = [];
	for (const biome of BIOMES) {
		scenarios.push([`${biome}|Old Rod|-|normal`, { biome, rod: null, bait: null, profile: 'normal' }]);
		for (const bait of BAITS) scenarios.push([`${biome}|Old Rod|${bait}|normal`, { biome, rod: null, bait, profile: 'normal' }]);
		for (const rod of Object.keys(RODS)) scenarios.push([`${biome}|${rod}|-|normal`, { biome, rod, bait: null, profile: 'normal' }]);
		scenarios.push([`${biome}|Old Rod|-|founder`, { biome, rod: null, bait: null, profile: 'founder', apply: true }]);
		for (const rod of ['Custom (Uncommon parts)', 'Custom (Rare parts)', 'Custom (Legendary parts)']) {
			scenarios.push([`${biome}|${rod}|-|founder`, { biome, rod, bait: null, profile: 'founder', apply: true }]);
		}
	}
	// Optional filter (regex on the scenario key), e.g. ONLY='founder$' for a supplementary run.
	const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
	if (only) scenarios.splice(0, scenarios.length, ...scenarios.filter(([k]) => only.test(k)));

	const results = [];
	const started = Date.now();
	for (const [key, spec] of scenarios) {
		const id = spec.profile === 'founder' ? 'founder' : key;
		// Founder scenarios use FOUNDER_IDS; each one gets a fresh founder account.
		if (spec.profile === 'founder') await UserModel.deleteMany({ userId: 'sim:founder' });
		const agg = await runScenario(id, spec, N);
		agg.key = key;
		results.push(agg);
		process.stderr.write(`${key}: ${agg.casts} casts, ${(agg.units / agg.casts).toFixed(2)} fish/cast, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
	}

	await stopDb();
	restore();
	process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), castsPerScenario: N, balanceVersion: require('../../src/engine/balance').BALANCE_VERSION, results }, null, 1));
}

main().catch((e) => {
	restore();
	console.error(e);
	process.exit(1);
});
