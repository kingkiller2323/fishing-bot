// Phase 5B FINAL REPORT tables (docs/economy/PHASE5B_REPORT.md). Every number in the report is generated
// here, never hand-typed, from:
//   - the integrated model at the current framework version (integrate.run on the shared core),
//   - the R1 record (docs/economy/5b/curve-integrated.json) and the R2 record (docs/economy/5b/r2.json),
//   - today's economy as simulated in Phase 5 (docs/economy/simulation.json, the "Current" columns),
//   - the decision registry (decisions.js, every module's DECISIONS),
//   - each module's own generated tables (re-emitted verbatim under the same block id).
// render-docs.js renders it like a module doc and check-shared.js fails when the report is stale.
//
//   node scripts/economy/5b/render-docs.js          (rewrites the report's generated blocks)
const fs = require('node:fs');
const path = require('node:path');
const F = require('./framework');
const I = require('./integrate');

const DOCS = path.join(__dirname, '../../../docs/economy');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(DOCS, rel), 'utf8'));
const ARCH = Object.keys(F.ARCHETYPES);
const MILESTONES = F.LIFECYCLE.milestones;
const WINDOW_LEVELS = Object.keys(F.TARGET_WINDOWS).map(Number);

const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const money = (n) => `$${fmt(n)}`;
const pct = (x, d = 1) => `${fmt(x * 100, d)}%`;
const cell = (v) => String(v ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');
function table(head, rows) {
	return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}
const windowText = (L) => `${F.TARGET_WINDOWS[L][0]}–${F.TARGET_WINDOWS[L][1]} h`;

const memo = new Map();
function run(key, opts) {
	if (!memo.has(key)) memo.set(key, I.run(opts));
	return memo.get(key);
}
const reference = (a) => run(`ref:${a}`, { archetype: a });

// ----- Current (today, Phase 5 simulation) vs proposed (integrated 5b.4) -----

function curveTable() {
	const c = readJson('5b/curve-integrated.json');
	const today = readJson('simulation.json').players.regular.core.milestones;
	const levels = Object.keys(c.thresholds).map(Number);
	const rows = levels.map((L) => {
		const t = c.thresholds[L];
		const th = today[`level${L}`];
		const ph = c.archetypes.regular[L];
		return [
			`Lv ${L}`, fmt(t.today), fmt(t.chosen), `×${fmt(t.chosen / t.today, 2)}`,
			th ? `${fmt(th.hours, 2)} h (day ${th.day})` : '—',
			ph ? `${fmt(ph.hours, 2)} h (day ${ph.day})` : 'beyond Lv 60 (not modelled)',
			F.TARGET_WINDOWS[L] ? windowText(L) : '—',
		];
	});
	return `Current: \`level = floor(0.1·√xp)\` (xp(L) = 100·L²). Proposed: xp(L) = ${F.CURVE.base}·L² + ${F.CURVE.quartic}·L⁴ (framework CURVE, chosen by the integrated R1 sweep); a player's level never drops (\`level = max(stored, curve)\`).\n\n${table(
		['Level', 'Total XP today', 'Total XP proposed', 'Proposed ÷ today', 'Regular player today (Phase 5 core loop)', 'Regular player proposed (integrated)', 'Approved window'],
		rows,
	)}`;
}

function progressionTable() {
	const sim = readJson('simulation.json').players;
	const rows = [];
	for (const a of ARCH) {
		const today = sim[a].core.milestones;
		rows.push([`${a} — today`, ...MILESTONES.map((L) => {
			const m = today[`level${L}`];
			return m ? `${fmt(m.hours, 2)} h (d${m.day})` : `not in ${sim[a].core.days} d`;
		})]);
		const r = reference(a);
		rows.push([`**${a} — proposed**`, ...MILESTONES.map((L) => {
			const m = r.milestones[L];
			return m ? `**${fmt(m.hours, 2)} h (d${m.day})**` : '—';
		})]);
	}
	const md = run('ref:minimumDaily', { archetype: F.MINIMUM_DAILY.name, stopAtLevel: null, days: 365 });
	rows.push(['minimum-daily player — proposed (R2 adversary)', ...MILESTONES.map((L) => {
		const m = md.milestones[L];
		return m ? `${fmt(m.hours, 2)} h (d${m.day})` : 'not in 365 d';
	})]);
	const arch = ARCH.map((a) => `${a} ${F.ARCHETYPES[a].minutesPerDay} min/day`).join(', ');
	return `${table(['Player', ...MILESTONES.map((L) => `Lv ${L}`)], rows)}\n\nActive hours of play (calendar day). Archetypes: ${arch}. "Today" is the Phase 5 simulation of the live economy (fishing + daily quest, no votes, no exploits, 30-day horizon); "proposed" is the integrated reference loop (${I.REFERENCE_NOTE}).`;
}

function r1Table() {
	const c = readJson('5b/curve-integrated.json');
	const near = c.sweep.filter((s) => Math.abs(s.quartic - c.chosen) <= 0.0101);
	const rows = near.map((s) => [
		s.quartic === c.chosen ? `**${s.quartic}** (chosen)` : String(s.quartic),
		...WINDOW_LEVELS.map((L) => {
			const h = s.regular[L];
			const [lo, hi] = F.TARGET_WINDOWS[L];
			return `${fmt(h, 2)} h${h >= lo && h <= hi ? '' : ' (out)'}`;
		}),
		fmt(s.score, 4),
	]);
	return `${table(['Quartic q', ...WINDOW_LEVELS.map((L) => `Lv ${L} (${windowText(L)})`), 'Fit score (lower is better)'], rows)}\n\nSweep on the integrated reference loop (${c.method}); record \`docs/economy/5b/curve-integrated.json\`, generated at framework ${c.frameworkVersion} (digest ${c.sharedDigest}). The regular player is in every approved window: **${c.framework.allInWindow ? 'yes' : 'NO'}**.`;
}

function r2Tables() {
	const r2 = readJson('5b/r2.json');
	const levels = Object.keys(r2.catchUp).map(Number);
	const decRows = [];
	for (const a of ARCH) {
		for (const L of levels) {
			const d = r2.decomposition[a][L];
			if (!d) continue;
			decRows.push([`${a} Lv ${L}`, `${fmt(d.activeHours, 2)} h (d${d.day})`, pct(d.share.fishing), pct(d.share.quests), pct(d.share.daily), pct(d.share.buffs), pct(d.share.other)]);
		}
	}
	const decomposition = table(['Player, level', 'Active hours (day)', 'Fishing', 'Quests (story + repeatable)', 'Daily systems (daily + weekly)', 'Buffs', 'Other'], decRows);
	const days = Object.keys(r2.calendar[F.MINIMUM_DAILY.name]).map(Number);
	const calRows = [F.MINIMUM_DAILY.name, ...ARCH].map((a) => [a === F.MINIMUM_DAILY.name ? '**minimum-daily**' : a, ...days.map((d) => {
		const t = r2.calendar[a][d];
		return t ? `Lv ${t.level} · ${fmt(t.activeHours, 1)} h · ${fmt(t.xpPerActiveHour)} XP/h` : '—';
	})]);
	const calendar = table(['Player', ...days.map((d) => `Day ${d}`)], calRows);
	const grinderRows = Object.entries(r2.noMissGrinder.shift).map(([L, s]) => [`Lv ${L}`, `${fmt(s.withDailySystems, 2)} h`, `${fmt(s.fishingOnly, 2)} h`, `${fmt(s.hoursSaved, 2)} h`, pct(s.share)]);
	const grinder = table(['Grinder', 'With every daily/streak/repeatable reward', 'Fishing (and gear/permits) only', 'Hours saved', 'Share'], grinderRows);
	const catchUp = table(['Casual ÷ regular active hours', ...levels.map((L) => `Lv ${L}`)], [['integrated reference loop', ...levels.map((L) => fmt(r2.catchUp[L], 3))]]);
	return {
		'summary-r2-decomposition': `${decomposition}\n\n${catchUp}\n\nA casual player needs ${fmt(Math.min(...Object.values(r2.catchUp)), 2)}–${fmt(Math.max(...Object.values(r2.catchUp)), 2)}× the regular player's active hours per level: the daily systems (daily/weekly quests, streak) make up the difference (decision 1).`,
		'summary-r2-adversaries': `**Minimum-daily player** (plays each DCC day only until every daily minimum is met; average ${fmt(r2.minimumDaily.minutesPerDayAverage, 2)} min/day):\n\n${calendar}\n\n- ${r2.minimumDaily.verdict}\n\n**No-miss grinder:**\n\n${grinder}\n\n- ${r2.noMissGrinder.verdict}`,
	};
}

function dailyFactorTable() {
	const s = readJson('5b/r2.json').guardrailSensitivity;
	const days = Object.keys(s['1'].minimumDaily).map(Number);
	const lastDay = days[days.length - 1];
	const rows = Object.entries(s).sort(([a], [b]) => Number(b) - Number(a)).map(([k, v]) => [
		k === '1' ? '**1.0 (proposed default)**' : `${Number(k).toFixed(2)}×`,
		...WINDOW_LEVELS.map((L) => `${fmt(v.regularHours[L], 2)} h`),
		v.regularInWindows ? 'yes' : '**no** (needs a curve refit)',
		fmt(v.casualCatchUpL50, 3),
		days.map((d) => `${v.minimumDaily[d]}/${v.casual[d]}`).join(' · '),
		`${fmt(v.minimumDailyXpPerHourVsRegularDay365, 2)}×`,
	]);
	return `${table(
		['Daily/weekly factor', ...WINDOW_LEVELS.map((L) => `Regular Lv ${L}`), 'Regular in every window', 'Casual ÷ regular hours at Lv 50', `Minimum-daily / casual level at days ${days.join(', ')}`, `Minimum-daily XP per active hour ÷ regular (day ${lastDay})`],
		rows,
	)}\n\nSame curve (q = ${F.CURVE.quartic}) in every row; only the daily and weekly quest reward scale changes (analysis option \`quests.system({ rewardScale })\`). Record: \`docs/economy/5b/r2.json\` guardrailSensitivity.`;
}

function sinksTable() {
	const rows = [];
	const add = (label, r) => {
		const s = I.sinkSummary(r);
		const share = (c) => s.byCategory[c]?.share ?? 0;
		rows.push([label, money(s.income), pct((s.sources.fishing || 0) / s.income), pct(share('upkeep')), pct(share('progression')), pct(share('optional')), pct(share('aspirational')), `${pct(s.savedShare)} (${money(s.saved)})`]);
	};
	for (const a of ARCH) add(`${a} — reference loop`, reference(a));
	for (const [label, variant] of [['bait: money baits', { bait: 'cash' }], ['bait: XP baits', { bait: 'xp' }], ['aquarium', { aquarium: true }], ['money baits + aquarium', { bait: 'cash', aquarium: true }]]) {
		add(`regular + ${label}`, run(`regular:${JSON.stringify(variant)}`, { archetype: 'regular', variant }));
	}
	return `${table(['Player (to Lv 60)', 'All income', 'From fishing', 'Upkeep', 'Progression', 'Optional', 'Aspirational', 'Saved at Lv 60'], rows)}\n\nSinks are split by category (decision 10); shares are of all income to Lv 60. Upkeep = repairs; progression = rod-tier crates and permits; optional = bait and aquarium licenses; aspirational = display tanks.`;
}

function decisionsTable() {
	const D = require('./decisions');
	const short = (v) => {
		if (v == null) return '—';
		const s = typeof v === 'string' ? v : JSON.stringify(v);
		return s.length > 160 ? `${s.slice(0, 157)}…` : s;
	};
	const rows = D.table().map((d) => [`\`${d.id}\``, d.status === 'proposed' ? 'proposed' : 'direction approved, numbers pending', d.module, d.title, short(d.modelled), short(Array.isArray(d.alternatives) ? d.alternatives.join('; ') : d.alternatives)]);
	const counts = D.table().reduce((a, d) => ({ ...a, [d.status]: (a[d.status] || 0) + 1 }), {});
	return `${Object.entries(counts).map(([k, v]) => `**${v}** ${k}`).join(' · ')}. Nothing in this table is user-approved as a final rule; \`decisions.verify()\` proves each modelled value is what the model runs.\n\n${table(['ID', 'Status', 'Module', 'Decision', 'Modelled (proposed)', 'Alternatives'], rows)}`;
}

function headlineTable() {
	const r2 = readJson('5b/r2.json');
	const reg = reference('regular');
	const windows = WINDOW_LEVELS.map((L) => {
		const h = reg.milestones[L].hours;
		const [lo, hi] = F.TARGET_WINDOWS[L];
		return `Lv ${L} ${fmt(h, 2)} h (${lo}–${hi}${h >= lo && h <= hi ? ', in' : ', OUT'})`;
	}).join(' · ');
	const gear = F.gearPath();
	const prices = require('./world').permitPriceMap();
	const sinks = ARCH.map((a) => I.sinkSummary(reference(a)));
	const range = (xs, f) => `${f(Math.min(...xs))}–${f(Math.max(...xs))}`;
	const share = (s, c) => s.byCategory[c]?.share ?? 0;
	const catchUp = Object.values(r2.catchUp);
	const D = require('./decisions');
	const counts = D.table().reduce((a, d) => ({ ...a, [d.status]: (a[d.status] || 0) + 1 }), {});
	return table(['Figure (framework 5b.4, integrated model)', 'Value'], [
		['Regular player, active hours to each window level', windows],
		['Regular player to Lv 60 (the Mountain Stream level)', `${fmt(reg.milestones[F.LIFECYCLE.maxLevel].hours, 2)} h (day ${reg.milestones[F.LIFECYCLE.maxLevel].day})`],
		['Casual ÷ regular active hours per level (Lv 20–50)', range(catchUp, (x) => fmt(x, 3))],
		['Normal fish per cast by gear step (multi-catch mean)', gear.map((t) => `${t.key === 'old' ? 'Old Rod' : t.key.toUpperCase()} ${fmt(t.meanFish, 2)}`).join(' · ')],
		['Chance of a 3+ fish jackpot by gear step', gear.map((t) => pct(t.jackpot3plus ?? 0)).join(' · ')],
		['Permit prices', Object.entries(prices).map(([b, p]) => `${b} ${money(p)}`).join(' · ')],
		['Share of all income to Lv 60: upkeep / progression / saved', `${range(sinks.map((s) => share(s, 'upkeep')), pct)} / ${range(sinks.map((s) => share(s, 'progression')), pct)} / ${range(sinks.map((s) => s.savedShare), pct)}`],
		['Minimum-daily player (R2)', `${r2.minimumDaily.leadsAnEngagedArchetypeOnDays.length ? 'LEADS an engaged player' : 'never leads an engaged player by calendar day'}; XP per active hour ${fmt(r2.minimumDaily.xpPerActiveHourVsRegular, 2)}× the regular player's (day 365)`],
		['No-miss grinder (R2): play-hours saved by every daily/streak/repeatable reward', `at most ${pct(r2.noMissGrinder.maxShareOfHoursSaved)}`],
		['Decisions awaiting approval', Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')],
	]);
}

function stampTable() {
	const D = require('./decisions');
	const v = D.verify();
	const c = readJson('5b/curve-integrated.json');
	return table(['Item', 'Value'], [
		['Framework version', `**${F.FRAMEWORK_VERSION}**`],
		['Shared digest', `**${F.sharedDigest()}**`],
		['XP curve', `xp(L) = ${F.CURVE.base}·L² + ${F.CURVE.quartic}·L⁴ (R1 integrated best fit ${c.chosen})`],
		['Gear path (R3)', `${F.GEAR_PATH_SOURCE} (one authoritative path)`],
		['Reference loop', I.REFERENCE_NOTE],
		['Decision registry', `${v.count} entries, verify ${v.ok ? 'passes' : `FAILS (${v.problems.length})`}`],
	]);
}

// Module tables re-emitted verbatim (same block ids as in the module docs).
const REEMIT = {
	rods: ['rods-current-proposed', 'rods-gear-path', 'rods-crates', 'rods-upkeep'],
	world: ['world-current-proposed', 'world-permit-table', 'world-time-to-afford', 'world-ms-ladder'],
	bait: ['bait-current', 'bait-proposed', 'bait-xp-sizing'],
	quests: ['quests-fixes', 'quests-kinds', 'quests-bands', 'quests-story'],
	streak: ['streak-current-proposed', 'streak-ladder'],
	buffs: ['buffs-bugs', 'buffs-current-proposed', 'buffs-income-share'],
	aquarium: [],
	founder: [],
};

function markdownTables() {
	const out = {
		'summary-stamp': stampTable(),
		'summary-headline': headlineTable(),
		'summary-curve': curveTable(),
		'summary-progression': progressionTable(),
		'summary-r1': r1Table(),
		...r2Tables(),
		'summary-daily-factor': dailyFactorTable(),
		'summary-sinks': sinksTable(),
		'summary-decisions': decisionsTable(),
	};
	for (const [m, ids] of Object.entries(REEMIT)) {
		if (!ids.length) continue;
		const tables = require(`./${m}`).markdownTables();
		for (const id of ids) {
			if (!(id in tables)) throw new Error(`${m}.js markdownTables() has no block ${id}`);
			out[id] = `${tables[id].trim()}\n\n*(From \`docs/economy/5b/${m}.md\`.)*`;
		}
	}
	return out;
}

function report() {
	return { ...F.stamp(), blocks: Object.keys(markdownTables()) };
}

module.exports = { markdownTables, report, REEMIT };
