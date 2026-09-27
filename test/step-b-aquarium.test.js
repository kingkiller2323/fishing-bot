// Phase 5B step B: aquarium (A3, A4, A5, A7, A8, A9), correctness on today's aquarium. A1 (sale formula),
// A2 (breeding chance) and A6 (tanks) are step C; prices, capacities and the success formula are unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser, giveFish } = require('./helpers/fixtures');
const { userDoc } = require('./helpers/castFixtures');
const { rng } = require('../src/engine/rng');
const { withUserLock } = require('../src/engine/userLock');
const rules = require('../src/engine/aquariumRules');
const model = require('../scripts/economy/5b/aquarium');
const { Aquarium } = require('../src/class/Aquarium');
const { Pet } = require('../src/class/Pet');
const { Habitat } = require('../src/schemas/HabitatSchema');
const { PetFish } = require('../src/schemas/PetSchema');
const { License } = require('../src/schemas/LicenseSchema');
const { Item } = require('../src/schemas/ItemSchema');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { User } = require('../src/class/User');
const { Utils } = require('../src/class/Utils');
const petCommand = require('../src/commands/slash/Pet/pet.js');
const buyOther = require('../src/components/buttons/buy-other.js');

const DAY = 24 * 60 * 60 * 1000;

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
});
test.after(async () => {
	await stopDb();
	restore();
});

async function makeTank(owner, name, extra = {}) {
	return new Aquarium(await Habitat.create({ name, owner, size: 5, waterType: 'Freshwater', ...extra }));
}

const TRAITS = {
	mood: { trait: 'Calm', unlocked: false },
	hunger: { trait: 'Normal Eater', unlocked: false },
	size: { trait: 'Medium', unlocked: false },
	health: { trait: 'Healthy', unlocked: false },
	finSize: { trait: 'Medium', unlocked: false },
	finShape: { trait: 'Round', unlocked: false },
	color: { trait: 'Blue', unlocked: false },
	geneticDrift: { trait: 'None', unlocked: false },
};

/** A breed-ready adult Carp in `aquarium` (age 30 days, full health, no stress). */
async function adultPet(owner, aquarium, name, extra = {}) {
	const user = new User(await User.get(owner));
	const fish = await giveFish(user, 'Carp');
	const now = Date.now();
	const pet = new Pet({
		fish: fish._id, aquarium: await aquarium.getId(), name, owner, species: 'Carp', age: 30, health: 100, mood: 100, hunger: 0, stress: 0, xp: 0,
		adoptTime: now - 30 * DAY, lastFed: now, lastPlayed: now, lastUpdated: now, lastBred: now - 30 * DAY, multiplier: 1, attraction: 0, traits: TRAITS, ...extra,
	});
	await pet.save();
	await aquarium.addFish(await pet.getId());
	return new Pet(await PetFish.findById(await pet.getId()));
}

/** Forces today's breeding roll to succeed (A2, the chance itself, is step C). */
async function withSuccess(fn) {
	const original = rng.random;
	rng.random = () => 0;
	try {
		return await fn();
	}
	finally {
		rng.random = original;
	}
}

// ---------- The values are the approved design's ----------

test('the live aquarium fix values are the approved model values', () => {
	assert.equal(rules.AQUARIUM_FIXES.idealTemperatureC, model.PARAMS.temperature.idealC);
	assert.deepEqual([...rules.AQUARIUM_FIXES.adjustRangeC], model.PARAMS.temperature.adjustRangeC);
	assert.equal(rules.AQUARIUM_FIXES.newTankTemperatureC, model.PARAMS.temperature.newTankC);
	assert.equal(model.PARAMS.temperature.driftPerHour, 0);
	assert.equal(rules.AQUARIUM_FIXES.breedingCooldownDays, model.PARAMS.breeding.cooldownDays);
});

// ---------- A9: temperature ----------

