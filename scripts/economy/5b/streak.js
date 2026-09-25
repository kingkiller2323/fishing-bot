// Phase 5B subsystem: DAILY STREAK + STREAK CRATE, and the retirement of Top.gg voting. ANALYSIS ONLY:
// nothing here touches the live game, src/ or production data.
//
// Every economic number is computed at runtime from the shared framework (./framework.js, which
// re-exports assumptions.js) and from the finished rods/bait designs (./rods.js salvage values,
// ./bait.js pack prices). Only the design parameters in PARAMS are hand-set. If a shared value changes
// (curve, value model, archetypes, gear path), re-run report(): every figure regenerates.
//
//   node -e "require('./scripts/economy/5b/streak.js').report()"     (returns the report object)
//   node scripts/economy/5b/streak.js                                  (prints it as JSON)
//
// Exports (pure and synchronous; no database, no randomness):
//   PARAMS                       frozen design parameters: day boundary, play gate, 7-day ladder, grace
//                                tokens, decay, badges, box pool/tables, Top.gg retirement, design targets
//   dayIndex(ms, startUtcHour)   the "DCC day" a timestamp belongs to (shared with the daily quest)
//   defaultState()               streak state of a player with no `streak` fields (read-time default)
//   boxForDay(streakDay)         'Streak Crate' | 'Streak Chest' for the n-th streak day
//   applyGap(state, missedDays)  grace/decay/reset rules for missed days (pure)
//   advanceStreak(state, day)    credits one streak day: new state + { box, graceUsed, decayedBy, reset,
//                                badges } (what the engine writes in the qualifying cast's commit)
//   onSuccessfulCast(state, day) gate counter + credit: the whole engine rule for one successful cast
//   boxDefinitions()             proposed Gacha V2 definitions: 'Streak Crate', 'Streak Chest'
//   legacyVotersCrate()          the kept Voter's Crate definition (src) + the recommended Old Rod exclusion
//   boxEV(box, {level, profile}) exact expected contents of one open: fish by rarity and value, parts
//                                (salvage), bait packs (usable / not yet usable), buffs; `box` is a name
//                                or a definition; `profile` 'normal' | 'founder' (private Founder EV)
//   stageRates(level, {archetype, tier})
//                                F.castOutcome/F.hourly at the player's highest biome and gear
//   streakValue(day, level, opts)
//                                INTEGRATOR ENTRY POINT. Expected value of the box earned on streak day
//                                `day` at `level`: { cashEquivalent, items, xp, box, breakdown }.
//                                xp is Double XP buff XP only (no direct XP).
//                                opts: { archetype (name or {minutesPerDay, overheadS}), tier, profile }
//   perClaimValue(level, opts)   average over one 7-day cycle (6 crates + 1 chest), per claimed day
//   attendanceModel(p, days)     exact DP over (streak, grace, gap) for daily attendance probability p:
//                                claims, crates, chests, grace used, decays, resets
//   lifecycle(archetype, opts)   curve.js-style lifecycle (same stepping; reproduces curve.json with the
//                                streak off) with the streak on: XP by source, cash by source, items
//   archetypeValue()             per day and per 30/90 days for every archetype vs fishing income
//   r2()                         INTEGRATION_REQUIREMENTS R2: XP-source decomposition, minimum-daily and
//                                no-miss-grinder adversarial scenarios, verdicts
//   t1PartsFromStreak()          days of streak drops to complete a T1 Uncommon part set (rods interplay)
//   topggComparison()            today's Top.gg reward (today's model and the new value model) vs streak
//   founderView()                private Founder EV per crate/chest (Founder gacha stats, sell multiplier)
//   ruleExamples()               worked traces of the gate, ladder, grace, decay and reset rules
//   jackpots(level)              Legendary/Lucky odds per crate, chest, week and 30 days
//   doubleXpDayShare()           share of streak days bringing a Double XP buff (the bound on streak XP)
//   attendanceTable()            attendanceModel for 7..3 days a week, proposed rules and the alternative
//   baselineMatchesCurveJson()   lifecycle with the streak off reproduces docs/economy/5b/curve.json
//   checks()                     design-target checks (pass/fail)
//   report()                     every number in docs/economy/5b/streak.md (cached), with ...F.stamp()
const F = require('./framework');
const rods = require('./rods');
const bait = require('./bait');
const { FISH } = require('../lib/catalog-model');
const { buildTable, normalize } = require('../../../src/engine/rarity');
const { RARITIES, PROFILES } = require('../../../src/engine/balance');
const { BOXES } = require('../../../src/engine/gachaBoxes');
const PART_CATALOG = require('../../../src/bootstrap/data/rodParts');
const BAIT_CATALOG = require('../../../src/bootstrap/data/bait');
const BUFF_CATALOG = require('../../../src/bootstrap/data/buffs');
const ROD_CATALOG = require('../../../src/bootstrap/data/rods');
const SIMULATION = require('../../../docs/economy/simulation.json');
const GACHA_EV = require('../../../docs/economy/gacha-ev.json');
const CURVE_JSON = require('../../../docs/economy/5b/curve.json');

const deepFreeze = (o) => {
	for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
	return Object.freeze(o);
};
const lower = (s) => String(s).toLowerCase();
const title = (s) => lower(s).charAt(0).toUpperCase() + lower(s).slice(1);
const rIdx = (r) => RARITIES.indexOf(lower(r));
const round = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Design parameters (the only hand-set numbers in this subsystem).
const VOTERS = BOXES['Voter\'s Crate'];
const PARAMS = deepFreeze({
	id: 'streak-5b',
	// One "DCC day" for the streak AND the daily quest: [startUtcHour, startUtcHour + 24h) in UTC.
	day: { startUtcHour: 0 },
	// A streak day is earned by real play: this many successful casts (a cast that lands >= 1 fish) in
	// the DCC day. Casts, not fish: identical effort for every rod and every profile (no Founder tell).
	gate: { successfulCasts: 20 },
	// Ladder: every streak day grants a Streak Crate; every `cycle`-th streak day grants the Streak Chest
	// instead (2 bonus slots, slot 0 Ultra+) and one grace token.
	ladder: { cycle: 7, dailyBox: 'Streak Crate', milestoneBox: 'Streak Chest' },
	// Grace tokens cover single missed days automatically (only while a streak is running).
	grace: { start: 1, perCycle: 1, max: 2 },
	// A missed day with no token costs one week of streak (the weekly phase is kept); a gap of this many
	// missed days in a row starts the streak over.
	decay: { perUncoveredMiss: 7, resetAfterMissedDays: 7 },
	// Alternative evaluated in the report (a decision for the user): more grace, so a 5-days-a-week
	// player keeps the weekly chest.
	alternatives: { moreGrace: { perCycle: 2, max: 3 } },
	// Cosmetic only (profile flair from `streak.best`): no economic value.
	badges: [7, 30, 100, 365],
	// No direct cash and no direct XP (decisions S3, S4 in streak.md).
	direct: { cash: 0, xp: 0 },
	boxes: {
		'Streak Crate': { id: 'streak-crate', slots: 3, guaranteedSlots: [] },
		'Streak Chest': { id: 'streak-chest', slots: 5, guaranteedSlots: [{ slot: 0, minRarity: 'ultra' }] },
	},
	pool: {
		// The Voter's Crate pool, adapted: no Old Rod ('rod'), no rod part above Uncommon (tiered crates
		// own those), fish from the opener's highest accessible biome, a fixed fish share per rarity.
		types: ['bait', 'buff', 'part_rod', 'part_reel', 'part_hook', 'part_handle'],
		fish: 'highestUnlocked',
		fishShare: 0.75,
		maxPartRarity: 'uncommon',
		// The Voter's Crate table with its Common tier removed (every Streak Crate reward is Uncommon+).
		rarityTable: { ...VOTERS.rarityTable, common: 0 },
		rarityFloor: 'uncommon',
		duplicates: 'unique',
	},
	// A bait slot grants one pack (bait design, bait.md §9), so a bait reward is worth using.
	baitGrant: 'pack',
	topgg: {
		retire: true,
		// '/vote' becomes an ephemeral notice pointing to /daily for `transitionDays`, then is unregistered.
		vote: 'notice-then-unregister',
		transitionDays: 30,
		legacyVotersCrate: { keep: true, excludeOldRod: true },
	},
	// Design targets checked by checks(); shares are of the archetype's own fishing income.
	targets: {
		casual30dShare: [0.15, 0.35],
		regular30dShareMax: 0.05,
		grinder30dShareMax: 0.01,
		streakXpShareMax: 0.02,
		grinderHoursDeltaMax: 0.01,
		minT1Days: 14,
	},
});

