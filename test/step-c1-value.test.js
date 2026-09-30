// Step C.1 (dark behind the 5B flag): the 5B curve, catch value scaled once to the 5B species
// expectation, and XP per fish weighted by rarity (floored per fish).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { userDoc } = require('./helpers/castFixtures');
const { with5b } = require('./helpers/withFlag');
const { castLine, applyCastResult, recoverPendingCasts } = require('../src/engine/cast');
const levels = require('../src/engine/levels');
const balance = require('../src/engine/balance');
const value5b = require('../src/engine/b5/value');
const { Fish, FishData } = require('../src/schemas/FishSchema');
const { Cast } = require('../src/schemas/CastSchema');
const { rng } = require('../src/engine/rng');
const { FISH, currentValue } = require('../scripts/economy/lib/catalog-model');
const F = require('../scripts/economy/5b/framework');

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
});
test.after(async () => {
	rng.reset();
	await stopDb();
	restore();
});

test('the curve switches to the 5B curve only with the flag on', async () => {
	assert.equal(levels.activeCurve().name, 'current');
	assert.equal(levels.curveLevel(48400), 22);
	await with5b(async () => {
		assert.equal(levels.activeCurve().name, '5b');
		assert.equal(levels.curveLevel(48400), 20);
		assert.equal(levels.curveLevel(48399), 19);
		for (const L of [1, 10, 20, 30, 40, 50, 60]) assert.equal(levels.CURVES['5b'].xpForLevel(L), F.xpForLevel(L));
		// Floors from step A still hold: a stored floor above the 5B curve is kept.
		assert.equal(levels.levelOf({ xp: 48400, levelFloor: 22 }), 22);
	});
	assert.equal(levels.activeCurve().name, 'current');
});

test('rules5b() is null with the flag off and the data with it on', async () => {
	assert.equal(balance.rules5b(), null);
	assert.throws(() => balance.need5b(), /switched off/);
	await with5b(async () => assert.equal(balance.rules5b().balanceVersion, '5b'));
});

test('value data: every catalog species has positive current and 5B values equal to the model', async () => {
	await with5b(async () => {
		for (const f of FISH) {
			const row = value5b.speciesValue(f);
			assert.equal(row.current, Number(currentValue(f).toPrecision(12)), f.name);
			assert.equal(row.proposed, Number(F.proposedValue(f).toPrecision(12)), f.name);
		}
		const templates = await Fish.find({ user: null }).lean();
		assert.deepEqual(value5b.missingValueData(templates), [], 'every seeded fish template has 5B value data');
		assert.deepEqual(value5b.missingValueData([{ biome: 'Nowhere', name: 'Ghost', type: 'fish' }]), ['Nowhere|Ghost']);
		assert.throws(() => value5b.scaleRaw(10, { biome: 'Nowhere', name: 'Ghost' }), (e) => e.code === 'NO_VALUE_DATA');
	});
});

test('scaleRaw: raw × proposed / current, nearest integer; the mean lands on the 5B expectation', async () => {
	await with5b(async () => {
		const carp = FISH.find((f) => f.name === 'Carp' && f.biome === 'River');
		const { current, proposed } = value5b.speciesValue(carp);
		for (const raw of [0, 1, 17, 250, 999]) assert.equal(value5b.scaleRaw(raw, carp), Math.round((raw * proposed) / current));
		const { rollFishStats } = require('../src/engine/rewards');
		rng.seed(11);
		let sum = 0;
		const n = 3000;
		for (let i = 0; i < n; i++) sum += value5b.scaleRaw((await rollFishStats(carp)).rawValue, carp);
		rng.reset();
		assert.ok(Math.abs(sum / n / proposed - 1) < 0.02, `mean ${sum / n} vs 5B expectation ${proposed}`);
	});
});

test('XP per fish: floor(roll × rarity weight)', async () => {
	await with5b(async () => {
		assert.equal(value5b.fishXp(17, 'Common'), 17);
		assert.equal(value5b.fishXp(17, 'Uncommon'), Math.floor(17 * 1.2));
		assert.equal(value5b.fishXp(13, 'Rare'), 19);
		assert.equal(value5b.fishXp(24, 'Lucky'), 144);
		assert.throws(() => value5b.fishXp(10, 'Mythic'), /no 5B XP weight/);
	});
});

test('a 5B cast: balance version 5b, value scaled once, XP by rarity; replay never scales again', async () => {
	await makeUser('c1-player');
	rng.seed(5);
	const r = await with5b(() => castLine({ userId: 'c1-player', guildId: 'g', channelId: null }));
	rng.reset();
	assert.equal(r.status, 'ok');
	assert.equal(r.balanceVersion, '5b');
	const fish = r.catches.filter((c) => c.kind === 'fish');
	assert.ok(fish.length > 0);
	await with5b(async () => {
		for (const c of fish) {
			const template = { biome: c.biome, name: c.name };
			assert.equal(c.rawValue, value5b.scaleRaw(c.rawRoll, template));
			assert.equal(c.value, Math.round(c.rawValue * r.modifiers.sell.multiplier));
		}
	});
	const units = r.catches.flatMap((c) => Array(c.count).fill(c.rarity));
	assert.deepEqual(r.xp.perFish, r.xp.rolls.map((roll, i) => Math.floor(roll * balance.balanceData('5b').xp.rarity[units[i].toLowerCase()])));

	// Journal it as pending (a crash before the commit), recover twice, apply again: the stored values are
	// the journal's, written once.
	await Cast.create({ _id: r.castId, userId: r.userId, result: r, status: 'pending' });
	assert.equal(await recoverPendingCasts({ userId: 'c1-player' }), 1);
	assert.equal(await recoverPendingCasts({ userId: 'c1-player' }), 0);
	await applyCastResult(r);
	const docs = await FishData.find({ castId: r.castId }).lean();
	assert.deepEqual(docs.map((d) => d.value).sort(), fish.map((c) => c.value).sort());
	assert.ok(docs.every((d) => d.balanceVersion === '5b'));
	const u = await userDoc('c1-player');
	assert.equal(u.xp, r.xp.total);
});

test('flag off: the same seeded cast is today\'s cast', async () => {
	await makeUser('c1-off');
	rng.seed(5);
	const r = await castLine({ userId: 'c1-off' });
	rng.reset();
	assert.equal(r.balanceVersion, balance.BALANCE_VERSION);
	assert.equal(r.xp.rolls, undefined);
	assert.ok(r.catches.every((c) => c.rawRoll === undefined));
});

test('boot validation with the flag on refuses a species without 5B value data', async () => {
	const { validate5b } = require('../src/engine/b5/validate');
	await with5b(async () => assert.deepEqual(await validate5b(), []));
	await Fish.create({ name: 'Unpriced Fish', biome: 'Ocean', rarity: 'Common', type: 'fish', weather: 'all', season: 'all', qualities: ['weak'], minSize: 1, maxSize: 2, minWeight: 1, maxWeight: 2, baseValue: 1 });
	await with5b(async () => assert.match((await validate5b()).join(), /5B value data missing for 1 species: Ocean\|Unpriced Fish/));
	await Fish.deleteOne({ name: 'Unpriced Fish' });
});
