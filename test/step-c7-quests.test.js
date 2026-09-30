// Step C.7 (dark behind the 5B flag): typed quests: the shared DCC day, the start rule (the model's rule
// examples), daily/weekly issue and expiry, band terms, progress rules (items never, biome scope), story pity,
// the completion log, legacy instances and the questLog backfill.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { userDoc } = require('./helpers/castFixtures');
const { with5b } = require('./helpers/withFlag');
const { castLine, applyCastResult } = require('../src/engine/cast');
const q5 = require('../src/engine/b5/quests');
const day = require('../src/engine/b5/day');
const { migrateQuestLog } = require('../src/engine/b5/migrations');
const { validate5b } = require('../src/engine/b5/validate');
const levels = require('../src/engine/levels');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { QuestData } = require('../src/schemas/QuestSchema');
const { rng } = require('../src/engine/rng');
const model = require('../scripts/economy/5b/quests');

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

async function player(userId, level) {
	await makeUser(userId);
	const xp = levels.CURVES['5b'].xpForLevel(level);
	await UserModel.updateOne({ userId }, { $set: { xp, publicXp: xp, level, levelFloor: level, publicLevelFloor: level, permits: [] } });
}

test('one DCC day for everything: periods and expiries equal the model\'s', async () => {
	await with5b(async () => {
		for (const iso of ['2026-09-25T21:30:00Z', '2026-09-27T23:59:59Z', '2026-09-28T00:00:00Z', '2027-01-01T00:00:00Z', '2026-12-31T12:00:00Z']) {
			const ms = Date.parse(iso);
			assert.equal(day.dayKey(ms), model.periodKey('daily', ms), iso);
			assert.equal(day.weekKey(ms), model.periodKey('weekly', ms), iso);
			assert.equal(day.dayEnd(ms), model.expiresAt('daily', ms), iso);
			assert.equal(day.weekEnd(ms), model.expiresAt('weekly', ms), iso);
		}
	});
});

test('the start rule reproduces the model\'s rule examples', async () => {
	await with5b(async () => {
		const ms = Date.parse('2026-09-25T12:00:00Z');
		const lucky = q5.template('story.lucky-fisher');
		const trout = q5.template('story.river-trout');
		const village = q5.template('repeatable.village');
		const fishmonger = q5.template('repeatable.fishmonger');
		assert.match(q5.canStart(lucky, { level: 20 }, ms).reason, /needs level 30/);
		assert.match(q5.canStart(lucky, { level: 30 }, ms).reason, /needs story.magikarp first/);
		assert.equal(q5.canStart(lucky, { level: 30, questLog: { 'story.magikarp': { completions: 1 } } }, ms).ok, true);
		assert.match(q5.canStart(trout, { level: 30, questLog: { 'story.river-trout': { completions: 1 } } }, ms).reason, /already completed/);
		assert.match(q5.canStart(village, { level: 5, questLog: { 'repeatable.village': { lastCompletedAt: ms - 5 * 3600e3 } } }, ms).reason, /on cooldown for 7.0 h/);
		assert.equal(q5.canStart(fishmonger, { level: 5, repeatableCompletionsToday: 1 }, ms).ok, true);
		assert.match(q5.canStart(fishmonger, { level: 5, repeatableCompletionsToday: 2 }, ms).reason, /daily cap of 2/);
		assert.match(q5.canStart(fishmonger, { level: 5, active: ['repeatable.village'] }, ms).reason, /only 1 repeatable/);
		assert.match(q5.canStart(q5.template('daily.catch'), { level: 5 }, ms).reason, /issued by \/daily/);
	});
});

test('daily and weekly: one per period with the band terms at issue; an unfinished one never blocks and expires', async () => {
	await player('c7-daily', 12);
	await with5b(async () => {
		const t0 = Date.parse('2026-09-25T10:00:00Z');
		const a = await q5.issueDaily('c7-daily', t0);
		const b = await q5.issueDaily('c7-daily', t0 + 3600e3);
		assert.equal(String(a.daily._id), String(b.daily._id), 'one daily per DCC day');
		assert.equal(a.daily.period, 'D2026-09-25');
		assert.equal(a.daily.band, 'river');
		assert.ok(a.weekly, 'weekly from Lv 10');
		const terms = q5.bandFor(q5.template(a.daily.key), 12);
		assert.equal(a.daily.progressMax, terms.progressMax);
		assert.equal(a.daily.xp, terms.xp);
		assert.equal(a.daily.cash, terms.cash);
		assert.equal(a.daily.reward.length, 1, 'one Daily Box');
		// Level up mid-day: terms unchanged.
		await UserModel.updateOne({ userId: 'c7-daily' }, { $set: { levelFloor: 25, publicLevelFloor: 25 } });
		assert.equal((await q5.issueDaily('c7-daily', t0 + 7200e3)).daily.xp, a.daily.xp);
		// Next day: a new daily, the old one untouched until a cast marks it expired.
		const next = await q5.issueDaily('c7-daily', t0 + 864e5);
		assert.notEqual(String(next.daily._id), String(a.daily._id));
		assert.equal(next.daily.band, 'lake');
		assert.equal(String(next.weekly._id), String(a.weekly._id), 'same ISO week');
		const r = await castLine({ userId: 'c7-daily', now: new Date(t0 + 864e5 + 60e3) });
		assert.ok(r.questsExpired.includes(String(a.daily._id)));
		await applyCastResult(r);
		const old = await QuestData.collection.findOne({ _id: a.daily._id });
		assert.equal(old.status, 'expired');
	});
});

