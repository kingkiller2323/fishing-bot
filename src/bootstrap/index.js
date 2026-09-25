// Startup bootstrap: normalizes legacy static data, seeds the static catalog exactly once,
// then derives runtime state (active season, weather forecast) and validates the result.
// Must complete before the bot logs in to Discord.
const { WeatherType } = require('../schemas/WeatherTypeSchema');
const { Season: SeasonSchema } = require('../schemas/SeasonSchema');
const { WeatherPattern: WeatherPatternSchema } = require('../schemas/WeatherPatternSchema');
const { Biome } = require('../schemas/BiomeSchema');
const { Fish } = require('../schemas/FishSchema');
const { Item } = require('../schemas/ItemSchema');
const { Quest } = require('../schemas/QuestSchema');
const { Season } = require('../class/Season');
const { STEPS, seedStatic, missingKeys, log, CATALOG } = require('./seed');

const FORECAST_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const REQUIRED_ITEMS = ['Old Rod', 'Daily Box', 'Voter\'s Crate'];
const RARITIES = ['Common', 'Uncommon', 'Rare', 'Ultra', 'Giant', 'Legendary', 'Lucky'];
const QUALITIES = ['strong', 'weak'];

/** Canonical weather name: "sunny" / "SUNNY" -> "Sunny". "all" is a wildcard and stays lowercase. */
const canonicalWeather = (name) => {
	if (typeof name !== 'string' || name.length === 0 || name.toLowerCase() === 'all') return name;
	return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
};

/**
 * One-time normalizations for databases created by the old scripts. Only static/derived
 * collections are touched (weathertypes, seasons, weatherpatterns).
 */
async function normalizeLegacyData() {
	// Weather names: the old generateWeatherTypes.js wrote lowercase names.
	for (const doc of await WeatherType.find({}).select('weather').lean()) {
		const canonical = canonicalWeather(doc.weather);
		if (canonical !== doc.weather) await WeatherType.updateOne({ _id: doc._id }, { $set: { weather: canonical } });
	}
	for (const doc of await WeatherPatternSchema.find({}).select('weather').lean()) {
		const canonical = canonicalWeather(doc.weather);
		if (canonical !== doc.weather) await WeatherPatternSchema.updateOne({ _id: doc._id }, { $set: { weather: canonical } });
	}
	for (const doc of await SeasonSchema.find({}).select('commonWeatherTypes').lean()) {
		const canonical = (doc.commonWeatherTypes || []).map(canonicalWeather);
		if (JSON.stringify(canonical) !== JSON.stringify(doc.commonWeatherTypes)) {
			await SeasonSchema.updateOne({ _id: doc._id }, { $set: { commonWeatherTypes: canonical } });
		}
	}

	// Duplicate weather types / seasons (e.g. from re-running the old non-idempotent script) are
	// referenced only by name, so extra copies can be removed safely. Keep the oldest row.
	const removed = {
		weatherTypes: await removeDuplicates(WeatherType, 'weather'),
		seasons: await removeDuplicates(SeasonSchema, 'season'),
	};
	if (removed.weatherTypes + removed.seasons > 0) {
		log(`Removed duplicate static rows: ${removed.weatherTypes} weather type(s), ${removed.seasons} season(s).`, 'warn');
	}
}

async function removeDuplicates(model, field) {
	const groups = await model.aggregate([
		{ $sort: { active: -1, createdAt: 1, _id: 1 } },
		{ $group: { _id: `$${field}`, ids: { $push: '$_id' }, count: { $sum: 1 } } },
		{ $match: { count: { $gt: 1 } } },
	]);
	let removed = 0;
	for (const group of groups) {
		const [, ...extra] = group.ids;
		const result = await model.deleteMany({ _id: { $in: extra } });
		removed += result.deletedCount;
	}
	return removed;
}

const monthDay = (month, day) => (MONTHS.indexOf(String(month).toLowerCase()) + 1) * 100 + Number(day);

