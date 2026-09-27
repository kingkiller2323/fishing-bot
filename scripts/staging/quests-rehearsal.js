// Step B: quests rehearsal for DCC Fishing Staging. NEVER runs against production (same guards as the
// step A rehearsal). Builds production-shaped legacy quest documents on the staging MongoDB, runs the
// real startup path, then exercises Q1 (trout target correction), Q3 (/start-quest prerequisites),
// Q4 (/daily eligible pool) and Q5 (stale daily expiry). Prints a JSON report; exit 1 on any failure.
const mongoose = require('mongoose');

const DB_NAME = process.env.STAGING_QUESTS_DB || 'fishing_quests_rehearsal';
const DAY = 24 * 60 * 60 * 1000;
const OLD_TROUT = ['rainbow trout', 'golden trout'];

function guard() {
	const uri = process.env.MONGODB_URI || '';
	const problems = [];
	if (process.env.STAGING_REHEARSAL !== '1') problems.push('STAGING_REHEARSAL=1 is not set');
	if (/mongodb\+srv:|mongodb\.net/i.test(uri)) problems.push('MONGODB_URI points at Atlas (production); refusing');
	const hosts = (uri.match(/^mongodb:\/\/(?:[^@/]*@)?([^/?]+)/) || [])[1] || '';
	if (!hosts || !hosts.split(',').every((h) => /^(localhost|127\.0\.0\.1|[a-z0-9-]+\.railway\.internal)(:\d+)?$/i.test(h))) problems.push('MONGODB_URI host is not a Railway private host or localhost');
	if (process.env.CLIENT_TOKEN) problems.push('CLIENT_TOKEN is set');
	if (problems.length > 0) throw new Error(`Refusing to run: ${problems.join('; ')}.`);
}

const checks = [];
const check = (name, pass, detail = {}) => checks.push({ name, pass: Boolean(pass), ...detail });

