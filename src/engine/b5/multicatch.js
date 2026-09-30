// Normal-player multi-catch under the 5B rules (A-MULTICATCH): every cast lands one fish; with chance c a
// second; each further fish (up to maxFish) with the chain probability. The final mean never exceeds the
// ceiling (the multi-catch chain capped at ceilingMean fish per cast).
const { need5b } = require('../balance');

/** P(n fish) for chance c, n = 0..maxFish (index 0 unused). */
function fishDistribution(chance, { jackpotChain, maxFish }) {
	const dist = new Array(maxFish + 1).fill(0);
	dist[1] = 1 - chance;
	let p = chance;
	for (let n = 2; n <= maxFish; n++) {
		if (n === maxFish) {
			dist[n] = p;
			break;
		}
		dist[n] = p * (1 - jackpotChain);
		p *= jackpotChain;
	}
	return dist;
}

const meanOf = (dist) => dist.reduce((s, q, n) => s + q * n, 0);

/** The chance whose chain has mean `mean` (bisection, as the model's chanceForMean). */
function chanceForMean(mean, chain = need5b().multiCatch) {
	if (!(mean > 1)) return 0;
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 60; i++) {
		const mid = (lo + hi) / 2;
		if (meanOf(fishDistribution(mid, chain)) < mean) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

/** The cast's chance after the ceiling: min(1, sum of chances), lowered so the mean is at most ceilingMean. */
function cappedChance(rawChance) {
	const chain = need5b().multiCatch;
	const c = Math.min(1, Math.max(0, rawChance || 0));
	if (meanOf(fishDistribution(c, chain)) <= chain.ceilingMean + 1e-12) return { chance: c, capped: false };
	return { chance: chanceForMean(chain.ceilingMean, chain), capped: true };
}

/** Rolls the number of fish for one cast (always >= 1). */
function rollFishCount(chance, rng) {
	const { jackpotChain, maxFish } = need5b().multiCatch;
	let n = 1;
	if (rng.random() >= chance) return n;
	n = 2;
	while (n < maxFish && rng.random() < jackpotChain) n++;
	return n;
}

module.exports = { fishDistribution, meanOf, chanceForMean, cappedChance, rollFishCount };
