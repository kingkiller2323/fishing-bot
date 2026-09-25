const test = require('node:test');
const assert = require('node:assert/strict');
const { Icons } = require('../src/class/Icons');
const { icons } = require('../src/emojis');

const RAW = /<a?:\w+:\d+>|^:\w+:$/;

test('legacy foreign emoji references render as Unicode, never raw markup', () => {
	for (const data of ['Sardine:1244064605622501467', 'SunAnimated:1304870451885117553', 'blankblock:1304335977275457567', 'Nope:123456789012345678', '', undefined]) {
		const out = Icons.render({ data }, 'fish');
		assert.ok(out && !RAW.test(out), `${data} -> ${out}`);
	}
});

test('placeholders only apply to their own type', () => {
	assert.equal(Icons.render({ data: 'old_rod:1' }, 'rod'), icons.old_rod);
	assert.equal(Icons.render({ data: 'old_rod:1' }, 'bait'), '🪱');
});

test('every seeded icon key has a Unicode mapping', () => {
	const D = '../src/bootstrap/data/';
	const docs = ['weatherTypes', 'seasons', 'biomes', 'seasonalFish', 'weatherFish', 'rods', 'rodParts', 'bait', 'buffs', 'licenses', 'gacha']
		.flatMap((n) => require(D + n)).concat(require(D + 'baseFish')());
	for (const d of docs) assert.ok(icons[d.icon?.data], `${d.name || d.season || d.weather}: ${d.icon?.data}`);
});
