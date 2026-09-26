// Phase 5B: export the approved balance numbers to src/engine/data/balance-5b.json.
//
// The engine never requires the analysis framework (scripts/economy/5b); it reads this generated file
// through balance.js (the '5b' balance version, used only while BALANCE_5B is on). Every value below is
// READ from the framework and its subsystem modules: nothing is typed here. Only structure is chosen.
//
//   node scripts/economy/5b/export-balance.js           write the file
//   node scripts/economy/5b/export-balance.js --check   exit 1 if the committed file is stale
//
// test/balance-5b-data.test.js fails when the committed file differs from build(), or when a value in it
// disagrees with an approved decision of the registry (decisions.js).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const OUT = path.join(__dirname, '../../../src/engine/data/balance-5b.json');
const SCHEMA = 1;

/** Numbers to 12 significant digits (drops float noise such as 0.30000000000000004); keys keep their order. */
function tidy(v) {
	if (Array.isArray(v)) return v.map(tidy);
	if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, tidy(x)]));
	return typeof v === 'number' ? Number(v.toPrecision(12)) : v;
}
/** Key-sorted copy, for hashing. */
const sorted = (v) => {
	if (Array.isArray(v)) return v.map(sorted);
	if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]));
	return v;
};
/** sha256 (first 16 hex) of the data without its own hash. */
function contentHash(data) {
	const rest = Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'contentHash'));
	return crypto.createHash('sha256').update(JSON.stringify(sorted(rest))).digest('hex').slice(0, 16);
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

