// Competitive eligibility. Catches record `competitiveEligible` from Foundation V2 on; Founder,
// developer-luck and developer-spawned catches are false. Historical catches without the field
// count as competitive.

/** Mongo filter for catches that may appear on competitive leaderboards/records. */
function competitiveCatches(extra = {}) {
	return { ...extra, competitiveEligible: { $ne: false } };
}

module.exports = { competitiveCatches };
