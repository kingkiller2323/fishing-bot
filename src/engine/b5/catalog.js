// Hidden 5B catalog rows and the read-time overlay (step C).
//
// Rows the 5B release adds to the catalog (standard rods, tackle crates, the new bait roster, Mountain
// Stream fish, ...) carry `release: '5b'` and are stored unlisted (`shopItem: false`). Today's queries that
// could reach them (box reward pools, the Lucky item pool, biome lists) exclude them with LEGACY_ONLY, so
// with the 5B flag off nothing new is visible. Prices, levels and listings of EXISTING catalog rows are never
// rewritten: while the flag is on, `effective(row)` overlays the 5B values at read time.
const { rules5b } = require('../balance');

/** Filter clause: rows that exist in today's game (not added by the 5B release). */
const LEGACY_ONLY = Object.freeze({ release: { $exists: false } });

/** Catalog filter for what the running release may show: everything with the 5B flag on, today's rows otherwise. */
const visibleCatalog = () => (rules5b() ? {} : { ...LEGACY_ONLY });

const isRelease5b = (row) => row?.release === '5b';

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

module.exports = { LEGACY_ONLY, visibleCatalog, isRelease5b, overlayFor, effective };