/** The 5B balance data, from the modules. */
function build() {
	const F = require('./framework');
	const rods = require('./rods');
	const world = require('./world');
	const upgrades = require('./upgrades');
	const buffs = require('./buffs');
	const bait = require('./bait');
	const aquarium = require('./aquarium');
	const founder = require('./founder');

	const stamp = F.verifyShared();

	const old = rods.oldRod();
	const rodFields = ['cooldownMs', 'maxDurability', 'maxRepairs', 'repairCost'];
	const standardDesign = Object.fromEntries(rods.PARAMS.standard.rods.map((r) => [r.name, r]));

	const hybrid = founder.solveHybrid();
	const upgradeRows = upgrades.priceTable();

	const data = {
		schema: SCHEMA,
		balanceVersion: '5b',
		frameworkVersion: stamp.frameworkVersion,
		sharedDigest: stamp.sharedDigest,
		generatedBy: 'scripts/economy/5b/export-balance.js',

		// xp(L) = base·L² + quartic·L⁴ (A-CURVE).
		curve: { ...F.CURVE },

		// Expected fish value = biome × rarity × quality × species factor (clamped) (P-VALUE-MODEL, P-MS-VALUE).
		value: {
			biome: { ...F.BIOME_VALUE },
			liveBiomes: [...F.LIVE_BIOMES],
			rarity: { ...F.RARITY_VALUE },
			quality: { ...F.QUALITY_VALUE },
			speciesClamp: [...F.SPECIES_CLAMP],
		},

		// XP per fish = the 10-25 roll (mean) × rarity weight (P-XP-RARITY).
		xp: { perFishMean: F.XP_PER_FISH_MEAN, rarity: { ...F.XP_RARITY } },

		// Normal-player multi-catch chain and the global ceiling on the final mean (A-MULTICATCH).
		multiCatch: { ...F.MULTI, ceilingMean: rods.PARAMS.multi.ceilingMean },

		world: { biomeOrder: [...F.BIOME_ORDER], biomeLevel: { ...F.BIOME_LEVEL } },

		// Standard shop ladder (P-RODS-STANDARD-LADDER, P-RODS-STANDARD-PRICES) and the unbreakable Old Rod.
		rods: {
			oldRod: { name: 'Old Rod', unlockLevel: 0, qualities: [...old.qualities], stats: { ...old.stats }, meanFish: old.meanFish, multiChance: old.multiChance, unbreakable: Boolean(old.unbreakable), ...pick(old, rodFields) },
			standard: rods.standardRods().map((r) => ({
				tier: r.tier,
				name: r.name,
				role: r.role,
				unlockLevel: r.level,
				price: r.price,
				qualities: [...r.qualities],
				stats: { ...r.stats },
				meanFish: r.meanFish,
				multiChance: r.multiChance,
				lifeHours: standardDesign[r.name].lifeHours,
				...pick(r, rodFields),
			})),
		},

		// One-time biome permits (A-PERMITS, P-WORLD-PERMIT-PRICES).
		permits: { free: [...world.PARAMS.permits.free], requiresPrevious: world.PARAMS.permits.requiresPrevious, prices: world.permitPriceMap() },

		// Angler Upgrades (P-UPGRADES-*): per-level effect, level unlocks and the price of each level.
		upgrades: {
			levels: upgrades.PARAMS.levels,
			unlockLevels: [...upgrades.PARAMS.unlockLevels],
			categories: Object.fromEntries(upgradeRows.map((u) => [u.key, { name: u.name, stat: u.stat, perLevel: u.perLevel, priceHours: u.priceHours, prices: [...u.prices] }])),
		},

		// Buffs and the event budget (P-BUFFS-*, P-DOUBLE-CASH, P-EVENTS).
		buffs: {
			doubleCashTiming: buffs.PARAMS.doubleCash.timing,
			catalog: Object.fromEntries(Object.entries(buffs.PARAMS.catalog).map(([name, b]) => [name, pick(b, ['kind', 'multiplier', 'bonusSlots', 'duration', 'excludeBoxes'])])),
			queue: pick(buffs.PARAMS.stacking, ['sameKind', 'maxQueued', 'acrossKinds']),
			stacking: pick(buffs.PARAMS.stacking, ['withEvent', 'withGearAndProfile']),
			eventsPerThirtyDays: { ...F.EVENTS.buffsPerThirtyDays },
		},

		// Bait roster and per-cast prices (bait design; P-BAIT-*).
		bait: {
			consumption: { ...bait.PARAMS.consumption },
			packSize: bait.PARAMS.pricing.packSize,
			roster: Object.fromEntries(Object.entries(bait.prices()).map(([name, p]) => {
				const b = bait.baits[name];
				return [name, {
					price: p.price, packPrice: p.packPrice, pricing: p.pricing, levelRequirement: p.levelRequirement,
					band: b.band, biomes: [...b.biomes], grantsStrong: b.grantsStrong, stats: { ...b.stats }, multiChance: b.multiChance,
				}];
			})),
		},

		// Aquarium licences and display tanks (P-AQUARIUM-*).
		aquarium: {
			licenses: aquarium.licenses().map((l) => pick(l, ['name', 'water', 'tier', 'prerequisite', 'level', 'tanks', 'tankSize', 'capacity', 'companionSlots', 'price'])),
			display: { ...pick(aquarium.PARAMS.display, ['requires', 'perWaterType', 'tankSize']), prices: aquarium.displayTanks().tanks.map((t) => t.price) },
		},

		// The Founder stealth-hybrid (P-FOUNDER-HYBRID).
		founder: {
			model: 'hybrid',
			rolls: hybrid.rolls,
			xp: hybrid.xp,
			sell: hybrid.sell,
			repairRebate: hybrid.repairRebate,
			gates: [...hybrid.gates],
			boxLuck: hybrid.boxLuck,
			competitiveEligible: false,
		},
	};
	const out = tidy(data);
	out.contentHash = contentHash(out);
	return out;
}

const serialise = (data) => `${JSON.stringify(data, null, '\t')}\n`;

module.exports = { OUT, SCHEMA, build, serialise, contentHash };

if (require.main === module) {
	const text = serialise(build());
	if (process.argv.includes('--check')) {
		const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
		if (current !== text) {
			console.error(`${path.relative(process.cwd(), OUT)} is stale: run node scripts/economy/5b/export-balance.js`);
			process.exit(1);
		}
		console.log('balance-5b.json is up to date');
	}
	else {
		fs.mkdirSync(path.dirname(OUT), { recursive: true });
		fs.writeFileSync(OUT, text);
		console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
	}
}