// ---------------------------------------------------------------------------------------------
// Streak rules (pure; the engine mirrors these exactly).
/** DCC day index of a timestamp (ms). */
const dayIndex = (ms, startUtcHour = PARAMS.day.startUtcHour) => Math.floor((ms - startUtcHour * 3_600_000) / DAY_MS);

/** Read-time default for a player without `streak` fields (no write needed). */
const defaultState = () => ({ count: 0, best: 0, total: 0, lastDay: null, grace: PARAMS.grace.start, castsDay: null, castsToday: 0 });

/** Box earned on the n-th streak day. */
const boxForDay = (streakDay) => (streakDay > 0 && streakDay % PARAMS.ladder.cycle === 0 ? PARAMS.ladder.milestoneBox : PARAMS.ladder.dailyBox);

/**
 * Applies `missedDays` consecutive missed days (called when the next streak day is credited). Tokens
 * are spent only while a streak is running; a long gap resets the streak and keeps the tokens.
 * `rules` defaults to PARAMS (overridable to evaluate alternatives).
 */
function applyGap(state, missedDays, rules = PARAMS) {
	const s = { ...state };
	const out = { graceUsed: 0, decayedBy: 0, reset: false };
	if (missedDays <= 0 || s.count <= 0) return { state: s, ...out };
	if (missedDays >= rules.decay.resetAfterMissedDays) {
		out.decayedBy = s.count;
		s.count = 0;
		out.reset = true;
		return { state: s, ...out };
	}
	out.graceUsed = Math.min(missedDays, s.grace);
	s.grace -= out.graceUsed;
	const uncovered = missedDays - out.graceUsed;
	const before = s.count;
	s.count = Math.max(0, s.count - rules.decay.perUncoveredMiss * uncovered);
	out.decayedBy = before - s.count;
	return { state: s, ...out };
}

/** Credits the streak day `day` (idempotent: a second credit on the same day is a no-op). */
function advanceStreak(state, day) {
	const s0 = { ...defaultState(), ...state };
	if (s0.lastDay !== null && day <= s0.lastDay) return { state: s0, credited: false, box: null };
	const missed = s0.lastDay === null ? 0 : day - s0.lastDay - 1;
	const gap = applyGap(s0, missed);
	const s = gap.state;
	s.count += 1;
	s.total += 1;
	s.lastDay = day;
	const box = boxForDay(s.count);
	if (box === PARAMS.ladder.milestoneBox) s.grace = Math.min(PARAMS.grace.max, s.grace + PARAMS.grace.perCycle);
	const badges = PARAMS.badges.filter((b) => s.count >= b && s0.best < b);
	s.best = Math.max(s0.best, s.count);
	return { state: s, credited: true, box, streakDay: s.count, graceUsed: gap.graceUsed, decayedBy: gap.decayedBy, reset: gap.reset, badges };
}

/** One successful cast on DCC day `day`: counts it and credits the streak when the gate is reached. */
function onSuccessfulCast(state, day) {
	const s0 = { ...defaultState(), ...state };
	const castsToday = (s0.castsDay === day ? s0.castsToday : 0) + 1;
	const counted = { ...s0, castsDay: day, castsToday };
	if (castsToday < PARAMS.gate.successfulCasts || (s0.lastDay !== null && s0.lastDay >= day)) return { state: counted, credit: null };
	const credit = advanceStreak(counted, day);
	return { state: credit.state, credit };
}

// ---------------------------------------------------------------------------------------------
// Catalog pools (the seeded catalog; the engine builds the same pools from the database).
const ITEMS = [
	...PART_CATALOG.map((p) => ({ name: p.name, type: p.type, rarity: lower(p.rarity) })),
	...BAIT_CATALOG.map((b) => ({ name: b.name, type: 'bait', rarity: lower(b.rarity) })),
	...BUFF_CATALOG.map((b) => ({ name: b.name, type: 'buff', rarity: lower(b.rarity), hours: (b.length || 0) / 3600 })),
	...ROD_CATALOG.map((r) => ({ name: r.name, type: r.type, rarity: lower(r.rarity) })),
];
const isPart = (i) => String(i.type).startsWith('part_');

/** Proposed Gacha V2 definitions (engine format; `fish: 'highestUnlocked'` and `fishShare` are new pool options). */
function boxDefinitions() {
	const P = PARAMS.pool;
	const exclude = ITEMS.filter((i) => isPart(i) && rIdx(i.rarity) > rIdx(P.maxPartRarity)).map((i) => i.name);
	return Object.fromEntries(Object.entries(PARAMS.boxes).map(([name, b]) => [name, {
		id: b.id,
		slots: b.slots,
		strategy: 'independent',
		pool: { types: [...P.types], fish: P.fish, fishShare: P.fishShare, exclude, featured: [] },
		rarityTable: { ...P.rarityTable },
		rarityFloor: P.rarityFloor,
		guaranteedSlots: b.guaranteedSlots.map((g) => ({ ...g })),
		duplicates: P.duplicates,
		pity: null,
	}]));
}

/** The legacy Voter's Crate as defined in src (kept forever), plus the recommended Old Rod exclusion. */
function legacyVotersCrate({ excludeOldRod = PARAMS.topgg.legacyVotersCrate.excludeOldRod } = {}) {
	const def = JSON.parse(JSON.stringify(VOTERS));
	if (excludeOldRod) def.pool.exclude = [...new Set([...(def.pool.exclude || []), ...ROD_CATALOG.map((r) => r.name)])];
	return def;
}

