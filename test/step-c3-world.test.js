// Step C.3 (dark behind the 5B flag): biome permits, the single access rule, grandfathering, the cast guard,
// Mountain Stream, and the Founder public gate with its one-time biome move.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { userDoc } = require('./helpers/castFixtures');
const { with5b } = require('./helpers/withFlag');
const config = require('../src/config');
const { castLine } = require('../src/engine/cast');
const world5b = require('../src/engine/b5/world');
const { buyPermit } = require('../src/engine/b5/permitOps');
const { migrateBiomePermits, migrateFounderBiome } = require('../src/engine/b5/migrations');
const { validate5b } = require('../src/engine/b5/validate');
const { gateLevelOf } = require('../src/engine/levelGate');
const levels = require('../src/engine/levels');
const { levelForXp } = require('../src/engine/balance');
const { User } = require('../src/class/User');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { Biome } = require('../src/schemas/BiomeSchema');
const { Fish } = require('../src/schemas/FishSchema');
const { DevAudit } = require('../src/schemas/DevAuditSchema');
const { WeatherPattern } = require('../src/schemas/WeatherPatternSchema');
const { visibleCatalog } = require('../src/engine/b5/catalog');
const { rng } = require('../src/engine/rng');
const modelWorld = require('../scripts/economy/5b/world');
const weatherFish = require('../src/bootstrap/data/weatherFish');

const FOUNDER = 'c3-founder';
let savedFounders;

test.before(async () => {
	quiet();
	savedFounders = config.users.founders;
	config.users.founders = [FOUNDER];
	await startDb();
	await seedGame();
});
test.after(async () => {
	config.users.founders = savedFounders;
	rng.reset();
	await stopDb();
	restore();
});

async function atLevel(userId, level, extra = {}) {
	const xp = levels.CURVES['5b'].xpForLevel(level);
	await UserModel.updateOne({ userId }, { $set: { xp, publicXp: xp, level, levelFloor: level, publicLevelFloor: level, ...extra } });
}

async function snapshot() {
	const out = {};
	for (const c of await mongoose.connection.db.collections()) out[c.collectionName] = JSON.stringify(await c.find({}).sort({ _id: 1 }).toArray());
	return out;
}

test('access rule: level AND (free or permit); prices are the model\'s; no chain', async () => {
	await with5b(async () => {
		assert.deepEqual(world5b.accessibleBiomes(0, []), ['Ocean']);
		assert.deepEqual(world5b.accessibleBiomes(25, []), ['Ocean']);
		assert.deepEqual(world5b.accessibleBiomes(25, [{ biome: 'Lake' }]), ['Ocean', 'Lake'], 'no chain: Lake without River');
		assert.deepEqual(world5b.accessibleBiomes(15, [{ biome: 'Lake' }]), ['Ocean'], 'a permit never bypasses the level');
		const prices = modelWorld.permitPriceMap();
		for (const [b, p] of Object.entries(prices)) assert.equal(world5b.permitPrice(b), p);
		assert.equal(world5b.permitPrice('Ocean'), 0);
		for (let L = 0; L <= 70; L += 5) {
			const permits = [{ biome: 'River' }, { biome: 'Pond' }];
			assert.deepEqual(world5b.accessibleBiomes(L, permits), modelWorld.accessibleBiomes(L, permits, { biomes: [...modelWorld.PARAMS.permits.free, 'River', 'Lake', 'Pond', 'Coast', 'Swamp', 'Mountain Stream'] }), `L${L}`);
		}
	});
});

test('buying a permit: level gate, one charge under a double click, insufficient changes nothing, never re-charged', async () => {
	await makeUser('c3-buy');
	await with5b(async () => {
		await atLevel('c3-buy', 9, { 'inventory.money': 5000, permits: [] });
		assert.equal((await buyPermit('c3-buy', 'River')).code, 'LEVEL_LOCKED');
		await atLevel('c3-buy', 10, { 'inventory.money': 1500 });
		const [a, b] = await Promise.all([buyPermit('c3-buy', 'River'), buyPermit('c3-buy', 'River')]);
		assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
		let u = await userDoc('c3-buy');
		assert.equal(u.inventory.money, 500);
		assert.equal(u.permits.length, 1);
		assert.equal(u.permits[0].source, 'purchased');
		assert.equal(u.permits[0].pricePaid, 1000);
		assert.equal((await buyPermit('c3-buy', 'River')).code, 'OWNED');
		await atLevel('c3-buy', 20);
		assert.equal((await buyPermit('c3-buy', 'Lake')).code, 'INSUFFICIENT');
		u = await userDoc('c3-buy');
		assert.equal(u.inventory.money, 500);
		assert.equal(u.permits.length, 1);
	});
});

