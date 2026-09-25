// Founder subtlety: same power, private presentation, exact reward bookkeeping.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { addPoolFish, useTestRod, giveQuest } = require('./helpers/castFixtures');
const { castLine, applyCastResult } = require('../src/engine/cast');
const { resolveModifiers, rollDraws } = require('../src/engine/modifiers');
const { PROFILES, NORMAL_RARITY_TABLE } = require('../src/engine/balance');
const { createRng, rng } = require('../src/engine/rng');
const { resetCooldowns } = require('../src/engine/cooldown');
const { FishData } = require('../src/schemas/FishSchema');
const config = require('../src/config');
const fishCommand = require('../src/commands/slash/Fish/fish.js');
const profileCommand = require('../src/commands/slash/User/profile.js');
const statsCommand = require('../src/commands/slash/User/fishing-stats.js');

const saved = { founders: config.users.founders };
const FOUNDER = '4242';
const MEMBER = '5151';
const PROFILE_TELLS = /founder|👑|profile bonus|bonus|admin|owner|boost/i;

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
	await addPoolFish([{ name: 'Pool Minnow', rarity: 'Common', baseValue: 40 }]);
	config.users.founders = [FOUNDER];
});
test.after(async () => {
	config.users.founders = saved.founders;
	rng.reset();
	await stopDb();
	restore();
});

// Minimal Discord interaction stand-in that records what the bot sends.
function interactionFor(user, { target = user } = {}) {
	const sent = [];
	return {
		sent,
		user,
		channel: { id: 'chan' },
		guild: { id: 'guild' },
		options: { getUser: () => target },
		deferReply: async (opts) => { sent.push({ kind: 'defer', ...(opts || {}) }); },
		reply: async (p) => { sent.push({ kind: 'reply', ...p }); },
		editReply: async (p) => { sent.push({ kind: 'edit', ...p }); return { createMessageComponentCollector: () => ({ on: () => undefined }) }; },
		followUp: async (p) => { sent.push({ kind: 'followUp', ...p }); return { createMessageComponentCollector: () => ({ on: () => undefined }), edit: async () => undefined }; },
	};
}
const json = (payload) => JSON.stringify({
	embeds: (payload.embeds || []).map((e) => (e.toJSON ? e.toJSON() : e)),
	components: (payload.components || []).map((c) => (c.toJSON ? c.toJSON() : c)),
	content: payload.content,
});

test('public catch cards do not expose Founder status and look like any other card', async () => {
	const founder = { id: FOUNDER, displayName: 'Casey', globalName: 'Casey', username: 'casey' };
	const member = { id: MEMBER, displayName: 'Pat', globalName: 'Pat', username: 'pat' };
	for (const u of [founder, member]) {
		await makeUser(u.id);
		await useTestRod(u.id, { capabilities: ['weak', '1'] });
	}
	resetCooldowns();
	const fi = interactionFor(founder);
	const mi = interactionFor(member);
	await fishCommand.run({}, fi, null, founder);
	await fishCommand.run({}, mi, null, member);
	const founderCard = fi.sent.find((s) => s.kind === 'followUp');
	const memberCard = mi.sent.find((s) => s.kind === 'followUp');
	assert.ok(!PROFILE_TELLS.test(json(founderCard)), json(founderCard));
	assert.ok(!fi.sent.some((s) => s.ephemeral), 'no extra private messages during normal play');
	const f = founderCard.embeds[0].toJSON();
	const m = memberCard.embeds[0].toJSON();
	assert.deepEqual(Object.keys(f).sort(), Object.keys(m).sort());
	assert.equal(f.footer.text, m.footer.text);
	assert.deepEqual(json({ components: founderCard.components }).replace(/[0-9a-f]{24}/g, 'ID'), json({ components: memberCard.components }).replace(/[0-9a-f]{24}/g, 'ID'));
});

test('Founder rewards are unchanged: 5x XP, 10x sale value, 5x quests', async () => {
	await makeUser('rewards-f');
	await useTestRod('rewards-f', { capabilities: ['weak', '1'] });
	await giveQuest('rewards-f', { progressMax: 1, xp: 30, cash: 11 });
	config.users.founders = [FOUNDER, 'rewards-f'];
	try {
		rng.seed(9);
		const r = await castLine({ userId: 'rewards-f' });
		assert.equal(r.xp.catch, Math.floor(r.xp.base * 5));
		for (const c of r.catches) assert.equal(c.value, Math.round(c.rawValue * 10));
		assert.equal(r.quests[0].xp, 150);
		assert.equal(r.quests[0].cash, 55);
		assert.equal(r.xp.total, r.xp.catch + 150);
	}
	finally {
		config.users.founders = [FOUNDER];
	}
});