/** Fish of one rarity a pool offers at `level`: the highest accessible biome that has that rarity. */
function fishFor(poolFish, rarity, level) {
	if (!poolFish) return [];
	if (poolFish === 'highestUnlocked') {
		const open = F.LIVE_BIOMES.filter((b) => level >= F.BIOME_LEVEL[b]).reverse();
		for (const b of open) {
			const list = FISH.filter((f) => f.biome === b && f.rarity === rarity);
			if (list.length) return list;
		}
		return [];
	}
	// true: every catchable fish (fish whose biome exists as a Biome document: the live biomes).
	return FISH.filter((f) => F.LIVE_BIOMES.includes(f.biome) && f.rarity === rarity);
}

const maskBelow = (t, min) => Object.fromEntries(RARITIES.map((r) => [r, rIdx(r) >= rIdx(min) ? t[r] : 0]));

/**
 * Exact expected contents of one open. Mirrors gacha.openLine: base table restricted to rarities with
 * rewards, rarity floor, profile gacha stats (buildTable), per-slot guarantees; within a rarity the kind
 * is fish with probability fishShare (when both kinds exist), then uniform (no featured weights).
 * Pity is not modelled (Founder only; it can only raise Founder's figures).
 */
function boxEV(box, { level = 0, profile = 'normal' } = {}) {
	const def = typeof box === 'string' ? (boxDefinitions()[box] || (box === 'Voter\'s Crate' ? legacyVotersCrate() : null)) : box;
	if (!def) throw new Error(`Unknown box ${box}`);
	const prof = PROFILES[profile];
	const exclude = new Set((def.pool.exclude || []).map(lower));
	const pools = Object.fromEntries(RARITIES.map((r) => [r, {
		fish: fishFor(def.pool.fish, r, level),
		items: ITEMS.filter((i) => def.pool.types.includes(i.type) && i.rarity === r && !exclude.has(lower(i.name))),
	}]));
	const has = (r) => pools[r].fish.length + pools[r].items.length > 0;
	let base = normalize(Object.fromEntries(RARITIES.map((r) => [r, has(r) ? Number(def.rarityTable[r]) || 0 : 0])));
	if (def.rarityFloor) {
		const floored = maskBelow(base, def.rarityFloor);
		if (RARITIES.some((r) => floored[r] > 0)) base = normalize(floored);
	}
	const table = buildTable(base, prof.gacha?.stats || {});
	const prices = bait.prices();
	const sell = prof.multipliers.sell;
	const acc = { fish: 0, fishValue: 0, fishByRarity: {}, parts: 0, partsByRarity: {}, salvage: 0, baitPacks: {}, baitUsable: 0, baitDeferred: 0, buffs: {}, rarity: {} };
	const slots = [];
	for (let i = 0; i < def.slots; i++) {
		const g = (def.guaranteedSlots || []).find((x) => x.slot === i);
		const t = g ? normalize(maskBelow(table, g.minRarity)) : table;
		slots.push(Object.fromEntries(RARITIES.filter((r) => t[r] > 0).map((r) => [r, round(t[r], 5)])));
		for (const r of RARITIES) {
			const pr = t[r];
			if (!pr) continue;
			acc.rarity[r] = (acc.rarity[r] || 0) + pr;
			const { fish, items } = pools[r];
			const share = def.pool.fishShare;
			const pf = fish.length && items.length ? (share ?? fish.length / (fish.length + items.length)) : fish.length ? 1 : 0;
			if (pf > 0) {
				const mean = fish.reduce((s, f) => s + F.proposedValue(f), 0) / fish.length;
				acc.fish += pr * pf;
				acc.fishByRarity[r] = (acc.fishByRarity[r] || 0) + pr * pf;
				acc.fishValue += pr * pf * mean * sell;
			}
			for (const it of items) {
				const p = (pr * (1 - pf)) / items.length;
				if (isPart(it)) {
					acc.parts += p;
					acc.partsByRarity[title(it.rarity)] = (acc.partsByRarity[title(it.rarity)] || 0) + p;
					acc.salvage += p * rods.salvageValue(title(it.rarity));
				}
				else if (it.type === 'bait') {
					const q = prices[it.name];
					const packs = PARAMS.baitGrant === 'pack' ? 1 : 1 / q.packSize;
					acc.baitPacks[it.name] = (acc.baitPacks[it.name] || 0) + p * packs;
					if (q.levelRequirement <= level) acc.baitUsable += p * packs * q.packPrice;
					else acc.baitDeferred += p * packs * q.packPrice;
				}
				else if (it.type === 'buff') {
					acc.buffs[it.name] = (acc.buffs[it.name] || 0) + p;
				}
				// 'rod' (legacy Voter's Crate only): an extra Old Rod has no value (unbreakable Old Rod).
			}
		}
	}
	return {
		box: def.id,
		slots: def.slots,
		level,
		profile,
		biome: def.pool.fish === 'highestUnlocked' ? F.biomeAt(level) : 'all live biomes',
		slotTables: slots,
		...acc,
		liquid: acc.fishValue + acc.salvage,
	};
}

// ---------------------------------------------------------------------------------------------
// Stage rates (the same castOutcome/hourly call as curve.js).
const rateCache = new Map();
function rates(biome, tier, overheadS) {
	const key = `${biome}|${tier.tier}|${overheadS}`;
	if (!rateCache.has(key)) {
		const o = F.castOutcome({ biome, qualities: tier.qualities, stats: tier.stats, multiChance: F.chanceForMean(tier.meanFish) });
		rateCache.set(key, { ...F.hourly(o, overheadS), valuePerFish: o.valuePerFish });
	}
	return rateCache.get(key);
}
const archOf = (a) => (typeof a === 'string' ? F.ARCHETYPES[a] : a) || F.ARCHETYPES[F.REFERENCE_ARCHETYPE];
/** Hourly rates of a player at `level` (highest live biome, best tier at that level unless given). */
function stageRates(level, { archetype = F.REFERENCE_ARCHETYPE, tier = F.tierAt(level) } = {}) {
	const arch = archOf(archetype);
	return { biome: F.biomeAt(level), tier: tier.key, ...rates(F.biomeAt(level), tier, arch.overheadS) };
}

const buffHours = (name) => ITEMS.find((i) => i.type === 'buff' && i.name === name)?.hours || 0;

/**
 * INTEGRATOR ENTRY POINT: expected value of the box earned on streak day `day` by a player at `level`.
 * cashEquivalent = fish sale value + salvage of parts + usable bait packs at their pack price + the
 * Double Cash buff's extra income over min(buff length, the archetype's daily play).
 * xp = the Double XP buff's extra XP over the same window (no direct streak XP).
 */
