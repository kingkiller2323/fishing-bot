// Phase 5B subsystem: DAILY STREAK + STREAK CRATE, and the retirement of Top.gg voting. ANALYSIS ONLY:
// nothing here touches the live game, src/ or production data.
//
// Framework 5b.4. The streak is a SYSTEM on the shared lifecycle core (lifecycle.js): integrate.js composes
// it with rods, world, quests and buffs into the reference loop. This module steps no time itself. Every
// lifecycle figure comes from integrated runs (integratedRun(): the integrate.js reference systems plus an
// observational recorder; recorderParity() proves the recorder changes nothing against integrate.run()).
// Static figures (box contents, stage rates, attendance) come from the framework's pure functions and the
// finished designs' exports: rods.salvageValue() / rods.assembly() (crate helpers, not a gear source),
// bait.prices(), quests.templateTerms(), founder.founderProfile(). Only PARAMS is hand-set; every
// non-obvious choice in it is a PROPOSED decision in DECISIONS (joined to decisions.js).
//
//   node scripts/economy/5b/streak.js          prints report() as JSON
//   node scripts/economy/5b/render-docs.js     fills docs/economy/5b/streak.md from markdownTables()
//
// Exports (pure and synchronous; no database, no randomness):
//   PARAMS, DECISIONS            design parameters; the proposed decisions (status 'proposed' only)
//   dayIndex, defaultState, boxForDay, applyGap, advanceStreak, onSuccessfulCast
//                                the streak rules the engine mirrors (gate, ladder, grace, decay, reset)
//   boxDefinitions()             proposed Gacha V2 definitions: 'Streak Crate', 'Streak Chest'
//   legacyVotersCrate()          the kept Voter's Crate definition (src) + the proposed Old Rod exclusion
//   boxEV(box, {level, profile}) exact expected contents of one open; profile: 'normal' | 'founder' (today's
//                                balance.js profiles) or a profile object (e.g. founder.founderProfile())
//   boxContents(box, level, profile)
//                                what the streak system books for one grant (counting rule: non-buff
//                                contents; buffs counted, valued by the buffs system); 'founder' = the
//                                Founder profile (founder.founderProfile(), opened by founder.founderBoxEV())
//   streakValue(day, level), perClaimValue(level)
//                                boxContents for the n-th streak day; its average over one ladder cycle
//   stageRates(level, opts)      F.castOutcome/F.hourly at the player's highest biome and gear
//   attendanceModel(p, days), attendanceTable()
//                                exact DP over (streak, grace, gap) for daily attendance probability p
//   system(opts)                 the streak SYSTEM (lifecycle.js hooks; integrate.js runs it)
//   integratedRun(archetype, o)  one integrated lifecycle (reference loop, `exclude` for with/without)
//   lifecycle(archetype, opts)   integratedRun() in the design-stage shape (reached / at / snapshots)
//   minimumDailyArchetype()      the gate's casts at the reference cadence as a fixed session (gate minutes;
//                                the R2 adversary itself is F.MINIMUM_DAILY on the core)
//   archetypeValue(), r2(), t1PartsFromStreak(), topggComparison(), founderView(), questInterplay(),
//   creditTiming(), recorderParity(), jackpots(), doubleXpDayShare(), ruleExamples(), checks()
//   SYSTEM_PARITY                the recorded parity of system() with the retired private loop (a83b5f0)
//   report()                     every number in docs/economy/5b/streak.md (cached), with ...F.stamp()
//   markdownTables()             the doc's generated tables ({ blockId: markdown })
const F = require('./framework');
const LC = require('./lifecycle');
const I = require('./integrate');
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

