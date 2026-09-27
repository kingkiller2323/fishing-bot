// Phase 5B step B: quests (Q1, Q3, Q4, Q5), correctness on TODAY's quest model: per-user QuestData
// documents, today's status enum and the rolling 24-hour daily gate. No step C schema (questLog, kinds,
// DCC-day periods) is introduced.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { MessageFlags } = require('discord.js');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { userDoc } = require('./helpers/castFixtures');
const { rng } = require('../src/engine/rng');
const { Quest: QuestClass } = require('../src/class/Quest');
const { Quest: QuestCatalog, QuestData } = require('../src/schemas/QuestSchema');
const { Fish } = require('../src/schemas/FishSchema');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { migrateTroutQuestTarget } = require('../src/bootstrap/migrations');
const { bootstrap } = require('../src/bootstrap');
const rules = require('../src/engine/questRules');
const balance = require('../src/engine/balance');
const levels = require('../src/engine/levels');
const startQuestCommand = require('../src/commands/slash/User/startQuest.js');
const dailyCommand = require('../src/commands/slash/User/daily.js');

const DAY = 24 * 60 * 60 * 1000;
const RIVER_TROUT = ['cherry trout', 'clover trout', 'fall blue trout', 'fogtail trout', 'frostfin trout', 'frostling trout', 'rainbow trout', 'skyfin trout', 'solaris trout', 'thunder trout'];

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
});
test.after(async () => {
	rng.reset();
	await stopDb();
	restore();
});

/** Sets a player's XP so its gate level is `level` (today's curve: xp = (10·level)²). */
async function atLevel(userId, level) {
	await makeUser(userId);
	const xp = (10 * level) ** 2;
	await UserModel.updateOne({ userId }, { $set: { xp, publicXp: xp, level, levelFloor: level, publicLevelFloor: level } });
}

/** A player's QuestData (in their inventory, as the game creates them). */
async function playerQuest(userId, fields) {
	const q = await QuestData.create({ description: 'x', cash: 0, xp: 0, progressMax: 1, user: userId, requirements: { level: 0, previous: [] }, progressType: { fish: ['any'], rarity: ['any'], rod: 'any', qualities: ['any'] }, reward: [], type: 'quest', ...fields });
	await UserModel.updateOne({ userId }, { $push: { 'inventory.quests': q._id } });
	return q;
}

// ---------- Q1: Catch 15 Trout targets the River trout family ----------

test('Q1: a fresh seed gets the River trout family; every target is a River fish and no other trout is included', async () => {
	const row = await QuestCatalog.findOne({ title: 'Catch 15 Trout' }).lean();
	assert.deepEqual(row.progressType.fish, RIVER_TROUT);
	assert.equal(row.progressMax, 15);
	assert.equal(row.cash, 500);
	assert.equal(row.xp, 450);
	const catalogTrout = await Fish.find({ user: null, name: /trout/i }).lean();
	const river = new Set(catalogTrout.filter((f) => f.biome === 'River').map((f) => f.name.toLowerCase()));
	assert.deepEqual([...river].sort(), [...RIVER_TROUT].sort(), 'exactly the River trout in the catalog');
	for (const f of catalogTrout.filter((x) => x.biome !== 'River')) assert.ok(!RIVER_TROUT.includes(f.name.toLowerCase()), `${f.name} (${f.biome}) excluded`);
});

test('Q1: an existing production-shaped row with the old target is corrected exactly once, nothing else changes', async () => {
	const before = await QuestCatalog.findOne({ title: 'Catch 15 Trout' }).lean();
	await QuestCatalog.collection.updateOne({ _id: before._id }, { $set: { 'progressType.fish': ['rainbow trout', 'golden trout'] } });
	assert.deepEqual(await migrateTroutQuestTarget(), { corrected: 1, activeCopies: 0 });
	assert.deepEqual(await migrateTroutQuestTarget(), { corrected: 0, activeCopies: 0 }, 'idempotent');
	const after = await QuestCatalog.findOne({ _id: before._id }).lean();
	assert.deepEqual(after.progressType.fish, RIVER_TROUT);
	for (const k of ['title', 'description', 'cash', 'xp', 'progressMax', 'reward', 'requirements', 'daily']) assert.deepEqual(after[k], before[k], k);
	// Through the real boot as well.
	await QuestCatalog.collection.updateOne({ _id: before._id }, { $set: { 'progressType.fish': ['rainbow trout', 'golden trout'] } });
	await bootstrap();
	assert.deepEqual((await QuestCatalog.findOne({ _id: before._id }).lean()).progressType.fish, RIVER_TROUT);
});

