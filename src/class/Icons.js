const { icons, types, placeholders } = require('../emojis');

// Application emojis owned by this bot, keyed by name. Filled by Icons.init() on clientReady.
const applicationEmojis = new Map();
let client = null;

/**
 * Resolves game icons to something Discord can always render. Never returns raw `:name:` text:
 * unavailable custom emojis fall back to Unicode. Configuration lives in src/emojis.js.
 */
class Icons {
	/** Loads this application's own emojis so uploaded artwork overrides the Unicode defaults. */
	static async init(discordClient) {
		// Required lazily: Utils itself depends on Icons.
		const { Utils } = require('./Utils');
		client = discordClient;
		try {
			const emojis = await discordClient.application.emojis.fetch();
			applicationEmojis.clear();
			emojis.forEach((emoji) => applicationEmojis.set(emoji.name, emoji));
			Utils.log(`Loaded ${applicationEmojis.size} application emoji(s) for icons.`, 'info');
		}
		catch (error) {
			Utils.log(`Could not load application emojis, using Unicode icons: ${error.message}`, 'warn');
		}
	}

	/** Splits a stored icon ('Sardine' or legacy 'Sardine:1244064605622501467') into key and id. */
	static parse(icon) {
		const data = typeof icon === 'string' ? icon : icon?.data;
		if (typeof data !== 'string' || data.trim() === '') return { key: null, id: null, animated: false };
		const [key, id] = data.split(':');
		return { key: key || null, id: id || null, animated: Boolean(icon?.animated) };
	}

	/**
	 * @returns {{ id?: string, name: string, animated?: boolean }} a component-ready emoji
	 * (custom when available, otherwise Unicode in `name`).
	 */
	static resolve(icon, type) {
		const { key, id } = Icons.parse(icon);

		if (key && applicationEmojis.has(key)) {
			const emoji = applicationEmojis.get(key);
			return { id: emoji.id, name: emoji.name, animated: emoji.animated };
		}
		const cached = id && client?.emojis.cache.get(id);
		if (cached?.available) {
			return { id: cached.id, name: cached.name, animated: cached.animated };
		}
		// Generic placeholder art (e.g. the old schema default 'old_rod' on a bait) only counts for its own types.
		const usable = key && icons[key] && (!placeholders[key] || placeholders[key].includes(type));
		return { name: (usable && icons[key]) || types[type] || types.default };
	}

	/** Inline string for an icon, e.g. in embed text. */
	static render(icon, type) {
		const emoji = Icons.resolve(icon, type);
		return emoji.id ? `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>` : emoji.name;
	}

	/** Inline string for a game object (fish, item, biome, season, weather...), using its own type as fallback. */
	static of(object) {
		if (!object) return '';
		const data = typeof object.toJSON === 'function' ? object.toJSON() : object;
		return Icons.render(data.icon, data.type);
	}

	/** Emoji for StringSelectMenuOptionBuilder#setEmoji / ButtonBuilder#setEmoji. */
	static component(object) {
		const data = typeof object?.toJSON === 'function' ? object.toJSON() : object;
		return Icons.resolve(data?.icon, data?.type);
	}
}

module.exports = { Icons };
