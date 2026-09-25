// In-memory MongoDB for tests. Each test file runs in its own process (node --test),
// so one server + mongoose connection per file is enough.
const mongoose = require('mongoose');
const { MongoMemoryServer, MongoMemoryReplSet } = require('mongodb-memory-server-core');

let server;

/** Starts MongoDB and connects mongoose. `replSet: true` gives a transaction-capable server. */
async function startDb({ replSet = false } = {}) {
	server = replSet
		? await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
		: await MongoMemoryServer.create();
	await mongoose.connect(server.getUri(), { dbName: 'test' });
	return mongoose.connection;
}

async function stopDb() {
	await mongoose.disconnect();
	if (server) await server.stop();
	server = null;
}

/** Empties every collection (keeps indexes). */
async function clearDb() {
	const collections = await mongoose.connection.db.collections();
	await Promise.all(collections.map((c) => c.deleteMany({})));
}

module.exports = { startDb, stopDb, clearDb };
