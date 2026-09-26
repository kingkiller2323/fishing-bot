// Phase 5B step B1: privacy closure (/sell, /boosters) and /dev founder hardening (P-FOUNDER-DEV-OVERRIDE).
//
// Locked semantics: identity comes only from FOUNDER_IDS. A profile override changes cast mechanics only:
// a real Founder is never competitive and its gates never follow the override (today they read the real
// level for everyone; step C moves the Founder branch to the public level with P-FOUNDER-GATE). /dev founder
// 'on' is refused for a non-Founder; a non-Founder returning to Normal gets publicXp = xp back, audited.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser, giveFish } = require('./helpers/fixtures');
const { addPoolFish, useTestRod, userDoc } = require('./helpers/castFixtures');
const { castLine } = require('../src/engine/cast');
const dev = require('../src/engine/dev');
const { resolveProfile, isFounderId } = require('../src/engine/balance');
const { gateLevelOf, checkLevelGate } = require('../src/engine/levelGate');
const { levelOf } = require('../src/engine/levels');
const { publicLevelOf } = require('../src/engine/publicLevel');
const { User } = require('../src/class/User');
const { Fish: FishClass } = require('../src/class/Fish');
const { FishData } = require('../src/schemas/FishSchema');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { DevAudit } = require('../src/schemas/DevAuditSchema');
const { resetCooldowns } = require('../src/engine/cooldown');
const config = require('../src/config');
const sellCommand = require('../src/commands/slash/Fish/sell.js');
const boostersCommand = require('../src/commands/slash/User/boosters.js');
const sellOneFish = require('../src/components/buttons/sell-one-fish.js');

const FOUNDER = 'b1-founder';
const saved = { founders: config.users.founders, developers: config.users.developers };
const isEphemeral = (s) => Boolean((s?.flags ?? 0) & MessageFlags.Ephemeral);

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
	await addPoolFish([{ name: 'Pool Minnow', rarity: 'Common' }]);
	config.users.founders = [FOUNDER];
	config.users.developers = ['dev'];
});
test.after(async () => {
	Object.assign(config.users, saved);
	resetCooldowns();
	await stopDb();
	restore();
});

/** A Founder with real Lv 15 (22,500 XP) and public Lv 7 (4,900 publicXp), floors written by step A. */
async function founderAccount() {
	await makeUser(FOUNDER);
	await useTestRod(FOUNDER, { capabilities: ['weak', '1'] });
	await UserModel.updateOne({ userId: FOUNDER }, { $set: { xp: 22500, publicXp: 4900, level: 15, levelFloor: 15, publicLevelFloor: 7 }, $unset: { devOverrides: 1 } });
	return userDoc(FOUNDER);
}

// ---------- Founder identity: competitive eligibility ----------

test('a real Founder stays non-competitive under every override (default, off, test)', async () => {
	await founderAccount();
	for (const mode of ['default', 'off', 'test']) {
		await dev.founder('dev', FOUNDER, mode);
		const r = await castLine({ userId: FOUNDER });
		assert.equal(r.status, 'ok', mode);
		assert.equal(r.competitiveEligible, false, `Founder ${mode}: cast non-competitive`);
		assert.equal(resolveProfile(FOUNDER, await userDoc(FOUNDER)).competitiveEligible, false, `Founder ${mode}: profile non-competitive`);
	}
	// 'off' still makes the cast mechanics Normal (the tool keeps working for testing).
	await dev.founder('dev', FOUNDER, 'off');
	assert.equal((await castLine({ userId: FOUNDER })).profile, 'normal');
	await dev.founder('dev', FOUNDER, 'default');
	assert.equal((await castLine({ userId: FOUNDER })).profile, 'founder');
});

