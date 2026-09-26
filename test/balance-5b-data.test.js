// The generated Phase 5B balance data (src/engine/data/balance-5b.json) against its two sources:
//   1. drift: the committed file is byte-for-byte what scripts/economy/5b/export-balance.js builds now
//      from the framework and subsystem modules (so a model change cannot silently skip the engine);
//   2. approval: every value the file shares with an APPROVED decision of the registry (decisions.js)
//      equals that decision's `expected` value (so the engine can only ship approved numbers).
// Only cheap reads are used: the exporter (about 1.5 s) and each approved entry's plain `expected` field,
// never decisions.all() (which evaluates heavy report getters).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const exporter = require('../scripts/economy/5b/export-balance');
const decisions = require('../scripts/economy/5b/decisions');
const F = require('../scripts/economy/5b/framework');
const balance = require('../src/engine/balance');

const committedText = fs.readFileSync(exporter.OUT, 'utf8');
const data = JSON.parse(committedText);
const approved = new Map(decisions.approvedEntries().map((d) => [d.id, d]));

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const byTier = (rows, fn) => Object.fromEntries(rows.filter((l) => l.water === rows[0].water).map((l) => [l.tier, fn(l)]));

test('balance-5b.json is what export-balance.js generates now (run the exporter after any model change)', () => {
	const built = exporter.serialise(exporter.build());
	assert.equal(committedText, built, 'stale: node scripts/economy/5b/export-balance.js');
});

test('balance-5b.json carries its version stamp and a valid content hash', () => {
	assert.equal(data.schema, exporter.SCHEMA);
	assert.equal(data.balanceVersion, '5b');
	assert.equal(data.frameworkVersion, F.FRAMEWORK_VERSION);
	assert.equal(data.sharedDigest, F.VERSION_DIGESTS[F.FRAMEWORK_VERSION], 'exported at the digest pinned for this framework version');
	assert.match(data.contentHash, /^[0-9a-f]{16}$/);
	assert.equal(data.contentHash, exporter.contentHash(data), 'the file was edited by hand');
});

/**
 * How each approved decision reads from the data file, in the shape of its `expected` value. Where the
 * decision's `expected` holds more than the engine needs (analysis fields), the projection compares the
 * engine subset: `keys` names it.
 */
const PROJECTIONS = {
	'A-CURVE': (d) => d.curve,
	'A-MULTICATCH': (d) => pick(d.multiCatch, ['jackpotChain', 'maxFish']),
	'P-RODS-CUSTOM-RELATION': { keys: ['ceilingMean'], read: (d) => ({ ceilingMean: d.multiCatch.ceilingMean }) },
	'P-BAIT-SPINNER-TIERS': { keys: ['ceilingMean'], read: (d) => ({ ceilingMean: d.multiCatch.ceilingMean }) },
	'P-VALUE-MODEL': (d) => ({ biome: pick(d.value.biome, d.value.liveBiomes), rarity: d.value.rarity, quality: d.value.quality, clamp: d.value.speciesClamp }),
	'P-MS-VALUE': (d) => d.value.biome['Mountain Stream'],
	'P-XP-RARITY': (d) => ({ mean: d.xp.perFishMean, weights: d.xp.rarity }),
	'P-DOUBLE-CASH': (d) => d.buffs.doubleCashTiming,
	'P-EVENTS': (d) => d.buffs.eventsPerThirtyDays,
	'P-BUFFS-DURATION': (d) => ({ 'Double XP': d.buffs.catalog['Double XP'].duration, 'Double Cash': d.buffs.catalog['Double Cash'].duration }),
	'P-BUFFS-QUEUE': (d) => d.buffs.queue,
	'P-WORLD-PERMIT-PRICES': (d) => d.permits.prices,
	'P-RODS-STANDARD-PRICES': (d) => d.rods.standard.map((r) => r.price),
	'P-RODS-STANDARD-LADDER': (d) => d.rods.standard.map((r) => ({ name: r.name, level: r.unlockLevel, meanFish: r.meanFish, qualities: r.qualities, stats: pick(r.stats, ['rareFind', 'luck', 'trophyChance', 'fishingSpeed', 'sellBonus']), lifeHours: r.lifeHours })),
	'P-UPGRADES-CATEGORIES': (d) => Object.fromEntries(Object.entries(d.upgrades.categories).map(([k, u]) => [k, { stat: u.stat, perLevel: u.perLevel }])),
	'P-UPGRADES-LEVELS': (d) => ({ levels: d.upgrades.levels, unlockLevels: d.upgrades.unlockLevels }),
	'P-UPGRADES-PRICES': (d) => Object.fromEntries(Object.entries(d.upgrades.categories).map(([k, u]) => [k, u.priceHours])),
	'P-AQUARIUM-LICENSE-PRICE': { keys: ['prices'], read: (d) => ({ prices: byTier(d.aquarium.licenses, (l) => l.price) }) },
	'P-AQUARIUM-LICENSE-GATES': (d) => byTier(d.aquarium.licenses, (l) => l.level),
	'P-AQUARIUM-TANKS': (d) => byTier(d.aquarium.licenses, (l) => ({ tanks: l.tanks, tankSize: l.tankSize })),
	'P-AQUARIUM-COMPANION-SLOTS': (d) => byTier(d.aquarium.licenses, (l) => l.companionSlots),
	'P-AQUARIUM-DISPLAY-TANKS': { keys: ['requires', 'perWaterType', 'tankSize', 'approvedPrices', 'prices'], read: (d) => ({ ...pick(d.aquarium.display, ['requires', 'perWaterType', 'tankSize']), approvedPrices: d.aquarium.display.prices, prices: d.aquarium.display.prices }) },
	'P-FOUNDER-HYBRID': { keys: ['rolls', 'xp', 'sell', 'repairRebate', 'gates', 'boxLuck', 'competitiveEligible'], read: (d) => pick(d.founder, ['rolls', 'xp', 'sell', 'repairRebate', 'gates', 'boxLuck', 'competitiveEligible']) },
};

