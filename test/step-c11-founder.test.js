// Step C.11 (dark behind the 5B flag): the Founder stealth-hybrid. The public cast is exactly a normal
// player's (same seed, same state -> same public result); the account also receives private reward rolls with
// today's Founder table and pity, XP x35 / sell x25, quests x5, a 40% repair rebate, Founder box luck on
// non-buff slots only. Private rolls never reach the public card, its Sell button, quests, the streak or bait.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { userDoc } = require('./helpers/castFixtures');
const { with5b } = require('./helpers/withFlag');
const config = require('../src/config');
const { castLine, applyCastResult } = require('../src/engine/cast');
const { openLine } = require('../src/engine/gacha');
const rodOps = require('../src/engine/b5/rodOps');
const q5 = require('../src/engine/b5/quests');
const levels = require('../src/engine/levels');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { Item, ItemData } = require('../src/schemas/ItemSchema');
const { FishData } = require('../src/schemas/FishSchema');
const { QuestData } = require('../src/schemas/QuestSchema');
const { rng } = require('../src/engine/rng');

const FOUNDER = 'c11-founder';
let saved;

test.before(async () => {
	quiet();
	saved = config.users.founders;
	config.users.founders = [FOUNDER];
	await startDb();
	await seedGame();
});
test.after(async () => {
	config.users.founders = saved;
	rng.reset();
	await stopDb();
	restore();
});

/** Two players in the same state (level, money, permits, no rod changes). */
async function twin(id, level = 12) {
	await makeUser(id);
	const xp = levels.CURVES['5b'].xpForLevel(level);
	await UserModel.updateOne({ userId: id }, { $set: { xp, publicXp: xp, level, levelFloor: level, publicLevelFloor: level, permits: [], 'inventory.money': 1e6 } });
}

const publicPart = (r) => ({
	status: r.status, catches: r.catches.map((c) => [c.name, c.rarity, c.count, c.size, c.weight, c.rawValue, c.reward.base]), units: r.units,
	cooldownMs: r.cooldownMs, durabilityCost: r.rod.durabilityCost, xpBase: r.rewards.xp.base, public: r.level.public, draws: r.draws, rarity: r.rarity.table,
});

test('the public cast is exactly a normal player\'s: same seed, same state, same public result', async () => {
	await twin('c11-normal');
	await twin(FOUNDER);
	await with5b(async () => {
		for (let seed = 1; seed <= 25; seed++) {
			rng.seed(seed);
			const n = await castLine({ userId: 'c11-normal', now: new Date('2026-10-01T12:00:00Z') });
			rng.seed(seed);
			const f = await castLine({ userId: FOUNDER, now: new Date('2026-10-01T12:00:00Z') });
			assert.deepEqual(publicPart(f), publicPart(n), `seed ${seed}`);
			assert.equal(n.private, undefined);
			assert.equal(f.private.rolls, 7);
			assert.equal(f.competitiveEligible, false);
		}
		rng.reset();
	});
});

test('private rolls: stored privately (never competitive, never on the Sell button), x25 value, x35 XP, public XP unchanged', async () => {
	await with5b(async () => {
		rng.seed(42);
		const r = await castLine({ userId: FOUNDER });
		rng.reset();
		const pub = r.catches.filter((c) => c.kind === 'fish');
		for (const c of pub) assert.equal(c.value, Math.round(c.rawValue * r.modifiers.sell.multiplier * 25));
		assert.equal(r.xp.total, r.xp.catch + r.xp.quest + r.private.xp.final);
		const before = await userDoc(FOUNDER);
		await applyCastResult(r);
		const after = await userDoc(FOUNDER);
		assert.equal(after.publicXp - before.publicXp, r.rewards.xp.base, 'public XP gets only the public catch');
		assert.equal(after.xp - before.xp, r.xp.total);
		const priv = await FishData.find({ castId: r.castId, private: true }).lean();
		assert.equal(priv.length, r.private.catches.filter((c) => c.kind === 'fish').length);
		assert.ok(priv.every((d) => d.competitiveEligible === false && Math.abs(d.value - d.valueBase * 25) <= 13), 'never competitive; value = base x 25 (rounding)');
		assert.deepEqual(after.stats.latestFish.map(String).sort(), pub.map((c) => c.id).sort(), 'the Sell button sells the public catch only');
		assert.equal(after.stats.fishCaught - (before.stats.fishCaught || 0), r.units, 'public stats count the public catch only');
	});
});

