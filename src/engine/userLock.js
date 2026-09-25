// Per-player async lock: operations on the same player's state run one at a time within this
// process (the bot runs as a single instance). Used for casts and sells so they never interleave.
const tails = new Map();

async function withUserLock(userId, fn) {
	const key = String(userId);
	const previous = tails.get(key) || Promise.resolve();
	let release;
	const current = new Promise((resolve) => { release = resolve; });
	const tail = previous.then(() => current);
	tails.set(key, tail);
	await previous;
	try {
		return await fn();
	}
	finally {
		release();
		if (tails.get(key) === tail) tails.delete(key);
	}
}

module.exports = { withUserLock };
