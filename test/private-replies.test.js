// Hotfix L4: personal commands reply privately (ephemeral) for everyone; /profile stays public and never
// shows Founder status. Behaviour is identical for every profile, Founder or not.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser, giveFish } = require('./helpers/fixtures');
const { giveBox } = require('./helpers/gachaFixtures');
const { Fish } = require('../src/schemas/FishSchema');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { resetCooldowns } = require('../src/engine/cooldown');
const { rng } = require('../src/engine/rng');
const config = require('../src/config');
const buttonPagination = require('../src/buttonPagination');
const profileCommand = require('../src/commands/slash/User/profile.js');
const inventoryCommand = require('../src/commands/slash/User/inventory.js');
const statsCommand = require('../src/commands/slash/User/stats.js');
const collectionCommand = require('../src/commands/slash/User/collection.js');
const balanceCommand = require('../src/commands/slash/Economy/balance.js');
const infoCommand = require('../src/commands/slash/Info/info.js');
const openCommand = require('../src/commands/slash/Economy/open.js');

const isEphemeral = (s) => Boolean((s?.flags ?? 0) & MessageFlags.Ephemeral);
const saved = { founders: config.users.founders };
const FOUNDER = '7101';
const MEMBER = '7202';
const PEOPLE = {
	[FOUNDER]: { id: FOUNDER, globalName: 'Casey', username: 'casey' },
	[MEMBER]: { id: MEMBER, globalName: 'Pat', username: 'pat' },
};

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
	config.users.founders = [FOUNDER];
	const fishName = (await Fish.findOne({ user: null }).lean()).name;
	for (const id of [FOUNDER, MEMBER]) {
		const u = await makeUser(id);
		await giveFish(u, fishName);
		// /collection lists caught species from stats.fishStats.
		await UserModel.updateOne({ userId: id }, { $set: { [`stats.fishStats.${fishName.toLowerCase()}`]: 1, 'stats.fishCaught': 1 } });
	}
});
test.after(async () => {
	config.users.founders = saved.founders;
	rng.reset();
	await stopDb();
	restore();
});

// Discord interaction stand-in: records every send and exposes the component collectors it creates.
function interactionFor(user, { target = user, subcommand, name } = {}) {
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
	return {
		sent,
		collectors,
		message,
		user,
		channel: { id: 'chan' },
		guild: { id: 'guild' },
		options: { getUser: () => target, getSubcommand: () => subcommand, getString: () => name },
		deferReply: async (opts) => { sent.push({ kind: 'defer', ...(opts || {}) }); },
		reply: async (p) => { sent.push({ kind: 'reply', ...p }); },
		editReply: async (p) => { sent.push({ kind: 'edit', ...p }); return message; },
		followUp: async (p) => { sent.push({ kind: 'followUp', ...p }); return message; },
	};
}

/** The first message the bot creates (a defer or a direct reply) decides who can see the reply. */
const opening = (i) => i.sent.find((s) => s.kind === 'defer' || s.kind === 'reply');

const PRIVATE = [
	['/inventory', (i) => inventoryCommand.run({}, i, null)],
	['/stats', (i) => statsCommand.run({}, i, null)],
	['/collection', (i) => collectionCommand.run({}, i, null)],
	['/balance', (i) => balanceCommand.run({}, i, null)],
];

for (const [label, run] of PRIVATE) {
	test(`${label} replies ephemerally for every profile`, async () => {
		for (const id of [FOUNDER, MEMBER]) {
			const i = interactionFor(PEOPLE[id]);
			await run(i);
			assert.ok(opening(i), `${label} sends something (${id})`);
			assert.ok(isEphemeral(opening(i)), `${label} defer is ephemeral (${id})`);
			for (const s of i.sent.filter((x) => x.kind === 'reply' || x.kind === 'followUp')) {
				assert.ok(isEphemeral(s), `${label} ${s.kind} is ephemeral (${id})`);
			}
			assert.ok(i.sent.some((s) => s.kind === 'edit' || s.kind === 'followUp'), `${label} shows content (${id})`);
		}
	});
}

