// Phase 5B subsystem: ANGLER UPGRADES (5b.5). Permanent, optional cash upgrades with several increasingly
// expensive levels ("I'm only $X away from my next upgrade"). Analysis only: nothing here touches the live
// game, src/ or production data. Every number is computed at runtime from the shared framework
// (./framework.js) and, for lifecycle figures, from the integrated model (./integrate.js on the shared core
// ./lifecycle.js). Only PARAMS and POLICIES are hand-set; prices are formulas of stage income (like permits,
// standard rods and crates), so a framework change regenerates every figure. This module never steps time.
//
//   node scripts/economy/5b/upgrades.js           (prints report() as JSON)
//   node scripts/economy/5b/render-docs.js        (regenerates docs/economy/5b/upgrades.md tables)
//
// Design rules (P-UPGRADES-*):
//   - seven categories, each a small permanent stat on every normal cast (or on bait use), LEVELS levels each;
//   - level k of every category unlocks at PARAMS.unlockLevels[k-1] (mid-stage: Lv 5, 15, ..., 55), so the
//     upgrade shop never competes with the rod + permit bought at each Lv 10 milestone, and a new row of
//     upgrades appears every stage;
//   - price(level k) = priceHours x the income of the stage the level unlocks in (the reference gear step held
//     at that level, in the biome open at that level, reference cadence), 2 significant digits;
//   - OPTIONAL: category 'optional', never blocking; the stat budget is small enough that a player who never
//     buys an upgrade still meets every approved window (report().windows);
//   - the XP upgrade (Experience) counts toward the regular player's windows ONLY because the reference policy
//     buys it (F.UPGRADE_POLICY); the windows are checked with and without upgrades.
//
// Exports:
//   PARAMS, POLICIES, UPGRADE_KEYS, DECISIONS
//   unlockLevel(k), stageIncomeAt(level), price(key, k), priceTable()
//   statsFor(levels)          the stat bonus of a set of owned levels ({ key: level })
//   system(opts)              lifecycle.js SYSTEM (integrate.js 'upgrades'): { policy }
//   lifecycle(archetype, {policy, variant})
//                             the upgrades view of one integrated run (cached)
//   report(), markdownTables()
const F = require('./framework');
const LC = require('./lifecycle');

const deepFreeze = (o) => {
	for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
	return Object.freeze(o);
};

// ---------------------------------------------------------------------------------------------
// Design parameters (the only hand-set numbers in this subsystem).
const PARAMS = deepFreeze({
	id: 'upgrades-5b',
	levels: 6,
	// Level k of every upgrade unlocks at this player level (gate level): one row per stage, mid-stage.
	unlockLevels: [5, 15, 25, 35, 45, 55],
	// stat: the castOutcome stat each level adds (baitSave: share of bait uses not consumed; applied to the
	// bait system's per-cast cost). perLevel: added per level. priceHours: hours of the unlock stage's income.
	upgrades: {
		casting: { name: 'Casting Technique', stat: 'fishingSpeed', perLevel: 0.01, priceHours: 0.3, effect: 'shorter cast cooldown' },
		knowledge: { name: 'Fish Knowledge', stat: 'rareFind', perLevel: 0.05, priceHours: 0.25, effect: 'more Rare/Ultra fish' },
		negotiation: { name: 'Negotiation', stat: 'sellBonus', perLevel: 0.02, priceHours: 0.3, effect: 'higher fish sale value' },
		tackleCare: { name: 'Tackle Care', stat: 'durabilityEfficiency', perLevel: 0.05, priceHours: 0.15, effect: 'less durability used per fish (fewer repairs)' },
		baitConservation: { name: 'Bait Conservation', stat: 'baitSave', perLevel: 0.04, priceHours: 0.15, effect: 'chance a bait is not used up' },
		trophyInstinct: { name: 'Trophy Instinct', stat: 'trophyChance', perLevel: 0.05, priceHours: 0.15, effect: 'more Giant (trophy) fish' },
		experience: { name: 'Experience', stat: 'xpBonus', perLevel: 0.005, priceHours: 0.25, effect: 'a little more fishing XP' },
	},
	priceSigDigits: 2,
});
const UPGRADE_KEYS = Object.keys(PARAMS.upgrades);

