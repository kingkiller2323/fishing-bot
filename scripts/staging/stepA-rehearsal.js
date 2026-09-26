// Phase 5B step A rehearsal for DCC Fishing Staging. NEVER runs against production.
//
// Builds pre-step-A player data (synthetic accounts shaped like the production Founder and member
// accounts, plus migration edge cases and 3.2.0 journals), then runs the real startup path
// (bootstrap: seed, validation, migrations, journal recovery) twice and proves:
//   - pass two changes nothing (every collection, document by document);
//   - publicXp is reconciled exactly; levelFloor / publicLevelFloor equal their anchors;
//   - no stored level goes down;
//   - pending 3.2.0 cast and box journals replay; a malformed journal stays pending without blocking
//     the boot or any player;
//   - with BALANCE_5B off, today's curve and rewards are active.
// Prints a JSON report between REPORT-BEGIN / REPORT-END and exits 1 if any check fails.
//
// Guards: STAGING_REHEARSAL=1 is required; the database must be a Railway private host or localhost
// (never Atlas); no Discord token may be present; BALANCE_5B must be off. The rehearsal database
// (STAGING_DB, default fishing_rehearsal) is dropped and rebuilt on every run.
const FIXTURE_FOUNDERS = ['stg-founder', 'stg-founder-set'];
if (process.env.FOUNDER_IDS === undefined) process.env.FOUNDER_IDS = FIXTURE_FOUNDERS.join(',');

const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const { EJSON } = mongoose.mongo.BSON;
const ROOT = path.join(__dirname, '..', '..');
const DB_NAME = process.env.STAGING_DB || 'fishing_rehearsal';

function guard() {
	const uri = process.env.MONGODB_URI || '';
	const problems = [];
	if (process.env.STAGING_REHEARSAL !== '1') problems.push('STAGING_REHEARSAL=1 is not set');
	if (!uri) problems.push('MONGODB_URI is not set');
	if (/mongodb\+srv:|mongodb\.net/i.test(uri)) problems.push('MONGODB_URI points at Atlas (production); refusing');
	const hosts = (uri.match(/^mongodb:\/\/(?:[^@/]*@)?([^/?]+)/) || [])[1] || '';
	const allowed = hosts.split(',').every((h) => /^(localhost|127\.0\.0\.1|[a-z0-9-]+\.railway\.internal)(:\d+)?$/i.test(h));
	if (!hosts || !allowed) problems.push('MONGODB_URI host is not a Railway private host or localhost');
	if (process.env.CLIENT_TOKEN) problems.push('CLIENT_TOKEN is set: the rehearsal never runs with a Discord token');
	if (problems.length > 0) throw new Error(`Refusing to run: ${problems.join('; ')}.`);
}

/** Single-node replica set (transactions, as on Atlas). Initiated once when STAGING_REPLSET is set. */
async function ensureReplicaSet(uri) {
	const name = process.env.STAGING_REPLSET;
	if (!name) return;
	const host = process.env.STAGING_REPLSET_HOST;
	const client = new mongoose.mongo.MongoClient(uri, { directConnection: true, serverSelectionTimeoutMS: 30000 });
	await client.connect();
	try {
		const admin = client.db('admin');
		try {
			await admin.command({ replSetGetStatus: 1 });
		}
		catch (error) {
			if (!/no replset config|NotYetInitialized/i.test(`${error.codeName} ${error.message}`)) throw error;
			await admin.command({ replSetInitiate: { _id: name, members: [{ _id: 0, host }] } });
		}
		for (let i = 0; i < 60; i++) {
			const hello = await admin.command({ hello: 1 });
			if (hello.isWritablePrimary) return;
			await new Promise((r) => setTimeout(r, 1000));
		}
		throw new Error('replica set has no primary after 60s');
	}
	finally {
		await client.close();
	}
}

const checks = [];
function check(name, pass, detail = {}) {
	checks.push({ name, pass: Boolean(pass), ...detail });
	return pass;
}

