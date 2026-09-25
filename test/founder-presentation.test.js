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
	assert.match(founderView, /Base \d+ · Founder \+\d+ · Final \d+/, 'last cast shows base / Founder / final');
	assert.match(founderView, /Pity/, 'pity is visible privately to the Founder');

	const member = { id: MEMBER, globalName: 'Pat', username: 'pat' };
	const mi = interactionFor(member);
	await statsCommand.run({}, mi);
	const memberView = json(mi.sent.find((s) => s.kind === 'edit'));
	assert.equal(mi.sent[0].ephemeral, true);
	assert.ok(!/Founder|Base \d|Pity/.test(memberView));
	assert.match(memberView, /Standard · competitive/);
});

test('public /fish shows base XP while the account receives the Founder-adjusted XP', async () => {
	const founder = { id: FOUNDER, displayName: 'Casey', globalName: 'Casey', username: 'casey' };
	await useTestRod(FOUNDER, { capabilities: ['weak', '1'] });
	resetCooldowns();
	const { User: UserModel } = require('../src/schemas/UserSchema');
	const { Cast } = require('../src/schemas/CastSchema');
	const before = (await UserModel.findOne({ userId: FOUNDER }).lean()).xp;
	const fi = interactionFor(founder);
	await fishCommand.run({}, fi, null, founder);
	const cast = (await Cast.findOne({ userId: FOUNDER }).sort({ createdAt: -1 }).lean()).result;
	const card = fi.sent.find((s) => s.kind === 'followUp').embeds[0].toJSON();
	assert.match(card.description, new RegExp(`\\*\\*\\+${cast.rewards.catchXp.base} XP\\*\\*`));
	assert.ok(cast.rewards.catchXp.final > cast.rewards.catchXp.base);
	assert.ok(!card.description.includes(`+${cast.rewards.catchXp.final} XP`));
	const after = (await UserModel.findOne({ userId: FOUNDER }).lean()).xp;
	assert.equal(after - before, cast.rewards.xp.final, 'account gets the true final XP');
});

test('public sale shows the base value, the balance receives the final value, private view has both', async () => {
	const sellOneFish = require('../src/components/buttons/sell-one-fish');
	const { User: UserModel } = require('../src/schemas/UserSchema');
	await useTestRod(FOUNDER, { capabilities: ['weak', '1'] });
	const r = await castLine({ userId: FOUNDER });
	await applyCastResult(r);
	const base = r.rewards.catchValue.base;
	const final = r.rewards.catchValue.final;
	assert.equal(final, base + r.rewards.catchValue.profileBonus);
	assert.ok(final > base);

	const moneyBefore = (await UserModel.findOne({ userId: FOUNDER }).lean()).inventory.money;
	const calls = {};
	await sellOneFish.run({}, {
		user: { id: FOUNDER },
		message: { embeds: [{ data: { title: 'catch' }, toJSON() { return this.data; } }], components: [{ components: [{ type: 2, custom_id: 'a', style: 1, label: 'Fish again' }, { type: 2, custom_id: 'b', style: 4, label: 'Sell' }] }] },
		reply: async (p) => { calls.reply = p; },
		update: async (p) => { calls.update = p; },
	}, null, r.castId);
	const soldText = calls.update.embeds[0].toJSON().fields.at(-1).value;
	assert.equal(soldText, `You sold this catch for $${base.toLocaleString('en-US')}.`);
	const doc = await UserModel.findOne({ userId: FOUNDER }).lean();
	assert.equal(doc.inventory.money - moneyBefore, final, 'balance receives the true value');
	assert.equal(doc.stats.lastSale.base, base);
	assert.equal(doc.stats.lastSale.final, final);

	const fi = interactionFor({ id: FOUNDER, globalName: 'Casey', username: 'casey' });
	await statsCommand.run({}, fi);
	const view = json(fi.sent.find((s) => s.kind === 'edit'));
	assert.ok(view.includes(`Base $${base.toLocaleString('en-US')} · Founder +$${(final - base).toLocaleString('en-US')} · Final $${final.toLocaleString('en-US')}`), view);
	assert.equal(fi.sent[0].ephemeral, true);
});

test('public quest rewards show base amounts; the account gets the Founder amounts', async () => {
	const founder = { id: FOUNDER, displayName: 'Casey', globalName: 'Casey', username: 'casey' };
	await useTestRod(FOUNDER, { capabilities: ['weak', '1'] });
	await giveQuest(FOUNDER, { title: 'Public quest', progressMax: 1, xp: 20, cash: 9 });
	resetCooldowns();
	const fi = interactionFor(founder);
	await fishCommand.run({}, fi, null, founder);
	const card = fi.sent.find((s) => s.kind === 'followUp').embeds[0].toJSON();
	const quest = card.fields.find((f) => /Quest/.test(f.name)).value;
	assert.match(quest, /\+20 XP · \+\$9/);
	assert.ok(!/\+100 XP|\$45/.test(quest));
});
