// Single source of randomness for game logic.
//
// Live play uses Math.random. Tests call rng.seed(n) (or build an isolated generator with
// createRng(n)) so every roll is reproducible; rng.reset() restores Math.random.
// Game code must never call Math.random directly - use rng.random() / rng.int() / rng.pick().

/** mulberry32: small, fast, well-distributed 32-bit PRNG. Returns floats in [0, 1). */
function mulberry32(seed) {
	let a = seed >>> 0;
	return function next() {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Wraps a [0,1) source with the helpers game code needs. */
function wrap(source) {
	const api = {
		random: () => source(),
		/** Integer in [0, maxExclusive). */
		int: (maxExclusive) => Math.floor(source() * maxExclusive),
		/** Uniform pick from a non-empty array (undefined for an empty one). */
		pick: (items) => (items.length === 0 ? undefined : items[Math.floor(source() * items.length)]),
		/**
		 * Weighted pick. Weights must be non-negative numbers; returns undefined if they sum to 0.
		 * Equivalent to the legacy Utils.getWeightedChoice for integer weights.
		 */
		weighted: (choices, weights) => {
			const total = weights.reduce((sum, w) => sum + w, 0);
			if (!(total > 0)) return undefined;
			let roll = source() * total;
			for (let i = 0; i < choices.length; i++) {
				roll -= weights[i];
				if (roll < 0) return choices[i];
			}
			return choices[choices.length - 1];
		},
	};
	return api;
}

/** An isolated deterministic generator, for code that takes an injected RNG. */
function createRng(seed) {
	return wrap(mulberry32(seed));
}

// Process-wide generator used by game code. Swappable for tests.
let current = Math.random;
const rng = wrap(() => current());
rng.seed = (seed) => { current = mulberry32(seed); };
rng.reset = () => { current = Math.random; };

module.exports = { rng, createRng };
