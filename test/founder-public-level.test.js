// Public level (hotfix): the public catch card announces level-ups from the PUBLIC (base) XP it shows,
// never from a Founder's real, privately boosted level. Every scenario is deterministic by construction
// (starting XP chosen so any legal roll gives the asserted outcome) or seeded.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { addPoolFish, useTestRod } = require('./helpers/castFixtures');
const { castLine, applyCastResult } = require('../src/engine/cast');
const { levelForXp } = require('../src/engine/balance');
const { rng } = require('../src/engine/rng');
const { resetCooldowns } = require('../src/engine/cooldown');
const { journalProfileBonus, migratePublicXp, publicXpOf } = require('../src/engine/publicLevel');
const dev = require('../src/engine/dev');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { Cast } = require('../src/schemas/CastSchema');
const config = require('../src/config');
const fishCommand = require('../src/commands/slash/Fish/fish.js');
const profileCommand = require('../src/commands/slash/User/profile.js');
const statsCommand = require('../src/commands/slash/User/fishing-stats.js');

const saved = { founders: config.users.founders, developers: config.users.developers };
const FOUNDER = '7101';
const MEMBER = '7202';
const DEV = '7303';

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
	await addPoolFish([{ name: 'Pool Minnow', rarity: 'Common', baseValue: 40 }]);
	config.users.founders = [FOUNDER];
	config.users.developers = [DEV];
});
test.after(async () => {
	config.users.founders = saved.founders;
	config.users.developers = saved.developers;
	rng.reset();
	await stopDb();
	restore();
});

function interactionFor(user) {
	const sent = [];
	return {
		sent, user,
		channel: { id: 'chan' },
		guild: { id: 'guild' },
		options: { getUser: () => user },
		deferReply: async (opts) => { sent.push({ kind: 'defer', ...(opts || {}) }); },
		reply: async (p) => { sent.push({ kind: 'reply', ...p }); },
		editReply: async (p) => { sent.push({ kind: 'edit', ...p }); return { createMessageComponentCollector: () => ({ on: () => undefined }) }; },
		followUp: async (p) => { sent.push({ kind: 'followUp', ...p }); return { createMessageComponentCollector: () => ({ on: () => undefined }), edit: async () => undefined }; },
	};
}
const discordUser = (id) => ({ id, displayName: `P${id}`, globalName: `P${id}`, username: `p${id}` });

async function player(id, { xp, publicXp }) {
	await makeUser(id);
	await useTestRod(id, { capabilities: ['weak', '1'] });
	await UserModel.updateOne({ userId: id }, { $set: { xp, publicXp, level: levelForXp(xp) } });
}
/** Runs /fish for a player; returns the public card's embed and the applied cast journal. */
async function fishOnce(id) {
	resetCooldowns();
	const fi = interactionFor(discordUser(id));
	await fishCommand.run({}, fi, null, discordUser(id));
	const card = fi.sent.find((s) => s.kind === 'followUp').embeds[0].toJSON();
	const journal = await Cast.findOne({ userId: id }).sort({ createdAt: -1 }).lean();
	return { card, result: journal.result };
}
const levelUpField = (card) => (card.fields || []).find((f) => f.name.includes('Level up'));
const doc = (id) => UserModel.findOne({ userId: id }).lean();

test('a real Founder level-up without a public level-up shows NO public level-up line', async () => {
	// Real Lv 2 needs 400 XP: 399 + any Founder cast (>= 5 x 10 XP) crosses it. Public XP 0 + at most
	// 5 fish x 25 base XP stays below 400, so the public level cannot move.
	await player('pl-real-only', { xp: 399, publicXp: 0 });
	config.users.founders = [FOUNDER, 'pl-real-only'];
	try {
		const { card, result } = await fishOnce('pl-real-only');
		assert.equal(result.level.levelUp, true, 'the real level rose');
		assert.equal(result.level.public.levelUp, false, 'the public level did not');
		assert.equal(levelUpField(card), undefined, JSON.stringify(card.fields));
	}
	finally {
		config.users.founders = [FOUNDER];
	}
});

