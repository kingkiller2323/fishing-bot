// DCC Fishing Staging only: drops the pseudonymized fishing_snapshot database once the exact-account
// rehearsal is done. It can drop nothing else: the name is fixed, the database must hold the snapshot
// manifest, and the connection must be the staging private host. Prints the database list after.
const { mongo } = require('mongoose');

const DB = 'fishing_snapshot';

async function main() {
	const uri = process.env.MONGODB_URI || '';
	if (/mongodb\+srv:|mongodb\.net/i.test(uri) || !/@[a-z0-9-]+\.railway\.internal[:/]/i.test(uri)) throw new Error('Refusing to run: MONGODB_URI is not the staging private host.');
	const client = new mongo.MongoClient(uri);
	await client.connect();
	try {
		const names = async () => (await client.db('admin').admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name).sort();
		if ((await names()).includes(DB)) {
			const manifest = await client.db(DB).collection('snapshot_manifest').findOne({ _id: 'manifest' }, { projection: { format: 1 } });
			if (manifest?.format !== 'fishing-staging-snapshot/1') throw new Error(`${DB} does not hold a snapshot manifest; not dropping`);
			await client.db(DB).dropDatabase();
		}
		const after = await names();
		console.log(`[DROP-SNAPSHOT] ${after.includes(DB) ? 'FAILED: still present' : `${DB} absent`}; databases: ${after.join(', ')}`);
		if (after.includes(DB)) process.exitCode = 1;
	}
	finally {
		await client.close();
	}
}

main().catch((error) => {
	console.error(`[DROP-SNAPSHOT] FAILED: ${String(error?.message || error).replace(/mongodb(\+srv)?:\/\/\S+/g, '<uri>')}`);
	process.exitCode = 1;
});