test('grandfathering: the model rule on accounts without the field; a second run and accounts with the field untouched', async () => {
	const now = new Date('2026-09-01T00:00:00Z');
	assert.ok(modelWorld.MIGRATION_EXAMPLES.length >= 3);
	for (const [i, ex] of modelWorld.MIGRATION_EXAMPLES.entries()) {
		await with5b(async () => assert.deepEqual(world5b.grandfatheredPermits(ex.user, { now, legacyLevelForXp: levelForXp }), modelWorld.grandfatheredPermits(ex.user, { now }), `example ${i}`));
	}
	await makeUser('c3-old');
	await makeUser('c3-has');
	await UserModel.collection.updateOne({ userId: 'c3-old' }, { $set: { level: 34, xp: 118000, currentBiome: 'pond' }, $unset: { permits: '' } });
	await UserModel.collection.updateOne({ userId: 'c3-has' }, { $set: { permits: [] } });
	await with5b(async () => {
		await migrateBiomePermits({ now });
		const before = await snapshot();
		const second = await migrateBiomePermits({ now });
		assert.equal(second.written, 0);
		assert.deepEqual(await snapshot(), before, 'a second run changes nothing');
	});
	assert.deepEqual((await userDoc('c3-old')).permits.map((p) => p.biome), ['River', 'Lake', 'Pond']);
	assert.deepEqual((await userDoc('c3-has')).permits, []);
	// A new account created with the 5B flag on holds no permits (never grandfathered).
	await with5b(() => User.get('c3-new'));
	assert.deepEqual((await userDoc('c3-new')).permits, []);
});

test('cast guard: an inaccessible biome is refused before any roll, with no side effect', async () => {
	await makeUser('c3-guard');
	await with5b(async () => {
		await atLevel('c3-guard', 25, { permits: [], currentBiome: 'lake' });
		const before = await snapshot();
		const r = await castLine({ userId: 'c3-guard', channelId: 'c3' });
		assert.equal(r.status, 'failed');
		assert.equal(r.failure.code, 'BIOME_LOCKED');
		assert.deepEqual(await snapshot(), before);
	});
});

test('Mountain Stream: hidden with the flag off; the grid is complete; existing salmon untouched; every weather catches', async () => {
	// Flag off: not in today's biome list or box fish.
	assert.equal((await Biome.find(visibleCatalog())).some((b) => b.name === 'Mountain Stream'), false);
	await with5b(async () => {
		assert.deepEqual(await validate5b(), []);
		assert.equal((await Biome.find(visibleCatalog())).some((b) => b.name === 'Mountain Stream'), true);
	});
	const ms = await Fish.find({ biome: 'Mountain Stream', user: null }).lean();
	assert.equal(ms.length, modelWorld.PARAMS.mountainStream.ladder.length);
	for (const name of ['Flashfin Salmon', 'Shrouded Salmon', 'Zephyr Salmon']) {
		const row = ms.find((f) => f.name === name);
		const seed = weatherFish.find((f) => f.name === name);
		assert.equal(row.release, undefined, `${name} is today's row`);
		for (const k of ['rarity', 'weather', 'baseValue', 'minSize', 'maxSize', 'minWeight', 'maxWeight']) assert.equal(row[k], seed[k], `${name}.${k}`);
	}
	const data = require('../src/engine/data/balance-5b.json').world.mountainStream;
	for (const s of data.species.filter((x) => !x.existing)) {
		const row = ms.find((f) => f.name === s.name);
		assert.equal(row.season, 'all', `${s.name} is year-round`);
		assert.ok(s.donor.startsWith('River|'));
		assert.equal(row.baseValue, s.baseValue);
	}
	// A level 60 player with the permit catches something in every weather, with the Old Rod.
	await makeUser('c3-ms');
	await with5b(async () => {
		await atLevel('c3-ms', 60, { permits: [{ biome: 'Mountain Stream', source: 'purchased' }], currentBiome: 'Mountain Stream' });
		const active = await WeatherPattern.findOne({ type: 'weather', active: true });
		const saved = active.weather;
		for (const weather of ['Sunny', 'Rainy', 'Cloudy', 'Snowy', 'Windy']) {
			await WeatherPattern.updateOne({ _id: active._id }, { $set: { weather } });
			for (let seed = 1; seed <= 5; seed++) {
				rng.seed(seed);
				const r = await castLine({ userId: 'c3-ms' });
				assert.equal(r.status, 'ok', `${weather}: ${r.failure?.message}`);
				assert.equal(r.environment.biome, 'Mountain Stream');
			}
		}
		rng.reset();
		await WeatherPattern.updateOne({ _id: active._id }, { $set: { weather: saved } });
	});
});

test('Founder: the gate is the public level under 5B; the biome move is audited and runs once', async () => {
	await makeUser(FOUNDER);
	// Real level 55 (xp), public level 20; standing in the Swamp with grandfathered permits.
	const real = levels.CURVES['5b'].xpForLevel(55);
	const pub = levels.CURVES['5b'].xpForLevel(20);
	await UserModel.updateOne({ userId: FOUNDER }, { $set: { xp: real, publicXp: pub, level: 55, levelFloor: 55, publicLevelFloor: 20, currentBiome: 'swamp' } });
	await UserModel.collection.updateOne({ userId: FOUNDER }, { $unset: { permits: '' } });
	assert.equal(gateLevelOf(await userDoc(FOUNDER)), levels.levelOf(await userDoc(FOUNDER)), 'flag off: the real level');
	await with5b(async () => {
		assert.equal(gateLevelOf(await userDoc(FOUNDER)), 20);
		await migrateBiomePermits();
		const first = await migrateFounderBiome();
		assert.deepEqual(first.moved.map((m) => m.to), ['lake']);
		assert.equal((await userDoc(FOUNDER)).currentBiome, 'lake');
		assert.equal(await DevAudit.countDocuments({ operation: '5b-founder-biome', target: FOUNDER }), 1);
		assert.deepEqual((await migrateFounderBiome()).moved, []);
		const r = await castLine({ userId: FOUNDER });
		assert.equal(r.status, 'ok');
	});
});
