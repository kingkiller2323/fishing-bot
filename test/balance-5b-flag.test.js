// BALANCE_5B flag plumbing (Phase 5B step A). The flag is off unless explicitly switched on, only
// balance.isBalance5b() reads it, and with it off the game plays exactly as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const config = require('../src/config');
const balance = require('../src/engine/balance');

const ROOT = path.join(__dirname, '..');

test('envFlag: only an explicit on value switches a flag on', () => {
	for (const v of ['on', 'ON', ' true ', '1', 'yes', 'True']) assert.equal(config.envFlag(v), true, JSON.stringify(v));
	for (const v of [undefined, null, '', 'off', 'false', '0', 'no', 'onn', 'enabled', '2']) assert.equal(config.envFlag(v), false, JSON.stringify(v));
});

test('BALANCE_5B is off by default and read through balance.isBalance5b()', () => {
	assert.equal(config.flags.balance5b, config.envFlag(process.env.BALANCE_5B));
	if (process.env.BALANCE_5B === undefined) assert.equal(balance.isBalance5b(), false);
	assert.equal(balance.isBalance5b({ flags: { balance5b: true } }), true);
	assert.equal(balance.isBalance5b({ flags: { balance5b: false } }), false);
	assert.equal(balance.isBalance5b({}), false);
	// Only a real boolean true counts (a leaked string never switches the economy).
	assert.equal(balance.isBalance5b({ flags: { balance5b: 'on' } }), false);
});

function walk(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
}

test('one accessor: nothing in src reads the flag or the 5b data except balance.js and config.js', () => {
	const offenders = [];
	for (const file of walk(path.join(ROOT, 'src'))) {
		const rel = path.relative(ROOT, file);
		if (rel === path.join('src', 'engine', 'balance.js') || rel === path.join('src', 'config.js')) continue;
		const text = fs.readFileSync(file, 'utf8');
		if (/BALANCE_5B|balance5b|balance-5b|loadBalance5b|balanceData\(/.test(text)) offenders.push(rel);
	}
	assert.deepEqual(offenders, [], 'read the flag through balance.isBalance5b() and the data through balance.js');
});

/** Runs the seeded cast sequence in a fresh process with BALANCE_5B set to `value` (undefined = unset). */
function play(value) {
	const env = { ...process.env, FOUNDER_IDS: 'flag-founder' };
	delete env.BALANCE_5B;
	if (value !== undefined) env.BALANCE_5B = value;
	return new Promise((resolve, reject) => {
		execFile(process.execPath, [path.join(__dirname, 'helpers', 'flagCast.js')], { env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) reject(new Error(`flagCast (BALANCE_5B=${value}) failed: ${stderr || err.message}`));
			else resolve(JSON.parse(stdout));
		});
	});
}

test('flag off: castLine and applyCastResult are identical with BALANCE_5B unset, off or unrecognised', async () => {
	const [unset, off, junk, on] = await Promise.all([play(undefined), play('off'), play('maybe'), play('on')]);
	assert.equal(unset.flag, false);
	assert.equal(off.flag, false);
	assert.equal(junk.flag, false);
	assert.equal(on.flag, true, 'BALANCE_5B=on reaches balance.isBalance5b()');
	assert.ok(unset.casts.length === 50 && unset.casts.every((c) => c.status === 'ok'), 'every seeded cast lands');
	assert.ok(unset.users[0].xp > 0 && unset.users[1].xp > unset.users[0].xp, 'normal and Founder players both progressed');
	assert.deepEqual(off, unset);
	assert.deepEqual(junk, unset);
	// Step A only: no gameplay path reads the 5B numbers yet, so even the flag on changes nothing. Step C
	// replaces this assertion with the 5B behaviour behind the flag.
	assert.deepEqual({ ...on, flag: false }, unset);
});
