// Gacha V2 box definitions (versioned with GameBalance.BALANCE_VERSION).
//
// A definition describes WHAT a box can give and HOW each slot rolls:
//   slots           number of rewards per open
//   strategy        'independent' (each slot rolls its own rarity) | 'shared' (one rarity for all)
//   pool            { types: item types, fish: include catchable fish, exclude: names, featured }
//                   featured: [{ names: [...], weight: n }] - within a rarity, those rewards are n x
//                   as likely to be picked as the rest
//   rarityTable     base weights per rarity (normalised by the engine)
//   rarityFloor     no slot rolls below this rarity (null = none)
//   guaranteedSlots [{ slot, minRarity }] - that slot rolls at or above minRarity
//   duplicates      'allow' | 'unique' (no identical reward twice in one open, when avoidable)
//   pity            box pity rules for everyone (null = none); profiles may add their own
//
// The four legacy boxes are converted 1:1 from their original weights/capabilities/items, so normal
// players keep the same per-slot odds; the only behavioural change is independent slots.
const { RARITIES } = require('./balance');

const LEGACY_TABLE = { common: 7000, uncommon: 2500, rare: 500, ultra: 100, giant: 50, legendary: 20, lucky: 1 };
const PARTS = ['part_rod', 'part_reel', 'part_hook', 'part_handle'];

const BOXES = {
	'Fishing Crate': {
		id: 'fishing-crate',
		slots: 3,
		strategy: 'independent',
		pool: { types: ['bait', ...PARTS], fish: false, exclude: [], featured: [] },
		rarityTable: { ...LEGACY_TABLE },
		rarityFloor: null,
		guaranteedSlots: [],
		duplicates: 'allow',
		pity: null,
	},
	'Booster Pack': {
		id: 'booster-pack',
		slots: 1,
		strategy: 'independent',
		pool: { types: ['buff'], fish: false, exclude: [], featured: [] },
		rarityTable: { common: 0, uncommon: 0, rare: 500, ultra: 0, giant: 0, legendary: 0, lucky: 0 },
		rarityFloor: null,
		guaranteedSlots: [],
		duplicates: 'allow',
		pity: null,
	},
	'Voter\'s Crate': {
		id: 'voters-crate',
		slots: 3,
		strategy: 'independent',
		pool: { types: ['bait', 'buff', 'rod', ...PARTS], fish: true, exclude: [], featured: [] },
		rarityTable: { common: 3000, uncommon: 2500, rare: 500, ultra: 100, giant: 50, legendary: 20, lucky: 1 },
		rarityFloor: null,
		guaranteedSlots: [],
		duplicates: 'allow',
		pity: null,
	},
	'Daily Box': {
		id: 'daily-box',
		slots: 3,
		strategy: 'independent',
		pool: { types: ['bait', 'buff', ...PARTS], fish: true, exclude: [], featured: [] },
		rarityTable: { ...LEGACY_TABLE },
		rarityFloor: null,
		guaranteedSlots: [],
		duplicates: 'allow',
		pity: null,
	},
};

/**
 * Definition for a box by name (case-insensitive). Unknown names (a box someone owns from an older
 * catalog) are converted from the owned document's legacy fields so they still open.
 */
function boxDefinition(name, ownedDoc = null) {
	const key = Object.keys(BOXES).find((k) => k.toLowerCase() === String(name).trim().toLowerCase());
	if (key) return { name: key, ...BOXES[key] };
	if (!ownedDoc) return null;
	return legacyDefinition(ownedDoc);
}

/** Converts a legacy gacha document (capabilities, weights, items) into a V2 definition. */
function legacyDefinition(doc) {
	const capabilities = doc.capabilities || [];
	const weights = Object.fromEntries(RARITIES.map((r) => [r, Number(doc.weights?.[r]) || 0]));
	return {
		name: doc.name,
		id: `legacy:${String(doc.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
		slots: Math.max(1, Number(doc.items) || 1),
		strategy: 'independent',
		pool: { types: capabilities.filter((c) => c !== 'fish'), fish: capabilities.includes('fish'), exclude: [], featured: [] },
		rarityTable: weights,
		rarityFloor: null,
		guaranteedSlots: [],
		duplicates: 'allow',
		pity: null,
		legacy: true,
	};
}

module.exports = { BOXES, boxDefinition, legacyDefinition };