test('/info rod replies ephemerally for every profile; the public info subcommands are unchanged', async () => {
	for (const id of [FOUNDER, MEMBER]) {
		const i = interactionFor(PEOPLE[id], { subcommand: 'rod' });
		await infoCommand.run({}, i, null);
		const reply = i.sent.find((s) => s.kind === 'reply');
		assert.ok(reply?.embeds?.length, `rod reply sent (${id})`);
		assert.ok(isEphemeral(reply), `rod reply is ephemeral (${id})`);
	}
	const src = require('fs').readFileSync(require.resolve('../src/commands/slash/Info/info.js'), 'utf8');
	assert.equal((src.match(/interaction\.reply\(\{ embeds: \[embed\] \}\)/g) || []).length, 2, 'weather + season stay public');
});

test('/profile stays public and never contains Founder status (own profile or viewed by others)', async () => {
	for (const [viewer, target] of [[FOUNDER, FOUNDER], [MEMBER, FOUNDER], [MEMBER, MEMBER]]) {
		const i = interactionFor(PEOPLE[viewer], { target: PEOPLE[target] });
		await profileCommand.run({}, i, null);
		assert.equal(opening(i).kind, 'defer');
		assert.ok(!i.sent.some(isEphemeral), '/profile is public');
		const shown = JSON.stringify(i.sent.filter((s) => s.kind === 'edit').map((s) => s.embeds.map((e) => e.toJSON())));
		assert.ok(!/founder|👑/i.test(shown), shown);
	}
});

test('/open: the reveal and every "Open another" reveal are ephemeral, and the button still works', async () => {
	for (const id of [FOUNDER, MEMBER]) {
		resetCooldowns();
		await giveBox(id, 'Daily Box', 2);
		const i = interactionFor(PEOPLE[id], { name: 'Daily Box' });
		await openCommand.run({}, i, null);
		assert.ok(isEphemeral(opening(i)), `first reveal deferred ephemerally (${id})`);
		const reveal = i.sent.find((s) => s.kind === 'edit');
		assert.ok(reveal.embeds?.length, 'reveal shown');
		const againId = reveal.components[0].toJSON().components[0].custom_id;
		assert.equal(againId, 'open-again:Daily Box');

		// Click 'Open another': the collector (bound to the ephemeral message) re-enters /open with the button.
		const [collector] = i.collectors;
		assert.ok(collector?.handlers.collect, 'Open another collector registered');
		const click = interactionFor(PEOPLE[id]);
		click.customId = againId;
		await collector.handlers.collect(click);
		assert.ok(isEphemeral(opening(click)), `"Open another" reveal is ephemeral (${id})`);
		assert.ok(click.sent.find((s) => s.kind === 'edit').embeds?.length, 'second reveal shown');
		assert.ok(!click.sent.some((s) => s.kind === 'reply' || s.kind === 'followUp'), 'no public follow-ups');

		// Collector end clears the button through the interaction webhook (works for ephemeral messages).
		await collector.handlers.end();
		assert.deepEqual(i.sent.at(-1), { kind: 'edit', components: [] });
		assert.equal(i.message.edits.length, 0, 'never Message#edit on an ephemeral message');
	}
});

test('buttonPagination: privateReply option defers privately and pages via interaction.editReply; default stays public', async () => {
	const { EmbedBuilder } = require('discord.js');
	const pages = [new EmbedBuilder().setTitle('one'), new EmbedBuilder().setTitle('two')];

	const priv = interactionFor(PEOPLE[MEMBER]);
	await buttonPagination(priv, pages, null, false, [], undefined, { privateReply: true });
	assert.ok(isEphemeral(priv.sent[0]));
	const [pc] = priv.collectors;
	await pc.handlers.collect({ user: PEOPLE[MEMBER], customId: 'next', deferUpdate: async () => undefined });
	await pc.handlers.end();
	assert.equal(priv.message.edits.length, 0, 'ephemeral pages are never edited with Message#edit');
	const edits = priv.sent.filter((s) => s.kind === 'edit');
	assert.equal(edits.length, 3, 'initial + next + end');
	assert.equal(edits[1].embeds[0].toJSON().title, 'two');

	const pub = interactionFor(PEOPLE[MEMBER]);
	await buttonPagination(pub, pages, null);
	assert.ok(!isEphemeral(pub.sent[0]), 'default is public');
	const [uc] = pub.collectors;
	await uc.handlers.collect({ user: PEOPLE[MEMBER], customId: 'next', deferUpdate: async () => undefined });
	assert.equal(pub.message.edits.length, 1, 'public pages keep Message#edit');
});
