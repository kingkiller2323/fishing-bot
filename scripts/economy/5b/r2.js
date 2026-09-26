// Phase 5B requirement R2 (docs/economy/5b/INTEGRATION_REQUIREMENTS.md), on the INTEGRATED model:
//   1. XP by source for casual / regular / active / grinder at L20/30/40/50: fishing, quests (story +
//      repeatable), daily systems (daily + weekly quests), buffs, other; shares, calendar days, active hours.
//   2. Adversarial: the minimum-daily player (F.MINIMUM_DAILY: plays each day only until every daily
//      system's minimum is met) against engaged players, by calendar week and per active hour.
//   3. Adversarial: the no-miss grinder with every daily/streak/repeatable reward vs without them.
//
//   node scripts/economy/5b/r2.js > docs/economy/5b/r2.json
const F = require('./framework');
const I = require('./integrate');

const LEVELS = [20, 30, 40, 50];
const DAYS = [7, 28, 91, 182, 365];
// Ledger sources grouped into the columns R2 asks for; anything unlisted lands in 'other'.
const GROUPS = { fishing: ['fishing'], quests: ['story', 'repeatable'], daily: ['daily', 'weekly'], buffs: ['buff'] };
const groupOf = (source) => Object.keys(GROUPS).find((g) => GROUPS[g].includes(source)) || 'other';

function decompose(result) {
	const out = {};
	for (const L of LEVELS) {
		const m = result.milestones[L];
		if (!m) {
			out[L] = null;
			continue;
		}
		const xp = { fishing: 0, quests: 0, daily: 0, buffs: 0, other: 0 };
		for (const [src, v] of Object.entries(m.ledger.xp)) xp[groupOf(src)] += v;
		const total = Object.values(xp).reduce((a, b) => a + b, 0);
		out[L] = {
			day: m.day, activeHours: +m.hours.toFixed(2), totalXp: Math.round(total),
			xp: Object.fromEntries(Object.entries(xp).map(([k, v]) => [k, Math.round(v)])),
			share: Object.fromEntries(Object.entries(xp).map(([k, v]) => [k, +(v / total).toFixed(4)])),
			otherSources: Object.keys(m.ledger.xp).filter((s) => groupOf(s) === 'other'),
		};
	}
	return out;
}

const levelOnDay = (result, day) => result.timeline.find((t) => t.day === day) || null;

function runAll(opts = {}) {
	const out = {};
	for (const a of [...Object.keys(F.ARCHETYPES), F.MINIMUM_DAILY.name]) {
		out[a] = I.run({ archetype: a, stopAtLevel: null, days: 365, checkpoints: DAYS, ...opts });
	}
	return out;
}

const withAll = runAll();
const fishingOnly = runAll({ exclude: ['quests', 'streak', 'buffs'] });

// 1. Decomposition (engaged archetypes).
const decomposition = Object.fromEntries(Object.keys(F.ARCHETYPES).map((a) => [a, decompose(withAll[a])]));

// Casual catch-up: casual active hours to each level relative to the regular player.
const catchUp = Object.fromEntries(LEVELS.map((L) => {
	const c = withAll.casual.milestones[L];
	const r = withAll.regular.milestones[L];
	return [L, c && r ? +(c.hours / r.hours).toFixed(3) : null];
}));

// 2. Minimum-daily adversary vs engaged players.
const calendar = Object.fromEntries(Object.entries(withAll).map(([a, r]) => [a, Object.fromEntries(DAYS.map((d) => {
	const t = levelOnDay(r, d);
	return [d, t ? { level: t.level, activeHours: t.hours, xpPerActiveHour: t.hours ? Math.round(t.xp / t.hours) : null } : null];
}))]));
const md = calendar[F.MINIMUM_DAILY.name];
const leadsEngaged = DAYS.filter((d) => ['casual', 'regular', 'active', 'grinder'].some((a) => md[d] && calendar[a][d] && md[d].level > calendar[a][d].level));
const mdMinutesPerDay = withAll[F.MINIMUM_DAILY.name].timeline.length ? +((withAll[F.MINIMUM_DAILY.name].hours * 60) / withAll[F.MINIMUM_DAILY.name].days).toFixed(2) : null;
const mdXpPerHourVsRegular = md[365] && calendar.regular[365] ? +(md[365].xpPerActiveHour / calendar.regular[365].xpPerActiveHour).toFixed(3) : null;
const minimumDaily = {
	archetype: F.MINIMUM_DAILY,
	minutesPerDayAverage: mdMinutesPerDay,
	calendar: md,
	xpPerActiveHourVsRegular: mdXpPerHourVsRegular,
	leadsAnEngagedArchetypeOnDays: leadsEngaged,
	decomposition: decompose(withAll[F.MINIMUM_DAILY.name]),
	verdict: leadsEngaged.length === 0
		? `PASS: never leads any engaged archetype in level at days ${DAYS.join('/')}; its XP per active hour is ${mdXpPerHourVsRegular}x the regular player's (expected: short sessions are dense), but levels per calendar week trail every engaged player.`
		: `FAIL: leads an engaged archetype on days ${leadsEngaged.join(', ')}.`,
};