// Purchase policies (P-UPGRADES-REFERENCE-POLICY). Every policy buys the cheapest affordable level first.
//   reference  a level is bought when it costs at most maxIncomeHours of the player's CURRENT hourly income
//              and the money left still covers the next rod purchase and the next permit (reserve); the rod and
//              permit goals always come first (LC.PRIORITY.optional)
//   greedy     stress case: every level as soon as the money is there, ahead of rods and permits, no reserve
//   none       never buys (the "never upgrade" player)
const POLICIES = deepFreeze({
	reference: { maxIncomeHours: 1, reserve: true, priority: LC.PRIORITY.optional },
	greedy: { maxIncomeHours: Infinity, reserve: false, priority: 5 },
	none: null,
});

// ---------------------------------------------------------------------------------------------
const nicePrice = (x, digits = PARAMS.priceSigDigits) => {
	if (!(x > 0)) return 0;
	const p = 10 ** (Math.floor(Math.log10(x)) - digits + 1);
	return Math.round(x / p) * p;
};
const round = (x, d = 4) => Number(x.toFixed(d));
const unlockLevel = (k) => PARAMS.unlockLevels[k - 1];

let sharedPathCache = null;
const sharedPath = () => sharedPathCache || (sharedPathCache = F.gearPath());
/** $/h of the reference gear step held at `level` in the biome open at `level` (reference cadence). */
function stageIncomeAt(level) {
	const step = F.tierAt(level, sharedPath());
	const o = F.castOutcome({ biome: F.biomeAt(level), qualities: step.qualities, stats: step.stats, multiChance: step.multiChance });
	return F.hourly(o, F.DESIGN_OVERHEAD_S).cash;
}
/** Price of level k (1-based) of an upgrade. */
function price(key, k) {
	return nicePrice(PARAMS.upgrades[key].priceHours * stageIncomeAt(unlockLevel(k)));
}
function priceTable() {
	return UPGRADE_KEYS.map((key) => {
		const u = PARAMS.upgrades[key];
		const prices = Array.from({ length: PARAMS.levels }, (_, i) => price(key, i + 1));
		return { key, name: u.name, stat: u.stat, perLevel: u.perLevel, max: u.perLevel * PARAMS.levels, effect: u.effect, priceHours: u.priceHours, prices, total: prices.reduce((a, b) => a + b, 0) };
	});
}

/** The stat bonus of owned levels ({ key: level }). baitSave is not a castOutcome stat (see system()). */
function statsFor(levels) {
	const out = {};
	for (const key of UPGRADE_KEYS) {
		const n = levels[key] || 0;
		if (!n) continue;
		const { stat, perLevel } = PARAMS.upgrades[key];
		out[stat] = round((out[stat] || 0) + n * perLevel, 6);
	}
	return out;
}
const allLevels = (n = PARAMS.levels) => Object.fromEntries(UPGRADE_KEYS.map((k) => [k, n]));

// ---------------------------------------------------------------------------------------------
// The SYSTEM. Per-run state in state.sys.upgrades only.
//   beforeStep  remembers the step's hourly income (the policy's affordability yardstick)
//   modifyCast  adds the owned levels' stats to the cast; Bait Conservation scales the bait system's per-cast
//               cost (item 'bait') by (1 - baitSave), so this system is composed after bait (integrate.js)
//   goals       at most one goal per category: its next level once unlocked; category 'optional', never
//               blocking; the reference policy's reserve = the rods system's next purchase + the cheapest
//               permit not yet held whose level is within the next stage
// Ledger: spend items 'upgrade:<key>' ('optional'); no XP or cash source (effects go through the cast).
const SYSTEM_NAME = 'upgrades';

