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
	{ id: 'A-CURVE', status: 'approved-direction', title: 'Steeper, smooth post-20 XP curve', modelled: 'xp(L) = 100L^2 + qL^4, q chosen by sweep (curve.js); windows L20 5-6h, L30 12-15h, L40 24-30h, L50 40-45h (regular). The quartic term also raises pre-20 XP (x1.21 at L20): with quests and the streak adding XP, that is what keeps L20 inside 5-6 h (an unchanged pre-20 curve reaches L20 in 4.28 h)', alternatives: ['piecewise 100L^2 + q*max(0, L-20)^4 (today\'s curve to L20), which would need lower pre-20 daily/streak XP to keep L20 inside 5-6 h'], get: () => ({ base: F().CURVE.base, quartic: F().CURVE.quartic }), expected: { base: 100, quartic: 0.0525 } },
	{ id: 'A-MULTICATCH', status: 'approved-direction', title: 'Normal multi-catch: progression-based and probabilistic (~1.0 to 1.5-1.8 average, 3-5 fish jackpots)', modelled: 'rods.js tiers + framework chain (jackpotChain 0.35, max 5)', get: () => F().MULTI, expected: { jackpotChain: 0.35, maxFish: 5 } },
	{ id: 'A-PERMITS', status: 'approved-direction', title: 'One-time biome permits priced from previous-stage earnings, grandfathered', modelled: 'world.js' },
	{ id: 'A-TOPGG', status: 'approved-direction', title: 'Retire Top.gg; DCC-native streak (Streak Crate); Voter\'s Crates openable forever', modelled: 'streak.js' },
	{ id: 'A-FOUNDER-VISIBLE', status: 'approved-direction', title: 'Founder: fewer visible fish (~4 on strong casts), private multipliers preserve effective power', modelled: 'founder.js' },
	{ id: 'A-PUBLIC-LEVEL', status: 'approved-direction', title: 'Public level from base/competitive XP; private /fishing-stats shows the real level', modelled: 'founder.js F1' },
	{ id: 'A-GEAR-PATH', status: 'approved-direction', title: 'R3: one authoritative gear path (rods design) for the integrated economy', get: () => F().GEAR_PATH_SOURCE, expected: 'rods' },

	// ----- Proposed candidate rules the shared framework models (NOT approved) -----
	{ id: 'P-VALUE-MODEL', status: 'proposed', title: 'Fish value model: expected value = biome base x rarity x quality x species factor (clamped), replacing today\'s per-species catalog values', modelled: 'BIOME_VALUE (live ladder), RARITY_VALUE, QUALITY_VALUE strong x1.3, SPECIES_CLAMP [0.8, 1.25] (framework.js; table in the report)', alternatives: ['today\'s catalog values (the biome ladder is not monotonic: River pays more per fish than Lake, Pond, Coast and Swamp on the Old Rod)', 'the Phase 5 P5 ladder (25..150)'], source: 'framework (Phase 5 proposal P5, re-derived in 5B)', why: 'every biome pays more than the one before at every tier, so progression is always an income step; rarity and quality order always hold', get: () => ({ biome: Object.fromEntries(Object.entries(F().BIOME_VALUE).filter(([b]) => F().LIVE_BIOMES.includes(b))), rarity: F().RARITY_VALUE, quality: F().QUALITY_VALUE, clamp: F().SPECIES_CLAMP }), expected: { biome: { Ocean: 18, River: 29, Lake: 43, Pond: 61, Coast: 82, Swamp: 107 }, rarity: { common: 1, uncommon: 1.6, rare: 3, ultra: 6, giant: 12, legendary: 25, lucky: 50 }, quality: { weak: 1, strong: 1.3 }, clamp: [0.8, 1.25] } },
	{ id: 'P-XP-RARITY', status: 'proposed', title: 'XP per fish weighted by rarity: the 10-25 roll (mean 17) x a rarity weight', modelled: 'XP_RARITY common 1, uncommon 1.2, rare 1.5, ultra 2, giant 2.5, legendary 4, lucky 6 (adds about 10-13% XP per fish by tier)', alternatives: ['today: a flat 10-25 roll for every rarity'], source: 'framework (Phase 5 proposal P4)', why: 'with multi-catch reduced, rarer fish carry more of the XP; the curve (R1) was fitted with this rule on', get: () => ({ mean: F().XP_PER_FISH_MEAN, weights: F().XP_RARITY }), expected: { mean: 17, weights: { common: 1, uncommon: 1.2, rare: 1.5, ultra: 2, giant: 2.5, legendary: 4, lucky: 6 } } },
	{ id: 'P-SAVINGS', status: 'proposed', title: 'Accept the savings surplus at release and watch it through telemetry (decision 10: players can save)', modelled: 'reference loop to Lv 60: players keep about 70-75% of all income (report: Income and sinks); no extra sink is added', alternatives: ['display tanks promoted as the aspirational sink (31-35% of income when bought; report: Aquarium)', 'a higher permit stage share (P-WORLD-PERMIT-SHARE)', 'Mountain Stream and post-60 expansions as the next progression sinks (not live yet)', 'XP bait as the time-for-money sink (P-BAIT-XP-SIZING)'], source: 'integration (summary.js sink table)', why: 'no blanket sink target (decision 10); upkeep and progression are sized from stage income, so the surplus is what quests, streak and buffs add on top; its use is a design choice, not a balance error' },
	{ id: 'P-LEGACY-WEALTH', status: 'proposed', title: 'Carried wealth at release: existing money, unsold fish (at their stored values), rods, parts and crates enter the new economy unchanged; nothing is wiped or clawed back', modelled: 'accept (standing constraint: never wipe user or progression data; additive migrations only). Production has very few accounts (the publicXp migration initialised 2)', alternatives: ['per-item rules only where the redefinition itself creates an arbitrage (owned Fishing Crates: P-RODS-FISHING-CRATE; legacy rod durability: P-RODS-LEGACY-DURABILITY)'], source: 'integration (adversarial review)', why: 'every simulated lifecycle starts a new player; legacy balances are far above new-economy stage income, so the size must be read from production before release and stated' },
	{ id: 'P-LUCKY', status: 'proposed', title: 'Pin Lucky-item odds to the normal base rate for every luck source', modelled: 'pinned', alternatives: ['engine (today: 20% of every Lucky roll is an item)'], source: 'bait + founder designs', why: 'keeps Booster Packs an Easter egg (decision 12) when gear, bait, Founder or pity raise Lucky', get: () => F().RULES.luckyItems, expected: 'pinned' },
	{ id: 'P-DURABILITY', status: 'proposed', title: 'Stochastic durability charge n x (1 - efficiency), no minimum', modelled: 'stochastic', alternatives: ['engine (today: max(1, ceil(n x (1 - efficiency))))'], source: 'founder design D5', why: 'identical for normal rods (efficiency 0); makes Founder durability efficiency meaningful', get: () => F().RULES.durability, expected: 'stochastic' },
	{ id: 'P-DOUBLE-CASH', status: 'proposed', title: 'Double Cash rewards fish CAUGHT during the buff (catch-time stamp)', modelled: 'catch', alternatives: ['sale (today: applies at sale; hoarding allowed), optionally with a bonus cap'], source: 'buffs design (user decision 8 asked for a deliberate choice)', why: 'a buff multiplies play, never a stockpile', get: () => F().BUFFS.doubleCashTiming, expected: 'catch' },
	{ id: 'P-MS-VALUE', status: 'proposed', title: 'Mountain Stream base value 143 -> 149', modelled: 149, alternatives: [143], source: 'world design', why: 'keeps its step over Swamp inside the live ladder band (not live content either way)', get: () => F().BIOME_VALUE['Mountain Stream'], expected: 149 },
	{ id: 'P-EVENTS', status: 'proposed', title: 'Event budget: 1 Double Cash + 1 Lucky Draw per 30 days, no XP events', modelled: { 'Double XP': 0, 'Double Cash': 1, 'Lucky Draw': 1 }, alternatives: ['no events', 'other budgets'], source: 'buffs design', get: () => F().EVENTS.buffsPerThirtyDays, expected: { 'Double XP': 0, 'Double Cash': 1, 'Lucky Draw': 1 } },
	{ id: 'P-DAY', status: 'proposed', title: 'DCC day starts at 00:00 UTC (daily quests and streak)', modelled: 0, alternatives: ['another UTC hour'], source: 'quests + streak designs', get: () => F().DAY.startUtcHour, expected: 0 },
	{ id: 'P-DAILY-FACTOR', status: 'proposed', title: 'Daily/weekly quests pay 1.0x the XP and cash of the fishing they require (a daily at most doubles its own session)', modelled: 1, alternatives: ['0.75 (regular L50 45.5 h, outside the window without a curve refit; casual catch-up 0.94 at L50)', '0.5 (regular L50 47.3 h; casual catch-up 1.04 at L50, i.e. casual slower than regular)'], source: 'quests design; R2 guardrail (docs/economy/5b/r2.json guardrailSensitivity; quests.md factor sensitivity)', why: 'the casual catch-up lever: minimum-daily players never lead engaged players by calendar week, but their XP per active hour is 1.6x the regular player\'s at day 365 (1.9-2.0x at equal level, L20-L50). User direction: keep 1.0, no curve refit, flag the ratio for post-release telemetry', get: () => { const q = require('./quests').PARAMS; return [q.daily.reward.xpK, q.daily.reward.cashK, q.weekly.reward.xpK, q.weekly.reward.cashK]; }, expected: [1, 1, 1, 1] },
	{ id: 'P-CURVE-EXISTING', status: 'proposed', title: 'Existing players at the curve change: keep the stored level (level = max(stored, curve(xp)), never demoted); the next level-up waits until XP reaches the new curve for stored level + 1', modelled: 'no-demotion freeze (not simulated: every lifecycle starts a new player)', alternatives: ['rescale each player\'s XP once so the stored level and the fraction of the way to the next level are kept on the new curve (rewrites xp/publicXp: an idempotent migration with a marker, but it changes progression data)', 'recompute the level from XP on the new curve (demotes players; conflicts with "never demote")'], source: 'framework (A-CURVE no-demotion rule)', why: 'the steeper curve raises the XP for Lv 50 from 250,000 to 578,125, so a player at today\'s Lv 50 sits at Lv 50 until 615,273 XP (Lv 51 on the new curve); far-ahead players (Lv 100+ today) would not level for a long time. Production has very few accounts (the publicXp migration initialised 2), so either option is cheap; the freeze is the only one that rewrites nothing. Implementation requirement: every level read and write (cast.js level write, getLevel, getPublicLevel, publicProgressOf, dev.js) goes through max(stored, curve), and the PUBLIC level gets the same stored floor for every player (P-FOUNDER-PUBLIC-LEVEL), otherwise the first cast after the change writes the lower new-curve level' },
	{ id: 'P-FOUNDER-GATE', status: 'proposed', title: 'Founder: gameplay gates read the PUBLIC level', modelled: 'public', alternatives: ['real'], source: 'founder design D1', why: 'otherwise the Founder fishes Swamp at public Lv ~10 within the first hour. For normal players public = real level only while both keep the stored no-demotion floor at the curve change (P-FOUNDER-PUBLIC-LEVEL, P-CURVE-EXISTING)', get: () => require('./integrate').DEFAULT_FOUNDER_GATE, expected: 'public' },
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
