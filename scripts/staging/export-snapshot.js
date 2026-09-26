// One-time, READ-ONLY copy of the production Fishing accounts into DCC Fishing Staging (Phase 5B step A).
//
// Source (SNAPSHOT_SOURCE_URI, a Railway reference to the production MONGODB_URI): the raw driver only
// (no mongoose models, bootstrap, migrations or saves), and nothing but find / countDocuments. Scope: the
// accounts in `users` (at most SNAPSHOT_MAX_ACCOUNTS), their cast and box journals, the dev-audit history
// that targets them, the migration markers and, only for an account with a pending journal, the
// inventory records a replay needs (items, quests). No guild or server data.
//
// Every Discord identifier (user, guild, channel, message, interaction: any 17-20 digit snowflake) is
// replaced in memory by a stable pseudonym, consistently across documents, BEFORE anything is written.
// Target (SNAPSHOT_TARGET_URI): the staging `fishing_snapshot` database only. Logs carry counts only:
// no documents, no identifiers, no connection strings.
const { mongo } = require('mongoose');

const { MongoClient } = mongo;
const TARGET_DB = 'fishing_snapshot';
// A snowflake not embedded in a longer hex/digit run (never matches inside an ObjectId hex string).
const SNOWFLAKE = /(?<![0-9a-fA-F])\d{17,20}(?![0-9a-fA-F])/g;
const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
const log = (message) => console.log(`[SNAPSHOT] ${message}`);

function guard(source, target) {
	const problems = [];
	if (!source) problems.push('SNAPSHOT_SOURCE_URI is not set');
	if (!target) problems.push('SNAPSHOT_TARGET_URI is not set');
	if (source && target && source === target) problems.push('source and target are the same');
	if (/mongodb\+srv:|mongodb\.net/i.test(target || '')) problems.push('the target looks like Atlas (production)');
	if (!/\/fishing_snapshot(\?|$)/.test(target || '')) problems.push(`the target must be the ${TARGET_DB} database`);
	if (process.env.CLIENT_TOKEN) problems.push('CLIENT_TOKEN is set');
	if (problems.length > 0) throw new Error(`Refusing to run: ${problems.join('; ')}.`);
}

function pseudonymizer(founders, developers) {
	const map = new Map();
	const seq = { founder: 0, developer: 0, other: 0 };
	const alias = (id) => {
		if (!map.has(id)) {
			const kind = founders.has(id) ? 'founder' : developers.has(id) ? 'developer' : 'other';
			const prefix = { founder: '1', developer: '5', other: '9' }[kind];
			map.set(id, `${prefix}${String(++seq[kind]).padStart(17, '0')}`);
		}
		return map.get(id);
	};
	const scrub = (value) => {
		if (typeof value === 'string') return value.replace(SNOWFLAKE, (m) => alias(m));
		if (Array.isArray(value)) return value.map(scrub);
		if (value && typeof value === 'object' && !value._bsontype && !(value instanceof Date)) {
			return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replace(SNOWFLAKE, (m) => alias(m)), scrub(v)]));
		}
		return value;
	};
	return { alias, scrub, size: () => map.size, isPseudonym: (v) => [...map.values()].includes(v) };
}