/** Every document of every collection, as canonical EJSON keyed by _id. */
async function captureAll() {
	const out = {};
	for (const { name } of await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray()) {
		const docs = await mongoose.connection.db.collection(name).find({}).sort({ _id: 1 }).toArray();
		out[name] = Object.fromEntries(docs.map((d) => [EJSON.stringify(d._id), EJSON.stringify(d, { relaxed: false })]));
	}
	return out;
}

function diffCaptures(a, b) {
	const changes = [];
	for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
		const x = a[name] || {};
		const y = b[name] || {};
		for (const id of new Set([...Object.keys(x), ...Object.keys(y)])) {
			if (x[id] === y[id]) continue;
			const fields = [];
			if (x[id] && y[id]) {
				const dx = EJSON.parse(x[id], { relaxed: false });
				const dy = EJSON.parse(y[id], { relaxed: false });
				for (const k of new Set([...Object.keys(dx), ...Object.keys(dy)])) {
					if (EJSON.stringify(dx[k] ?? null) !== EJSON.stringify(dy[k] ?? null)) fields.push(k);
				}
			}
			changes.push({ collection: name, id, change: !x[id] ? 'added' : !y[id] ? 'removed' : 'modified', fields });
		}
	}
	return changes;
}

async function main() {
	guard();
	const uri = process.env.MONGODB_URI;
	await ensureReplicaSet(uri);
	await mongoose.connect(uri, { dbName: DB_NAME, serverSelectionTimeoutMS: 30000 });
	if (mongoose.connection.db.databaseName !== DB_NAME) throw new Error('connected to an unexpected database');
	await mongoose.connection.db.dropDatabase();

	// Required only after the connection: the engine reads config (FOUNDER_IDS, BALANCE_5B) at require time.
	const config = require('../../src/config');
	const balance = require('../../src/engine/balance');
	const levels = require('../../src/engine/levels');
	const { publicXpOf, checkPublicXp } = require('../../src/engine/publicLevel');
	const { bootstrap, seedStatic } = require('../../src/bootstrap');
	const { castLine, applyCastResult } = require('../../src/engine/cast');
	const { Aquarium } = require('../../src/class/Aquarium');
	const { User: UserModel } = require('../../src/schemas/UserSchema');
	const { Cast } = require('../../src/schemas/CastSchema');
	const { GachaOpen } = require('../../src/schemas/GachaOpenSchema');
	const { DevAudit } = require('../../src/schemas/DevAuditSchema');
	const { ItemData, Item } = require('../../src/schemas/ItemSchema');
	const { makeUser } = require('../../test/helpers/fixtures');
	const { addPoolFish, useTestRod } = require('../../test/helpers/castFixtures');
	const { giveBox } = require('../../test/helpers/gachaFixtures');

	const todays = balance.levelForXp;
	const env = {
		database: DB_NAME,
		transactions: await Aquarium.supportsTransactions(),
		mongoVersion: (await mongoose.connection.db.admin().command({ buildInfo: 1 })).version,
		balance5bEnv: process.env.BALANCE_5B ?? null,
		founders: config.users.founders,
		node: process.version,
	};
	for (const f of FIXTURE_FOUNDERS) if (!config.users.founders.includes(f)) throw new Error(`FOUNDER_IDS must include ${f}`);

	// ---------- Flag off: today's game ----------
	check('flag.off', config.flags.balance5b === false && balance.isBalance5b() === false, { env: process.env.BALANCE_5B ?? null });
	check('flag.curve-is-today', levels.activeCurve().name === 'current');
	const curveSamples = [0, 99, 100, 399, 400, 12345, 70000, 250000, 1e6, 5e7];
	check('flag.curve-equals-levelForXp', curveSamples.every((x) => levels.curveLevel(x) === todays(x)), { samples: curveSamples.map((x) => [x, levels.curveLevel(x)]) });
	check('flag.balance-version', balance.BALANCE_VERSION === '3.2.0', { version: balance.BALANCE_VERSION });

	// ---------- Pre-step-A world ----------
	await seedStatic();
	await addPoolFish([{ name: 'Pool Minnow', rarity: 'Common', baseValue: 40 }]);

	const fixture = (name) => EJSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', name), 'utf8'), { relaxed: true });
	const legacy = async (userId, fields, unset = []) => {
		await makeUser(userId);
		const $unset = Object.fromEntries(['levelFloor', 'publicLevelFloor', ...unset].map((k) => [k, '']));
		await UserModel.collection.updateOne({ userId }, { $set: fields, $unset });
	};
	const journal = (userId, at, profileBonus, base = 100) => {
		const id = new mongoose.Types.ObjectId().toString();
		return { _id: id, userId, status: 'applied', createdAt: at, appliedAt: at, attempts: 1, result: { castId: id, userId, status: 'ok', createdAt: at, profile: 'founder', xp: { total: base + profileBonus }, rewards: { xp: { base, profileBonus } } } };
	};
	const day = (n) => new Date(Date.UTC(2026, 6, 1 + n));

	// Accounts shaped like production today: publicXp present (earlier migration), no floors, no reconcile marker.
	const expected = {
		// Founder: publicXp left wrong by the pre-F4 code; 180,000 XP of private bonus in its journals.
		'stg-founder': { set: { xp: 250000, level: 50, publicXp: 1234 }, publicXp: 70000, levelFloor: 50, publicLevelFloor: todays(70000) },
		// Founder with an audited /dev xp set: only journals after it count (3,000 bonus).
		'stg-founder-set': { set: { xp: 20000, level: 14, publicXp: 20000 }, publicXp: 17000, levelFloor: 14, publicLevelFloor: todays(17000) },
		'stg-member': { set: { xp: 12345, level: 11, publicXp: 12345 }, publicXp: 12345, levelFloor: 11, publicLevelFloor: 11 },
		'stg-member-nopublic': { set: { xp: 5000, level: 7 }, unset: ['publicXp'], publicXp: 5000, levelFloor: 7, publicLevelFloor: 7 },
		'stg-member-drift': { set: { xp: 5200, level: 7, publicXp: 3000 }, publicXp: 5200, levelFloor: 7, publicLevelFloor: 7 },
		// Stored level above the curve (XP removed by the old /dev command): the floor keeps level 7.
		'stg-member-highlevel': { set: { xp: 400, level: 7, publicXp: 400 }, publicXp: 400, levelFloor: 7, publicLevelFloor: 7 },
		'stg-member-nolevel': { set: { xp: 900, publicXp: 900 }, unset: ['level'], publicXp: 900, levelFloor: 3, publicLevelFloor: 3 },
		'stg-member-zero': { set: { xp: 0, level: 1, publicXp: 0 }, publicXp: 0, levelFloor: 1, publicLevelFloor: 1 },
	};
	for (const [id, e] of Object.entries(expected)) await legacy(id, e.set, e.unset);
	await Cast.collection.insertMany([
		journal('stg-founder', day(1), 100000),
		journal('stg-founder', day(2), 80000),
		journal('stg-founder-set', day(1), 50000),
		journal('stg-founder-set', day(5), 3000),
	]);
	await DevAudit.collection.insertOne({ actor: 'stg-dev', target: 'stg-founder-set', operation: 'xp.set', details: { value: 20000 }, before: {}, after: {}, timestamp: day(3) });

	// Pending 3.2.0 cast journal (captured from the pre-step-A code), onto a legacy account.
	const moveItemTo = async (userId, fromId, toId, listField) => {
		const doc = await ItemData.collection.findOne({ _id: fromId });
		await ItemData.collection.insertOne({ ...doc, _id: toId });
		await ItemData.collection.deleteOne({ _id: fromId });
		await UserModel.collection.updateOne({ userId }, { $pull: { [listField]: fromId } });
		await UserModel.collection.updateOne({ userId }, { $push: { [listField]: toId } });
	};
	const castPlayer = async (result, fields) => {
		await legacy(result.userId, fields);
		const rodId = await useTestRod(result.userId, { capabilities: ['weak', '1'] });
		await moveItemTo(result.userId, rodId, new mongoose.Types.ObjectId(result.rod.id), 'inventory.rods');
		await UserModel.collection.updateOne({ userId: result.userId }, { $set: { 'inventory.equippedRod': new mongoose.Types.ObjectId(result.rod.id) } });
		await Cast.collection.insertOne({ _id: result.castId, userId: result.userId, guildId: null, result, status: 'pending', attempts: 0, createdAt: new Date() });
	};
	const castJ = fixture('cast-journal-3.2.0.json');
	await castPlayer(castJ, { xp: 350, level: 1, publicXp: 350 });
	// The same journal shape onto an account whose stored level (9) is above its curve: must not lower it.
	const highJ = fixture('cast-journal-3.2.0.json');
	highJ.userId = 'journal-highlevel';
	highJ.castId = new mongoose.Types.ObjectId().toString();
	highJ.rod.id = new mongoose.Types.ObjectId().toString();
	highJ.writes.fishDocs = highJ.writes.fishDocs.map((d) => ({ ...d, _id: new mongoose.Types.ObjectId().toString(), user: highJ.userId, castId: highJ.castId }));
	await castPlayer(highJ, { xp: 350, level: 9, publicXp: 350 });

	// Pending 3.2.0 box-opening journal.
	const openJ = fixture('gacha-journal-3.2.0.json');
	openJ.userId = 'journal-gacha';
	openJ.writes.fishDocs = openJ.writes.fishDocs.map((d) => ({ ...d, user: openJ.userId }));
	await legacy(openJ.userId, { xp: 2500, level: 5, publicXp: 2500 });
	await giveBox(openJ.userId, 'Voter\'s Crate', 2);
	const crate = await ItemData.collection.findOne({ user: openJ.userId, name: (await Item.findOne({ name: 'Voter\'s Crate', user: null }).lean()).name });
	await moveItemTo(openJ.userId, crate._id, new mongoose.Types.ObjectId(openJ.box.id), 'inventory.gacha');
	await GachaOpen.collection.insertOne({ _id: openJ.openId, userId: openJ.userId, result: openJ, status: 'pending', attempts: 0, createdAt: new Date() });

	// One malformed pending journal (cast) and one (box opening), older than every valid journal.
	const old = new Date(Date.now() - 3600_000);
	await legacy('stg-malformed', { xp: 1600, level: 4, publicXp: 1600 });
	await useTestRod('stg-malformed', { capabilities: ['weak', '1'] });
	await Cast.collection.insertOne({ _id: 'bad-cast-stg-malformed', userId: 'stg-malformed', status: 'pending', createdAt: old, result: { castId: 'bad-cast-stg-malformed', userId: 'stg-malformed', status: 'ok', writes: null, rod: { id: 'not-an-object-id' } } });
	await GachaOpen.collection.insertOne({ _id: 'bad-open-stg-malformed', userId: 'stg-malformed', status: 'pending', createdAt: old, result: { openId: 'bad-open-stg-malformed', userId: 'stg-malformed', status: 'ok', box: { id: 'nope' }, writes: {} } });
	await legacy('stg-other', { xp: 3600, level: 6, publicXp: 3600 });
	await useTestRod('stg-other', { capabilities: ['weak', '1'] });

	const users = async () => Object.fromEntries((await UserModel.collection.find({}).toArray()).map((u) => [u.userId, u]));
	const s0 = await users();

	// ---------- Pass 1 and pass 2: the real startup path ----------
	const t1 = Date.now();
	await bootstrap();
	const pass1Ms = Date.now() - t1;
	const s1 = await users();
	const c1 = await captureAll();
	const t2 = Date.now();
	await bootstrap();
	const pass2Ms = Date.now() - t2;
	const s2 = await users();
	const c2 = await captureAll();
	check('boot.pass1-completed', true, { ms: pass1Ms });
	check('boot.pass2-completed', true, { ms: pass2Ms });

	// Pass two may only touch boot bookkeeping, never player data: the retry counter of a journal that
	// stays pending (by design, every boot retries it) and seasons.updatedAt (the active-season step
	// re-stamps it on every boot, as production does today). Anything else fails.
	const changes = diffCaptures(c1, c2);
	const pendingIds = new Set([...(await Cast.collection.find({ status: 'pending' }).toArray()), ...(await GachaOpen.collection.find({ status: 'pending' }).toArray())].map((j) => EJSON.stringify(j._id)));
	const within = (fields, allowed) => fields.length > 0 && fields.every((f) => allowed.includes(f));
	const bookkeeping = (c) => c.change === 'modified' && (
		(c.collection === 'seasons' && within(c.fields, ['updatedAt']))
		|| (['casts', 'gachaopens'].includes(c.collection) && pendingIds.has(c.id) && within(c.fields, ['updatedAt', 'attempts', 'lastError'])));
	const unexpected = changes.filter((c) => !bookkeeping(c));
	check('idempotent.pass2-no-player-or-progression-change', unexpected.length === 0, {
		collections: Object.keys(c1).length,
		documents: Object.values(c1).reduce((a, c) => a + Object.keys(c).length, 0),
		playerCollectionsIdentical: ['users', 'itemdatas', 'fishdatas', 'questdatas', 'buffs', 'pets', 'habitats', 'devaudits', 'migrations'].filter((n) => c1[n]).every((n) => JSON.stringify(c1[n]) === JSON.stringify(c2[n])),
		unexpected: unexpected.slice(0, 50),
		allowedBookkeeping: changes.filter(bookkeeping),
	});
	const markers = await mongoose.connection.db.collection('migrations').find({}).toArray();
	check('idempotent.reconcile-marker-once', markers.length === 1 && markers[0]._id === 'publicXpReconcile-v1', { markers: markers.map((m) => ({ id: m._id, result: { scanned: m.result?.scanned, members: m.result?.members, membersChanged: m.result?.membersChanged, recomputed: m.result?.recomputed } })) });

	// ---------- publicXp and floors ----------
	for (const [id, e] of Object.entries(expected)) {
		const u = s1[id];
		check(`publicXp.${id}`, u.publicXp === e.publicXp, { expected: e.publicXp, actual: u.publicXp, xp: u.xp, before: s0[id].publicXp ?? null });
		const anchorReal = Math.max(Number.isFinite(s0[id].level) ? s0[id].level : 0, todays(s0[id].xp || 0));
		const anchorPublic = publicXpOf(u) >= (u.xp || 0) ? anchorReal : todays(publicXpOf(u));
		check(`floors.${id}`, u.levelFloor === e.levelFloor && u.publicLevelFloor === e.publicLevelFloor && u.levelFloor === anchorReal && u.publicLevelFloor === anchorPublic,
			{ expected: [e.levelFloor, e.publicLevelFloor], rule: [anchorReal, anchorPublic], actual: [u.levelFloor, u.publicLevelFloor], storedLevel: s0[id].level ?? null, xp: u.xp, publicXp: u.publicXp });
	}
	const pubCheck = await checkPublicXp({ UserModel, founders: config.users.founders });
	check('publicXp.members-equal-xp', pubCheck.mismatched === 0, pubCheck);

	// ---------- No stored level goes down ----------
	const lowered = [];
	for (const [id, before] of Object.entries(s0)) {
		for (const [pass, s] of [['pass1', s1], ['pass2', s2]]) {
			const u = s[id];
			const was = Number.isFinite(before.level) ? before.level : 0;
			if ((u.level ?? 0) < was || levels.levelOf(u) < was) lowered.push({ id, pass, before: was, stored: u.level, effective: levels.levelOf(u) });
		}
	}
	check('levels.none-lowered', lowered.length === 0, { accounts: Object.keys(s0).length, lowered });

	// ---------- Journals ----------
	const castDoc = await Cast.collection.findOne({ _id: castJ.castId });
	const jb = s0[castJ.userId];
	const ja = s1[castJ.userId];
	check('journals.cast-3.2.0-replayed', castDoc.status === 'applied'
		&& ja.xp - jb.xp === castJ.xp.total && ja.publicXp - jb.publicXp === castJ.rewards.xp.base
		&& ja.inventory.money - jb.inventory.money === castJ.cash.total
		&& ja.levelFloor === Math.max(1, castJ.level.after) && ja.publicLevelFloor === Math.max(1, castJ.level.public.after),
	{ status: castDoc.status, xp: [jb.xp, ja.xp, castJ.xp.total], publicXp: [jb.publicXp, ja.publicXp, castJ.rewards.xp.base], money: [jb.inventory.money, ja.inventory.money, castJ.cash.total], floors: [ja.levelFloor, ja.publicLevelFloor] });
	const hb = s0[highJ.userId];
	const ha = s1[highJ.userId];
	check('journals.cast-3.2.0-keeps-higher-stored-level', (await Cast.collection.findOne({ _id: highJ.castId })).status === 'applied'
		&& ha.level === 9 && ha.levelFloor === 9 && ha.xp - hb.xp === highJ.xp.total, { journalLevel: highJ.level.after, stored: [hb.level, ha.level], floor: ha.levelFloor });
	const openDoc = await GachaOpen.collection.findOne({ _id: openJ.openId });
	check('journals.open-3.2.0-replayed', openDoc.status === 'applied' && s1[openJ.userId].stats.gachaBoxesOpened === 1 && (await ItemData.collection.findOne({ _id: new mongoose.Types.ObjectId(openJ.box.id) })).count === 1,
		{ status: openDoc.status, boxesOpened: s1[openJ.userId].stats.gachaBoxesOpened });
	const badCast = await Cast.collection.findOne({ _id: 'bad-cast-stg-malformed' });
	const badOpen = await GachaOpen.collection.findOne({ _id: 'bad-open-stg-malformed' });
	check('journals.malformed-stays-pending', badCast.status === 'pending' && Boolean(badCast.lastError) && badOpen.status === 'pending' && Boolean(badOpen.lastError),
		{ cast: { status: badCast.status, lastError: badCast.lastError }, open: { status: badOpen.status, lastError: badOpen.lastError } });
	check('journals.nothing-else-pending', await Cast.countDocuments({ status: 'pending' }) === 1 && await GachaOpen.countDocuments({ status: 'pending' }) === 1);

	// ---------- After boot: players are not blocked; today's rewards ----------
	const played = {};
	for (const id of ['stg-other', 'stg-malformed', 'stg-member-highlevel']) {
		if (id === 'stg-member-highlevel') await useTestRod(id, { capabilities: ['weak', '1'] });
		const before = await UserModel.collection.findOne({ userId: id });
		const r = await castLine({ userId: id });
		await applyCastResult(r);
		const after = await UserModel.collection.findOne({ userId: id });
		played[id] = {
			status: r.status, balanceVersion: r.balanceVersion, xp: r.xp.total, levelAfter: r.level.after,
			ok: r.status === 'ok' && r.balanceVersion === '3.2.0' && after.xp - before.xp === r.xp.total
				&& r.level.after === Math.max(before.levelFloor, todays(before.xp + r.xp.total))
				&& after.level >= before.level && after.levelFloor >= before.levelFloor,
		};
	}
	check('play.not-blocked-and-today-rules', Object.values(played).every((p) => p.ok), { played });
	check('journals.malformed-still-pending-after-play', (await Cast.collection.findOne({ _id: 'bad-cast-stg-malformed' })).status === 'pending');

	const accounts = Object.fromEntries(Object.keys(s0).sort().map((id) => [id, {
		before: { xp: s0[id].xp, publicXp: s0[id].publicXp ?? null, level: s0[id].level ?? null },
		pass1: { xp: s1[id].xp, publicXp: s1[id].publicXp, level: s1[id].level, levelFloor: s1[id].levelFloor, publicLevelFloor: s1[id].publicLevelFloor },
		pass2Same: JSON.stringify(s1[id]) === JSON.stringify(s2[id]),
	}]));
	const failed = checks.filter((c) => !c.pass);
	const report = { rehearsal: 'phase5b-stepA', env, passed: checks.length - failed.length, failed: failed.length, checks, accounts };
	console.log('REPORT-BEGIN');
	console.log(JSON.stringify(report, null, 2));
	console.log('REPORT-END');
	console.log(`STEP A REHEARSAL: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${checks.length - failed.length}/${checks.length} checks)`);
	await mongoose.disconnect();
	process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch(async (error) => {
	console.error(`STEP A REHEARSAL: ERROR ${error?.stack || error}`);
	await mongoose.disconnect().catch(() => undefined);
	process.exitCode = 1;
});