async function main() {
	guard();
	await mongoose.connect(process.env.MONGODB_URI, { dbName: DB_NAME, serverSelectionTimeoutMS: 60000 });
	if (mongoose.connection.db.databaseName !== DB_NAME) throw new Error('connected to an unexpected database');
	await mongoose.connection.db.dropDatabase();

	const { bootstrap, seedStatic } = require('../../src/bootstrap');
	const { Quest: QuestClass } = require('../../src/class/Quest');
	const { Quest: QuestCatalog, QuestData } = require('../../src/schemas/QuestSchema');
	const { User: UserModel } = require('../../src/schemas/UserSchema');
	const { User } = require('../../src/class/User');
	const rules = require('../../src/engine/questRules');
	const { rng } = require('../../src/engine/rng');
	const troutTarget = require('../../src/bootstrap/data/quests').find((q) => q.title === 'Catch 15 Trout').progressType.fish;

	// ---------- Pre-step-B world: the production catalog row and legacy player quest documents ----------
	await seedStatic();
	await QuestCatalog.collection.updateOne({ title: 'Catch 15 Trout', user: null }, { $set: { 'progressType.fish': OLD_TROUT } });
	const now = Date.now();
	const player = async (userId, xp) => {
		await User.get(userId);
		await UserModel.updateOne({ userId }, { $set: { xp, publicXp: xp, level: Math.max(1, Math.floor(0.1 * Math.sqrt(xp))), 'stats.lastDailyQuest': 0 } });
	};
	const legacyQuest = async (userId, fields) => {
		const template = await QuestCatalog.findOne({ title: fields.title }).lean();
		const doc = { ...(template || { description: 'x', cash: 0, xp: 0, progressMax: 1, requirements: { level: 0, previous: [] }, progressType: { fish: ['any'], rarity: ['any'], rod: 'any', qualities: ['any'] }, reward: [] }), ...fields, _id: new mongoose.Types.ObjectId(), user: userId };
		await QuestData.collection.insertOne(doc);
		await UserModel.updateOne({ userId }, { $push: { 'inventory.quests': doc._id } });
		return doc._id;
	};
	// A player with an unfinished daily from 3 days ago (the Q5 blocker), a legacy daily with no startDate,
	// an accepted "Catch 15 Trout" copy with the old target, and a completed daily chain for Q4.
	await player('stg-q-stale', 12100);
	const staleId = await legacyQuest('stg-q-stale', { title: 'Catch 1 Legendary Fish', daily: true, status: 'in_progress', progress: 0, startDate: now - 3 * DAY });
	await UserModel.updateOne({ userId: 'stg-q-stale' }, { $set: { 'stats.lastDailyQuest': now - 3 * DAY } });
	const acceptedTroutId = await legacyQuest('stg-q-stale', { title: 'Catch 15 Trout', daily: false, status: 'in_progress', progress: 3 });
	await player('stg-q-legacy', 900);
	const legacyNoStart = await legacyQuest('stg-q-legacy', { title: 'Catch 5 Ultra Fish', daily: true, status: 'in_progress', createdAt: new Date(now - 2 * DAY) });
	await player('stg-q-fresh', 900);
	const freshId = await legacyQuest('stg-q-fresh', { title: 'Catch 100 Fish', daily: true, status: 'in_progress', startDate: now - 2 * 60 * 60 * 1000 });
	await UserModel.updateOne({ userId: 'stg-q-fresh' }, { $set: { 'stats.lastDailyQuest': now - 2 * 60 * 60 * 1000 } });
	await player('stg-q-chain', 1225 * 100);
	await legacyQuest('stg-q-chain', { title: 'Catch 100 Fish', daily: true, status: 'completed', startDate: now - 5 * DAY });

	// ---------- The real boot (twice): Q1 correction ----------
	await bootstrap();
	const row1 = await QuestCatalog.findOne({ title: 'Catch 15 Trout', user: null }).lean();
	await bootstrap();
	const row2 = await QuestCatalog.findOne({ title: 'Catch 15 Trout', user: null }).lean();
	check('q1.catalog-row-corrected', JSON.stringify(row1.progressType.fish) === JSON.stringify(troutTarget), { target: row1.progressType.fish });
	check('q1.second-boot-no-change', JSON.stringify(row1) === JSON.stringify(row2));
	check('q1.rewards-unchanged', row1.cash === 500 && row1.xp === 450 && row1.progressMax === 15, { cash: row1.cash, xp: row1.xp, progressMax: row1.progressMax });
	check('q1.accepted-copy-untouched', JSON.stringify((await QuestData.findById(acceptedTroutId).lean()).progressType.fish) === JSON.stringify(OLD_TROUT));

	// ---------- Q5: stale dailies ----------
	const issued = await QuestClass.generateDailyQuest('stg-q-stale', now);
	const stale = await QuestData.findById(staleId).lean();
	check('q5.stale-daily-no-longer-blocks', Boolean(issued), { issued: issued?.title });
	check('q5.stale-daily-failed-and-kept', stale.status === 'failed' && stale.endDate === now, { status: stale.status });
	check('q5.only-new-daily-open', (await QuestData.countDocuments({ user: 'stg-q-stale', daily: true, status: 'in_progress' })) === 1);
	check('q5.legacy-daily-without-startDate-expires', (await rules.expireStaleDailies('stg-q-legacy', now)) === 1 && (await QuestData.findById(legacyNoStart).lean()).status === 'failed');
	check('q5.fresh-daily-still-blocks', (await QuestClass.generateDailyQuest('stg-q-fresh', now)) === false && (await QuestData.findById(freshId).lean()).status === 'in_progress');

	// ---------- Q4: the eligible pool (gate level 35, Catch 100 Fish completed) ----------
	const drawn = new Set();
	for (let seed = 1; seed <= 60; seed++) {
		await UserModel.updateOne({ userId: 'stg-q-chain' }, { $set: { 'stats.lastDailyQuest': 0 } });
		rng.seed(seed);
		const q = await QuestClass.generateDailyQuest('stg-q-chain', now);
		if (!q) break;
		drawn.add(q.title);
		await QuestData.updateOne({ _id: q._id }, { $set: { status: 'failed' } });
	}
	rng.reset();
	check('q4.prerequisite-daily-issued', drawn.has('Catch 250 Fish'), { drawn: [...drawn].sort() });
	check('q4.unmet-prerequisite-never-issued', !drawn.has('Catch 500 Fish') && !drawn.has('Catch 750 Fish'));

	// ---------- Q3: prerequisites against the player's QuestData ----------
	const completed = await rules.completedQuestTitles('stg-q-chain');
	const two = { requirements: { previous: ['Catch 100 Fish', 'Catch 250 Fish'] } };
	check('q3.one-of-two-refused', !rules.meetsPrerequisites(two, completed));
	await legacyQuest('stg-q-chain', { title: 'Catch 250 Fish', daily: true, status: 'completed' });
	check('q3.both-allowed', rules.meetsPrerequisites(two, await rules.completedQuestTitles('stg-q-chain')));

	const failed = checks.filter((c) => !c.pass);
	console.log('QUESTS-REPORT-BEGIN');
	console.log(JSON.stringify({ rehearsal: 'phase5b-stepB-quests', database: DB_NAME, passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
	console.log('QUESTS-REPORT-END');
	console.log(`STEP B QUESTS REHEARSAL: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${checks.length - failed.length}/${checks.length} checks)`);
	await mongoose.disconnect();
	process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch(async (error) => {
	console.error(`STEP B QUESTS REHEARSAL: ERROR ${error?.stack || error}`);
	await mongoose.disconnect().catch(() => undefined);
	process.exitCode = 1;
});
