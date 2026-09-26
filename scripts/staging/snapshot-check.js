// DCC Fishing Staging only: checks the imported fishing_snapshot against its manifest. Prints counts and
// roles only (never document contents). Exit 1 if any collection's count differs from the manifest.
const { mongo } = require('mongoose');

async function main() {
	const uri = process.env.MONGODB_URI || '';
	if (/mongodb\+srv:|mongodb\.net/i.test(uri) || !/@[a-z0-9-]+\.railway\.internal[:/]/i.test(uri)) throw new Error('Refusing to run: MONGODB_URI is not the staging private host.');
	const client = new mongo.MongoClient(uri);
	await client.connect();
	try {
		const db = client.db('fishing_snapshot');
		const manifest = await db.collection('snapshot_manifest').findOne({ _id: 'manifest' });
		if (!manifest) throw new Error('no snapshot manifest');
		const mismatches = [];
		const counts = {};
		for (const [name, expected] of Object.entries(manifest.counts)) {
			counts[name] = await db.collection(name).countDocuments();
			if (counts[name] !== expected) mismatches.push(`${name}: ${counts[name]} != ${expected}`);
		}
		const roles = manifest.accounts.map((a) => a.role).sort().join(',');
		console.log(`[SNAPSHOT-CHECK] exportedAt=${new Date(manifest.exportedAt).toISOString()} accounts=${manifest.accounts.length} roles=${roles} ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
		console.log(`[SNAPSHOT-CHECK] ${mismatches.length === 0 && manifest.accounts.length === 2 ? 'COUNTS-OK' : `FAILED ${mismatches.join('; ')}`}`);
		if (mismatches.length > 0 || manifest.accounts.length !== 2) process.exitCode = 1;
	}
	finally {
		await client.close();
	}
}

main().catch((error) => {
	console.error(`[SNAPSHOT-CHECK] FAILED: ${String(error?.message || error).replace(/mongodb(\+srv)?:\/\/\S+/g, '<uri>')}`);
	process.exitCode = 1;
});