function reserveFor(state, ctx) {
	let reserve = 0;
	const rods = ctx.systems.find((s) => s.name === 'rods');
	const next = rods && rods.nextPurchase ? rods.nextPurchase(state, ctx) : null;
	if (next && next.unlockLevel <= ctx.gateLevel() + 10) reserve += next.cost;
	const w = state.sys.world;
	if (w && w.permits) {
		const due = w.offered.filter((b) => !w.held[b] && F.BIOME_LEVEL[b] <= ctx.gateLevel() + 10).map((b) => w.prices[b]);
		if (due.length) reserve += Math.min(...due);
	}
	return reserve;
}

function system(opts = {}) {
	const policyName = opts.policy || F.UPGRADE_POLICY;
	if (!(policyName in POLICIES)) throw new Error(`upgrades: unknown policy ${policyName}`);
	const policy = POLICIES[policyName];
	const own = (state) => state.sys[SYSTEM_NAME];
	return {
		name: SYSTEM_NAME,
		init(state) {
			state.sys[SYSTEM_NAME] = { policy: policyName, levels: Object.fromEntries(UPGRADE_KEYS.map((k) => [k, 0])), bought: [], spent: 0, perHourCash: 0 };
		},
		beforeStep(state, ctx, rates) {
			if (rates.perHour.cash > 0) own(state).perHourCash = rates.perHour.cash;
		},
		modifyCast(input, state) {
			const s = own(state);
			const add = statsFor(s.levels);
			const save = add.baitSave || 0;
			delete add.baitSave;
			for (const [k, v] of Object.entries(add)) input.stats[k] = (input.stats[k] || 0) + v;
			if (save > 0) for (const c of input.costs) if (c.item === 'bait') c.perCast *= 1 - save;
		},
		goals(state, ctx) {
			if (!policy) return [];
			const s = own(state);
			const L = ctx.gateLevel();
			const cap = policy.maxIncomeHours * s.perHourCash;
			const reserve = policy.reserve ? reserveFor(state, ctx) : 0;
			const out = [];
			for (const key of UPGRADE_KEYS) {
				const k = s.levels[key] + 1;
				if (k > PARAMS.levels || L < unlockLevel(k)) continue;
				const cost = price(key, k);
				if (cost > cap) continue;
				out.push({
					id: `upgrade:${key}:${k}`, item: `upgrade:${key}`, category: 'optional', blocking: false,
					// Cheapest first within the policy's priority band.
					priority: policy.priority + cost / 1e12, cost, reserve,
					buy(st, c) {
						s.levels[key] = k;
						s.spent += cost;
						s.bought.push({ key, level: k, cost, hours: +st.h.toFixed(4), day: st.day + 1, playerLevel: c.gateLevel(), moneyAfter: Math.round(st.money) });
					},
				});
			}
			return out;
		},
	};
}

// ---------------------------------------------------------------------------------------------
// Lifecycles (integrate.run; cached).
const PLAYERS = Object.keys(F.ARCHETYPES);
const POLICY_NAMES = Object.keys(POLICIES);
/**
 * The upgrades view of one integrated run: rods.lifecycle() (the same cached run and the same Lv 60
 * accounting) with the upgrades policy as the variant. Money shares are to the Lv 60 milestone, with the Lv 60
 * rod counted as bought on arrival (rods.js lifecycle()).
 */
function lifecycle(archetype, { policy = F.UPGRADE_POLICY, variant = {} } = {}) {
	const v = require('./rods').lifecycle(archetype, { variant: { ...variant, upgrades: policy } });
	const t = v.totals;
	return {
		archetype, policy, variant, reached: v.reached, hours: v.hours, days: v.days,
		income: t.income, fishing: t.gross, categories: Object.fromEntries(Object.entries(t.categoryShares).map(([c, x]) => [c, x * t.income])), upgradeSpend: t.upgrades, saved: t.saved, minMoney: t.minMoney,
		bought: v.upgradesBought, levels: v.upgradeLevels, permits: v.permits, rodEquips: v.equips, rodBought: v.bought,
	};
}

/**
 * Largest wait between reaching a level and fishing the rod of that level / holding the permit of that level
 * (rod waits from rods.lifecycle(): a purchase at the first pass after the level-up counts as no wait, as
 * world.js labels permits; the Lv 60 rod bought after the run's stop is left out).
 */
