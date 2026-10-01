// Hidden 5B catalog rows and the read-time overlay (step C).
//
// Rows the 5B release adds to the catalog (standard rods, tackle crates, the new bait roster, Mountain
// Stream fish, ...) carry `release: '5b'` and are stored unlisted (`shopItem: false`). Today's queries that
// could reach them (box reward pools, the Lucky item pool, biome lists) exclude them with LEGACY_ONLY, so
// with the 5B flag off nothing new is visible. Prices, levels and listings of EXISTING catalog rows are never
// rewritten: while the flag is on, `effective(row)` overlays the 5B values at read time.
const { rules5b, seedData5b } = require('../balance');

/** Filter clause: rows that exist in today's game (not added by the 5B release). */
const LEGACY_ONLY = Object.freeze({ release: { $exists: false } });

/** Catalog filter for what the running release may show: everything with the 5B flag on, today's rows otherwise. */
const visibleCatalog = () => (rules5b() ? {} : { ...LEGACY_ONLY });

const isRelease5b = (row) => row?.release === '5b';

// Today's biomes (the static catalog). A biome outside it exists only in the 5B release (Mountain Stream).
const LEGACY_BIOMES = new Set(require('../../bootstrap/data/biomes').map((b) => String(b.name).toLowerCase()));
/** True for a biome only the 5B release has: after a rollback (flag off) a player left there fishes the Ocean. */
function isRelease5bBiome(name) {
	const key = String(name || 'ocean').toLowerCase();
	return !LEGACY_BIOMES.has(key) && seedData5b().world.biomeOrder.some((b) => b.toLowerCase() === key);
}

/** The 5B overlay of a catalog row by name (price, requirements.level, shopItem, capabilities, flags). */
function overlayFor(name) {
	const r = rules5b();
	return r?.catalog?.overlay?.[name] || null;
}

/**
 * A catalog row as the running release sees it. Flag off: the stored row. Flag on: the stored row with the
 * 5B overlay applied, and hidden 5B rows listed as their data says. Never mutates `row`.
 */
function effective(row) {
	if (!row || !rules5b()) return row;
	const plain = typeof row.toObject === 'function' ? row.toObject() : row;
	const over = overlayFor(plain.name);
	const out = { ...plain };
	if (isRelease5b(plain) && plain.listed5b !== undefined) out.shopItem = plain.listed5b;
	if (over) {
		for (const [k, v] of Object.entries(over)) {
			if (k === 'requirements') out.requirements = { ...(plain.requirements || {}), ...v };
			else out[k] = v;
		}
	}
	return out;
}

module.exports = { LEGACY_ONLY, visibleCatalog, isRelease5b, isRelease5bBiome, overlayFor, effective };
