// DCC Fishing Staging only: creates (IMPORT_USER_ACTION=create), checks (=verify) or drops (=drop) the temporary user the
// one-time snapshot export writes with. It can only read/write the fishing_snapshot database.
// Runs with the staging admin connection (MONGODB_URI, a Railway private host); never against Atlas.
const { mongo } = require('mongoose');

const USER = 'snapshot-import';
const DB = 'fishing_snapshot';

async function main() {
	const uri = process.env.MONGODB_URI || '';
	if (/mongodb\+srv:|mongodb\.net/i.test(uri) || !/@[a-z0-9-]+\.railway\.internal[:/]/i.test(uri)) throw new Error('Refusing to run: MONGODB_URI is not the staging private host.');
	const action = process.env.IMPORT_USER_ACTION;
	const client = new mongo.MongoClient(uri);
	await client.connect();
	try {
		const db = client.db(DB);
		const exists = (await db.command({ usersInfo: USER })).users.length > 0;
		if (action === 'create') {
			const pwd = process.env.IMPORT_PASSWORD;
			if (!pwd || pwd.length < 24) throw new Error('IMPORT_PASSWORD must be at least 24 characters.');
			if (exists) await db.command({ updateUser: USER, pwd, roles: [{ role: 'readWrite', db: DB }] });
			else await db.command({ createUser: USER, pwd, roles: [{ role: 'readWrite', db: DB }] });
			console.log(`[IMPORT-USER] ${USER} ready (readWrite on ${DB} only).`);
		}
		else if (action === 'verify') {
			// Roles only (never credentials): the user must hold exactly readWrite on fishing_snapshot.
			const info = (await db.command({ usersInfo: USER, showPrivileges: false })).users[0];
			const roles = (info?.roles || []).map((r) => `${r.role}@${r.db}`);
			const ok = roles.length === 1 && roles[0] === `readWrite@${DB}`;
			console.log(`[IMPORT-USER] ${USER} roles: ${roles.join(', ') || 'none'} -> ${ok ? 'RESTRICTED-OK' : 'NOT RESTRICTED'}`);
			if (!ok) process.exitCode = 1;
		}
		else if (action === 'drop') {
			if (exists) await db.command({ dropUser: USER });
			console.log(`[IMPORT-USER] ${USER} ${exists ? 'dropped' : 'already absent'}.`);
		}
		else {
			throw new Error('IMPORT_USER_ACTION must be create, verify or drop.');
		}
	}
	finally {
		await client.close();
	}
}

main().catch((error) => {
	console.error(`[IMPORT-USER] FAILED: ${String(error?.message || error).replace(/mongodb(\+srv)?:\/\/\S+/g, '<uri>')}`);
	process.exitCode = 1;
});
