const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { bootstrap } = require('../src/bootstrap');
const { STEPS } = require('../src/bootstrap/seed');

test.before(async () => {
	quiet();
	await startDb();
});
test.after(async () => {
	await stopDb();
	restore();
});

const counts = async () => {
	const out = {};
	for (const c of await mongoose.connection.db.collections()) out[c.collectionName] = await c.countDocuments();
	return out;
};

test('bootstrap seeds a fresh database and passes validation', async () => {
	await bootstrap();
	const c = await counts();
	assert.equal(c.weathertypes, 5);
	assert.equal(c.seasons, 4);
	assert.equal(c.biomes, 6);
	assert.equal(c.fish, 178);
	assert.equal(c.items, 53);
	assert.equal(c.quests, 13);
	assert.equal(c.weatherpatterns, 7);
	const active = await mongoose.connection.db.collection('seasons').countDocuments({ active: true });
	assert.equal(active, 1);
});

test('bootstrap is idempotent', async () => {
	const before = await counts();
	await bootstrap();
	assert.deepEqual(await counts(), before);
});

test('every seed step defines unique natural keys', () => {
	for (const step of STEPS) {
		const keys = step.docs().map((d) => step.keyFields.map((f) => String({ weather: 'all', season: 'all', ...d }[f])).join('|'));
		assert.equal(new Set(keys).size, keys.length, step.name);
	}
});

test('required catalog entries exist', async () => {
	const items = mongoose.connection.db.collection('items');
	for (const name of ['Old Rod', 'Daily Box', 'Voter\'s Crate']) assert.ok(await items.findOne({ name }), name);
});