/** Marks exactly one season active: the one whose start date most recently passed. */
async function ensureActiveSeason(now = new Date()) {
	const seasons = await SeasonSchema.find({ type: 'season' }).lean();
	if (seasons.length === 0) throw new Error('No seasons in the database after seeding.');

	const today = (now.getMonth() + 1) * 100 + now.getDate();
	const byStart = [...seasons].sort((a, b) => monthDay(a.startMonth, a.startDay) - monthDay(b.startMonth, b.startDay));
	const started = byStart.filter((s) => monthDay(s.startMonth, s.startDay) <= today);
	// Before the first start date of the year (early January to mid March) the last season (Winter) is still running.
	const current = started.length > 0 ? started[started.length - 1] : byStart[byStart.length - 1];

	const activeBefore = seasons.filter((s) => s.active).map((s) => s.season);
	await SeasonSchema.updateMany({ type: 'season', _id: { $ne: current._id } }, { $set: { active: false } });
	await SeasonSchema.updateOne({ _id: current._id }, { $set: { active: true } });

	if (activeBefore.length !== 1 || activeBefore[0] !== current.season) {
		log(`Active season set to ${current.season} (was: ${activeBefore.join(', ') || 'none'}).`, 'done');
	}
	else {
		log(`Active season: ${current.season}.`);
	}
	return current.season;
}

/**
 * Generates the 7-day weather forecast chain if there is no active weather pattern.
 * Requires weather types and an active season. Runtime rotation is handled in interactionCreate.
 */
async function ensureWeatherPatterns() {
	const active = await WeatherPatternSchema.findOne({ type: 'weather', active: true });
	if (active) {
		log(`Weather forecast present (current: ${active.weather}).`);
		return;
	}

	// Without an active pattern the chain is unusable; clear any partial leftovers (derived data only).
	const stale = await WeatherPatternSchema.deleteMany({ type: 'weather' });
	if (stale.deletedCount > 0) log(`Removed ${stale.deletedCount} weather pattern(s) left without an active pattern.`, 'warn');

	const season = await Season.getCurrentSeason();
	if (!season) throw new Error('Cannot generate weather: no active season.');

	const patterns = [];
	let start = new Date();
	for (let i = 0; i < FORECAST_DAYS; i++) {
		const weatherType = await Season.getSeasonalWeather(season);
		if (!weatherType) throw new Error('Cannot generate weather: no weather types in the database.');
		const end = new Date(start.getTime() + DAY_MS);
		patterns.push(new WeatherPatternSchema({
			weather: weatherType.weather,
			icon: weatherType.icon,
			dateStart: start,
			dateEnd: end,
			type: 'weather',
			active: i === 0,
			nextWeatherPattern: null,
		}));
		start = end;
	}
	patterns.forEach((pattern, i) => {
		if (patterns[i + 1]) pattern.nextWeatherPattern = patterns[i + 1]._id;
	});
	await WeatherPatternSchema.insertMany(patterns);

	log(`Generated ${FORECAST_DAYS}-day weather forecast for ${season.season}: ${patterns.map((p) => p.weather).join(', ')}.`, 'done');
}