test('a public (base) level-up shows the line with the public level', async () => {
	// Public 399 + at least 10 base XP crosses 400 (public Lv 2); real 10,000 + at most 625 stays Lv 10.
	await player('pl-public-up', { xp: 10000, publicXp: 399 });
	config.users.founders = [FOUNDER, 'pl-public-up'];
	try {
		const { card, result } = await fishOnce('pl-public-up');
		assert.equal(result.level.public.levelUp, true);
		assert.equal(result.level.levelUp, false);
		const field = levelUpField(card);
		assert.ok(field, 'level-up line shown');
		assert.match(field.value, /level \*\*2\*\*/);
	}
	finally {
		config.users.founders = [FOUNDER];
	}
});

test('normal members are unchanged: public level-up == real level-up, and publicXp tracks xp exactly', async () => {
	await player(MEMBER, { xp: 399, publicXp: 399 });
	const { card, result } = await fishOnce(MEMBER);
	assert.equal(result.level.levelUp, true);
	assert.equal(result.level.public.levelUp, true);
	assert.equal(result.level.after, result.level.public.after);
	assert.match(levelUpField(card).value, /level \*\*2\*\*/);
	const d = await doc(MEMBER);
	assert.equal(d.publicXp, d.xp);
	// A member without a level-up gets no line.
	await player('pl-member-flat', { xp: 100, publicXp: 100 });
	const flat = await fishOnce('pl-member-flat');
	assert.equal(levelUpField(flat.card), undefined);
});

test('public XP and the level-up line never contradict each other (seeded casts, Founder and member)', async () => {
	const ids = [];
	for (const [id, founder] of [['pl-inv-f', true], ['pl-inv-m', false]]) {
		// Start just under a public threshold so level-ups happen often.
		await player(id, { xp: founder ? 2380 : 380, publicXp: 380 });
		ids.push([id, founder]);
	}
	config.users.founders = [FOUNDER, 'pl-inv-f'];
	try {
		for (const [id, founder] of ids) {
			for (let i = 0; i < 25; i++) {
				rng.seed(1000 + i);
				const before = await doc(id);
				const { card, result } = await fishOnce(id);
				const after = await doc(id);
				const shownCatchXp = Number(/\*\*\+(\d+) XP\*\*/.exec(card.description)[1]);
				const shownQuestXp = result.quests.filter((q) => q.completed).reduce((s, q) => s + q.reward.xp.base, 0);
				// The public XP gain is exactly the XP the card shows.
				assert.equal(after.publicXp - before.publicXp, shownCatchXp + shownQuestXp);
				assert.equal(after.publicXp, result.level.public.xpAfter);
				// A line appears if and only if the public level rose, and names the new public level.
				const rose = levelForXp(after.publicXp) > levelForXp(before.publicXp);
				const field = levelUpField(card);
				assert.equal(Boolean(field), rose, `cast ${i}: line ${Boolean(field)} vs public rise ${rose}`);
				if (field) assert.match(field.value, new RegExp(`level \\*\\*${levelForXp(after.publicXp)}\\*\\*`));
				assert.ok(after.publicXp <= after.xp);
				if (!founder) assert.equal(after.publicXp, after.xp);
			}
		}
	}
	finally {
		config.users.founders = [FOUNDER];
		rng.reset();
	}
});

test('/profile shows the public level; the private /fishing-stats shows the real and public levels', async () => {
	await player(FOUNDER, { xp: 90000, publicXp: 1600 });
	const fi = interactionFor(discordUser(FOUNDER));
	await profileCommand.run({}, fi, null);
	const profile = JSON.stringify(fi.sent.find((s) => s.kind === 'edit').embeds.map((e) => (e.toJSON ? e.toJSON() : e)));
	assert.match(profile, /Level 4\b/, 'public level 4 (1,600 XP)');
	assert.doesNotMatch(profile, /Level 30\b/, 'never the real level 30');
	const si = interactionFor(discordUser(FOUNDER));
	await statsCommand.run({}, si);
	const stats = JSON.stringify(si.sent.find((s) => s.kind === 'edit').embeds.map((e) => (e.toJSON ? e.toJSON() : e)));
	assert.match(stats, /Real level 30 · Public level 4/);
});