test('A9: no drift over time; new tanks start at 25 °C; long-drifted values read as the range edge', async () => {
	const t0 = new Date('2026-01-01T00:00:00Z');
	const tank = await makeTank('a9', 'Drift Tank', { temperature: 18, lastAdjusted: t0, lastCleaned: t0 });
	await tank.updateStatus(new Date(t0.getTime() + 500 * 3_600_000));
	assert.equal((await Habitat.findById(await tank.getId()).lean()).temperature, 18, 'the heater holds its setting');
	const fresh = await Habitat.create({ name: 'New Tank', owner: 'a9', size: 1, waterType: 'Freshwater' });
	assert.equal(fresh.temperature, 25);
	for (const [stored, read] of [[500, 30], [31, 30], [-99, -30], [12, 12], [null, 25], [undefined, 25], [NaN, 25]]) {
		assert.equal(rules.effectiveTemperature(stored), read, String(stored));
	}
	const drifted = new Aquarium(await Habitat.create({ name: 'Old Tank', owner: 'a9', size: 1, waterType: 'Freshwater', temperature: 512 }));
	assert.equal(await drifted.getTemperature(), 30, 'read clamped');
	assert.equal((await Habitat.findById(await drifted.getId()).lean()).temperature, 512, 'nothing stored is rewritten');
});

test('A9: hunger, mood, stress and health are all neutral at the one ideal (25 °C) and worse away from it', async () => {
	const tank = await makeTank('a9-f', 'Formula Tank');
	const pet = await adultPet('a9-f', tank, 'Formula Carp');
	const at = async (t) => ({
		hunger: await pet.calculateHunger(60, 100, t),
		mood: await pet.calculateMood(60, 100, t),
		stress: await pet.calculateStress(1, 60, 60, 100, t),
		health: await pet.updateHealth(100, t),
	});
	const ideal = await at(25);
	assert.equal(ideal.health, 100, 'full health at the ideal');
	for (const t of [0, 10, 30, -30]) {
		const off = await at(t);
		assert.ok(off.hunger >= ideal.hunger, `hunger at ${t}`);
		assert.ok(off.mood <= ideal.mood, `mood at ${t}`);
		assert.ok(off.stress >= ideal.stress, `stress at ${t}`);
		assert.ok(off.health < ideal.health, `health at ${t}`);
	}
});

// ---------- A3 / A5: breeding cooldown and success XP ----------

test('A3: a parent that bred in the last 7 days is refused; at 7 days it may breed again', async () => {
	const tank = await makeTank('a3', 'Breed Tank');
	const recent = await adultPet('a3', tank, 'Recent', { lastBred: Date.now() - 2 * DAY });
	const mate = await adultPet('a3', tank, 'Mate');
	const r = await withSuccess(() => Pet.breed(recent, mate, 'Baby A3', tank.aquarium._id));
	assert.equal(r.success, false);
	assert.match(r.reason, /Recent bred recently and can breed again in 5 days/);
	assert.equal(await PetFish.countDocuments({ name: 'Baby A3' }), 0);
	await PetFish.updateOne({ _id: recent.pet._id }, { $set: { lastBred: Date.now() - 7 * DAY } });
	const ready = new Pet(await PetFish.findById(recent.pet._id));
	assert.equal((await withSuccess(() => Pet.breed(ready, mate, 'Baby A3', tank.aquarium._id))).success, true);
});

test('A5: a successful breed gives both parents the success XP (250 x multiplier), then starts their cooldown', async () => {
	const tank = await makeTank('a5', 'XP Tank');
	const a = await adultPet('a5', tank, 'Parent A');
	const b = await adultPet('a5', tank, 'Parent B', { multiplier: 2 });
	const r = await withSuccess(() => Pet.breed(a, b, 'Baby A5', tank.aquarium._id));
	assert.equal(r.success, true);
	assert.equal((await PetFish.findById(a.pet._id).lean()).xp, 250);
	assert.equal((await PetFish.findById(b.pet._id).lean()).xp, 500);
	const a2 = new Pet(await PetFish.findById(a.pet._id));
	const b2 = new Pet(await PetFish.findById(b.pet._id));
	const again = await withSuccess(() => Pet.breed(a2, b2, 'Baby A5 2', tank.aquarium._id));
	assert.equal(again.success, false);
	assert.match(again.reason, /can breed again in 7 days/);
});

// ---------- A4: capacity and baby placement (through /pet breed) ----------

function petInteraction(userId, options) {
	const sent = [];
	return {
		sent,
		interaction: {
			user: { id: userId },
			options: { getSubcommand: () => options.subcommand, getString: (k) => options[k] ?? null },
			deferReply: async () => undefined,
			followUp: async (p) => { sent.push(typeof p === 'string' ? p : p.content); },
		},
	};
}

