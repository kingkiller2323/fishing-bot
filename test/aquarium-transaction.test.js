// Same move, on a replica set where MongoDB transactions are available.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser, giveFish } = require('./helpers/fixtures');
const { Aquarium } = require('../src/class/Aquarium');
const { Pet } = require('../src/class/Pet');
const { Habitat } = require('../src/schemas/HabitatSchema');
const { PetFish } = require('../src/schemas/PetSchema');

test.before(async () => {
	quiet();
	await startDb({ replSet: true });
	await seedGame();
});
test.after(async () => {
	await stopDb();
	restore();
});

test('moving a pet uses a transaction on a replica set', async () => {
	assert.equal(await Aquarium.supportsTransactions(), true);
	const user = await makeUser('tx-mover');
	const a = new Aquarium(await Habitat.create({ name: 'A', owner: 'tx-mover', size: 5, waterType: 'Freshwater' }));
	const b = new Aquarium(await Habitat.create({ name: 'B', owner: 'tx-mover', size: 5, waterType: 'Freshwater' }));
	const fish = await giveFish(user, 'Carp');
	const pet = new Pet({ fish: fish._id, aquarium: await a.getId(), name: 'Tx', owner: 'tx-mover', species: 'Carp' });
	await pet.save();
	await a.addFish(await pet.getId());

	await b.moveFish(pet, b);

	const petId = String(await pet.getId());
	assert.equal(String((await PetFish.findById(petId)).aquarium), String(await b.getId()));
	assert.deepEqual((await Habitat.findById(await a.getId())).fish.map(String), []);
	assert.deepEqual((await Habitat.findById(await b.getId())).fish.map(String), [petId]);
});
