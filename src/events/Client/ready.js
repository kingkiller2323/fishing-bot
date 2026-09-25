const { Utils } = require('../../class/Utils');

module.exports = {
	// 'ready' is deprecated in discord.js v14.22+ in favour of 'clientReady' (Events.ClientReady).
	event: 'clientReady',
	once: true,
	/**
     *
     * @param {ExtendedClient} _
     * @param {import('discord.js').Client<true>} client
     * @returns
     */
	run: async (_, client) => {
		// Static game data (seasons, weather, fish, items, quests) is seeded by src/bootstrap
		// before login, so there is nothing left to initialize here.
		Utils.log('Logged in as: ' + client.user.tag, 'done');
	},
};
