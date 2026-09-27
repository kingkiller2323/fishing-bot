// Aquarium correctness rules on TODAY's aquarium (Phase 5B step B: aquarium; A3, A7, A9). The values
// are the approved design's (scripts/economy/5b/aquarium.js PARAMS; test/step-b-aquarium.test.js pins
// them): one temperature ideal of 25 °C, no drift, stored values read clamped to the /aquarium adjust
// range, new tanks at 25 °C, and a 7-day breeding cooldown per parent. Prices, capacities, the breeding
// chance (A2) and the sale formula (A1) are unchanged here; step C replaces them behind the 5B flag.
const { ItemData } = require('../schemas/ItemSchema');

const DAY_MS = 24 * 60 * 60 * 1000;

const AQUARIUM_FIXES = Object.freeze({
	idealTemperatureC: 25,
	adjustRangeC: Object.freeze([-30, 30]),
	newTankTemperatureC: 25,
	breedingCooldownDays: 7,
});

/** The temperature every formula reads: the stored value clamped to the adjust range (25 °C if unset). */
function effectiveTemperature(storedC) {
	const [lo, hi] = AQUARIUM_FIXES.adjustRangeC;
	const t = Number.isFinite(storedC) ? storedC : AQUARIUM_FIXES.newTankTemperatureC;
	return Math.min(hi, Math.max(lo, t));
}

/** Milliseconds until a pet may breed again (0 = ready). Only a successful breed records lastBred. */
function breedingCooldownRemaining(lastBred, now = Date.now()) {
	const last = lastBred ? new Date(lastBred).getTime() : NaN;
	if (!Number.isFinite(last)) return 0;
	return Math.max(0, last + AQUARIUM_FIXES.breedingCooldownDays * DAY_MS - now);
}

/** A license's tier within its water type (its tank size: Basic 1, Advanced 2, Expert 3). */
const licenseTier = (license) => Number(license?.aquarium?.size) || 0;
const licenseWaters = (license) => (license?.aquarium?.waterType || []).map((w) => String(w).toLowerCase());

/** The highest license tier the player owns per water type, e.g. { freshwater: 2 }. */
async function ownedLicenseTiers(itemIds) {
	const owned = await ItemData.find({ _id: { $in: itemIds || [] }, type: 'license' }).lean();
	const tiers = {};
	for (const l of owned) for (const w of licenseWaters(l)) tiers[w] = Math.max(tiers[w] || 0, licenseTier(l));
	return tiers;
}

/** A7: a license is on offer only above the tier already owned for its water type (no duplicates, no lower tiers). */
function licenseOffered(license, ownedTiers) {
	return licenseWaters(license).some((w) => licenseTier(license) > (ownedTiers[w] || 0));
}

module.exports = { DAY_MS, AQUARIUM_FIXES, effectiveTemperature, breedingCooldownRemaining, licenseTier, ownedLicenseTiers, licenseOffered };
