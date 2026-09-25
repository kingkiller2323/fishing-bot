const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { addPoolFish, useTestRod, useTestBait, giveQuest, userDoc } = require('./helpers/castFixtures');
const { castLine, applyCastResult, recoverPendingCasts } = require('../src/engine/cast');
const { withUserLock } = require('../src/engine/userLock');
const { BALANCE_VERSION } = require('../src/engine/balance');
const { FishData } = require('../src/schemas/FishSchema');
const { ItemData, Item } = require('../src/schemas/ItemSchema');
const { BuffData } = require('../src/schemas/BuffSchema');
const { QuestData } = require('../src/schemas/QuestSchema');
const { Pond } = require('../src/schemas/PondSchema');
const { Cast } = require('../src/schemas/CastSchema');
const config = require('../src/config');
const { rng } = require('../src/engine/rng');

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
	await addPoolFish([{ name: 'Pool Minnow', rarity: 'Common' }, { name: 'Pool Perch', rarity: 'Common' }, { name: 'Pool Legend', rarity: 'Legendary' }]);
});
test.after(async () => {
	rng.reset();
	await stopDb();
	restore();
});

async function snapshot() {
	const out = {};
	for (const c of await mongoose.connection.db.collections()) {
		out[c.collectionName] = JSON.stringify(await c.find({}).sort({ _id: 1 }).toArray());
	}
	return out;
}

async function player(id, rod = {}) {
	await makeUser(id);
	await useTestRod(id, rod);
	return id;
}

test('castLine decides a cast without writing anything', async () => {
	await player('pure', { capabilities: ['weak', '3'] });
	await giveQuest('pure', { progressMax: 2, xp: 10 });
	await useTestBait('pure');
	const before = await snapshot();
	const result = await castLine({ userId: 'pure', guildId: 'g1', channelId: 'c1' });
	assert.equal(result.status, 'ok');
	assert.deepEqual(await snapshot(), before);
});

test('CastResult records the whole cast', async () => {
	await player('record', { capabilities: ['weak', '2'] });
	const r = await castLine({ userId: 'record', guildId: 'g1', channelId: 'c1' });
	assert.match(r.castId, /^[0-9a-f]{24}$/);
	assert.equal(r.userId, 'record');
	assert.equal(r.guildId, 'g1');
	assert.equal(r.profile, 'normal');
	assert.equal(r.balanceVersion, BALANCE_VERSION);
	assert.equal(r.competitiveEligible, true);
	assert.deepEqual(Object.keys(r.environment).sort(), ['biome', 'season', 'weather']);
	assert.ok(r.rod.id && r.rod.before && r.rod.after);
	assert.ok(r.createdAt instanceof Date);
	for (const c of r.catches) {
		assert.ok(Number.isFinite(c.size) && Number.isFinite(c.weight) && Number.isInteger(c.value));
		assert.equal(typeof c.count, 'number');
	}
	assert.ok(r.pity.before && r.pity.after);
	assert.ok(Array.isArray(r.buffs) && Array.isArray(r.quests));
});

test('XP: one base roll per fish caught (duplicates included), modifiers applied once', async () => {
	await player('xp-rule', { capabilities: ['weak', '5'] });
	await useTestBait('xp-rule', { multiplier: 2 });
	const buff = await Item.findOne({ name: 'Double XP', user: null }).lean();
	const fields = Object.fromEntries(Object.entries(buff).filter(([key]) => !['_id', '__t'].includes(key)));
	await BuffData.create({ ...fields, user: 'xp-rule', active: true, capabilities: ['xp', '1.5'] });

	for (let seed = 1; seed <= 20; seed++) {
		rng.seed(seed);
		const r = await castLine({ userId: 'xp-rule' });
		assert.equal(r.units, 5);
		assert.equal(r.xp.perFish.length, 5, 'one roll per fish, whatever the species split');
		assert.equal(r.xp.base, r.xp.perFish.reduce((a, b) => a + b, 0));
		assert.ok(r.xp.perFish.every((x) => x >= 10 && x < 25));
		assert.equal(r.xp.multiplier, 3);
		assert.equal(r.xp.catch, Math.floor(r.xp.base * 3));
		assert.equal(r.xp.bonus, r.xp.catch - r.xp.base);
	}
});

test('applying a cast awards XP exactly once, whatever the species mix', async () => {
	await player('xp-once', { capabilities: ['weak', '4'] });
	for (let i = 0; i < 5; i++) {
		const before = await userDoc('xp-once');
		const r = await castLine({ userId: 'xp-once' });
		await applyCastResult(r);
		const after = await userDoc('xp-once');
		assert.equal(after.xp - before.xp, r.xp.total);
		assert.equal(after.stats.fishCaught - before.stats.fishCaught, 4);
	}
});

