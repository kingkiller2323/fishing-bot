// Phase 5B step D: the full integrated 5B rehearsal for DCC Fishing Staging. NEVER runs against production.
//
// Builds today's production state (the real startup path with BALANCE_5B off; the pseudonymized production
// accounts when SNAPSHOT_DB is set, plus synthetic accounts covering every migration case and 3.2.0 journals
// pending at the flip), then:
//   1. flips the flag on and runs the real startup path twice: validation (validate5b), the flag-on
//      migrations, journal recovery; pass two changes nothing; the flip itself is additive only;
//   2. checks the catalog (hidden rows visible only under the flag, Mountain Stream grid, 5B boxes);
//   3. measures the engine against the model (fish, value, XP, durability per cast and the cooldown, per rod);
//   4. proves the Founder's public casts are a normal player's (same seed -> same public result; independent
//      samples -> the same rarity distribution) and that private rolls never reach public state;
//   5. checks the standard rod ladder, the permits and the L6B gates;
//   6. plays scripted Casual / Regular / Active / Grinder sessions (the model's own purchase plan) and compares
//      their XP and level with the integrated model day by day;
//   7. rehearses the rollback: flag off (with players in 5B-only states and a 5B journal pending), the
//      flag-off startup path changes nothing, today's game is served, then flag on again changes nothing.
// Prints a JSON report between REPORT-BEGIN / REPORT-END and exits 1 if any check fails.
//
// Guards: STAGING_REHEARSAL=1; the database is a Railway private host or localhost (never Atlas); no Discord
// token; BALANCE_5B must be off at start (the rehearsal flips it in-process exactly as the restart would).
// The rehearsal database (STAGING_DB_D, default fishing_stepd_rehearsal) is dropped and rebuilt on every run.
const FIXTURE_FOUNDERS = ['stgd-founder'];
// The fixture Founder joins FOUNDER_IDS for this staging process only (before config loads).
process.env.FOUNDER_IDS = [...new Set([...String(process.env.FOUNDER_IDS || '').split(',').map((x) => x.trim()).filter(Boolean), ...FIXTURE_FOUNDERS])].join(',');

const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const { EJSON } = mongoose.mongo.BSON;
const ROOT = path.join(__dirname, '..', '..');
const DB_NAME = process.env.STAGING_DB_D || 'fishing_stepd_rehearsal';
const PARITY_CASTS = Number(process.env.STEPD_PARITY_CASTS) || 2000;
const FOUNDER_SEEDS = Number(process.env.STEPD_FOUNDER_SEEDS) || 150;
const FOUNDER_SAMPLE = Number(process.env.STEPD_FOUNDER_SAMPLE) || 1200;
const ARCHETYPE_DAYS = { casual: 3, regular: 2, active: 1, grinder: 1 };
const DAY = 24 * 3600e3;

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
	if (/^(1|true|on|yes)$/i.test(String(process.env.BALANCE_5B || ''))) problems.push('BALANCE_5B is on: the rehearsal starts from today\'s game and flips the flag itself');
	if (problems.length > 0) throw new Error(`Refusing to run: ${problems.join('; ')}.`);
}

const checks = [];
function check(name, pass, detail = {}) {
	checks.push({ name, pass: Boolean(pass), ...detail });
	if (!pass) console.log(`[STEP D] FAIL ${name} ${JSON.stringify(detail).slice(0, 4000)}`);
	return pass;
}
const progress = (msg) => console.log(`[STEP D] ${msg}`);

/** Every document of every collection, as canonical EJSON keyed by _id. */
async function captureAll() {
	const out = {};
	for (const { name } of await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray()) {
		const docs = await mongoose.connection.db.collection(name).find({}).sort({ _id: 1 }).toArray();
		out[name] = Object.fromEntries(docs.map((d) => [EJSON.stringify(d._id), EJSON.stringify(d, { relaxed: false })]));
	}
	return out;
}

/** Document and top-level field differences between two captures. */
function diffCaptures(a, b) {
	const changes = [];
	for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
		const x = a[name] || {};
		const y = b[name] || {};
		for (const id of new Set([...Object.keys(x), ...Object.keys(y)])) {
			if (x[id] === y[id]) continue;
			const fields = [];
			const removedFields = [];
			if (x[id] && y[id]) {
				const dx = EJSON.parse(x[id], { relaxed: false });
				const dy = EJSON.parse(y[id], { relaxed: false });
				for (const k of new Set([...Object.keys(dx), ...Object.keys(dy)])) {
					if (EJSON.stringify(dx[k] ?? null) !== EJSON.stringify(dy[k] ?? null)) fields.push(k);
					if (k in dx && !(k in dy)) removedFields.push(k);
				}
			}
			changes.push({ collection: name, id, change: !x[id] ? 'added' : !y[id] ? 'removed' : 'modified', fields, removedFields });
		}
	}
	return changes;
}

const summarize = (changes) => {
	const out = {};
	for (const c of changes) {
		const k = `${c.collection}:${c.change}`;
		out[k] = out[k] || { count: 0, fields: {} };
		out[k].count++;
		for (const f of c.fields) out[k].fields[f] = (out[k].fields[f] || 0) + 1;
	}
	return out;
};

/** Pearson chi-square of two count vectors over the same categories (categories empty in both dropped). */
function chiSquare2(a, b, keys) {
	const na = keys.reduce((s, k) => s + (a[k] || 0), 0);
	const nb = keys.reduce((s, k) => s + (b[k] || 0), 0);
	let chi = 0;
	let df = -1;
	for (const k of keys) {
		const t = (a[k] || 0) + (b[k] || 0);
		if (t === 0) continue;
		df++;
		const ea = (t * na) / (na + nb);
		const eb = (t * nb) / (na + nb);
		chi += ((a[k] || 0) - ea) ** 2 / ea + ((b[k] || 0) - eb) ** 2 / eb;
	}
	return { chi: +chi.toFixed(3), df };
}
// Chi-square critical values at p = 0.001.
const CHI_001 = [0, 10.83, 13.82, 16.27, 18.47, 20.52, 22.46, 24.32];