test('Q1: a row whose target was changed some other way is never touched', async () => {
	const row = await QuestCatalog.findOne({ title: 'Catch 15 Trout' }).lean();
	await QuestCatalog.collection.updateOne({ _id: row._id }, { $set: { 'progressType.fish': ['rainbow trout'] } });
	assert.deepEqual(await migrateTroutQuestTarget(), { corrected: 0, activeCopies: 0 });
	assert.deepEqual((await QuestCatalog.findOne({ _id: row._id }).lean()).progressType.fish, ['rainbow trout']);
	await QuestCatalog.collection.updateOne({ _id: row._id }, { $set: { 'progressType.fish': RIVER_TROUT } });
});

test('Q1: active player copies on the old target are corrected; history and edited copies are not', async () => {
	await makeUser('q1-player');
	const oldTarget = { fish: ['rainbow trout', 'golden trout'], rarity: ['any'], rod: 'any', qualities: ['any'] };
	const inProgress = await playerQuest('q1-player', { title: 'Catch 15 Trout', status: 'in_progress', progress: 4, progressType: oldTarget });
	const pending = await playerQuest('q1-player', { title: 'Catch 15 Trout', status: 'pending', progressType: oldTarget });
	const completed = await playerQuest('q1-player', { title: 'Catch 15 Trout', status: 'completed', progressType: oldTarget });
	const failed = await playerQuest('q1-player', { title: 'Catch 15 Trout', status: 'failed', progressType: oldTarget });
	const edited = await playerQuest('q1-player', { title: 'Catch 15 Trout', status: 'in_progress', progressType: { ...oldTarget, fish: ['rainbow trout'] } });
	const otherTitle = await playerQuest('q1-player', { title: 'Catch 15 Carp', status: 'in_progress', progressType: oldTarget });
	assert.deepEqual(await migrateTroutQuestTarget(), { corrected: 0, activeCopies: 2 });
	assert.deepEqual(await migrateTroutQuestTarget(), { corrected: 0, activeCopies: 0 }, 'idempotent');
	const fishOf = async (q) => (await QuestData.findById(q._id).lean()).progressType.fish;
	assert.deepEqual(await fishOf(inProgress), RIVER_TROUT);
	assert.deepEqual(await fishOf(pending), RIVER_TROUT);
	assert.equal((await QuestData.findById(inProgress._id).lean()).progress, 4, 'only the target changes');
	for (const q of [completed, failed]) assert.deepEqual(await fishOf(q), ['rainbow trout', 'golden trout'], 'history kept');
	assert.deepEqual(await fishOf(edited), ['rainbow trout']);
	assert.deepEqual(await fishOf(otherTitle), ['rainbow trout', 'golden trout']);
});

// ---------- Q3: prerequisites on /start-quest ----------

function startQuestInteraction(userId) {
	const out = { replies: [], handlers: {} };
	const response = {
		createMessageComponentCollector: () => {
			const on = (ev, fn) => { out.handlers[ev] = fn; };
			return { on };
		},
		edit: async () => undefined,
	};
	const reply = async (p) => {
		out.replies.push(p);
		return response;
	};
	const interaction = { user: { id: userId }, reply };
	return { interaction, out };
}

async function startQuest(userId, questId) {
	const { interaction, out } = startQuestInteraction(userId);
	await startQuestCommand.run({}, interaction, null);
	const answers = [];
	await out.handlers.collect({ user: { id: userId }, values: [String(questId)], reply: async (p) => { answers.push(typeof p === 'string' ? { content: p } : p); } });
	return answers[0].content;
}

