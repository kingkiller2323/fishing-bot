// Guards against deprecated discord.js interaction options creeping back in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function sourceFiles(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) return sourceFiles(full);
		return e.name.endsWith('.js') ? [full] : [];
	});
}

test('no interaction payload uses the deprecated `ephemeral` option (use flags: MessageFlags.Ephemeral)', () => {
	const offenders = [];
	for (const file of sourceFiles(path.join(__dirname, '..', 'src'))) {
		fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
			if (/^\s*\/\//.test(line)) return;
			if (/\bephemeral\s*:/.test(line)) offenders.push(`${path.relative(process.cwd(), file)}:${i + 1}`);
		});
	}
	assert.deepEqual(offenders, []);
});
