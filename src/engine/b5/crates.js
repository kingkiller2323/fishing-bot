// Gacha V2 definitions of the 5B tier crates (step C.2; P-RODS-CRATES). The Fishing Crate becomes the T1
// part crate, except the units a player already owned at the flip (P-RODS-FISHING-CRATE, option b): a stack
// with a `legacyCount` opens min(legacyCount, count) units first under TODAY's definition.
const { need5b } = require('../balance');
const { BOXES } = require('../gachaBoxes');

const LEGACY_CRATE = 'Fishing Crate';

/** Legacy units still to open on an owned stack. */
const legacyUnits = (owned) => Math.max(0, Math.min(Number(owned?.legacyCount) || 0, Number(owned?.count) || 0));

/** The 5B definition for a box name (and owned stack), or null when the 5B release does not define it. */
function crateDefinition5b(name, owned = null) {
	const key = String(name).trim().toLowerCase();
	// Streak boxes (P-STREAK-LADDER) and the legacy Voter's Crate without the Old Rod (P-STREAK-VOTERS-CRATE).
	const streak = Object.entries(need5b().streak.boxes).find(([n]) => n.toLowerCase() === key);
	if (streak) return { name: streak[0], ...structuredClone(streak[1]), baitGrant: need5b().streak.baitGrant, release5b: true };
	if (key === 'voter\'s crate') {
		const def = structuredClone(BOXES['Voter\'s Crate']);
		def.pool.exclude = [...new Set([...(def.pool.exclude || []), ...need5b().streak.votersCrateExclude])];
		return { name: 'Voter\'s Crate', ...def };
	}
	const crate = need5b().rods.crates.find((c) => c.name.toLowerCase() === key);
	if (!crate) return null;
	if (crate.name === LEGACY_CRATE && legacyUnits(owned) > 0) return { name: LEGACY_CRATE, ...structuredClone(BOXES[LEGACY_CRATE]), legacyUnit: true };
	const def = structuredClone(crate);
	delete def.price;
	delete def.shop;
	return { ...def, release5b: true };
}

module.exports = { LEGACY_CRATE, legacyUnits, crateDefinition5b };