async function catalogQuest(title, previous, level = 0) {
	return QuestCatalog.create({ title, description: 'x', cash: 1, xp: 1, progressMax: 1, daily: false, requirements: { level, previous }, progressType: { fish: ['any'], rarity: ['any'], rod: 'any', qualities: ['any'] }, reward: [] });
}

test('Q3: no prerequisites -> eligible; one -> needs it completed; two -> needs both (one of two is refused)', async () => {
	const none = await catalogQuest('Q3 none', []);
	const one = await catalogQuest('Q3 one', ['Q3 prereq A']);
	const two = await catalogQuest('Q3 two', ['Q3 prereq A', 'Q3 prereq B']);
	await makeUser('q3');
	assert.match(await startQuest('q3', none._id), /has started quest \*\*Q3 none\*\*/);
	assert.match(await startQuest('q3', one._id), /complete the previous quest\(s\)[\s\S]*Q3 prereq A/);
	await playerQuest('q3', { title: 'Q3 prereq A', status: 'in_progress' });
	assert.match(await startQuest('q3', one._id), /complete the previous quest/, 'an in-progress prerequisite does not count');
	await QuestData.updateOne({ user: 'q3', title: 'Q3 prereq A' }, { $set: { status: 'completed' } });
	assert.match(await startQuest('q3', one._id), /has started quest \*\*Q3 one\*\*/);
	assert.match(await startQuest('q3', two._id), /complete the previous quest\(s\)[\s\S]*Q3 prereq B/, 'one of two completed is refused');
	await playerQuest('q3', { title: 'Q3 prereq B', status: 'completed' });
	assert.match(await startQuest('q3', two._id), /has started quest \*\*Q3 two\*\*/, 'both completed is allowed');
});

test('Q3: level gating is kept (gate level), and another player\'s completions never count', async () => {
	const gated = await catalogQuest('Q3 gated', [], 30);
	await atLevel('q3-low', 12);
	assert.match(await startQuest('q3-low', gated._id), /need to be level 30/);
	const one = await catalogQuest('Q3 other', ['Q3 other prereq']);
	await makeUser('q3-other');
	await makeUser('q3-someone');
	await playerQuest('q3-someone', { title: 'Q3 other prereq', status: 'completed' });
	assert.match(await startQuest('q3-other', one._id), /complete the previous quest/);
});

test('Q3/Q4: missing or malformed prerequisite lists count as none', () => {
	const done = new Set(['A']);
	for (const previous of [undefined, null, 'A', 7, {}, [], [''], ['  '], [null]]) {
		assert.deepEqual(rules.prerequisitesOf({ requirements: { previous } }), [], JSON.stringify(previous));
		assert.equal(rules.meetsPrerequisites({ requirements: { previous } }, new Set()), true);
	}
	assert.deepEqual(rules.prerequisitesOf({}), []);
	assert.equal(rules.meetsPrerequisites({ requirements: { previous: ['A', ''] } }, done), true);
	assert.equal(rules.meetsPrerequisites({ requirements: { previous: ['A', 'B'] } }, done), false);
});

// ---------- Q4: /daily draws from the eligible pool, computed once ----------

/** Issues dailies under seeds 1..n, failing each one after it is issued so the next can be drawn. */
async function drawDailies(userId, n) {
	const titles = [];
	for (let seed = 1; seed <= n; seed++) {
		await UserModel.updateOne({ userId }, { $set: { 'stats.lastDailyQuest': 0 } });
		rng.seed(seed);
		const q = await QuestClass.generateDailyQuest(userId);
		assert.ok(q, `seed ${seed}: a daily is issued`);
		titles.push(q.title);
		await QuestData.updateOne({ _id: q._id }, { $set: { status: 'failed' } });
	}
	rng.reset();
	return titles;
}

test('Q4: a low-level player draws uniformly from the level-0, no-prerequisite dailies only', async () => {
	await atLevel('q4-low', 1);
	const titles = await drawDailies('q4-low', 60);
	const pool = ['Catch 100 Fish', 'Catch 1 Legendary Fish', 'Catch 5 Ultra Fish', 'Catch 15 Rare Fish'];
	assert.ok(titles.every((t) => pool.includes(t)), JSON.stringify([...new Set(titles)]));
	assert.deepEqual([...new Set(titles)].sort(), [...pool].sort(), 'every eligible daily can be drawn');
});