test('Founder identity comes from FOUNDER_IDS only, never from the profile override', async () => {
	await founderAccount();
	for (const mode of ['off', 'test', 'default']) {
		await dev.founder('dev', FOUNDER, mode);
		assert.equal(resolveProfile(FOUNDER, await userDoc(FOUNDER)).founderIdentity, true, mode);
	}
	await makeUser('b1-plain');
	await dev.founder('dev', 'b1-plain', 'test');
	const p = resolveProfile('b1-plain', await userDoc('b1-plain'));
	assert.equal(p.founderIdentity, false);
	assert.equal(isFounderId('b1-plain'), false);
	// Normal players are unchanged: competitive as before.
	await dev.founder('dev', 'b1-plain', 'default');
	assert.equal(resolveProfile('b1-plain', await userDoc('b1-plain')).competitiveEligible, true);
});

// ---------- Founder identity: gate level ----------

test('/dev founder off/test cannot change a Founder\'s gate level; B1 keeps its current real-level access', async () => {
	const doc = await founderAccount();
	assert.equal(levelOf(doc), 15);
	assert.equal(publicLevelOf(doc), 7);
	const gatedLv10 = { requirements: { level: 10 } };
	for (const mode of ['default', 'off', 'test']) {
		await dev.founder('dev', FOUNDER, mode);
		const d = await userDoc(FOUNDER);
		// B1: the Founder branch is the real level (15). Step C switches it to the public level (P-FOUNDER-GATE).
		assert.equal(gateLevelOf(d), 15, `Founder ${mode}: gate level`);
		const gate = await checkLevelGate(new User(await User.get(FOUNDER)), gatedLv10);
		assert.equal(gate.ok, true, `Founder ${mode}: a Lv 10 item stays allowed`);
		assert.equal(await new User(await User.get(FOUNDER)).getGateLevel(), 15);
	}
	await dev.founder('dev', FOUNDER, 'default');
});

test('non-Founders gate exactly as before: the real level, whatever the override', async () => {
	await makeUser('b1-gates');
	await UserModel.updateOne({ userId: 'b1-gates' }, { $set: { xp: 3600, publicXp: 3600, level: 6, levelFloor: 6, publicLevelFloor: 6 } });
	for (const mode of ['default', 'test', 'off']) {
		await dev.founder('dev', 'b1-gates', mode);
		const d = await userDoc('b1-gates');
		assert.equal(gateLevelOf(d), levelOf(d));
		assert.equal(gateLevelOf(d), 6);
	}
});

// ---------- /dev founder on and the Normal invariant ----------

test('/dev founder on is refused for a non-Founder and changes nothing (no write, no audit)', async () => {
	await makeUser('b1-member');
	await UserModel.updateOne({ userId: 'b1-member' }, { $set: { xp: 900, publicXp: 900 } });
	const before = await userDoc('b1-member');
	const audits = await DevAudit.countDocuments({ target: 'b1-member' });
	await assert.rejects(dev.founder('dev', 'b1-member', 'on'), (e) => e.code === 'NOT_FOUNDER' && /only for FOUNDER_IDS/.test(e.message) && /test/.test(e.message));
	const after = await userDoc('b1-member');
	assert.deepEqual(after, before);
	assert.equal(await DevAudit.countDocuments({ target: 'b1-member' }), audits);
	// 'on' still works for the real Founder.
	await founderAccount();
	assert.equal((await dev.founder('dev', FOUNDER, 'on')).after, 'founder');
	await dev.founder('dev', FOUNDER, 'default');
});

test('non-Founder test -> default restores publicXp == xp and a coherent public floor, audited', async () => {
	await makeUser('b1-gap');
	await dev.founder('dev', 'b1-gap', 'test');
	// A publicXp gap left by an earlier developer override (e.g. the old non-Founder 'on').
	await UserModel.updateOne({ userId: 'b1-gap' }, { $set: { xp: 10000, publicXp: 2500, level: 10, levelFloor: 10, publicLevelFloor: 5 } });
	const r = await dev.founder('dev', 'b1-gap', 'default');
	const d = await userDoc('b1-gap');
	assert.equal(d.publicXp, d.xp);
	assert.equal(d.publicLevelFloor, 10);
	assert.equal(publicLevelOf(d), levelOf(d));
	assert.equal(d.devOverrides?.profile, undefined);
	assert.deepEqual(r.repair, { publicXp: { before: 2500, after: 10000 }, publicLevelFloor: { before: 5, after: 10 } });
	const audit = await DevAudit.findOne({ target: 'b1-gap', operation: 'founder' }).sort({ timestamp: -1 }).lean();
	assert.equal(audit.details.mode, 'default');
	assert.deepEqual(audit.details.repair, r.repair);
	// 'off' repairs the same way; nothing to repair -> no repair recorded.
	await UserModel.updateOne({ userId: 'b1-gap' }, { $set: { publicXp: 9000 } });
	assert.equal((await dev.founder('dev', 'b1-gap', 'off')).repair.publicXp.after, 10000);
	assert.equal((await dev.founder('dev', 'b1-gap', 'default')).repair, null);
});