async function main() {
	guard();
	const uri = process.env.MONGODB_URI;
	await mongoose.connect(uri, { dbName: DB_NAME, serverSelectionTimeoutMS: 60000 });
	if (mongoose.connection.db.databaseName !== DB_NAME) throw new Error('connected to an unexpected database');
	await mongoose.connection.db.dropDatabase();

	// The exact production accounts (pseudonymized copy written by export-snapshot.js), when present.
	let snapshot = null;
	if (process.env.SNAPSHOT_DB) {
		const sdb = mongoose.connection.client.db(process.env.SNAPSHOT_DB);
		const manifest = await sdb.collection('snapshot_manifest').findOne({ _id: 'manifest' });
		if (!manifest) throw new Error(`SNAPSHOT_DB ${process.env.SNAPSHOT_DB} has no manifest`);
		snapshot = { db: sdb, manifest };
		const founders = String(process.env.FOUNDER_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
		process.env.FOUNDER_IDS = [...new Set([...founders, ...manifest.founders])].join(',');
	}

	const config = require('../../src/config');
	const balance = require('../../src/engine/balance');
	const levels = require('../../src/engine/levels');
	const { bootstrap } = require('../../src/bootstrap');
	const { castLine, applyCastResult } = require('../../src/engine/cast');
	const { openLine, applyGachaResult } = require('../../src/engine/gacha');
	const { visibleCatalog } = require('../../src/engine/b5/catalog');
	const world5b = require('../../src/engine/b5/world');
	const rodOps = require('../../src/engine/b5/rodOps');
	const permitOps = require('../../src/engine/b5/permitOps');
	const upgrades5b = require('../../src/engine/b5/upgrades');
	const q5 = require('../../src/engine/b5/quests');
	const { validate5b } = require('../../src/engine/b5/validate');
	const { gateLevelOf } = require('../../src/engine/levelGate');
	const { rng } = require('../../src/engine/rng');
	const { User: UserModel } = require('../../src/schemas/UserSchema');
	const { Cast } = require('../../src/schemas/CastSchema');
	const { GachaOpen } = require('../../src/schemas/GachaOpenSchema');
	const { DevAudit } = require('../../src/schemas/DevAuditSchema');
	const { Item, ItemData } = require('../../src/schemas/ItemSchema');
	const { Fish, FishData } = require('../../src/schemas/FishSchema');
	const { Biome } = require('../../src/schemas/BiomeSchema');
	const { QuestData } = require('../../src/schemas/QuestSchema');
	const { Habitat } = require('../../src/schemas/HabitatSchema');
	const { Fish: FishClass } = require('../../src/class/Fish');
	const { withUserLock } = require('../../src/engine/userLock');
	const { makeUser } = require('../../test/helpers/fixtures');
	const { giveBox } = require('../../test/helpers/gachaFixtures');
	const { runParity } = require('./lib/parity5b');
	const modelWorld = require('../economy/5b/world');
	const modelRods = require('../economy/5b/rods');
	const integrate = require('../economy/5b/integrate');
	const A = require('../economy/5b/assumptions');

	const flag = (on) => {
		config.flags.balance5b = on;
	};
	const users = async () => Object.fromEntries((await UserModel.collection.find({}).toArray()).map((u) => [u.userId, u]));
	const atLevel = async (userId, level, extra = {}) => {
		const xp = (balance.isBalance5b() ? levels.CURVES['5b'] : levels.activeCurve()).xpForLevel(level);
		await UserModel.updateOne({ userId }, { $set: { xp, publicXp: xp, level, levelFloor: level, publicLevelFloor: level, ...extra } });
	};
	const env = {
		database: DB_NAME, node: process.version, mongoVersion: (await mongoose.connection.db.admin().command({ buildInfo: 1 })).version,
		balance5bEnv: process.env.BALANCE_5B ?? null, founders: config.users.founders, parityCasts: PARITY_CASTS,
		data: { balanceVersion: balance.seedData5b().balanceVersion, frameworkVersion: balance.seedData5b().frameworkVersion, contentHash: balance.seedData5b().contentHash },
	};
	for (const f of FIXTURE_FOUNDERS) if (!config.users.founders.includes(f)) throw new Error(`FOUNDER_IDS must include ${f}`);

	// =========================================================================================
	// 0. Today's production state (flag off).
	// =========================================================================================
	flag(false);
	check('today.flag-off', balance.isBalance5b() === false && levels.activeCurve().name === 'current');
	if (snapshot) {
		for (const name of Object.keys(snapshot.manifest.counts)) {
			const docs = await snapshot.db.collection(name).find({}).toArray();
			if (docs.length > 0) await mongoose.connection.db.collection(name).insertMany(docs);
		}
	}
	await bootstrap();
	const hidden = await Item.collection.countDocuments({ release: '5b' }) + await Fish.collection.countDocuments({ release: '5b' }) + await Biome.collection.countDocuments({ release: '5b' });
	check('today.hidden-rows-seeded-and-invisible', hidden > 0
		&& await Biome.countDocuments(visibleCatalog()) === await Biome.countDocuments({ release: { $exists: false } })
		&& !(await Biome.find(visibleCatalog()).lean()).some((b) => b.name === 'Mountain Stream'), { hiddenRows: hidden });

	// Synthetic accounts in today's shapes: one per migration case.
	const legacyAccount = async (userId, level, fields = {}) => {
		await makeUser(userId);
		const xp = levels.activeCurve().xpForLevel(level);
		await UserModel.collection.updateOne({ userId }, { $set: { xp, publicXp: xp, level, levelFloor: level, publicLevelFloor: level, ...fields }, $unset: { permits: '' } });
	};
	await legacyAccount('stgd-new', 1);
	await legacyAccount('stgd-mid', 25, { currentBiome: 'lake', 'inventory.money': 50000 });
	await legacyAccount('stgd-high', 55, { currentBiome: 'swamp', 'inventory.money': 400000 });
	// Founder: real level 60, public level 12, fishing the Coast: the flip moves it to its gate's highest legal biome.
	await legacyAccount('stgd-founder', 60, { currentBiome: 'coast' });
	await UserModel.collection.updateOne({ userId: 'stgd-founder' }, { $set: { publicXp: levels.activeCurve().xpForLevel(12), publicLevelFloor: 12 } });
	// Owned Fishing Crates (P-RODS-FISHING-CRATE option b).
	await giveBox('stgd-mid', 'Fishing Crate', 3);
	// A destroyed legacy crafted rod (counts as broken, repairable under 5B).
	const highRod = new mongoose.Types.ObjectId();
	await ItemData.collection.insertOne({ _id: highRod, __t: 'CustomRodData', user: 'stgd-high', name: 'Legacy Custom Rod', type: 'customrod', capabilities: ['weak', 'strong', '6', '5 count', '10000 durability'], durability: 0, maxDurability: 10000, repairs: 3, maxRepairs: 3, repairCost: 50000, state: 'destroyed', requirements: { level: 50 } });
	await UserModel.collection.updateOne({ userId: 'stgd-high' }, { $push: { 'inventory.rods': highRod }, $set: { 'inventory.equippedRod': highRod } });
	// Legacy quest completions (backfilled into questLog).
	const legacyTitles = Object.keys(balance.seedData5b().quests.legacyMap).slice(0, 3);
	for (const [i, title] of legacyTitles.entries()) {
		await QuestData.collection.insertOne({ title, user: 'stgd-mid', status: 'completed', progress: 1, progressMax: 1, endDate: new Date(Date.UTC(2026, 7, 1 + i)), type: 'quest' });
	}
	// Legacy aquarium tanks (grandfathered).
	for (let i = 0; i < 3; i++) await Habitat.create({ name: `legacy${i}`, owner: 'stgd-high', waterType: 'Freshwater', size: 1 });

	// 3.2.0 journals still pending at the flip (captured from the pre-5B code).
	const fixture = (name) => EJSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', name), 'utf8'), { relaxed: true });
	const moveItemTo = async (userId, fromId, toId, listField) => {
		const doc = await ItemData.collection.findOne({ _id: fromId });
		await ItemData.collection.insertOne({ ...doc, _id: toId });
		await ItemData.collection.deleteOne({ _id: fromId });
		await UserModel.collection.updateOne({ userId }, { $pull: { [listField]: fromId } });
		await UserModel.collection.updateOne({ userId }, { $push: { [listField]: toId } });
	};
	const castJ = fixture('cast-journal-3.2.0.json');
	await legacyAccount(castJ.userId, 1, { xp: 350, publicXp: 350 });
	const jRod = (await UserModel.collection.findOne({ userId: castJ.userId })).inventory.equippedRod;
	await ItemData.collection.updateOne({ _id: jRod }, { $set: { capabilities: ['weak', '1'] } });
	await moveItemTo(castJ.userId, jRod, new mongoose.Types.ObjectId(castJ.rod.id), 'inventory.rods');
	await UserModel.collection.updateOne({ userId: castJ.userId }, { $set: { 'inventory.equippedRod': new mongoose.Types.ObjectId(castJ.rod.id) } });
	await Cast.collection.insertOne({ _id: castJ.castId, userId: castJ.userId, guildId: null, result: castJ, status: 'pending', attempts: 0, createdAt: new Date() });
	const openJ = fixture('gacha-journal-3.2.0.json');
	openJ.userId = 'stgd-journal-gacha';
	openJ.writes.fishDocs = openJ.writes.fishDocs.map((d) => ({ ...d, user: openJ.userId }));
	await legacyAccount(openJ.userId, 5);
	await giveBox(openJ.userId, 'Voter\'s Crate', 2);
	const crate = await ItemData.collection.findOne({ user: openJ.userId, name: 'Voter\'s Crate' });
	await moveItemTo(openJ.userId, crate._id, new mongoose.Types.ObjectId(openJ.box.id), 'inventory.gacha');
	await GachaOpen.collection.insertOne({ _id: openJ.openId, userId: openJ.userId, result: openJ, status: 'pending', attempts: 0, createdAt: new Date() });

	const s0 = await users();
	const c0 = await captureAll();

	// =========================================================================================
	// 1. The flip: flag on, the real startup path twice.
	// =========================================================================================
	flag(true);
	check('flip.flag-on', balance.isBalance5b() === true && levels.activeCurve().name === '5b');
	let t = Date.now();
	await bootstrap();
	const pass1Ms = Date.now() - t;
	const s1 = await users();
	const c1 = await captureAll();
	t = Date.now();
	await bootstrap();
	const pass2Ms = Date.now() - t;
	const c2 = await captureAll();
	check('flip.boot-pass1-validation-passed', true, { ms: pass1Ms });
	check('flip.boot-pass2-validation-passed', true, { ms: pass2Ms });
	check('flip.validate5b-clean', (await validate5b()).length === 0);

	// Pass two: only boot bookkeeping (seasons.updatedAt re-stamped every boot, as production does).
	const bookkeeping = (c) => c.change === 'modified' && c.collection === 'seasons' && c.fields.every((f) => f === 'updatedAt');
	const pass2 = diffCaptures(c1, c2).filter((c) => !bookkeeping(c));
	check('flip.pass2-changes-nothing', pass2.length === 0, { unexpected: pass2.slice(0, 30) });

	// The flip is additive: no document removed, no field removed; player documents change only in the fields
	// the migrations add (plus the replay of the pending journals on their own accounts).
	const flipChanges = diffCaptures(c0, c1).filter((c) => !bookkeeping(c));
	const journalUsers = new Set([castJ.userId, openJ.userId]);
	const userDocIds = Object.fromEntries(Object.values(s0).map((u) => [EJSON.stringify(u._id), u.userId]));
	const allowedUserFields = (userId) => (journalUsers.has(userId) ? null : ['permits', 'questLog', ...(config.users.founders.includes(userId) ? ['currentBiome'] : [])]);
	const flipViolations = flipChanges.filter((c) => {
		if (c.change === 'removed' || c.removedFields.length) return true;
		if (c.collection === 'users' && c.change === 'modified') {
			const allowed = allowedUserFields(userDocIds[c.id]);
			return allowed !== null && !c.fields.every((f) => allowed.includes(f));
		}
		if (c.collection === 'itemdatas' && c.change === 'modified') {
			// The journal replays write their own accounts' items (rod durability, the opened box's count).
			if (journalUsers.has(EJSON.parse(c1.itemdatas[c.id], { relaxed: false }).user)) return false;
			return !c.fields.every((f) => f === 'legacyCount');
		}
		if (c.collection === 'buffs' && c.change === 'modified') return !c.fields.every((f) => f === 'active');
		return false;
	});
	check('flip.additive-only', flipViolations.length === 0, { summary: summarize(flipChanges), violations: flipViolations.slice(0, 30) });

	const markers = (await mongoose.connection.db.collection('migrations').find({}).toArray()).map((m) => m._id);
	check('flip.migration-markers-once', ['5b-legacy-fishing-crates', '5b-quest-log'].every((m) => markers.filter((x) => x === m).length === 1), { markers });

	// Permits: every account without the field got the model's grandfathered permits; nothing else changed.
	const permitMismatch = [];
	for (const [id, before] of Object.entries(s0)) {
		const after = s1[id];
		if ('permits' in before) {
			if (EJSON.stringify(before.permits) !== EJSON.stringify(after.permits)) permitMismatch.push({ id, reason: 'had the field; changed' });
			continue;
		}
		const expected = modelWorld.grandfatheredPermits({ level: before.level, xp: before.xp, currentBiome: before.currentBiome }, { legacyLevelForXp: balance.levelForXp }).map((p) => p.biome ?? p).sort();
		const actual = (after.permits || []).map((p) => p.biome ?? p).sort();
		if (JSON.stringify(expected) !== JSON.stringify(actual)) permitMismatch.push({ id, expected, actual });
	}
	check('migrate.permits-equal-model', permitMismatch.length === 0, { accounts: Object.keys(s0).length, mismatches: permitMismatch.slice(0, 20), examples: { mid: s1['stgd-mid'].permits?.map((p) => p.biome), high: s1['stgd-high'].permits?.map((p) => p.biome) } });
	const crates = await ItemData.collection.find({ name: 'Fishing Crate', user: { $ne: null } }).toArray();
	check('migrate.fishing-crates-snapshot', crates.length > 0 && crates.every((c) => c.legacyCount === c.count), { stacks: crates.map((c) => [c.count, c.legacyCount]) });
	const midLog = s1['stgd-mid'].questLog || {};
	const logKey = (title) => balance.seedData5b().quests.legacyMap[title].replace(/\./g, ':');
	check('migrate.quest-log-backfilled', legacyTitles.every((title) => midLog[logKey(title)]?.completions === 1), { questLog: midLog, titles: legacyTitles });
	const f1 = s1['stgd-founder'];
	const founderAudits = await DevAudit.collection.find({ target: 'stgd-founder', operation: '5b-founder-biome' }).toArray();
	check('migrate.founder-biome-moved-audited-once', world5b.canFish(gateLevelOf(f1), f1.permits, f1.currentBiome) && f1.currentBiome !== 'coast' && founderAudits.length === 1, { from: 'coast', to: f1.currentBiome, gateLevel: gateLevelOf(f1), audits: founderAudits.length });
	check('migrate.legacy-tanks-kept', await Habitat.countDocuments({ owner: 'stgd-high' }) === 3);

	// Journals pending at the flip replay exactly as written (3.2.0; never rescaled).
	const castDoc = await Cast.collection.findOne({ _id: castJ.castId });
	const jb = s0[castJ.userId];
	const ja = s1[castJ.userId];
	const replayedFish = await FishData.collection.find({ castId: castJ.castId }).toArray();
	check('journals.cast-3.2.0-replayed-unscaled', castDoc.status === 'applied' && ja.xp - jb.xp === castJ.xp.total && ja.inventory.money - jb.inventory.money === castJ.cash.total
		&& replayedFish.length === castJ.writes.fishDocs.length && replayedFish.every((d) => castJ.writes.fishDocs.some((w) => w.value === d.value)),
	{ status: castDoc.status, xp: [jb.xp, ja.xp, castJ.xp.total], fish: replayedFish.map((d) => d.value) });
	const openDoc = await GachaOpen.collection.findOne({ _id: openJ.openId });
	check('journals.open-3.2.0-replayed', openDoc.status === 'applied' && s1[openJ.userId].stats.gachaBoxesOpened === 1, { status: openDoc.status });
	check('journals.none-pending', await Cast.countDocuments({ status: 'pending' }) === 0 && await GachaOpen.countDocuments({ status: 'pending' }) === 0);

	// =========================================================================================
	// 2. Catalog.
	// =========================================================================================
	const visibleBiomes = (await Biome.find(visibleCatalog()).lean()).map((b) => b.name);
	const ms = await Fish.find({ biome: 'Mountain Stream', user: null }).lean();
	const msNew = ms.filter((f) => f.release === '5b');
	const legacySalmon = ms.filter((f) => !f.release).map((f) => f.name).sort();
	const boxes = ['Streak Crate', 'Streak Chest', ...balance.seedData5b().rods.crates.map((c) => c.name)];
	const missingBoxes = [];
	for (const b of boxes) if (!await Item.exists({ name: b, user: null })) missingBoxes.push(b);
	check('catalog.flag-on-visible', visibleBiomes.includes('Mountain Stream') && visibleBiomes.length === balance.seedData5b().world.biomeOrder.length, { visibleBiomes });
	check('catalog.mountain-stream', msNew.length === balance.seedData5b().world.mountainStream.species.filter((x) => !x.existing).length && JSON.stringify(legacySalmon) === JSON.stringify(['Flashfin Salmon', 'Shrouded Salmon', 'Zephyr Salmon']), { added: msNew.length, legacySalmon });
	check('catalog.5b-boxes-and-rods', missingBoxes.length === 0 && balance.seedData5b().rods.standard.every((r) => r.name), { missingBoxes });
	const ladder = modelRods.standardRods();
	check('catalog.standard-rods-equal-model', balance.seedData5b().rods.standard.every((r, i) => r.name === ladder[i].name && r.price === ladder[i].price && r.unlockLevel === ladder[i].level && r.maxDurability === ladder[i].maxDurability),
		{ rods: balance.seedData5b().rods.standard.map((r) => [r.name, r.unlockLevel, r.price, r.maxDurability]) });

	// =========================================================================================
	// 3. Existing accounts play under 5B.
	// =========================================================================================
	const played = {};
	for (const id of ['stgd-new', 'stgd-mid', 'stgd-high', 'stgd-founder', castJ.userId, ...(snapshot?.manifest.accounts || []).map((a) => a.userId)]) {
		const before = await UserModel.collection.findOne({ userId: id });
		const r = await castLine({ userId: id });
		if (r.status === 'ok') await applyCastResult(r);
		const after = await UserModel.collection.findOne({ userId: id });
		played[id] = { status: r.status, code: r.failure?.code ?? null, balanceVersion: r.balanceVersion, biome: r.environment?.biome, levelBefore: levels.levelOf(before), levelAfter: levels.levelOf(after) };
		// A legacy destroyed rod is broken under 5B: the right answer is the broken-rod refusal (repair or Old Rod).
		played[id].ok = (r.status === 'ok' && r.balanceVersion === '5b') || (id === 'stgd-high' && r.failure?.code === 'ROD_BROKEN');
		played[id].ok = played[id].ok && levels.levelOf(after) >= levels.levelOf(before);
	}
	const repaired = await rodOps.repairRod('stgd-high', String(highRod));
	const afterRepair = await castLine({ userId: 'stgd-high' });
	if (afterRepair.status === 'ok') await applyCastResult(afterRepair);
	check('play.existing-accounts', Object.values(played).every((p) => p.ok) && repaired.ok && afterRepair.status === 'ok', { played, repair: { ok: repaired.ok, cost: repaired.cost, code: repaired.code }, afterRepair: afterRepair.status });
	const fcOpen = await openLine({ userId: 'stgd-mid', boxName: 'Fishing Crate' });
	if (fcOpen.status === 'ok') await applyGachaResult(fcOpen);
	const fcAfter = await ItemData.collection.findOne({ user: 'stgd-mid', name: 'Fishing Crate' });
	check('play.legacy-fishing-crate-opens-today-definition', fcOpen.status === 'ok' && fcAfter.count === 2 && fcAfter.legacyCount === 2, { status: fcOpen.status, code: fcOpen.failure?.code, after: [fcAfter.count, fcAfter.legacyCount] });

	// =========================================================================================
	// 4. Engine = model, per rod.
	// =========================================================================================
	progress(`parity: ${PARITY_CASTS} casts per configuration`);
	const parity = await runParity({ casts: PARITY_CASTS, onProgress: progress });
	for (const p of parity) check(`parity.${p.key}`, p.pass, { statuses: p.statuses, cooldown: p.cooldown, metrics: p.metrics });

	// =========================================================================================
	// 5. Founder: the public cast is a normal player's; private state stays private.
	// =========================================================================================
	const twin = async (id, level, { rod = null, biome = 'ocean' } = {}) => {
		if (!await UserModel.exists({ userId: id })) await makeUser(id);
		const permits = Object.keys(balance.seedData5b().permits.prices).map((b) => ({ biome: b, source: 'purchased', acquiredAt: new Date(0), pricePaid: 0 }));
		await atLevel(id, level, { permits, currentBiome: biome, 'inventory.money': 1e7 });
		if (rod) {
			const b = await rodOps.buyStandardRod(id, rod, { equip: true });
			if (!b.ok && b.code !== 'OWNED') throw new Error(`twin ${id}: ${b.code}`);
		}
	};
	const publicPart = (r) => ({
		status: r.status, catches: r.catches.map((c) => [c.name, c.rarity, c.count, c.size, c.weight, c.rawValue, c.reward?.base]), units: r.units,
		cooldownMs: r.cooldownMs, durabilityCost: r.rod.durabilityCost, xpBase: r.rewards.xp.base, public: r.level.public, draws: r.draws, rarity: r.rarity.table,
	});
	const founderStates = [{ level: 5, rod: null, biome: 'ocean' }, { level: 22, rod: 'Angler\'s Rod', biome: 'river' }];
	const seededDiffs = [];
	const fixedNow = new Date('2026-10-01T12:00:00Z');
	for (const [i, st] of founderStates.entries()) {
		const founderId = 'stgd-founder';
		await twin(`stgd-normal-${i}`, st.level, st);
		await twin(founderId, st.level, st);
		for (let seed = 1; seed <= FOUNDER_SEEDS; seed++) {
			rng.seed(seed * 7919 + i);
			const n = await castLine({ userId: `stgd-normal-${i}`, now: fixedNow });
			rng.seed(seed * 7919 + i);
			const f = await castLine({ userId: founderId, now: fixedNow });
			if (JSON.stringify(publicPart(n)) !== JSON.stringify(publicPart(f)) || f.competitiveEligible !== false || !f.private || n.private) seededDiffs.push({ state: i, seed });
		}
	}
	rng.reset();
	check('founder.seeded-public-identical', seededDiffs.length === 0, { states: founderStates.length, seedsPerState: FOUNDER_SEEDS, diffs: seededDiffs.slice(0, 10) });

	// Independent samples: rarity counts of the public catch, Founder vs Normal (same state).
	await twin('stgd-normal-dist', 22, { rod: 'Angler\'s Rod', biome: 'river' });
	await twin('stgd-founder', 22, { rod: 'Angler\'s Rod', biome: 'river' });
	const counts = { normal: {}, founder: {} };
	for (const [who, id] of [['normal', 'stgd-normal-dist'], ['founder', 'stgd-founder']]) {
		for (let k = 0; k < FOUNDER_SAMPLE; k++) {
			const r = await castLine({ userId: id, now: fixedNow });
			for (const c of r.catches) counts[who][c.rarity] = (counts[who][c.rarity] || 0) + (c.count || 1);
		}
	}
	const chi = chiSquare2(counts.normal, counts.founder, balance.RARITIES.map((r) => r.charAt(0).toUpperCase() + r.slice(1)));
	check('founder.public-distribution-equal', chi.chi <= (CHI_001[chi.df] ?? 30), { counts, ...chi, critical: CHI_001[chi.df] });

	// One applied Founder cast: public state gets only the public catch; private fish are never competitive.
	const fb = await UserModel.collection.findOne({ userId: 'stgd-founder' });
	const fr = await castLine({ userId: 'stgd-founder' });
	await applyCastResult(fr);
	const fa = await UserModel.collection.findOne({ userId: 'stgd-founder' });
	const privFish = await FishData.collection.find({ castId: fr.castId, private: true }).toArray();
	const pubIds = fr.catches.filter((c) => c.kind === 'fish').map((c) => c.id).sort();
	check('founder.private-never-public', fa.publicXp - fb.publicXp === fr.rewards.xp.base && fa.stats.latestFish.map(String).sort().join() === pubIds.join()
		&& privFish.every((d) => d.competitiveEligible === false) && (await FishData.collection.countDocuments({ private: true, competitiveEligible: { $ne: false } })) === 0,
	{ publicXpGain: fa.publicXp - fb.publicXp, base: fr.rewards.xp.base, privateFish: privFish.length });

	// =========================================================================================
	// 6. Rod ladder, permits and L6B gates.
	// =========================================================================================
	const gates = [];
	for (const r of balance.seedData5b().rods.standard) {
		const id = `stgd-gate-t${r.tier}`;
		await makeUser(id);
		await atLevel(id, r.unlockLevel - 1, { 'inventory.money': r.price * 2, permits: [] });
		const below = await rodOps.buyStandardRod(id, r.name, { equip: true });
		await atLevel(id, r.unlockLevel);
		const at = await rodOps.buyStandardRod(id, r.name, { equip: true });
		const again = await rodOps.buyStandardRod(id, r.name);
		const money = (await UserModel.collection.findOne({ userId: id })).inventory.money;
		const rod = at.ok ? await ItemData.collection.findOne({ _id: new mongoose.Types.ObjectId(at.rodId) }) : null;
		gates.push({ rod: r.name, below: below.code, at: at.ok, again: again.code, charged: r.price * 2 - money, durability: rod?.durability, ok: below.code === 'LEVEL_LOCKED' && at.ok && again.code === 'OWNED' && money === r.price && rod?.durability === r.maxDurability });
	}
	check('gates.standard-rods', gates.every((g) => g.ok), { gates });
	const permitGates = [];
	for (const [biome, price] of Object.entries(balance.seedData5b().permits.prices)) {
		const id = `stgd-permit-${biome.replace(/\s+/g, '').toLowerCase()}`;
		const lvl = balance.seedData5b().world.biomeLevel[biome];
		await makeUser(id);
		await atLevel(id, lvl - 1, { 'inventory.money': price, permits: [], currentBiome: biome.toLowerCase() });
		const locked = await castLine({ userId: id });
		const below = await permitOps.buyPermit(id, biome);
		await atLevel(id, lvl);
		const noPermit = await castLine({ userId: id });
		const bought = await permitOps.buyPermit(id, biome);
		const cast = await castLine({ userId: id });
		permitGates.push({ biome, locked: locked.failure?.code, below: below.code, noPermit: noPermit.failure?.code, bought: bought.ok, cast: cast.status, ok: locked.failure?.code === 'BIOME_LOCKED' && below.code === 'LEVEL_LOCKED' && noPermit.failure?.code === 'BIOME_LOCKED' && bought.ok && bought.price === price && cast.status === 'ok' });
	}
	check('gates.permits', permitGates.every((g) => g.ok), { permitGates });
	// L6B: the equip gate on a rod above the level; the equipped rod is grandfathered.
	await atLevel('stgd-gate-t3', 25);
	const t3 = gates.find((g) => g.rod === 'Pro Angler Rod');
	const owned = await rodOps.ownedRods(await UserModel.collection.findOne({ userId: 'stgd-gate-t3' }));
	const t3Rod = owned.find((r) => r.name === 'Pro Angler Rod');
	const oldRod = owned.find((r) => r.name === 'Old Rod');
	await rodOps.equipRod('stgd-gate-t3', String(oldRod._id));
	const reEquip = await rodOps.equipRod('stgd-gate-t3', String(t3Rod._id));
	check('gates.l6b-equip', t3 && reEquip.ok === false && /Lv 30|30/.test(reEquip.message || ''), { reEquip: { ok: reEquip.ok, code: reEquip.code, message: reEquip.message } });

	// =========================================================================================
	// 7. Scripted archetype sessions vs the integrated model.
	// =========================================================================================
	const archetypes = {};
	const t0 = Date.UTC(2026, 9, 5);
	for (const [name, days] of Object.entries(ARCHETYPE_DAYS)) {
		progress(`archetype ${name}: ${days} day(s)`);
		const model = integrate.run({ archetype: name, days, checkpoints: Array.from({ length: days }, (_, i) => i + 1), stopAtLevel: null });
		const arch = A.ARCHETYPES[name];
		const userId = `stgd-arch-${name}`;
		await makeUser(userId);
		const plan = model.purchases.map((p) => ({ ...p }));
		const done = [];
		const skipped = new Set();
		const failures = {};
		let casts = 0;
		let cash = 0;
		let fishingXp = 0;
		const timeline = [];
		const buy = async (p, now) => {
			const [kind, a, b] = p.id.split(':');
			if (kind === 'upgrade') return upgrades5b.buyUpgrade(userId, a);
			if (kind === 'rods') return rodOps.buyStandardRod(userId, balance.seedData5b().rods.standard.find((r) => `T${r.tier}` === a).name, { equip: true });
			if (kind === 'permit') return permitOps.buyPermit(userId, a, { now: new Date(now) });
			skipped.add(p.id.replace(/:\d+$/, ''));
			return { ok: true, skipped: true, b };
		};
		for (let d = 0; d < days; d++) {
			const start = t0 + d * DAY + 12 * 3600e3;
			let elapsed = 0;
			while (elapsed < arch.minutesPerDay * 60e3) {
				const now = start + elapsed;
				const playedH = (d * arch.minutesPerDay * 60e3 + elapsed) / 3600e3;
				let bought = false;
				for (const p of plan.filter((x) => !x.done && x.hours <= playedH)) {
					const r = await buy(p, now);
					if (r.ok) {
						p.done = true;
						bought = bought || !r.skipped;
						done.push({ id: p.id, modelHours: p.hours, engineHours: +playedH.toFixed(3) });
					}
				}
				if (bought) {
					const u = await UserModel.collection.findOne({ userId });
					await UserModel.collection.updateOne({ userId }, { $set: { currentBiome: world5b.highestAccessible(gateLevelOf(u), u.permits).toLowerCase() } });
				}
				if (casts % 25 === 0) {
					const active = await QuestData.collection.countDocuments({ user: userId, status: 'in_progress', kind: { $in: ['story', 'repeatable'] } });
					if (active === 0) {
						const can = (await q5.startable(userId, now)).filter((x) => x.check.ok);
						const pick = can.find((x) => x.t.kind === 'story') || can.find((x) => x.t.kind === 'repeatable');
						if (pick) await q5.startQuest(userId, pick.t.key, now);
					}
				}
				// The player sells its catch (as /sell all does) so the model's purchase plan can be paid for.
				if (casts % 10 === 0) await withUserLock(userId, () => FishClass.sellByRarity(userId, 'all'));
				const r = await castLine({ userId, now: new Date(now) });
				if (r.status === 'ok') {
					await applyCastResult(r);
					await q5.issueDaily(userId, now);
					casts++;
					fishingXp += r.xp.catch;
					cash += r.catches.filter((c) => c.kind === 'fish').reduce((s, c) => s + (c.value || 0) * (c.count || 1), 0);
					elapsed += r.cooldownMs + arch.overheadS * 1000;
				}
				else if (r.failure?.code === 'ROD_BROKEN') {
					const rep = await rodOps.repairRod(userId, r.rod?.id || String((await UserModel.collection.findOne({ userId })).inventory.equippedRod));
					if (!rep.ok) await rodOps.useOldRod(userId);
				}
				else {
					failures[r.failure?.code || 'unknown'] = (failures[r.failure?.code || 'unknown'] || 0) + 1;
					elapsed += 5000;
					if (Object.values(failures).reduce((a, x) => a + x, 0) > 50) break;
				}
			}
			const u = await UserModel.collection.findOne({ userId });
			timeline.push({ day: d + 1, level: levels.levelOf(u), xp: u.xp, money: u.inventory.money, biome: u.currentBiome });
		}
		const cmp = timeline.map((e) => {
			const m = model.timeline.find((x) => x.day === e.day) || {};
			return { day: e.day, engine: e, model: { level: m.level, xp: m.xp, money: m.money, biome: m.biome, tier: m.tier }, xpRatio: +(e.xp / m.xp).toFixed(3), levelDelta: e.level - m.level };
		});
		const modelCasts = model.final.castsTotal;
		archetypes[name] = {
			days, casts, modelCasts: Math.round(modelCasts), failures, skipped: [...skipped], purchases: done, cmp,
			perCast: { fishingXp: +(fishingXp / casts).toFixed(2), modelFishingXp: +(model.ledger.xp.fishing / modelCasts).toFixed(2), cash: +(cash / casts).toFixed(2), modelCash: +(model.ledger.cash.fishing / modelCasts).toFixed(2) },
		};
		// Quest rewards arrive in lumps (a story chapter lands on one day in the engine, the next in the model):
		// intermediate days within 35%, the last day within 15%, the level within 2 every day.
		const ok = Object.keys(failures).length === 0 && Math.abs(casts / modelCasts - 1) <= 0.1
			&& cmp.every((c, i) => Math.abs(c.xpRatio - 1) <= (i === cmp.length - 1 ? 0.15 : 0.35) && Math.abs(c.levelDelta) <= 2);
		check(`archetype.${name}`, ok, archetypes[name]);
	}

	// =========================================================================================
	// 8. Rollback: flag off, then on again.
	// =========================================================================================
	// Players in 5B-only states at the rollback: one fishing the Mountain Stream, one holding a 5B rod and a
	// Streak Crate, and one 5B cast journal still pending.
	await makeUser('stgd-rb-ms');
	await atLevel('stgd-rb-ms', 62, { 'inventory.money': 1e6, permits: [] });
	await permitOps.buyPermit('stgd-rb-ms', 'Mountain Stream');
	await UserModel.collection.updateOne({ userId: 'stgd-rb-ms' }, { $set: { currentBiome: 'mountain stream' } });
	const msCast = await castLine({ userId: 'stgd-rb-ms' });
	if (msCast.status === 'ok') await applyCastResult(msCast);
	await giveBox('stgd-arch-regular', 'Streak Crate', 1);
	const pending5b = await castLine({ userId: 'stgd-mid' });
	await Cast.collection.insertOne({ _id: pending5b.castId, userId: 'stgd-mid', guildId: null, result: pending5b, status: 'pending', attempts: 0, createdAt: new Date() });
	const midBefore = await UserModel.collection.findOne({ userId: 'stgd-mid' });
	const c3 = await captureAll();

	flag(false);
	check('rollback.flag-off', balance.isBalance5b() === false && levels.activeCurve().name === 'current');
	await bootstrap();
	const c4 = await captureAll();
	const pendingDoc = await Cast.collection.findOne({ _id: pending5b.castId });
	const midAfter = await UserModel.collection.findOne({ userId: 'stgd-mid' });
	check('rollback.pending-5b-journal-replayed', pendingDoc.status === 'applied' && midAfter.xp - midBefore.xp === pending5b.xp.total, { status: pendingDoc.status, xp: [midBefore.xp, midAfter.xp, pending5b.xp.total] });
	const rbChanges = diffCaptures(c3, c4).filter((c) => !bookkeeping(c));
	const rbViolations = rbChanges.filter((c) => c.change === 'removed' || c.removedFields.length > 0
		|| (c.collection === 'users' && userDocIds[c.id] !== undefined && userDocIds[c.id] !== 'stgd-mid'));
	check('rollback.boot-non-destructive', rbViolations.length === 0, { summary: summarize(rbChanges), violations: rbViolations.slice(0, 20) });
	check('rollback.catalog-hidden-again', !(await Biome.find(visibleCatalog()).lean()).some((b) => b.release === '5b'));

	const rb = {};
	for (const id of ['stgd-new', 'stgd-mid', 'stgd-high', 'stgd-arch-grinder', 'stgd-rb-ms', 'stgd-founder']) {
		const r = await castLine({ userId: id });
		if (r.status === 'ok') await applyCastResult(r);
		rb[id] = { status: r.status, code: r.failure?.code ?? null, balanceVersion: r.balanceVersion, biome: r.environment?.biome, release5bCatch: r.status === 'ok' ? (await Fish.collection.countDocuments({ _id: { $in: r.catches.filter((c) => c.templateId).map((c) => new mongoose.Types.ObjectId(c.templateId)) }, release: '5b' })) : 0 };
	}
	// A 5B box stays unopened (and owned) with the flag off; a player left in the Mountain Stream fishes the Ocean.
	const streakOpen = await openLine({ userId: 'stgd-arch-regular', boxName: 'Streak Crate' });
	const streakLeft = (await ItemData.collection.findOne({ user: 'stgd-arch-regular', name: 'Streak Crate' }))?.count;
	rb.streakCrate = { status: streakOpen.status, code: streakOpen.failure?.code ?? null, left: streakLeft };
	const rbOk = Object.entries(rb).filter(([k]) => k !== 'streakCrate').every(([, v]) => v.status === 'ok' && v.balanceVersion === balance.BALANCE_VERSION && v.release5bCatch === 0)
		&& rb['stgd-rb-ms'].biome === 'Ocean' && streakOpen.failure?.code === 'UNKNOWN_BOX' && streakLeft >= 1;
	check('rollback.today-game-served', rbOk, { casts: rb });

	flag(true);
	const c5a = await captureAll();
	await bootstrap();
	const c5 = await captureAll();
	const reflip = diffCaptures(c5a, c5).filter((c) => !bookkeeping(c));
	check('rollback.reflip-changes-nothing', reflip.length === 0, { unexpected: reflip.slice(0, 20) });
	const again = await castLine({ userId: 'stgd-rb-ms' });
	check('rollback.reflip-play', again.status === 'ok' && again.balanceVersion === '5b' && again.environment.biome === 'Mountain Stream', { status: again.status, code: again.failure?.code });
	flag(false);

	const failed = checks.filter((c) => !c.pass);
	env.snapshot = snapshot ? { exportedAt: snapshot.manifest.exportedAt, accounts: snapshot.manifest.accounts, counts: snapshot.manifest.counts } : null;
	const report = { rehearsal: 'phase5b-stepD', env, passed: checks.length - failed.length, failed: failed.length, failedNames: failed.map((c) => c.name), checks };
	console.log('REPORT-BEGIN');
	console.log(JSON.stringify(report, null, 2));
	console.log('REPORT-END');
	console.log(`STEP D REHEARSAL: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${checks.length - failed.length}/${checks.length} checks)`);
	await mongoose.disconnect();
	process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch(async (error) => {
	console.error(`STEP D REHEARSAL: ERROR ${error?.stack || error}`);
	await mongoose.disconnect().catch(() => undefined);
	process.exitCode = 1;
});