test('Q4: prerequisite dailies are issued only once every prerequisite is completed (they were never issued before)', async () => {
	await atLevel('q4-chain', 35);
	assert.ok(!(await drawDailies('q4-chain', 40)).includes('Catch 250 Fish'), 'Catch 100 Fish not completed yet');
	await playerQuest('q4-chain', { title: 'Catch 100 Fish', status: 'completed', daily: true });
	const titles = await drawDailies('q4-chain', 60);
	assert.ok(titles.includes('Catch 250 Fish'));
	assert.ok(!titles.includes('Catch 500 Fish'), 'Catch 250 Fish not completed');
	await playerQuest('q4-chain', { title: 'Catch 250 Fish', status: 'completed', daily: true });
	assert.ok((await drawDailies('q4-chain', 80)).includes('Catch 500 Fish'), 'level 35 >= 30 and Catch 250 Fish completed');
	assert.ok(!(await drawDailies('q4-chain', 40)).includes('Catch 750 Fish'), 'level 35 < 40');
});

test('Q4: an empty eligible pool returns null (no recursion) and /daily answers privately', async () => {
	await atLevel('q4-none', 1);
	const saved = await QuestCatalog.find({ daily: true }).lean();
	await QuestCatalog.collection.updateMany({ daily: true }, { $set: { 'requirements.level': 999 } });
	try {
		assert.equal(await QuestClass.generateDailyQuest('q4-none'), null);
		assert.equal((await userDoc('q4-none')).stats.lastDailyQuest || 0, 0, 'nothing issued, gate untouched');
		const replies = [];
		await dailyCommand.run({}, { user: { id: 'q4-none' }, reply: async (p) => { replies.push(p); } }, null);
		assert.match(replies[0].content, /no daily quest available/);
		assert.ok(replies[0].flags & MessageFlags.Ephemeral);
	}
	finally {
		for (const q of saved) await QuestCatalog.collection.updateOne({ _id: q._id }, { $set: { 'requirements.level': q.requirements.level } });
	}
});

test('Q4: the rolling 24-hour issuance gate is unchanged (stats.lastDailyQuest)', async () => {
	await atLevel('q4-gate', 1);
	const now = Date.now();
	await UserModel.updateOne({ userId: 'q4-gate' }, { $set: { 'stats.lastDailyQuest': now - DAY + 1 } });
	assert.equal(await QuestClass.generateDailyQuest('q4-gate', now), false);
	await UserModel.updateOne({ userId: 'q4-gate' }, { $set: { 'stats.lastDailyQuest': now - DAY } });
	assert.ok(await QuestClass.generateDailyQuest('q4-gate', now));
});

// ---------- Q5: a daily unfinished for 24 hours no longer blocks ----------

async function openDaily(userId, startedAgo, now) {
	await atLevel(userId, 1);
	await UserModel.updateOne({ userId }, { $set: { 'stats.lastDailyQuest': now - startedAgo } });
	return playerQuest(userId, { title: 'Catch 100 Fish', daily: true, status: 'in_progress', progressMax: 100, progress: 40, startDate: now - startedAgo });
}

test('Q5: boundaries: just before 24 h still blocks; exactly 24 h and just after expire it', async () => {
	const now = Date.now();
	const cases = [['q5-before', DAY - 1, false], ['q5-at', DAY, true], ['q5-after', DAY + 1, true]];
	for (const [id, ago, expires] of cases) {
		const old = await openDaily(id, ago, now);
		const issued = await QuestClass.generateDailyQuest(id, now);
		const oldAfter = await QuestData.findById(old._id).lean();
		if (!expires) {
			assert.equal(issued, false, `${id}: still blocks`);
			assert.equal(oldAfter.status, 'in_progress');
			continue;
		}
		assert.ok(issued, `${id}: a new daily is issued`);
		assert.equal(oldAfter.status, 'failed', `${id}: marked failed (today's enum)`);
		assert.equal(oldAfter.endDate, now);
		assert.equal(oldAfter.progress, 40, 'the document is kept as it was');
		assert.ok((await userDoc(id)).inventory.quests.map(String).includes(String(old._id)), 'still in the player\'s history');
		const open = await QuestData.find({ user: id, daily: true, status: 'in_progress' }).lean();
		assert.deepEqual(open.map((q) => String(q._id)), [String(issued._id)], 'only the new daily can progress');
		// Sizes and rewards are today's.
		const template = await QuestCatalog.findOne({ title: issued.title }).lean();
		assert.equal(issued.progressMax, template.progressMax);
		assert.equal(issued.cash, template.cash);
		assert.equal(issued.xp, template.xp);
	}
});