test('a real Founder\'s publicXp is never touched by /dev founder', async () => {
	const before = await founderAccount();
	for (const mode of ['off', 'test', 'on', 'default']) {
		const r = await dev.founder('dev', FOUNDER, mode);
		assert.equal(r.repair, null, mode);
		const d = await userDoc(FOUNDER);
		assert.equal(d.publicXp, before.publicXp, mode);
		assert.equal(d.publicLevelFloor, before.publicLevelFloor, mode);
	}
});

test('every /dev founder change is audited with before and after', async () => {
	await makeUser('b1-audit');
	const start = await DevAudit.countDocuments({ target: 'b1-audit', operation: 'founder' });
	await dev.founder('dev', 'b1-audit', 'test');
	await dev.founder('dev', 'b1-audit', 'off');
	await dev.founder('dev', 'b1-audit', 'default');
	const rows = await DevAudit.find({ target: 'b1-audit', operation: 'founder' }).sort({ timestamp: 1 }).lean();
	assert.equal(rows.length - start, 3);
	assert.deepEqual(rows.slice(-3).map((a) => [a.actor, a.before.profile, a.after.profile, a.details.mode]), [
		['dev', 'default', 'test', 'test'], ['dev', 'test', 'normal', 'off'], ['dev', 'normal', 'default', 'default'],
	]);
	await assert.rejects(dev.founder('not-a-dev', 'b1-audit', 'test'), { code: 'NOT_DEVELOPER' });
});

// ---------- Privacy: /sell and /boosters ----------

function interactionFor(user, { rarity } = {}) {
	const sent = [];
	const collectors = [];
	const message = {
		edits: [],
		edit: async (p) => { message.edits.push(p); },
		createMessageComponentCollector: () => {
			const handlers = {};
			const c = { handlers, on: (ev, fn) => { handlers[ev] = fn; }, resetTimer: () => undefined };
			collectors.push(c);
			return c;
		},
	};
	const i = {
		sent, collectors, message, user, channel: { id: 'chan' }, guild: { id: 'guild' }, deferred: false, replied: false,
		options: { getString: () => rarity, getUser: () => null },
		deferReply: async (opts) => { i.deferred = true; sent.push({ kind: 'defer', ...(opts || {}) }); },
		reply: async (p) => { i.replied = true; sent.push({ kind: 'reply', ...p }); },
		editReply: async (p) => { sent.push({ kind: 'edit', ...p }); return message; },
		followUp: async (p) => { sent.push({ kind: 'followUp', ...p }); return message; },
	};
	return i;
}

const opening = (i) => i.sent.find((s) => s.kind === 'defer' || s.kind === 'reply');
function assertPrivate(i, label) {
	assert.ok(opening(i), `${label}: something was sent`);
	assert.ok(isEphemeral(opening(i)), `${label}: the first response is ephemeral`);
	for (const s of i.sent.filter((x) => x.kind === 'reply' || x.kind === 'followUp')) assert.ok(isEphemeral(s), `${label}: ${s.kind} is ephemeral`);
	assert.equal(i.message.edits.length, 0, `${label}: never edits a public message`);
}

