// Manually run the idempotent static-data bootstrap (the bot also runs it on every startup).
//   npm run seed                 -> full bootstrap: normalize, seed all steps, season, weather, validate
//   npm run seed -- bait quests  -> only the named seed steps (see src/bootstrap/seed.js STEPS)
require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config');
const { bootstrap, seedStatic } = require('../bootstrap');

async function run(steps = process.argv.slice(2)) {
	const uri = process.env.MONGODB_URI || config.handler.mongodb.uri;
	if (!uri) throw new Error('MONGODB_URI is not set.');
	await mongoose.connect(uri);
	try {
		if (steps.length > 0) await seedStatic(steps);
		else await bootstrap();
	}
	finally {
		await mongoose.disconnect();
	}
}

if (require.main === module) {
	run().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}

module.exports = { run };
