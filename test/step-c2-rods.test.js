// Step C.2 (dark behind the 5B flag): standard rods, the Rod Workshop, the L6B gate, the unbreakable Old
// Rod, repairs, legacy crafted rods, tier crates, owned Fishing Crates and salvage.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { userDoc } = require('./helpers/castFixtures');
const { with5b } = require('./helpers/withFlag');
const { castLine, applyCastResult } = require('../src/engine/cast');
const { openLine, applyGachaResult, buildPools, validateBoxes } = require('../src/engine/gacha');
const rods5b = require('../src/engine/b5/rods');
const rodOps = require('../src/engine/b5/rodOps');
const mc = require('../src/engine/b5/multicatch');
const { migrateLegacyFishingCrates } = require('../src/engine/b5/migrations');
const { runOnce } = require('../src/bootstrap/migrations');
const levels = require('../src/engine/levels');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { Item, ItemData } = require('../src/schemas/ItemSchema');
const { rng } = require('../src/engine/rng');
const model = require('../scripts/economy/5b/rods');
const F = require('../scripts/economy/5b/framework');

const oid = (id) => new mongoose.Types.ObjectId(String(id));

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

/** Sets a player's level on the 5B curve (xp at the level's start, floors at the level). */
async function atLevel(userId, level, money = 0) {
	const xp = levels.CURVES['5b'].xpForLevel(level);
	await UserModel.updateOne({ userId }, { $set: { xp, publicXp: xp, level, levelFloor: level, publicLevelFloor: level, 'inventory.money': money } });
}

/** Gives the player one unit of each named catalog part; returns their ids in rod/reel/hook/handle order. */
async function giveParts(userId, names) {
	const ids = [];
	for (const name of names) {
		const t = await Item.collection.findOne({ name, user: null });
		const _id = new mongoose.Types.ObjectId();
		await ItemData.collection.insertOne({ ...t, _id, __t: 'ItemData', user: userId, count: 1 });
		await UserModel.updateOne({ userId }, { $push: { 'inventory.items': _id } });
		ids.push(String(_id));
	}
	return ids;
}

test('engine = model: every catalog part combination crafts the same rod', async () => {
	await with5b(async () => {
		for (const combo of model.evaluateAllCombos()) {
			const parts = combo.names.map((n) => model.CATALOG.find((p) => p.name === n));
			const m = model.craftRod(parts);
			const e = rods5b.craftedRod(parts);
			const at = combo.names.join(' + ');
			assert.equal(e.requiredLevel, m.level, at);
			assert.equal(e.tier, m.tier, at);
			assert.ok(Math.abs(e.meanFish - m.meanFish) < 1e-12, at);
			assert.ok(Math.abs(e.multiChance - m.multiChance) < 1e-9, at);
			for (const k of ['rareFind', 'luck', 'trophyChance', 'fishingSpeed', 'sellBonus']) assert.ok(Math.abs(e.stats[k] - m.stats[k]) < 1e-9, `${at} ${k}`);
			assert.equal(e.maxDurability, m.maxDurability, at);
			assert.equal(e.repairCost, m.repairCost, at);
			assert.deepEqual(e.qualities, ['weak', 'strong']);
		}
		for (const s of model.standardRods()) {
			const e = rods5b.standardProfile(s.name);
			assert.equal(e.price, s.price);
			assert.equal(e.requiredLevel, s.level);
			assert.equal(e.maxDurability, s.maxDurability);
			assert.equal(e.repairCost, s.repairCost);
			assert.ok(Math.abs(e.multiChance - s.multiChance) < 1e-9);
			assert.ok(e.meanFish <= 1.8);
		}
		for (const mean of [1.05, 1.2, 1.5, 1.8]) assert.ok(Math.abs(mc.chanceForMean(mean) - F.chanceForMean(mean)) < 1e-12);
	});
});

test('L6B rule: the requirement is the highest part level (four Commons Lv 10; a Rare handle makes it Lv 30)', async () => {
	await with5b(async () => {
		const part = (name) => model.CATALOG.find((p) => p.name === name);
		const commons = ['Wooden Rod Piece', 'Plastic Reel', 'Barbed Hook', 'Wooden Handle'].map(part);
		if (commons.every(Boolean)) assert.equal(rods5b.rodGate(commons).requiredLevel, 10);
		const byRarity = (type, rarity) => model.CATALOG.find((p) => p.type === type && p.rarity === rarity);
		const mixed = [byRarity('part_rod', 'Common'), byRarity('part_reel', 'Common'), byRarity('part_hook', 'Common'), byRarity('part_handle', 'Rare')];
		const g = rods5b.rodGate(mixed, 10);
		assert.equal(g.requiredLevel, 30);
		assert.equal(g.allowed, false);
		assert.deepEqual(g.setBy.map((p) => p.slot), ['handle']);
	});
});

