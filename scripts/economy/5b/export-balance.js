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

const { FISH, currentValue, LUCKY_ITEM_SHARE } = require('../lib/catalog-model');

const qualityOf = (f) => ((f.qualities || []).includes('weak') ? 'weak' : 'strong');
const yearRound = (f) => (f.weather || 'all') === 'all' && (f.season || 'all') === 'all';
const DONOR_BIOME = 'River';
const COPIED = ['minSize', 'maxSize', 'minWeight', 'maxWeight', 'baseValue'];

/**
 * Species value data and the Mountain Stream ladder. New Mountain Stream species take size, weight and
 * base value from a River donor of the same rarity and quality. Donor rule (stable, recorded here so a
 * regeneration cannot silently pick another): the bucket's River species ordered year-round first, then
 * by name; the k-th new species of the bucket (ladder order) takes candidate k mod n. New species are
 * year-round (season 'all'); the premium salmon keep their weather. Flashfin, Shrouded and Zephyr stay
 * as they are in the catalog. Value: the world design's ladder value (BIOME_VALUE['Mountain Stream'] ×
 * rarity × quality × new-species factor; P-MS-VALUE, P-WORLD-MS-LADDER).
 */
function speciesData(F, world) {
	const species = {};
	const add = (f, proposed) => {
		const key = `${f.biome}|${f.name}`;
		const current = currentValue(f);
		if (!(current > 0) || !(proposed > 0)) throw new Error(`species ${key}: value data must be positive (current ${current}, proposed ${proposed})`);
		if (species[key] && (species[key].current !== current || species[key].proposed !== proposed)) throw new Error(`species ${key}: two catalog rows disagree`);
		species[key] = { rarity: f.rarity, quality: qualityOf(f), current, proposed };
	};
	for (const f of FISH) add(f, F.proposedValue(f));

	const buckets = new Map();
	const donorsFor = (rarity, quality) => {
		const key = `${rarity}|${quality}`;
		if (!buckets.has(key)) {
			const list = FISH.filter((f) => f.biome === DONOR_BIOME && f.rarity === rarity && qualityOf(f) === quality)
				.sort((a, b) => (yearRound(b) - yearRound(a)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
			if (!list.length) throw new Error(`Mountain Stream: no ${DONOR_BIOME} donor for ${key}`);
			buckets.set(key, { list, used: 0 });
		}
		return buckets.get(key);
	};
	const ladder = world.ladderSpecies();
	const params = new Map(world.PARAMS.mountainStream.ladder.map((s) => [s.name, s]));
	const rows = ladder.map((s) => {
		const p = params.get(s.name);
		if (s.existing) return { name: s.name, rarity: s.rarity, quality: qualityOf(s), weather: s.weather, season: s.season, existing: true };
		const bucket = donorsFor(p.rarity, p.quality);
		const donor = bucket.list[bucket.used % bucket.list.length];
		bucket.used++;
		const row = { name: s.name, rarity: p.rarity, quality: p.quality, weather: p.weather || 'all', season: 'all', existing: false, donor: `${DONOR_BIOME}|${donor.name}`, ...pick(donor, COPIED) };
		add({ ...row, biome: 'Mountain Stream', qualities: [p.quality] }, s.value);
		return row;
	});
	return { species, mountainStream: { level: F.BIOME_LEVEL['Mountain Stream'], donorBiome: DONOR_BIOME, species: rows } };
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
	const { species: speciesValues, mountainStream } = speciesData(F, world);

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
			// Per species ('<biome>|<name>'): today's expected raw value (current) and the 5B expected value
			// (proposed). A catch's raw roll is scaled by proposed / current (P-VALUE-MODEL; step C rule).
			species: speciesValues,
		},

		// Engine rules the model runs (P-LUCKY: Lucky items pinned to the normal base rate; P-DURABILITY:
		// n × (1 − efficiency) with stochastic rounding and no minimum).
		rules: { luckyItems: F.RULES.luckyItems, durability: F.RULES.durability, luckyItemShare: LUCKY_ITEM_SHARE },

		// XP per fish = the 10-25 roll (mean) × rarity weight (P-XP-RARITY).
		xp: { perFishMean: F.XP_PER_FISH_MEAN, rarity: { ...F.XP_RARITY } },

		// Normal-player multi-catch chain and the global ceiling on the final mean (A-MULTICATCH).
		multiCatch: { ...F.MULTI, ceilingMean: rods.PARAMS.multi.ceilingMean },

		world: { biomeOrder: [...F.BIOME_ORDER], biomeLevel: { ...F.BIOME_LEVEL }, mountainStream },

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
			// The Rod Workshop (P-RODS-CUSTOM-LEVEL-RULE, P-RODS-SLOT-FAMILIES, P-RODS-VARIANTS, P-RODS-DURABILITY,
			// P-RODS-REPAIR): part levels, slot stat families, variants, durability base and repair cost per
			// rod-piece rarity (computed by the model), unlimited repairs.
			custom: {
				minLevel: rods.PARAMS.craft.minLevel,
				qualities: [...rods.PARAMS.craft.qualities],
				partLevel: { ...rods.PARAMS.partLevel },
				tierOfRarity: { ...rods.PARAMS.tierOfRarity },
				slots: JSON.parse(JSON.stringify(rods.PARAMS.slots)),
				variants: JSON.parse(JSON.stringify(rods.PARAMS.variants)),
				durabilityBase: Object.fromEntries(rods.RARITY_ORDER.map((r) => [r, rods.baseDurability(r)])),
				durabilityRoundTo: rods.PARAMS.durability.roundTo,
				repairCost: Object.fromEntries(rods.RARITY_ORDER.map((r) => [r, rods.repairCostFor(r)])),
				maxRepairs: rods.PARAMS.repair.craftedMaxRepairs,
			},
			// Tier crates (P-RODS-CRATES, P-RODS-CRATE-PRICE): Gacha V2 definitions and prices.
			crates: rods.crateDefinitions().map((c) => pick(c, ['tier', 'id', 'name', 'slots', 'strategy', 'pool', 'rarityTable', 'rarityFloor', 'guaranteedSlots', 'duplicates', 'pity', 'shop', 'price'])),
			// Salvage value per part rarity (P-RODS-SALVAGE).
			salvage: Object.fromEntries(rods.RARITY_ORDER.map((r) => [r, rods.salvageValue(r)])),
			// Existing crafted rods (P-RODS-LEGACY-RODS, P-RODS-LEGACY-DURABILITY): legacy fingerprint -> the
			// weakest catalog combination with it (Path B); unknown fingerprints use a matched Common set.
			legacy: {
				signatures: Object.fromEntries([...rods.legacyIndexMap().entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([sig, r]) => [sig, [...r.names]])),
				defaultRarity: 'Common',
			},
			// Owned Fishing Crates (P-RODS-FISHING-CRATE, option b).
			legacyCrate: { ...rods.PARAMS.legacyCrateStock },
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

		// Read-time overlay of EXISTING catalog rows while the 5B flag is on (stored rows are never rewritten):
		// fields per row name.
		catalog: {
			overlay: {
				// The Fishing Crate becomes the T1 part crate (rods catalogSync; P-RODS-FISHING-CRATE).
				...Object.fromEntries(rods.catalogSync().updates.filter((u) => u.row !== 'Old Rod').reduce((m, u) => {
					const row = m.get(u.row) || {};
					if (u.field === 'requirements.level') row.requirements = { level: u.after };
					else row[u.field] = u.after;
					return m.set(u.row, row);
				}, new Map())),
				// The Old Rod is unbreakable (P-RODS-OLD-ROD).
				'Old Rod': { unbreakable: rods.PARAMS.oldRod.unbreakable },
			},
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
