// Hidden catalog rows of the 5B release, inserted at every boot whatever the flag (additive and
// idempotent: a row whose name already exists is never touched). Every row carries `release: '5b'` and
// `shopItem: false`, so today's game never lists, awards or draws it (b5/catalog.js LEGACY_ONLY); with the
// 5B flag on, the 5B shop lists what the 5B data says. Values come from the generated 5B data only.
// Raw collection inserts: the catalog schemas do not declare `release`, so a model insert would strip it.
const mongoose = require('mongoose');
const { seedData5b } = require('../balance');
const { Item } = require('../../schemas/ItemSchema');

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

/** Inserts the missing 5B rows. Returns how many were inserted. */
async function seedCatalog5b() {
	const rows = itemRows();
	const existing = new Set((await Item.collection.find({ user: null, name: { $in: rows.map((r) => r.name) } }, { projection: { name: 1 } }).toArray()).map((r) => r.name));
	const missing = rows.filter((r) => !existing.has(r.name));
	const now = new Date();
	if (missing.length) await Item.collection.insertMany(missing.map((r) => ({ _id: new mongoose.Types.ObjectId(), ...r, createdAt: now, updatedAt: now })));
	return { defined: rows.length, inserted: missing.length };
}

module.exports = { RELEASE, itemRows, seedCatalog5b };
