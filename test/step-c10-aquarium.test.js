// Step C.10 (dark behind the 5B flag): the aquarium: companion bonus (model parity), licence slots level-capped,
// care cooldowns and capped bond, sale formula and weekly limit, finite tanks with legacy tanks kept, the
// shop's Aquarium tab, breeding as a probability.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { userDoc } = require('./helpers/castFixtures');
const { with5b } = require('./helpers/withFlag');
const { castLine } = require('../src/engine/cast');
const aq = require('../src/engine/b5/aquarium');
const levels = require('../src/engine/levels');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { Item, ItemData } = require('../src/schemas/ItemSchema');
const { PetFish } = require('../src/schemas/PetSchema');
const { Habitat } = require('../src/schemas/HabitatSchema');
const { Fish, FishData } = require('../src/schemas/FishSchema');
const model = require('../scripts/economy/5b/aquarium');

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
});
test.after(async () => {
	await stopDb();
	restore();
});

async function atLevel(userId, level, money = 0) {
	const xp = levels.CURVES['5b'].xpForLevel(level);
	await UserModel.updateOne({ userId }, { $set: { xp, publicXp: xp, level, levelFloor: level, publicLevelFloor: level, 'inventory.money': money, permits: [] } });
}

async function giveLicense(userId, name) {
	const t = await Item.collection.findOne({ name, user: null });
	const _id = new mongoose.Types.ObjectId();
	await ItemData.collection.insertOne({ ...t, _id, __t: 'LicenseData', user: userId, count: 1 });
	await UserModel.updateOne({ userId }, { $push: { 'inventory.items': _id } });
}

async function petIn(userId, tankId, { name, species = 'Woodskip', biome = 'River', xp = 700, lastFed = Date.now(), age = 30, attraction = 0, bred } = {}) {
	const t = await Fish.findOne({ name: species, biome, user: null }).lean();
	const fd = new mongoose.Types.ObjectId();
	await FishData.collection.insertOne({ ...t, _id: fd, user: userId });
	const p = await PetFish.create({ name, fish: fd, owner: userId, species, age, xp, lastFed, lastPlayed: lastFed, aquarium: tankId, attraction, health: 100, hunger: 0, mood: 100, stress: 0, ...(bred ? { bred } : {}) });
	await Habitat.updateOne({ _id: tankId }, { $push: { fish: p._id } });
	return p;
}

test('rules equal the model: companion bonus, slots (level-capped), bond, sale value, breeding rate', async () => {
	await with5b(async () => {
		for (const level of [10, 15, 29, 30, 44, 45, 60]) {
			for (const held of ['basic', 'advanced', 'expert']) {
				assert.equal(aq.companionSlots({ Freshwater: held }, level), model.companionSlots({ Freshwater: held }, level), `${held} at ${level}`);
			}
		}
		const pets = [{ rarity: 'Legendary', xp: 700, thriving: true }, { rarity: 'Common', xp: 0, thriving: true }, { rarity: 'Lucky', xp: 350, thriving: false }];
		const e = aq.companionBonus(pets, 2);
		const m = model.companionBonus(pets.map((p) => ({ rarity: p.rarity, bondXp: p.xp, thriving: p.thriving })), { slots: 2 });
		assert.ok(Math.abs(e.bonus - m.bonus) < 1e-12);
		for (const days of [1, 14, 28, 40]) {
			for (const bred of [false, true]) {
				const args = { speciesValue: 1000, ageDays: days, bred, attraction: 25, isThriving: true };
				assert.equal(aq.petSaleValue(args), Math.round(model.petSaleValue({ ...args, thriving: true })));
			}
		}
		assert.equal(aq.breedingRate(0, 100), model.breedingRate(0, 100).fixed);
	});
});

test('the companion bonus reaches the cast as a cash-only sell bonus', async () => {
	await makeUser('c10-bonus');
	await with5b(async () => {
		await atLevel('c10-bonus', 15);
		await giveLicense('c10-bonus', 'Basic Freshwater Aquarium License');
		const tank = await Habitat.create({ name: 't', owner: 'c10-bonus', waterType: 'Freshwater', size: 3, cleanliness: 100, temperature: 25 });
		await petIn('c10-bonus', tank._id, { name: 'A', species: 'Woodskip' });
		await petIn('c10-bonus', tank._id, { name: 'B', species: 'Woodskip' });
		const r = await castLine({ userId: 'c10-bonus' });
		const src = r.modifiers.sources.find((s) => s.source === 'aquarium');
		assert.ok(src, 'aquarium source present');
		assert.ok(Math.abs(src.stats.sellBonus - 0.01) < 1e-9, 'two Legendary pets at full bond in Basic: +1.00%');
		assert.equal(r.modifiers.stats.xpBonus, 0, 'never XP');
	});
});