// 3. No-miss grinder: every daily/streak/repeatable reward vs fishing (and gear/permits) only.
const grinderShift = Object.fromEntries(LEVELS.map((L) => {
	const w = withAll.grinder.milestones[L];
	const f = fishingOnly.grinder.milestones[L];
	return [L, w && f ? { withDailySystems: +w.hours.toFixed(2), fishingOnly: +f.hours.toFixed(2), hoursSaved: +(f.hours - w.hours).toFixed(2), share: +((f.hours - w.hours) / f.hours).toFixed(4) } : null];
}));
const maxGrinderShare = Math.max(...Object.values(grinderShift).filter(Boolean).map((x) => x.share));
const regularWindows = Object.fromEntries(Object.entries(F.TARGET_WINDOWS).map(([L, [lo, hi]]) => {
	const h = withAll.regular.milestones[L]?.hours;
	return [L, { hours: +h.toFixed(2), window: [lo, hi], ok: h >= lo && h <= hi }];
}));
const noMissGrinder = {
	shift: grinderShift,
	maxShareOfHoursSaved: +maxGrinderShare.toFixed(4),
	regularWindowsWithEverything: regularWindows,
	verdict: `${Object.values(regularWindows).every((w) => w.ok) ? 'PASS' : 'FAIL'}: with every daily, weekly, streak and repeatable reward the regular player stays in every approved window; a no-miss grinder saves at most ${(maxGrinderShare * 100).toFixed(1)}% of play-hours versus fishing alone.`,
};

// Guardrail sensitivity: the daily/weekly reward factor (proposed 1.0 = a daily at most doubles its own
// session) at 0.75 and 0.5: the minimum-daily player's level against the casual player's, XP per active
// hour, the casual catch-up factor and the regular player's windows. A user decision, not a model choice.
const sensitivity = Object.fromEntries([1, 0.75, 0.5].map((k) => {
	const opts = { systemOpts: { quests: { rewardScale: { daily: k, weekly: k } } } };
	const run = (a) => I.run({ archetype: a, stopAtLevel: null, days: 365, checkpoints: DAYS, ...opts });
	const mdR = run(F.MINIMUM_DAILY.name);
	const casR = run('casual');
	const regR = run('regular');
	const lv = (r, d) => levelOnDay(r, d)?.level ?? null;
	const xph = (r, d) => {
		const t = levelOnDay(r, d);
		return t && t.hours ? Math.round(t.xp / t.hours) : null;
	};
	return [k, {
		minimumDaily: Object.fromEntries(DAYS.map((d) => [d, lv(mdR, d)])),
		casual: Object.fromEntries(DAYS.map((d) => [d, lv(casR, d)])),
		minimumDailyXpPerHourVsRegularDay365: +(xph(mdR, 365) / xph(regR, 365)).toFixed(3),
		casualCatchUpL50: casR.milestones[50] && regR.milestones[50] ? +(casR.milestones[50].hours / regR.milestones[50].hours).toFixed(3) : null,
		regularHours: Object.fromEntries(Object.keys(F.TARGET_WINDOWS).map((L) => [L, +regR.milestones[L].hours.toFixed(2)])),
		regularInWindows: Object.entries(F.TARGET_WINDOWS).every(([L, [lo, hi]]) => regR.milestones[L].hours >= lo && regR.milestones[L].hours <= hi),
	}];
}));

// Daily systems' share of XP for each archetype at L50 (the catch-up lever, quantified).
const dailyShareAtL50 = Object.fromEntries(Object.keys(F.ARCHETYPES).map((a) => [a, decomposition[a][50]?.share.daily ?? null]));

process.stdout.write(JSON.stringify({
	...F.stamp(),
	requirement: 'R2 (docs/economy/5b/INTEGRATION_REQUIREMENTS.md)',
	model: I.REFERENCE_NOTE,
	decomposition, catchUp, dailyShareAtL50, calendar, minimumDaily, noMissGrinder, guardrailSensitivity: sensitivity,
}, null, 1));