test('multi-catch: counts per draw stack into numeric counts', async () => {
	await player('multi', { capabilities: ['weak', '3', '2 count'] });
	const r = await castLine({ userId: 'multi' });
	assert.equal(r.units, 6);
	assert.equal(r.catches.reduce((s, c) => s + c.count, 0), 6);
	assert.ok(r.catches.every((c) => Number.isInteger(c.count) && c.count % 2 === 0));
	await applyCastResult(r);
	const stored = await FishData.find({ castId: r.castId }).lean();
	assert.equal(stored.reduce((s, f) => s + f.count, 0), 6);
});

test('persistence: catches, rod, bait, quests, pond, stats, pity and level land exactly once', async () => {
	await player('full', { capabilities: ['weak', '3'], durability: 100 });
	const baitId = await useTestBait('full', { count: 5 });
	const quest = await giveQuest('full', { progressMax: 2, xp: 100, cash: 50 });
	await Pond.create({ id: 'pond-full', count: 252 });

	const before = await userDoc('full');
	const r = await castLine({ userId: 'full', guildId: 'g', channelId: 'pond-full' });
	await applyCastResult(r);
	// A second apply must change nothing.
	await applyCastResult(r);
	await recoverPendingCasts({ userId: 'full' });

	const after = await userDoc('full');
	const fishIds = r.catches.map((c) => c.id);
	assert.equal(after.xp - before.xp, r.xp.total);
	assert.equal(r.xp.quest, 100);
	assert.equal(after.inventory.money - before.inventory.money, 50);
	assert.deepEqual(after.inventory.fish.slice(-fishIds.length).map(String), fishIds);
	assert.equal(after.inventory.fish.length, before.inventory.fish.length + fishIds.length);
	assert.equal((await FishData.countDocuments({ castId: r.castId })), fishIds.length);
	assert.equal((await ItemData.findById(r.rod.id).lean()).durability, 97);
	assert.equal((await ItemData.findById(baitId).lean()).count, 2);
	const q = await QuestData.findById(quest._id).lean();
	assert.equal(q.status, 'completed');
	assert.equal(q.progress, 3);
	const pond = await Pond.findOne({ id: 'pond-full' }).lean();
	assert.equal(pond.count, 249);
	assert.equal(pond.warning, true);
	assert.equal(r.pond.warn, true);
	assert.equal(after.pity.castsSinceLegendary, (before.pity?.castsSinceLegendary || 0) + 1);
	assert.equal((await Cast.findById(r.castId).lean()).status, 'applied');
	for (const f of await FishData.find({ castId: r.castId }).lean()) {
		assert.equal(f.profile, 'normal');
		assert.equal(f.balanceVersion, BALANCE_VERSION);
		assert.equal(f.competitiveEligible, true);
		assert.equal(f.user, 'full');
	}
});

const STEPS = ['fish', 'rod', 'bait', 'quests', 'pond', 'commit'];

for (const step of STEPS) {
	test(`atomicity: failure at "${step}" awards nothing and loses nothing; recovery applies it once`, async () => {
		const id = `fail-${step}`;
		await player(id, { capabilities: ['weak', '2'], durability: 100 });
		const baitId = await useTestBait(id, { count: 5 });
		const quest = await giveQuest(id, { progressMax: 50, xp: 0 });
		await Pond.create({ id: `pond-${id}`, count: 1000 });
		const before = await userDoc(id);

		const r = await castLine({ userId: id, channelId: `pond-${id}` });
		const boom = new Error(`injected failure at ${step}`);
		await assert.rejects(applyCastResult(r, { fault: async (s) => { if (s === step) throw boom; } }), boom);

		// The commit did not happen: no XP, no cash, no catch ownership, no stats.
		const mid = await userDoc(id);
		assert.equal(mid.xp, before.xp);
		assert.equal(mid.inventory.money, before.inventory.money);
		assert.equal(mid.inventory.fish.length, before.inventory.fish.length);
		assert.equal(mid.stats.fishCaught, before.stats.fishCaught);
		assert.equal((await Cast.findById(r.castId).lean()).status, 'pending');

		// Roll forward: everything lands exactly once.
		assert.equal(await recoverPendingCasts({ userId: id }), 1);
		await recoverPendingCasts({ userId: id });
		const after = await userDoc(id);
		assert.equal(after.xp - before.xp, r.xp.total);
		assert.equal(after.inventory.fish.length, before.inventory.fish.length + r.catches.length);
		assert.equal(after.stats.fishCaught - before.stats.fishCaught, 2);
		assert.equal((await ItemData.findById(r.rod.id).lean()).durability, 98);
		assert.equal((await ItemData.findById(baitId).lean()).count, 3);
		assert.equal((await QuestData.findById(quest._id).lean()).progress, 2);
		assert.equal((await Pond.findOne({ id: `pond-${id}` }).lean()).count, 998);
		assert.equal(await FishData.countDocuments({ castId: r.castId }), r.catches.length);
		assert.equal((await Cast.findById(r.castId).lean()).status, 'applied');
	});
}

