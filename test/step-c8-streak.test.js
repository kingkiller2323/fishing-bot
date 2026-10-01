// Step C.8 (dark behind the 5B flag): the daily streak (the model's rule traces), credit on the qualifying
// cast in the atomic commit, streak boxes (highest accessible biome, fish share, bait packs, no Lucky Draw),
// the Voter's Crate without the Old Rod, and /vote retired.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { userDoc } = require('./helpers/castFixtures');
const { with5b } = require('./helpers/withFlag');
const { castLine, recoverPendingCasts } = require('../src/engine/cast');
const { openLine, buildPools } = require('../src/engine/gacha');
const { crateDefinition5b } = require('../src/engine/b5/crates');
const st = require('../src/engine/b5/streak');
const day = require('../src/engine/b5/day');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { Item, ItemData } = require('../src/schemas/ItemSchema');
const { Cast } = require('../src/schemas/CastSchema');
const { rng } = require('../src/engine/rng');
const model = require('../scripts/economy/5b/streak');

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

test('the rules mirror the model on every rule trace and on random walks', async () => {
	await with5b(async () => {
		let a = st.defaultState();
		let b = model.defaultState();
		assert.deepEqual(a, b);
		rng.seed(4);
		let d = 100;
		for (let i = 0; i < 2000; i++) {
			d += rng.random() < 0.8 ? 1 : 1 + Math.floor(rng.random() * 9);
			const casts = 1 + Math.floor(rng.random() * 25);
			for (let c = 0; c < casts; c++) {
				const x = st.onSuccessfulCast(a, d);
				const y = model.onSuccessfulCast(b, d);
				assert.deepEqual(x, y);
				a = x.state;
				b = y.state;
			}
		}
		rng.reset();
	});
});

test('the 20th successful cast of the day credits the streak and grants its box in the commit, once', async () => {
	await makeUser('c8-gate');
	const now = new Date('2026-10-01T12:00:00Z');
	const today = await with5b(() => day.dayIndex(now.getTime()));
	await UserModel.updateOne({ userId: 'c8-gate' }, { $set: { permits: [], streak: { count: 6, best: 6, total: 6, lastDay: today - 1, grace: 1, castsDay: today, castsToday: 19 } } });
	await with5b(async () => {
		const r = await castLine({ userId: 'c8-gate', now });
		assert.equal(r.streak.credit.box, 'Streak Chest', 'the 7th streak day');
		assert.equal(r.streak.after.count, 7);
		assert.equal(r.streak.after.grace, 2);
		assert.ok(r.writes.grants.some((g) => g.key === `${r.castId}:streak`));
		// Interrupted before the commit, recovered twice: one chest.
		await Cast.create({ _id: r.castId, userId: r.userId, result: r, status: 'pending' });
		await recoverPendingCasts({ userId: 'c8-gate' });
		await recoverPendingCasts({ userId: 'c8-gate' });
		const u = await userDoc('c8-gate');
		assert.equal(u.streak.count, 7);
		const chests = await ItemData.collection.find({ user: 'c8-gate', name: 'Streak Chest' }).toArray();
		assert.equal(chests.reduce((s, c) => s + c.count, 0), 1);
		// The 21st cast credits nothing.
		const r2 = await castLine({ userId: 'c8-gate', now });
		assert.equal(r2.streak.credit, null);
		assert.equal(r2.streak.after.castsToday, 21);
	});
});

test('streak boxes: fish from the highest accessible biome, no Lucky Draw, no rare+ parts, bait as a pack', async () => {
	await with5b(async () => {
		const def = crateDefinition5b('Streak Crate');
		const pools = await buildPools(def, { accessibleBiomes: ['Ocean', 'River'] });
		const fish = Object.values(pools).flat().filter((e) => e.kind === 'fish');
		assert.ok(fish.length > 0);
		for (const r of Object.keys(pools)) {
			const biomes = new Set(pools[r].filter((e) => e.kind === 'fish').map((e) => e.template.biome));
			assert.ok(biomes.size <= 1, `${r}: one biome`);
		}
		assert.ok(fish.every((e) => ['Ocean', 'River'].includes(e.template.biome)));
		const items = Object.values(pools).flat().filter((e) => e.kind === 'item');
		assert.ok(!items.some((e) => e.template.name === 'Lucky Draw' || e.template.name === 'Booster Pack' || e.template.name === 'Old Rod'));
		assert.ok(!items.some((e) => e.template.type.startsWith('part_') && !['common', 'uncommon'].includes(String(e.template.rarity).toLowerCase())));
		assert.equal(def.baitGrant, 'pack');
		// The Voter's Crate keeps its definition, minus the Old Rod.
		const voters = crateDefinition5b('Voter\'s Crate');
		assert.ok(voters.pool.exclude.includes('Old Rod'));
		const vp = await buildPools(voters);
		assert.ok(!Object.values(vp).flat().some((e) => e.template.name === 'Old Rod'));
	});
});

test('opening a Streak Crate: a bait slot grants a pack of 10', async () => {
	await makeUser('c8-open');
	const t = await Item.collection.findOne({ name: 'Streak Crate', user: null });
	const _id = new mongoose.Types.ObjectId();
	await ItemData.collection.insertOne({ ...t, _id, __t: 'GachaData', user: 'c8-open', count: 50 });
	await UserModel.updateOne({ userId: 'c8-open' }, { $push: { 'inventory.gacha': _id }, $set: { permits: [] } });
	await with5b(async () => {
		let sawBait = false;
		for (let seed = 1; seed <= 40 && !sawBait; seed++) {
			rng.seed(seed);
			const r = await openLine({ userId: 'c8-open', boxName: 'Streak Crate' });
			assert.equal(r.status, 'ok');
			const baitGrant = r.writes.grants.find((g) => r.slots.some((s) => s.reward.id === g.newId && s.reward.type === 'bait'));
			if (baitGrant) {
				sawBait = true;
				assert.equal(baitGrant.count, 10);
			}
			assert.ok(r.slots.every((s) => s.rarity !== 'common'), 'Uncommon or better');
		}
		rng.reset();
		assert.ok(sawBait, 'a bait slot within 40 seeded opens');
	});
});

test('/vote is retired under the flag: a private notice, no Top.gg call', async () => {
	const vote = require('../src/commands/slash/Economy/vote');
	let reply = null;
	const interaction = {
		user: { id: 'c8-vote' },
		reply: async (p) => {
			reply = p;
		},
		deferReply: async () => {
			throw new Error('no defer');
		},
	};
	await with5b(() => vote.run({}, interaction));
	assert.match(reply.content, /Voting rewards have ended/);
	assert.ok(reply.flags);
});
