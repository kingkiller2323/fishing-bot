// Phase 5B DECISION REGISTRY: which modelled choices are approved by the user and which are only
// PROPOSED. An analysis-framework choice must never silently become a production design decision:
// every candidate rule the model runs is listed here as 'proposed' with its alternatives, and
// check-shared.js verifies each entry's modelled value is the one the framework actually runs.
//
// Statuses:
//   'approved-direction'  the user approved the direction (e.g. "reduce normal multi-catch"); the
//                         specific numbers still await approval of the final Phase 5B tables
//   'proposed'            a recommendation the model runs so numbers are comparable; NOT approved
// No entry may claim more than that: final approval happens only after the user reviews Phase 5B.
const STATUSES = ['approved-direction', 'proposed'];

/** Lazily read a modelled value (framework/integrator), so this file never copies one. */
const F = () => require('./framework');

const DECISIONS = [
	// ----- Approved directions (user messages during Phase 5 / 5B); numbers pending final approval -----
	{ id: 'A-CURVE', status: 'approved-direction', title: 'Steeper, smooth post-20 XP curve', modelled: 'xp(L) = 100L^2 + qL^4, q chosen by sweep (curve.js); windows L20 5-6h, L30 12-15h, L40 24-30h, L50 40-45h (regular)', get: () => ({ base: F().CURVE.base, quartic: F().CURVE.quartic }), expected: { base: 100, quartic: 0.0525 } },
	{ id: 'A-MULTICATCH', status: 'approved-direction', title: 'Normal multi-catch: progression-based and probabilistic (~1.0 to 1.5-1.8 average, 3-5 fish jackpots)', modelled: 'rods.js tiers + framework chain (jackpotChain 0.35, max 5)', get: () => F().MULTI, expected: { jackpotChain: 0.35, maxFish: 5 } },
	{ id: 'A-PERMITS', status: 'approved-direction', title: 'One-time biome permits priced from previous-stage earnings, grandfathered', modelled: 'world.js' },
	{ id: 'A-TOPGG', status: 'approved-direction', title: 'Retire Top.gg; DCC-native streak (Streak Crate); Voter\'s Crates openable forever', modelled: 'streak.js' },
	{ id: 'A-FOUNDER-VISIBLE', status: 'approved-direction', title: 'Founder: fewer visible fish (~4 on strong casts), private multipliers preserve effective power', modelled: 'founder.js' },
	{ id: 'A-PUBLIC-LEVEL', status: 'approved-direction', title: 'Public level from base/competitive XP; private /fishing-stats shows the real level', modelled: 'founder.js F1' },
	{ id: 'A-GEAR-PATH', status: 'approved-direction', title: 'R3: one authoritative gear path (rods design) for the integrated economy', get: () => F().GEAR_PATH_SOURCE, expected: 'rods' },

	// ----- Proposed candidate rules the shared framework models (NOT approved) -----
	{ id: 'P-LUCKY', status: 'proposed', title: 'Pin Lucky-item odds to the normal base rate for every luck source', modelled: 'pinned', alternatives: ['engine (today: 20% of every Lucky roll is an item)'], source: 'bait + founder designs', why: 'keeps Booster Packs an Easter egg (decision 12) when gear, bait, Founder or pity raise Lucky', get: () => F().RULES.luckyItems, expected: 'pinned' },
	{ id: 'P-DURABILITY', status: 'proposed', title: 'Stochastic durability charge n x (1 - efficiency), no minimum', modelled: 'stochastic', alternatives: ['engine (today: max(1, ceil(n x (1 - efficiency))))'], source: 'founder design D5', why: 'identical for normal rods (efficiency 0); makes Founder durability efficiency meaningful', get: () => F().RULES.durability, expected: 'stochastic' },
	{ id: 'P-DOUBLE-CASH', status: 'proposed', title: 'Double Cash rewards fish CAUGHT during the buff (catch-time stamp)', modelled: 'catch', alternatives: ['sale (today: applies at sale; hoarding allowed), optionally with a bonus cap'], source: 'buffs design (user decision 8 asked for a deliberate choice)', why: 'a buff multiplies play, never a stockpile', get: () => F().BUFFS.doubleCashTiming, expected: 'catch' },
	{ id: 'P-MS-VALUE', status: 'proposed', title: 'Mountain Stream base value 143 -> 149', modelled: 149, alternatives: [143], source: 'world design', why: 'keeps its step over Swamp inside the live ladder band (not live content either way)', get: () => F().BIOME_VALUE['Mountain Stream'], expected: 149 },
	{ id: 'P-EVENTS', status: 'proposed', title: 'Event budget: 1 Double Cash + 1 Lucky Draw per 30 days, no XP events', modelled: { 'Double XP': 0, 'Double Cash': 1, 'Lucky Draw': 1 }, alternatives: ['no events', 'other budgets'], source: 'buffs design', get: () => F().EVENTS.buffsPerThirtyDays, expected: { 'Double XP': 0, 'Double Cash': 1, 'Lucky Draw': 1 } },
	{ id: 'P-DAY', status: 'proposed', title: 'DCC day starts at 00:00 UTC (daily quests and streak)', modelled: 0, alternatives: ['another UTC hour'], source: 'quests + streak designs', get: () => F().DAY.startUtcHour, expected: 0 },
	{ id: 'P-DAILY-FACTOR', status: 'proposed', title: 'Daily/weekly quests pay 1.0x the XP and cash of the fishing they require (a daily at most doubles its own session)', modelled: 1, alternatives: ['0.75 (regular L50 45.5 h, outside the window without a curve refit; casual catch-up 0.94 at L50)', '0.5 (regular L50 47.3 h; casual catch-up 1.04 at L50, i.e. casual slower than regular)'], source: 'quests design; R2 guardrail (docs/economy/5b/r2.json guardrailSensitivity; quests.md factor sensitivity)', why: 'the casual catch-up lever: minimum-daily players never lead engaged players by calendar week, but their XP per active hour is 1.6x the regular player\'s at day 365 (1.9-2.0x at equal level, L20-L50). User direction: keep 1.0, no curve refit, flag the ratio for post-release telemetry', get: () => { const q = require('./quests').PARAMS; return [q.daily.reward.xpK, q.daily.reward.cashK, q.weekly.reward.xpK, q.weekly.reward.cashK]; }, expected: [1, 1, 1, 1] },
	{ id: 'P-CURVE-EXISTING', status: 'proposed', title: 'Existing players at the curve change: keep the stored level (level = max(stored, curve(xp)), never demoted); the next level-up waits until XP reaches the new curve for stored level + 1', modelled: 'no-demotion freeze (not simulated: every lifecycle starts a new player)', alternatives: ['rescale each player\'s XP once so the stored level and the fraction of the way to the next level are kept on the new curve (rewrites xp/publicXp: an idempotent migration with a marker, but it changes progression data)', 'recompute the level from XP on the new curve (demotes players; conflicts with "never demote")'], source: 'framework (A-CURVE no-demotion rule)', why: 'the steeper curve raises the XP for Lv 50 from 250,000 to 578,125, so a player at today\'s Lv 50 sits at Lv 50 until 615,273 XP (Lv 51 on the new curve); far-ahead players (Lv 100+ today) would not level for a long time. Production has very few accounts (the publicXp migration initialised 2), so either option is cheap; the freeze is the only one that rewrites nothing' },
	{ id: 'P-FOUNDER-GATE', status: 'proposed', title: 'Founder: gameplay gates read the PUBLIC level', modelled: 'public', alternatives: ['real'], source: 'founder design D1', why: 'otherwise the Founder fishes Swamp at public Lv ~10 within the first hour', get: () => require('./integrate').DEFAULT_FOUNDER_GATE, expected: 'public' },
];