const deepFreeze = (o) => {
	for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
	return Object.freeze(o);
};
const lower = (s) => String(s).toLowerCase();
const title = (s) => lower(s).charAt(0).toUpperCase() + lower(s).slice(1);
const rIdx = (r) => RARITIES.indexOf(lower(r));
const round = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);
const sumValues = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------------------------------------
// Design parameters (the only hand-set numbers in this subsystem; each is a proposed decision).
const VOTERS = BOXES['Voter\'s Crate'];
const PARAMS = deepFreeze({
	id: 'streak-5b',
	// One "DCC day" for the streak AND the daily quest: the shared F.DAY (decisions.js P-DAY), copied so
	// deepFreeze never freezes the shared object.
	day: { ...F.DAY },
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
	// Alternative evaluated in the report (P-STREAK-GRACE): more grace, so a 5-days-a-week player keeps
	// the weekly chest.
	alternatives: { moreGrace: { perCycle: 2, max: 3 } },
	// Cosmetic only (profile flair from `streak.best`): no economic value.
	badges: [7, 30, 100, 365],
	// No direct cash and no direct XP (P-STREAK-NO-CASH-XP).
	direct: { cash: 0, xp: 0 },
	boxes: {
		'Streak Crate': { id: 'streak-crate', slots: 3, guaranteedSlots: [] },
		'Streak Chest': { id: 'streak-chest', slots: 5, guaranteedSlots: [{ slot: 0, minRarity: 'ultra' }] },
	},
	pool: {
		// The Voter's Crate pool, adapted: no Old Rod ('rod'), no rod part above Uncommon (tiered crates
		// own those), fish from the opener's highest accessible biome, a fixed fish share per rarity.
		types: ['bait', 'buff', 'part_rod', 'part_reel', 'part_hook', 'part_handle'],
		// Buffs the streak boxes never contain (user decision: Lucky Draw stays a rarer Daily Box / Booster
		// Pack / event reward). Excluded by name, so the rest of the Rare item pool (Double XP, Double Cash,
		// Rare bait) shares the Rare item slot uniformly, as the engine rolls it; no cash replaces it.
		excludeBuffs: ['Lucky Draw'],
		fish: 'highestUnlocked',
		fishShare: 0.75,
		maxPartRarity: 'uncommon',
		// The Voter's Crate table with its Common tier removed (every Streak Crate reward is Uncommon+).
		rarityTable: { ...VOTERS.rarityTable, common: 0 },
		rarityFloor: 'uncommon',
		duplicates: 'unique',
	},
	// A bait slot grants one pack (the bait design's recommendation), so a bait reward is worth using.
	baitGrant: 'pack',
	topgg: {
		retire: true,
		// '/vote' becomes an ephemeral notice pointing to /daily for `transitionDays`, then is unregistered.
		vote: 'notice-then-unregister',
		transitionDays: 30,
		legacyVotersCrate: { keep: true, excludeOldRod: true },
	},
	// Design targets checked by checks(); shares are of the archetype's own fishing income (integrated).
	// shareBasis 'withAttributedBuffs': streak value = box contents + the buffs system's cash value of every
	// buff from streak boxes (Double Cash by source, Lucky Draw attributed pro rata; user decision).
	targets: {
		shareBasis: 'withAttributedBuffs',
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
/** DCC day index of a timestamp (ms): the shared F.dayIndex (the streak and the daily quest share it). */
const dayIndex = (ms, startUtcHour = PARAMS.day.startUtcHour) => F.dayIndex(ms, startUtcHour);

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
const BUFF_NAMES = BUFF_CATALOG.map((b) => b.name);

/** Proposed Gacha V2 definitions (engine format; `fish: 'highestUnlocked'` and `fishShare` are new pool options). */
function boxDefinitions() {
	const P = PARAMS.pool;
	const exclude = [...ITEMS.filter((i) => isPart(i) && rIdx(i.rarity) > rIdx(P.maxPartRarity)).map((i) => i.name), ...P.excludeBuffs];
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

/** The legacy Voter's Crate as defined in src (kept forever), plus the proposed Old Rod exclusion. */
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

/** A profile name ('normal' | 'founder': today's balance.js PROFILES) or a profile object. */
const profileOf = (profile) => (typeof profile === 'string' ? PROFILES[profile] : profile);
const profileLabel = (profile) => (typeof profile === 'string' ? profile : profile.name || 'custom');
/** The Founder profile (founder.founderProfile(): the stealth-hybrid, or the run's profile inside an integrated run; loaded lazily). */
const proposedFounder = () => require('./founder').founderProfile();

/**
 * Exact expected contents of one open. Mirrors gacha.openLine: base table restricted to rarities with
 * rewards, rarity floor, profile gacha stats (buildTable), per-slot guarantees; within a rarity the kind
 * is fish with probability fishShare (when both kinds exist), then uniform (no featured weights).
 * Pity is not modelled (Founder only; it can only raise Founder's figures). `profile` is a name (today's
 * balance.js profile; buffs.js relies on that) or a profile object (e.g. the proposed Founder profile).
 */
function boxEV(box, { level = 0, profile = 'normal' } = {}) {
	const def = typeof box === 'string' ? (boxDefinitions()[box] || (box === 'Voter\'s Crate' ? legacyVotersCrate() : null)) : box;
	if (!def) throw new Error(`Unknown box ${box}`);
	const prof = profileOf(profile);
	if (!prof) throw new Error(`Unknown profile ${profile}`);
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
		profile: profileLabel(profile),
		biome: def.pool.fish === 'highestUnlocked' ? F.biomeAt(level) : 'all live biomes',
		slotTables: slots,
		...acc,
		liquid: acc.fishValue + acc.salvage,
	};
}

const contentsCache = new Map();
/**
 * Non-buff contents of one open of `box` at `level` by `profile` ('normal' | 'founder'), as the streak
 * system books them: fish at sale value, parts at salvage, bait packs usable at `level` at their pack
 * price. 'founder' is the Founder profile (founder.founderProfile(); founder.founderBoxEV(): its gacha stats on
 * non-buff slots only under the hybrid, its sell multiplier). Buffs are counted here but valued by the buffs
 * system (counting rule).
 */
function boxContents(box, level, profile = 'normal') {
	const usable = Object.values(bait.prices()).filter((q) => q.levelRequirement <= level).length;
	const FO = profile === 'founder' ? require('./founder') : null;
	const prof = FO ? FO.founderProfile() : null;
	const key = `${box}|${F.biomeAt(level)}|${usable}|${profile}${FO ? `|${FO.boxProfileKey(prof)}` : ''}`;
	if (!contentsCache.has(key)) {
		const ev = FO ? FO.founderBoxEV(box, { level, profile: prof }) : boxEV(box, { level, profile: 'normal' });
		contentsCache.set(key, deepFreeze({
			box, biome: ev.biome, profile,
			fish: ev.fishValue, salvage: ev.salvage, baitUsable: ev.baitUsable, baitDeferred: ev.baitDeferred,
			liquid: ev.fishValue + ev.salvage,
			cashEquivalent: ev.fishValue + ev.salvage + ev.baitUsable,
			items: { fish: ev.fish, parts: sumValues(ev.partsByRarity), baitPacks: sumValues(ev.baitPacks), buffs: sumValues(ev.buffs) },
			buffs: { ...ev.buffs },
		}));
	}
	return contentsCache.get(key);
}

/** The box of streak day `day` at `level`: what the streak system books (no XP: P-STREAK-NO-CASH-XP). */
function streakValue(day, level, { profile = 'normal' } = {}) {
	const box = boxForDay(day);
	const v = boxContents(box, level, profile);
	return { day, level, box, cashEquivalent: v.cashEquivalent, xp: 0, buffs: { ...v.buffs }, items: { ...v.items }, breakdown: { fish: v.fish, salvage: v.salvage, baitUsable: v.baitUsable, baitDeferred: v.baitDeferred, liquid: v.liquid } };
}

/** Average per claimed day over one ladder cycle (cycle-1 crates + 1 chest). */
function perClaimValue(level, opts = {}) {
	const n = PARAMS.ladder.cycle;
	const vals = Array.from({ length: n }, (_, i) => streakValue(i + 1, level, opts));
	const avg = (f) => vals.reduce((s, v) => s + f(v), 0) / n;
	return {
		cashEquivalent: avg((v) => v.cashEquivalent),
		liquid: avg((v) => v.breakdown.liquid),
		fish: avg((v) => v.breakdown.fish),
		salvage: avg((v) => v.breakdown.salvage),
		baitUsable: avg((v) => v.breakdown.baitUsable),
		fishCount: avg((v) => v.items.fish),
		parts: avg((v) => v.items.parts),
		baitPacks: avg((v) => v.items.baitPacks),
		buffs: avg((v) => v.items.buffs),
		buffsByName: Object.fromEntries(BUFF_NAMES.map((b) => [b, avg((v) => v.buffs[b] || 0)])),
	};
}

// ---------------------------------------------------------------------------------------------
// Stage rates (the same castOutcome/hourly call the core makes for the reference loop's base fishing).
const rateCache = new Map();
/** Cache key of a gear tier by content. */
const tierKey = (tier) => JSON.stringify([tier.qualities, tier.stats, tier.meanFish, tier.multiChance ?? null]);
function rates(biome, tier, overheadS) {
	const key = `${biome}|${tierKey(tier)}|${overheadS}`;
	if (!rateCache.has(key)) {
		const o = F.castOutcome({ biome, qualities: tier.qualities, stats: tier.stats, multiChance: tier.multiChance ?? F.chanceForMean(tier.meanFish) });
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

/** Minutes a player needs for the gate at the Old Rod's cooldown and an overhead. */
const gateMinutes = (overheadS) => (PARAMS.gate.successfulCasts * (F.COOLDOWN.fishMs / 1000 + overheadS)) / 60;
/**
 * The gate's casts at the reference cadence as a fixed session ({ minutesPerDay, overheadS }). Kept for
 * the gate table and buffs.js; the R2 adversary itself is F.MINIMUM_DAILY on the shared core, which plays
 * each day until every system's daily minimum is met (here the streak gate and the daily quest).
 */
function minimumDailyArchetype() {
	return { minutesPerDay: gateMinutes(F.DESIGN_OVERHEAD_S), overheadS: F.DESIGN_OVERHEAD_S };
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
	return { referenceLevel: refLevel, crateLiquid: crate, chestLiquid: chest, chestToCrate: chest / crate, proposed: mk(PARAMS), moreGrace: { rules: alt.grace, rows: mk(alt) } };
}

// ---------------------------------------------------------------------------------------------
// The streak SYSTEM on the shared lifecycle core (lifecycle.js); integrate.js runs it in the reference loop.
const SYSTEM_NAME = 'streak';
/** The streak's only ledger entry: cash source 'streak' (box contents without buffs). No XP, no spend. */
const CASH_SOURCE = 'streak';
// The buffs system's ledger sources (buffs.js BUFF_SOURCE / LUCKY_SOURCE), read for attribution only.
const BUFF_XP_SOURCE = 'buff';
const LUCKY_SOURCE = 'luckyDraw';
const CREDIT_MODES = ['gate', 'dayEnd'];
const BAIT_VALUES = ['cash', 'items'];
// Float tolerance on the gate (whole steps of casts reach the gate up to rounding).
const GATE_EPS = 1e-9;

/**
 * The streak SYSTEM (lifecycle.js hooks). Per-run state lives in state.sys.streak only.
 *   onDayEnd     credit 'dayEnd' (default): when today's casts (state.castsToday) reached the play gate
 *                (PARAMS.gate.successfulCasts), the streak day is credited (advanceStreak) and its box
 *                granted at day end, valued at the level the day's last step started at. The engine credits
 *                on the qualifying cast; the model's player opens the box after the session. An attended
 *                day below the gate is a miss.
 *   onCasts      credit 'gate' (option; the engine's timing): the step whose casts reach the gate credits
 *                the day and grants the box at once, valued at that step's level (creditTiming()).
 *   onMissedDay  a calendar day not attended (daysPerWeek < 7) is a miss.
 *                Misses are settled by the engine rule when the next streak day is credited (advanceStreak
 *                -> applyGap): grace tokens first, then PARAMS.decay.perUncoveredMiss streak days per
 *                uncovered miss, a reset after PARAMS.decay.resetAfterMissedDays in a row (tokens kept).
 *   grant        a Streak Crate, or the Streak Chest on every PARAMS.ladder.cycle-th streak day (+ a grace
 *                token): its NON-BUFF contents (boxContents) as cash source 'streak', and
 *                emit('box', { name, count: 1, level, source: 'streak', streakDay, profile }) so the buffs
 *                system values its buffs (counting rule). No direct XP, no purchases, no spend.
 *   sessionDone  today's casts >= the play gate (the R2 minimum-daily player stops there at the earliest).
 * Profile: state.profile 'founder' (set by the founder system) values the box with the Founder profile
 * (founder.founderProfile(): the run's; founder.founderBoxEV(): gacha stats, sell multiplier); the gate is the same for every profile (casts, not fish).
 * Successful casts: every modelled cast lands at least one draw; a cast whose every draw is an item
 * (P ~ itemPerDraw, under 0.1%) is counted as successful (the gate is met at most one step later).
 * @param {object} opts { credit: 'dayEnd' (default) | 'gate', baitValue: 'cash' (default: usable packs
 *   at pack price) | 'items' (packs tallied only; cash = fish + salvage) }
 */
function system(opts = {}) {
	const { credit = 'dayEnd', baitValue = 'cash' } = opts;
	if (!CREDIT_MODES.includes(credit)) throw new Error(`Unknown streak credit mode ${credit}`);
	if (!BAIT_VALUES.includes(baitValue)) throw new Error(`Unknown streak baitValue ${baitValue}`);
	const gateMet = (state) => state.castsToday >= PARAMS.gate.successfulCasts - GATE_EPS;
	const own = (state) => state.sys[SYSTEM_NAME];
	function grant(state, ctx) {
		const s = own(state);
		if (s.streak.lastDay === state.day) return;
		const r = advanceStreak(s.streak, state.day);
		if (!r.credited) return;
		s.streak = r.state;
		const level = state.stepStartLevel;
		const profile = state.profile === 'founder' ? 'founder' : 'normal';
		const v = boxContents(r.box, level, profile);
		const cash = baitValue === 'cash' ? v.cashEquivalent : v.liquid;
		ctx.addCash(CASH_SOURCE, cash);
		s.credits++;
		if (r.box === PARAMS.ladder.milestoneBox) s.chests++;
		else s.crates++;
		s.graceUsed += r.graceUsed;
		if (r.reset) s.resets++;
		else if (r.decayedBy > 0) s.decays++;
		s.daysDecayed += r.decayedBy;
		for (const b of r.badges) s.badges.push({ badge: b, day: state.day + 1 });
		for (const k of ['fish', 'salvage', 'baitUsable', 'baitDeferred']) s.value[k] += v[k];
		s.value.cash += cash;
		for (const k of Object.keys(s.items)) s.items[k] += v.items[k];
		for (const [n, q] of Object.entries(v.buffs)) s.buffs[n] = (s.buffs[n] || 0) + q;
		s.last = { day: state.day + 1, hours: +state.h.toFixed(4), streakDay: r.streakDay, box: r.box, level, cash };
		ctx.emit('box', { name: r.box, count: 1, level, source: SYSTEM_NAME, streakDay: r.streakDay, profile });
	}
	return {
		name: SYSTEM_NAME,
		init(state) {
			state.sys[SYSTEM_NAME] = {
				credit, baitValue, streak: defaultState(),
				credits: 0, crates: 0, chests: 0, graceUsed: 0, decays: 0, daysDecayed: 0, resets: 0, badges: [],
				missedDays: 0, belowGateDays: 0, last: null,
				value: { fish: 0, salvage: 0, baitUsable: 0, baitDeferred: 0, cash: 0 },
				items: { fish: 0, parts: 0, baitPacks: 0, buffs: 0 },
				buffs: {},
			};
		},
		onCasts(state, ctx) {
			if (credit === 'gate' && gateMet(state)) grant(state, ctx);
		},
		onDayEnd(state, ctx) {
			if (credit === 'dayEnd' && gateMet(state)) grant(state, ctx);
			if (own(state).streak.lastDay !== state.day) own(state).belowGateDays++;
		},
		onMissedDay(state) {
			own(state).missedDays++;
		},
		sessionDone(state) {
			return gateMet(state);
		},
	};
}

// ---------------------------------------------------------------------------------------------
// Integrated runs. The reference loop of integrate.js (rods, world, quests, streak, buffs) with an
// observational recorder appended last: it snapshots the ledgers and the streak/buffs figures at each
// milestone (on 'levelUp', the moment the core records the milestone) and at calendar checkpoints (day
// end). It writes nothing, so the run is integrate.run()'s run (recorderParity() checks it every report).
const RECORDER = 'streakRecorder';
function recorder({ checkpoints = [] } = {}) {
	const snap = (state) => ({
		hours: state.h,
		day: state.day + 1,
		ledger: clone(state.ledger),
		streak: state.sys[SYSTEM_NAME] ? clone(state.sys[SYSTEM_NAME]) : null,
		buffs: state.sys.buffs ? clone({ received: state.sys.buffs.received, receivedBySource: state.sys.buffs.receivedBySource, valueBySource: state.sys.buffs.valueBySource }) : null,
	});
	return {
		name: RECORDER,
		init(state) {
			state.sys[RECORDER] = { milestones: {}, days: {} };
		},
		on(event, payload, state) {
			if (event !== 'levelUp' || payload.kind !== 'real') return;
			const r = state.sys[RECORDER];
			for (const T of Object.keys(state.milestones)) if (!(T in r.milestones)) r.milestones[T] = snap(state);
		},
		onDayEnd(state) {
			if (checkpoints.includes(state.day + 1)) state.sys[RECORDER].days[state.day + 1] = snap(state);
		},
	};
}

const ARCHETYPE_NAMES = Object.keys(F.ARCHETYPES);
const MINIMUM_DAILY = F.MINIMUM_DAILY.name;
/** Value periods (calendar days) and the R2 calendar checkpoints (weeks 1, 4, 13, 26, 52). */
const PERIODS = [7, 30, 90];
const R2_DAYS = [1, 4, 13, 26, 52].map((w) => 7 * w);
const R2_LEVELS = Object.keys(F.TARGET_WINDOWS).map(Number);
const CHECKPOINTS = [...new Set([...PERIODS, ...R2_DAYS])].sort((a, b) => a - b);
// Calendar horizon of a default run: a year for the casual and minimum-daily players (the R2 calendar
// comparison); for the others the value periods, which already contain their last milestone
// (checks(): 'milestones-covered').
const VALUE_HORIZON_DAYS = 120;
const horizon = (a) => (a === 'casual' || a === MINIMUM_DAILY ? R2_DAYS[R2_DAYS.length - 1] : VALUE_HORIZON_DAYS);

const runCache = new Map();
/**
 * One integrated lifecycle: integrate.js's reference systems (I.REFERENCE minus `exclude`, each built by
 * I.systemOf with `systemOpts[name]`) plus the recorder, on LC.simulate with the gate on the real level
 * (the reference loop; the Founder variant goes through integrate.run directly). Cached.
 */
function integratedRun(archetype, { exclude = [], systemOpts = {}, days = horizon(archetype), stopAtLevel = null, checkpoints = CHECKPOINTS } = {}) {
	const key = JSON.stringify([archetype, exclude, systemOpts, days, stopAtLevel, checkpoints]);
	if (!runCache.has(key)) {
		const names = I.REFERENCE.filter((n) => !exclude.includes(n));
		const systems = [...names.map((n) => I.systemOf(n, systemOpts[n] || {})), recorder({ checkpoints })];
		const result = LC.simulate({ archetype, systems, days, stopAtLevel, checkpoints, gate: 'real' });
		runCache.set(key, { ...result, systems: names, exclude, ...F.stamp() });
	}
	return runCache.get(key);
}

// R2 groups of XP ledger sources (as r2.js); the buffs system's XP is split into the streak's share
// (Double XP from streak boxes: its valueBySource.streak) and the rest.
const XP_GROUPS = { fishing: ['fishing'], quests: ['story', 'repeatable'], daily: ['daily', 'weekly'], buffs: [BUFF_XP_SOURCE] };
const pick = (o, keys) => keys.reduce((a, k) => a + (o[k] || 0), 0);

/**
 * The streak's figures in a recorder snapshot (or a run's final state): XP by group, cash by source,
 * the streak's own contents, and the buffs system's value of the streak's buffs. Lucky Draw value is
 * attributed pro rata to the Lucky Draw units received (the buffs system does not split it by source).
 */
function figures(snap) {
	const { xp, cash } = snap.ledger;
	const st = snap.streak;
	const b = snap.buffs;
	const own = b?.valueBySource?.[SYSTEM_NAME] || { doubleXpXp: 0, doubleCash: 0 };
	const ldAll = b?.received?.['Lucky Draw'] || 0;
	const ldOwn = b?.receivedBySource?.[SYSTEM_NAME]?.['Lucky Draw'] || 0;
	const xpTotal = sumValues(xp);
	const nonBuff = cash[CASH_SOURCE] || 0;
	const fishing = cash.fishing || 0;
	return {
		xpTotal,
		xpBy: {
			fishing: pick(xp, XP_GROUPS.fishing), quests: pick(xp, XP_GROUPS.quests), daily: pick(xp, XP_GROUPS.daily),
			streak: own.doubleXpXp, buffsOther: pick(xp, XP_GROUPS.buffs) - own.doubleXpXp,
			other: xpTotal - pick(xp, Object.values(XP_GROUPS).flat()),
		},
		cashBy: { fishing, streak: nonBuff + own.doubleCash, other: sumValues(cash) - fishing - nonBuff - own.doubleCash },
		streakBy: {
			fish: st?.value.fish || 0, salvage: st?.value.salvage || 0, baitUsable: st?.value.baitUsable || 0, baitDeferred: st?.value.baitDeferred || 0,
			nonBuff, doubleCash: own.doubleCash, luckyDrawAttributed: ldAll > 0 ? ((cash[LUCKY_SOURCE] || 0) * ldOwn) / ldAll : 0,
		},
		items: { crates: st?.crates || 0, chests: st?.chests || 0, ...(st?.items || { fish: 0, parts: 0, baitPacks: 0, buffs: 0 }) },
		credits: st?.credits || 0,
	};
}
/** Streak value on the checked basis (PARAMS.targets.shareBasis): box contents + attributed buff cash. */
const checkedValue = (f) => f.cashBy.streak + f.streakBy.luckyDrawAttributed;
const finalSnap = (run) => ({ hours: run.hours, day: run.days, ledger: run.ledger, streak: run.sys[SYSTEM_NAME] || null, buffs: run.sys.buffs || null });
const dayRow = (run, d) => {
	const t = run.timeline.find((x) => x.day === d);
	const s = run.sys[RECORDER].days[d];
	return t && s ? { level: t.level, hours: s.hours, ...figures(s) } : null;
};
const milestoneHours = (run) => Object.fromEntries(Object.entries(run.milestones).filter(([k]) => /^\d+$/.test(k)).map(([k, v]) => [k, v.hours]));

/**
 * integratedRun() in the design-stage lifecycle() shape (buffs.js reads it): reached / at / snapshots /
 * final with xpBy, cashBy, streakBy and items (figures()). opts: streak (false: exclude the streak),
 * dailyXp (false: exclude the quests system), maxDays, maxLevel, snapshots (calendar days).
 */
function lifecycle(archetype, { streak = true, dailyXp = true, maxDays = Infinity, maxLevel = F.LIFECYCLE.maxLevel, snapshots = PERIODS } = {}) {
	const exclude = [...(streak ? [] : [SYSTEM_NAME]), ...(dailyXp ? [] : ['quests'])];
	const stopAtLevel = Number.isFinite(maxLevel) ? maxLevel : null;
	const days = Number.isFinite(maxDays) ? maxDays : stopAtLevel === null ? horizon(archetype) : 3650;
	const run = integratedRun(archetype, { exclude, days, stopAtLevel, checkpoints: snapshots });
	const rec = run.sys[RECORDER];
	const levels = Object.keys(run.milestones).filter((T) => /^\d+$/.test(T) && rec.milestones[T]);
	const view = (s, level) => ({ level, hours: round(s.hours, 3), ...figures(s) });
	return {
		archetype: run.archetype,
		model: I.REFERENCE_NOTE,
		systems: run.systems,
		reached: Object.fromEntries(levels.map((T) => [T, { hours: run.milestones[T].hours, day: run.milestones[T].day }])),
		at: Object.fromEntries(levels.map((T) => [T, view(rec.milestones[T], Number(T))])),
		snapshots: Object.fromEntries(Object.keys(rec.days).map((d) => [d, view(rec.days[d], run.timeline.find((t) => t.day === Number(d))?.level)])),
		final: view(finalSnap(run), run.final.level),
		days: run.days,
		frameworkVersion: run.frameworkVersion,
		sharedDigest: run.sharedDigest,
	};
}

/**
 * recorderParity(): every default integratedRun() equals integrate.run() with the same archetype, horizon and
 * checkpoints (milestone hours, timeline and every ledger entry identical): the recorder only observes.
 */
let parityCache = null;
function recorderParity() {
	if (parityCache) return parityCache;
	const rows = {};
	for (const a of [...ARCHETYPE_NAMES, MINIMUM_DAILY]) {
		const mine = integratedRun(a);
		const ref = I.run({ archetype: a, stopAtLevel: null, days: horizon(a), checkpoints: CHECKPOINTS });
		rows[a] = {
			milestones: Object.keys(milestoneHours(ref)).length,
			milestoneHours: JSON.stringify(milestoneHours(mine)) === JSON.stringify(milestoneHours(ref)),
			timeline: JSON.stringify(mine.timeline) === JSON.stringify(ref.timeline),
			ledger: JSON.stringify(mine.ledger) === JSON.stringify(ref.ledger),
		};
	}
	parityCache = { rows, exact: Object.values(rows).every((r) => r.milestoneHours && r.timeline && r.ledger) };
	return parityCache;
}

// ---------------------------------------------------------------------------------------------
// Value per archetype vs fishing income: integrated periods, plus the static per-stage view.
let avCache = null;
function archetypeValue() {
	if (avCache) return avCache;
	const out = {};
	for (const name of ARCHETYPE_NAMES) {
		const arch = F.ARCHETYPES[name];
		const run = integratedRun(name);
		const row = { minutesPerDay: arch.minutesPerDay, periods: {} };
		for (const d of PERIODS) {
			const s = dayRow(run, d);
			if (!s) continue;
			row.periods[d] = {
				level: s.level,
				hours: s.hours,
				fishingIncome: s.cashBy.fishing,
				boxContents: s.streakBy.nonBuff,
				doubleCash: s.streakBy.doubleCash,
				streakValue: s.cashBy.streak,
				streakShareOfFishing: s.cashBy.streak / s.cashBy.fishing,
				streakPerDay: s.cashBy.streak / d,
				doubleCashShareOfStreak: s.streakBy.doubleCash / s.cashBy.streak,
				luckyDrawAttributed: s.streakBy.luckyDrawAttributed,
				withLuckyDrawShareOfFishing: (s.cashBy.streak + s.streakBy.luckyDrawAttributed) / s.cashBy.fishing,
				// The checked basis (PARAMS.targets.shareBasis): box contents + every attributed buff's cash.
				attributedBuffCash: s.streakBy.doubleCash + s.streakBy.luckyDrawAttributed,
				checkedValue: checkedValue(s),
				checkedShareOfFishing: checkedValue(s) / s.cashBy.fishing,
				streakXpShare: s.xpBy.streak / s.xpTotal,
				items: s.items,
				credits: s.credits,
			};
		}
		// Per claimed day at fixed levels: the start of each biome (box contents only; static stage rates).
		row.byLevel = F.LIVE_BIOMES.map((b) => {
			const L = F.BIOME_LEVEL[b];
			const r = stageRates(L, { archetype: arch, tier: F.typicalTier(b) });
			const v = perClaimValue(L);
			const fishingPerDay = r.cash * (arch.minutesPerDay / 60);
			return { biome: b, level: L, tier: F.typicalTier(b).key, streakPerDay: v.cashEquivalent, fishingPerDay, share: v.cashEquivalent / fishingPerDay, minutesOfOwnPlay: (v.cashEquivalent / r.cash) * 60 };
		});
		out[name] = row;
	}
	avCache = out;
	return out;
}

// ---------------------------------------------------------------------------------------------
// R2 on the integrated model: XP-source decomposition with the streak's share, the minimum-daily player
// (F.MINIMUM_DAILY) against the casual player, and the no-miss grinder with and without the streak.
function decomposition(run) {
	const rec = run.sys[RECORDER];
	return Object.fromEntries(R2_LEVELS.filter((T) => run.milestones[T] && rec.milestones[T]).map((T) => {
		const f = figures(rec.milestones[T]);
		return [T, {
			hours: run.milestones[T].hours,
			day: run.milestones[T].day,
			xpTotal: f.xpTotal,
			xp: f.xpBy,
			share: Object.fromEntries(Object.entries(f.xpBy).map(([k, v]) => [k, v / f.xpTotal])),
		}];
	}));
}

let r2Cache = null;
function r2() {
	if (r2Cache) return r2Cache;
	const archetypes = {};
	for (const name of ARCHETYPE_NAMES) {
		const on = integratedRun(name);
		const off = integratedRun(name, { exclude: [SYSTEM_NAME] });
		const hOn = milestoneHours(on);
		const hOff = milestoneHours(off);
		const common = Object.keys(hOff).filter((k) => k in hOn);
		archetypes[name] = {
			decomposition: decomposition(on),
			hoursWithoutStreak: hOff,
			hoursWithStreak: hOn,
			maxHoursDelta: Math.max(...common.map((k) => Math.abs(hOn[k] - hOff[k]) / hOff[k])),
		};
	}
	// Minimum-daily vs casual by calendar week. 'streakOnly': the quests system excluded, so the minimum-
	// daily session ends at the streak gate (isolates this subsystem). 'reference': the whole reference loop
	// (the session ends when the streak gate AND the daily quest are met).
	const scenario = (exclude) => {
		const md = integratedRun(MINIMUM_DAILY, { exclude });
		const cas = integratedRun('casual', { exclude });
		const side = (run, d) => {
			const s = dayRow(run, d);
			return { level: s.level, hours: s.hours, xpPerActiveHour: s.xpTotal / s.hours, xpPerDay: s.xpTotal / d, streakXpShare: s.xpBy.streak / s.xpTotal, streakCashPerDay: s.cashBy.streak / d, streakCashPerActiveHour: s.cashBy.streak / s.hours, streakShareOfIncome: s.cashBy.streak / (s.cashBy.fishing + s.cashBy.streak), credits: s.credits };
		};
		const rows = R2_DAYS.map((d) => {
			const m = side(md, d);
			const c = side(cas, d);
			return { day: d, minimumDaily: m, casual: c, minimumDailyLeadsInLevel: m.level > c.level };
		});
		const st = md.sys[SYSTEM_NAME];
		return { exclude, rows, leadsAnywhere: rows.some((r) => r.minimumDailyLeadsInLevel), minutesPerDay: (md.hours * 60) / md.days, credited: st.credits, belowGateDays: st.belowGateDays, days: md.days };
	};
	const minimumDaily = { archetype: F.MINIMUM_DAILY, gateCasts: PARAMS.gate.successfulCasts, streakOnly: scenario(['quests']), reference: scenario([]) };
	minimumDaily.verdict = !minimumDaily.streakOnly.leadsAnywhere && !minimumDaily.reference.leadsAnywhere
		? 'PASS: the minimum-daily player never leads the casual player in level at any calendar checkpoint, with the streak alone or with the whole reference loop. The streak adds no direct XP, so its only XP (Double XP buffs) scales with real play.'
		: 'FAIL: the minimum-daily player leads the casual player in level; add a guardrail.';
	// No-miss grinder: every streak reward on top of grinding.
	const g = archetypes.grinder;
	const reg = archetypes.regular.hoursWithStreak;
	const noMissGrinder = {
		hoursWithoutStreak: g.hoursWithoutStreak,
		hoursWithStreak: g.hoursWithStreak,
		maxHoursDelta: g.maxHoursDelta,
		regularHours: Object.fromEntries(Object.keys(F.TARGET_WINDOWS).map((L) => [L, reg[L]])),
		regularStillInWindows: Object.entries(F.TARGET_WINDOWS).every(([L, [lo, hi]]) => reg[L] >= lo && reg[L] <= hi),
	};
	noMissGrinder.verdict = noMissGrinder.maxHoursDelta <= PARAMS.targets.grinderHoursDeltaMax && noMissGrinder.regularStillInWindows
		? `PASS: stacking every streak reward on grinding moves the grinder's milestones by at most ${(100 * noMissGrinder.maxHoursDelta).toFixed(2)}%, and the regular player stays inside every approved window.`
		: 'FAIL: the streak moves milestones materially; cap the buff source.';
	r2Cache = { model: I.REFERENCE_NOTE, archetypes, minimumDaily, noMissGrinder };
	return r2Cache;
}

// ---------------------------------------------------------------------------------------------
// Rods interplay: days of streak drops to complete the T1 reference set (one Uncommon part per slot).
// The integrated model books streak parts at salvage (counting rule); a completed set saving the T1
// assembly is an upside the lifecycle does not count.
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
	// Calendar day each archetype reaches the Tier 1 level (integrated reference loop).
	const daysToTier1 = Object.fromEntries(ARCHETYPE_NAMES.map((k) => [k, integratedRun(k).milestones[t1.level].day]));
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
// Top.gg today vs the proposed streak (30 days).
function topggComparison() {
	const players = SIMULATION.players;
	const today = {};
	for (const name of ARCHETYPE_NAMES) {
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
	// The same Top.gg rule under the new value model, against the integrated 30-day lifecycle.
	const proposed = {};
	for (const name of Object.keys(today)) {
		const s = dayRow(integratedRun(name), 30);
		const voters = boxEV(legacyVotersCrate(), { level: s.level });
		const topgg30 = 30 * today[name].votesPerDay * (today[name].cashPerVote + voters.liquid + voters.baitUsable);
		proposed[name] = {
			level30: s.level,
			fishing30d: s.cashBy.fishing,
			topggRule30d: topgg30,
			topggShareOfFishing: topgg30 / s.cashBy.fishing,
			streak30d: checkedValue(s),
			streakShareOfFishing: checkedValue(s) / s.cashBy.fishing,
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
		return { label, start: { ...defaultState(), ...start }, steps };
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
// Founder: the Founder profile (founder.founderProfile(), the stealth-hybrid) on the same boxes, opened by
// founder.founderBoxEV() (the hybrid's gacha luck on non-buff slots only). The sell multiplier is private (it
// only changes what the contents sell for); the gacha stats change which rarities are rolled on non-buff slots.
// The reveal table measures what an /open reply would show if it were public.
function founderView() {
	const prof = proposedFounder();
	const fBox = (box, level) => require('./founder').founderBoxEV(box, { level, profile: prof });
	const hi = (ev) => (ev.rarity.legendary || 0) + (ev.rarity.lucky || 0);
	// P(an open shows at least one Legendary/Lucky slot): what the public reveal can show.
	const pHi = (ev) => 1 - ev.slotTables.reduce((a, t) => a * (1 - ((t.legendary || 0) + (t.lucky || 0))), 1);
	const revealLevel = F.gearPath()[1].level;
	const reveal = (box) => {
		const nv = pHi(boxEV(box, { level: revealLevel }));
		const fv = pHi(fBox(box, revealLevel));
		return { normal: nv, founder: fv, ratio: fv / nv };
	};
	const crateR = reveal(PARAMS.ladder.dailyBox);
	const chestR = reveal(PARAMS.ladder.milestoneBox);
	const cycleDays = PARAMS.ladder.cycle;
	const cycle = (k) => 1 - (1 - crateR[k]) ** (cycleDays - 1) * (1 - chestR[k]);
	const pity = prof.gacha?.pity?.legendaryPlus || null;
	// Do the reveal odds depend on the stage? (the pools of some stages may lack a rarity)
	const byStage = F.LIVE_BIOMES.map((b) => [PARAMS.ladder.dailyBox, PARAMS.ladder.milestoneBox].map((box) => [boxEV(box, { level: F.BIOME_LEVEL[b] }), fBox(box, F.BIOME_LEVEL[b])].map(pHi))).flat(2);
	const ref = [crateR.normal, crateR.founder, chestR.normal, chestR.founder];
	const sameAtEveryStage = byStage.every((x, i) => Math.abs(x - ref[i % 4]) < 1e-9);
	return {
		profile: { source: 'founder.founderProfile()', variant: prof.variant || null, buffSlots: prof.gacha?.buffSlots || 'luck', sell: prof.multipliers.sell, gachaStats: { ...(prof.gacha?.stats || {}) }, todaySell: PROFILES.founder.multipliers.sell, gachaPity: pity ? { softStart: pity.softStart, hard: pity.hard } : null },
		reveal: {
			level: revealLevel,
			crate: crateR,
			chest: chestR,
			cycle: { normal: cycle('normal'), founder: cycle('founder'), ratio: cycle('founder') / cycle('normal') },
			sameAtEveryStage,
			surface: '/open (public reply; every slot\'s rarity, Legendary/Lucky marked)',
		},
		stages: F.LIVE_BIOMES.map((b) => {
			const L = F.BIOME_LEVEL[b];
			const n = boxEV(PARAMS.ladder.dailyBox, { level: L });
			const f = fBox(PARAMS.ladder.dailyBox, L);
			const nc = boxEV(PARAMS.ladder.milestoneBox, { level: L });
			const fc = fBox(PARAMS.ladder.milestoneBox, L);
			return {
				biome: b,
				level: L,
				crate: { normal: n.liquid, founder: f.liquid, ratio: f.liquid / n.liquid, normalLegendaryPlus: hi(n), founderLegendaryPlus: hi(f) },
				chest: { normal: nc.liquid, founder: fc.liquid, ratio: fc.liquid / nc.liquid },
			};
		}),
	};
}

// ---------------------------------------------------------------------------------------------
// Quests interplay: does completing the daily quest also meet the streak gate? (quests.templateTerms at
// each band: fish required, and casts at the band's gear.)
function questInterplay() {
	const quests = require('./quests');
	const [catchT, rareT] = quests.PARAMS.daily.templates;
	return quests.bands().map((band) => {
		const c = quests.templateTerms('daily', catchT, band);
		const r = quests.templateTerms('daily', rareT, band);
		const fpc = F.castOutcome({ biome: band.biome, qualities: band.gear.qualities, stats: band.gear.stats, multiChance: band.gear.multiChance ?? F.chanceForMean(band.gear.meanFish) }).fishPerCast;
		const catchCasts = c.progressMax / fpc;
		const rareCastsP50 = r.fish.p50 / fpc;
		return { band: band.id, biome: band.biome, fishPerCast: fpc, catchFish: c.progressMax, catchCasts, rareTarget: r.progressMax, rareFishP50: r.fish.p50, rareCastsP50, catchMeetsGate: catchCasts >= PARAMS.gate.successfulCasts - GATE_EPS, rareP50MeetsGate: rareCastsP50 >= PARAMS.gate.successfulCasts - GATE_EPS };
	});
}

// ---------------------------------------------------------------------------------------------
// Credit timing sensitivity on the integrated model: credit 'gate' (the engine: the box on the qualifying
// cast) vs the default 'dayEnd' (the player opens the box after the session).
function creditTiming() {
	const rows = {};
	for (const name of ARCHETYPE_NAMES) {
		const a = integratedRun(name);
		const b = integratedRun(name, { systemOpts: { [SYSTEM_NAME]: { credit: 'gate' } } });
		const ha = milestoneHours(a);
		const hb = milestoneHours(b);
		const common = Object.keys(ha).filter((k) => k in hb);
		const d30 = [dayRow(a, 30), dayRow(b, 30)];
		rows[name] = {
			maxMilestoneShift: Math.max(...common.map((k) => Math.abs(hb[k] - ha[k]) / ha[k])),
			streakValue30dChange: d30[1].cashBy.streak / d30[0].cashBy.streak - 1,
		};
	}
	return { rows, maxMilestoneShift: Math.max(...Object.values(rows).map((r) => r.maxMilestoneShift)), maxStreakValueChange: Math.max(...Object.values(rows).map((r) => Math.abs(r.streakValue30dChange))) };
}

// ---------------------------------------------------------------------------------------------
// Parity of system() with the retired private loop. RECORDED, not live: streak.validateSystem() at
// framework 5b.4 on the code of commit a83b5f0 (the loop, its replication checks and the validation
// were deleted in the final migration stage; this constant is the record the doc cites).
const SYSTEM_PARITY = deepFreeze({
	source: 'streak.validateSystem() at framework 5b.4, code of commit a83b5f0',
	method: 'LC.simulate with streak.system() + LC.provisionalRods() + LC.provisionalDaily() + a validation-only replay of the old buff valuation, vs the retired streak.lifecycle() and streak.r2(), every archetype; hours compared step-exact',
	archetypes: { exactMilestoneHours: '24/24', maxRelativeDifference: 0, scope: 'every XP, cash, breakdown and item total at every milestone and at days 7, 30 and 90' },
	r2: { archetypesAndGrinderMaxRelativeDifference: 0, minimumDailyMaxRelativeDifference: 0.073294, worst: 'minimum-daily streak cash per active hour at week 4 (streak only)', verdicts: { minimumDaily: 'PASS', noMissGrinder: 'PASS' }, sameVerdicts: true },
	replay: { rule: 'requireGate: false', exactMilestoneHours: '24/24', maxRelativeDifference: 0, r2MaxRelativeDifference: 0 },
	minimumDaily: { days: 364, sharedSession: { credited: 364, belowGateDays: 0, chests: 52 }, oldFixedSession: { sessionMinutes: 3, credited: 362, belowGateDays: 2, chests: 51, graceUsed: 2 }, oldLoopCredited: 364 },
	cause: 'the old loop credited every played day without checking the gate',
});

// ---------------------------------------------------------------------------------------------
// Proposed decisions (status 'proposed' only: only the user approves). get() reads what the model runs;
// decisions.verify() checks it against `expected`.
const DECISIONS = [
	{
		id: 'P-STREAK-GATE', status: 'proposed',
		title: 'A streak day is earned by real play: successful casts in the DCC day, credited automatically on the qualifying cast (no claim command)',
		modelled: `${PARAMS.gate.successfulCasts} successful casts (a cast landing at least one fish) per DCC day; casts, not fish`,
		alternatives: ['a /daily claim command (can be forgotten; needs no play)', 'a fish count (multi-catch gear and the Founder profile reach it sooner)', 'minutes played', 'another cast count'],
		source: 'streak design', why: 'a few minutes of real play for every archetype (gate table); identical effort for every rod and profile; nothing to forget',
		get: () => PARAMS.gate, expected: { successfulCasts: 20 },
	},
	{
		id: 'P-STREAK-LADDER', status: 'proposed',
		title: `${PARAMS.ladder.cycle}-day ladder: a Streak Crate every streak day, the Streak Chest (bonus slots, a guaranteed high-rarity slot, a grace token) at the end of each cycle`,
		modelled: `${PARAMS.ladder.dailyBox} (${PARAMS.boxes[PARAMS.ladder.dailyBox].slots} slots) daily; every ${PARAMS.ladder.cycle}th streak day the ${PARAMS.ladder.milestoneBox} (${PARAMS.boxes[PARAMS.ladder.milestoneBox].slots} slots, slot ${PARAMS.boxes[PARAMS.ladder.milestoneBox].guaranteedSlots[0].slot} >= ${PARAMS.boxes[PARAMS.ladder.milestoneBox].guaranteedSlots[0].minRarity})`,
		alternatives: ['a flat daily box with no weekly goal', 'an escalating 1-to-7 ladder that restarts weekly', 'a longer milestone (e.g. 30 days)'],
		source: 'streak design', why: 'a weekly goal with a jackpot slot; the chest is the only consistency bonus, so value stays close to proportional to days played (attendance table)',
		get: () => ({ ladder: PARAMS.ladder, boxes: PARAMS.boxes }),
		expected: { ladder: { cycle: 7, dailyBox: 'Streak Crate', milestoneBox: 'Streak Chest' }, boxes: { 'Streak Crate': { id: 'streak-crate', slots: 3, guaranteedSlots: [] }, 'Streak Chest': { id: 'streak-chest', slots: 5, guaranteedSlots: [{ slot: 0, minRarity: 'ultra' }] } } },
	},
	{
		id: 'P-STREAK-GRACE', status: 'proposed',
		title: 'Grace tokens cover missed days automatically: a starting token, more from each Streak Chest, a small cap',
		modelled: `start ${PARAMS.grace.start}, +${PARAMS.grace.perCycle} per chest, max ${PARAMS.grace.max}`,
		alternatives: [`${PARAMS.alternatives.moreGrace.perCycle} per chest, max ${PARAMS.alternatives.moreGrace.max} (a 5-days-a-week player keeps more chests; attendance table)`, 'no grace tokens'],
		source: 'streak design', why: 'a player who plays six days a week keeps almost all of the daily player\'s value per claim, while the streak still means something (attendance table)',
		get: () => PARAMS.grace, expected: { start: 1, perCycle: 1, max: 2 },
	},
	{
		id: 'P-STREAK-DECAY', status: 'proposed',
		title: 'A miss with no token costs a ladder cycle of streak days (the chest phase is kept); a long gap resets the streak (tokens kept)',
		modelled: `-${PARAMS.decay.perUncoveredMiss} streak days per uncovered miss; reset after ${PARAMS.decay.resetAfterMissedDays} missed days in a row`,
		alternatives: ['reset on any uncovered miss (the classic streak)', 'lose one streak day per miss'],
		source: 'streak design', why: 'one bad day never erases a long streak and the next chest still comes on schedule; consistency still matters (rule traces)',
		get: () => PARAMS.decay, expected: { perUncoveredMiss: 7, resetAfterMissedDays: 7 },
	},
	{
		id: 'P-STREAK-NO-CASH-XP', status: 'proposed',
		title: 'No direct cash and no direct XP: the streak pays only box contents; its only XP is the Double XP buffs in its boxes, valued by the buffs system',
		modelled: `direct cash ${PARAMS.direct.cash}, direct XP ${PARAMS.direct.xp}`,
		alternatives: ['cash per streak day (today\'s vote paid a fixed sum per vote)', 'level-scaled XP per streak day'],
		source: 'streak design', why: 'value scales with progression through the normal sale path, and a minimum-daily player cannot turn a few casts into levels (R2 tables)',
		get: () => PARAMS.direct, expected: { cash: 0, xp: 0 },
	},
	{
		id: 'P-STREAK-FISH-POOL', status: 'proposed',
		title: 'Streak box fish come from the opener\'s highest accessible biome, with a fixed fish share per rarity (two new generic Gacha V2 pool options)',
		modelled: `pool.fish '${PARAMS.pool.fish}' (per-rarity fallback to the next biome down), pool.fishShare ${PARAMS.pool.fishShare}`,
		alternatives: ['fish from every catchable biome (today\'s Voter\'s Crate: a Swamp Giant at Lv 1)', 'no fish (items only)'],
		source: 'streak design', why: 'value tracks the stage and every fish is one the player can already catch; the fixed share keeps a single-biome fish pool from being swamped by items',
		get: () => ({ fish: PARAMS.pool.fish, fishShare: PARAMS.pool.fishShare }), expected: { fish: 'highestUnlocked', fishShare: 0.75 },
	},
	{
		id: 'P-STREAK-ITEM-POOL', status: 'proposed',
		title: 'Streak box items: the Voter\'s Crate pool without the Old Rod, rod parts up to Uncommon, bait, and the Double XP and Double Cash buffs (never a Lucky Draw, never a Booster Pack); the Voter\'s table without Common; unique duplicates',
		modelled: `types ${PARAMS.pool.types.join(', ')}; buffs excluded: ${PARAMS.pool.excludeBuffs.join(', ')} (the Rare item slot is shared uniformly by Double XP, Double Cash and the Rare bait; no cash added); parts <= ${PARAMS.pool.maxPartRarity}; table ${Object.entries(PARAMS.pool.rarityTable).map(([r, w]) => `${r} ${w}`).join(', ')}; floor ${PARAMS.pool.rarityFloor}; duplicates ${PARAMS.pool.duplicates}`,
		alternatives: ['Lucky Draw kept in streak boxes (the earlier proposal: the regular player\'s 30-day streak value then crosses 5% of fishing income once its Lucky Draw rebates are attributed)', 'Double XP / Double Cash per-open odds held at their earlier values by Gacha V2 featured weights (a lower Double Cash rate; not needed for the 5% cap)', 'today\'s Voter\'s pool (Old Rod, parts of every rarity, a Common tier)'],
		source: 'streak design; user decision (Lucky Draw removed from Streak Crates and Streak Chests; it stays a rarer Daily Box / Booster Pack / event reward)', why: 'free rare+ parts would undercut the tiered crates; Booster Packs stay an Easter egg (decision 12); every reward is Uncommon or better. Lucky Draw rebates on tier assemblies were the largest buff value the streak carried, so without it the streak stays a small bonus for engaged players (lifecycle table) and the Lucky Draw keeps its rarity',
		get: () => ({ types: PARAMS.pool.types, excludeBuffs: PARAMS.pool.excludeBuffs, maxPartRarity: PARAMS.pool.maxPartRarity, rarityTable: PARAMS.pool.rarityTable, rarityFloor: PARAMS.pool.rarityFloor, duplicates: PARAMS.pool.duplicates }),
		expected: { types: ['bait', 'buff', 'part_rod', 'part_reel', 'part_hook', 'part_handle'], excludeBuffs: ['Lucky Draw'], maxPartRarity: 'uncommon', rarityTable: { common: 0, uncommon: 2500, rare: 500, ultra: 100, giant: 50, legendary: 20, lucky: 1 }, rarityFloor: 'uncommon', duplicates: 'unique' },
	},
	{
		id: 'P-STREAK-BAIT-PACK', status: 'proposed',
		title: 'A bait reward in a streak box is one pack; packs for bait the player cannot use yet keep until usable',
		modelled: `baitGrant '${PARAMS.baitGrant}'; a pack below its bait's shop level is valued at zero. The wait is enforced by biome access, except for Strong Magnet (every live biome), which needs the bait design's use-time level check`,
		alternatives: ['one unit (worth almost nothing at the new bait prices)'],
		source: 'streak design (bait design recommendation)', why: 'a bait reward should be worth using',
		get: () => PARAMS.baitGrant, expected: 'pack',
	},
	{
		id: 'P-STREAK-VOTE', status: 'proposed',
		title: '/vote retired: an ephemeral notice pointing to the streak for a transition period, then unregistered; TOPGG_TOKEN, the topgg_token config and User.vote() removed',
		modelled: `${PARAMS.topgg.vote}, transition ${PARAMS.topgg.transitionDays} days; no Top.gg network call remains`,
		alternatives: ['unregister /vote at release', 'repurpose /vote for a later cosmetic-only Top.gg reward'],
		source: 'streak design (A-TOPGG)', why: 'retire, do not repurpose: "vote" names an external action that no longer exists; no external dependency or token remains',
		get: () => ({ retire: PARAMS.topgg.retire, vote: PARAMS.topgg.vote, transitionDays: PARAMS.topgg.transitionDays }), expected: { retire: true, vote: 'notice-then-unregister', transitionDays: 30 },
	},
	{
		id: 'P-STREAK-VOTERS-CRATE', status: 'proposed',
		title: 'Owned Voter\'s Crates open forever under their current definition, minus the now-worthless Old Rod reward',
		modelled: 'keep the Voter\'s Crate definition and catalog item (REQUIRED_ITEMS); add exclude: [\'Old Rod\']',
		alternatives: ['keep the definition byte-identical'],
		source: 'streak design (A-TOPGG)', why: 'an extra Old Rod has no value once the Old Rod is unbreakable (P-RODS-OLD-ROD); the definition changes, no data does',
		get: () => PARAMS.topgg.legacyVotersCrate, expected: { keep: true, excludeOldRod: true },
	},
	{
		id: 'P-STREAK-BADGES', status: 'proposed',
		title: 'Streak badges are cosmetic only, derived from the best streak',
		modelled: `badges at ${PARAMS.badges.join(' / ')} streak days (streak.best)`,
		alternatives: ['economic rewards at long-streak milestones'],
		source: 'streak design', why: 'long streaks earn prestige, not economy, so players who miss days are not left behind',
		get: () => PARAMS.badges, expected: [7, 30, 100, 365],
	},
	{
		id: 'P-STREAK-INDEPENDENT', status: 'proposed',
		title: 'The streak and the daily quest share the DCC day (P-DAY) but are independent: the streak never requires the daily quest, and the daily quest never extends the streak',
		modelled: 'one day boundary (PARAMS.day = F.DAY); separate rewards (Streak Crate / Daily Box)',
		alternatives: ['the daily quest as the streak\'s gate (casual players cannot always finish one)'],
		source: 'streak + quests designs', why: 'one streak system, and a gate every archetype meets in minutes',
		get: () => PARAMS.day.startUtcHour === F.DAY.startUtcHour, expected: true,
	},
	{
		id: 'P-STREAK-FOUNDER', status: 'proposed',
		title: 'Founder: the same gate, boxes and public catch-card line. The sell multiplier on box contents is private; the Founder gacha stats (and gacha pity) roll the box, so the rarity edge shows on the public /open reveal',
		modelled: 'boxContents(..., \'founder\') = founder.founderBoxEV() with founder.founderProfile() (the stealth-hybrid: gacha stats on non-buff slots only, buffs at normal odds; sell multiplier); gate counts casts; /open stays a public reply rolled with the opener\'s gacha stats and pity (Founder reveal table)',
		alternatives: [
			'accept the visible rarity edge on /open, as with the kept catch-card rarity edge (P-FOUNDER-KEPT)',
			'roll Founder box opens on the normal table and pay the Founder edge privately as extra value (the reveal then matches a normal player\'s odds)',
			'make /open ephemeral for every player (no public reveal for anyone)',
			'Founder-specific streak boxes',
		],
		source: 'streak design', why: 'the gate, the catch-card line and box fish (competitiveEligible false) are identical for every profile; what differs publicly is the rarity mix a Founder reveals on /open (Founder reveal table), a slower tell than the kept catch-card rarity edge. The user picks one of the alternatives',
	},
	{
		id: 'P-STREAK-TARGETS', status: 'proposed',
		title: 'Value targets the streak is checked against: casual 30-day value in a band of its own fishing income, caps for regular and grinder, a streak-XP cap, a no-miss-grinder shift cap, and the T1 part set not free for regular players. Streak value counts the box contents AND the cash value of every buff from streak boxes (Double Cash; Lucky Draw attributed pro rata, none since the pools exclude it)',
		modelled: `basis '${PARAMS.targets.shareBasis}' (box contents + attributed buff cash); casual ${PARAMS.targets.casual30dShare.map((x) => `${100 * x}%`).join('-')}; regular <= ${100 * PARAMS.targets.regular30dShareMax}%; grinder <= ${100 * PARAMS.targets.grinder30dShareMax}%; streak XP <= ${100 * PARAMS.targets.streakXpShareMax}%; grinder shift <= ${100 * PARAMS.targets.grinderHoursDeltaMax}%; T1 set median >= ${PARAMS.targets.minT1Days} days`,
		alternatives: ['basis \'boxAndDoubleCash\' (the earlier basis: box contents + Double Cash, Lucky Draw rebates left to the buffs design)', 'other bands (the streak as a larger share of casual income, or a flat share for everyone)'],
		source: 'streak design; user decision (regular 30-day streak value including attributed buff value <= 5% of fishing income)', why: 'a catch-up for casual players and a small bonus for engaged ones (checks table); every buff a streak box grants is streak value, whichever system books it',
		get: () => PARAMS.targets, expected: { shareBasis: 'withAttributedBuffs', casual30dShare: [0.15, 0.35], regular30dShareMax: 0.05, grinder30dShareMax: 0.01, streakXpShareMax: 0.02, grinderHoursDeltaMax: 0.01, minT1Days: 14 },
	},
	{
		id: 'P-STREAK-SUPPORTER-FLAIR', status: 'proposed',
		title: 'Optional: a cosmetic "Early Supporter" flair for past voters, derived at read time from stats.lastVoted',
		modelled: 'offered, not modelled (cosmetic; no write, no economy); stats.totalVotes cannot be used (it was never incremented)',
		alternatives: ['no flair'],
		source: 'streak design', why: 'acknowledges voters who lose the vote reward at no economic cost',
	},
];

// ---------------------------------------------------------------------------------------------
/** archetypeValue() period field each PARAMS.targets.shareBasis reads. */
const SHARE_BASIS = Object.freeze({ withAttributedBuffs: 'checkedShareOfFishing', boxAndDoubleCash: 'streakShareOfFishing' });
function checks() {
	const T = PARAMS.targets;
	const av = archetypeValue();
	const r = r2();
	const t1 = t1PartsFromStreak();
	const defs = boxDefinitions();
	const pools = Object.values(defs).flatMap((d) => d.pool.types);
	const basis = SHARE_BASIS[T.shareBasis];
	if (!basis) throw new Error(`Unknown streak share basis ${T.shareBasis}`);
	const shares = Object.fromEntries(Object.entries(av).map(([k, v]) => [k, v.periods[30][basis]]));
	const order = ARCHETYPE_NAMES;
	const maxStreakXpShare = Math.max(...Object.values(r.archetypes).flatMap((a) => Object.values(a.decomposition).map((d) => d.share.streak)));
	const minDailyXpShare = Math.max(...['streakOnly', 'reference'].flatMap((v) => r.minimumDaily[v].rows.map((x) => x.minimumDaily.streakXpShare)));
	const bound = doubleXpDayShare();
	const refRuns = [...ARCHETYPE_NAMES, MINIMUM_DAILY].map((a) => integratedRun(a));
	const countedOnce = refRuns.every((run) => {
		const st = run.sys[SYSTEM_NAME];
		const received = sumValues(run.sys.buffs.receivedBySource[SYSTEM_NAME]);
		return Math.abs(sumValues(st.buffs) - received) <= 1e-9 * Math.max(1, received) && run.ledger.cash[CASH_SOURCE] === st.value.cash;
	});
	// User decision: no Lucky Draw in streak boxes, at any stage or profile, and none received from the streak.
	const excluded = PARAMS.pool.excludeBuffs;
	const noExcludedBuffs = Object.keys(defs).every((box) => F.LIVE_BIOMES.every((b) => ['normal', 'founder'].every((p) => excluded.every((n) => !(boxContents(box, F.BIOME_LEVEL[b], p).buffs[n] > 0)))))
		&& refRuns.every((run) => excluded.every((n) => !(run.sys.buffs.receivedBySource[SYSTEM_NAME]?.[n] > 0)));
	const list = [
		{ id: 'no-lucky-draw-in-streak-boxes', value: excluded, pass: excluded.includes('Lucky Draw') && noExcludedBuffs },
		{ id: 'no-direct-cash-or-xp', pass: PARAMS.direct.cash === 0 && PARAMS.direct.xp === 0 && refRuns.every((run) => !(SYSTEM_NAME in run.ledger.xp)) },
		{ id: 'buffs-counted-once', pass: countedOnce },
		{ id: 'recorder-observational', pass: recorderParity().exact },
		{ id: 'milestones-covered', value: F.LIFECYCLE.maxLevel, pass: ARCHETYPE_NAMES.every((a) => integratedRun(a).milestones[F.LIFECYCLE.maxLevel]) },
		{ id: 'no-booster-pack-no-old-rod', pass: !pools.includes('gacha') && !pools.includes('rod') },
		{ id: 'casual-30d-share-in-band', basis: T.shareBasis, value: shares.casual, band: T.casual30dShare, pass: shares.casual >= T.casual30dShare[0] && shares.casual <= T.casual30dShare[1] },
		{ id: 'regular-30d-share-max', basis: T.shareBasis, value: shares.regular, max: T.regular30dShareMax, pass: shares.regular <= T.regular30dShareMax },
		{ id: 'grinder-30d-share-max', basis: T.shareBasis, value: shares.grinder, max: T.grinder30dShareMax, pass: shares.grinder <= T.grinder30dShareMax },
		{ id: 'casual-gains-relatively-most', value: order.map((k) => round(shares[k], 4)), pass: order.every((k, i) => i === 0 || shares[order[i - 1]] > shares[k]) },
		{ id: 'streak-xp-share-max', value: maxStreakXpShare, max: T.streakXpShareMax, pass: maxStreakXpShare <= T.streakXpShareMax },
		{ id: 'streak-xp-within-double-xp-bound', value: { archetypes: maxStreakXpShare, minimumDaily: minDailyXpShare }, max: bound, pass: maxStreakXpShare <= bound && minDailyXpShare <= bound },
		{ id: 'r2-minimum-daily', pass: !r.minimumDaily.streakOnly.leadsAnywhere && !r.minimumDaily.reference.leadsAnywhere },
		{ id: 'r2-no-miss-grinder', value: r.noMissGrinder.maxHoursDelta, max: T.grinderHoursDeltaMax, pass: r.noMissGrinder.maxHoursDelta <= T.grinderHoursDeltaMax },
		{ id: 'regular-in-windows-with-streak', value: r.noMissGrinder.regularHours, pass: r.noMissGrinder.regularStillInWindows },
		{ id: 't1-set-not-free-for-regular', value: { medianDays: t1.medianDays, regularTier1Day: t1.daysToTier1Level.regular }, min: T.minT1Days, pass: t1.medianDays >= T.minT1Days && t1.medianDays > t1.daysToTier1Level.regular },
	];
	return { pass: list.every((c) => c.pass), list };
}

// ---------------------------------------------------------------------------------------------
let reportCache = null;
function report() {
	if (reportCache) return reportCache;
	const defs = boxDefinitions();
	const values = Object.fromEntries(F.LIVE_BIOMES.map((b) => {
		const L = F.BIOME_LEVEL[b];
		const c = boxEV(PARAMS.ladder.dailyBox, { level: L });
		const h = boxEV(PARAMS.ladder.milestoneBox, { level: L });
		const r = stageRates(L, { tier: F.typicalTier(b) });
		const v = perClaimValue(L);
		return [b, {
			level: L,
			tier: F.typicalTier(b).key,
			stageCashPerHour: r.cash,
			stageValuePerFish: r.valuePerFish,
			crate: { liquid: c.liquid, fish: c.fish, fishValue: c.fishValue, salvage: c.salvage, baitUsable: c.baitUsable, baitDeferred: c.baitDeferred, buffs: c.buffs, fishByRarity: c.fishByRarity },
			chest: { liquid: h.liquid, fish: h.fish, fishValue: h.fishValue, salvage: h.salvage, baitUsable: h.baitUsable, baitDeferred: h.baitDeferred, buffs: h.buffs, fishByRarity: h.fishByRarity, slot0: h.slotTables[0] },
			perClaim: v,
			perClaimMinutesOfStageIncome: (v.cashEquivalent / r.cash) * 60,
		}];
	}));
	const legacy = F.LIVE_BIOMES.map((b) => ({ biome: b, level: F.BIOME_LEVEL[b], ...(({ liquid, fishValue, salvage, baitUsable, buffs }) => ({ liquid, fishValue, salvage, baitUsable, buffs }))(boxEV(legacyVotersCrate(), { level: F.BIOME_LEVEL[b] })) }));
	const ladderAt = F.gearPath()[1].level;
	const ladder = Array.from({ length: PARAMS.ladder.cycle }, (_, i) => streakValue(i + 1, ladderAt));
	const crateAt = boxEV(PARAMS.ladder.dailyBox, { level: ladderAt });
	const chestAt = boxEV(PARAMS.ladder.milestoneBox, { level: ladderAt });
	const r2r = r2();
	reportCache = {
		...F.stamp(),
		gearPathSource: F.GEAR_PATH_SOURCE,
		model: I.REFERENCE_NOTE,
		params: PARAMS,
		gate: {
			successfulCasts: PARAMS.gate.successfulCasts,
			minutesByArchetype: Object.fromEntries(Object.entries(F.ARCHETYPES).map(([k, a]) => [k, gateMinutes(a.overheadS)])),
			shareOfDailyCasts: Object.fromEntries(Object.entries(F.ARCHETYPES).map(([k, a]) => [k, PARAMS.gate.successfulCasts / (a.minutesPerDay * 60 / (F.COOLDOWN.fishMs / 1000 + a.overheadS))])),
			minimumDailyMinutesPerDay: { streakOnly: r2r.minimumDaily.streakOnly.minutesPerDay, reference: r2r.minimumDaily.reference.minutesPerDay },
		},
		boxDefinitions: defs,
		legacyVotersCrate: legacyVotersCrate(),
		contents: { level: ladderAt, crate: crateAt, chest: chestAt },
		values,
		legacyVotersCrateValue: legacy,
		ladder: { level: ladderAt, days: ladder },
		rules: ruleExamples(),
		jackpots: jackpots(),
		doubleXpDayShare: doubleXpDayShare(),
		attendance: attendanceTable(),
		archetypeValue: archetypeValue(),
		r2: r2r,
		t1PartsFromStreak: t1PartsFromStreak(),
		topgg: topggComparison(),
		founder: founderView(),
		quests: questInterplay(),
		integration: {
			system: SYSTEM_NAME,
			hooks: ['init', 'onCasts (credit \'gate\' only)', 'onDayEnd', 'onMissedDay', 'sessionDone'],
			ledger: { cash: [CASH_SOURCE], xp: [], spend: [] },
			events: { emits: 'box { name: \'Streak Crate\' | \'Streak Chest\', count: 1, level, source: \'streak\', streakDay, profile }' },
			defaults: { credit: 'dayEnd', baitValue: 'cash' },
		},
		recorderParity: recorderParity(),
		creditTiming: creditTiming(),
		systemParity: SYSTEM_PARITY,
		decisions: DECISIONS.map((d) => ({ ...Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'get' && k !== 'expected')), recordMatchesModel: d.get ? JSON.stringify(d.get()) === JSON.stringify(d.expected) : null })),
		checks: checks(),
	};
	return reportCache;
}

// ---------------------------------------------------------------------------------------------
// Generated doc tables (render-docs.js). Every number in docs/economy/5b/streak.md comes from here.
const mdTable = (headers, rows) => [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n');
const usd = (x) => `$${Math.round(x).toLocaleString('en-US')}`;
const pct = (x, d = 1) => `${(100 * x).toFixed(d)}%`;
/** Whole percent from 10% up, one decimal below (small shares stay readable). */
const pctAuto = (x) => pct(x, Math.abs(x) >= 0.1 ? 0 : 1);
const fx = (x, d = 2) => Number(x).toFixed(d);
const n0 = (x) => Math.round(x).toLocaleString('en-US');
const hrs = (x) => `${fx(x, 2)} h`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const range = (xs, f) => {
	const lo = Math.min(...xs);
	const hi = Math.max(...xs);
	return lo === hi ? f(lo) : `${f(lo)}–${f(hi)}`;
};
const yes = (b) => (b ? 'yes' : '**no**');

function markdownTables() {
	const R = report();
	const P = PARAMS;
	const out = {};
	const av = R.archetypeValue;
	const r2r = R.r2;
	const tg = R.topgg;
	const G = P.gate.successfulCasts;
	const chestDef = P.boxes[P.ladder.milestoneBox];
	const crateDef = P.boxes[P.ladder.dailyBox];
	const s30 = Object.fromEntries(ARCHETYPE_NAMES.map((a) => [a, av[a].periods[30]]));
	const t1 = R.t1PartsFromStreak;
	const fv = R.founder;
	const att = R.attendance;
	const jp = R.jackpots;

	// Summary.
	const allDecomp = Object.values(r2r.archetypes).flatMap((a) => Object.values(a.decomposition));
	const maxStreakXp = Math.max(...allDecomp.map((d) => d.share.streak));
	out['streak-headline'] = mdTable(['Figure', 'Value', 'Table'], [
		['Play gate', `${G} successful casts per DCC day: ${range(Object.values(R.gate.minutesByArchetype), (x) => fx(x, 1))} min of play`, 'Gate'],
		['Streak value in the first 30 days incl. the cash value of its buffs, share of own fishing income (integrated)', ARCHETYPE_NAMES.map((a) => `${a} ${pct(s30[a].checkedShareOfFishing)}`).join(', '), 'Lifecycle'],
		['Streak XP share at L20–L50 (Double XP from streak boxes, integrated)', `at most ${pct(maxStreakXp, 2)}; structural bound ${pct(R.doubleXpDayShare, 2)}`, 'R2 decomposition'],
		['Minimum-daily player vs casual (R2)', r2r.minimumDaily.verdict.split(':')[0], 'R2 minimum-daily'],
		['No-miss grinder: largest milestone shift from the streak', `${pct(r2r.noMissGrinder.maxHoursDelta, 2)} (${r2r.noMissGrinder.verdict.split(':')[0]})`, 'R2 grinder'],
		['Regular player with the streak (reference loop)', `${Object.entries(r2r.noMissGrinder.regularHours).map(([L, h]) => `L${L} ${hrs(h)}`).join(', ')}; ${r2r.noMissGrinder.regularStillInWindows ? 'every approved window met' : 'a window is MISSED'}`, 'R2 grinder'],
		['Today\'s vote rule on the new value model (casual, 30 days)', `${usd(tg.newValueModel.casual.topggRule30d)} = ${pct(tg.newValueModel.casual.topggShareOfFishing, 0)} of fishing income, against the streak's ${pct(tg.newValueModel.casual.streakShareOfFishing)}`, 'Top.gg'],
		['Legendary/Lucky in streak boxes', `${pct(jp.crate.pAtLeastOne)} of crates, ${pct(jp.chest.pAtLeastOne)} of chests, ${pct(jp.pAtLeastOnePerWeek, 0)} of weeks`, 'Box contents'],
		['Founder box value (Founder profile, private: sell multiplier)', `a crate is worth ${range(fv.stages.map((s) => s.crate.ratio), (x) => `${fx(x, 1)}×`)} a normal one`, 'Founder'],
		['Founder box reveal on /open (public: gacha stats)', `a Legendary/Lucky slot in ${pct(fv.reveal.crate.founder, 2)} of Founder crates against ${pct(fv.reveal.crate.normal, 2)} of normal ones; chests ${pct(fv.reveal.chest.founder, 2)} against ${pct(fv.reveal.chest.normal, 2)} (pity not modelled)`, 'Founder reveal'],
		['Design checks', `${R.checks.list.filter((c) => c.pass).length} of ${R.checks.list.length} pass`, 'Checks'],
	]);

	// Decisions for approval.
	out['streak-decisions'] = `${mdTable(['ID', 'Proposed decision', 'Modelled', 'Alternatives', 'Why', 'Record = model'], DECISIONS.map((d) => [
		`\`${d.id}\``, d.title, d.modelled, d.alternatives.join('; '), d.why,
		d.get ? yes(JSON.stringify(d.get()) === JSON.stringify(d.expected)) : 'n/a (not a PARAMS value)',
	]))}\n\nStatus of every entry: \`${[...new Set(DECISIONS.map((d) => d.status))].join(', ')}\`. Only the user approves; \`decisions.js\` joins these to the Phase 5B registry (alongside the framework's \`P-DAY\`, \`P-EVENTS\`, \`P-DOUBLE-CASH\` and \`A-TOPGG\`, which this design relies on) and \`check-shared.js\` verifies each record against the model.`;

	// Current -> Proposed.
	const todayC = tg.todayModel;
	const vt = VOTERS.rarityTable;
	out['streak-current-proposed'] = mdTable(['Item', 'Current', 'Proposed'], [
		['External daily reward', `\`/vote\`: a Top.gg API check (\`User.vote()\`, \`TOPGG_TOKEN\`, a network call) on every vote, paying ${usd(todayC.casual.cashPerVote)} + a Voter's Crate per vote`, '**Retired** (`P-STREAK-VOTE`). No network call and no token'],
		['DCC-native daily reward', 'None. The daily quest runs on a rolling clock from the time the last one was accepted', `A **streak day** once per DCC day, earned by ${G} successful casts and credited in the qualifying cast (\`P-STREAK-GATE\`)`],
		['Reward', `Cash + a Voter's Crate: ${VOTERS.slots} slots, fish from **every** biome, the Old Rod, parts of every rarity, bait, buffs`, `${P.ladder.dailyBox} (${crateDef.slots} slots) or, every ${P.ladder.cycle}th streak day, the ${P.ladder.milestoneBox} (${chestDef.slots} slots, slot 0 ${chestDef.guaranteedSlots[0].minRarity}+). Fish from the player's highest biome; parts up to ${P.pool.maxPartRarity}; no cash`],
		['Rarity table', `Voter's: ${RARITIES.map((r) => `${r} ${vt[r]}`).join(', ')}`, `The same table with common ${P.pool.rarityTable.common}, rarity floor ${P.pool.rarityFloor}`],
		['Streak, grace, decay', 'None', `Count, best, total; grace tokens (${P.grace.start} → max ${P.grace.max}); −${P.decay.perUncoveredMiss} days per uncovered miss; reset after ${P.decay.resetAfterMissedDays} missed days`],
		['Value in the first 30 days, share of own fishing income', `${ARCHETYPE_NAMES.map((a) => `${a} ${pctAuto(todayC[a].votesShareOfFishing)}`).join(', ')} (Phase 5 model, \`simulation.json\`)`, `${ARCHETYPE_NAMES.map((a) => `${a} ${pct(s30[a].checkedShareOfFishing)}`).join(', ')} (integrated, incl. the cash value of streak-box buffs; framework ${R.frameworkVersion})`],
		['XP', 'None from votes', `None direct. Double XP buffs in streak boxes only: at most ${pct(maxStreakXp, 2)} of XP at L20–L50`],
		['Voter\'s Crate', 'Granted per vote', 'No longer granted. Owned crates open forever, minus the Old Rod reward (`P-STREAK-VOTERS-CRATE`)'],
		['Vote counters', '`stats.lastVoted` is written. `stats.totalVotes` is never incremented (`User.vote()` increments `stats.votes`, which the schema does not define)', 'Both kept read-only. New additive `streak.*` fields'],
	]);

	// Gate.
	out['streak-gate'] = mdTable(['Archetype', 'Overhead per cast', 'Minutes to reach the gate', 'Share of the day\'s casts'], ARCHETYPE_NAMES.map((a) => [
		cap(a), `${F.ARCHETYPES[a].overheadS} s`, fx(R.gate.minutesByArchetype[a], 1), pct(R.gate.shareOfDailyCasts[a]),
	]).concat([[
		'Minimum-daily player (integrated, `F.MINIMUM_DAILY`)', `${F.MINIMUM_DAILY.overheadS} s`,
		`${fx(R.gate.minimumDailyMinutesPerDay.streakOnly, 1)} a day with the streak alone; ${fx(R.gate.minimumDailyMinutesPerDay.reference, 1)} with the daily quest too`, '—',
	]])) + `\n\nOld Rod cooldown ${F.COOLDOWN.fishMs / 1000} s + overhead; ${G} casts.`;

	// Rule traces.
	const rx = R.rules;
	const gateHit = rx.gate.find((g) => g.credited);
	const after = rx.gate.find((g) => g.cast === G + 1);
	const nextDay = rx.gate[rx.gate.length - 1];
	const fw = rx.firstWeek.steps;
	const chestStep = fw[fw.length - 1];
	const missed = (tr) => tr.steps[0].day - tr.start.lastDay - 1;
	const gapRow = (tr, event) => {
		const s = tr.steps[0];
		const parts = [];
		if (s.graceUsed) parts.push(`${s.graceUsed} token${s.graceUsed > 1 ? 's' : ''} used`);
		if (s.reset) parts.push(`**reset** (tokens kept: ${s.grace})`);
		else if (s.decayedBy) parts.push(`${tr.start.count} − ${P.decay.perUncoveredMiss * (missed(tr) - s.graceUsed)} → ${tr.start.count - s.decayedBy}`);
		return [tr.label, `streak ${tr.start.count}, grace ${tr.start.grace}`, event, `${parts.join('; ')}${parts.length ? '; then ' : ''}streak **${s.streak}**, grace ${s.grace}`];
	};
	out['streak-rules'] = mdTable(['Case', 'Before', 'Event', 'After'], [
		['Gate', `${G - 1} casts today`, `cast ${gateHit.cast}`, `credited: ${gateHit.box}. Cast ${after.cast} credits nothing (${after.credited ? 'CREDITED' : 'no-op'}); the next day starts again at ${nextDay.castsToday}`],
		[rx.firstWeek.label, `new player (grace ${rx.firstWeek.start.grace})`, `${fw.length} consecutive days`, `days 1–${fw.length - 1}: ${fw[0].box}; day ${chestStep.day}: **${chestStep.box}**, grace ${fw[fw.length - 2].grace} → ${chestStep.grace}${chestStep.badges.length ? `, badge ${chestStep.badges.join(', ')}` : ''}`],
		[rx.sameDayTwice.label, 'credited today', 'another credit attempt', rx.sameDayTwice.steps[1].credited ? 'CREDITED TWICE' : 'no-op'],
		gapRow(rx.missCovered, `skip ${missed(rx.missCovered)} day, play`),
		gapRow(rx.missUncovered, `skip ${missed(rx.missUncovered)} days, play`),
		gapRow(rx.newStreakMiss, `skip ${missed(rx.newStreakMiss)} day, play`),
		gapRow(rx.longGap, `skip ${missed(rx.longGap)} days, play`),
	]);

	// Ladder.
	const ld = R.ladder.days;
	const ldRow = (v, label) => [label, v.box, usd(v.cashEquivalent), fx(v.items.fish), fx(v.items.parts), fx(v.items.baitPacks, 3), BUFF_NAMES.map((b) => fx(v.buffs[b] || 0, 3)).join(' / ')];
	out['streak-ladder'] = mdTable(['Streak day', 'Box', 'Box contents (cash-equivalent)', 'Fish', 'Uncommon parts', 'Bait packs', `Buffs (${BUFF_NAMES.join(' / ')})`], [
		ldRow(ld[0], `1–${P.ladder.cycle - 1}, ${P.ladder.cycle + 1}–${2 * P.ladder.cycle - 1}, …`),
		ldRow(ld[P.ladder.cycle - 1], `${P.ladder.cycle}, ${2 * P.ladder.cycle}, ${3 * P.ladder.cycle}, …`),
	]) + `\n\nAt Lv ${R.ladder.level} (${F.biomeAt(R.ladder.level)}). Cash-equivalent = fish at sale value + parts at salvage + usable bait packs at pack price (what the streak system books). Buffs are counted here and valued by the buffs system.`;

	// Attendance.
	const alt = att.moreGrace.rows;
	out['streak-attendance'] = mdTable(['Days played per week', 'Claims / 30 d', 'Chests / 30 d', 'Tokens used / 30 d', 'Chests / year', 'Chest share of claims', 'Uncovered misses / year', 'Resets / year', 'Value per claim vs daily player', `Alternative (${att.moreGrace.rules.perCycle} per chest, max ${att.moreGrace.rules.max}): chests / year`, 'Alternative: value per claim'], att.proposed.map((x, i) => [
		fx(x.daysPerWeek, 0), fx(x.d30.claims, 1), fx(x.d30.chests), fx(x.d30.graceUsed), fx(x.d365.chests, 1), pct(x.d365.chestShare), fx(x.d365.decayEvents, 1), fx(x.d365.resets), pct(x.valuePerClaimVsDaily),
		fx(alt[i].d365.chests, 1), pct(alt[i].valuePerClaimVsDaily),
	])) + `\n\nExact DP over streak × tokens × missed days, each day played independently with probability days/7; values at Lv ${att.referenceLevel}, where a chest is worth ${fx(att.chestToCrate, 1)}× a crate.`;

	// Box definitions.
	const cd = R.boxDefinitions[P.ladder.dailyBox];
	const hd = R.boxDefinitions[P.ladder.milestoneBox];
	const tbl = (t) => RARITIES.filter((r) => t[r] > 0).map((r) => `${r} ${t[r]}`).join(', ');
	out['streak-boxes'] = mdTable(['', P.ladder.dailyBox, P.ladder.milestoneBox], [
		['id', `\`${cd.id}\``, `\`${hd.id}\``],
		['slots', cd.slots, `${hd.slots} (${hd.slots - cd.slots} bonus)`],
		['strategy', cd.strategy, hd.strategy],
		['pool.types', cd.pool.types.join(', '), 'same'],
		['pool.fish', `**\`'${cd.pool.fish}'\`** (new option)`, 'same'],
		['pool.fishShare', `**${cd.pool.fishShare}** (new option)`, 'same'],
		['pool.exclude', `every rod part above ${P.pool.maxPartRarity} (${cd.pool.exclude.length} names, from the catalog)`, 'same'],
		['rarityTable', `${tbl(cd.rarityTable)} (the Voter's table without common)`, 'same'],
		['rarityFloor', cd.rarityFloor, hd.rarityFloor],
		['guaranteedSlots', cd.guaranteedSlots.length ? JSON.stringify(cd.guaranteedSlots) : 'none', hd.guaranteedSlots.map((g) => `slot ${g.slot} ≥ **${g.minRarity}**`).join(', ')],
		['duplicates', cd.duplicates, hd.duplicates],
		['pity', 'none', 'none'],
	]);

	// Contents of one open.
	const cc = R.contents.crate;
	const hc = R.contents.chest;
	const rar = RARITIES.filter((r) => (cc.slotTables[0][r] || 0) + (hc.slotTables[0][r] || 0) > 0);
	out['streak-contents'] = mdTable(['Rarity', `${P.ladder.dailyBox} slot`, `${P.ladder.milestoneBox} slot 0`], rar.map((r) => [cap(r), pct(cc.slotTables[0][r] || 0, 2), pct(hc.slotTables[0][r] || 0, 2)])) + '\n\n' +
		mdTable(['Per open', 'Fish', 'Uncommon parts', 'Bait packs', ...BUFF_NAMES, 'Holds a Legendary/Lucky fish'], [
			[P.ladder.dailyBox, fx(cc.fish), fx(cc.parts), fx(sumValues(cc.baitPacks), 3), ...BUFF_NAMES.map((b) => fx(cc.buffs[b] || 0, 3)), pct(jp.crate.pAtLeastOne)],
			[P.ladder.milestoneBox, fx(hc.fish), fx(hc.parts), fx(sumValues(hc.baitPacks), 3), ...BUFF_NAMES.map((b) => fx(hc.buffs[b] || 0, 3)), pct(jp.chest.pAtLeastOne)],
		]) + `\n\nAt Lv ${R.contents.level}. At least one Legendary or Lucky fish arrives in ${pct(jp.pAtLeastOnePerWeek, 0)} of weeks; about ${fx(jp.expectedPer30Days)} arrive per 30 days. Bait packs: ${Object.keys(cc.baitPacks).join(', ')}.`;

	// Value per box by stage.
	out['streak-box-value'] = mdTable(['Stage', 'Crate: fish', 'fish $', 'salvage $', 'usable bait $', 'bait not yet usable $', 'Chest: fish', 'fish $', 'salvage $', 'usable bait $'], F.LIVE_BIOMES.map((b) => {
		const v = R.values[b];
		return [`${b} (Lv ${v.level})`, fx(v.crate.fish), usd(v.crate.fishValue), usd(v.crate.salvage), usd(v.crate.baitUsable), usd(v.crate.baitDeferred), fx(v.chest.fish), usd(v.chest.fishValue), usd(v.chest.salvage), usd(v.chest.baitUsable)];
	})) + '\n\nFish at the framework\'s `proposedValue`, parts at `rods.salvageValue`, bait at `bait.prices()` pack price once the player can use it.';

	// Legacy Voter's Crate.
	out['streak-voters'] = mdTable(['Stage', 'One open (liquid)', 'Fish (all biomes)', 'Part salvage', 'Usable bait'], R.legacyVotersCrateValue.map((x) => [`${x.biome} (Lv ${x.level})`, usd(x.liquid), usd(x.fishValue), usd(x.salvage), usd(x.baitUsable)])) +
		`\n\nToday (\`gacha-ev.json\`, today's value model): ${usd(tg.votersCrateTodayLiquid)} per open. With the proposed Old Rod exclusion.`;

	// Per claimed day by stage (static rates).
	out['streak-stage-value'] = mdTable(['Stage', 'Regular $/h at the stage', 'Crate', 'Chest', 'Per claimed day', 'Minutes of stage income (regular)', 'Buffs per claimed day', ...ARCHETYPE_NAMES.map((a) => `Share of ${a}'s daily fishing`)], F.LIVE_BIOMES.map((b, i) => {
		const v = R.values[b];
		return [`${b} · ${v.tier} (Lv ${v.level})`, usd(v.stageCashPerHour), usd(v.crate.liquid), usd(v.chest.liquid), usd(v.perClaim.cashEquivalent), fx(v.perClaimMinutesOfStageIncome, 1), fx(v.perClaim.buffs, 3), ...ARCHETYPE_NAMES.map((a) => pct(av[a].byLevel[i].share))];
	})) + '\n\nBox columns: liquid value (fish + salvage); per claimed day adds usable bait (7-day cycle average). Stage $/h: `F.castOutcome` at the typical tier, the core\'s base fishing rate for the reference loop. Buffs are not in these columns (the buffs system values them; lifecycle table).';

	// Integrated lifecycle totals.
	out['streak-lifecycle'] = mdTable(['Player', 'Day', 'Level', 'Fishing income', 'Box contents', 'Double Cash (buffs system)', 'Lucky Draw (attributed)', 'Streak value / fishing', 'Streak per day', 'Double Cash share', 'Streak XP share'], ARCHETYPE_NAMES.flatMap((a) => PERIODS.map((d) => {
		const s = av[a].periods[d];
		return [d === PERIODS[0] ? `${cap(a)} (${F.ARCHETYPES[a].minutesPerDay} min/day)` : '', d, s.level, usd(s.fishingIncome), usd(s.boxContents), usd(s.doubleCash), usd(s.luckyDrawAttributed), `**${pct(s.checkedShareOfFishing)}**`, usd(s.checkedValue / d), pct(s.doubleCashShareOfStreak, 0), pct(s.streakXpShare, 2)];
	}))) + `\n\nIntegrated reference loop (${I.REFERENCE_NOTE}); every archetype plays every day. Streak value (the checked basis, \`PARAMS.targets.shareBasis\` '${P.targets.shareBasis}') = box contents (the streak's ledger) + the cash value of every buff from streak boxes: their Double Cash (the buffs system's value by source) and their Lucky Draw (the buffs system's Lucky Draw value attributed pro rata to the units received). Streak boxes hold no Lucky Draw (\`P-STREAK-ITEM-POOL\`), so that column is zero by construction; it stays in the basis so a pool change that reintroduces a buff is counted.` + '\n\n' +
		mdTable(['Buffs per open (Lv 0)', ...BUFF_NAMES.map((b) => `${b}: earlier pool`), ...BUFF_NAMES.map((b) => `${b}: proposed`)], Object.keys(boxDefinitions()).map((box) => {
			const def = boxDefinitions()[box];
			const earlier = { ...def, pool: { ...def.pool, exclude: def.pool.exclude.filter((n) => !P.pool.excludeBuffs.includes(n)) } };
			const [e, p] = [boxEV(earlier), boxEV(box)];
			return [box, ...BUFF_NAMES.map((b) => pct(e.buffs[b] || 0, 2)), ...BUFF_NAMES.map((b) => pct(p.buffs[b] || 0, 2))];
		})) + `\n\nThe earlier pool held ${P.pool.excludeBuffs.join(', ')}; without it the Rare item slot is shared uniformly by the remaining Rare items (Double XP, Double Cash and the Rare bait, as the engine rolls it), so each keeps a slightly larger share of that slot. No cash replaces the Lucky Draw.` + '\n\n' +
		mdTable(['Per 30 days (integrated)', ...ARCHETYPE_NAMES.map(cap)], [
			['Streak days credited', ...ARCHETYPE_NAMES.map((a) => n0(s30[a].credits))],
			['Crates / chests', ...ARCHETYPE_NAMES.map((a) => `${n0(s30[a].items.crates)} / ${n0(s30[a].items.chests)}`)],
			['Fish', ...ARCHETYPE_NAMES.map((a) => fx(s30[a].items.fish, 1))],
			['Uncommon parts', ...ARCHETYPE_NAMES.map((a) => fx(s30[a].items.parts, 1))],
			['Bait packs', ...ARCHETYPE_NAMES.map((a) => fx(s30[a].items.baitPacks, 1))],
			['Buffs', ...ARCHETYPE_NAMES.map((a) => fx(s30[a].items.buffs, 2))],
		]);

	// R2 decomposition.
	out['streak-r2-decomposition'] = mdTable(['Player', 'Level', 'Play-hours (without streak → with)', 'Calendar day', 'Fishing XP', 'Quest XP (story + repeatable)', 'Daily systems XP (daily + weekly)', 'Streak XP (Double XP of streak boxes)', 'Other buff XP', 'Other', 'Streak share'], ARCHETYPE_NAMES.flatMap((a) => {
		const x = r2r.archetypes[a];
		return R2_LEVELS.filter((L) => x.decomposition[L]).map((L, i) => {
			const d = x.decomposition[L];
			return [i === 0 ? cap(a) : '', L, `${fx(x.hoursWithoutStreak[L])} → ${fx(x.hoursWithStreak[L])}`, d.day, n0(d.xp.fishing), n0(d.xp.quests), n0(d.xp.daily), n0(d.xp.streak), n0(d.xp.buffsOther), n0(d.xp.other), pct(d.share.streak, 2)];
		});
	})) + `\n\nIntegrated reference loop; "without streak" excludes the streak system (\`exclude: ['streak']\`). Structural bound on the streak share: ${pct(R.doubleXpDayShare, 2)} of streak days bring a Double XP buff.`;

	// R2 minimum-daily.
	const mdRows = (key, label) => r2r.minimumDaily[key].rows.map((r, i) => [
		i === 0 ? label : '', r.day,
		r.minimumDaily.level, fx(r.minimumDaily.hours, 1), n0(r.minimumDaily.xpPerActiveHour), usd(r.minimumDaily.streakCashPerActiveHour),
		r.casual.level, fx(r.casual.hours, 1), n0(r.casual.xpPerActiveHour), usd(r.casual.streakCashPerActiveHour),
		r.minimumDailyLeadsInLevel ? '**yes**' : 'no',
	]);
	out['streak-r2-minimum-daily'] = mdTable(['Variant', 'Day', 'Min-daily: level', 'play-h', 'XP / active h', 'streak $ / active h', 'Casual: level', 'play-h', 'XP / active h', 'streak $ / active h', 'Leads?'], [
		...mdRows('streakOnly', `Streak alone (quests excluded; ${fx(r2r.minimumDaily.streakOnly.minutesPerDay, 1)} min/day)`),
		...mdRows('reference', `Reference loop (streak + daily quest; ${fx(r2r.minimumDaily.reference.minutesPerDay, 1)} min/day)`),
	]) + `\n\n\`F.MINIMUM_DAILY\` (${F.MINIMUM_DAILY.overheadS} s overhead) plays each day only until every system's \`sessionDone()\` holds. Verdict: **${r2r.minimumDaily.verdict}** Streak days credited: ${r2r.minimumDaily.streakOnly.credited} of ${r2r.minimumDaily.streakOnly.days} (streak alone), ${r2r.minimumDaily.reference.credited} of ${r2r.minimumDaily.reference.days} (reference loop).`;

	// R2 grinder.
	const g = r2r.noMissGrinder;
	const gl = Object.keys(g.hoursWithoutStreak).filter((L) => L in g.hoursWithStreak);
	out['streak-r2-grinder'] = mdTable(['Level', 'Grinder without streak', 'with streak', 'Shift'], gl.map((L) => [L, hrs(g.hoursWithoutStreak[L]), hrs(g.hoursWithStreak[L]), pct((g.hoursWithoutStreak[L] - g.hoursWithStreak[L]) / g.hoursWithoutStreak[L], 2)])) +
		`\n\nVerdict: **${g.verdict}** Regular player with the streak: ${Object.entries(g.regularHours).map(([L, h]) => `L${L} ${hrs(h)} (window ${F.TARGET_WINDOWS[L].join('–')} h)`).join(', ')}.`;

	// T1 parts.
	out['streak-t1-parts'] = mdTable(['Figure', 'Value'], [
		['Uncommon parts per Streak Crate', fx(t1.uncommonPartsPerCrate)],
		['Chance per crate slot', Object.entries(t1.slotChancePerCrateSlot).map(([k, v]) => `${k.replace('part_', '')} ${pct(v)}`).join(', ')],
		['Days of crates to collect all four slot types', `median ${t1.medianDays}, mean ${fx(t1.expectedDays, 1)}, P90 ${t1.p90Days}`],
		['T1 assembly the set would save', `${usd(t1.t1AssemblyCost)} (\`rods.assembly(1)\`, Lv ${t1.t1Level})`],
		...ARCHETYPE_NAMES.map((a) => [`${cap(a)}: reaches Lv ${t1.t1Level} on day (integrated) / set complete by then`, `day ${t1.daysToTier1Level[a]} / ${pct(t1.pSetCompleteByTier1Level[a] || 0, 0)}`]),
	]) + `\n\n${t1.note}. The integrated lifecycle books these parts at salvage (counting rule), so a set that saves the T1 assembly is an upside the lifecycle tables do not count.`;

	// Quests interplay.
	out['streak-quests'] = mdTable(['Daily band', 'Fish per cast at the band\'s gear', 'Daily Catch: fish', 'casts', 'Daily Rare Hunt: target', 'median fish', 'median casts', 'Completing the daily meets the gate?'], R.quests.map((q) => [
		`${q.band} (${q.biome})`, fx(q.fishPerCast), q.catchFish, fx(q.catchCasts, 1), q.rareTarget, q.rareFishP50, fx(q.rareCastsP50, 1),
		`Catch ${q.catchMeetsGate ? 'yes' : '**no**'}; Rare Hunt (median) ${q.rareP50MeetsGate ? 'yes' : '**no**'}`,
	])) + `\n\nFrom \`quests.templateTerms()\`; the gate is ${G} successful casts.`;

	// Founder.
	out['streak-founder'] = mdTable(['Stage', 'Crate: normal', 'Founder', 'ratio', 'Legendary+ per crate: normal', 'Founder', 'Chest: normal', 'Founder', 'ratio'], fv.stages.map((s) => [
		`${s.biome} (Lv ${s.level})`, usd(s.crate.normal), usd(s.crate.founder), `${fx(s.crate.ratio, 1)}×`, fx(s.crate.normalLegendaryPlus, 3), fx(s.crate.founderLegendaryPlus, 3), usd(s.chest.normal), usd(s.chest.founder), `${fx(s.chest.ratio, 1)}×`,
	])) + `\n\nLiquid value (fish + salvage). Founder: the Founder profile (\`${fv.profile.source}\`${fv.profile.variant ? `, ${fv.profile.variant}` : ''}): gacha stats ${Object.entries(fv.profile.gachaStats).map(([k, v]) => `${k} +${pct(v, 0)}`).join(', ')}${fv.profile.buffSlots === 'normal' ? ' on non-buff slots only (buffs at normal odds)' : ''}, sell ×${fv.profile.sell} (today's profile: ×${fv.profile.todaySell}). Founder pity is not modelled (it can only raise these).`;

	// Founder: what the public /open reveal shows.
	const rv = fv.reveal;
	const pityText = fv.profile.gachaPity ? `The Founder gacha pity (a Legendary+ slot ramps from open ${fv.profile.gachaPity.softStart} and is certain by open ${fv.profile.gachaPity.hard} without one) is not modelled: it can only raise the Founder column.` : 'The Founder profile has no gacha pity.';
	out['streak-founder-reveal'] = mdTable(['Opens shown on the public /open reveal', 'Normal: holds a Legendary/Lucky slot', 'Founder', 'Founder ÷ normal'], [
		[P.ladder.dailyBox, pct(rv.crate.normal, 2), pct(rv.crate.founder, 2), `${fx(rv.crate.ratio, 1)}×`],
		[P.ladder.milestoneBox, pct(rv.chest.normal, 2), pct(rv.chest.founder, 2), `${fx(rv.chest.ratio, 1)}×`],
		[`One ${P.ladder.cycle}-day cycle (${P.ladder.cycle - 1} crates + 1 chest): at least one`, pct(rv.cycle.normal, 1), pct(rv.cycle.founder, 1), `${fx(rv.cycle.ratio, 1)}×`],
	]) + `\n\nAt Lv ${rv.level}, from \`boxEV\` slot tables (${rv.sameAtEveryStage ? 'the same at every live stage' : '**differs by stage**'}). Surface: ${rv.surface}. ${pityText}`;

	// Top.gg.
	out['streak-topgg'] = mdTable(['Player', 'Votes/day', 'Today (Phase 5 simulation, 30 d): votes vs fishing', 'Today\'s vote rule on the new value model (integrated, 30 d)', 'Proposed streak (integrated, 30 d)'], Object.keys(todayC).map((a) => {
		const t = todayC[a];
		const p = tg.newValueModel[a];
		return [cap(a), t.votesPerDay, `${usd(t.votes30d)} vs ${usd(t.fishing30d)} (**${pctAuto(t.votesShareOfFishing)}**)`, `${usd(p.topggRule30d)} vs ${usd(p.fishing30d)} (**${pctAuto(p.topggShareOfFishing)}**)`, `${usd(p.streak30d)} (**${pct(p.streakShareOfFishing)}**)`];
	}));

	// Validation.
	const rp = R.recorderParity;
	const ct = R.creditTiming;
	const sp = R.systemParity;
	out['streak-validation'] = mdTable(['Check', 'Result', 'Detail'], [
		['Recorder is observational (live)', rp.exact ? 'exact' : '**differs**', `integratedRun() vs integrate.run() for ${Object.keys(rp.rows).join(', ')}: milestone hours, timeline and every ledger entry identical (${Object.values(rp.rows).map((r) => r.milestones).reduce((a, b) => a + b, 0)} milestones)`],
		['Buffs counted once (live)', R.checks.list.find((c) => c.id === 'buffs-counted-once').pass ? 'yes' : '**no**', 'every buff unit the streak grants is received by the buffs system; the streak\'s ledger holds only its non-buff contents'],
		['Credit timing: \'gate\' vs \'dayEnd\' (live)', ct.maxMilestoneShift === 0 ? 'no milestone moves' : `milestones move ≤ ${pct(ct.maxMilestoneShift, 2)}`, `the box on the qualifying cast instead of after the session; 30-day streak value changes by at most ${pct(ct.maxStreakValueChange, 1)} (${ARCHETYPE_NAMES.map((a) => `${a} ${pct(ct.rows[a].streakValue30dChange, 1)}`).join(', ')})`],
		['Parity with the retired private loop (record)', `${sp.archetypes.exactMilestoneHours} milestones step-exact; max relative difference ${sp.archetypes.maxRelativeDifference}`, `${sp.source}. Scope: ${sp.archetypes.scope}; R2 verdicts ${Object.values(sp.r2.verdicts).join('/')} (unchanged); archetype and grinder R2 rows max relative difference ${sp.r2.archetypesAndGrinderMaxRelativeDifference}`],
		['One rule differed (record)', `minimum-daily streak cash ≤ ${pct(sp.r2.minimumDailyMaxRelativeDifference, 1)}`, `${cap(sp.cause)}. Its fixed ${sp.minimumDaily.oldFixedSession.sessionMinutes}-minute minimum-daily session fell below the gate on ${sp.minimumDaily.oldFixedSession.belowGateDays} of ${sp.minimumDaily.days} days (floating-point day boundaries): the core credited ${sp.minimumDaily.oldFixedSession.credited}, the old loop ${sp.minimumDaily.oldLoopCredited}; the core is right. \`F.MINIMUM_DAILY\` meets the gate every day (${sp.minimumDaily.sharedSession.credited} of ${sp.minimumDaily.days}). A replay with the old rule (\`${sp.replay.rule}\`) was exact: ${sp.replay.exactMilestoneHours} milestones, max relative difference ${sp.replay.maxRelativeDifference}`],
	]);

	// Checks.
	const fmtVal = (c) => {
		if (c.value === undefined) return '—';
		if (c.id === 'milestones-covered') return `Lv ${c.value} reached by every archetype`;
		if (c.id === 'regular-in-windows-with-streak') return Object.entries(c.value).map(([L, h]) => `L${L} ${hrs(h)}`).join(', ');
		if (c.id === 't1-set-not-free-for-regular') return `median ${c.value.medianDays} days; regular at Lv ${t1.t1Level} on day ${c.value.regularTier1Day}`;
		if (typeof c.value === 'number') return pct(c.value, 2);
		if (Array.isArray(c.value)) return c.value.map((x) => pct(x)).join(' > ');
		return Object.entries(c.value).map(([k, v]) => `${k} ${pct(v, 2)}`).join(', ');
	};
	const fmtTarget = (c) => (c.band ? `${pct(c.band[0], 0)}–${pct(c.band[1], 0)}` : c.max !== undefined ? `≤ ${pct(c.max, 2)}` : c.min !== undefined ? `median ≥ ${c.min} days, and after the regular player's T1 day` : '—');
	out['streak-checks'] = mdTable(['Check', 'Value', 'Target', 'Pass'], R.checks.list.map((c) => [`\`${c.id}\``, fmtVal(c), fmtTarget(c), c.pass ? 'pass' : '**FAIL**'])) +
		`\n\n\`checks().pass\`: **${R.checks.pass}**.`;
	return out;
}

module.exports = {
	PARAMS, DECISIONS, SYSTEM_PARITY,
	dayIndex, defaultState, boxForDay, applyGap, advanceStreak, onSuccessfulCast,
	boxDefinitions, legacyVotersCrate, boxEV, boxContents,
	stageRates, streakValue, perClaimValue, minimumDailyArchetype,
	attendanceModel, attendanceTable,
	SYSTEM_NAME, CASH_SOURCE, system, integratedRun, lifecycle, recorderParity,
	archetypeValue, r2, t1PartsFromStreak, topggComparison, founderView, questInterplay, creditTiming, ruleExamples,
	jackpots, doubleXpDayShare, checks,
	report, markdownTables,
};

if (require.main === module) process.stdout.write(`${JSON.stringify(module.exports.report(), null, 1)}\n`);