test('every value the file shares with an approved decision equals the approved value', () => {
	const problems = [];
	for (const [id, projection] of Object.entries(PROJECTIONS)) {
		const entry = approved.get(id);
		if (!entry) {
			problems.push(`${id} is not an approved decision (was it renamed or un-approved?)`);
			continue;
		}
		if (entry.expected === undefined) {
			problems.push(`${id} has no expected value in the registry`);
			continue;
		}
		const { keys, read } = typeof projection === 'function' ? { keys: null, read: projection } : projection;
		const want = keys ? pick(entry.expected, keys) : entry.expected;
		try {
			assert.deepStrictEqual(read(data), want);
		}
		catch {
			problems.push(`${id}: data file has ${JSON.stringify(read(data))}, approved ${JSON.stringify(want)}`);
		}
	}
	assert.deepEqual(problems, []);
});

test('the headline approved numbers are in the file (curve, permits, standard rods, Founder hybrid)', () => {
	for (const id of ['A-CURVE', 'P-WORLD-PERMIT-PRICES', 'P-RODS-STANDARD-PRICES', 'P-RODS-STANDARD-LADDER', 'P-FOUNDER-HYBRID', 'P-UPGRADES-PRICES']) {
		assert.ok(approved.has(id), `${id} approved`);
		assert.ok(id in PROJECTIONS, `${id} checked against the file`);
	}
	// Standard ladder rows carry everything the rods step needs, and nothing the ladder omits.
	for (const r of data.rods.standard) {
		for (const k of ['name', 'unlockLevel', 'price', 'stats', 'meanFish', 'maxDurability', 'repairCost']) assert.ok(r[k] !== undefined && r[k] !== null, `${r.name}.${k}`);
		assert.equal(r.stats.xpBonus, 0);
		assert.equal(r.stats.durabilityEfficiency, 0);
	}
	assert.equal(data.rods.oldRod.unbreakable, true);
	// Normal-player mean never exceeds the approved 1.80 ceiling on the standard ladder.
	assert.ok(data.rods.standard.every((r) => r.meanFish <= data.multiCatch.ceilingMean));
});

test('balance.js exposes the file as the 5b balance version, read-only', () => {
	const b = balance.balanceData('5b');
	assert.equal(b, balance.loadBalance5b());
	assert.equal(b.balanceVersion, balance.BALANCE_VERSION_5B);
	assert.deepEqual(JSON.parse(JSON.stringify(b)), data);
	assert.ok(Object.isFrozen(b) && Object.isFrozen(b.rods.standard[0].stats));
	assert.throws(() => balance.balanceData('9z'), /unknown balance version/);
	// The current (live) version is untouched.
	assert.notEqual(balance.BALANCE_VERSION, '5b');
});