function streakValue(day, level, { archetype = F.REFERENCE_ARCHETYPE, tier = F.tierAt(level), profile = 'normal' } = {}) {
	const box = boxForDay(day);
	const ev = boxEV(box, { level, profile });
	const arch = archOf(archetype);
	const r = rates(F.biomeAt(level), tier, arch.overheadS);
	const playH = arch.minutesPerDay / 60;
	const dxp = (ev.buffs['Double XP'] || 0) * Math.min(buffHours('Double XP'), playH);
	const dcash = (ev.buffs['Double Cash'] || 0) * Math.min(buffHours('Double Cash'), playH);
	const xp = dxp * r.xp;
	const doubleCash = dcash * r.cash;
	const cashEquivalent = ev.fishValue + ev.salvage + ev.baitUsable + doubleCash;
	return {
		day,
		level,
		box,
		cashEquivalent,
		xp,
		items: {
			box,
			slots: ev.slots,
			fish: ev.fish,
			fishByRarity: ev.fishByRarity,
			parts: ev.partsByRarity,
			baitPacks: ev.baitPacks,
			buffs: ev.buffs,
		},
		breakdown: { fish: ev.fishValue, salvage: ev.salvage, baitUsable: ev.baitUsable, baitDeferred: ev.baitDeferred, doubleCash, liquid: ev.liquid },
	};
}

/** Average per claimed day over one ladder cycle (cycle-1 crates + 1 chest). */
function perClaimValue(level, opts = {}) {
	const n = PARAMS.ladder.cycle;
	const vals = Array.from({ length: n }, (_, i) => streakValue(i + 1, level, opts));
	const avg = (f) => vals.reduce((s, v) => s + f(v), 0) / n;
	return {
		cashEquivalent: avg((v) => v.cashEquivalent),
		xp: avg((v) => v.xp),
		liquid: avg((v) => v.breakdown.liquid),
		fish: avg((v) => v.breakdown.fish),
		salvage: avg((v) => v.breakdown.salvage),
		baitUsable: avg((v) => v.breakdown.baitUsable),
		doubleCash: avg((v) => v.breakdown.doubleCash),
		fishCount: avg((v) => v.items.fish),
		parts: avg((v) => Object.values(v.items.parts).reduce((a, b) => a + b, 0)),
		baitPacks: avg((v) => Object.values(v.items.baitPacks).reduce((a, b) => a + b, 0)),
		buffs: avg((v) => Object.values(v.items.buffs).reduce((a, b) => a + b, 0)),
	};
}

// ---------------------------------------------------------------------------------------------
// Attendance: exact distribution over (streak count, grace tokens, missed days in a row) when the player
// meets the gate on each day independently with probability p. `rules` overrides grace/decay/cycle.
function attendanceModel(p, days = 30, rules = PARAMS) {
	const R = rules.decay.resetAfterMissedDays;
	const G = rules.grace.max;
	const C = days + 1;
	const idx = (c, g, m) => (c * (G + 1) + g) * (R + 1) + m;
	let cur = new Float64Array(C * (G + 1) * (R + 1));
	cur[idx(0, Math.min(G, rules.grace.start), 0)] = 1;
	const out = { p, days, claims: 0, crates: 0, chests: 0, graceUsed: 0, decayEvents: 0, daysDecayed: 0, resets: 0 };
	for (let d = 0; d < days; d++) {
		const nx = new Float64Array(cur.length);
		for (let c = 0; c <= d; c++) {
			for (let g = 0; g <= G; g++) {
				for (let m = 0; m <= R; m++) {
					const pr = cur[idx(c, g, m)];
					if (!pr) continue;
					if (p > 0) {
						const gap = applyGap({ count: c, grace: g }, m, rules);
						const cnt = gap.state.count + 1;
						const chest = cnt % rules.ladder.cycle === 0;
						const g2 = chest ? Math.min(G, gap.state.grace + rules.grace.perCycle) : gap.state.grace;
						const w = pr * p;
						out.claims += w;
						if (chest) out.chests += w;
						else out.crates += w;
						out.graceUsed += w * gap.graceUsed;
						if (gap.reset) out.resets += w;
						else if (gap.decayedBy > 0) out.decayEvents += w;
						out.daysDecayed += w * gap.decayedBy;
						nx[idx(cnt, g2, 0)] += w;
					}
					if (p < 1) nx[idx(c, g, Math.min(R, m + 1))] += pr * (1 - p);
				}
			}
		}
		cur = nx;
	}
	let meanCount = 0;
	for (let c = 0; c < C; c++) for (let g = 0; g <= G; g++) for (let m = 0; m <= R; m++) meanCount += c * cur[idx(c, g, m)];
	return { ...out, chestShare: out.claims ? out.chests / out.claims : 0, meanStreakAtEnd: meanCount };
}

/** Attendance table for the proposed rules and one alternative (more grace), with value per claim. */
function attendanceTable() {
	const alt = { ...PARAMS, grace: { ...PARAMS.grace, ...PARAMS.alternatives.moreGrace } };
	// Valued at the first crafted-rod level (Tier 1 of the shared gear path); the ratios barely move by level.
	const refLevel = F.gearPath()[1].level;
	const crate = boxEV(PARAMS.ladder.dailyBox, { level: refLevel }).liquid;
	const chest = boxEV(PARAMS.ladder.milestoneBox, { level: refLevel }).liquid;
	const row = (p, rules) => {
		const d30 = attendanceModel(p, 30, rules);
		const d365 = attendanceModel(p, 365, rules);
		const perClaim = (x) => (x.crates * crate + x.chests * chest) / x.claims;
		return { d30, d365, valuePerClaimVsDaily: perClaim(d365) };
	};
	const daily = row(1, PARAMS);
	const ps = [1, 6 / 7, 5 / 7, 4 / 7, 3 / 7];
	const mk = (rules) => ps.map((p) => {
		const r = row(p, rules);
		return { p: round(p, 4), daysPerWeek: round(7 * p, 2), ...r, valuePerClaimVsDaily: r.valuePerClaimVsDaily / daily.valuePerClaimVsDaily };
	});
	return { referenceLevel: refLevel, crateLiquid: crate, chestLiquid: chest, proposed: mk(PARAMS), moreGrace: { rules: alt.grace, rows: mk(alt) } };
}

// ---------------------------------------------------------------------------------------------
// Lifecycle: curve.js stepping (1-minute steps, highest biome, shared gear path bought after
// F.PURCHASE.saveHours of stage income, F.DAILY.xpPerLevel x level per day). With `streak` on, each day
// boundary also credits one streak day (every archetype plays daily and far exceeds the gate).
const svCache = new Map();
function streakDayCached(day, L, tier, arch) {
	const box = boxForDay(day);
	const usable = Object.values(bait.prices()).filter((q) => q.levelRequirement <= L).length;
	const k = `${box}|${F.biomeAt(L)}|${usable}|${tier.tier}|${arch.minutesPerDay}|${arch.overheadS}`;
	if (!svCache.has(k)) svCache.set(k, streakValue(day, L, { archetype: arch, tier }));
	return svCache.get(k);
}