function delays(v, path = F.gearPath()) {
	const rod = path.slice(1).filter((step) => v.rodEquips[step.tier] || step.level < F.LIFECYCLE.maxLevel).map((step) => {
		const e = v.rodEquips[step.tier];
		return { tier: step.tier, name: step.name, delayH: e ? e.delayHours : null };
	});
	const permit = Object.entries(v.permits || {}).map(([b, p]) => ({ biome: b, delayH: p.delayH, delaySessions: p.delaySessions }));
	const maxOf = (xs) => (xs.some((x) => x === null) ? null : Math.max(0, ...xs));
	return { rod, permit, maxRodH: maxOf(rod.map((x) => x.delayH)), maxPermitH: maxOf(permit.map((x) => x.delayH)), maxPermitSessions: maxOf(permit.map((x) => x.delaySessions)) };
}

const inWindows = (reached) => Object.fromEntries(Object.entries(F.TARGET_WINDOWS).map(([L, [lo, hi]]) => [L, { hours: reached[L]?.hours ?? null, window: [lo, hi], ok: reached[L] ? reached[L].hours >= lo && reached[L].hours <= hi : false }]));

// ---------------------------------------------------------------------------------------------
/** Marginal effect of a full category (all levels) on the reference step at a level, in its biome. */
function categoryValue(level) {
	const step = F.tierAt(level, sharedPath());
	const biome = F.biomeAt(level);
	const base = { biome, qualities: step.qualities, stats: { ...step.stats }, multiChance: step.multiChance };
	const h0 = F.hourly(F.castOutcome(base), F.DESIGN_OVERHEAD_S);
	const o0 = F.castOutcome(base);
	return UPGRADE_KEYS.map((key) => {
		const { stat, perLevel } = PARAMS.upgrades[key];
		const full = perLevel * PARAMS.levels;
		if (stat === 'baitSave') return { key, stat, full, xp: 0, cash: 0, repairs: 0, note: 'bait cost only' };
		const stats = { ...base.stats, [stat]: (base.stats[stat] || 0) + full };
		const o = F.castOutcome({ ...base, stats });
		const h = F.hourly(o, F.DESIGN_OVERHEAD_S);
		return { key, stat, full, xp: h.xp / h0.xp - 1, cash: h.cash / h0.cash - 1, durabilityPerFish: (o.durabilityPerCast / o.fishPerCast) / (o0.durabilityPerCast / o0.fishPerCast) - 1, giants: (o.rarity.giant / o0.rarity.giant) - 1 };
	});
}