test('migration: publicXp = xp minus every recorded profile bonus; members get xp; idempotent', async () => {
	await UserModel.collection.insertMany([
		{ userId: 'mig-member', xp: 5000, level: 7 },
		{ userId: 'mig-founder', xp: 9000, level: 9 },
		{ userId: 'mig-done', xp: 700, publicXp: 123, level: 2 },
	]);
	await Cast.collection.insertMany([
		// Current shape: base/profileBonus/final.
		{ _id: 'mig-c1', userId: 'mig-founder', status: 'applied', result: { rewards: { xp: { base: 100, profileBonus: 400, final: 500 } } } },
		// Phase 3 shape: multipliers only (x5 catch, x5 quest).
		{ _id: 'mig-c2', userId: 'mig-founder', status: 'applied', result: { xp: { base: 40, catch: 200, total: 350 }, modifiers: { xp: { profile: 5, multiplier: 5 }, sources: [{ source: 'profile', multipliers: { questXp: 5 } }] }, quests: [{ xp: 150 }] } },
		// Pending journals are not counted (the engine adds their base when it applies them).
		{ _id: 'mig-c3', userId: 'mig-founder', status: 'pending', result: { rewards: { xp: { base: 10, profileBonus: 40, final: 50 } } } },
		{ _id: 'mig-c4', userId: 'mig-member', status: 'applied', result: { rewards: { xp: { base: 20, profileBonus: 0, final: 20 } } } },
	]);
	const bonus = journalProfileBonus({ rewards: { xp: { base: 100, profileBonus: 400, final: 500 } } })
		+ journalProfileBonus({ xp: { base: 40, catch: 200, total: 350 }, modifiers: { xp: { profile: 5, multiplier: 5 }, sources: [{ source: 'profile', multipliers: { questXp: 5 } }] }, quests: [{ xp: 150 }] });
	assert.equal(bonus, 400 + (200 - 40) + (150 - 30));
	await migratePublicXp({ UserModel, Cast });
	assert.equal((await doc('mig-member')).publicXp, 5000);
	assert.equal((await doc('mig-founder')).publicXp, 9000 - bonus);
	assert.equal((await doc('mig-done')).publicXp, 123, 'existing publicXp untouched');
	const again = await migratePublicXp({ UserModel, Cast });
	assert.equal(again.scanned, 0, 'idempotent');
});

test('developer XP grants apply to public XP too and never put it above xp', async () => {
	await player('pl-dev', { xp: 5000, publicXp: 1000 });
	await dev.xp(DEV, 'pl-dev', 'add', 500);
	let d = await doc('pl-dev');
	assert.equal(d.xp, 5500);
	assert.equal(d.publicXp, 1500);
	await dev.xp(DEV, 'pl-dev', 'set', 800);
	d = await doc('pl-dev');
	assert.equal(d.xp, 800);
	assert.equal(d.publicXp, 800);
	await dev.xp(DEV, 'pl-dev', 'add', -5000);
	d = await doc('pl-dev');
	assert.equal(d.xp, 0);
	assert.equal(d.publicXp, 0);
	assert.equal(publicXpOf({ xp: 10, publicXp: 50 }), 10, 'publicXp is never read above xp');
});

test('a cast journaled by the previous code (no public level) still adds its base XP when applied', async () => {
	await player('pl-legacy', { xp: 1000, publicXp: 200 });
	config.users.founders = [FOUNDER, 'pl-legacy'];
	try {
		rng.seed(77);
		const r = await castLine({ userId: 'pl-legacy' });
		// Simulate a journal written before this change: no level.public, no rewards breakdown.
		const legacy = JSON.parse(JSON.stringify(r));
		delete legacy.level.public;
		const base = legacy.rewards.xp.base;
		delete legacy.rewards;
		legacy.modifiers = { ...legacy.modifiers, xp: { ...legacy.modifiers.xp, profile: 5 } };
		await applyCastResult({ ...r, level: legacy.level, rewards: undefined, modifiers: legacy.modifiers });
		const d = await doc('pl-legacy');
		assert.equal(d.xp, 1000 + r.xp.total);
		assert.equal(d.publicXp, 200 + base, 'base recovered from the recorded multipliers');
	}
	finally {
		config.users.founders = [FOUNDER];
		rng.reset();
	}
});