function lifecycle(archetype, { streak = true, dailyXp = true, maxDays = Infinity, maxLevel = F.LIFECYCLE.maxLevel, snapshots = [7, 30, 90] } = {}) {
	const arch = archOf(archetype);
	const path = F.gearPath();
	const STEP_H = F.LIFECYCLE.stepH;
	const dayH = arch.minutesPerDay / 60;
	let xp = 0;
	let h = 0;
	let tierIdx = 0;
	let saving = 0;
	let day = 0;
	const xpBy = { fishing: 0, daily: 0, streak: 0 };
	const cashBy = { fishing: 0, streak: 0 };
	const streakBy = { fish: 0, salvage: 0, baitUsable: 0, doubleCash: 0 };
	const items = { crates: 0, chests: 0, fish: 0, parts: 0, baitPacks: 0, buffs: 0 };
	const reached = {};
	const at = {};
	const snap = {};
	const take = () => ({ level: F.levelForXp(xp), hours: round(h, 3), tier: path[tierIdx].key, xpBy: { ...xpBy }, cashBy: { ...cashBy }, streakBy: { ...streakBy }, items: { ...items } });
	while (h < 2000) {
		const L = F.levelForXp(xp);
		const next = path[tierIdx + 1];
		const cur = path[tierIdx];
		const r = rates(F.biomeAt(L), cur, arch.overheadS);
		if (next && L >= next.level) {
			saving += r.cash * STEP_H;
			if (saving >= r.cash * F.PURCHASE.saveHours) {
				tierIdx++;
				saving = 0;
			}
		}
		xp += r.xp * STEP_H;
		xpBy.fishing += r.xp * STEP_H;
		cashBy.fishing += r.cash * STEP_H;
		const before = h;
		h += STEP_H;
		if (Math.floor(h / dayH) !== Math.floor(before / dayH)) {
			day++;
			if (dailyXp) {
				xp += F.DAILY.xpPerLevel * L;
				xpBy.daily += F.DAILY.xpPerLevel * L;
			}
			if (streak) {
				const v = streakDayCached(day, L, cur, arch);
				xp += v.xp;
				xpBy.streak += v.xp;
				cashBy.streak += v.cashEquivalent;
				for (const k of Object.keys(streakBy)) streakBy[k] += v.breakdown[k];
				if (v.box === PARAMS.ladder.milestoneBox) items.chests++;
				else items.crates++;
				items.fish += v.items.fish;
				items.parts += Object.values(v.items.parts).reduce((a, b) => a + b, 0);
				items.baitPacks += Object.values(v.items.baitPacks).reduce((a, b) => a + b, 0);
				items.buffs += Object.values(v.items.buffs).reduce((a, b) => a + b, 0);
			}
			if (snapshots.includes(day)) snap[day] = take();
		}
		const L2 = F.levelForXp(xp);
		for (const T of F.LIFECYCLE.milestones) {
			if (!reached[T] && L2 >= T) {
				reached[T] = { hours: +h.toFixed(2), day: Math.ceil(h / dayH) };
				at[T] = take();
			}
		}
		if (L2 >= maxLevel || day >= maxDays) break;
	}
	return { archetype: arch, reached, at, snapshots: snap, final: take(), days: day };
}

// ---------------------------------------------------------------------------------------------
// Value per archetype vs fishing income.
let avCache = null;
function archetypeValue() {
	if (avCache) return avCache;
	const out = {};
	for (const name of Object.keys(F.ARCHETYPES)) {
		const arch = F.ARCHETYPES[name];
		const lc = lifecycle(name, { maxLevel: Infinity, maxDays: 90 });
		const row = { minutesPerDay: arch.minutesPerDay, periods: {} };
		for (const d of [7, 30, 90]) {
			const s = lc.snapshots[d];
			if (!s) continue;
			row.periods[d] = {
				level: s.level,
				fishingIncome: s.cashBy.fishing,
				streakCashEquivalent: s.cashBy.streak,
				streakShareOfFishing: s.cashBy.streak / s.cashBy.fishing,
				streakPerDay: s.cashBy.streak / d,
				fishingPerDay: s.cashBy.fishing / d,
				streakXpShare: s.xpBy.streak / (s.xpBy.fishing + s.xpBy.daily + s.xpBy.streak),
				streakComponents: Object.fromEntries(Object.entries(s.streakBy).map(([k, v]) => [k, v / s.cashBy.streak])),
				items: s.items,
			};
		}
		// Per day at fixed levels: the start of each biome (level bands every archetype passes through).
		row.byLevel = F.LIVE_BIOMES.map((b) => {
			const L = F.BIOME_LEVEL[b];
			const r = stageRates(L, { archetype: arch, tier: F.typicalTier(b) });
			const v = perClaimValue(L, { archetype: arch, tier: F.typicalTier(b) });
			const fishingPerDay = r.cash * (arch.minutesPerDay / 60);
			return { biome: b, level: L, tier: F.typicalTier(b).key, streakPerDay: v.cashEquivalent, fishingPerDay, share: v.cashEquivalent / fishingPerDay, minutesOfOwnPlay: (v.cashEquivalent / r.cash) * 60 };
		});
		out[name] = row;
	}
	avCache = out;
	return out;
}

// ---------------------------------------------------------------------------------------------
// R2: XP-source decomposition and adversarial scenarios.
function decomposition(lc) {
	return Object.fromEntries(Object.keys(F.TARGET_WINDOWS).map(Number).filter((T) => lc.at[T]).map((T) => {
		const s = lc.at[T];
		const total = s.xpBy.fishing + s.xpBy.daily + s.xpBy.streak;
		return [T, {
			hours: lc.reached[T].hours,
			day: lc.reached[T].day,
			fishingXp: Math.round(s.xpBy.fishing),
			questXpNonDaily: 0,
			dailyXpProvisional: Math.round(s.xpBy.daily),
			streakXp: Math.round(s.xpBy.streak),
			otherXp: 0,
			share: { fishing: s.xpBy.fishing / total, questNonDaily: 0, dailyProvisional: s.xpBy.daily / total, streak: s.xpBy.streak / total, other: 0 },
		}];
	}));
}

/** The minimum-daily player: exactly the gate's casts per day, at the reference cadence, Old Rod speed. */
function minimumDailyArchetype() {
	const overheadS = F.DESIGN_OVERHEAD_S;
	return { minutesPerDay: (PARAMS.gate.successfulCasts * (F.COOLDOWN.fishMs / 1000 + overheadS)) / 60, overheadS };
}

