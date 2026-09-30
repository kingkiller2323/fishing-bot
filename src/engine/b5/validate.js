// Boot validation of the 5B release. bootstrap validate() runs it only while the 5B flag is on, and any
// problem stops the boot, so the flag can never be enabled on data the 5B rules cannot serve.
const { Fish } = require('../../schemas/FishSchema');
const value5b = require('./value');

/** Returns a list of problems (empty = the 5B release can run on this database). */
async function validate5b() {
	const problems = [];
	const fish = await Fish.find({ user: null, type: 'fish' }).select('name biome rarity type').lean();
	const missing = value5b.missingValueData(fish);
	if (missing.length > 0) problems.push(`5B value data missing for ${missing.length} species: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}`);
	return problems;
}

module.exports = { validate5b };
