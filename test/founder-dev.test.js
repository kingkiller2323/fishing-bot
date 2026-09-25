// Founder Mode, pity persistence, competitive separation, /dev tools and cooldowns (database-backed).
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { addPoolFish, useTestRod, userDoc } = require('./helpers/castFixtures');
const { castLine, applyCastResult, fishingStats } = require('../src/engine/cast');
const { competitiveCatches } = require('../src/engine/competitive');
const dev = require('../src/engine/dev');
const { remainingMs, startCooldown, resetCooldowns } = require('../src/engine/cooldown');
const { PROFILES } = require('../src/engine/balance');
const { FishData } = require('../src/schemas/FishSchema');
const { ItemData } = require('../src/schemas/ItemSchema');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { DevAudit } = require('../src/schemas/DevAuditSchema');
const config = require('../src/config');
const { rng } = require('../src/engine/rng');

const saved = { founders: config.users.founders, developers: config.users.developers };

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
	await addPoolFish([{ name: 'Pool Minnow', rarity: 'Common' }, { name: 'Pool Legend', rarity: 'Legendary', baseValue: 100 }]);
	config.users.founders = ['founder'];
	config.users.developers = ['dev'];
});
test.after(async () => {
	Object.assign(config.users, saved);
	rng.reset();
	await stopDb();
	restore();
});

test('Founder casts: 5x XP, 10x sale value, 3 draws, cheaper durability, non-competitive', async () => {
	await makeUser('founder');
	await useTestRod('founder', { capabilities: ['weak', '1'], durability: 100 });
	rng.seed(5);
	const r = await castLine({ userId: 'founder' });
	assert.equal(r.profile, 'founder');
	assert.equal(r.competitiveEligible, false);
	assert.equal(r.units, 3);
	assert.equal(r.xp.catch, Math.floor(r.xp.base * 5));
	for (const c of r.catches) assert.equal(c.value, Math.round(c.baseValue * 10));
	assert.equal(r.rod.durabilityCost, 1, '3 fish x 0.25 rounds up to 1');
	assert.equal(r.cooldownMs, 2000);
	assert.equal(r.modifiers.sources.find((s) => s.source === 'profile').name, 'founder');
	await applyCastResult(r);
	for (const f of await FishData.find({ castId: r.castId }).lean()) assert.equal(f.competitiveEligible, false);
});

test('Founder pity: counters persist, a hard cap guarantees Legendary+, and only a real hit resets', async () => {
	await makeUser('pity-founder');
	await useTestRod('pity-founder', { capabilities: ['weak', '1'] });
	await UserModel.updateOne({ userId: 'pity-founder' }, { $set: { 'devOverrides.profile': 'founder', 'pity.castsSinceLegendary': PROFILES.founder.pity.legendaryPlus.hard - 1, 'pity.castsSinceLucky': 5 } });
	rng.seed(1);
	const r = await castLine({ userId: 'pity-founder' });
	assert.deepEqual(r.rarity.guarantee, ['legendary', 'lucky']);
	assert.ok(r.catches.some((c) => ['Legendary', 'Lucky'].includes(c.rarity)));
	assert.equal(r.pity.applied.legendaryPlus.guaranteed, true);
	assert.equal(r.pity.after.castsSinceLegendary, 0);
	await applyCastResult(r);
	assert.equal((await userDoc('pity-founder')).pity.castsSinceLegendary, 0);

	// Soft pity raises the odds recorded in the cast.
	await UserModel.updateOne({ userId: 'pity-founder' }, { $set: { 'pity.castsSinceLegendary': PROFILES.founder.pity.legendaryPlus.softStart + 5 } });
	const soft = await castLine({ userId: 'pity-founder' });
	assert.ok(soft.pity.applied.legendaryPlus.bonus > 0);
	assert.ok(soft.rarity.table.legendary > soft.modifiers.rarity.table.legendary);
});

test('normal players have no pity boost, but counters still track', async () => {
	await makeUser('pity-normal');
	await useTestRod('pity-normal', { capabilities: ['weak', '1'] });
	await UserModel.updateOne({ userId: 'pity-normal' }, { $set: { 'pity.castsSinceLegendary': 500 } });
	const r = await castLine({ userId: 'pity-normal' });
	assert.equal(r.rarity.guarantee, null);
	assert.deepEqual(r.pity.applied, {});
});