test('multi-catch chain: sampled mean matches the chance; the ceiling caps the mean at 1.80', async () => {
	await with5b(async () => {
		const c = mc.chanceForMean(1.62);
		rng.seed(3);
		let sum = 0;
		const n = 20000;
		for (let i = 0; i < n; i++) sum += mc.rollFishCount(c, rng);
		rng.reset();
		assert.ok(Math.abs(sum / n - 1.62) < 0.02, `mean ${sum / n}`);
		const capped = mc.cappedChance(0.95);
		assert.equal(capped.capped, true);
		assert.ok(Math.abs(mc.meanOf(mc.fishDistribution(capped.chance, { jackpotChain: 0.35, maxFish: 5 })) - 1.8) < 1e-9);
	});
});

test('durability charge: n × (1 − e) in expectation, no minimum', async () => {
	rng.seed(9);
	let sum = 0;
	for (let i = 0; i < 20000; i++) sum += rods5b.durabilityCharge(2, 0.3, rng);
	rng.reset();
	assert.ok(Math.abs(sum / 20000 - 1.4) < 0.02);
	assert.equal(rods5b.durabilityCharge(3, 0, rng), 3);
	assert.equal(rods5b.durabilityCharge(1, 1, rng), 0);
});

test('the Old Rod is unbreakable under 5B: casting never lowers its durability, even when stored as destroyed', async () => {
	await makeUser('c2-old');
	const u = await userDoc('c2-old');
	await ItemData.collection.updateOne({ _id: u.inventory.equippedRod }, { $set: { durability: 1, state: 'destroyed' } });
	await with5b(async () => {
		for (let i = 0; i < 3; i++) {
			const r = await castLine({ userId: 'c2-old' });
			assert.equal(r.status, 'ok');
			assert.equal(r.rod.durabilityCost, 0);
			assert.equal(r.rod.unbreakable, true);
			await applyCastResult(r);
		}
	});
	const rod = await ItemData.collection.findOne({ _id: u.inventory.equippedRod });
	assert.equal(rod.durability, 1);
});

test('standard rods: level gate, one guarded charge under two concurrent clicks, one copy per rod', async () => {
	await makeUser('c2-buy');
	await with5b(async () => {
		await atLevel('c2-buy', 9, 100000);
		assert.equal((await rodOps.buyStandardRod('c2-buy', 'Trusty Rod')).code, 'LEVEL_LOCKED');
		await atLevel('c2-buy', 10, 5100 + 50);
		const [a, b] = await Promise.all([rodOps.buyStandardRod('c2-buy', 'Trusty Rod', { equip: true }), rodOps.buyStandardRod('c2-buy', 'Trusty Rod')]);
		assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
		assert.equal([a, b].find((x) => !x.ok).code, 'OWNED');
		const u = await userDoc('c2-buy');
		assert.equal(u.inventory.money, 50);
		const rod = await ItemData.collection.findOne({ _id: u.inventory.equippedRod });
		assert.equal(rod.name, 'Trusty Rod');
		assert.equal(rod.durability, 1200);
		assert.equal(rod.release, '5b');
		assert.equal((await rodOps.buyStandardRod('c2-buy', 'Angler\'s Rod')).code, 'LEVEL_LOCKED');
		await atLevel('c2-buy', 20, 10);
		assert.equal((await rodOps.buyStandardRod('c2-buy', 'Angler\'s Rod')).code, 'INSUFFICIENT');
		assert.equal((await userDoc('c2-buy')).inventory.money, 10);
	});
});

test('Rod Workshop: craft refused below the requirement (parts kept); the craft gets the 5B stats', async () => {
	await makeUser('c2-craft');
	await with5b(async () => {
		const byRarity = (type, rarity) => model.CATALOG.find((p) => p.type === type && p.rarity === rarity).name;
		const ids = await giveParts('c2-craft', [byRarity('part_rod', 'Common'), byRarity('part_reel', 'Common'), byRarity('part_hook', 'Common'), byRarity('part_handle', 'Rare')]);
		await atLevel('c2-craft', 9);
		assert.equal((await rodOps.craftRod('c2-craft', { name: 'x', partIds: ids })).code, 'WORKSHOP_LOCKED');
		await atLevel('c2-craft', 12);
		const refused = await rodOps.craftRod('c2-craft', { name: 'x', partIds: ids });
		assert.equal(refused.code, 'LEVEL_LOCKED');
		assert.match(refused.message, /Needs Lv 30 because of the Rare .*You are Lv 12/);
		assert.equal((await ItemData.collection.find({ _id: { $in: ids.map(oid) } }).toArray()).every((p) => p.count === 1), true, 'parts kept');
		await atLevel('c2-craft', 30);
		const ok = await rodOps.craftRod('c2-craft', { name: 'My Rod', partIds: ids });
		assert.equal(ok.ok, true);
		const rod = await ItemData.collection.findOne({ _id: oid(ok.rodId) });
		assert.deepEqual(rod.capabilities, ['weak', 'strong']);
		assert.equal(rod.requirements.level, 30);
		assert.equal(rod.maxRepairs, null);
		assert.equal((await ItemData.collection.find({ _id: { $in: ids.map(oid) } }).toArray()).every((p) => p.count === 0), true, 'one unit of each part used');
	});
});