let r2Cache = null;
function r2() {
	if (r2Cache) return r2Cache;
	const archetypes = {};
	for (const name of Object.keys(F.ARCHETYPES)) {
		const on = lifecycle(name, { streak: true });
		const off = lifecycle(name, { streak: false });
		archetypes[name] = {
			decomposition: decomposition(on),
			hoursWithoutStreak: Object.fromEntries(Object.entries(off.reached).map(([k, v]) => [k, v.hours])),
			hoursWithStreak: Object.fromEntries(Object.entries(on.reached).map(([k, v]) => [k, v.hours])),
			maxHoursDelta: Math.max(...Object.keys(off.reached).map((k) => Math.abs(on.reached[k].hours - off.reached[k].hours) / off.reached[k].hours)),
		};
	}
	// Minimum-daily vs casual: levels per calendar week, XP per active hour and per calendar day.
	const minArch = minimumDailyArchetype();
	// Calendar checkpoints: 1, 4, 13, 26 and 52 weeks.
	const checkDays = [1, 4, 13, 26, 52].map((w) => w * PARAMS.ladder.cycle);
	const horizon = checkDays[checkDays.length - 1];
	const scenario = (dailyXp) => {
		const run = (arch) => lifecycle(arch, { dailyXp, maxDays: horizon, maxLevel: Infinity, snapshots: checkDays }).snapshots;
		const ms = run(minArch);
		const cs = run('casual');
		const rows = checkDays.map((d) => {
			const m = ms[d];
			const c = cs[d];
			const mXp = m.xpBy.fishing + m.xpBy.daily + m.xpBy.streak;
			const cXp = c.xpBy.fishing + c.xpBy.daily + c.xpBy.streak;
			return {
				day: d,
				minimumDaily: { level: m.level, hours: m.hours, xpPerActiveHour: mXp / m.hours, xpPerDay: mXp / d, streakXpShare: m.xpBy.streak / mXp, streakCashPerDay: m.cashBy.streak / d, streakCashPerActiveHour: m.cashBy.streak / m.hours, streakShareOfIncome: m.cashBy.streak / (m.cashBy.fishing + m.cashBy.streak) },
				casual: { level: c.level, hours: c.hours, xpPerActiveHour: cXp / c.hours, xpPerDay: cXp / d, streakXpShare: c.xpBy.streak / cXp, streakCashPerDay: c.cashBy.streak / d, streakCashPerActiveHour: c.cashBy.streak / c.hours, streakShareOfIncome: c.cashBy.streak / (c.cashBy.fishing + c.cashBy.streak) },
				minimumDailyLeadsInLevel: m.level > c.level,
			};
		});
		return { rows, leadsAnywhere: rows.some((r) => r.minimumDailyLeadsInLevel) };
	};
	const minimumDaily = {
		archetype: minArch,
		gateCasts: PARAMS.gate.successfulCasts,
		streakOnly: scenario(false),
		withProvisionalDaily: scenario(true),
	};
	minimumDaily.verdict = !minimumDaily.streakOnly.leadsAnywhere && !minimumDaily.withProvisionalDaily.leadsAnywhere
		? 'PASS: the minimum-daily player never leads a casual player in level on any calendar checkpoint. The streak adds no direct XP, so its only XP (Double XP buffs) scales with real play.'
		: 'FAIL: the minimum-daily player leads a casual player in level; add a guardrail.';
	// No-miss grinder: every streak reward on top of grinding.
	const g = archetypes.grinder;
	const noMissGrinder = {
		hoursWithoutStreak: g.hoursWithoutStreak,
		hoursWithStreak: g.hoursWithStreak,
		maxHoursDelta: g.maxHoursDelta,
		regularStillInWindows: Object.entries(F.TARGET_WINDOWS).every(([L, [lo, hi]]) => archetypes.regular.hoursWithStreak[L] >= lo && archetypes.regular.hoursWithStreak[L] <= hi),
	};
	noMissGrinder.verdict = noMissGrinder.maxHoursDelta <= PARAMS.targets.grinderHoursDeltaMax && noMissGrinder.regularStillInWindows
		? `PASS: stacking every streak reward on grinding moves the grinder's milestones by at most ${(100 * noMissGrinder.maxHoursDelta).toFixed(2)}%, and the regular player stays inside every approved window.`
		: 'FAIL: the streak moves milestones materially; cap the buff source.';
	r2Cache = { archetypes, minimumDaily, noMissGrinder };
	return r2Cache;
}

// ---------------------------------------------------------------------------------------------
// Rods interplay: days of streak drops to complete the T1 reference set (one Uncommon part per slot).
function t1PartsFromStreak() {
	const crate = boxEV('Streak Crate', { level: 0 });
	const perSlot = crate.partsByRarity.Uncommon / crate.slots;
	const unc = ITEMS.filter((i) => isPart(i) && i.rarity === 'uncommon');
	const slotsNeeded = ['part_rod', 'part_reel', 'part_hook', 'part_handle'];
	const q = slotsNeeded.map((t) => (perSlot * unc.filter((i) => i.type === t).length) / unc.length);
	// Markov chain over collected slot-type subsets, one Streak Crate (3 independent slots) per day.
	const n = slotsNeeded.length;
	const full = (1 << n) - 1;
	const slotOutcomes = [...q.map((p, i) => ({ mask: 1 << i, p })), { mask: 0, p: 1 - q.reduce((a, b) => a + b, 0) }];
	let open = [{ mask: 0, p: 1 }];
	for (let s = 0; s < crate.slots; s++) {
		const nx = new Map();
		for (const o of open) for (const so of slotOutcomes) nx.set(o.mask | so.mask, (nx.get(o.mask | so.mask) || 0) + o.p * so.p);
		open = [...nx].map(([mask, p]) => ({ mask, p }));
	}
	// Tier 1 level from the shared gear path; its assembly cost from the rods crate helper (not a gear source).
	const t1 = { level: F.gearPath().find((x) => x.tier === 1).level, assembly: rods.assembly(1) };
	const daysToTier1 = Object.fromEntries(Object.keys(F.ARCHETYPES).map((k) => [k, lifecycle(k, { streak: false }).reached[t1.level].day]));
	const doneBy = {};
	let dist = new Map([[0, 1]]);
	let expected = 0;
	let median = null;
	let p90 = null;
	for (let d = 1; d <= 2000; d++) {
		const before = dist.get(full) || 0;
		const nx = new Map();
		for (const [m, p] of dist) for (const o of open) nx.set(m | o.mask, (nx.get(m | o.mask) || 0) + p * o.p);
		dist = nx;
		const done = dist.get(full) || 0;
		expected += d * (done - before);
		for (const [k, day] of Object.entries(daysToTier1)) if (day === d) doneBy[k] = done;
		if (median === null && done >= 0.5) median = d;
		if (p90 === null && done >= 0.9) p90 = d;
		if (done > 1 - 1e-12 && d > Math.max(...Object.values(daysToTier1))) break;
	}
	return {
		note: 'Streak Crates only (chests ignored: conservative); each crate slot independent',
		uncommonPartsPerCrate: crate.partsByRarity.Uncommon,
		slotChancePerCrateSlot: Object.fromEntries(slotsNeeded.map((t, i) => [t, q[i]])),
		expectedDays: expected,
		medianDays: median,
		p90Days: p90,
		t1AssemblyCost: t1.assembly.expectedCost,
		t1Level: t1.level,
		daysToTier1Level: daysToTier1,
		pSetCompleteByTier1Level: doneBy,
	};
}