test('A4: a full tank refuses breeding; otherwise the baby joins the tank\'s fish list in the same flow', async () => {
	const full = await makeTank('a4', 'Full Tank', { size: 2 });
	await adultPet('a4', full, 'Mum');
	await adultPet('a4', full, 'Dad');
	const opts = { subcommand: 'breed', first_pet: 'Mum', second_pet: 'Dad', name: 'Pup', aquarium: 'Full Tank' };
	const refused = petInteraction('a4', opts);
	await withSuccess(() => petCommand.run({}, refused.interaction, null));
	assert.match(refused.sent[0], /aquarium is full/);
	assert.equal(await PetFish.countDocuments({ name: 'Pup' }), 0);

	await Habitat.updateOne({ _id: full.aquarium._id }, { $set: { size: 3 } });
	const bred = petInteraction('a4', opts);
	await withSuccess(() => petCommand.run({}, bred.interaction, null));
	assert.match(bred.sent[0], /Successfully bred/);
	const baby = await PetFish.findOne({ name: 'Pup' }).lean();
	const tank = await Habitat.findById(full.aquarium._id).lean();
	assert.ok(tank.fish.map(String).includes(String(baby._id)), 'the baby is in the tank\'s fish list');
	// Now at capacity (3 of 3): the next breed is refused.
	await PetFish.updateMany({ owner: 'a4' }, { $set: { lastBred: Date.now() - 30 * DAY } });
	const third = petInteraction('a4', { ...opts, name: 'Pup 2' });
	await withSuccess(() => petCommand.run({}, third.interaction, null));
	assert.match(third.sent[0], /aquarium is full/);
});

test('A4: babies missing from a legacy tank\'s fish list still count toward its capacity', async () => {
	const tank = await makeTank('a4-legacy', 'Legacy Tank', { size: 3 });
	await adultPet('a4-legacy', tank, 'L1');
	await adultPet('a4-legacy', tank, 'L2');
	// An older baby placed in the tank but never added to its list (the pre-fix behaviour).
	const orphan = await adultPet('a4-legacy', tank, 'L3');
	await Habitat.updateOne({ _id: tank.aquarium._id }, { $pull: { fish: orphan.pet._id } });
	const r = petInteraction('a4-legacy', { subcommand: 'breed', first_pet: 'L1', second_pet: 'L2', name: 'L4', aquarium: 'Legacy Tank' });
	await withSuccess(() => petCommand.run({}, r.interaction, null));
	assert.match(r.sent[0], /aquarium is full/);
});

// ---------- A8: pet sale ----------

test('A8: two concurrent sells of one pet pay once; the pet leaves its tank', async () => {
	const tank = await makeTank('a8', 'Sale Tank');
	const pet = await adultPet('a8', tank, 'Seller', { xp: 400, attraction: 5 });
	const before = (await userDoc('a8')).inventory.money;
	const copyA = new Pet(await PetFish.findById(pet.pet._id));
	const copyB = new Pet(await PetFish.findById(pet.pet._id));
	const results = await Promise.all([copyA.sell(tank), copyB.sell(tank)]);
	assert.deepEqual(results.sort(), [2000, null].sort());
	assert.equal((await userDoc('a8')).inventory.money - before, 2000, 'paid once: xp x attraction (today\'s formula)');
	const sold = await PetFish.findById(pet.pet._id).lean();
	assert.equal(sold.owner, '');
	assert.equal(sold.aquarium, null);
	assert.ok(!(await Habitat.findById(tank.aquarium._id).lean()).fish.map(String).includes(String(pet.pet._id)));
});

test('A8: a sale during other income loses none of it (money moves by $inc, not a whole-document save)', async () => {
	const tank = await makeTank('a8-inc', 'Inc Tank');
	const pet = await adultPet('a8-inc', tank, 'Inc Seller', { xp: 100, attraction: 5 });
	const before = (await userDoc('a8-inc')).inventory.money;
	// Cast income lands with $inc under the same lock, interleaved with the sale.
	await Promise.all([
		pet.sell(tank),
		withUserLock('a8-inc', () => UserModel.updateOne({ userId: 'a8-inc' }, { $inc: { 'inventory.money': 777 } })),
		UserModel.updateOne({ userId: 'a8-inc' }, { $inc: { 'inventory.money': 23 } }),
	]);
	assert.equal((await userDoc('a8-inc')).inventory.money - before, 500 + 777 + 23);
});