test('atomicity: failure after the commit keeps rewards and catches together; item grants recover once', async () => {
	const id = 'fail-grants';
	await player(id, { capabilities: ['weak', '1'] });
	const box = await Item.findOne({ name: 'Daily Box', user: null }).lean();
	await giveQuest(id, { progressMax: 1, xp: 5, cash: 7, reward: [box._id] });
	const before = await userDoc(id);

	const r = await castLine({ userId: id });
	await assert.rejects(applyCastResult(r, { fault: async (s) => { if (s === 'grants') throw new Error('boom'); } }));

	const mid = await userDoc(id);
	assert.equal(mid.xp - before.xp, r.xp.total, 'XP committed with the catch');
	assert.equal(mid.inventory.fish.length, before.inventory.fish.length + 1, 'catch committed with the XP');
	assert.equal(mid.inventory.gacha.length, before.inventory.gacha.length, 'grant not yet applied');

	await recoverPendingCasts({ userId: id });
	await recoverPendingCasts({ userId: id });
	const after = await userDoc(id);
	assert.equal(after.xp - before.xp, r.xp.total, 'XP not re-awarded by recovery');
	assert.equal(after.inventory.money - before.inventory.money, 7);
	const boxes = await ItemData.find({ _id: { $in: after.inventory.gacha }, name: 'Daily Box' }).lean();
	assert.equal(boxes.reduce((s, b) => s + b.count, 0), 1, 'exactly one reward box');
});

test('item grants stack onto an existing stack exactly once', async () => {
	const id = 'grant-stack';
	await player(id, { capabilities: ['weak', '1'] });
	const box = await Item.findOne({ name: 'Daily Box', user: null }).lean();
	for (let i = 0; i < 2; i++) {
		await giveQuest(id, { title: `q${i}`, progressMax: 1, reward: [box._id] });
		const r = await castLine({ userId: id });
		await applyCastResult(r);
		await applyCastResult(r);
	}
	const user = await userDoc(id);
	const boxes = await ItemData.find({ _id: { $in: user.inventory.gacha }, name: 'Daily Box' }).lean();
	assert.equal(boxes.length, 1);
	assert.equal(boxes[0].count, 2);
});

test('cast ids are unique under concurrency (no max+1 race)', async () => {
	await player('ids', { capabilities: ['weak', '1'] });
	const results = await Promise.all(Array.from({ length: 30 }, () => castLine({ userId: 'ids' })));
	assert.equal(new Set(results.map((r) => r.castId)).size, 30);
});

test('concurrent casts by one player are serialized and all applied', async () => {
	await player('serial', { capabilities: ['weak', '1'] });
	const before = await userDoc('serial');
	const results = await Promise.all(Array.from({ length: 8 }, () => withUserLock('serial', async () => {
		const r = await castLine({ userId: 'serial' });
		await applyCastResult(r);
		return r;
	})));
	const after = await userDoc('serial');
	assert.equal(after.xp - before.xp, results.reduce((s, r) => s + r.xp.total, 0));
	assert.equal(after.inventory.fish.length - before.inventory.fish.length, 8);
	assert.equal(after.stats.fishCaught - before.stats.fishCaught, 8);
	assert.equal((await ItemData.findById(results[0].rod.id).lean()).durability, 1000 - 8);
});

test('buffs are loaded once per cast, not once per fish', async () => {
	await player('buffs', { capabilities: ['weak', '10'] });
	const original = BuffData.find;
	let calls = 0;
	BuffData.find = function(...args) {
		calls++;
		return original.apply(this, args);
	};
	try {
		await castLine({ userId: 'buffs' });
	}
	finally {
		BuffData.find = original;
	}
	assert.equal(calls, 1);
});