function buildReport() {
	const I = require('./integrate');
	const table = priceTable();
	const runs = Object.fromEntries(PLAYERS.map((a) => [a, Object.fromEntries(POLICY_NAMES.map((p) => [p, lifecycle(a, { policy: p })]))]));
	const summarize = (v) => {
		const d = delays(v);
		return {
			reached: v.reached, windows: inWindows(v.reached), hours: v.hours, days: v.days,
			income: v.income, fishing: v.fishing, upgradeSpend: v.upgradeSpend,
			shares: Object.fromEntries(Object.entries(v.categories).map(([c, x]) => [c, x / v.income])), upgradeShare: v.upgradeSpend / v.income, savedShare: v.saved / v.income,
			levelsAtStop: v.levels, boughtCount: v.bought.length, minMoney: v.minMoney,
			maxRodDelayH: d.maxRodH, maxPermitDelayH: d.maxPermitH, maxPermitDelaySessions: d.maxPermitSessions, permitDelays: d.permit, rodDelays: d.rod,
		};
	};
	// When each unlock row is completed (all seven categories at level k) and the gap from the unlock level.
	const timing = Object.fromEntries(PLAYERS.map((a) => {
		const v = runs[a][F.UPGRADE_POLICY];
		const rows = Array.from({ length: PARAMS.levels }, (_, i) => {
			const k = i + 1;
			const got = v.bought.filter((b) => b.level === k);
			const unlockH = v.reached[unlockLevel(k)]?.hours ?? (unlockLevel(k) === 5 ? null : null);
			const first = got.length ? Math.min(...got.map((b) => b.hours)) : null;
			const last = got.length === UPGRADE_KEYS.length ? Math.max(...got.map((b) => b.hours)) : null;
			return { k, unlockLevel: unlockLevel(k), bought: got.length, firstH: first, lastH: last, firstLevel: got.length ? Math.min(...got.map((b) => b.playerLevel)) : null, lastLevel: last !== null ? Math.max(...got.map((b) => b.playerLevel)) : null, unlockH };
		});
		return [a, rows];
	}));
	// Time to afford each unlock row from the archetype's own income at that stage (hours / sessions).
	const affordRows = Array.from({ length: PARAMS.levels }, (_, i) => {
		const k = i + 1;
		const L = unlockLevel(k);
		const row = UPGRADE_KEYS.reduce((s, key) => s + price(key, k), 0);
		const perArch = Object.fromEntries(PLAYERS.map((a) => {
			const step = F.tierAt(L, sharedPath());
			const o = F.castOutcome({ biome: F.biomeAt(L), qualities: step.qualities, stats: step.stats, multiChance: step.multiChance });
			const perHour = F.hourly(o, F.ARCHETYPES[a].overheadS).cash;
			const hours = row / perHour;
			return [a, { perHour, hours, sessions: hours / (F.ARCHETYPES[a].minutesPerDay / 60) }];
		}));
		return { k, unlockLevel: L, rowCost: row, stageIncomeRef: stageIncomeAt(L), perArch };
	});
	return {
		...F.stamp(),
		params: PARAMS.id,
		referencePolicy: F.UPGRADE_POLICY,
		referenceNote: I.REFERENCE_NOTE,
		table,
		maxStats: statsFor(allLevels()),
		categoryValue: { level: 50, rows: categoryValue(50) },
		allUpgradesTotal: table.reduce((s, r) => s + r.total, 0),
		affordRows,
		timing,
		runs: Object.fromEntries(PLAYERS.map((a) => [a, Object.fromEntries(POLICY_NAMES.map((p) => [p, summarize(runs[a][p])]))])),
	};
}
let reportCache = null;
function report() {
	if (!reportCache) reportCache = buildReport();
	return reportCache;
}

