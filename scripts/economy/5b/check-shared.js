// Phase 5B reproducibility guard. Fails (exit 1) when a subsystem module could drift from the shared
// framework:
//   1. static scan: no module redefines a shared assumption (archetypes, target windows, daily XP,
//      purchase delay, lifecycle step, biome levels, curve, value/XP tables, provisional tier stats)
//      or reads an alternate gear source (rods.gearPath() outside assumptions.js; R3);
//      a line may opt out only with an explicit `// shared-ok: <reason>` comment;
//   2. runtime: framework.verifyShared() passes (shared values match the digest pinned for
//      FRAMEWORK_VERSION), and every module's report() carries that exact version and digest;
//   3. the committed curve choice (docs/economy/5b/curve.json) equals framework CURVE.quartic;
//   4. the decision registry (decisions.js) only uses allowed statuses (nothing claims user approval
//      of a candidate rule) and every entry's modelled value is what the framework actually runs.
//
//   node scripts/economy/5b/check-shared.js
const fs = require('node:fs');
const path = require('node:path');
const F = require('./framework');

const DIR = __dirname;
const SHARED_FILES = new Set(['framework.js', 'assumptions.js', 'check-shared.js', 'curve.js', 'lifecycle.js', 'integrate.js', 'decisions.js']);
const num = (n) => String(n).replace('.', '\\.').replace(/^0\\\./, '0?\\.');

const RULES = [
	{ name: 'archetype minutesPerDay literal', re: /minutesPerDay\s*:\s*\d/ },
	{ name: 'archetype overheadS literal', re: /overheadS\s*:\s*\d/ },
	{ name: 'daily XP literal', re: /\b(DAILY_XP_PER_LEVEL|dailyXpPerLevel|xpPerLevel)\s*[:=]\s*\d/ },
	{ name: 'target window literal', re: /\b20\s*:\s*\[\s*5\s*,\s*6\s*\]|\[\s*40\s*,\s*45\s*\]/ },
	{ name: 'curve literal', re: /\bquartic\s*[:=]\s*0?\.\d/ },
	{ name: 'purchase-delay literal', re: /\b(purchaseHours|saveHours)\s*[:=]\s*\d/ },
	{ name: 'lifecycle step literal', re: /\bstepH\s*[:=]\s*1\s*\/\s*60/ },
	{ name: 'lifecycle maxLevel literal', re: /\bmaxLevel\s*[:=]\s*60\b/ },
	{ name: 'milestone list literal', re: /\[\s*10\s*,\s*20\s*,\s*30\s*,\s*40\s*,\s*50\s*,\s*60\s*\]/ },
	{ name: 'biome level literal', re: /'(Ocean|River|Lake|Pond|Coast|Swamp|Mountain Stream)'\s*:\s*(0|10|20|30|40|50|60)\s*[,}]/ },
	{ name: 'shared table redefinition', re: /\b(BIOME_LEVEL|BIOME_ORDER|BIOME_VALUE|RARITY_VALUE|QUALITY_VALUE|XP_RARITY|ARCHETYPES|TARGET_WINDOWS|TARGETS)\s*=\s*[{[]/ },
	// R3: one authoritative gear path. Only assumptions.js may read rods.gearPath() (the GEAR_PATH_SOURCE
	// switch); every other module uses F.gearPath(), which becomes the rods path at the 5b.3 cutover.
	{ name: 'alternate gear source (use F.gearPath(); rods.gearPath() becomes the shared path at the R3 cutover)', re: /\brods\.gearPath\s*\(|require\(\s*['"]\.\/rods(\.js)?['"]\s*\)\s*\.\s*gearPath\s*\(/ },
	...F.PROVISIONAL_GEAR_PATH.filter((t) => Object.keys(t.stats).length >= 2).map((t) => ({
		name: `provisional tier ${t.key} stats literal`,
		re: new RegExp(Object.entries(t.stats).map(([k, v]) => `${k}\\s*:\\s*${num(v)}`).join('\\s*,\\s*')),
	})),
];

const problems = [];
const modules = fs.readdirSync(DIR).filter((f) => f.endsWith('.js') && !SHARED_FILES.has(f)).sort();
for (const file of modules) {
	const lines = fs.readFileSync(path.join(DIR, file), 'utf8').split('\n');
	lines.forEach((line, i) => {
		if (/\/\/\s*shared-ok:/.test(line) || /^\s*(\/\/|\*|\/\*)/.test(line)) return;
		for (const rule of RULES) {
			if (rule.re.test(line)) problems.push(`${file}:${i + 1} ${rule.name}: ${line.trim().slice(0, 120)}`);
		}
	});
}

function findStamp(obj, depth = 0) {
	if (!obj || typeof obj !== 'object' || depth > 3) return null;
	if (obj.frameworkVersion && obj.sharedDigest) return { frameworkVersion: obj.frameworkVersion, sharedDigest: obj.sharedDigest };
	for (const v of Object.values(obj)) {
		const s = findStamp(v, depth + 1);
		if (s) return s;
	}
	return null;
}

async function main() {
	let expected;
	try {
		expected = F.verifyShared();
	}
	catch (e) {
		problems.push(`framework: ${e.message}`);
		expected = { frameworkVersion: F.FRAMEWORK_VERSION, sharedDigest: F.sharedDigest() };
	}
	const results = {};
	for (const file of modules) {
		const mod = require(path.join(DIR, file));
		if (typeof mod.report !== 'function') {
			problems.push(`${file}: no report() export`);
			continue;
		}
		let report;
		try {
			report = await mod.report();
		}
		catch (e) {
			problems.push(`${file}: report() threw: ${e.message}`);
			continue;
		}
		const stamp = findStamp(report);
		results[file] = stamp;
		if (!stamp) {problems.push(`${file}: report() carries no { frameworkVersion, sharedDigest } stamp (use ...F.stamp())`);}
		else if (stamp.frameworkVersion !== expected.frameworkVersion || stamp.sharedDigest !== expected.sharedDigest) {
			problems.push(`${file}: report stamped ${stamp.frameworkVersion}/${stamp.sharedDigest}, framework is ${expected.frameworkVersion}/${expected.sharedDigest}`);
		}
	}
	const curveFile = path.join(DIR, '../../../docs/economy/5b/curve.json');
	if (fs.existsSync(curveFile)) {
		const curve = JSON.parse(fs.readFileSync(curveFile, 'utf8'));
		if (curve.chosen !== F.CURVE.quartic) problems.push(`curve.json chose quartic ${curve.chosen} but framework CURVE.quartic is ${F.CURVE.quartic}`);
		if (curve.sharedDigest && curve.sharedDigest !== expected.sharedDigest) problems.push(`curve.json was generated at digest ${curve.sharedDigest}; regenerate it (framework is ${expected.sharedDigest})`);
	}
	// Decision registry: candidate rules stay 'proposed' and match what the model runs.
	const decisions = require('./decisions').verify();
	for (const p of decisions.problems) problems.push(`decisions.js: ${p}`);
	const summary = { framework: expected, gearPathSource: F.GEAR_PATH_SOURCE, decisions: { ok: decisions.ok, count: decisions.count }, modules: results, problems };
	process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
	if (problems.length) process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