test('/sell is private on success, on invalid input and when the sale fails', async () => {
	for (const id of [FOUNDER, 'b1-seller']) {
		const u = await makeUser(id);
		const fishName = (await (require('../src/schemas/FishSchema').Fish).findOne({ user: null, rarity: 'Common' }).lean()).name;
		await giveFish(u, fishName, { value: 40 });
		const ok = interactionFor({ id, username: id }, { rarity: 'all' });
		await sellCommand.run({}, ok, null);
		assertPrivate(ok, `/sell success (${id})`);
		assert.match(ok.sent.find((s) => s.kind === 'edit').embeds[0].data.title, /Fish Sold/);

		const bad = interactionFor({ id, username: id }, { rarity: 'not-a-rarity' });
		await sellCommand.run({}, bad, null);
		assertPrivate(bad, `/sell invalid (${id})`);
		assert.match(bad.sent.find((s) => s.kind === 'edit').embeds[0].data.title, /Invalid Input/);
	}
	const original = FishClass.sellByRarity;
	FishClass.sellByRarity = async () => { throw new Error('Inventory changed while selling; nothing was paid out.'); };
	try {
		const err = interactionFor({ id: 'b1-seller', username: 'seller' }, { rarity: 'all' });
		await sellCommand.run({}, err, null);
		assertPrivate(err, '/sell error');
		const edit = err.sent.find((s) => s.kind === 'edit');
		assert.match(edit.embeds[0].data.title, /Sale Failed/);
		assert.match(edit.embeds[0].data.description, /Inventory changed/);
	}
	finally {
		FishClass.sellByRarity = original;
	}
});

test('/boosters is private: the first page and every page button', async () => {
	for (const id of [FOUNDER, 'b1-boost']) {
		await makeUser(id);
		const i = interactionFor({ id, username: id });
		await boostersCommand.run({}, i, null);
		assertPrivate(i, `/boosters (${id})`);
		assert.equal(i.collectors.length, 1, 'two pages: page buttons are live');
		const collector = i.collectors[0];
		for (const customId of ['next', 'prev', 'home']) await collector.handlers.collect({ user: { id }, customId, deferUpdate: async () => undefined });
		await collector.handlers.end();
		// Initial page + 3 button pages + end: all through the ephemeral interaction, never the public message.
		assert.equal(i.sent.filter((s) => s.kind === 'edit').length, 5);
		assertPrivate(i, `/boosters paging (${id})`);
		// Someone else pressing the buttons gets a private refusal.
		const other = [];
		await collector.handlers.collect({ user: { id: 'someone-else' }, customId: 'next', reply: async (p) => { other.push(p); } });
		assert.ok(other.length === 1 && isEphemeral(other[0]));
	}
});

// ---------- The catch-card Sell button is unchanged ----------

test('catch-card Sell still updates the public card with the base amount; the balance receives the final value', async () => {
	const u = await makeUser('b1-card');
	const fishName = (await (require('../src/schemas/FishSchema').Fish).findOne({ user: null, rarity: 'Common' }).lean()).name;
	const f = await giveFish(u, fishName, { value: 500 });
	await FishData.updateOne({ _id: f._id }, { $set: { castId: 'b1-cast', valueBase: 50 } });
	const moneyBefore = (await userDoc('b1-card')).inventory.money;
	const calls = {};
	const interaction = {
		user: { id: 'b1-card' },
		message: {
			embeds: [{ data: { title: 'catch', description: 'x' }, toJSON() { return this.data; } }],
			components: [{ components: [{ type: 2, custom_id: 'fish-again', style: 1, label: 'Fish again' }, { type: 2, custom_id: 'sell', style: 4, label: 'Sell' }] }],
		},
		reply: async (p) => { calls.reply = p; },
		update: async (p) => { calls.update = p; },
	};
	await sellOneFish.run({}, interaction, null, 'b1-cast');
	assert.equal(calls.reply, undefined, 'no separate (ephemeral) reply');
	assert.ok(calls.update, 'the public catch card is updated in place');
	const sold = calls.update.embeds[0].data.fields.find((x) => /Sold/.test(x.name));
	assert.match(sold.value, /\$50\b/);
	assert.equal((await userDoc('b1-card')).inventory.money - moneyBefore, 500);
});