test('base / profile bonus / final reconcile exactly, and final is what gets stored', async () => {
	await makeUser('recon');
	await useTestRod('recon', { capabilities: ['weak', '2', '2 count'] });
	await giveQuest('recon', { progressMax: 1, xp: 33, cash: 7 });
	config.users.founders = [FOUNDER, 'recon'];
	try {
		for (let seed = 1; seed <= 10; seed++) {
			rng.seed(seed);
			const r = await castLine({ userId: 'recon' });
			const w = r.rewards;
			for (const line of ['catchXp', 'questXp', 'xp', 'questCash', 'catchValue']) {
				assert.equal(w[line].base + w[line].profileBonus, w[line].final, line);
				assert.ok(w[line].profileBonus >= 0, line);
			}
			assert.equal(w.xp.final, r.xp.total);
			assert.equal(w.catchXp.final, r.xp.catch);
			assert.equal(w.questCash.final, r.cash.total);
			assert.equal(w.catchValue.final, r.catches.filter((c) => c.kind === 'fish').reduce((s, c) => s + c.value * c.count, 0));
			for (const c of r.catches) assert.equal(c.reward.base + c.reward.profileBonus, c.reward.final);
			if (seed === 1) {
				await applyCastResult(r);
				for (const c of r.catches) assert.equal((await FishData.findById(c.id).lean()).value, c.reward.final);
			}
		}
	}
	finally {
		config.users.founders = [FOUNDER];
	}
	// Normal players: no profile bonus anywhere.
	await makeUser('recon-normal');
	await useTestRod('recon-normal', { capabilities: ['weak', '1'] });
	const n = await castLine({ userId: 'recon-normal' });
	for (const line of Object.values(n.rewards)) assert.equal(line.profileBonus, 0);
});

test('variable multi-catch keeps the old average (3 fish with the starter rod) and varies', () => {
	const founder = { name: 'founder', ...PROFILES.founder };
	const oldRod = { _id: 'r', name: 'Old Rod', type: 'rod', capabilities: ['weak', '1'], weights: NORMAL_RARITY_TABLE };
	const mods = resolveModifiers({ profile: founder, rod: oldRod });
	const r = createRng(2026);
	const n = 200_000;
	const counts = {};
	let total = 0;
	for (let i = 0; i < n; i++) {
		const { draws } = rollDraws(mods, r);
		counts[draws] = (counts[draws] || 0) + 1;
		total += draws;
	}
	const mean = total / n;
	// Standard deviation of the draw count is ~1.14; 5 sigma of the mean.
	assert.ok(Math.abs(mean - 3) < 5 * 1.14 / Math.sqrt(n), `mean ${mean}`);
	assert.deepEqual(Object.keys(counts).map(Number).sort(), [1, 2, 3, 4, 5]);
	const expected = { 1: 0.10, 2: 0.25, 3: 0.30, 4: 0.25, 5: 0.10 };
	for (const [k, p] of Object.entries(expected)) assert.ok(Math.abs(counts[k] / n - p) < 5 * Math.sqrt(p * (1 - p) / n), `P(${k})`);
});

test('Founder catches stay non-competitive', async () => {
	await makeUser(FOUNDER);
	await useTestRod(FOUNDER, { capabilities: ['weak', '1'] });
	const r = await castLine({ userId: FOUNDER });
	await applyCastResult(r);
	for (const c of r.catches) assert.equal((await FishData.findById(c.id).lean()).competitiveEligible, false);
});

test('Founder status shows only on your own profile', async () => {
	const founder = { id: FOUNDER, globalName: 'Casey', username: 'casey' };
	const member = { id: MEMBER, globalName: 'Pat', username: 'pat' };
	const own = interactionFor(founder, { target: founder });
	await profileCommand.run({}, own, null);
	const ownTitle = own.sent.find((s) => s.kind === 'edit').embeds[0].toJSON().title;
	assert.match(ownTitle, /Casey's Profile · 👑 Founder/);

	const viewed = interactionFor(member, { target: founder });
	await profileCommand.run({}, viewed, null);
	const publicTitle = viewed.sent.find((s) => s.kind === 'edit').embeds[0].toJSON().title;
	assert.equal(publicTitle, 'Casey\'s Profile');
});

test('/fishing-stats is private and holds the Founder breakdown; members see only their own odds', async () => {
	const founder = { id: FOUNDER, globalName: 'Casey', username: 'casey' };
	const fi = interactionFor(founder);
	await statsCommand.run({}, fi);
	assert.equal(fi.sent[0].kind, 'defer');
	assert.equal(fi.sent[0].ephemeral, true);
	const founderView = json(fi.sent.find((s) => s.kind === 'edit'));
	assert.match(founderView, /Founder/);
	assert.match(founderView, /XP ×5/);
	assert.match(founderView, /bonus\)/, 'last cast shows base + bonus');
	assert.ok(!/pity|castsSince/i.test(founderView), 'pity stays invisible');

	const member = { id: MEMBER, globalName: 'Pat', username: 'pat' };
	const mi = interactionFor(member);
	await statsCommand.run({}, mi);
	const memberView = json(mi.sent.find((s) => s.kind === 'edit'));
	assert.equal(mi.sent[0].ephemeral, true);
	assert.ok(!/Founder|bonus\)/.test(memberView));
	assert.match(memberView, /Standard · competitive/);
});