// ---------------------------------------------------------------------------------------------
// Top.gg today vs the proposed streak.
function topggComparison() {
	const players = SIMULATION.players;
	const today = {};
	for (const name of Object.keys(F.ARCHETYPES)) {
		const wv = players[name]?.withVotes;
		if (!wv) continue;
		const votesPerDay = wv.arch.votes;
		today[name] = {
			votesPerDay,
			cashPerVote: wv.sources.votes / (wv.days * votesPerDay),
			votes30d: wv.sources.votes + wv.sources.voterCrateLiquid,
			fishing30d: wv.sources.fishSales,
			votesShareOfFishing: (wv.sources.votes + wv.sources.voterCrateLiquid) / wv.sources.fishSales,
		};
	}
	// The same Top.gg rule under the new value model and the proposed lifecycle (30 days).
	const proposed = {};
	for (const name of Object.keys(today)) {
		const lc = lifecycle(name, { maxLevel: Infinity, maxDays: 30 });
		const s = lc.snapshots[30];
		const L = s.level;
		const voters = boxEV(legacyVotersCrate(), { level: L });
		const topgg30 = 30 * today[name].votesPerDay * (today[name].cashPerVote + voters.liquid + voters.baitUsable);
		proposed[name] = {
			level30: L,
			fishing30d: s.cashBy.fishing,
			topggRule30d: topgg30,
			topggShareOfFishing: topgg30 / s.cashBy.fishing,
			streak30d: s.cashBy.streak,
			streakShareOfFishing: s.cashBy.streak / s.cashBy.fishing,
		};
	}
	return { todayModel: today, newValueModel: proposed, votersCrateTodayLiquid: GACHA_EV['Voter\'s Crate'].expectedLiquidValuePerOpen };
}

// ---------------------------------------------------------------------------------------------
// Exciting outcomes: Legendary/Lucky rewards (fish only in these pools) per box, week and 30 days.
function jackpots(level = F.gearPath()[1].level) {
	const hi = ['legendary', 'lucky'];
	const box = (name) => {
		const ev = boxEV(name, { level });
		const perSlot = ev.slotTables.map((t) => hi.reduce((a, r) => a + (t[r] || 0), 0));
		return { expected: perSlot.reduce((a, b) => a + b, 0), pAtLeastOne: 1 - perSlot.reduce((a, q) => a * (1 - q), 1) };
	};
	const crate = box(PARAMS.ladder.dailyBox);
	const chest = box(PARAMS.ladder.milestoneBox);
	const n = PARAMS.ladder.cycle;
	const pWeek = 1 - (1 - crate.pAtLeastOne) ** (n - 1) * (1 - chest.pAtLeastOne);
	return { level, crate, chest, pAtLeastOnePerWeek: pWeek, expectedPer30Days: (30 / n) * ((n - 1) * crate.expected + chest.expected) };
}

/** Structural bound: streak XP is at most the share of streak days that bring a Double XP buff. */
function doubleXpDayShare() {
	const L = F.gearPath()[1].level;
	const n = PARAMS.ladder.cycle;
	const dxp = (name) => boxEV(name, { level: L }).buffs['Double XP'] || 0;
	return ((n - 1) * dxp(PARAMS.ladder.dailyBox) + dxp(PARAMS.ladder.milestoneBox)) / n;
}

// ---------------------------------------------------------------------------------------------
// Worked rule traces (what the engine tests assert), produced by the same pure functions.
function ruleExamples() {
	const trace = (label, days, start = {}) => {
		let st = { ...defaultState(), ...start };
		const steps = days.map((d) => {
			const r = advanceStreak(st, d);
			st = r.state;
			return { day: d, credited: r.credited, streak: st.count, grace: st.grace, box: r.box, graceUsed: r.graceUsed || 0, decayedBy: r.decayedBy || 0, reset: Boolean(r.reset), badges: r.badges || [] };
		});
		return { label, start, steps };
	};
	const G = PARAMS.gate.successfulCasts;
	let gs = defaultState();
	const gate = [];
	for (let i = 1; i <= G + 1; i++) {
		const r = onSuccessfulCast(gs, 100);
		gs = r.state;
		if (i >= G - 1) gate.push({ cast: i, castsToday: gs.castsToday, credited: Boolean(r.credit), box: r.credit?.box || null });
	}
	const next = onSuccessfulCast(gs, 101);
	gate.push({ cast: 'first cast of the next day', castsToday: next.state.castsToday, credited: Boolean(next.credit) });
	const week = Array.from({ length: PARAMS.ladder.cycle }, (_, i) => i + 1);
	return {
		gate,
		firstWeek: trace('seven days in a row', week),
		sameDayTwice: trace('same day credited twice', [1, 1]),
		missCovered: trace('streak 10, one missed day, 1 token', [12], { count: 10, best: 10, total: 10, lastDay: 10, grace: 1 }),
		missUncovered: trace('streak 10, two missed days, 1 token', [13], { count: 10, best: 10, total: 10, lastDay: 10, grace: 1 }),
		newStreakMiss: trace('streak 5, one missed day, no token', [7], { count: 5, best: 5, total: 5, lastDay: 5, grace: 0 }),
		longGap: trace('streak 40, away a full week', [48], { count: 40, best: 40, total: 40, lastDay: 40, grace: 2 }),
	};
}

// ---------------------------------------------------------------------------------------------
function founderView() {
	return F.LIVE_BIOMES.map((b) => {
		const L = F.BIOME_LEVEL[b];
		const n = boxEV('Streak Crate', { level: L });
		const f = boxEV('Streak Crate', { level: L, profile: 'founder' });
		const nc = boxEV('Streak Chest', { level: L });
		const fc = boxEV('Streak Chest', { level: L, profile: 'founder' });
		return {
			biome: b,
			crate: { normal: n.liquid, founder: f.liquid, ratio: f.liquid / n.liquid, founderLegendaryPlus: (f.rarity.legendary || 0) + (f.rarity.lucky || 0), normalLegendaryPlus: (n.rarity.legendary || 0) + (n.rarity.lucky || 0) },
			chest: { normal: nc.liquid, founder: fc.liquid, ratio: fc.liquid / nc.liquid },
		};
	});
}

let baselineCache = null;
function baselineMatchesCurveJson() {
	if (baselineCache) return baselineCache;
	const rows = {};
	let ok = CURVE_JSON.chosen === F.CURVE.quartic;
	for (const name of Object.keys(F.ARCHETYPES)) {
		const lc = lifecycle(name, { streak: false });
		const cj = CURVE_JSON.archetypes[name];
		rows[name] = Object.fromEntries(Object.keys(cj).map((k) => [k, { mine: lc.reached[k], curveJson: cj[k] }]));
		for (const k of Object.keys(cj)) ok = ok && lc.reached[k] && lc.reached[k].hours === cj[k].hours && lc.reached[k].day === cj[k].day;
	}
	baselineCache = { match: Boolean(ok), rows };
	return baselineCache;
}