test('private pity: at the hard threshold a private roll is Legendary+, and only private hits reset it', async () => {
	await UserModel.updateOne({ userId: FOUNDER }, { $set: { 'pity.castsSinceLegendary': 25, 'pity.castsSinceLucky': 0 } });
	await with5b(async () => {
		const r = await castLine({ userId: FOUNDER });
		assert.ok(r.private.catches.some((c) => ['Legendary', 'Lucky'].includes(c.rarity)));
		assert.equal(r.pity.after.castsSinceLegendary, 0);
	});
});

test('quests: the Founder\'s completion shows the base publicly and receives x5 / x5', async () => {
	await with5b(async () => {
		const s = await q5.startQuest(FOUNDER, 'repeatable.village');
		assert.equal(s.ok, true);
		await QuestData.collection.updateOne({ _id: s.quest._id }, { $set: { progress: s.quest.progressMax - 1 } });
		const r = await castLine({ userId: FOUNDER });
		const q = r.quests.find((x) => x.key === 'repeatable.village');
		assert.equal(q.completed, true);
		assert.equal(q.reward.xp.base, s.quest.xp);
		assert.equal(q.reward.xp.final, s.quest.xp * 5);
		assert.equal(q.reward.cash.final, s.quest.cash * 5);
		assert.equal(q.after - q.before, r.units, 'progress counts the public catch only');
	});
});

test('box luck on non-buff slots only: whether a slot is a buff is a normal player\'s roll', async () => {
	const t = await Item.collection.findOne({ name: 'Daily Box', user: null });
	for (const id of ['c11-normal', FOUNDER]) {
		const _id = new mongoose.Types.ObjectId();
		await ItemData.collection.insertOne({ ...t, _id, __t: 'GachaData', user: id, count: 100 });
		await UserModel.updateOne({ userId: id }, { $push: { 'inventory.gacha': _id } });
	}
	await with5b(async () => {
		let founderLuck = 0;
		for (let seed = 1; seed <= 60; seed++) {
			rng.seed(seed);
			const n = await openLine({ userId: 'c11-normal', boxName: 'Daily Box' });
			rng.seed(seed);
			const f = await openLine({ userId: FOUNDER, boxName: 'Daily Box' });
			assert.equal(f.slots[0].reward.type === 'buff', n.slots[0].reward.type === 'buff', `seed ${seed}`);
			if (f.slots[0].reward.type !== 'buff' && f.slots[0].rarity !== n.slots[0].rarity) founderLuck++;
		}
		rng.reset();
		assert.ok(founderLuck > 0, 'non-buff slots are re-rolled with the Founder luck');
	});
});

test('repairs: the public cost is normal; 40% comes back privately', async () => {
	await with5b(async () => {
		const bought = await rodOps.buyStandardRod(FOUNDER, 'Trusty Rod', { equip: true });
		assert.equal(bought.ok, true);
		await ItemData.collection.updateOne({ _id: new mongoose.Types.ObjectId(bought.rodId) }, { $set: { state: 'broken', durability: 0 } });
		const before = (await userDoc(FOUNDER)).inventory.money;
		const r = await rodOps.repairRod(FOUNDER, bought.rodId);
		assert.equal(r.cost, 2100);
		assert.equal(r.rebate, 840);
		assert.equal((await userDoc(FOUNDER)).inventory.money, before - 2100 + 840);
	});
});
