// Runtime configuration for the private DCC deployment (Railway).
// Every secret and ID is read from environment variables; nothing sensitive is hard-coded here.
const envList = (value) => (value || '').split(',').map((v) => v.trim()).filter(Boolean);
// Feature flags are OFF unless the variable is exactly one of these (case-insensitive); anything else,
// including unset, empty or a typo, is off.
const FLAG_ON = ['on', 'true', '1', 'yes'];
const envFlag = (value) => FLAG_ON.includes(String(value ?? '').trim().toLowerCase());

module.exports = {
	envFlag,
	client: {
		token: process.env.CLIENT_TOKEN,
		id: process.env.CLIENT_ID,
		topgg_token: process.env.TOPGG_TOKEN,
		analytics: process.env.ANALYTICS === 'true',
	},
	handler: {
		prefix: '?',
		deploy: process.env.DEPLOY_COMMANDS !== 'false',
		commands: {
			prefix: false,
			slash: true,
			user: false,
			message: false,
		},
		mongodb: {
			enabled: true,
			uri: process.env.MONGODB_URI,
		},
	},
	users: {
		developers: envList(process.env.DEVELOPER_IDS),
		// Boosted-gameplay accounts. Independent of DEVELOPER_IDS (command access).
		founders: envList(process.env.FOUNDER_IDS),
	},
	flags: {
		// Phase 5B balance release (BALANCE_5B). Read once at boot; every 5B code path asks
		// balance.isBalance5b(), never this field or the env var directly. Off = today's game.
		balance5b: envFlag(process.env.BALANCE_5B),
	},
	development: {
		// When GUILD_ID is set, slash commands are registered to that guild only (private deployment).
		enabled: Boolean(process.env.GUILD_ID),
		guild: process.env.GUILD_ID,
	},
	messageSettings: {
		nsfwMessage: 'The current channel is not a NSFW channel.',
		developerMessage: 'You are not authorized to use this command.',
		cooldownMessage: 'Slow down buddy! You\'re too fast to use this command ({cooldown}s).',
		globalCooldownMessage: 'Slow down buddy! This command is on a global cooldown ({cooldown}s).',
		notHasPermissionMessage: 'You do not have the permission to use this command.',
		notHasPermissionComponent: 'You do not have the permission to use this component.',
		missingDevIDsMessage: 'This is a developer only command, but unable to execute due to missing user IDs in configuration file.',
	},
};
