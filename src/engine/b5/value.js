// Phase 5B value model and XP per rarity (step C.1). Used only by the 5B engine paths.
//
// Catch value: new raw roll = today's raw roll × (5B species EV / today's species EV). The size/weight
// roll and today's formula are kept, so the within-species distribution keeps its shape and only its
// scale moves to the 5B expectation. The scale is applied once, when the cast (or open) is decided;
// the journal stores the scaled value and replay writes it as stored, so nothing is scaled twice.
// XP: each fish's 10-25 roll × its rarity weight, rounded down per fish.
const { need5b } = require('../balance');

const speciesKey = (template) => `${template?.biome}|${template?.name}`;

/** The species' value data, or throws: missing or non-positive data is never replaced by a guess. */
function speciesValue(template) {
	const row = need5b().value.species[speciesKey(template)];
	if (!row || !(row.current > 0) || !(row.proposed > 0)) {
		const error = new Error(`no 5B value data for ${speciesKey(template)}`);
		error.code = 'NO_VALUE_DATA';
		throw error;
	}
	return row;
}

/** The one rounding rule for a scaled catch value: nearest integer. */
const roundValue = (x) => Math.round(x);

/** Today's raw roll scaled to the 5B expectation for this species. */
function scaleRaw(rawValue, template) {
	const { current, proposed } = speciesValue(template);
	return roundValue((rawValue * proposed) / current);
}

/** XP of one fish: floor(roll × rarity weight). */
function fishXp(roll, rarity) {
	const weight = need5b().xp.rarity[String(rarity).toLowerCase()];
	if (!(weight > 0)) throw new Error(`no 5B XP weight for rarity ${rarity}`);
	return Math.floor(roll * weight);
}

/** Boot check: every fish template has positive value data. Returns the missing keys. */
function missingValueData(templates) {
	const rows = need5b().value.species;
	return templates.filter((t) => t.type === 'fish' || t.type === undefined)
		.map(speciesKey)
		.filter((k) => !(rows[k]?.current > 0 && rows[k]?.proposed > 0));
}

module.exports = { speciesKey, speciesValue, roundValue, scaleRaw, fishXp, missingValueData };
