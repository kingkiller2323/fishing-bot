// Flag off = today's game, pinned against production. test/fixtures/flag-off-golden-71fde4d.json is the
// output of test/helpers/flagCast.js (50 seeded casts: a normal player and a Founder) produced by the
// production code at main 71fde4d, the last commit before Phase 5B step A. With BALANCE_5B off the
// current code must reproduce it exactly: same fish, XP, public XP, levels, cash, stats and pity.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');

const golden = require('./fixtures/flag-off-golden-71fde4d.json');

test('BALANCE_5B=off reproduces the production (71fde4d) cast sequence exactly', async () => {
	const env = { ...process.env, FOUNDER_IDS: 'flag-founder', BALANCE_5B: 'off' };
	const out = await new Promise((resolve, reject) => {
		execFile(process.execPath, [path.join(__dirname, 'helpers', 'flagCast.js')], { env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) reject(new Error(`flagCast failed: ${stderr || err.message}`));
			else resolve(JSON.parse(stdout));
		});
	});
	assert.equal(out.flag, false);
	delete out.flag;
	assert.deepEqual(out, golden);
});