// ---------------------------------------------------------------------------------------------
// Decisions (join decisions.js). Status is only ever 'proposed'.
const DECISIONS = [
	{
		id: 'P-UPGRADES-CATEGORIES', status: 'proposed',
		title: 'Seven permanent Angler Upgrades bought with cash, six levels each: Casting Technique, Fish Knowledge, Negotiation, Tackle Care, Bait Conservation, Trophy Instinct, Experience',
		modelled: UPGRADE_KEYS.map((k) => `${PARAMS.upgrades[k].name} +${+(PARAMS.upgrades[k].perLevel * 100).toFixed(1)}% ${PARAMS.upgrades[k].stat}/level`).join('; '),
		alternatives: ['fewer categories (Negotiation + Fish Knowledge + Casting Technique only)', 'more levels with smaller steps (VF: 18-21 levels of +5%)', 'no upgrades (rods and permits are the only cash progression)'],
		source: 'upgrades design (user direction: VF-style permanent cash upgrades, names/stats open)',
		why: 'a steady stream of "$X away" goals between rod/permit milestones; each effect is small so none is mandatory (a never-upgrade player still meets every window)',
		get: () => Object.fromEntries(UPGRADE_KEYS.map((k) => [k, { stat: PARAMS.upgrades[k].stat, perLevel: PARAMS.upgrades[k].perLevel }])),
		expected: { casting: { stat: 'fishingSpeed', perLevel: 0.01 }, knowledge: { stat: 'rareFind', perLevel: 0.05 }, negotiation: { stat: 'sellBonus', perLevel: 0.02 }, tackleCare: { stat: 'durabilityEfficiency', perLevel: 0.05 }, baitConservation: { stat: 'baitSave', perLevel: 0.04 }, trophyInstinct: { stat: 'trophyChance', perLevel: 0.05 }, experience: { stat: 'xpBonus', perLevel: 0.005 } },
	},
	{
		id: 'P-UPGRADES-LEVELS', status: 'proposed',
		title: 'Upgrade level k of every category unlocks at a mid-stage level (Lv 5, 15, 25, 35, 45, 55)',
		modelled: `levels ${PARAMS.levels}; unlock ${PARAMS.unlockLevels.map((l) => `Lv ${l}`).join(', ')}`,
		alternatives: ['no level gate (VF style: price only; lets an early saver stack every level before Lv 20)', 'unlock at the Lv 10 milestones (competes with the rod and permit bought there)'],
		source: 'upgrades design', why: 'a new row of goals appears every stage, halfway between two rod/permit milestones, so upgrades never compete with them for the same cash',
		get: () => ({ levels: PARAMS.levels, unlockLevels: PARAMS.unlockLevels }), expected: { levels: 6, unlockLevels: [5, 15, 25, 35, 45, 55] },
	},
	{
		id: 'P-UPGRADES-PRICES', status: 'proposed',
		title: 'Upgrade prices from stage income: level k costs priceHours of the income of the stage it unlocks in',
		modelled: `priceHours: ${UPGRADE_KEYS.map((k) => `${PARAMS.upgrades[k].name} ${PARAMS.upgrades[k].priceHours} h`).join(', ')}; ${PARAMS.priceSigDigits} significant digits`,
		alternatives: ['a fixed geometric price (VF: roughly x1.5-x2 per level)', 'higher hours (a real sink; delays nothing mandatory but slows optional goals)'],
		source: 'upgrades design', why: `prices regenerate with any framework change and escalate about x2 per level with stage income; a full row costs ${+UPGRADE_KEYS.reduce((t, k) => t + PARAMS.upgrades[k].priceHours, 0).toFixed(2)} h of the unlock stage's income`,
		get: () => Object.fromEntries(UPGRADE_KEYS.map((k) => [k, PARAMS.upgrades[k].priceHours])),
		expected: { casting: 0.3, knowledge: 0.25, negotiation: 0.3, tackleCare: 0.15, baitConservation: 0.15, trophyInstinct: 0.15, experience: 0.25 },
	},
	{
		id: 'P-UPGRADES-REFERENCE-POLICY', status: 'proposed',
		title: 'The reference loop buys upgrades under the reference policy: a level when it costs at most 1 h of current income and the next rod and permit stay covered; rods and permits always first',
		modelled: `F.UPGRADE_POLICY '${F.UPGRADE_POLICY}' (${JSON.stringify(POLICIES.reference)}); every archetype; windows checked with it AND with policy 'none'`,
		alternatives: ['reference player buys no upgrades (then the XP upgrade never counts in the windows)', 'greedy (every level as soon as affordable, ahead of rods and permits: the stress case)'],
		source: 'upgrades design (the north-star loop includes permanent upgrades)',
		why: 'the loop the user described buys upgrades, so the reference player does; the reserve makes the policy unable to delay a rod or permit by construction, and the windows hold for the never-upgrade player too, so upgrades stay optional',
		get: () => ({ policy: F.UPGRADE_POLICY, reference: POLICIES.reference, inReferenceLoop: require('./integrate').REFERENCE.includes('upgrades') }),
		expected: { policy: 'reference', reference: { maxIncomeHours: 1, reserve: true, priority: 80 }, inReferenceLoop: true },
	},
	{
		id: 'P-UPGRADES-OPTIONAL', status: 'proposed',
		title: 'Upgrades are an optional sink (category optional), never a gate: no content, rod, biome or quest requires an upgrade level',
		modelled: 'spend category optional; goals never blocking',
		alternatives: ['upgrade levels as rod or biome prerequisites (VF-style gating; rejected: mandatory)'],
		source: 'user direction (optional optimisation sinks, not mandatory gates)', why: 'savings ~70-75% are accepted (P-SAVINGS); upgrades give that money an optional use',
	},
	{
		id: 'P-UPGRADES-BAIT-CONSERVATION', status: 'proposed',
		title: 'Bait Conservation: each bait use has a chance not to consume the bait; the bait\'s effect still applies',
		modelled: `${PARAMS.upgrades.baitConservation.perLevel * 100}% per level (max ${Math.round(PARAMS.upgrades.baitConservation.perLevel * PARAMS.levels * 100)}%): the bait system's per-cast cost x (1 - chance)`,
		alternatives: ['a flat bait discount in the shop (simpler; but a discount is not felt at the moment of use)'],
		source: 'upgrades design', why: 'makes bait specialisation cheaper for players who use it; worth nothing to a no-bait player, so it is a genuine choice',
	},
];