test('care: on cooldown nothing changes; bond capped; locked traits do not multiply', async () => {
	await makeUser('c10-care');
	const tank = await Habitat.create({ name: 'c', owner: 'c10-care', waterType: 'Freshwater', size: 3, cleanliness: 100, temperature: 25 });
	const now = Date.now();
	const p = await petIn('c10-care', tank._id, { name: 'C', xp: 690, lastFed: now - 9 * 3600e3 });
	await with5b(async () => {
		const r = await aq.care(p._id, 'feed', now);
		assert.equal(r.ok, true);
		assert.equal(r.bond, 700, 'capped');
		const again = await aq.care(p._id, 'feed', now + 3600e3);
		assert.equal(again.code, 'COOLDOWN');
		assert.match(again.message, /again in 7.0 h/);
		assert.equal(aq.bondMultiplier({ color: { trait: 'Rainbow', unlocked: false } }), 1);
		assert.equal(aq.bondMultiplier({ color: { trait: 'Rainbow', unlocked: true } }), 1.4);
	});
});

test('selling: the formula (never XP) and at most 3 sales per 7 days', async () => {
	await makeUser('c10-sell');
	const tank = await Habitat.create({ name: 's', owner: 'c10-sell', waterType: 'Freshwater', size: 9, cleanliness: 100, temperature: 25 });
	const pets = [];
	for (let i = 0; i < 4; i++) pets.push(await petIn('c10-sell', tank._id, { name: `S${i}`, xp: 100000, age: 28 }));
	await with5b(async () => {
		const v = require('../src/engine/data/balance-5b.json').value.species['River|Woodskip'].proposed;
		const first = await aq.sellPet('c10-sell', pets[0]._id);
		assert.equal(first.amount, Math.round(v), 'full age, thriving, no attraction: the species value; XP is ignored');
		assert.equal((await aq.sellPet('c10-sell', pets[1]._id)).ok, true);
		assert.equal((await aq.sellPet('c10-sell', pets[2]._id)).ok, true);
		assert.equal((await aq.sellPet('c10-sell', pets[3]._id)).code, 'SALE_LIMIT');
		assert.equal((await PetFish.findById(pets[0]._id).lean()).owner, '', 'a sold pet leaves its owner');
	});
});

test('tanks: a licence grants its tanks; existing extra tanks are kept but count; the shop sells the next licence', async () => {
	await makeUser('c10-tanks');
	for (let i = 0; i < 2; i++) await Habitat.create({ name: `legacy${i}`, owner: 'c10-tanks', waterType: 'Freshwater', size: 1 });
	await giveLicense('c10-tanks', 'Basic Freshwater Aquarium License');
	await with5b(async () => {
		await atLevel('c10-tanks', 30, 200000);
		const refused = await aq.canBuild('c10-tanks', 'freshwater');
		assert.equal(refused.code, 'TANKS_FULL');
		assert.equal(await Habitat.countDocuments({ owner: 'c10-tanks' }), 2, 'legacy tanks kept');
		const tab = await aq.shopTab(await userDoc('c10-tanks'));
		assert.ok(tab.rows.some((r) => r.id === 'license:Advanced Freshwater Aquarium License'));
		assert.ok(tab.rows.some((r) => r.id === 'license:Basic Saltwater Aquarium License'));
		const bought = await aq.buyFromShop('c10-tanks', 'license:Advanced Freshwater Aquarium License');
		assert.equal(bought.price, 120000);
		const ok = await aq.canBuild('c10-tanks', 'Freshwater');
		assert.equal(ok.ok, false, 'Advanced gives 2 tanks: both used by the legacy tanks');
		assert.equal((await aq.buyFromShop('c10-tanks', 'display:Freshwater')).code, 'NOT_OFFERED', 'display tanks need Expert');
	});
});