test('Q5: /daily itself: a fresh unfinished daily blocks privately; a stale one is expired and a new daily issued', async () => {
	const replies = (id) => {
		const r = [];
		return { r, interaction: { user: { id }, reply: async (p) => { r.push(p); } } };
	};
	await openDaily('q5-cmd-fresh', DAY - 60_000, Date.now());
	const fresh = replies('q5-cmd-fresh');
	await dailyCommand.run({}, fresh.interaction, null);
	assert.match(fresh.r[0].content, /already have a daily quest in progress/);
	assert.ok(fresh.r[0].flags & MessageFlags.Ephemeral);

	const stale = await openDaily('q5-cmd-stale', DAY + 60_000, Date.now());
	const r = replies('q5-cmd-stale');
	await dailyCommand.run({}, r.interaction, null);
	assert.match(r.r[0].embeds[0].data.title, /^Daily Quest: /);
	assert.equal((await QuestData.findById(stale._id).lean()).status, 'failed');
});

test('Q5: a daily completed in the meantime, a story quest, or a legacy daily without startDate is handled safely', async () => {
	const now = Date.now();
	await atLevel('q5-safe', 1);
	const done = await playerQuest('q5-safe', { title: 'Catch 100 Fish', daily: true, status: 'completed', startDate: now - 3 * DAY });
	const story = await playerQuest('q5-safe', { title: 'Catch 15 Carp', daily: false, status: 'in_progress', startDate: now - 3 * DAY });
	assert.equal(await rules.expireStaleDailies('q5-safe', now), 0);
	assert.equal((await QuestData.findById(done._id).lean()).status, 'completed');
	assert.equal((await QuestData.findById(story._id).lean()).status, 'in_progress', 'story quests never expire here');
	// Legacy daily without startDate: its creation time decides.
	const legacy = await playerQuest('q5-safe', { title: 'Catch 5 Ultra Fish', daily: true, status: 'in_progress' });
	await QuestData.collection.updateOne({ _id: legacy._id }, { $unset: { startDate: '' }, $set: { createdAt: new Date(now - 2 * DAY) } });
	assert.equal(await rules.expireStaleDailies('q5-safe', now), 1);
	assert.equal((await QuestData.findById(legacy._id).lean()).status, 'failed');
});

// ---------- No gameplay drift ----------

test('quest fixes change no cast reward, Founder rule, XP curve, economy number or BALANCE_5B', () => {
	// Everything the balance module exports that is data (not code), plus the curve at sample XP values.
	const data = Object.fromEntries(Object.entries(balance).filter(([, v]) => typeof v !== 'function').sort(([a], [b]) => a.localeCompare(b)));
	const curve = [0, 99, 100, 400, 4900, 22500, 250000].map((x) => [x, balance.levelForXp(x), levels.curveLevel(x)]);
	const digest = crypto.createHash('sha256').update(JSON.stringify({ data, curve })).digest('hex').slice(0, 16);
	assert.equal(digest, ECONOMY_DIGEST, 'balance data or curve changed');
	assert.equal(balance.BALANCE_VERSION, '3.2.0');
	assert.equal(balance.isBalance5b(), false);
	assert.equal(levels.activeCurve().name, 'current');
	assert.equal(balance.resolveProfile('nobody', null).competitiveEligible, true);
	// test/flag-off-golden.test.js separately pins the full cast sequence to production 71fde4d.
	assert.ok(mongoose.connection.readyState === 1);
});

// Captured from main 83af7f3 (before step B: quests); balance.js is not part of this change.
const ECONOMY_DIGEST = 'a56d59d7c2240047';