// ---------------------------------------------------------------------------------------------
function checks() {
	const T = PARAMS.targets;
	const av = archetypeValue();
	const r = r2();
	const t1 = t1PartsFromStreak();
	const defs = boxDefinitions();
	const pools = Object.values(defs).flatMap((d) => d.pool.types);
	const shares = Object.fromEntries(Object.entries(av).map(([k, v]) => [k, v.periods[30].streakShareOfFishing]));
	const order = ['casual', 'regular', 'active', 'grinder'];
	const maxStreakXpShare = Math.max(...Object.values(r.archetypes).flatMap((a) => Object.values(a.decomposition).map((d) => d.share.streak)));
	const minDailyXpShare = Math.max(...r.minimumDaily.streakOnly.rows.map((x) => x.minimumDaily.streakXpShare));
	const bound = doubleXpDayShare();
	const list = [
		{ id: 'no-direct-cash-or-xp', pass: PARAMS.direct.cash === 0 && PARAMS.direct.xp === 0 },
		{ id: 'no-booster-pack-no-old-rod', pass: !pools.includes('gacha') && !pools.includes('rod') },
		{ id: 'casual-30d-share-in-band', value: shares.casual, band: T.casual30dShare, pass: shares.casual >= T.casual30dShare[0] && shares.casual <= T.casual30dShare[1] },
		{ id: 'regular-30d-share-max', value: shares.regular, max: T.regular30dShareMax, pass: shares.regular <= T.regular30dShareMax },
		{ id: 'grinder-30d-share-max', value: shares.grinder, max: T.grinder30dShareMax, pass: shares.grinder <= T.grinder30dShareMax },
		{ id: 'casual-gains-relatively-most', value: order.map((k) => round(shares[k], 4)), pass: order.every((k, i) => i === 0 || shares[order[i - 1]] > shares[k]) },
		{ id: 'streak-xp-share-max', value: maxStreakXpShare, max: T.streakXpShareMax, pass: maxStreakXpShare <= T.streakXpShareMax },
		{ id: 'streak-xp-within-double-xp-bound', value: { archetypes: maxStreakXpShare, minimumDaily: minDailyXpShare }, max: bound, pass: maxStreakXpShare <= bound && minDailyXpShare <= bound },
		{ id: 'r2-minimum-daily', pass: !r.minimumDaily.streakOnly.leadsAnywhere && !r.minimumDaily.withProvisionalDaily.leadsAnywhere },
		{ id: 'r2-no-miss-grinder', value: r.noMissGrinder.maxHoursDelta, max: T.grinderHoursDeltaMax, pass: r.noMissGrinder.maxHoursDelta <= T.grinderHoursDeltaMax },
		{ id: 'regular-in-windows-with-streak', pass: r.noMissGrinder.regularStillInWindows },
		{ id: 't1-set-not-free-for-regular', value: t1.medianDays, min: T.minT1Days, pass: t1.medianDays >= T.minT1Days && t1.medianDays > t1.daysToTier1Level.regular },
		{ id: 'baseline-reproduces-curve-json', pass: baselineMatchesCurveJson().match },
	];
	return { pass: list.every((c) => c.pass), list };
}

// ---------------------------------------------------------------------------------------------
let reportCache = null;
function report() {
	if (reportCache) return reportCache;
	const defs = boxDefinitions();
	const crate = Object.fromEntries(F.LIVE_BIOMES.map((b) => {
		const L = F.BIOME_LEVEL[b];
		const c = boxEV('Streak Crate', { level: L });
		const h = boxEV('Streak Chest', { level: L });
		const r = stageRates(L, { tier: F.typicalTier(b) });
		const v = perClaimValue(L, { tier: F.typicalTier(b) });
		return [b, {
			level: L,
			tier: F.typicalTier(b).key,
			stageCashPerHour: r.cash,
			stageValuePerFish: r.valuePerFish,
			crate: { liquid: c.liquid, fish: c.fish, fishValue: c.fishValue, salvage: c.salvage, baitUsable: c.baitUsable, baitDeferred: c.baitDeferred, buffs: c.buffs, fishByRarity: c.fishByRarity },
			chest: { liquid: h.liquid, fish: h.fish, fishValue: h.fishValue, salvage: h.salvage, baitUsable: h.baitUsable, baitDeferred: h.baitDeferred, buffs: h.buffs, fishByRarity: h.fishByRarity, slot0: h.slotTables[0] },
			perClaim: v,
			perClaimMinutesOfStageIncome: (v.cashEquivalent / r.cash) * 60,
			perClaimStageFish: v.fish / r.valuePerFish,
		}];
	}));
	const legacy = F.LIVE_BIOMES.map((b) => ({ biome: b, level: F.BIOME_LEVEL[b], ...(({ liquid, fishValue, salvage, baitUsable, buffs }) => ({ liquid, fishValue, salvage, baitUsable, buffs }))(boxEV(legacyVotersCrate(), { level: F.BIOME_LEVEL[b] })) }));
	const ladderAt = F.gearPath()[1].level;
	const ladder = Array.from({ length: PARAMS.ladder.cycle + 1 }, (_, i) => {
		const v = streakValue(i + 1, ladderAt);
		return { streakDay: i + 1, box: v.box, cashEquivalent: v.cashEquivalent, xp: v.xp, fish: v.items.fish, breakdown: v.breakdown };
	});
	reportCache = {
		...F.stamp(),
		gearPathSource: F.GEAR_PATH_SOURCE,
		params: PARAMS,
		gate: { successfulCasts: PARAMS.gate.successfulCasts, minutesByArchetype: Object.fromEntries(Object.entries(F.ARCHETYPES).map(([k, a]) => [k, (PARAMS.gate.successfulCasts * (F.COOLDOWN.fishMs / 1000 + a.overheadS)) / 60])), shareOfDailyCasts: Object.fromEntries(Object.entries(F.ARCHETYPES).map(([k, a]) => [k, PARAMS.gate.successfulCasts / (a.minutesPerDay * 60 / (F.COOLDOWN.fishMs / 1000 + a.overheadS))])) },
		boxDefinitions: defs,
		legacyVotersCrate: legacyVotersCrate(),
		values: crate,
		legacyVotersCrateValue: legacy,
		ladder: { level: ladderAt, days: ladder },
		rules: ruleExamples(),
		jackpots: jackpots(),
		doubleXpDayShare: doubleXpDayShare(),
		attendance: attendanceTable(),
		archetypeValue: archetypeValue(),
		r2: r2(),
		t1PartsFromStreak: t1PartsFromStreak(),
		topgg: topggComparison(),
		founder: founderView(),
		baselineMatchesCurveJson: baselineMatchesCurveJson().match,
		checks: checks(),
	};
	return reportCache;
}

module.exports = {
	PARAMS,
	dayIndex, defaultState, boxForDay, applyGap, advanceStreak, onSuccessfulCast,
	boxDefinitions, legacyVotersCrate, boxEV,
	stageRates, streakValue, perClaimValue,
	attendanceModel, attendanceTable, lifecycle, minimumDailyArchetype,
	archetypeValue, r2, t1PartsFromStreak, topggComparison, founderView, baselineMatchesCurveJson, ruleExamples,
	jackpots, doubleXpDayShare, checks,
	report,
};

if (require.main === module) process.stdout.write(`${JSON.stringify(module.exports.report(), null, 1)}\n`);
