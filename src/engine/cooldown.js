// Per-player cast cooldown. Each cast sets the earliest time the player may cast again, using that
// cast's resolved Fishing Speed (GameBalance.COOLDOWN, never below minMs). Applies to /fish and the
// Fish again button alike. In-process, like the per-player lock (single bot instance).
const { COOLDOWN } = require('./balance');

const nextCastAt = new Map();

/** Milliseconds the player still has to wait (0 = may cast now). */
function remainingMs(userId, now = Date.now()) {
	const until = nextCastAt.get(String(userId)) || 0;
	return Math.max(0, until - now);
}

/** Starts the cooldown after a cast attempt. */
function startCooldown(userId, cooldownMs = COOLDOWN.fishMs, now = Date.now()) {
	nextCastAt.set(String(userId), now + Math.max(COOLDOWN.minMs, cooldownMs));
}

function resetCooldowns() {
	nextCastAt.clear();
}

module.exports = { remainingMs, startCooldown, resetCooldowns };