test('L6B equip gate: refused below the level with the lock reason; the equipped rod is grandfathered', async () => {
	await makeUser('c2-equip');
	await with5b(async () => {
		const byRarity = (type, rarity) => model.CATALOG.find((p) => p.type === type && p.rarity === rarity).name;
		const ids = await giveParts('c2-equip', ['part_rod', 'part_reel', 'part_hook', 'part_handle'].map((t) => byRarity(t, 'Legendary')));
		await atLevel('c2-equip', 50);
		const crafted = await rodOps.craftRod('c2-equip', { name: 'Legend', partIds: ids });
		assert.equal(crafted.ok, true);
		assert.equal((await rodOps.equipRod('c2-equip', crafted.rodId)).ok, true);
		// A lower-level account (e.g. data from before the gate): the equipped rod stays and casts.
		await atLevel('c2-equip', 35);
		const r = await castLine({ userId: 'c2-equip' });
		assert.equal(r.status, 'ok');
		assert.equal(r.rod.kind, 'custom');
		// Voluntarily unequipped: the gate applies again.
		const old = (await rodOps.ownedRods(await userDoc('c2-equip'))).find((x) => x.name === 'Old Rod');
		assert.equal((await rodOps.equipRod('c2-equip', old._id)).ok, true);
		const again = await rodOps.equipRod('c2-equip', crafted.rodId);
		assert.equal(again.code, 'LEVEL_LOCKED');
		assert.match(again.message, /requires Lv 50 .*You are Lv 35/);
	});
});

test('legacy crafted rods: a destroyed one counts as broken and is repaired (unlimited) at the rule cost; durability grandfathered', async () => {
	await makeUser('c2-legacy');
	await with5b(async () => {
		const byRarity = (type, rarity) => model.CATALOG.find((p) => p.type === type && p.rarity === rarity).name;
		const ids = await giveParts('c2-legacy', ['part_rod', 'part_reel', 'part_hook', 'part_handle'].map((t) => byRarity(t, 'Rare')));
		// Today's crafted rod: legacy capabilities, 10,000 durability, destroyed after 3 repairs.
		const _id = new mongoose.Types.ObjectId();
		await ItemData.collection.insertOne({ _id, __t: 'CustomRodData', user: 'c2-legacy', name: 'Old Craft', type: 'customrod', rod: oid(ids[0]), reel: oid(ids[1]), hook: oid(ids[2]), handle: oid(ids[3]), capabilities: ['weak', 'strong', '6', '5 count', '10000 durability'], durability: 0, maxDurability: 10000, repairs: 3, maxRepairs: 3, repairCost: 50000, state: 'destroyed', requirements: { level: 50 } });
		await UserModel.updateOne({ userId: 'c2-legacy' }, { $push: { 'inventory.rods': _id }, $set: { 'inventory.equippedRod': _id } });
		await atLevel('c2-legacy', 35, 100000);
		const r = await castLine({ userId: 'c2-legacy' });
		assert.equal(r.status, 'failed');
		assert.equal(r.failure.code, 'ROD_BROKEN');
		const profile = await rods5b.resolveRod(await ItemData.collection.findOne({ _id }));
		assert.equal(profile.method, 'parts');
		assert.equal(profile.maxDurability, 10000, 'grandfathered: max(stored, rule)');
		const rep = await rodOps.repairRod('c2-legacy', _id);
		assert.equal(rep.ok, true);
		assert.equal(rep.cost, model.repairCostFor('Rare'));
		const rod = await ItemData.collection.findOne({ _id });
		assert.equal(rod.state, 'repaired');
		assert.equal(rod.durability, 10000);
		assert.equal((await userDoc('c2-legacy')).inventory.money, 100000 - rep.cost);
		assert.equal((await rodOps.repairRod('c2-legacy', _id)).code, 'NOT_BROKEN');
		// Path B: a missing part -> the weakest combination with the same fingerprint (the model's converter).
		const catalogParts = await Item.collection.find({ user: null, type: { $in: Object.keys(rods5b.SLOT_OF_TYPE) } }).toArray();
		const stored = { name: 'x', capabilities: ['weak', 'quick', 'strong', '6', '5 count', '10000 durability'], maxDurability: 10000 };
		const e = rods5b.convertCraftedRod(stored, [null, null, null, null], catalogParts);
		const m = model.convertLegacyRod(stored, null);
		assert.equal(e.method, m.method);
		assert.equal(e.requiredLevel, m.rod.level);
		assert.equal(e.meanFish, m.rod.meanFish);
		assert.equal(rods5b.convertCraftedRod({ capabilities: ['nonsense'] }, [], catalogParts).method, 'default');
	});
});