// ---------------------------------------------------------------------------------------------
// Generated doc tables (docs/economy/5b/upgrades.md).
const mdTable = (headers, rows) => [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n');
const n0 = (x) => Math.round(x).toLocaleString('en-US');
const usd = (x) => `$${n0(x)}`;
const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const hrs = (x, d = 2) => (x === null || x === undefined ? '—' : `${x.toFixed(d)} h`);
const signed = (x, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`;

function markdownTables() {
	const R = report();
	const out = {};
	out['upgrades-table'] = [
		mdTable(['Upgrade', 'Effect', 'Per level', 'Max (6 levels)', ...PARAMS.unlockLevels.map((L, i) => `L${i + 1} (Lv ${L})`), 'All levels'], R.table.map((r) => [
			`**${r.name}**`, r.effect, r.stat === 'baitSave' ? `${pct(r.perLevel, 0)} not used up` : `+${pct(r.perLevel, 1)} ${r.stat}`, r.stat === 'baitSave' ? pct(r.max, 0) : `+${pct(r.max, 1)}`, ...r.prices.map(usd), usd(r.total),
		])),
		'',
		`All ${UPGRADE_KEYS.length} upgrades at every level: **${usd(R.allUpgradesTotal)}**. Price of level k = its hours (${UPGRADE_KEYS.map((k) => `${PARAMS.upgrades[k].name} ${PARAMS.upgrades[k].priceHours} h`).join(', ')}) × the reference $/h of the stage it unlocks in:`,
		'',
		mdTable(['Row', 'Unlocks at', 'Reference stage $/h', 'Whole row (7 levels)', ...PLAYERS.map((a) => `${a}: hours (sessions) of own income`)], R.affordRows.map((r) => [
			`L${r.k}`, `Lv ${r.unlockLevel}`, usd(r.stageIncomeRef), usd(r.rowCost), ...PLAYERS.map((a) => `${r.perArch[a].hours.toFixed(2)} (${r.perArch[a].sessions.toFixed(1)})`),
		])),
	].join('\n');
	const cv = R.categoryValue;
	out['upgrades-value'] = [
		`What each category is worth at all ${PARAMS.levels} levels, on the standard rod held at Lv ${cv.level} in its biome (reference cadence; alone, not stacked):`,
		'',
		mdTable(['Upgrade', 'Stat at max', 'XP/h', '$/h', 'Durability per fish', 'Giants'], cv.rows.map((r) => [
			PARAMS.upgrades[r.key].name, r.stat === 'baitSave' ? `${pct(r.full, 0)} bait saved` : `+${pct(r.full, 1)} ${r.stat}`,
			r.note ? '—' : signed(r.xp), r.note ? '—' : signed(r.cash), r.note ? '—' : signed(r.durabilityPerFish), r.note ? '—' : signed(r.giants),
		])),
		'',
		`Every upgrade at max adds: ${Object.entries(R.maxStats).map(([k, v]) => `${k} +${pct(v, 1)}`).join(', ')}.`,
	].join('\n');
	const pol = (a, p) => R.runs[a][p];
	const WL = Object.keys(F.TARGET_WINDOWS);
	out['upgrades-windows'] = mdTable(['Player / policy', ...WL.map((L) => `Lv ${L} (${F.TARGET_WINDOWS[L].join('–')} h)`), 'Lv 60'], PLAYERS.flatMap((a) => POLICY_NAMES.map((p) => {
		const v = pol(a, p);
		const w = v.windows;
		return [`${a === F.REFERENCE_ARCHETYPE ? `**${a}**` : a} · ${p}${p === F.UPGRADE_POLICY ? ' (reference)' : ''}`, ...WL.map((L) => (a === F.REFERENCE_ARCHETYPE ? `${hrs(w[L].hours)} ${w[L].ok ? '(in)' : '**(OUT)**'}` : hrs(w[L].hours))), hrs(v.reached[60]?.hours ?? null)];
	})));
	out['upgrades-sinks'] = mdTable(['Player / policy', 'Income to Lv 60', 'Upkeep', 'Progression (rods + permits)', 'Upgrades', 'Other optional', 'Saved', 'Levels owned at Lv 60'], PLAYERS.flatMap((a) => POLICY_NAMES.map((p) => {
		const v = pol(a, p);
		return [`${a} · ${p}`, usd(v.income), pct(v.shares.upkeep || 0), pct(v.shares.progression || 0), pct(v.upgradeShare), pct((v.shares.optional || 0) - v.upgradeShare), pct(v.savedShare), `${v.boughtCount} / ${UPGRADE_KEYS.length * PARAMS.levels}`];
	})));
	out['upgrades-timing'] = [
		'When each row of upgrade levels is bought on the integrated reference loop (reference policy): first and last of the seven levels of the row, hours of play (gate level).',
		'',
		mdTable(['Player', ...PARAMS.unlockLevels.map((L, i) => `L${i + 1} (unlocks Lv ${L})`)], PLAYERS.map((a) => [a, ...R.timing[a].map((r) => (r.bought ? `${hrs(r.firstH)} (Lv ${r.firstLevel}) → ${r.lastH !== null ? `${hrs(r.lastH)} (Lv ${r.lastLevel})` : `${r.bought}/${UPGRADE_KEYS.length} by Lv 60`}` : 'none by Lv 60'))])),
	].join('\n');
	out['upgrades-affordability'] = [
		'Rods and permits with extra optional spending: the longest wait between reaching a level and fishing its standard rod / holding its permit, per policy (integrated loop to Lv 60).',
		'',
		mdTable(['Player', ...POLICY_NAMES.map((p) => `${p}: rod wait / permit wait (sessions)`)], PLAYERS.map((a) => [a, ...POLICY_NAMES.map((p) => {
			const v = pol(a, p);
			return `${hrs(v.maxRodDelayH)} / ${hrs(v.maxPermitDelayH)} (${v.maxPermitDelaySessions === null ? '—' : v.maxPermitDelaySessions.toFixed(2)})`;
		})])),
		'',
		(() => {
			const greedyLate = PLAYERS.flatMap((a) => pol(a, 'greedy').permitDelays.filter((d) => d.delayH > 0).map((d) => `${a} ${d.biome} +${d.delayH.toFixed(2)} h (${d.delaySessions.toFixed(2)} sessions)`));
			const refLate = PLAYERS.flatMap((a) => pol(a, F.UPGRADE_POLICY).permitDelays.filter((d) => d.delayH > 0).map((d) => `${a} ${d.biome}`));
			return `- **Reference policy:** ${refLate.length ? `permits late: ${refLate.join(', ')}` : 'no permit and no rod waits for cash for any archetype'} (the reserve keeps the next rod and permit covered).\n- **Greedy policy (every level as soon as affordable, ahead of rods and permits):** ${greedyLate.length ? `permit waits: ${greedyLate.join('; ')}` : 'still no permit waits for cash'}.`;
		})(),
	].join('\n');
	out['upgrades-decisions'] = mdTable(['ID', 'Proposed decision', 'Modelled', 'Alternatives', 'Why', 'Record = model'], DECISIONS.map((d) => [
		`\`${d.id}\``, d.title, d.modelled, d.alternatives.join('; '), d.why, d.get ? (JSON.stringify(d.get()) === JSON.stringify(d.expected) ? 'yes' : '**NO**') : 'n/a (not a model value)',
	]));
	return out;
}

module.exports = { PARAMS, POLICIES, UPGRADE_KEYS, DECISIONS, SYSTEM_NAME, unlockLevel, stageIncomeAt, price, priceTable, statsFor, system, lifecycle, delays, report, markdownTables };

if (require.main === module) process.stdout.write(JSON.stringify(report(), null, 1));
