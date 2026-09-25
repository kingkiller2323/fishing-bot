const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser, giveFish } = require('./helpers/fixtures');
const { Aquarium } = require('../src/class/Aquarium');
const { Pet } = require('../src/class/Pet');
const { Habitat } = require('../src/schemas/HabitatSchema');
const { PetFish } = require('../src/schemas/PetSchema');
const { License } = require('../src/schemas/LicenseSchema');

const HOUR = 3_600_000;

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
});
test.after(async () => {
	await stopDb();
	restore();
});

async function giveLicense(user, name) {
	const license = await License.findOne({ name, user: null });
	await user.sendToInventory(license._id);
}

test('aquarium license: best matching water type, case-insensitive, else null', async () => {
	const user = await makeUser('licensee');
	assert.equal(await user.getAquariumLicense('Freshwater'), null);

	await giveLicense(user, 'Basic Freshwater Aquarium License');
	await giveLicense(user, 'Advanced Freshwater Aquarium License');
	await giveLicense(user, 'Basic Saltwater Aquarium License');

	const fresh = await user.getAquariumLicense('Freshwater');
	assert.equal(fresh.name, 'Advanced Freshwater Aquarium License');
	assert.equal((await user.getAquariumLicense('saltwater')).name, 'Basic Saltwater Aquarium License');
	assert.equal(await user.getAquariumLicense('Lava'), null);
});

async function makeAquarium(owner, name, extra = {}) {
	const doc = await Habitat.create({ name, owner, size: 5, waterType: 'Freshwater', ...extra });
	return new Aquarium(doc);
}

test('decay is applied once per elapsed hour, never re-applied', async () => {
	const t0 = new Date('2026-01-01T00:00:00Z');
	const aquarium = await makeAquarium('decayer', 'Tank', { lastCleaned: t0, lastAdjusted: t0, cleanliness: 100, temperature: 0 });

	await aquarium.updateStatus(new Date(t0.getTime() + 5 * HOUR + 10 * 60_000));
	assert.equal(await aquarium.getCleanliness(), 95);
	assert.equal(await aquarium.getTemperature(), 5);

	// Viewing again at the same moment changes nothing.
	await aquarium.updateStatus(new Date(t0.getTime() + 5 * HOUR + 20 * 60_000));
	assert.equal(await aquarium.getCleanliness(), 95);

	// The leftover 20 minutes count toward the next hour.
	await aquarium.updateStatus(new Date(t0.getTime() + 6 * HOUR));
	const stored = await Habitat.findById(await aquarium.getId());
	assert.equal(stored.cleanliness, 94);
	assert.equal(stored.temperature, 6);

	// Cleaning resets the cleanliness clock.
	const cleanedAt = new Date(t0.getTime() + 6 * HOUR);
	await aquarium.clean(cleanedAt);
	await aquarium.updateStatus(new Date(cleanedAt.getTime() + 2 * HOUR));
	assert.equal((await Habitat.findById(await aquarium.getId())).cleanliness, 98);
});

test('cleanliness never goes below zero', async () => {
	const t0 = new Date('2026-01-01T00:00:00Z');
	const aquarium = await makeAquarium('decayer2', 'Old Tank', { lastCleaned: t0, cleanliness: 3 });
	await aquarium.updateStatus(new Date(t0.getTime() + 500 * HOUR));
	assert.equal((await Habitat.findById(await aquarium.getId())).cleanliness, 0);
});

async function makePet(user, aquarium, name, traits = {}) {
	const fish = await giveFish(user, 'Carp');
	const pet = new Pet({ fish: fish._id, aquarium: await aquarium.getId(), name, owner: await user.getUserId(), species: 'Carp', traits });
	await pet.save();
	await aquarium.addFish(await pet.getId());
	return pet;
}