test('competitive filter: Founder, dev-luck and dev-spawned catches are excluded; legacy catches count', async () => {
	const now = new Date();
	await FishData.collection.insertMany([
		{ name: 'Legacy Pike', user: 'x', size: 999, weight: 1, obtained: now.getTime() },
		{ name: 'Founder Pike', user: 'x', size: 998, weight: 1, obtained: now.getTime(), competitiveEligible: false, profile: 'founder' },
		{ name: 'Normal Pike', user: 'x', size: 997, weight: 1, obtained: now.getTime(), competitiveEligible: true, profile: 'normal' },
	]);
	const names = (await FishData.find(competitiveCatches({ name: /Pike$/ })).lean()).map((f) => f.name).sort();
	assert.deepEqual(names, ['Legacy Pike', 'Normal Pike']);
	// Leaderboard commands use this filter for fish caught, largest size and largest weight.
	for (const file of ['global-leaderboard', 'server-leaderboard']) {
		const src = require('fs').readFileSync(require.resolve(`../src/commands/slash/Info/${file}.js`), 'utf8');
		assert.equal((src.match(/FishData\.find\(competitiveCatches\(\)\)/g) || []).length, 3, file);
		assert.ok(!/FishData\.find\(\{\}\)/.test(src), file);
	}
});

test('/dev: only DEVELOPER_IDS may use it (Founder is not a developer)', async () => {
	await makeUser('founder');
	for (const actor of ['founder', 'someone']) {
		await assert.rejects(dev.money(actor, 'someone', 'add', 5), { code: 'NOT_DEVELOPER' });
		await assert.rejects(dev.founder(actor, actor, 'on'), { code: 'NOT_DEVELOPER' });
	}
	assert.equal(await DevAudit.countDocuments({ actor: { $in: ['founder', 'someone'] } }), 0);
});

test('/dev money and xp: add and set, each audited with before/after', async () => {
	await makeUser('target');
	assert.deepEqual(await dev.money('dev', 'target', 'add', 500), { before: 0, after: 500 });
	assert.deepEqual(await dev.money('dev', 'target', 'set', 42), { before: 500, after: 42 });
	const xp = await dev.xp('dev', 'target', 'set', 40_000);
	assert.deepEqual(xp.after, { xp: 40_000, level: 20 });
	await dev.xp('dev', 'target', 'add', 50_000);
	assert.equal((await userDoc('target')).level, 30);

	const audits = await DevAudit.find({ target: 'target' }).sort({ timestamp: 1 }).lean();
	assert.deepEqual(audits.map((a) => a.operation), ['money.add', 'money.set', 'xp.set', 'xp.add']);
	for (const a of audits) {
		assert.equal(a.actor, 'dev');
		assert.ok(a.before && a.after && a.timestamp instanceof Date);
	}
});

test('/dev give stacks catalog items; /dev spawn creates a non-competitive fish', async () => {
	await makeUser('gifts');
	assert.deepEqual(await dev.give('dev', 'gifts', 'magic lure', 3), { item: 'Magic Lure', before: 0, after: 3 });
	assert.equal((await dev.give('dev', 'gifts', 'Magic Lure', 2)).after, 5);
	await assert.rejects(dev.give('dev', 'gifts', 'No Such Thing'), /No catalog item/);

	const s = await dev.spawn('dev', 'gifts', 'kraken', { size: 900, weight: 800 });
	const fish = await FishData.findById(s.fishId).lean();
	assert.equal(fish.name, 'Kraken');
	assert.equal(fish.competitiveEligible, false);
	assert.equal(fish.profile, 'dev-spawn');
	assert.ok((await userDoc('gifts')).inventory.fish.map(String).includes(s.fishId));
	assert.equal(await DevAudit.countDocuments({ target: 'gifts', operation: { $in: ['give', 'spawn'] } }), 3);
});

