// Boot validation of the 5B release. bootstrap validate() runs it only while the 5B flag is on, and any
// problem stops the boot, so the flag can never be enabled on data the 5B rules cannot serve.
const { Fish } = require('../../schemas/FishSchema');
const { Biome } = require('../../schemas/BiomeSchema');
const { WeatherType } = require('../../schemas/WeatherTypeSchema');
const { Season } = require('../../schemas/SeasonSchema');
const { need5b } = require('../balance');
const value5b = require('./value');

const RARITIES = ['Common', 'Uncommon', 'Rare', 'Ultra', 'Giant', 'Legendary', 'Lucky'];
const QUALITIES = ['weak', 'strong'];

/**
 * Mountain Stream grid: the biome row exists, every ladder species is seeded, and for every rarity × quality ×
 * weather × season at least one species can be caught (the premium Ultra tier is covered weather by weather),
 * so no cast there can fail for lack of a fish.
 */
async function mountainStreamProblems() {
	const problems = [];
	const name = 'Mountain Stream';
	if (!await Biome.exists({ name })) problems.push('Mountain Stream: biome row missing');
	const fish = await Fish.find({ user: null, biome: name }).select('name rarity weather season qualities').lean();
	const expected = need5b().world.mountainStream.species.map((s) => s.name);
	const missing = expected.filter((n) => !fish.some((f) => f.name === n));
	if (missing.length) problems.push(`Mountain Stream: ${missing.length} ladder species missing (${missing.slice(0, 3).join(', ')})`);
	const weathers = (await WeatherType.find({ type: 'weather' }).lean()).map((w) => w.weather);
	const seasons = (await Season.find({ type: 'season' }).lean()).map((x) => x.season);
	const gaps = [];
	for (const rarity of RARITIES) {
		for (const quality of QUALITIES) {
			for (const weather of weathers) {
				for (const season of seasons) {
					const ok = fish.some((f) => f.rarity === rarity && [weather, 'all'].includes(f.weather) && [season, 'all'].includes(f.season) && (f.qualities || []).includes(quality));
					if (!ok) gaps.push(`${rarity}/${quality}/${weather}/${season}`);
				}
			}
		}
	}
	if (gaps.length) problems.push(`Mountain Stream grid incomplete (${gaps.length}): ${gaps.slice(0, 5).join(', ')}${gaps.length > 5 ? ', ...' : ''}`);
	return problems;
}

/** Returns a list of problems (empty = the 5B release can run on this database). */
async function validate5b() {
	const problems = [];
	const fish = await Fish.find({ user: null, type: 'fish' }).select('name biome rarity type').lean();
	const missing = value5b.missingValueData(fish);
	if (missing.length > 0) problems.push(`5B value data missing for ${missing.length} species: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}`);
	problems.push(...await mountainStreamProblems());
	return problems;
}

module.exports = { validate5b, mountainStreamProblems };
