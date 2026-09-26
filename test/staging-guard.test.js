// The staging rehearsal refuses anything but a staging database, and never runs with a Discord token.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'staging', 'stepA-rehearsal.js');

function run(env) {
	return new Promise((resolve) => {
		const base = { ...process.env };
		for (const k of ['MONGODB_URI', 'STAGING_REHEARSAL', 'CLIENT_TOKEN', 'STAGING_REPLSET']) delete base[k];
		execFile(process.execPath, [SCRIPT], { env: { ...base, ...env }, timeout: 20000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: `${stdout}${stderr}` }));
	});
}

test('the rehearsal refuses production-like targets before connecting', async () => {
	const cases = [
		[{ MONGODB_URI: 'mongodb://mongodb.railway.internal:27017' }, /STAGING_REHEARSAL=1 is not set/],
		[{ STAGING_REHEARSAL: '1', MONGODB_URI: 'mongodb+srv://u:p@cluster0.abcde.mongodb.net/fishing' }, /Atlas/],
		[{ STAGING_REHEARSAL: '1', MONGODB_URI: 'mongodb://u:p@db.example.com:27017' }, /not a Railway private host or localhost/],
		[{ STAGING_REHEARSAL: '1', MONGODB_URI: 'mongodb://mongodb.railway.internal:27017', CLIENT_TOKEN: 'x' }, /CLIENT_TOKEN is set/],
	];
	for (const [env, message] of cases) {
		const { code, out } = await run(env);
		assert.equal(code, 1, out);
		assert.match(out, /Refusing to run/);
		assert.match(out, message);
	}
});
