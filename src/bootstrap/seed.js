// Idempotent seeding of the static FishingRPG catalog.
//
// Every step inserts only the documents whose natural key is missing, so running the
// bootstrap on every deploy is safe: existing catalog rows are never modified or duplicated,
// and user/progression collections (users, *datas, pets, habitats, guilds, ponds, codes,
// interactions, commands) are never touched.
const { Utils } = require('../class/Utils');
const { WeatherType } = require('../schemas/WeatherTypeSchema');
const { Season } = require('../schemas/SeasonSchema');
const { Biome } = require('../schemas/BiomeSchema');
const { Fish } = require('../schemas/FishSchema');
const { Item } = require('../schemas/ItemSchema');
const { Rod } = require('../schemas/RodSchema');
const { Bait } = require('../schemas/BaitSchema');
const { Buff } = require('../schemas/BuffSchema');
const { License } = require('../schemas/LicenseSchema');
const { Gacha } = require('../schemas/GachaSchema');
const { Quest } = require('../schemas/QuestSchema');

const log = (message, style = 'info') => Utils.log(`[BOOTSTRAP] ${message}`, style);

// Catalog rows have no owner; user-owned copies carry a `user` field.
const CATALOG = { user: null };
const FISH_DEFAULTS = { weather: 'all', season: 'all' };

/**
 * Seed order. Each step only depends on steps above it:
 *  weatherTypes -> seasons (commonWeatherTypes) -> biomes -> fish (biome/season/weather names)
 *  -> rods/rodParts/bait/buffs/licenses -> gacha (draws from those item types) -> quests (reward items)
 */
const STEPS = [
	{
		name: 'weatherTypes',
		model: WeatherType,
		keyFields: ['weather'],
		scope: { type: 'weather' },
		docs: () => require('./data/weatherTypes'),
	},
	{
		name: 'seasons',
		model: Season,
		keyFields: ['season'],
		scope: { type: 'season' },
		docs: () => require('./data/seasons').map((s) => ({ ...s, type: 'season', active: false })),
	},
	{
		name: 'biomes',
		model: Biome,
		keyFields: ['name'],
		docs: () => require('./data/biomes'),
	},
	{
		name: 'baseFish',
		model: Fish,
		keyFields: ['name', 'biome', 'weather', 'season'],
		defaults: FISH_DEFAULTS,
		scope: CATALOG,
		docs: () => require('./data/baseFish')(),
	},
	{
		name: 'seasonalFish',
		model: Fish,
		keyFields: ['name', 'biome', 'weather', 'season'],
		defaults: FISH_DEFAULTS,
		scope: CATALOG,
		docs: () => require('./data/seasonalFish'),
	},
	{
		name: 'weatherFish',
		model: Fish,
		keyFields: ['name', 'biome', 'weather', 'season'],
		defaults: FISH_DEFAULTS,
		scope: CATALOG,
		docs: () => require('./data/weatherFish'),
	},
	// Items share the `items` collection (Mongoose discriminators); names are unique across it.
	{
		name: 'rods',
		model: Rod,
		lookup: Item,
		keyFields: ['name'],
		scope: CATALOG,
		docs: () => require('./data/rods'),
	},
	{
		name: 'rodParts',
		model: Item,
		lookup: Item,
		keyFields: ['name'],
		scope: CATALOG,
		docs: () => require('./data/rodParts'),
	},
	{
		name: 'bait',
		model: Bait,
		lookup: Item,
		keyFields: ['name'],
		scope: CATALOG,
		docs: () => require('./data/bait'),
	},
	{
		name: 'buffs',
		model: Buff,
		lookup: Item,
		keyFields: ['name'],
		scope: CATALOG,
		docs: () => require('./data/buffs'),
	},
	{
		name: 'licenses',
		model: License,
		lookup: Item,
		keyFields: ['name'],
		scope: CATALOG,
		docs: () => require('./data/licenses'),
	},
	{
		name: 'gacha',
		model: Gacha,
		lookup: Item,
		keyFields: ['name'],
		scope: CATALOG,
		docs: () => require('./data/gacha'),
	},
	{
		name: 'quests',
		model: Quest,
		keyFields: ['title'],
		scope: CATALOG,
		docs: () => require('./data/quests'),
		prepare: resolveQuestRewards,
	},
];

const keyOf = (step, doc) => {
	const withDefaults = { ...(step.defaults || {}), ...doc };
	return step.keyFields.map((field) => String(withDefaults[field] ?? '')).join(' | ');
};

async function existingKeys(step) {
	const lookup = step.lookup || step.model;
	const rows = await lookup.find(step.scope || {}).select(step.keyFields.join(' ')).lean();
	const counts = new Map();
	for (const row of rows) {
		const key = keyOf(step, row);
		counts.set(key, (counts.get(key) || 0) + 1);
	}
	return counts;
}

// Quest rewards are declared by item name in the seed data and stored as ObjectIds.
async function resolveQuestRewards(docs) {
	return Promise.all(docs.map(async ({ rewardItems = [], ...quest }) => {
		const reward = [...(quest.reward || [])];
		for (const itemName of rewardItems) {
			const item = await Item.findOne({ name: itemName, ...CATALOG }).select('_id').lean();
			if (item) reward.push(item._id);
			else log(`Quest "${quest.title}": reward item "${itemName}" is not in the catalog; quest seeded without it.`, 'warn');
		}
		return { ...quest, reward };
	}));
}

async function runStep(step) {
	const docs = step.docs();
	const have = await existingKeys(step);

	const seen = new Set();
	let missing = docs.filter((doc) => {
		const key = keyOf(step, doc);
		if (have.has(key) || seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	if (missing.length > 0) {
		if (step.prepare) missing = await step.prepare(missing);
		await step.model.insertMany(missing, { ordered: true });
	}

	const duplicates = [...have.entries()].filter(([, count]) => count > 1).map(([key]) => key);
	if (duplicates.length > 0) {
		log(`${step.name}: ${duplicates.length} key(s) have duplicate rows in the database: ${duplicates.slice(0, 5).join(', ')}${duplicates.length > 5 ? ', ...' : ''}`, 'warn');
	}

	log(`${step.name}: ${docs.length} defined, ${docs.length - missing.length} already present, ${missing.length} inserted.`, missing.length > 0 ? 'done' : 'info');
	return { step: step.name, defined: docs.length, inserted: missing.length, duplicates };
}

/**
 * Runs the seed steps in dependency order.
 * @param {string[]} [only] optional list of step names to run (still in dependency order).
 */
async function seedStatic(only) {
	const selected = only && only.length > 0 ? STEPS.filter((s) => only.includes(s.name)) : STEPS;
	const unknown = (only || []).filter((name) => !STEPS.some((s) => s.name === name));
	if (unknown.length > 0) throw new Error(`Unknown seed step(s): ${unknown.join(', ')}. Valid: ${STEPS.map((s) => s.name).join(', ')}`);

	const results = [];
	for (const step of selected) {
		results.push(await runStep(step));
	}
	return results;
}

/** Returns the natural keys defined by a step that are missing from the database. */
async function missingKeys(stepName) {
	const step = STEPS.find((s) => s.name === stepName);
	const have = await existingKeys(step);
	return step.docs().map((doc) => keyOf(step, doc)).filter((key) => !have.has(key));
}

module.exports = { STEPS, seedStatic, missingKeys, log, CATALOG };