test('moving a pet (standalone MongoDB, no transactions) updates pet and both aquariums', async () => {
	assert.equal(await Aquarium.supportsTransactions(), false);
	const user = await makeUser('mover');
	const a = await makeAquarium('mover', 'A');
	const b = await makeAquarium('mover', 'B');
	const pet = await makePet(user, a, 'Bubbles');

	await b.moveFish(pet, b);

	const petId = String(await pet.getId());
	assert.equal(String((await PetFish.findById(petId)).aquarium), String(await b.getId()));
	assert.deepEqual((await Habitat.findById(await a.getId())).fish.map(String), []);
	assert.deepEqual((await Habitat.findById(await b.getId())).fish.map(String), [petId]);
});

test('an interrupted move is repaired by reconcileOwner', async () => {
	const user = await makeUser('crasher');
	const a = await makeAquarium('crasher', 'A');
	const b = await makeAquarium('crasher', 'B');
	const pet = await makePet(user, a, 'Nemo');
	const petId = await pet.getId();

	// Simulate a crash right after the pet was re-pointed, before membership was updated.
	await PetFish.updateOne({ _id: petId }, { $set: { aquarium: await b.getId() } });
	await Aquarium.reconcileOwner('crasher');
	await Aquarium.reconcileOwner('crasher');

	assert.deepEqual((await Habitat.findById(await a.getId())).fish.map(String), []);
	assert.deepEqual((await Habitat.findById(await b.getId())).fish.map(String), [String(petId)]);
});

test('updateHabitat writes the schema field (aquarium)', async () => {
	const user = await makeUser('habitat');
	const a = await makeAquarium('habitat', 'A');
	const b = await makeAquarium('habitat', 'B');
	const pet = await makePet(user, a, 'Dory');
	await pet.updateHabitat(await b.getId());
	assert.equal(String((await PetFish.findById(await pet.getId())).aquarium), String(await b.getId()));
});

test('pet timestamps default per document, not per process', async () => {
	assert.equal(PetFish.schema.path('lastFed').defaultValue, Date.now);
	const first = new PetFish({ name: 'x', owner: 'o', species: 'Carp' });
	await new Promise((resolve) => setTimeout(resolve, 15));
	const second = new PetFish({ name: 'y', owner: 'o', species: 'Carp' });
	assert.ok(second.lastFed > first.lastFed);
	assert.ok(second.adoptTime > first.adoptTime);
});

const traitSet = (driftTrait, driftUnlocked) => ({
	mood: { trait: 'Calm', unlocked: false },
	hunger: { trait: 'Normal Eater', unlocked: false },
	size: { trait: 'Medium', unlocked: false },
	health: { trait: 'Healthy', unlocked: false },
	finSize: { trait: 'Medium', unlocked: false },
	finShape: { trait: 'Round', unlocked: false },
	color: { trait: 'Blue', unlocked: false },
	geneticDrift: { trait: driftTrait, unlocked: driftUnlocked },
});

test('environment affects non-Adaptive pets: a dirty tank lowers mood and raises stress', async () => {
	const user = await makeUser('keeper');
	const tank = await makeAquarium('keeper', 'Tank');
	const pet = await makePet(user, tank, 'Plain', traitSet('Stable', true));

	const cleanMood = await pet.calculateMood(60, 100, 0);
	const dirtyMood = await pet.calculateMood(60, 20, 0);
	assert.ok(dirtyMood < cleanMood, `dirty ${dirtyMood} < clean ${cleanMood}`);

	const cleanStress = await pet.calculateStress(60, 60, 60, 100, 0);
	const dirtyStress = await pet.calculateStress(60, 60, 60, 20, 0);
	assert.ok(dirtyStress > cleanStress, `dirty ${dirtyStress} > clean ${cleanStress}`);
});

test('an unlocked Adaptive pet ignores the environment; a locked one does not', async () => {
	const user = await makeUser('keeper2');
	const tank = await makeAquarium('keeper2', 'Tank');
	const adaptive = await makePet(user, tank, 'Adapt', traitSet('Adaptive', true));
	assert.equal(await adaptive.calculateMood(60, 20, 0), await adaptive.calculateMood(60, 100, 0));

	const hidden = await makePet(user, tank, 'Hidden', traitSet('Adaptive', false));
	assert.ok(await hidden.calculateMood(60, 20, 0) < await hidden.calculateMood(60, 100, 0));
});
