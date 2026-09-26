// /biome and /start-quest menus act on the invoker's account, so only the invoker may use them.
// Drives the commands through discord.js's real InteractionCollector with a fake client/interactions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ComponentType, InteractionType, InteractionCollector, Events, MessageFlags } = require('discord.js');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser, reload } = require('./helpers/fixtures');
const { Biome } = require('../src/schemas/BiomeSchema');
const { Quest: QuestSchema } = require('../src/schemas/QuestSchema');
const biomeCommand = require('../src/commands/slash/Fish/biome.js');
const startQuestCommand = require('../src/commands/slash/User/startQuest.js');

const INVOKER = '7001';
const BYSTANDER = '7002';
const isEphemeral = (payload) => Boolean((payload?.flags ?? 0) & MessageFlags.Ephemeral);

function fakeClient() {
	const client = new EventEmitter();
	client.incrementMaxListeners = () => client.setMaxListeners(client.getMaxListeners() + 1);
	client.decrementMaxListeners = () => client.setMaxListeners(Math.max(client.getMaxListeners() - 1, 0));
	client.channels = { resolveId: () => null };
	client.guilds = { resolveId: () => null };
	return client;
}

/** Runs a command whose reply carries a select menu; returns a way to click it as any user. */
async function openMenu(command, invokerId) {
	const client = fakeClient();
	const collectors = [];
	const message = {
		id: 'menu-message',
		channelId: 'channel-1',
		guildId: 'guild-1',
		createMessageComponentCollector(options) {
			const collector = new InteractionCollector(client, { ...options, message: this });
			collectors.push(collector);
			return collector;
		},
		edit: async () => message,
	};
	const interaction = {
		user: { id: invokerId, toString: () => `<@${invokerId}>` },
		reply: async () => message,
	};
	await command.run(client, interaction, null);
	assert.equal(collectors.length, 1, 'command should open exactly one collector');

	let n = 0;
	const select = (userId, value) => new Promise((resolve) => {
		const replies = [];
		const click = {
			id: `click-${++n}`,
			type: InteractionType.MessageComponent,
			componentType: ComponentType.StringSelect,
			message: { id: message.id },
			channelId: message.channelId,
			guildId: message.guildId,
			user: { id: userId, toString: () => `<@${userId}>` },
			values: [value],
			reply: async (payload) => {
				replies.push(typeof payload === 'string' ? { content: payload } : payload);
				resolve(replies);
			},
		};
		client.emit(Events.InteractionCreate, click);
	});
	const close = () => collectors.forEach((c) => c.stop('test'));
	return { select, close };
}

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
});

test.after(async () => {
	await stopDb();
	restore();
});

test('/biome: a bystander\'s selection is ignored; the invoker\'s switches the invoker', async () => {
	const invoker = await makeUser(INVOKER);
	const bystander = await makeUser(BYSTANDER);
	await invoker.setCurrentBiome('swamp');
	await bystander.setCurrentBiome('swamp');
	const ocean = await Biome.findOne({ name: 'Ocean' });

	const menu = await openMenu(biomeCommand, INVOKER);
	try {
		const [bystanderReply] = await menu.select(BYSTANDER, ocean._id.toString());
		assert.ok(isEphemeral(bystanderReply), 'bystander gets a private "not yours" reply');
		assert.match(bystanderReply.content, /not yours/i);
		assert.equal(await (await reload(invoker)).getCurrentBiome(), 'swamp', 'bystander click must not move the invoker');
		assert.equal(await (await reload(bystander)).getCurrentBiome(), 'swamp');

		const [invokerReply] = await menu.select(INVOKER, ocean._id.toString());
		assert.ok(!isEphemeral(invokerReply));
		assert.match(invokerReply.content, /switched to the \*\*Ocean\*\*/);
		assert.equal(await (await reload(invoker)).getCurrentBiome(), 'Ocean');
		assert.equal(await (await reload(bystander)).getCurrentBiome(), 'swamp');
	}
	finally {
		menu.close();
	}
});

test('/start-quest: a bystander\'s selection is ignored; the invoker\'s starts the quest for the invoker', async () => {
	const quest = await QuestSchema.findOne({ title: 'Catch 15 Trout', daily: false });
	assert.ok(quest, 'seeded quest exists');
	const invokerId = '7101';
	const bystanderId = '7102';
	await makeUser(invokerId);
	await makeUser(bystanderId);
	const questTitles = async (id) => (await (await makeUser(id)).getQuests()).map((q) => q.title);

	const menu = await openMenu(startQuestCommand, invokerId);
	try {
		const [bystanderReply] = await menu.select(bystanderId, quest._id.toString());
		assert.ok(isEphemeral(bystanderReply), 'bystander gets a private "not yours" reply');
		assert.match(bystanderReply.content, /not yours/i);
		assert.deepEqual(await questTitles(invokerId), [], 'bystander click must not start a quest on the invoker');
		assert.deepEqual(await questTitles(bystanderId), []);

		const [invokerReply] = await menu.select(invokerId, quest._id.toString());
		assert.ok(!isEphemeral(invokerReply));
		assert.match(invokerReply.content, /started quest \*\*Catch 15 Trout\*\*/);
		assert.deepEqual(await questTitles(invokerId), ['Catch 15 Trout']);
		assert.deepEqual(await questTitles(bystanderId), []);
	}
	finally {
		menu.close();
	}
});