// Subsystem modules export their own proposed decisions (same shape) as DECISIONS; they join the
// registry here so there is ONE list for the Phase 5B report.
const MODULES = ['rods', 'bait', 'quests', 'streak', 'aquarium', 'founder', 'buffs', 'world'];
function all() {
	const out = DECISIONS.map((d) => ({ module: 'framework', ...d }));
	for (const m of MODULES) {
		const list = require(`./${m}`).DECISIONS;
		if (Array.isArray(list)) out.push(...list.map((d) => ({ module: m, ...d })));
	}
	return out;
}

/** Verifies the registry: allowed statuses only, unique ids, and every modelled value is what runs. */
function verify() {
	const problems = [];
	const seen = new Set();
	for (const m of MODULES) if (!Array.isArray(require(`./${m}`).DECISIONS)) problems.push(`${m}.js exports no DECISIONS array`);
	for (const d of all()) {
		if (seen.has(d.id)) problems.push(`duplicate decision id ${d.id}`);
		seen.add(d.id);
		if (!STATUSES.includes(d.status)) problems.push(`${d.id}: status '${d.status}' is not allowed (${STATUSES.join(', ')}); only the user approves final rules`);
		if (d.get) {
			const actual = JSON.stringify(d.get());
			if (actual !== JSON.stringify(d.expected)) problems.push(`${d.id}: registry says ${JSON.stringify(d.expected)} but the model runs ${actual}`);
		}
	}
	// Every candidate engine rule the framework runs must be registered as a decision.
	const covered = new Set(DECISIONS.filter((d) => d.get).map((d) => String(d.get)));
	const rulesCovered = Object.keys(F().RULES).every((k) => DECISIONS.some((d) => String(d.get).includes(`RULES.${k}`)));
	if (!rulesCovered) problems.push(`an entry of RULES (${Object.keys(F().RULES).join(', ')}) has no decision entry`);
	return { ok: problems.length === 0, problems, count: all().length, covered: covered.size };
}

/** Plain rows for the report (proposed first). */
// The `get`/`expected` verification fields are left out of the report rows.
const table = () => all().map((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'get' && k !== 'expected'))).sort((a, b) => (a.status === b.status ? 0 : a.status === 'proposed' ? -1 : 1));

module.exports = { STATUSES, DECISIONS, MODULES, all, verify, table };
