// Runs `fn` with the 5B release flag switched on (or off) in this process, restoring it afterwards.
// config.flags is read at call time by balance.isBalance5b(), so this reaches every 5B code path.
const config = require('../../src/config');

async function withFlag(on, fn) {
	const saved = config.flags.balance5b;
	config.flags.balance5b = on;
	try {
		return await fn();
	}
	finally {
		config.flags.balance5b = saved;
	}
}

module.exports = { withFlag, with5b: (fn) => withFlag(true, fn) };