async function main() {
	const sourceUri = process.env.SNAPSHOT_SOURCE_URI;
	const targetUri = process.env.SNAPSHOT_TARGET_URI;
	guard(sourceUri, targetUri);
	const maxAccounts = Number(process.env.SNAPSHOT_MAX_ACCOUNTS || 2);
	const founders = new Set(list(process.env.FOUNDER_IDS));
	const developers = new Set(list(process.env.DEVELOPER_IDS));

	const source = new MongoClient(sourceUri, { readPreference: 'secondaryPreferred', appName: 'fishing-staging-snapshot' });
	const target = new MongoClient(targetUri, { appName: 'fishing-staging-snapshot' });
	await source.connect();
	await target.connect();
	try {
		const src = source.db();
		const dst = target.db(TARGET_DB);

		// ---- Read (production: find / countDocuments only) ----
		const userCount = await src.collection('users').countDocuments();
		if (userCount > maxAccounts) throw new Error(`production has ${userCount} accounts, more than SNAPSHOT_MAX_ACCOUNTS=${maxAccounts}; refusing`);
		const users = await src.collection('users').find({}).toArray();
		const ids = users.map((u) => u.userId);
		const casts = await src.collection('casts').find({ userId: { $in: ids } }).toArray();
		const opens = await src.collection('gachaopens').find({ userId: { $in: ids } }).toArray();
		const audits = await src.collection('devaudits').find({ target: { $in: ids } }).toArray();
		const markers = await src.collection('migrations').find({}).toArray();
		const pendingUsers = [...new Set([...casts, ...opens].filter((j) => j.status === 'pending').map((j) => j.userId))];
		const replay = pendingUsers.length === 0 ? { itemdatas: [], questdatas: [] } : {
			itemdatas: await src.collection('itemdatas').find({ user: { $in: pendingUsers } }).toArray(),
			questdatas: await src.collection('questdatas').find({ user: { $in: pendingUsers } }).toArray(),
		};

		// ---- Pseudonymize in memory (Founders first, so they get stable 1… pseudonyms) ----
		const p = pseudonymizer(founders, developers);
		[...founders].sort().forEach(p.alias);
		const collections = {
			users: users.map(p.scrub),
			casts: casts.map(p.scrub),
			gachaopens: opens.map(p.scrub),
			devaudits: audits.map(p.scrub),
			migrations: markers.map(p.scrub),
			itemdatas: replay.itemdatas.map(p.scrub),
			questdatas: replay.questdatas.map(p.scrub),
		};
		const residue = (JSON.stringify(Object.values(collections)).match(SNOWFLAKE) || []).filter((m) => !p.isPseudonym(m));
		if (residue.length > 0) throw new Error(`${residue.length} identifier(s) survived pseudonymization; nothing written`);
		const accounts = users.map((u, i) => ({ userId: collections.users[i].userId, role: founders.has(u.userId) ? 'founder' : 'member' }));
		const manifest = {
			_id: 'manifest',
			format: 'fishing-staging-snapshot/1',
			exportedAt: new Date(),
			accounts,
			founders: accounts.filter((a) => a.role === 'founder').map((a) => a.userId),
			pendingJournalUsers: pendingUsers.map(p.alias),
			counts: Object.fromEntries(Object.entries(collections).map(([k, v]) => [k, v.length])),
			pseudonyms: p.size(),
		};

		// ---- Write (staging fishing_snapshot only): replace the previous snapshot ----
		for (const c of await dst.listCollections({}, { nameOnly: true }).toArray()) await dst.collection(c.name).drop();
		for (const [name, docs] of Object.entries(collections)) if (docs.length > 0) await dst.collection(name).insertMany(docs, { ordered: true });
		await dst.collection('snapshot_manifest').insertOne(manifest);
		for (const [name, docs] of Object.entries(collections)) {
			const written = await dst.collection(name).countDocuments();
			if (written !== docs.length) throw new Error(`${name}: wrote ${written}, expected ${docs.length}`);
		}
		log(`accounts=${accounts.length} (founders=${manifest.founders.length}) ${Object.entries(manifest.counts).map(([k, v]) => `${k}=${v}`).join(' ')} pendingJournalAccounts=${pendingUsers.length} pseudonyms=${manifest.pseudonyms}`);
		log('SNAPSHOT-OK');
	}
	finally {
		await source.close();
		await target.close();
	}
}

main().catch((error) => {
	// The message only: driver errors can quote a connection string in their stack/metadata.
	console.error(`[SNAPSHOT] FAILED: ${String(error?.message || error).replace(/mongodb(\+srv)?:\/\/\S+/g, '<uri>')}`);
	process.exitCode = 1;
});