test('/dev founder toggles the gameplay profile without touching FOUNDER_IDS', async () => {
	await makeUser('toggle');
	await useTestRod('toggle', { capabilities: ['weak', '1'] });
	assert.equal((await castLine({ userId: 'toggle' })).profile, 'normal');
	await dev.founder('dev', 'toggle', 'on');
	assert.equal((await castLine({ userId: 'toggle' })).profile, 'founder');
	await dev.founder('dev', 'toggle', 'test');
	assert.equal((await castLine({ userId: 'toggle' })).profile, 'test');
	await dev.founder('dev', 'toggle', 'default');
	assert.equal((await castLine({ userId: 'toggle' })).profile, 'normal');
	assert.deepEqual(config.users.founders, ['founder']);

	// A real Founder can be switched off for testing the normal game.
	await useTestRod('founder', { capabilities: ['weak', '1'] });
	await dev.founder('dev', 'founder', 'off');
	assert.equal((await castLine({ userId: 'founder' })).profile, 'normal');
	await dev.founder('dev', 'founder', 'default');
	assert.equal((await castLine({ userId: 'founder' })).profile, 'founder');
});

test('/dev luck raises luck temporarily and makes catches non-competitive', async () => {
	await makeUser('lucky');
	await useTestRod('lucky', { capabilities: ['weak', '1'] });
	const before = await castLine({ userId: 'lucky' });
	await dev.luck('dev', 'lucky', 5, 30);
	const boosted = await castLine({ userId: 'lucky' });
	assert.equal(boosted.competitiveEligible, false);
	assert.ok(boosted.modifiers.rarity.table.legendary > before.modifiers.rarity.table.legendary * 5);
	await dev.luck('dev', 'lucky', 0);
	assert.equal((await castLine({ userId: 'lucky' })).competitiveEligible, true);
});

test('custom rods in the database use their parts', async () => {
	await makeUser('crafted');
	const parts = await Promise.all(['Composite Rod Piece', 'Sage Green Reel', 'Worm Hook', 'Composite Handle'].map(async (name) => {
		const t = await mongoose.connection.db.collection('items').findOne({ name });
		const _id = new mongoose.Types.ObjectId();
		await ItemData.collection.insertOne({ ...t, _id, user: 'crafted' });
		return _id;
	}));
	const rodId = new mongoose.Types.ObjectId();
	await ItemData.collection.insertOne({ _id: rodId, __t: 'CustomRodData', type: 'customrod', name: 'Elite Rod', description: 'x', rarity: 'Legendary', user: 'crafted', rod: parts[0], reel: parts[1], hook: parts[2], handle: parts[3], capabilities: ['weak', 'strong', 'quick', '12', '7 count'], durability: 17000, maxDurability: 17000, state: 'mint' });
	await UserModel.updateOne({ userId: 'crafted' }, { $set: { 'inventory.equippedRod': rodId, currentBiome: 'ocean' } });
	const r = await castLine({ userId: 'crafted' });
	const rodSource = r.modifiers.sources.find((s) => s.source === 'rod');
	assert.equal(rodSource.parts.length, 4);
	assert.equal(r.modifiers.stats.luck, 0.8);
	assert.equal(r.draws.draws, PROFILES.normal.limits.maxDraws, 'legacy 12 draws capped');
	assert.equal(r.draws.perDraw, PROFILES.normal.limits.maxPerDraw, 'legacy 7 per draw capped');
});

test('fishingStats exposes the player\'s resolved odds without writing anything', async () => {
	await makeUser('stats');
	await useTestRod('stats', { capabilities: ['weak', '1'] });
	const before = await userDoc('stats');
	const s = await fishingStats('stats');
	assert.equal(s.status, 'ok');
	assert.equal(s.profile, 'normal');
	assert.ok(Math.abs(Object.values(s.odds).reduce((a, b) => a + b, 0) - 100) < 0.01);
	assert.deepEqual(await userDoc('stats'), before);
});

test('cooldown: per-player, uses the cast\'s Fishing Speed, never below the floor', () => {
	resetCooldowns();
	const t0 = 1_000_000;
	assert.equal(remainingMs('a', t0), 0);
	startCooldown('a', 2000, t0);
	assert.equal(remainingMs('a', t0 + 500), 1500);
	assert.equal(remainingMs('b', t0 + 500), 0);
	startCooldown('c', 10, t0);
	assert.equal(remainingMs('c', t0), 1500, 'floor');
	assert.equal(remainingMs('a', t0 + 2000), 0);
});