test('a 5B crafted rod at 0 durability is broken, never destroyed; the cast uses the chain and the rod profile', async () => {
	await makeUser('c2-break');
	await with5b(async () => {
		await atLevel('c2-break', 10, 5100);
		const bought = await rodOps.buyStandardRod('c2-break', 'Trusty Rod', { equip: true });
		await ItemData.collection.updateOne({ _id: oid(bought.rodId) }, { $set: { durability: 1 } });
		let r;
		for (let seed = 1; seed < 50; seed++) {
			rng.seed(seed);
			r = await castLine({ userId: 'c2-break' });
			if (r.rod.durabilityCost >= 1) break;
		}
		rng.reset();
		assert.equal(r.rod.after.state, 'broken');
		assert.equal(r.rod.kind, 'standard');
		assert.ok(r.draws.draws >= 1 && r.draws.perDraw === 1);
		assert.deepEqual(r.draws.qualities.sort(), ['strong', 'weak']);
	});
});

test('salvage: one spare unit for its rarity value', async () => {
	await makeUser('c2-salvage');
	await with5b(async () => {
		const name = model.CATALOG.find((p) => p.rarity === 'Ultra').name;
		const [id] = await giveParts('c2-salvage', [name]);
		const res = await rodOps.salvagePart('c2-salvage', id);
		assert.equal(res.value, model.salvageValue('Ultra'));
		assert.equal((await rodOps.salvagePart('c2-salvage', id)).code, 'NONE_LEFT');
		assert.equal((await userDoc('c2-salvage')).inventory.money, model.salvageValue('Ultra'));
	});
});

test('owned Fishing Crates (option b): legacy units open first under today\'s definition; the migration runs once', async () => {
	await makeUser('c2-crate');
	const crate = await Item.collection.findOne({ name: 'Fishing Crate', user: null });
	const _id = new mongoose.Types.ObjectId();
	await ItemData.collection.insertOne({ ...crate, _id, __t: 'GachaData', user: 'c2-crate', count: 2 });
	await UserModel.updateOne({ userId: 'c2-crate' }, { $push: { 'inventory.gacha': _id } });
	await with5b(async () => {
		const first = await runOnce('5b-legacy-fishing-crates-test', migrateLegacyFishingCrates);
		assert.ok(first.result.marked >= 1);
		assert.equal((await runOnce('5b-legacy-fishing-crates-test', migrateLegacyFishingCrates)).skipped, true);
		assert.equal((await migrateLegacyFishingCrates()).marked, 0, 'guarded: a second pass writes nothing');
		assert.equal((await ItemData.collection.findOne({ _id })).legacyCount, 2);
		// One more unit acquired after the flip.
		await ItemData.collection.updateOne({ _id }, { $inc: { count: 1 } });
		const kinds = [];
		for (let i = 0; i < 3; i++) {
			const r = await openLine({ userId: 'c2-crate', boxName: 'Fishing Crate' });
			assert.equal(r.status, 'ok');
			kinds.push(r.box.legacyUnit ? 'legacy' : r.box.definitionId);
			await applyGachaResult(r);
		}
		assert.deepEqual(kinds, ['legacy', 'legacy', 'fishing-crate']);
		const after = await ItemData.collection.findOne({ _id });
		assert.equal(after.count, 0);
		assert.equal(after.legacyCount, 0);
	});
});

test('tier crates validate under 5B; with the flag off no hidden 5B row is a box reward or a listed item', async () => {
	await with5b(async () => {
		const names = (await Item.collection.find({ type: 'gacha', user: null }).toArray()).map((b) => b.name);
		const { problems } = await validateBoxes(names);
		assert.deepEqual(problems, []);
	});
	const { BOXES } = require('../src/engine/gachaBoxes');
	for (const [name, def] of Object.entries(BOXES)) {
		const pools = await buildPools({ name, ...def });
		for (const list of Object.values(pools)) assert.ok(list.every((e) => e.template.release === undefined), `${name} pool has a hidden row`);
	}
	assert.equal(await Item.countDocuments({ shopItem: true, release: '5b' }), 0);
});