/** Verifies that everything gameplay depends on exists and is consistent. Throws on failure. */
async function validate() {
	const problems = [];

	for (const step of STEPS) {
		const missing = await missingKeys(step.name);
		if (missing.length > 0) problems.push(`${step.name}: ${missing.length} seed row(s) missing (${missing.slice(0, 3).join(', ')})`);
	}

	const weatherNames = new Set((await WeatherType.find({ type: 'weather' }).lean()).map((w) => w.weather));
	const seasons = await SeasonSchema.find({ type: 'season' }).lean();
	const seasonNames = new Set(seasons.map((s) => s.season));
	const biomeNames = new Set((await Biome.find({}).lean()).map((b) => b.name));

	const activeSeasons = seasons.filter((s) => s.active);
	if (activeSeasons.length !== 1) problems.push(`expected exactly 1 active season, found ${activeSeasons.length}`);
	for (const season of seasons) {
		const unknown = (season.commonWeatherTypes || []).filter((w) => !weatherNames.has(w));
		if (unknown.length > 0) problems.push(`season ${season.season} references unknown weather type(s): ${unknown.join(', ')}`);
	}

	const fish = await Fish.find(CATALOG).select('name rarity biome weather season qualities').lean();
	const badFish = fish.filter((f) => !biomeNames.has(f.biome)
		|| (f.weather !== 'all' && !weatherNames.has(f.weather))
		|| (f.season !== 'all' && !seasonNames.has(f.season)));
	// Not fatal: such fish are simply never drawn. Reported so the seed data can be corrected.
	if (badFish.length > 0) log(`${badFish.length} fish reference an unknown biome/weather/season and can never be caught: ${badFish.map((f) => `${f.name} (${f.biome}/${f.weather}/${f.season})`).join(', ')}`, 'warn');

	// Fish.generateFish() retries until it finds a match, so every rarity x biome x quality needs a year-round fish.
	const gaps = [];
	for (const rarity of RARITIES) {
		for (const biome of biomeNames) {
			for (const quality of QUALITIES) {
				const found = fish.some((f) => f.rarity === rarity && f.biome === biome && f.weather === 'all' && f.season === 'all' && (f.qualities || []).includes(quality));
				if (!found) gaps.push(`${rarity}/${biome}/${quality}`);
			}
		}
	}
	if (gaps.length > 0) problems.push(`base fish grid incomplete: ${gaps.slice(0, 5).join(', ')}${gaps.length > 5 ? ', ...' : ''}`);

	for (const name of REQUIRED_ITEMS) {
		if (!await Item.exists({ name, ...CATALOG })) problems.push(`required item "${name}" is missing`);
	}
	if (!await Quest.exists({ daily: true, ...CATALOG })) problems.push('no daily quest templates');
	if (!await Quest.exists({ daily: false, ...CATALOG })) problems.push('no non-daily quest templates');

	// The forecast must be a chain of FORECAST_DAYS patterns starting at the active one.
	let pattern = await WeatherPatternSchema.findOne({ type: 'weather', active: true }).lean();
	if (!pattern) {
		problems.push('no active weather pattern');
	}
	else {
		let length = 1;
		while (pattern.nextWeatherPattern && length < FORECAST_DAYS) {
			pattern = await WeatherPatternSchema.findById(pattern.nextWeatherPattern).lean();
			if (!pattern) break;
			length++;
		}
		if (length < FORECAST_DAYS) problems.push(`weather forecast chain has ${length} day(s), expected ${FORECAST_DAYS}`);
		const unknown = (await WeatherPatternSchema.find({ type: 'weather' }).lean()).filter((p) => !weatherNames.has(p.weather));
		if (unknown.length > 0) problems.push(`${unknown.length} weather pattern(s) reference unknown weather types`);
	}

	const summary = {
		weatherTypes: weatherNames.size,
		seasons: seasons.length,
		biomes: biomeNames.size,
		fish: fish.length,
		items: await Item.countDocuments(CATALOG),
		quests: await Quest.countDocuments(CATALOG),
		weatherPatterns: await WeatherPatternSchema.countDocuments({ type: 'weather' }),
	};
	log(`Collections: ${Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(', ')}.`);

	if (problems.length > 0) {
		problems.forEach((p) => log(`Validation failed: ${p}`, 'err'));
		throw new Error(`Bootstrap validation failed with ${problems.length} problem(s).`);
	}
	log('Validation passed.', 'done');
}

async function bootstrap() {
	const started = Date.now();
	log('Starting static data bootstrap...');
	await normalizeLegacyData();
	await seedStatic();
	await ensureActiveSeason();
	await ensureWeatherPatterns();
	await validate();
	log(`Bootstrap complete in ${Date.now() - started}ms.`, 'done');
}

module.exports = { bootstrap, seedStatic, validate, canonicalWeather };