test('A8: /pet sell answers "already sold" instead of paying twice', async () => {
	const tank = await makeTank('a8-cmd', 'Cmd Tank');
	await adultPet('a8-cmd', tank, 'Cmd Pet', { xp: 10, attraction: 5 });
	const first = petInteraction('a8-cmd', { subcommand: 'sell', name: 'Cmd Pet' });
	await petCommand.run({}, first.interaction, null);
	assert.match(first.sent[0], /Successfully sold Cmd Pet for \$50/);
	const second = petInteraction('a8-cmd', { subcommand: 'sell', name: 'Cmd Pet' });
	await petCommand.run({}, second.interaction, null);
	assert.match(second.sent[0], /do not own a pet with that name/);
});

// ---------- A7: duplicate licenses ----------

async function licenseLabels(userId) {
	// buy-other builds its select menu from getSelectionOptions; read the license labels it offers.
	const labels = [];
	const interaction = {
		user: { id: userId },
		message: { id: `m-${userId}`, components: [] },
		update: async (p) => {
			for (const row of (p.components || []).filter(Boolean)) for (const c of row.components || []) for (const o of c.options || []) labels.push(o.data.label);
			return { createMessageComponentCollector: () => ({ on: () => undefined }) };
		},
		reply: async () => undefined,
	};
	await buyOther.run(null, interaction, null);
	return labels.filter((l) => /License/.test(l));
}

test('A7: the shop offers only the next license tier per water type; owned and lower tiers are hidden', async () => {
	await makeUser('a7');
	const all = await licenseLabels('a7');
	assert.equal(all.length, (await Promise.all(await Utils.selectionOptions('license'))).filter(Boolean).length, 'nothing owned: all offered');
	const user = new User(await User.get('a7'));
	await user.sendToInventory((await License.findOne({ name: 'Basic Freshwater Aquarium License', user: null }))._id);
	const afterBasic = await licenseLabels('a7');
	assert.ok(!afterBasic.includes('Basic Freshwater Aquarium License'));
	assert.ok(afterBasic.includes('Advanced Freshwater Aquarium License'));
	assert.ok(afterBasic.includes('Basic Saltwater Aquarium License'), 'the other water type is unaffected');
	await user.sendToInventory((await License.findOne({ name: 'Advanced Freshwater Aquarium License', user: null }))._id);
	const afterAdvanced = await licenseLabels('a7');
	assert.ok(!afterAdvanced.includes('Basic Freshwater Aquarium License') && !afterAdvanced.includes('Advanced Freshwater Aquarium License'));
	assert.ok(afterAdvanced.includes('Expert Freshwater Aquarium License'));
});

test('A7: buying an owned license from a stale menu is refused and not charged', async () => {
	await makeUser('a7-stale');
	const basic = await Item.findOne({ name: 'Basic Saltwater Aquarium License', user: null });
	const user = new User(await User.get('a7-stale'));
	await user.sendToInventory(basic._id);
	await UserModel.updateOne({ userId: 'a7-stale' }, { $set: { 'inventory.money': 5_000_000 } });
	const before = await userDoc('a7-stale');
	// The select handler of a menu opened before the first purchase.
	const replies = [];
	let collect;
	const menu = {
		user: { id: 'a7-stale' },
		message: { id: 'stale-menu', components: [] },
		update: async () => {
			const on = (ev, fn) => {
				if (ev === 'collect') collect = fn;
			};
			return { createMessageComponentCollector: () => ({ on, stop: () => undefined }) };
		},
		reply: async () => undefined,
	};
	await buyOther.run(null, menu, null);
	const push = async (p) => {
		replies.push(p);
	};
	await collect({ user: { id: 'a7-stale' }, customId: 'select-item', values: [String(basic._id)], message: { id: 'stale-menu', components: [], embeds: [] }, reply: push, update: async () => undefined, followUp: push });
	assert.match(replies[0].content, /already own this license/);
	const after = await userDoc('a7-stale');
	assert.equal(after.inventory.money, before.inventory.money, 'not charged');
	assert.equal(after.inventory.items.length, before.inventory.items.length, 'no second copy');
	assert.ok(mongoose.connection.readyState === 1);
});
