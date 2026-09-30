// Hidden catalog rows of the 5B release, inserted at every boot whatever the flag (additive and
// idempotent: a row whose name already exists is never touched). Every row carries `release: '5b'` and
// `shopItem: false`, so today's game never lists, awards or draws it (b5/catalog.js LEGACY_ONLY); with the
// 5B flag on, the 5B shop lists what the 5B data says. Values come from the generated 5B data only.
// Raw collection inserts: the catalog schemas do not declare `release`, so a model insert would strip it.
const mongoose = require('mongoose');
const { seedData5b } = require('../balance');
const { Item } = require('../../schemas/ItemSchema');
const { Fish } = require('../../schemas/FishSchema');
const { Biome } = require('../../schemas/BiomeSchema');

const RELEASE = '5b';

/** The rows the 5B release adds to the items collection (standard rods, tackle crates). */
function itemRows(data = seedData5b()) {
	const rows = [];
	for (const r of data.rods.standard) {
		rows.push({
			__t: 'Rod', name: r.name, description: `A ${r.role} shop rod for anglers of level ${r.unlockLevel} and up.`, rarity: 'Common',
			type: 'rod', price: r.price, capabilities: [...r.qualities], requirements: { level: r.unlockLevel },
			durability: r.maxDurability, maxDurability: r.maxDurability, repairs: 0, maxRepairs: r.maxRepairs, repairCost: r.repairCost,
			icon: { animated: false, data: 'old_rod' },
		});
	}
	for (const c of data.rods.crates.filter((x) => !x.shop.existingItem)) {
		rows.push({
			__t: 'Gacha', name: c.name, description: 'A crate of rod parts for the Rod Workshop.', rarity: 'Common', type: 'gacha',
			price: c.price, requirements: { level: c.shop.unlockLevel }, capabilities: [...c.pool.types], items: c.slots,
			icon: { animated: false, data: 'Treasure_Chest' },
		});
	}
	return rows.map((row) => ({ ...row, user: null, shopItem: false, release: RELEASE }));
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Mountain Stream (P-WORLD-MS-LADDER): the biome row and its NEW species. Size, weight and base value come from
 * the recorded River donor (generated data); the icon is the donor's. The three existing salmon rows are
 * never touched. Every new species is year-round; the premium salmon keep their weather.
 */
async function mountainStreamRows(data = seedData5b()) {
	const ms = data.world.mountainStream;
	const name = 'Mountain Stream';
	const biome = { name, requirements: [`Level ${ms.level}`], icon: { animated: false, data: 'River' }, type: 'biome', release: RELEASE };
	const fish = [];
	for (const s of ms.species.filter((x) => !x.existing)) {
		const [donorBiome, donorName] = s.donor.split('|');
		const donor = await Fish.collection.findOne({ name: donorName, biome: donorBiome, user: null });
		fish.push({
			name: s.name, description: `A ${s.rarity} fish of fast, cold mountain water.`, rarity: cap(s.rarity), type: 'fish', biome: name,
			weather: s.weather, season: s.season, qualities: [s.quality], minSize: s.minSize, maxSize: s.maxSize, minWeight: s.minWeight, maxWeight: s.maxWeight,
			baseValue: s.baseValue, value: s.baseValue, icon: donor?.icon || { animated: false, data: 'Salmon' }, user: null, release: RELEASE,
		});
	}
	return { biome, fish };
}

async function insertMissing(collection, rows, keyOf, filter) {
	const have = new Set((await collection.find(filter).toArray()).map(keyOf));
	const missing = rows.filter((r) => !have.has(keyOf(r)));
	const now = new Date();
	if (missing.length) await collection.insertMany(missing.map((r) => ({ _id: new mongoose.Types.ObjectId(), ...r, createdAt: now, updatedAt: now })));
	return missing.length;
}

/** Inserts the missing 5B rows. Returns how many were inserted. */
async function seedCatalog5b() {
	const rows = itemRows();
	let inserted = await insertMissing(Item.collection, rows, (r) => r.name, { user: null, name: { $in: rows.map((r) => r.name) } });
	const ms = await mountainStreamRows();
	inserted += await insertMissing(Biome.collection, [ms.biome], (r) => r.name, { name: ms.biome.name });
	inserted += await insertMissing(Fish.collection, ms.fish, (r) => `${r.biome}|${r.name}|${r.weather}|${r.season}`, { user: null, biome: ms.biome.name });
	return { defined: rows.length + 1 + ms.fish.length, inserted };
}

module.exports = { RELEASE, itemRows, mountainStreamRows, seedCatalog5b };