test('progress: items never progress; a biome-scoped chapter counts only its biome; completion logs and pays the base publicly', async () => {
	await player('c7-story', 20);
	await with5b(async () => {
		const started = await q5.startQuest('c7-story', 'story.lake', Date.now());
		assert.equal(started.ok, true);
		// Casting in the Ocean does not progress the Lake chapter.
		const r = await castLine({ userId: 'c7-story' });
		assert.equal(r.quests.filter((x) => x.key === 'story.lake').length, 0);
		// Force completion: set the stored progress one short and cast in the Lake with its permit.
		await QuestData.collection.updateOne({ _id: started.quest._id }, { $set: { progress: started.quest.progressMax - 1 } });
		await UserModel.updateOne({ userId: 'c7-story' }, { $set: { currentBiome: 'lake', permits: [{ biome: 'Lake', source: 'purchased' }] } });
		const r2 = await castLine({ userId: 'c7-story' });
		const done = r2.quests.find((x) => x.key === 'story.lake');
		assert.equal(done.completed, true);
		assert.equal(done.reward.xp.base, q5.template('story.lake').xp);
		assert.deepEqual(r2.questLog.keys, ['story:lake']);
		await applyCastResult(r2);
		const u = await userDoc('c7-story');
		assert.equal(u.questLog['story:lake'].completions, 1);
		assert.equal((await q5.startQuest('c7-story', 'story.lake')).reason, 'already completed (story quests are one-time)');
		// A Lucky ITEM never progresses a quest.
		const t = q5.effectiveTerms({ kind: 'story', key: 'story.lucky-fisher', progressType: q5.template('story.lucky-fisher').progressType, progressMax: 5 });
		assert.equal(q5.progresses(t, { kind: 'item', name: 'Booster Pack', rarity: 'Lucky', qualities: [] }, 'x'), false);
		assert.equal(q5.progresses(t, { kind: 'fish', name: 'Lunafin Fish', rarity: 'Lucky', biome: 'River', qualities: ['weak'] }, 'x'), true);
	});
});

test('repeatables: the daily cap counts completions in the DCC day', async () => {
	await player('c7-rep', 5);
	await with5b(async () => {
		const today = day.dayKey(Date.now());
		await UserModel.updateOne({ userId: 'c7-rep' }, { $set: { 'stats.questDay': { period: today, repeatableCompletions: 2 } } });
		assert.match((await q5.startQuest('c7-rep', 'repeatable.village')).reason, /daily cap/);
		await UserModel.updateOne({ userId: 'c7-rep' }, { $set: { 'stats.questDay': { period: 'D2000-01-01', repeatableCompletions: 2 } } });
		assert.equal((await q5.startQuest('c7-rep', 'repeatable.village')).ok, true);
		const [a, b] = await Promise.all([q5.startQuest('c7-rep', 'repeatable.fishmonger'), q5.startQuest('c7-rep', 'repeatable.fishmonger')]);
		assert.equal(a.ok || b.ok, false, 'one repeatable at a time (Village is active)');
	});
});

test('story pity: at the hard threshold the first draw is the Magikarp; the meter resets on success', async () => {
	await player('c7-karp', 1);
	await with5b(async () => {
		const s = await q5.startQuest('c7-karp', 'story.magikarp');
		assert.equal(s.ok, true);
		const pity = q5.template('story.magikarp').pity;
		await QuestData.collection.updateOne({ _id: s.quest._id }, { $set: { pityCount: pity.hard } });
		const r = await castLine({ userId: 'c7-karp' });
		assert.equal(r.questPity.forces, 'species');
		assert.equal(r.catches[0].name, 'Magikarp');
		const q = r.quests.find((x) => x.key === 'story.magikarp');
		assert.equal(q.completed, true);
		assert.equal(q.pityAfter, 0);
		// Below the soft start nothing is forced and the meter grows by 1 + Luck per Ocean fish.
		assert.deepEqual(q5.pityBonus(pity, pity.softStart - 1), { bonus: 0, hard: false });
	});
});

test('legacy instances: never expire, trout maps to the River family, Lucky Fisher counts at most 5, backfill is idempotent', async () => {
	await player('c7-legacy', 12);
	await with5b(async () => {
		const legacyTrout = { title: 'Catch 15 Trout', progressType: { fish: ['rainbow trout', 'golden trout'], rarity: ['any'], rod: 'any', qualities: ['any'] }, progressMax: 15, xp: 450, cash: 500 };
		const t = q5.effectiveTerms(legacyTrout);
		assert.equal(t.key, 'story.river-trout');
		assert.ok(t.progressType.fish.includes('skyfin trout'));
		assert.equal(t.xp, Math.max(450, q5.template('story.river-trout').xp));
		assert.equal(q5.effectiveTerms({ title: 'Lucky Fisher', progressMax: 25, progressType: { rarity: ['lucky'] } }).progressMax, 5);
		assert.equal(q5.isExpired({ title: 'Catch 100 Fish', daily: true, startDate: 0 }, Date.now()), false);
		// Backfill: two completed legacy trout documents -> completions 2; a second run changes nothing.
		for (let i = 0; i < 2; i++) await QuestData.collection.insertOne({ _id: new mongoose.Types.ObjectId(), title: 'Catch 15 Trout', user: 'c7-legacy', status: 'completed', endDate: 1000 + i });
		await migrateQuestLog();
		const once = (await userDoc('c7-legacy')).questLog;
		await migrateQuestLog();
		assert.deepEqual((await userDoc('c7-legacy')).questLog, once);
		assert.equal(once['story:river-trout'].completions, 2);
		assert.equal(once['story:river-trout'].firstCompletedAt, 1000);
		assert.equal(await QuestData.countDocuments({ user: 'c7-legacy', status: 'completed' }), 2, 'nothing deleted');
	});
});

test('boot validation: every kind has a template and every story target exists', async () => {
	await with5b(async () => assert.deepEqual(await validate5b(), []));
});