test('pity counters increment, and reset atomically on a qualifying catch', async () => {
	await player('pity', { capabilities: ['weak', '1'] });
	let r = await castLine({ userId: 'pity' });
	await applyCastResult(r);
	assert.equal((await userDoc('pity')).pity.castsSinceLegendary, 1);

	await useTestRod('pity', { capabilities: ['weak', '1'], weights: { common: 0, uncommon: 0, rare: 0, ultra: 0, giant: 0, legendary: 1, lucky: 0 } });
	r = await castLine({ userId: 'pity' });
	assert.equal(r.catches[0].rarity, 'Legendary');
	await applyCastResult(r);
	const pity = (await userDoc('pity')).pity;
	assert.equal(pity.castsSinceLegendary, 0);
	assert.equal(pity.castsSinceLucky, 2);
});

test('Founder casts are stamped non-competitive (FOUNDER_IDS, independent of DEVELOPER_IDS)', async () => {
	await player('founder-1', { capabilities: ['weak', '1'] });
	await player('dev-1', { capabilities: ['weak', '1'] });
	const saved = { founders: config.users.founders, developers: config.users.developers };
	config.users.founders = ['founder-1'];
	config.users.developers = ['dev-1'];
	try {
		const f = await castLine({ userId: 'founder-1' });
		await applyCastResult(f);
		assert.equal(f.profile, 'founder');
		assert.equal(f.competitiveEligible, false);
		assert.equal((await FishData.findById(f.catches[0].id).lean()).competitiveEligible, false);

		const d = await castLine({ userId: 'dev-1' });
		assert.equal(d.profile, 'normal');
		assert.equal(d.competitiveEligible, true);
	}
	finally {
		Object.assign(config.users, saved);
	}
});

test('failed casts write nothing: broken rod, empty pond', async () => {
	await player('broken', { state: 'broken', durability: 0 });
	const before = await snapshot();
	const r = await castLine({ userId: 'broken' });
	assert.equal(r.status, 'failed');
	assert.equal(r.failure.code, 'ROD_BROKEN');
	await applyCastResult(r);
	assert.deepEqual(await snapshot(), before);

	await player('pondless', {});
	await Pond.create({ id: 'empty-pond', count: 0 });
	const p = await castLine({ userId: 'pondless', channelId: 'empty-pond' });
	assert.equal(p.failure.code, 'POND_EMPTY');
});

test('rod durability reaching zero breaks the rod (destroyed once repairs are used up)', async () => {
	await player('wear', { capabilities: ['weak', '3'], durability: 2 });
	let r = await castLine({ userId: 'wear' });
	assert.equal(r.rod.after.state, 'broken');
	assert.equal(r.rod.after.durability, 0);

	await player('wear-out', { capabilities: ['weak', '3'], durability: 2, repairs: 3, maxRepairs: 3 });
	r = await castLine({ userId: 'wear-out' });
	assert.equal(r.rod.after.state, 'destroyed');
});

test('depleted bait is unequipped and removed from the inventory in the commit', async () => {
	await player('bait-out', { capabilities: ['weak', '3'] });
	const baitId = await useTestBait('bait-out', { count: 2 });
	const r = await castLine({ userId: 'bait-out' });
	assert.equal(r.bait.depleted, true);
	await applyCastResult(r);
	const user = await userDoc('bait-out');
	assert.equal(user.inventory.equippedBait, null);
	assert.ok(!user.inventory.baits.map(String).includes(String(baitId)));
});

test('a Lucky item catch is granted to the inventory exactly once', async () => {
	// Lucky-only odds in a biome with no Lucky fish: every successful draw is a catalog item.
	await player('lucky-item', { capabilities: ['weak', '1'], weights: { common: 0, uncommon: 0, rare: 0, ultra: 0, giant: 0, legendary: 0, lucky: 1 } });
	rng.seed(11);
	const r = await castLine({ userId: 'lucky-item' });
	assert.equal(r.status, 'ok');
	assert.equal(r.catches[0].kind, 'item');
	assert.equal(r.writes.fishDocs.length, 0);
	assert.equal(r.writes.grants.length, 1);
	assert.equal(r.units, 1);
	assert.equal(r.pity.after.castsSinceLucky, 0);

	const before = await userDoc('lucky-item');
	await applyCastResult(r);
	await applyCastResult(r);
	const after = await userDoc('lucky-item');
	assert.equal(after.xp - before.xp, r.xp.total);
	const granted = await ItemData.find({ user: 'lucky-item', name: r.catches[0].name }).lean();
	assert.equal(granted.reduce((s, i) => s + (i.count || 0), 0), 1);
});
