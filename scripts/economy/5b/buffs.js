// Phase 5B subsystem: BUFFS (Double XP, Double Cash, Lucky Draw) and the Double Cash timing decision
// (user decision 8). ANALYSIS ONLY: nothing here touches the live game, src/ or production data.
//
// Every economic number is computed at runtime from the shared framework (./framework.js, which
// re-exports assumptions.js) and from finished-design exports: streak.js (box buff odds, the streak
// ladder, the minimum-daily player), quests.js (Daily Boxes per day) and rods.js crate helpers
// (crate definitions, exact open outcomes, crate prices, stage income; never a gear source, R3).
// Only the buff design parameters in PARAMS are hand-set. A framework bump regenerates every figure.
//
//   node -e "require('./scripts/economy/5b/buffs.js').report()"     (returns the report object)
//   node scripts/economy/5b/buffs.js                                  (prints it as JSON)
//
// Exports (pure and synchronous; no database, no randomness):
//   PARAMS                        frozen design parameters: Double Cash timing, per-buff kind, multiplier
//                                 and duration model, stacking rules, sources and event budget,
//                                 alternatives evaluated (sale-time cap, casts-based duration), targets
//   --- engine rules (the implementation mirrors these exactly; test cases in ruleExamples()) ---
//   defaultState()                buff state of a player with no activations (read-time default)
//   activate(state, name, nowMs)  consumes ONE unit from stock and starts/extends that kind's timer or
//                                 charges (same kind queues, at most PARAMS.stacking.maxQueued); pure
//   effectsAt(state, nowMs)       active multipliers { xp, cash, gachaBonusSlots } with read-time expiry
//   consumeOpen(state, nowMs, box)
//                                 one open of `box`: bonus slots for it + the state with a charge used
//                                 (excluded boxes use no charge)
//   temporaryMultiplier(buffMult, eventMult)
//                                 the buff/event stacking rule (additive bonuses: x2 buff + x2 event = x3)
//   catchValue({ rawValue, sellBonus, buffCash, eventSell, profileSell })
//                                 the catch-time stamp: { base (public), final (account), buffBonus }
//   catchXp({ baseXp, xpBonus, buffXp, eventXp, profileXp })
//                                 the same split for catch XP (Double XP never touches quest XP)
//   legacyKind(capabilities)      read-time mapping of legacy catalog capabilities to a proposed kind
//   ruleExamples()                worked traces of the rules above (the regression-test table)
//   --- model ---
//   boxBuffOdds(box, level, {profile})
//                                 expected buffs of each type per open (streak.boxEV; exact)
//   arrivals(day, level, tier, archetype, sources)
//                                 expected buffs received on one played day, by type and source
//   bonusSlotValue(box, level)    liquid value (fish + salvage) of one extra non-guaranteed slot
//   luckyAssembly(t, {opens, mode})
//                                 exact expected tier-t crates to assemble the rods reference set when the
//                                 first `opens` opens are lucky (mode 'slot' = proposed bonus slot,
//                                 'luck' = today's +50% rare+ weights); K = 0 reproduces rods exactly
//   luckyDrawValue(t)             proposed Lucky Draw value on tier t's assembly: crates, $, stage hours
//   lifecycle(archetype, opts)    curve.js-style lifecycle (same stepping; reproduces curve.json with
//                                 buffs off and streak.lifecycle's buff figures with streak-only sources)
//                                 with buff arrivals, Double XP XP, Double Cash and Lucky Draw value
//   doubleCashModels(archetype, {days})
//                                 decision 8: catch-time (proposed), buff-saver bound, casts-based
//                                 alternative, sale-time non-hoarder, sale-time hoarder uncapped (exact
//                                 renewal DP) and capped; shares of fishing income; Double XP share under
//                                 the wall-clock and casts-based duration models
//   saleTimeHoarder(rows, {capHours})
//                                 sale-time hoarder bonus from lifecycle rows (uncapped: exact renewal DP;
//                                 capped: sells the capped amount under each buff)
//   buffIncomeShare(archetype, {days, sources})
//                                 INTEGRATOR ENTRY POINT: share of fishing income (cash) and of XP that
//                                 buffs add, by buff and by source, over the first `days` days
//   valuePerBuff(level, archetype)
//                                 one buff of each type at a stage: $ / XP and minutes of own play
//   current()                     today's buffs: catalog, measured box odds, buffs per 30 days, bugs,
//                                 today's stacking (engine buffEffects), Lucky Draw inertness
//   r2()                          INTEGRATION_REQUIREMENTS R2 for the buff layer: XP decomposition,
//                                 minimum-daily player, no-miss grinder, windows shift, verdicts
//   founderView()                 Founder buff odds (gacha luck) and the public-level drift they imply
//   minimumDailyArchetype()       the R2 adversary: streak.minimumDailyArchetype() (20 casts a day), flagged
//                                 so its daily quest counts as completed (upper bound on Daily Boxes)
//   baselineMatchesCurveJson(), reconcileWithStreak()
//                                 validation of the lifecycle against curve.json and streak.js
//   --- framework 5b.3: the buffs SYSTEM on the shared lifecycle core (lifecycle.js) ---
//   system(opts)                  a FRESH lifecycle.js system (per-run state in state.sys.buffs only): buff
//                                 units from 'box' events (boxBuffOdds) and the F.EVENTS budget; Double XP /
//                                 Double Cash activated at the session start, their window counted in play
//                                 minutes, the BONUS credited per step (XP 'buff' final/base, cash 'buff');
//                                 Lucky Draw as cash 'luckyDraw' (assembly rebate on the rods 'assembly'
//                                 event, surplus on Streak Crates). No sinks. See the system() comment.
//   validateSystem()              system() on the core vs lifecycle() (exact replay with lifecycle()'s
//                                 conventions; the design defaults with differences explained), shares
//                                 vs buffIncomeShare(), streak reconciliation (buff value counted once)
//   SYSTEM_NAME, SYSTEM_DEFAULTS, LIFECYCLE_CONVENTIONS, LEDGER_SOURCES, coverage(), coreRun()
//   checks()                      design-target checks (pass/fail)
//   report()                      every number in docs/economy/5b/buffs.md (cached), with ...F.stamp();
//                                 report().system holds the system description and validateSystem()
const F = require('./framework');
const LC = require('./lifecycle');
const streak = require('./streak');
const quests = require('./quests');
const rods = require('./rods');
const { buildTable } = require('../../../src/engine/rarity');
const { RARITIES, PROFILES } = require('../../../src/engine/balance');
const { BOXES } = require('../../../src/engine/gachaBoxes');
const { buffEffects: engineBuffEffects } = require('../../../src/engine/modifiers');
const BUFF_CATALOG = require('../../../src/bootstrap/data/buffs');
const GACHA_EV = require('../../../docs/economy/gacha-ev.json');
const CURVE_JSON = require('../../../docs/economy/5b/curve.json');

const deepFreeze = (o) => {
	for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
	return Object.freeze(o);
};
const round = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const BUFF_NAMES = ['Double XP', 'Double Cash', 'Lucky Draw'];

// ---------------------------------------------------------------------------------------------
// Design parameters (the only hand-set numbers in this subsystem). 5b.3: the rules this design proposed
// for the framework are now the SHARED F.BUFFS (timing, duration, multipliers, Lucky Draw, stacking) and
// F.EVENTS (event budget); they are read from there (copied, so deepFreeze never freezes the shared
// objects), never restated here. Same values as 5b.2.
const PARAMS = deepFreeze({
	id: 'buffs-5b',
	// The rule every choice below follows: a buff multiplies PLAY inside its window, never a STOCKPILE
	// built outside it (hoarded fish sold at x2, hoarded boxes opened in one lucky hour).
	principle: 'A buff multiplies play, never a stockpile.',
	// Decision 8: Double Cash rewards fish CAUGHT during the buff. The bonus is stamped into the fish's
	// stored value at catch (like every other sell modifier today), so the sale path never reads buffs.
	// PROPOSED (decisions.js P-DOUBLE-CASH).
	doubleCash: { timing: F.BUFFS.doubleCashTiming },
	catalog: {
		'Double XP': { kind: 'xp', multiplier: F.BUFFS.multipliers.xp, duration: { type: 'wallclock', seconds: F.BUFFS.durationSeconds }, applies: 'XP of fish caught by casting (never quest XP, never box fish)' },
		'Double Cash': { kind: 'cash', multiplier: F.BUFFS.multipliers.cash, duration: { type: 'wallclock', seconds: F.BUFFS.durationSeconds }, applies: 'value of fish caught by casting, stamped into the stored value (never quest cash, box fish or items)' },
		// Lucky Draw: today's +50% rare+ weights are inert on floored crates (see current()); proposed: one
		// bonus slot on each of the next `opens` box opens, any box.
		// The Booster Pack keeps its exact contents (decision 12): a Lucky Draw charge is not used on it.
		'Lucky Draw': { kind: 'gacha', bonusSlots: F.BUFFS.luckyDraw.bonusSlots, duration: { type: 'charges', opens: F.BUFFS.luckyDraw.opens }, excludeBoxes: ['Booster Pack'], applies: 'the next box opens (any box, including legacy Voter\'s Crates; not the Booster Pack)' },
	},
	stacking: {
		// A second buff of a running kind queues behind it (extends the timer or adds charges) instead of
		// stacking its multiplier; at most `maxQueued` durations can be banked per kind.
		sameKind: F.BUFFS.stacking.sameKind,
		maxQueued: F.BUFFS.stacking.maxQueued,
		acrossKinds: 'independent',
		// Temporary boosts in one category ADD their bonuses: x2 buff during a x2 event pays x3, not x4.
		withEvent: F.BUFFS.stacking.withEvent,
		// Gear/aquarium stats and the private profile keep multiplying, as today.
		withGearAndProfile: F.BUFFS.stacking.withGearAndProfile,
	},
	sources: {
		// Streak Crate / Streak Chest pools exactly as the streak design proposes (buff odds via streak.boxEV).
		streak: { from: 'streak.js' },
		// Daily/weekly quest Daily Boxes (quests.js questIncome().boxes), today's Daily Box pool unchanged.
		quests: { from: 'quests.js' },
		// The deliberate, tunable lever: an event calendar grants at most this many buffs per 30 days to
		// players who fish during the event. No Double XP from events (XP events use event multipliers).
		// PROPOSED (decisions.js P-EVENTS): the shared F.EVENTS budget.
		events: { perThirtyDays: { ...F.EVENTS.buffsPerThirtyDays } },
		// Booster Pack: Easter egg, unchanged, never valued (decision 12). No shop sale of buffs.
		boosterPack: { valued: false },
		shop: false,
	},
	// Lucky Draw use in the lifecycle: one saved for the next tier assembly while a tier is ahead, the
	// surplus spent on Streak Crates.
	luckyDrawReserve: 1,
	// Alternatives evaluated for decision 8 (not proposed).
	alternatives: {
		// Sale-time Double Cash with a bounded bonus: at most this many hours of the player's stage income
		// (reference cadence) per buff.
		saleTimeCapHours: 1,
		// Casts-based duration: this many reference hours of casts (F.COOLDOWN + F.DESIGN_OVERHEAD_S).
		castsReferenceHours: 1,
		luckyDrawOpens: [1, 2, 3],
	},
	// Design targets checked by checks(); shares are of the archetype's own fishing income / XP.
	targets: {
		cashShareMax30d: { casual: 0.08, regular: 0.08, active: 0.05, grinder: 0.03 },
		xpShareMax: 0.03,
		windowShiftMax: 0.03,
		buffsPerThirtyDays: [3, 6],
		luckyDrawMinHoursAnyTier: 0.15,
	},
});

const ALL_SOURCES = ['streak', 'quests', 'events'];
const buffOf = (name) => PARAMS.catalog[name];
const windowHours = (name) => (buffOf(name).duration.type === 'wallclock' ? buffOf(name).duration.seconds / 3600 : 0);

// ---------------------------------------------------------------------------------------------
// Engine rules (pure). State: { stock: { [name]: units }, active: { [kind]: { name, multiplier,
// endsAt | chargesLeft, bonusSlots } } }. The engine stores `active` on the user (additive field) and
// keeps stock in the existing BuffData stacks (`count`).
const defaultState = () => ({ stock: {}, active: {} });

const isLive = (a, nowMs) => Boolean(a) && (a.endsAt !== undefined ? a.endsAt > nowMs : a.chargesLeft > 0);

/** Activates one unit of `name`: consumes it and starts or extends (queues) its kind. */
function activate(state, name, nowMs) {
	const def = buffOf(name);
	if (!def) return { ok: false, reason: 'UNKNOWN_BUFF', state };
	const stock = state.stock?.[name] || 0;
	if (stock < 1) return { ok: false, reason: 'NO_STOCK', state };
	const cur = state.active?.[def.kind];
	const live = isLive(cur, nowMs) && cur.name === name ? cur : null;
	if (isLive(cur, nowMs) && cur.name !== name) return { ok: false, reason: 'OTHER_BUFF_OF_KIND_ACTIVE', state };
	let next;
	if (def.duration.type === 'wallclock') {
		const ms = def.duration.seconds * 1000;
		const start = live ? live.endsAt : nowMs;
		if (start - nowMs + ms > PARAMS.stacking.maxQueued * ms) return { ok: false, reason: 'QUEUE_FULL', state };
		next = { name, multiplier: def.multiplier, endsAt: start + ms };
	}
	else {
		const add = def.duration.opens;
		const have = live ? live.chargesLeft : 0;
		if (have + add > PARAMS.stacking.maxQueued * add) return { ok: false, reason: 'QUEUE_FULL', state };
		next = { name, bonusSlots: def.bonusSlots, chargesLeft: have + add };
	}
	return {
		ok: true,
		reason: live ? 'EXTENDED' : 'STARTED',
		state: { stock: { ...state.stock, [name]: stock - 1 }, active: { ...state.active, [def.kind]: next } },
	};
}

/** Active effects at `nowMs` (expired timers and spent charges have no effect, whatever `active` says). */
function effectsAt(state, nowMs) {
	const a = state.active || {};
	return {
		xp: isLive(a.xp, nowMs) ? a.xp.multiplier : 1,
		cash: isLive(a.cash, nowMs) ? a.cash.multiplier : 1,
		gachaBonusSlots: isLive(a.gacha, nowMs) ? a.gacha.bonusSlots : 0,
	};
}

/** One open of `box`: bonus slots for it, and the state with one charge used (once per open journal). */
function consumeOpen(state, nowMs, box = null) {
	const g = state.active?.gacha;
	if (!isLive(g, nowMs) || (box && (buffOf(g.name).excludeBoxes || []).includes(box))) return { bonusSlots: 0, state };
	return { bonusSlots: g.bonusSlots, state: { ...state, active: { ...state.active, gacha: { ...g, chargesLeft: g.chargesLeft - 1 } } } };
}

/** Buff/event stacking rule inside one category: bonuses add. */
const temporaryMultiplier = (buffMult = 1, eventMult = 1) => 1 + (buffMult - 1) + (eventMult - 1);

/**
 * Catch-time value stamp. base = what the public sees (no private profile), final = what the account
 * stores and is paid on sale. Gear/aquarium sellBonus and the profile multiply; buff and event add.
 */
function catchValue({ rawValue, sellBonus = 0, buffCash = 1, eventSell = 1, profileSell = 1 }) {
	const temp = temporaryMultiplier(buffCash, eventSell);
	const base = Math.round(rawValue * (1 + sellBonus) * temp);
	const final = Math.round(rawValue * (1 + sellBonus) * temp * profileSell);
	const withoutBuff = Math.round(rawValue * (1 + sellBonus) * temporaryMultiplier(1, eventSell));
	return { base, final, buffBonus: base - withoutBuff, temporaryMultiplier: temp };
}

/** Catch XP split (quest XP never takes a buff). */
function catchXp({ baseXp, xpBonus = 0, buffXp = 1, eventXp = 1, profileXp = 1 }) {
	const temp = temporaryMultiplier(buffXp, eventXp);
	const base = Math.floor(baseXp * (1 + xpBonus) * temp);
	return { base, final: Math.floor(baseXp * (1 + xpBonus) * temp * profileXp), temporaryMultiplier: temp };
}

/** Legacy catalog capabilities -> proposed kind (read-time; no document is rewritten). */
function legacyKind(capabilities = []) {
	const [kind] = capabilities;
	const name = Object.keys(PARAMS.catalog).find((n) => buffOf(n).kind === kind);
	return name ? { name, ...buffOf(name) } : null;
}

function ruleExamples() {
	const t0 = Date.UTC(2026, 8, 25, 12);
	const H = 3_600_000;
	const s0 = { stock: { 'Double Cash': 2, 'Lucky Draw': 1 }, active: {} };
	const a1 = activate(s0, 'Double Cash', t0);
	const a2 = activate(a1.state, 'Double Cash', t0 + H / 2);
	const noStock = activate(a2.state, 'Double Cash', t0 + H);
	const expired = effectsAt(a2.state, t0 + 2.5 * H + 1);
	let q = { state: { stock: { 'Double XP': PARAMS.stacking.maxQueued + 1 }, active: {} } };
	for (let i = 0; i < PARAMS.stacking.maxQueued; i++) q = activate(q.state, 'Double XP', t0);
	const full = activate(q.state, 'Double XP', t0);
	const l1 = activate(s0, 'Lucky Draw', t0);
	const o1 = consumeOpen(l1.state, t0, 'Master Tackle Crate');
	const ob = consumeOpen(o1.state, t0, 'Booster Pack');
	const o2 = consumeOpen(ob.state, t0, 'Streak Crate');
	const o3 = consumeOpen(o2.state, t0, 'Daily Box');
	return [
		{ case: 'activate consumes one unit', before: 'stock Double Cash 2', event: 'activate at t0', after: `stock ${a1.state.stock['Double Cash']}, ends t0 + ${(a1.state.active.cash.endsAt - t0) / H} h (seconds, not ms)` },
		{ case: 'same kind queues', before: 'Double Cash running until t0 + 1 h', event: 'activate another at t0 + 0.5 h', after: `${a2.reason}: ends t0 + ${(a2.state.active.cash.endsAt - t0) / H} h, multiplier stays x${a2.state.active.cash.multiplier}` },
		{ case: 'no unit, no buff', before: 'stock 0', event: 'activate', after: noStock.reason },
		{ case: 'read-time expiry', before: 'active flag still set', event: 'cast at t0 + 2.5 h', after: `cash multiplier x${expired.cash}` },
		{ case: 'queue bound', before: `${PARAMS.stacking.maxQueued} Double XP activated at t0 (ends t0 + ${(q.state.active.xp.endsAt - t0) / H} h)`, event: 'activate one more', after: `${full.reason}, stock kept at ${full.state.stock['Double XP']}` },
		{ case: 'Lucky Draw charges', before: 'stock Lucky Draw 1', event: 'activate, then open Master Tackle Crate, Booster Pack, Streak Crate, Daily Box', after: `bonus slots per open: ${[o1.bonusSlots, ob.bonusSlots, o2.bonusSlots, o3.bonusSlots].join(', ')} (the Booster Pack uses no charge)` },
		{ case: 'buff + event', before: 'Double Cash x2, event sell x2', event: 'catch a $100 fish (no gear bonus)', after: `stored $${catchValue({ rawValue: 100, buffCash: 2, eventSell: 2 }).final} (x3, not x4)` },
		{ case: 'gear and profile multiply', before: 'Double Cash, handle +5%, private profile x10', event: 'catch a $100 fish', after: `public $${catchValue({ rawValue: 100, sellBonus: 0.05, buffCash: 2, profileSell: 10 }).base}, stored $${catchValue({ rawValue: 100, sellBonus: 0.05, buffCash: 2, profileSell: 10 }).final}` },
		{ case: 'sale pays the stored value', before: 'fish caught under Double Cash, sold later', event: 'sell with no buff active', after: 'paid the stored value (x2 already in it); a fish caught before the buff is never doubled' },
	];
}

// ---------------------------------------------------------------------------------------------
// Stage rates (the same castOutcome/hourly call as curve.js).
const rateCache = new Map();
/** Cache key of a gear tier by content (the provisional and the rods path share tier numbers and keys). */
const tierKey = (tier) => JSON.stringify([tier.qualities, tier.stats, tier.meanFish]);
function rates(biome, tier, overheadS) {
	const key = `${biome}|${tierKey(tier)}|${overheadS}`;
	if (!rateCache.has(key)) {
		const o = F.castOutcome({ biome, qualities: tier.qualities, stats: tier.stats, multiChance: F.chanceForMean(tier.meanFish) });
		rateCache.set(key, { ...F.hourly(o, overheadS), valuePerCast: o.valuePerCast });
	}
	return rateCache.get(key);
}
const archOf = (a) => (typeof a === 'string' ? F.ARCHETYPES[a] : a) || F.ARCHETYPES[F.REFERENCE_ARCHETYPE];
const minimumDailyArchetype = () => ({ ...streak.minimumDailyArchetype(), minimumDaily: true });
/** Casts in one reference hour (Old Rod cooldown + design overhead): the casts-based alternative. */
const referenceCastsPerHour = () => 3600 / (F.COOLDOWN.fishMs / 1000 + F.DESIGN_OVERHEAD_S);

// ---------------------------------------------------------------------------------------------
// Sources.
const oddsCache = new Map();
/** Expected buffs of each type in one open of `box` (a name or a definition) at `level`. */
function boxBuffOdds(box, level = 0, { profile = 'normal' } = {}) {
	const key = `${typeof box === 'string' ? box : box.id}|${F.biomeAt(level)}|${profile}`;
	if (!oddsCache.has(key)) {
		const ev = streak.boxEV(box, { level, profile });
		oddsCache.set(key, Object.fromEntries(BUFF_NAMES.map((n) => [n, ev.buffs[n] || 0])));
	}
	return oddsCache.get(key);
}
const DAILY_BOX = BOXES['Daily Box'];
const VOTERS_TODAY = BOXES['Voter\'s Crate'];

const questBoxCache = new Map();
function questBoxesPerDay(level, tier, arch) {
	const band = quests.bandFor(level).id;
	const key = `${band}|${tierKey(tier)}|${arch.minutesPerDay}|${arch.overheadS}|${Boolean(arch.minimumDaily)}`;
	if (!questBoxCache.has(key)) {
		const r = rates(F.biomeAt(level), tier, arch.overheadS);
		const hours = arch.minutesPerDay / 60;
		questBoxCache.set(key, quests.questIncome(level, r.fish * hours, hours, { assumeDailyComplete: Boolean(arch.minimumDaily) }).boxes);
	}
	return questBoxCache.get(key);
}

/**
 * Expected buffs received on streak/calendar day `day` by a player at `level` holding gear `tier`.
 * sources: 'streak' | 'quests' | 'events' (proposed) and 'todayDailyBox' | 'todayVotes' (today).
 */
function arrivals(day, level, tier, archetype, sources = ALL_SOURCES) {
	const arch = archOf(archetype);
	const out = Object.fromEntries(BUFF_NAMES.map((n) => [n, {}]));
	const add = (source, odds, times) => {
		for (const n of BUFF_NAMES) out[n][source] = (out[n][source] || 0) + odds[n] * times;
	};
	if (sources.includes('streak')) add('streak', boxBuffOdds(streak.boxForDay(day), level), 1);
	if (sources.includes('quests')) add('quests', boxBuffOdds(DAILY_BOX, level), questBoxesPerDay(level, tier, arch));
	if (sources.includes('events')) add('events', Object.fromEntries(BUFF_NAMES.map((n) => [n, PARAMS.sources.events.perThirtyDays[n] / 30])), 1);
	// Today's live sources: one Daily Box per day (the daily quest) and a Voter's Crate every 12 h.
	if (sources.includes('todayDailyBox')) add('todayDailyBox', boxBuffOdds(DAILY_BOX, level), 1);
	if (sources.includes('todayVotes')) add('todayVotes', boxBuffOdds(VOTERS_TODAY, level), 2);
	const total = Object.fromEntries(BUFF_NAMES.map((n) => [n, sum(Object.values(out[n]))]));
	return { bySource: out, total };
}

// ---------------------------------------------------------------------------------------------
// Lucky Draw.
const slotCache = new Map();
/**
 * Liquid value (fish + part salvage) of one extra, non-guaranteed slot of `box` at `level`. profile
 * 'founder' (5b.3 system): the Founder gacha stats (streak.boxEV) and its fish sold at the PROPOSED
 * Founder sell multiplier (founder.founderProfile(), as streak.boxContents values a Founder's box).
 */
function bonusSlotValue(box, level = 0, { profile = 'normal' } = {}) {
	const def = typeof box === 'string' ? streak.boxDefinitions()[box] || (box === 'Daily Box' ? DAILY_BOX : null) : box;
	const key = `${def.id}|${level}|${profile}`;
	if (!slotCache.has(key)) {
		const ev = streak.boxEV({ ...def, id: `${def.id}+1`, slots: 1, guaranteedSlots: [] }, { level, profile });
		const sell = profile === 'founder' ? require('./founder').founderProfile().multipliers.sell / PROFILES.founder.multipliers.sell : 1;
		slotCache.set(key, profile === 'founder' ? ev.fishValue * sell + ev.salvage : ev.liquid);
	}
	return slotCache.get(key);
}

const rankOf = (r) => rods.RARITY_ORDER.map((x) => x.toLowerCase()).indexOf(String(r).toLowerCase());
const SLOT_OF_TYPE = Object.fromEntries(Object.entries(rods.SLOTS).map(([s, t]) => [t, s]));
const TODAY_LUCKY_STATS = (() => {
	// Today's Lucky Draw: gacha.js adds (multiplier - 1) to rareFind, trophyChance and luck.
	const cat = BUFF_CATALOG.find((b) => b.name === 'Lucky Draw');
	const bonus = (parseFloat(cat.capabilities[1]) || 1) - 1;
	return { rareFind: bonus, trophyChance: bonus, luck: bonus };
})();
const luckyDef = (def, mode) => (mode === 'slot'
	? { ...def, id: `${def.id}+slot`, slots: def.slots + buffOf('Lucky Draw').bonusSlots }
	: { ...def, id: `${def.id}+luck`, rarityTable: buildTable(def.rarityTable, TODAY_LUCKY_STATS) });

const assemblyCache = new Map();
/**
 * Exact expected crates to assemble tier t's reference set (rods.assembly(t).needs) when the first
 * `opens` opens are lucky. Mirrors rods.cratesDistribution (same Markov chain over collected slots and
 * the box pity counter, same openOutcomes); opens = 0 reproduces it exactly.
 */
function luckyAssembly(t, { opens = buffOf('Lucky Draw').duration.opens, mode = 'slot', maxN = 5000 } = {}) {
	const key = `${t}|${opens}|${mode}`;
	if (assemblyCache.has(key)) return assemblyCache.get(key);
	const base = rods.crateDefinition(t);
	const lucky = luckyDef(base, mode);
	const need = rods.assembly(t).needs.map((s) => {
		const [rarity, slot] = s.split(' ');
		return { rarity, slot };
	});
	const rule = Object.values(base.pity || {})[0] || null;
	const full = (1 << need.length) - 1;
	const hit = (picks) => need.reduce((m, n, j) => (picks.some((x) => SLOT_OF_TYPE[x.type] === n.slot && rankOf(x.rarity) >= rankOf(n.rarity)) ? m | (1 << j) : m), 0);
	const trans = new Map();
	const transFor = (def, c) => {
		const k = `${def.id}|${c}`;
		if (!trans.has(k)) {
			const agg = new Map();
			for (const o of rods.openOutcomes(def, rule ? c : null)) {
				const kk = `${hit(o.picks)}|${rule && o.picks.some((x) => rule.tiers.includes(x.rarity)) ? 1 : 0}`;
				agg.set(kk, (agg.get(kk) || 0) + o.p);
			}
			trans.set(k, [...agg.entries()].map(([kk, p]) => ({ mask: Number(kk.split('|')[0]), pityHit: kk.endsWith('|1'), p })));
		}
		return trans.get(k);
	};
	let state = new Map([['0|0', 1]]);
	let expected = 0;
	for (let n = 0; n < maxN; n++) {
		let alive = 0;
		for (const [k, p] of state) if (Number(k.split('|')[0]) !== full) alive += p;
		expected += alive;
		if (alive < 1e-12) break;
		const def = n < opens ? lucky : base;
		const next = new Map();
		for (const [k, p] of state) {
			const [mask, c] = k.split('|').map(Number);
			if (mask === full) continue;
			for (const tr of transFor(def, c)) {
				const nk = `${mask | tr.mask}|${rule ? (tr.pityHit ? 0 : c + 1) : 0}`;
				next.set(nk, (next.get(nk) || 0) + p * tr.p);
			}
		}
		state = next;
	}
	assemblyCache.set(key, expected);
	return expected;
}

const TIERS = [1, 2, 3, 4, 5];
/** Proposed Lucky Draw on tier t's assembly: crates saved, $ saved and hours of that stage's income. */
function luckyDrawValue(t, { opens = buffOf('Lucky Draw').duration.opens, mode = 'slot' } = {}) {
	if (!TIERS.includes(t)) return { tier: t, cratesSaved: 0, dollars: 0, stageHours: 0 };
	const e0 = luckyAssembly(t, { opens: 0 });
	const e1 = luckyAssembly(t, { opens, mode });
	const price = rods.cratePrice(t);
	const income = rods.stageIncome(t);
	return { tier: t, crate: rods.crateDefinition(t).name, price, expectedCrates: e0, expectedCratesLucky: e1, cratesSaved: e0 - e1, dollars: (e0 - e1) * price, stageHours: ((e0 - e1) * price) / income };
}

// ---------------------------------------------------------------------------------------------
// Lifecycle: curve.js's model (same step, gear purchase rule, biome choice, day boundary and
// provisional daily XP), with buff arrivals valued at the day boundary like streak.js values its boxes.
// 5b.3: superseded by system() on the shared core (validateSystem() replays it exactly); kept until the
// old loops are retired.
/**
 * @param {string|object} archetype  F.ARCHETYPES name/entry, or minimumDailyArchetype()
 * @param {object} opts sources (default proposed), dailyXp, applyXp (Double XP XP feeds the level),
 *   maxDays, maxLevel, snapshots, gearPath (default the shared F.gearPath(); baselineMatchesCurveJson()
 *   passes F.PROVISIONAL_GEAR_PATH, the path curve.json was fitted on)
 */
function lifecycle(archetype, { sources = ALL_SOURCES, dailyXp = true, applyXp = true, maxDays = Infinity, maxLevel = F.LIFECYCLE.maxLevel, snapshots = [7, 30, 90], gearPath = F.gearPath() } = {}) {
	const arch = archOf(archetype);
	const path = gearPath;
	const STEP_H = F.LIFECYCLE.stepH;
	const dayH = arch.minutesPerDay / 60;
	const upkeep = rods.PARAMS.repair.upkeepShare;
	const lucky = buffOf('Lucky Draw');
	let xp = 0;
	let h = 0;
	let tierIdx = 0;
	let saving = 0;
	let day = 0;
	let ldHeld = 0;
	let dayFishing = 0;
	let dayFishingXp = 0;
	let dayPurchase = 0;
	const xpBy = { fishing: 0, daily: 0, buff: 0 };
	const cashBy = { fishing: 0, doubleCash: 0, luckyDraw: 0 };
	const received = Object.fromEntries(BUFF_NAMES.map((n) => [n, 0]));
	const bySource = {};
	const luckyUse = { assembly: 0, streakCrate: 0, assemblyValue: 0, streakCrateValue: 0 };
	const rows = [];
	const reached = {};
	const at = {};
	const snap = {};
	const take = () => ({ level: F.levelForXp(xp), hours: round(h, 3), tier: path[tierIdx].key, xpBy: { ...xpBy }, cashBy: { ...cashBy }, received: { ...received }, bySource: JSON.parse(JSON.stringify(bySource)), luckyUse: { ...luckyUse } });
	const credit = (source, key, v) => {
		bySource[source] = bySource[source] || { 'Double XP': 0, 'Double Cash': 0, 'Lucky Draw': 0, doubleXpXp: 0, doubleCash: 0 };
		bySource[source][key] += v;
	};
	while (h < 5000) {
		const L = F.levelForXp(xp);
		const next = path[tierIdx + 1];
		const cur = path[tierIdx];
		const r = rates(F.biomeAt(L), cur, arch.overheadS);
		if (next && L >= next.level) {
			saving += r.cash * STEP_H;
			if (saving >= r.cash * F.PURCHASE.saveHours) {
				tierIdx++;
				saving = 0;
				dayPurchase += r.cash * F.PURCHASE.saveHours;
				// A held Lucky Draw goes into the new tier's crate assembly.
				const use = Math.min(1, ldHeld);
				if (use > 0) {
					const v = use * luckyDrawValue(next.tier).dollars;
					ldHeld -= use;
					luckyUse.assembly += use;
					luckyUse.assemblyValue += v;
					cashBy.luckyDraw += v;
				}
			}
		}
		xp += r.xp * STEP_H;
		xpBy.fishing += r.xp * STEP_H;
		cashBy.fishing += r.cash * STEP_H;
		dayFishing += r.cash * STEP_H;
		dayFishingXp += r.xp * STEP_H;
		const before = h;
		h += STEP_H;
		if (Math.floor(h / dayH) !== Math.floor(before / dayH)) {
			day++;
			const dailyToday = dailyXp ? F.DAILY.xpPerLevel * L : 0;
			xp += dailyToday;
			xpBy.daily += dailyToday;
			const arr = arrivals(day, L, cur, arch, sources);
			for (const n of BUFF_NAMES) {
				received[n] += arr.total[n];
				for (const [s, v] of Object.entries(arr.bySource[n])) credit(s, n, v);
			}
			// Double XP / Double Cash: each buff doubles min(its window, the day's play) at the current stage.
			const dxpXp = arr.total['Double XP'] * Math.min(windowHours('Double XP'), dayH) * r.xp * (buffOf('Double XP').multiplier - 1);
			const dc = arr.total['Double Cash'] * Math.min(windowHours('Double Cash'), dayH) * r.cash * (buffOf('Double Cash').multiplier - 1);
			for (const [s, v] of Object.entries(arr.bySource['Double XP'])) credit(s, 'doubleXpXp', arr.total['Double XP'] ? (dxpXp * v) / arr.total['Double XP'] : 0);
			for (const [s, v] of Object.entries(arr.bySource['Double Cash'])) credit(s, 'doubleCash', arr.total['Double Cash'] ? (dc * v) / arr.total['Double Cash'] : 0);
			if (applyXp) xp += dxpXp;
			xpBy.buff += dxpXp;
			cashBy.doubleCash += dc;
			// Lucky Draw: keep a reserve for the next tier assembly; the surplus goes on Streak Crates.
			ldHeld += arr.total['Lucky Draw'];
			const reserve = path[tierIdx + 1] ? PARAMS.luckyDrawReserve : 0;
			if (ldHeld > reserve) {
				const spend = ldHeld - reserve;
				const v = spend * lucky.duration.opens * bonusSlotValue('Streak Crate', L);
				ldHeld = reserve;
				luckyUse.streakCrate += spend;
				luckyUse.streakCrateValue += v;
				cashBy.luckyDraw += v;
			}
			rows.push({
				day, level: L, tier: cur.tier, biome: F.biomeAt(L), cashPerH: r.cash, xpPerH: r.xp, castsPerH: r.casts,
				refCashPerH: rates(F.biomeAt(L), cur, F.DESIGN_OVERHEAD_S).cash,
				fishing: dayFishing, purchase: dayPurchase, upkeep: cur.tier >= 1 ? upkeep * dayFishing : 0,
				fishingXp: dayFishingXp, dailyXp: dailyToday,
				lambda: { ...arr.total },
			});
			dayFishing = 0;
			dayFishingXp = 0;
			dayPurchase = 0;
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
	return { archetype: arch, reached, at, snapshots: snap, final: take(), days: day, rows };
}

// ---------------------------------------------------------------------------------------------
// Decision 8: Double Cash under each timing model, from the same daily rows.
/**
 * Sale-time hoarder. g = fish income minus mandatory upkeep and progression purchases (sold at x1 as
 * needed); everything else is hoarded and sold under the next Double Cash. Uncapped: exact renewal DP
 * over "day of the last hoard sale" (P(arrival on a day) = 1 - exp(-lambda)). Capped: the hoarder sells
 * exactly the capped amount under each buff and keeps the rest (mean-field; exact once hoard >= cap).
 */
function saleTimeHoarder(rows, { capHours = null } = {}) {
	const extra = buffOf('Double Cash').multiplier - 1;
	let bonus = 0;
	if (capHours === null) {
		let entries = [{ p: 1, hoard: 0 }];
		for (const r of rows) {
			const g = r.fishing - r.purchase - r.upkeep;
			const pa = 1 - Math.exp(-r.lambda['Double Cash']);
			let mass = 0;
			for (const e of entries) {
				e.hoard = Math.max(0, e.hoard + g);
				bonus += e.p * pa * e.hoard * extra;
				mass += e.p * pa;
				e.p *= 1 - pa;
			}
			entries.push({ p: mass, hoard: 0 });
			entries = entries.filter((e) => e.p > 1e-15);
		}
		return bonus;
	}
	let hoard = 0;
	for (const r of rows) {
		hoard = Math.max(0, hoard + r.fishing - r.purchase - r.upkeep);
		const pa = 1 - Math.exp(-r.lambda['Double Cash']);
		const sold = Math.min(hoard, capHours * r.refCashPerH);
		bonus += pa * sold * extra;
		hoard -= pa * sold;
	}
	return bonus;
}

const dcCache = new Map();
function doubleCashModels(archetype, { days = 30, sources = ALL_SOURCES } = {}) {
	const arch = archOf(archetype);
	const key = `${arch.minutesPerDay}|${arch.overheadS}|${days}|${sources.join(',')}`;
	if (dcCache.has(key)) return dcCache.get(key);
	const lc = lifecycle(arch, { sources, maxDays: days, maxLevel: Infinity, snapshots: [days] });
	const rows = lc.rows;
	const dayH = arch.minutesPerDay / 60;
	const D = windowHours('Double Cash');
	const extra = buffOf('Double Cash').multiplier - 1;
	const N = PARAMS.alternatives.castsReferenceHours * referenceCastsPerHour();
	const fishing = sum(rows.map((r) => r.fishing));
	const catchWall = sum(rows.map((r) => r.lambda['Double Cash'] * Math.min(D, dayH) * r.cashPerH * extra));
	const models = {
		catchTime: catchWall,
		catchTimeBuffSaver: sum(rows.map((r) => r.lambda['Double Cash'] * D * r.cashPerH * extra)),
		catchTimeCastsBased: sum(rows.map((r) => Math.min(r.lambda['Double Cash'] * N, r.castsPerH * dayH) * (r.cashPerH / r.castsPerH) * extra)),
		saleTimeNonHoarder: catchWall,
		saleTimeHoarderUncapped: saleTimeHoarder(rows),
		saleTimeHoarderCapped: saleTimeHoarder(rows, { capHours: PARAMS.alternatives.saleTimeCapHours }),
	};
	const spend = sum(rows.map((r) => r.purchase + r.upkeep));
	// The same two duration models for Double XP (share of all XP: fishing + daily + the buff's XP).
	const xpExtra = buffOf('Double XP').multiplier - 1;
	const baseXp = sum(rows.map((r) => r.fishingXp + r.dailyXp));
	const dxpWall = sum(rows.map((r) => r.lambda['Double XP'] * Math.min(windowHours('Double XP'), dayH) * r.xpPerH * xpExtra));
	const dxpCasts = sum(rows.map((r) => Math.min(r.lambda['Double XP'] * N, r.castsPerH * dayH) * (r.xpPerH / r.castsPerH) * xpExtra));
	const out = {
		archetype: arch,
		days,
		level: lc.final.level,
		fishingIncome: fishing,
		doubleCashPer30d: (sum(rows.map((r) => r.lambda['Double Cash'])) * 30) / Math.max(1, rows.length),
		hoardableShare: (fishing - spend) / fishing,
		castsBasedCasts: N,
		value: models,
		share: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, v / fishing])),
		doubleXpShare: { wallclock: dxpWall / (baseXp + dxpWall), castsBased: dxpCasts / (baseXp + dxpCasts) },
	};
	dcCache.set(key, out);
	return out;
}

// ---------------------------------------------------------------------------------------------
// Integrator entry point.
const shareCache = new Map();
/**
 * Share of the archetype's fishing income (cash) and of its XP that buffs add over the first `days`
 * days of daily play, under the proposal. Buff value counts ALL sources; when integrating with
 * streak.js, count the streak's Double Cash/XP here only (bySource.streak), not also in
 * streak.streakValue().breakdown.doubleCash / .xp.
 */
function buffIncomeShare(archetype = F.REFERENCE_ARCHETYPE, { days = 30, sources = ALL_SOURCES } = {}) {
	const arch = archetype === 'minimumDaily' ? minimumDailyArchetype() : archOf(archetype);
	const key = `${arch.minutesPerDay}|${arch.overheadS}|${days}|${sources.join(',')}`;
	if (shareCache.has(key)) return shareCache.get(key);
	const lc = lifecycle(arch, { sources, maxDays: days, maxLevel: Infinity, snapshots: [days] });
	const s = lc.snapshots[days] || lc.final;
	const fishing = s.cashBy.fishing;
	const totalXp = s.xpBy.fishing + s.xpBy.daily + s.xpBy.buff;
	const res = {
		archetype: typeof archetype === 'string' ? archetype : arch,
		days,
		level: s.level,
		playHours: s.hours,
		fishingIncome: fishing,
		doubleCash: s.cashBy.doubleCash,
		luckyDraw: s.cashBy.luckyDraw,
		cash: (s.cashBy.doubleCash + s.cashBy.luckyDraw) / fishing,
		cashDoubleCashOnly: s.cashBy.doubleCash / fishing,
		cashLuckyDrawOnly: s.cashBy.luckyDraw / fishing,
		xp: s.xpBy.buff / totalXp,
		doubleXpXp: s.xpBy.buff,
		buffsPer30d: Object.fromEntries(BUFF_NAMES.map((n) => [n, (s.received[n] * 30) / days])),
		buffsPer30dTotal: (sum(Object.values(s.received)) * 30) / days,
		bySource: Object.fromEntries(Object.entries(s.bySource).map(([src, v]) => [src, { buffsPer30d: Object.fromEntries(BUFF_NAMES.map((n) => [n, (v[n] * 30) / days])), cashShare: v.doubleCash / fishing, xpShare: v.doubleXpXp / totalXp }])),
		luckyDrawUse: s.luckyUse,
	};
	shareCache.set(key, res);
	return res;
}

/** One buff of each type at a stage (typical tier of the stage's biome), for an archetype. */
function valuePerBuff(level, archetype = F.REFERENCE_ARCHETYPE) {
	const arch = archOf(archetype);
	const biome = F.biomeAt(level);
	const tier = F.typicalTier(biome);
	const r = rates(biome, tier, arch.overheadS);
	const dayH = arch.minutesPerDay / 60;
	const w = Math.min(windowHours('Double Cash'), dayH);
	const next = F.gearPath().find((t) => t.level > level);
	const ld = next ? luckyDrawValue(next.tier) : null;
	return {
		level, biome, tier: tier.key,
		doubleCash: { dollars: w * r.cash, minutesOfOwnPlay: w * 60, ifSavedForAnHourSession: windowHours('Double Cash') * r.cash, shareOfDay: w / dayH },
		doubleXp: { xp: w * r.xp, shareOfDay: w / dayH },
		luckyDraw: {
			nextAssembly: ld ? { tier: ld.tier, crate: ld.crate, cratesSaved: ld.cratesSaved, dollars: ld.dollars, hoursOfOwnPlay: ld.dollars / r.cash } : null,
			onStreakCrates: { dollars: buffOf('Lucky Draw').duration.opens * bonusSlotValue('Streak Crate', level), hoursOfOwnPlay: (buffOf('Lucky Draw').duration.opens * bonusSlotValue('Streak Crate', level)) / r.cash },
		},
	};
}

// ---------------------------------------------------------------------------------------------
// Today.
function current() {
	const catalog = BUFF_CATALOG.map((b) => ({ name: b.name, capabilities: b.capabilities, length: b.length, intendedSeconds: b.length, actualSecondsAfterActivation: b.length / 1000, description: b.description }));
	const measured = Object.fromEntries(['Daily Box', 'Voter\'s Crate', 'Booster Pack'].map((box) => {
		const g = GACHA_EV[box];
		const perType = Object.fromEntries(Object.entries(g.rewards).filter(([, v]) => v.type === 'buff').map(([k, v]) => [k, v.p]));
		return [box, { slots: g.slots, buffShareOfSlots: g.typeShare.buff || 0, perSlotEachType: perType, perOpenAnyBuff: (g.typeShare.buff || 0) * g.slots }];
	}));
	// Buffs per 30 days today for a daily player: 1 Daily Box a day (daily quest), 2 Voter's Crates a day.
	const daily30 = 30 * measured['Daily Box'].perOpenAnyBuff;
	const votes30 = 60 * measured['Voter\'s Crate'].perOpenAnyBuff;
	// Today's same-kind stacking in the engine (modifiers.buffEffects) vs the sale path (first cash buff).
	const dxp = { _id: 'a', name: 'Double XP', capabilities: ['xp', '2.0'] };
	const stackXp = engineBuffEffects([dxp, { ...dxp, _id: 'b' }]).xp;
	// Lucky Draw today (+50% to every rare+ tier): effect per box.
	const luckRow = (label, def, level) => {
		const a = streak.boxEV(def, { level });
		const b = streak.boxEV({ ...def, id: `${def.id || label}+luck`, rarityTable: buildTable(def.rarityTable, TODAY_LUCKY_STATS) }, { level });
		const rarePlus = (ev) => sum(RARITIES.filter((r) => ['rare', 'ultra', 'giant', 'legendary', 'lucky'].includes(r)).map((r) => ev.rarity[r] || 0)) / ev.slots;
		return { box: label, rarePlusPerSlot: rarePlus(a), rarePlusPerSlotLucky: rarePlus(b), liquid: a.liquid, liquidLucky: b.liquid, liquidGain: b.liquid - a.liquid };
	};
	const L = F.BIOME_LEVEL.Lake;
	const luckyToday = {
		boxes: [
			luckRow('Daily Box', DAILY_BOX, L),
			luckRow('Streak Crate', streak.boxDefinitions()['Streak Crate'], L),
			luckRow('Streak Chest', streak.boxDefinitions()['Streak Chest'], L),
		],
		tierCrates: TIERS.map((t) => {
			const e0 = luckyAssembly(t, { opens: 0 });
			const eAll = luckyAssembly(t, { opens: 1e6, mode: 'luck' });
			return { tier: t, crate: rods.crateDefinition(t).name, expectedCrates: e0, expectedCratesAllOpensLucky: eAll, cratesSaved: e0 - eAll, inert: e0 - eAll < 1e-6 };
		}),
	};
	return {
		catalog,
		measured,
		buffsPer30dToday: { dailyBoxOnly: daily30, withTopggVotes: daily30 + votes30, eachType: (daily30 + votes30) / 3 },
		stacking: { twoDoubleXpInEngine: `+${stackXp * 100}% (x${1 + stackXp})`, cashAtSale: 'Fish.sellByRarity and sell-one-fish take the FIRST active cash buff only (.find)', gacha: 'gacha.js sums every active Lucky Draw' },
		luckyToday,
		bugs: [
			{ id: 'B1', title: 'Every buff lasts 3.6 s', evidence: `User.startBooster: endTime = Date.now() + buff.length, catalog length ${BUFF_CATALOG[0].length} (seconds) read as ms. Reproduced on the in-memory MongoDB: endTime - start = 3,601 ms.` },
			{ id: 'B2', title: 'A buff is never consumed', evidence: 'startBooster never decrements count; endBooster filters inventory with b.id !== buff.id (ObjectId.id is a Buffer, buff.id a string: always true), so nothing is removed. Reproduced: after expiry the stack still has count 1, is still in inventory, and /equip re-activates it. Fixing B1 alone would make every buff permanent.' },
			{ id: 'B3', title: 'Expiry only on slash commands', evidence: 'interactionCreate sweeps expired buffs before slash commands only; buttons (sell-one-fish) never sweep, and cast.js/gacha.js/Fish.js trust active: true.' },
			{ id: 'B4', title: 'Inconsistent same-kind stacking', evidence: `modifiers.buffEffects adds every active buff (two Double XP = ${1 + stackXp}x); the sale paths use the first cash buff; gacha.js sums Lucky Draws.` },
			{ id: 'B5', title: 'Descriptions over-promise', evidence: 'Double XP "from all activities" and Double Cash "income from all activities": quest XP/cash never take a buff (modifiers quest multiplier = profile x event).' },
			{ id: 'B6', title: 'Dead code', evidence: 'User.generateBoostedXP / generateBoostedCash have no callers.' },
		],
	};
}

// ---------------------------------------------------------------------------------------------
// R2 for the buff layer.
function decomposition(lc) {
	return Object.fromEntries(Object.keys(F.TARGET_WINDOWS).map(Number).filter((T) => lc.at[T]).map((T) => {
		const s = lc.at[T];
		const total = s.xpBy.fishing + s.xpBy.daily + s.xpBy.buff;
		return [T, {
			hours: lc.reached[T].hours,
			day: lc.reached[T].day,
			fishingXp: Math.round(s.xpBy.fishing),
			dailyXpProvisional: Math.round(s.xpBy.daily),
			buffXp: Math.round(s.xpBy.buff),
			buffXpBySource: Object.fromEntries(Object.entries(s.bySource).map(([k, v]) => [k, Math.round(v.doubleXpXp)])),
			shares: { fishing: s.xpBy.fishing / total, daily: s.xpBy.daily / total, buff: s.xpBy.buff / total },
		}];
	}));
}

let r2Cache = null;
function r2() {
	if (r2Cache) return r2Cache;
	const archetypes = {};
	for (const name of Object.keys(F.ARCHETYPES)) {
		const on = lifecycle(name);
		const off = lifecycle(name, { sources: [] });
		const keys = Object.keys(off.reached);
		archetypes[name] = {
			decomposition: decomposition(on),
			hoursWithoutBuffs: Object.fromEntries(keys.map((k) => [k, off.reached[k].hours])),
			hoursWithBuffs: Object.fromEntries(keys.map((k) => [k, on.reached[k]?.hours])),
			maxHoursDelta: Math.max(...keys.map((k) => Math.abs(on.reached[k].hours - off.reached[k].hours) / off.reached[k].hours)),
		};
	}
	const reg = archetypes.regular;
	const windows = Object.fromEntries(Object.entries(F.TARGET_WINDOWS).map(([L, [lo, hi]]) => [L, { window: [lo, hi], without: reg.hoursWithoutBuffs[L], with: reg.hoursWithBuffs[L], inside: reg.hoursWithBuffs[L] >= lo && reg.hoursWithBuffs[L] <= hi }]));
	// Minimum-daily player (streak gate only) vs the casual player at calendar checkpoints.
	const minArch = minimumDailyArchetype();
	const checkDays = [1, 4, 13, 26, 52].map((w) => w * 7);
	const horizon = checkDays[checkDays.length - 1];
	const run = (arch) => lifecycle(arch, { maxDays: horizon, maxLevel: Infinity, snapshots: checkDays }).snapshots;
	const ms = run(minArch);
	const cs = run('casual');
	const rows = checkDays.map((d) => {
		const view = (s) => {
			const xp = s.xpBy.fishing + s.xpBy.daily + s.xpBy.buff;
			return { level: s.level, hours: s.hours, xpPerActiveHour: xp / s.hours, xpPerDay: xp / d, buffXpShare: s.xpBy.buff / xp, buffXpPerActiveHour: s.xpBy.buff / s.hours };
		};
		return { day: d, minimumDaily: view(ms[d]), casual: view(cs[d]), minimumDailyLeadsInLevel: ms[d].level > cs[d].level };
	});
	const minimumDaily = { archetype: minArch, rows, leadsAnywhere: rows.some((r) => r.minimumDailyLeadsInLevel) };
	minimumDaily.verdict = minimumDaily.leadsAnywhere
		? 'FAIL: the minimum-daily player leads a casual player in level; cap buff arrivals by play.'
		: 'PASS: a buff only doubles real play inside its window, so the minimum-daily player never leads the casual player in level at any checkpoint.';
	const g = archetypes.grinder;
	const noMissGrinder = {
		hoursWithoutBuffs: g.hoursWithoutBuffs,
		hoursWithBuffs: g.hoursWithBuffs,
		maxHoursDelta: g.maxHoursDelta,
		regularStillInWindows: Object.values(windows).every((w) => w.inside),
	};
	noMissGrinder.verdict = noMissGrinder.maxHoursDelta <= PARAMS.targets.windowShiftMax && noMissGrinder.regularStillInWindows
		? `PASS: every buff source on top of grinding moves the grinder's milestones by at most ${(100 * g.maxHoursDelta).toFixed(2)}%, and the regular player stays inside every window.`
		: 'FAIL: buffs move milestones materially.';
	r2Cache = { archetypes, windows, minimumDaily, noMissGrinder };
	return r2Cache;
}

// ---------------------------------------------------------------------------------------------
// Founder (private): gacha luck raises buff odds per box; public XP counts buff XP like anyone's.
/** Continuous level for an XP amount on the framework curve (bisection on F.xpForLevel). */
function levelExact(xp) {
	let lo = 0;
	let hi = 400;
	for (let i = 0; i < 60; i++) {
		const mid = (lo + hi) / 2;
		if (F.xpForLevel(mid) < xp) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}
function founderView() {
	const L = F.BIOME_LEVEL.Lake;
	const boxes = ['Streak Crate', 'Streak Chest'].map((b) => ({ box: b, normal: boxBuffOdds(b, L), founder: boxBuffOdds(b, L, { profile: 'founder' }) }));
	boxes.push({ box: 'Daily Box', normal: boxBuffOdds(DAILY_BOX, L), founder: boxBuffOdds(DAILY_BOX, L, { profile: 'founder' }) });
	const cycle = streak.PARAMS.ladder.cycle;
	const per30 = (profile) => {
		const crate = boxBuffOdds('Streak Crate', L, { profile });
		const chest = boxBuffOdds('Streak Chest', L, { profile });
		const db = boxBuffOdds(DAILY_BOX, L, { profile });
		const qb = questBoxesPerDay(L, F.tierAt(L), F.ARCHETYPES[F.REFERENCE_ARCHETYPE]);
		return Object.fromEntries(BUFF_NAMES.map((n) => [n, 30 * (((cycle - 1) * crate[n] + chest[n]) / cycle + qb * db[n] + PARAMS.sources.events.perThirtyDays[n] / 30)]));
	};
	const normal = per30('normal');
	const founder = per30('founder');
	// Public XP drift: a Founder's extra Double XP days add base XP a normal player would not have
	// (a buff covers a regular player's whole session), as a share of base XP, then in levels at L50.
	const drift = (founder['Double XP'] - normal['Double XP']) / 30;
	const L50 = Object.keys(F.TARGET_WINDOWS).map(Number).slice(-1)[0];
	const xp50 = F.xpForLevel(L50);
	return {
		profileGachaStats: PROFILES.founder.gacha?.stats || {},
		boxes,
		buffsPer30d: { normal, founder, ratio: founder['Double XP'] / normal['Double XP'] },
		publicXpDriftShare: drift,
		publicLevelDriftAtL50: levelExact(xp50 * (1 + drift)) - L50,
		note: 'Buff effects are base (public) rewards for everyone; the private profile multiplies the final. Founder boxes hold more buffs (gacha luck), so a Founder\'s public XP can run ahead of an identical normal player by the drift share.',
	};
}

// ---------------------------------------------------------------------------------------------
// Validation.
/**
 * lifecycle() with every buff source off reproduces docs/economy/5b/curve.json. curve.json is curve.js's
 * 'provisional' model, fitted on F.PROVISIONAL_GEAR_PATH, so the stepping is checked on that path (on the
 * 5b.3 shared rods path the hours legitimately differ; the curve itself is unchanged). Hours only:
 * curve.json is generated on the shared core, which counts a level reached on a day's final step in that
 * day (lifecycle()'s ceil(h / dayH) counts the next day), so the day column may differ by 1.
 */
function baselineMatchesCurveJson() {
	if (CURVE_JSON.chosen !== F.CURVE.quartic || CURVE_JSON.model !== 'provisional') return false;
	return Object.keys(F.ARCHETYPES).every((name) => {
		const lc = lifecycle(name, { sources: [], gearPath: F.PROVISIONAL_GEAR_PATH });
		return Object.entries(CURVE_JSON.archetypes[name]).every(([L, v]) => lc.reached[L] && lc.reached[L].hours === v.hours);
	});
}

function reconcileWithStreak(days = 30) {
	return Object.fromEntries(Object.keys(F.ARCHETYPES).map((name) => {
		const mine = lifecycle(name, { sources: ['streak'], maxDays: days, maxLevel: Infinity, snapshots: [days] }).snapshots[days];
		const theirs = streak.lifecycle(name, { maxDays: days, maxLevel: Infinity, snapshots: [days] }).snapshots[days];
		const dc = { buffs: mine.cashBy.doubleCash, streak: theirs.streakBy.doubleCash };
		const xp = { buffs: mine.xpBy.buff, streak: theirs.xpBy.streak };
		return [name, { doubleCash: dc, doubleXpXp: xp, level: { buffs: mine.level, streak: theirs.level }, match: Math.abs(dc.buffs - dc.streak) < 1e-6 * Math.max(1, dc.streak) && Math.abs(xp.buffs - xp.streak) < 1e-6 * Math.max(1, xp.streak) }];
	}));
}

// ---------------------------------------------------------------------------------------------
// SYSTEM (framework 5b.3): the buff layer on the shared lifecycle core (lifecycle.js). The core steps
// time and accrues base fishing (ledger source 'fishing'); this system receives buffs, activates them and
// credits only their BONUS, into its own ledger sources: XP / public XP 'buff' (Double XP), cash 'buff'
// (Double Cash) and cash 'luckyDraw' (Lucky Draw). No sinks, no purchases.
// Counting rule (integrate.js): a box's non-buff contents are valued once, by the system that grants it
// (quests: Daily Box; streak: Streak Crate / Chest); its buffs reach this system as
// emit('box', { name, count, level }) and are valued here, once.
const SYSTEM_NAME = 'buffs';
const BUFF_SOURCE = 'buff';
const LUCKY_SOURCE = 'luckyDraw';
/** Ledger sources this system writes (it has no spend items). */
const LEDGER_SOURCES = Object.freeze({ xp: [BUFF_SOURCE], publicXp: [BUFF_SOURCE], cash: [BUFF_SOURCE, LUCKY_SOURCE], spend: [] });
/** Buffs with a wall-clock window (Double XP, Double Cash); the Lucky Draw works by charges. */
const TIMED = BUFF_NAMES.filter((n) => buffOf(n).duration.type === 'wallclock');
const VALUATIONS = ['session', 'dayEnd'];
/** system() defaults: the design rules. */
const SYSTEM_DEFAULTS = Object.freeze({ valuation: 'session', events: true });
/** lifecycle()'s conventions, for the exact replay in validateSystem(). */
const LIFECYCLE_CONVENTIONS = Object.freeze({ valuation: 'dayEnd', events: true });
/** 'box' event names priced by a definition rather than by name (streak.boxEV knows the rest). */
const BOX_REFS = { 'Daily Box': DAILY_BOX };
const zeroBuffs = () => Object.fromEntries(BUFF_NAMES.map((n) => [n, 0]));
const clone = (o) => JSON.parse(JSON.stringify(o));

/** A 'box' event name this module can price: the streak boxes, the Daily Box, the legacy Voter's Crate. */
const knownBox = (name) => Boolean(BOX_REFS[name] || streak.boxDefinitions()[name] || name === 'Voter\'s Crate');

/**
 * Expected share of the play minutes [m0, m1) covered by a wall-clock buff when `a` expected units were
 * queued at minute 0 of the session: unit k covers [kW, (k + 1)W) with weight min(1, a - k).
 */
function coverage(a, m0, m1, W) {
	let covered = 0;
	for (let k = 0; k < Math.ceil(a - 1e-12); k++) {
		const lo = Math.max(m0, k * W);
		const hi = Math.min(m1, (k + 1) * W);
		if (hi > lo) covered += Math.min(1, a - k) * (hi - lo);
	}
	return covered / (m1 - m0);
}

/**
 * The buffs SYSTEM (lifecycle.js hooks). A fresh object per call; per-run state in state.sys.buffs only.
 * Stocks are EXPECTED units (the model is linear in them, as lifecycle() was).
 *   on('box')      a granted box { name, count, level, source }: its expected buffs of each type
 *                  (boxBuffOdds: streak.boxEV at the payload level and the run's profile) join the stock,
 *                  attributed to payload.source. The Booster Pack is never valued (decision 12); an
 *                  unknown box throws (a box with buffs must be priced here, once).
 *   events         the event budget (F.EVENTS.buffsPerThirtyDays = PARAMS.sources.events) accrues per
 *                  CALENDAR day and is delivered by the first cast of the next played day (a player who
 *                  fishes during the event; days not played still count toward the 30-day budget).
 *   onDayStart     valuation 'session' (default): events delivered, then the Double XP and Double Cash in
 *                  stock are activated at the session start: up to one unit per started hour of the planned
 *                  session (the queue, at most PARAMS.stacking.maxQueued; the minimum-daily session: 1).
 *                  Rational use: a unit received mid-session waits for the next session's start, where its
 *                  whole window meets play.
 *   onCasts        while a window is open, counted in PLAY minutes of the session (state.minutesToday), the
 *                  bonus on the step's catch: XP 'buff' = (multiplier - 1) x rates.xp (final) with
 *                  (multiplier - 1) x rates.xpBase as its public base; cash 'buff' = (multiplier - 1) x
 *                  rates.cash (catch-time stamp). Gear, bait, aquarium and the profile are already in the
 *                  step's rates (they multiply); F.EVENTS has no event multipliers to add to. The core's
 *                  'fishing' ledger is untouched.
 *   on('assembly') a tier assembly (the rods system's event): one held Lucky Draw goes into it, valued as
 *                  cash 'luckyDraw' = luckyDrawValue(tier).dollars (crates its bonus slots save x the tier
 *                  crate price): a REBATE credited at the assembly, not a lower goal cost (the goal and its
 *                  cost are the rods system's own).
 *   onDayEnd       an unexpired window ends with the session (wall-clock). Lucky Draws above the reserve
 *                  (PARAMS.luckyDrawReserve while a tier is still ahead) go on Streak Crates: opens x
 *                  bonusSlotValue('Streak Crate', level), cash 'luckyDraw'. valuation 'dayEnd' (lifecycle()'s
 *                  convention; validation replay): events arrive here, and the day's Double XP / Double Cash
 *                  are valued at once at the rates of the day's last step over min(window, the archetype's
 *                  daily play).
 *   sessionDone    always true (buffs set no daily minimum).
 * Profile (founderView() rules): state.profile 'founder' (the founder system's init) takes the Founder box
 * odds (gacha luck) and sells the Streak Crate bonus slot's fish at the Founder's sell multiplier. Buff XP
 * is base (public) XP for everyone; the final XP and the cash follow the profile's step rates (the private
 * multipliers apply after the buff). The Lucky Draw assembly rebate uses the Normal crate chain.
 * @param {object} opts { valuation: 'session' (default) | 'dayEnd' (lifecycle() replay), events: true
 *   (default) | false (no event budget) }
 */
function system(opts = {}) {
	const cfg = { ...SYSTEM_DEFAULTS, ...opts };
	if (!VALUATIONS.includes(cfg.valuation)) throw new Error(`Unknown buff valuation ${cfg.valuation}`);
	const own = (state) => state.sys[SYSTEM_NAME];
	const profileOf = (state) => (state.profile === 'founder' ? 'founder' : 'normal');
	const windowMinutes = (name) => windowHours(name) * 60;

	function receive(s, name, units, source) {
		if (!(units > 0)) return;
		s.stock[name] += units;
		s.pool[name][source] = (s.pool[name][source] || 0) + units;
		s.received[name] += units;
		s.receivedBySource[source] = s.receivedBySource[source] || zeroBuffs();
		s.receivedBySource[source][name] += units;
	}
	/** Removes `units` from the stock, pro rata over its sources; returns the units taken by source. */
	function takeStock(s, name, units) {
		const total = s.stock[name];
		if (!(units > 0) || !(total > 0)) return {};
		const f = Math.min(1, units / total);
		const out = {};
		for (const [src, u] of Object.entries(s.pool[name])) {
			out[src] = u * f;
			s.pool[name][src] = f === 1 ? 0 : u - u * f;
		}
		s.stock[name] = f === 1 ? 0 : total - units;
		return out;
	}
	/** Credits a Double XP / Double Cash bonus (final, and public base for XP), split by the units' sources. */
	function creditBonus(state, ctx, name, amount, base, mix) {
		if (!(amount > 0)) return;
		const s = own(state);
		const isXp = buffOf(name).kind === 'xp';
		if (isXp) {
			ctx.addXp(BUFF_SOURCE, amount, base);
			s.value.doubleXpXp += amount;
			s.value.doubleXpBase += base;
		}
		else {
			ctx.addCash(BUFF_SOURCE, amount);
			s.value.doubleCash += amount;
		}
		const units = sum(Object.values(mix));
		if (!(units > 0)) return;
		for (const [src, u] of Object.entries(mix)) {
			s.valueBySource[src] = s.valueBySource[src] || { doubleXpXp: 0, doubleCash: 0 };
			s.valueBySource[src][isXp ? 'doubleXpXp' : 'doubleCash'] += (amount * u) / units;
		}
	}
	function creditEvents(state) {
		const s = own(state);
		const days = state.day + 1 - s.eventDays;
		if (!cfg.events || days <= 0) return;
		s.eventDays = state.day + 1;
		for (const n of BUFF_NAMES) receive(s, n, (days * PARAMS.sources.events.perThirtyDays[n]) / 30, 'events');
	}
	function startSession(state, ctx) {
		const s = own(state);
		// Planned play of a fixed session (a minimum-daily session has no planned length: one unit).
		const planned = (ctx.arch.session === 'fixed' && ctx.arch.minutesPerDay) || 0;
		for (const n of TIMED) {
			const perSession = Math.min(PARAMS.stacking.maxQueued, Math.max(1, Math.ceil(planned / windowMinutes(n) - 1e-9)));
			const a = Math.min(s.stock[n], perSession);
			s.active[n] = { units: a, mix: takeStock(s, n, a) };
			s.activated[n] += a;
		}
	}
	/** valuation 'dayEnd' (lifecycle()): the day's units at the last step's rates over min(window, daily play). */
	function valueAtDayEnd(state, ctx) {
		const s = own(state);
		const r = s.lastRates;
		if (!r) return;
		const dayH = ctx.arch.session === 'fixed' ? ctx.arch.minutesPerDay / 60 : state.minutesToday / 60;
		for (const n of TIMED) {
			const units = s.stock[n];
			if (!(units > 0)) continue;
			const hours = Math.min(windowHours(n), dayH);
			const extra = buffOf(n).multiplier - 1;
			const mix = takeStock(s, n, units);
			s.activated[n] += units;
			s.buffedMinutes[n] += units * hours * 60;
			if (buffOf(n).kind === 'xp') creditBonus(state, ctx, n, units * hours * r.xpPerH * extra, units * hours * r.xpBasePerH * extra, mix);
			else creditBonus(state, ctx, n, units * hours * r.cashPerH * extra, 0, mix);
		}
	}
	function onBox(state, ctx, payload) {
		const s = own(state);
		const count = payload.count ?? 1;
		const name = payload.name;
		if (!(count > 0)) return;
		s.boxes[name] = (s.boxes[name] || 0) + count;
		if (name === 'Booster Pack' && !PARAMS.sources.boosterPack.valued) {
			s.unvalued[name] = (s.unvalued[name] || 0) + count;
			return;
		}
		if (!knownBox(name)) throw new Error(`buffs system: no buff odds for box '${name}' (a granted box with buffs must be priced here, once)`);
		const odds = boxBuffOdds(BOX_REFS[name] || name, payload.level ?? ctx.gateLevel(), { profile: profileOf(state) });
		for (const n of BUFF_NAMES) receive(s, n, count * odds[n], payload.source || name);
	}
	function onAssembly(state, ctx, payload) {
		const s = own(state);
		s.assembled = Math.max(s.assembled, payload.tier);
		const use = Math.min(1, s.stock['Lucky Draw']);
		if (!(use > 0)) return;
		const v = use * luckyDrawValue(payload.tier).dollars;
		takeStock(s, 'Lucky Draw', use);
		s.luckyUse.assembly += use;
		s.luckyUse.assemblyValue += v;
		s.value.luckyDraw += v;
		if (v > 0) ctx.addCash(LUCKY_SOURCE, v);
	}
	/** Lucky Draws above the reserve go on Streak Crates (the reserve waits for the next assembly). */
	function spendLuckySurplus(state, ctx) {
		const s = own(state);
		const reserve = ctx.path[Math.max(s.assembled, state.equippedTier) + 1] ? PARAMS.luckyDrawReserve : 0;
		const held = s.stock['Lucky Draw'];
		if (!(held > reserve)) return;
		const spend = held - reserve;
		const v = spend * buffOf('Lucky Draw').duration.opens * bonusSlotValue('Streak Crate', state.stepStartLevel, { profile: profileOf(state) });
		takeStock(s, 'Lucky Draw', spend);
		s.stock['Lucky Draw'] = reserve;
		s.luckyUse.streakCrate += spend;
		s.luckyUse.streakCrateValue += v;
		s.value.luckyDraw += v;
		if (v > 0) ctx.addCash(LUCKY_SOURCE, v);
	}

	return {
		name: SYSTEM_NAME,
		init(state) {
			state.sys[SYSTEM_NAME] = {
				options: { ...cfg },
				stock: zeroBuffs(),
				pool: Object.fromEntries(BUFF_NAMES.map((n) => [n, {}])),
				received: zeroBuffs(),
				receivedBySource: {},
				active: {},
				activated: zeroBuffs(),
				buffedMinutes: zeroBuffs(),
				value: { doubleXpXp: 0, doubleXpBase: 0, doubleCash: 0, luckyDraw: 0 },
				valueBySource: {},
				luckyUse: { assembly: 0, streakCrate: 0, assemblyValue: 0, streakCrateValue: 0 },
				boxes: {},
				unvalued: {},
				eventDays: 0,
				assembled: state.equippedTier,
				lastRates: null,
			};
		},
		on(event, payload, state, ctx) {
			if (event === 'box') onBox(state, ctx, payload);
			else if (event === 'assembly') onAssembly(state, ctx, payload);
		},
		onDayStart(state, ctx) {
			own(state).lastRates = null;
			if (cfg.valuation !== 'session') return;
			creditEvents(state);
			startSession(state, ctx);
		},
		onCasts(state, ctx, { rates: r }) {
			const s = own(state);
			s.lastRates = { tier: r.tier, xpPerH: r.perHour.xp, xpBasePerH: r.xpBase / ctx.stepH, cashPerH: r.perHour.cash };
			if (cfg.valuation !== 'session') return;
			const m0 = state.minutesToday;
			const m1 = m0 + ctx.stepH * 60;
			for (const n of TIMED) {
				const act = s.active[n];
				if (!act || !(act.units > 0)) continue;
				const c = coverage(act.units, m0, m1, windowMinutes(n));
				if (!(c > 0)) continue;
				const extra = buffOf(n).multiplier - 1;
				s.buffedMinutes[n] += c * (m1 - m0);
				if (buffOf(n).kind === 'xp') creditBonus(state, ctx, n, c * extra * r.xp, c * extra * r.xpBase, act.mix);
				else creditBonus(state, ctx, n, c * extra * r.cash, 0, act.mix);
			}
		},
		onDayEnd(state, ctx) {
			const s = own(state);
			if (cfg.valuation === 'dayEnd') {
				creditEvents(state);
				valueAtDayEnd(state, ctx);
			}
			else {
				for (const n of TIMED) s.active[n] = null;
			}
			spendLuckySurplus(state, ctx);
		},
		sessionDone() {
			return true;
		},
	};
}

// ---------------------------------------------------------------------------------------------
// Validation (5b.3): system() on the shared core against lifecycle().
/**
 * Validation only: lifecycle()'s gear rule (LC.provisionalRods: the next tier after F.PURCHASE.saveHours
 * of stage income once its level is reached) plus the 'assembly' event the rods system emits on a purchase,
 * so a held Lucky Draw reaches the assembly on the step lifecycle() used it.
 */
function lifecycleGear({ saveHours = F.PURCHASE.saveHours } = {}) {
	const NAME = 'buffsLifecycleGear';
	return {
		name: NAME,
		init(state) {
			state.sys[NAME] = { saving: 0 };
		},
		beforeStep(state, ctx, r) {
			const next = ctx.path[state.equippedTier + 1];
			if (!next || state.stepStartLevel < next.level) return;
			const g = state.sys[NAME];
			g.saving += r.cash;
			if (g.saving >= r.perHour.cash * saveHours) {
				state.equippedTier++;
				g.saving = 0;
				ctx.emit('assembly', { tier: next.tier, level: state.stepStartLevel, source: NAME });
			}
		},
	};
}

/**
 * Validation only: lifecycle()'s buff sources as 'box' events at each played day's end, at the level the
 * day's last step started at (arrivals()): the box of streak day n (streak.boxForDay; lifecycle() credited
 * every played day) and the day's expected Daily Boxes (questBoxesPerDay: quests.questIncome at the tier the
 * day's last step fished, over the archetype's daily play; the minimum-daily player's daily counted
 * complete). sessionDone = the streak play gate: F.MINIMUM_DAILY stops there, as the streak design's
 * minimum-daily player (minimumDailyArchetype(): 20 casts) did.
 */
function lifecycleSources({ streak: withStreak = true, quests: withQuests = true } = {}) {
	const NAME = 'buffsLifecycleSources';
	return {
		name: NAME,
		init(state) {
			state.sys[NAME] = { tier: state.equippedTier };
		},
		onCasts(state, ctx, { rates: r }) {
			state.sys[NAME].tier = r.tier;
		},
		sessionDone(state) {
			return state.castsToday >= streak.PARAMS.gate.successfulCasts - 1e-9;
		},
		onDayEnd(state, ctx) {
			const L = state.stepStartLevel;
			if (withStreak) ctx.emit('box', { name: streak.boxForDay(state.playDay + 1), count: 1, level: L, source: 'streak' });
			if (withQuests) {
				const arch = ctx.arch.session === 'fixed' ? ctx.arch : { ...ctx.arch, minutesPerDay: state.minutesToday, minimumDaily: true };
				ctx.emit('box', { name: 'Daily Box', count: questBoxesPerDay(L, ctx.path[state.sys[NAME].tier], arch), level: L, source: 'quests' });
			}
		},
	};
}

/**
 * Validation only (runs last): ledger + buff-state snapshots in lifecycle()'s conventions. A milestone
 * reached on a day's final step is re-snapshotted after that day's day-end credits (lifecycle() adds the
 * daily and the day's buff XP inside that step, before its milestone check; the core records the milestone
 * first); calendar `checkpoints` are snapshotted at their day end.
 */
function validationProbe({ checkpoints = [] } = {}) {
	const NAME = 'buffsProbe';
	const snap = (state, ctx) => ({ hours: +state.h.toFixed(4), level: F.levelForXp(state.xp, ctx.curve), ledger: clone(state.ledger), buffs: clone(state.sys[SYSTEM_NAME] || null) });
	return {
		name: NAME,
		init(state) {
			state.sys[NAME] = { milestones: {}, days: {} };
		},
		onDayEnd(state, ctx) {
			const p = state.sys[NAME];
			const ranToClock = ctx.arch.session !== 'fixed' || Math.floor(state.h / (ctx.arch.minutesPerDay / 60)) !== state.playDay;
			const h = +state.h.toFixed(4);
			if (ranToClock) {
				for (const [T, m] of Object.entries(state.milestones)) if (!(T in p.milestones) && m.hours === h) p.milestones[T] = snap(state, ctx);
			}
			if (checkpoints.includes(state.day + 1)) p.days[state.day + 1] = snap(state, ctx);
		},
	};
}

/** lifecycle()'s model on the shared core: its gear rule, the provisional daily, its sources, this system. */
function coreRun(archetype, { valuation = SYSTEM_DEFAULTS.valuation, sources = ALL_SOURCES, days, checkpoints = [] } = {}) {
	return LC.simulate({
		archetype,
		systems: [
			lifecycleGear(),
			LC.provisionalDaily(),
			lifecycleSources({ streak: sources.includes('streak'), quests: sources.includes('quests') }),
			system({ valuation, events: sources.includes('events') }),
			validationProbe({ checkpoints }),
		],
		days,
		stopAtLevel: null,
	});
}

/** A core snapshot (probe) in lifecycle()'s take() shape. */
function coreView(snap) {
	const L = snap.ledger;
	const b = snap.buffs;
	const bySource = {};
	for (const [src, units] of Object.entries(b.receivedBySource)) bySource[src] = { ...units, doubleXpXp: b.valueBySource[src]?.doubleXpXp || 0, doubleCash: b.valueBySource[src]?.doubleCash || 0 };
	return {
		level: snap.level,
		hours: snap.hours,
		xpBy: { fishing: L.xp.fishing || 0, daily: L.xp.daily || 0, buff: L.xp[BUFF_SOURCE] || 0 },
		publicBuffXp: L.publicXp[BUFF_SOURCE] || 0,
		cashBy: { fishing: L.cash.fishing || 0, doubleCash: L.cash[BUFF_SOURCE] || 0, luckyDraw: L.cash[LUCKY_SOURCE] || 0 },
		received: { ...b.received },
		stock: { ...b.stock },
		bySource,
		luckyUse: { ...b.luckyUse },
	};
}

const STEP_H = F.LIFECYCLE.stepH;
const stepOf = (hours) => Math.round(hours / STEP_H);
/** Relative difference; float noise (summation order) counts as equal. */
function relDiff(a, b) {
	const d = Math.abs(a - b);
	const scale = Math.max(Math.abs(a), Math.abs(b));
	return d <= 1e-9 * Math.max(1, scale) ? 0 : d / scale;
}
const LEDGER_FIELDS = [
	['fishingXp', (v) => v.xpBy.fishing], ['dailyXp', (v) => v.xpBy.daily], ['buffXp', (v) => v.xpBy.buff],
	['fishingCash', (v) => v.cashBy.fishing], ['doubleCash', (v) => v.cashBy.doubleCash], ['luckyDraw', (v) => v.cashBy.luckyDraw],
	...BUFF_NAMES.map((n) => [`received ${n}`, (v) => v.received[n]]),
];

/**
 * One comparison of a core run with lifecycle() (same archetype, sources and horizon): milestone hours
 * step-exact (lifecycle() rounds to 0.01 h, under a step, so its step index is recovered) and the buff XP
 * at each milestone; the ledgers and levels at the calendar checkpoints.
 */
function compareWithLifecycle(old, core, checkpoints) {
	const out = { maxMaxRel: 0, maxWorst: null, hoursMaxRel: 0, hoursWorst: null, ledgerMaxRel: 0, ledgerWorst: null, maxAbsSteps: 0, milestonesCompared: 0, exactMilestones: 0, levelsMatch: true, missing: [], milestones: {}, checkpoints: {} };
	const note = (kind, key, a, b) => {
		const d = relDiff(a, b);
		if (d > out[`${kind}MaxRel`]) {
			out[`${kind}MaxRel`] = d;
			out[`${kind}Worst`] = key;
		}
		if (d > out.maxMaxRel) {
			out.maxMaxRel = d;
			out.maxWorst = key;
		}
		return d;
	};
	for (const T of F.LIFECYCLE.milestones) {
		const o = old.reached[T];
		const c = core.milestones[T];
		if (!o && !c) continue;
		if (!o || !c) {
			out.missing.push(`L${T}`);
			continue;
		}
		const [kOld, kCore] = [stepOf(o.hours), stepOf(c.hours)];
		const x = (core.sys.buffsProbe.milestones[T] || c).ledger.xp;
		const oldBuff = old.at[T].xpBy.buff;
		out.milestonesCompared++;
		if (kOld === kCore) out.exactMilestones++;
		out.maxAbsSteps = Math.max(out.maxAbsSteps, Math.abs(kCore - kOld));
		out.milestones[T] = {
			hours: { old: o.hours, core: c.hours, steps: kCore - kOld, rel: round(note('hours', `L${T} hours`, kCore, kOld), 6) },
			buffXp: { old: Math.round(oldBuff), core: Math.round(x[BUFF_SOURCE] || 0), rel: round(note('ledger', `L${T} buff XP`, x[BUFF_SOURCE] || 0, oldBuff), 6) },
		};
	}
	for (const d of checkpoints) {
		const o = old.snapshots[d];
		const snap = core.sys.buffsProbe.days[d];
		if (!o || !snap) {
			out.missing.push(`day ${d}`);
			continue;
		}
		const c = coreView(snap);
		if (o.level !== c.level) out.levelsMatch = false;
		const row = { level: { old: o.level, core: c.level } };
		for (const [k, get] of LEDGER_FIELDS) row[k] = { old: round(get(o), 4), core: round(get(c), 4), rel: round(note('ledger', `day ${d} ${k}`, get(c), get(o)), 6) };
		row.stockAtEnd = Object.fromEntries(BUFF_NAMES.map((n) => [n, round(c.stock[n], 4)]));
		// Informative (not in the max): value per unit USED (received minus still in stock); lifecycle()
		// used every unit on the day it arrived.
		const perUnit = (value, units) => (units > 1e-12 ? value / units : 0);
		const dc = [perUnit(c.cashBy.doubleCash, c.received['Double Cash'] - c.stock['Double Cash']), perUnit(o.cashBy.doubleCash, o.received['Double Cash'])];
		const dx = [perUnit(c.xpBy.buff, c.received['Double XP'] - c.stock['Double XP']), perUnit(o.xpBy.buff, o.received['Double XP'])];
		row.valuePerUnitUsed = {
			doubleCash: { old: round(dc[1], 2), core: round(dc[0], 2), rel: round(relDiff(...dc), 6) },
			doubleXpXp: { old: round(dx[1], 2), core: round(dx[0], 2), rel: round(relDiff(...dx), 6) },
		};
		out.checkpoints[d] = row;
	}
	return out;
}

/** buffIncomeShare()'s figures from a core snapshot (the same definitions). */
function coreShare(snap, days) {
	const v = coreView(snap);
	const totalXp = v.xpBy.fishing + v.xpBy.daily + v.xpBy.buff;
	return {
		level: v.level,
		cash: (v.cashBy.doubleCash + v.cashBy.luckyDraw) / v.cashBy.fishing,
		cashDoubleCashOnly: v.cashBy.doubleCash / v.cashBy.fishing,
		cashLuckyDrawOnly: v.cashBy.luckyDraw / v.cashBy.fishing,
		xp: v.xpBy.buff / totalXp,
		buffsPer30dTotal: (sum(Object.values(v.received)) * 30) / days,
		streakCashShare: (v.bySource.streak?.doubleCash || 0) / v.cashBy.fishing,
	};
}

/**
 * Streak reconciliation on the core (count buff value once). (1) lifecycle()'s streak source replayed as
 * 'box' events: this system's Double Cash / Double XP XP = streak.lifecycle()'s buff value (what
 * streak.streakValue() put in its boxes' cash equivalent). (2) When streak.js exports its system (5b.3):
 * streak.system() + this system on the core: every buff unit the streak grants is received here, the
 * streak's own ledger source carries only the non-buff contents, and the two add up to streak.lifecycle()'s
 * cash equivalent.
 */
function reconcileStreakOnCore(days = 30) {
	const rows = {};
	for (const name of Object.keys(F.ARCHETYPES)) {
		const theirs = streak.lifecycle(name, { maxDays: days, maxLevel: Infinity, snapshots: [days] }).snapshots[days];
		const replay = coreView(coreRun(name, { valuation: 'dayEnd', sources: ['streak'], days, checkpoints: [days] }).sys.buffsProbe.days[days]);
		const row = {
			replay: {
				doubleCash: { buffs: round(replay.cashBy.doubleCash, 2), streakLifecycle: round(theirs.streakBy.doubleCash, 2) },
				doubleXpXp: { buffs: round(replay.xpBy.buff, 2), streakLifecycle: round(theirs.xpBy.streak, 2) },
				match: relDiff(replay.cashBy.doubleCash, theirs.streakBy.doubleCash) < 1e-6 && relDiff(replay.xpBy.buff, theirs.xpBy.streak) < 1e-6,
			},
		};
		rows[name] = row;
		if (typeof streak.system !== 'function') continue;
		try {
			const run = LC.simulate({ archetype: name, systems: [lifecycleGear(), LC.provisionalDaily(), streak.system(), system({ valuation: 'dayEnd', events: false })], days, stopAtLevel: null });
			const st = run.sys.streak || {};
			const granted = sum(Object.values(st.buffs || {}));
			const received = sum(Object.values(run.sys[SYSTEM_NAME].receivedBySource.streak || {}));
			const nonBuff = run.ledger.cash.streak || 0;
			const buffCash = run.ledger.cash[BUFF_SOURCE] || 0;
			row.withStreakSystem = {
				buffUnits: { grantedByStreak: round(granted, 6), receivedByBuffs: round(received, 6) },
				streakCash: { nonBuffContents: round(nonBuff, 2), doubleCash: round(buffCash, 2), total: round(nonBuff + buffCash, 2), streakLifecycleCashEquivalent: round(theirs.cashBy.streak, 2) },
				doubleXpXp: { buffs: round(run.ledger.xp[BUFF_SOURCE] || 0, 2), streakLifecycle: round(theirs.xpBy.streak, 2) },
				// Counted once: the only XP/cash beyond fishing, the daily and the streak's own box contents
				// are this system's sources, and they hold exactly what this system credited.
				buffValueOnlyHere: Object.keys(run.ledger.xp).every((k) => ['fishing', 'daily', BUFF_SOURCE].includes(k))
					&& Object.keys(run.ledger.cash).every((k) => ['fishing', 'streak', BUFF_SOURCE, LUCKY_SOURCE].includes(k))
					&& (run.ledger.xp[BUFF_SOURCE] || 0) === run.sys[SYSTEM_NAME].value.doubleXpXp && buffCash === run.sys[SYSTEM_NAME].value.doubleCash,
			};
			const w = row.withStreakSystem;
			w.match = w.buffValueOnlyHere && relDiff(granted, received) < 1e-9 && relDiff(nonBuff + buffCash, theirs.cashBy.streak) < 1e-6 && relDiff(run.ledger.xp[BUFF_SOURCE] || 0, theirs.xpBy.streak) < 1e-6;
		}
		catch (e) {
			row.withStreakSystem = { available: false, reason: e.message };
		}
	}
	const withSystem = Object.values(rows).map((r) => r.withStreakSystem).filter((x) => x && x.available !== false);
	return {
		days,
		rows,
		replayMatch: Object.values(rows).every((r) => r.replay.match),
		withStreakSystem: typeof streak.system !== 'function' ? 'streak.system() not exported' : withSystem.length === Object.keys(rows).length ? withSystem.every((x) => x.match) : 'streak.system() run failed (see rows)',
	};
}

let validation = null;
/**
 * validateSystem(): system() on the shared core vs this module's lifecycle(), every archetype and the
 * minimum-daily player, with lifecycle()'s gear rule, provisional daily and buff sources as systems
 * (lifecycleGear, LC.provisionalDaily, lifecycleSources: the assumptions lifecycle() made).
 *   replay   system(LIFECYCLE_CONVENTIONS): the day's buffs valued at its end, at the last step's rates over
 *            min(window, daily play). Must reproduce lifecycle() (milestone hours step-exact, buff XP at
 *            milestones, XP / cash / Lucky Draw / arrivals and levels at the checkpoints).
 *   system   system() with its defaults (the design rule: activation at the next session start, the window
 *            in play minutes, the bonus on each step's catch): the same comparison, differences explained.
 * The minimum-daily player: lifecycle() ran minimumDailyArchetype(), a FIXED 3-min day (the streak gate's
 * 20 casts at Old Rod speed); the replay runs that same object on the core (same day-boundary rule, same
 * steps). The system runs the shared F.MINIMUM_DAILY, which plays until the streak gate every day
 * (lifecycleSources.sessionDone); minimumDailyStepping isolates that archetype difference.
 */
function validateSystem({ tolerance = 0.005 } = {}) {
	if (validation) return validation;
	const oldMinimum = { ...minimumDailyArchetype(), name: 'minimumDaily (lifecycle(): fixed 3-min day)' };
	const cases = [
		...Object.keys(F.ARCHETYPES).map((n) => ({ key: n, old: n, replay: n, system: n, checkpoints: [7, 30, 90] })),
		{ key: 'minimumDaily', old: minimumDailyArchetype(), replay: oldMinimum, system: F.MINIMUM_DAILY.name, checkpoints: [7, 28, 30, 91, 182, 364] },
	];
	const replay = {};
	const proposed = {};
	const shares30d = {};
	let minimumDailyStepping = null;
	for (const c of cases) {
		const horizon = c.key === 'minimumDaily' ? Math.max(...c.checkpoints) : Math.max(Math.max(...c.checkpoints), lifecycle(c.old).days + 1);
		const old = lifecycle(c.old, { maxDays: horizon, maxLevel: Infinity, snapshots: c.checkpoints });
		const rep = coreRun(c.replay, { valuation: LIFECYCLE_CONVENTIONS.valuation, days: horizon, checkpoints: c.checkpoints });
		const sys = coreRun(c.system, { valuation: SYSTEM_DEFAULTS.valuation, days: horizon, checkpoints: c.checkpoints });
		replay[c.key] = compareWithLifecycle(old, rep, c.checkpoints);
		proposed[c.key] = compareWithLifecycle(old, sys, c.checkpoints);
		if (c.replay !== c.system) {
			const cmp = compareWithLifecycle(old, coreRun(c.system, { valuation: LIFECYCLE_CONVENTIONS.valuation, days: horizon, checkpoints: c.checkpoints }), c.checkpoints);
			minimumDailyStepping = { hoursMaxRel: cmp.hoursMaxRel, maxAbsSteps: cmp.maxAbsSteps, ledgerMaxRel: cmp.ledgerMaxRel, ledgerWorst: cmp.ledgerWorst, lastCheckpointLedgerMaxRel: Math.max(...LEDGER_FIELDS.map(([k]) => cmp.checkpoints[horizon][k].rel)) };
		}
		const share = buffIncomeShare(c.key, { days: 30 });
		const pick = (x) => ({ level: x.level, cash: round(x.cash, 5), cashDoubleCashOnly: round(x.cashDoubleCashOnly, 5), cashLuckyDrawOnly: round(x.cashLuckyDrawOnly, 5), xp: round(x.xp, 5), buffsPer30dTotal: round(x.buffsPer30dTotal, 4) });
		const use = sys.sys[SYSTEM_NAME];
		shares30d[c.key] = {
			buffIncomeShare: pick(share),
			replay: pick(coreShare(rep.sys.buffsProbe.days[30], 30)),
			system: pick(coreShare(sys.sys.buffsProbe.days[30], 30)),
			systemBuffUse: {
				activatedUnits: Object.fromEntries(TIMED.map((n) => [n, round(use.activated[n], 4)])),
				buffedPlayMinutesPerUnit: Object.fromEntries(TIMED.map((n) => [n, round(use.buffedMinutes[n] / Math.max(1e-12, use.activated[n]), 2)])),
			},
		};
	}
	const agg = (runs, kind) => Object.entries(runs).reduce((a, [k, r]) => (r[`${kind}MaxRel`] > a.maxRel ? { maxRel: r[`${kind}MaxRel`], at: `${k} ${r[`${kind}Worst`]}` } : a), { maxRel: 0, at: null });
	const replayMax = agg(replay, 'max');
	const sysHours = agg(proposed, 'hours');
	const sysLedger = agg(proposed, 'ledger');
	const count = (runs, k) => sum(Object.values(runs).map((r) => r[k]));
	const maxSteps = Math.max(...Object.values(proposed).map((r) => r.maxAbsSteps));
	// Hours agree when every milestone is within the tolerance or within one step (the core's resolution:
	// 1 min, i.e. 1.2% of an 81-min L10).
	const hoursOk = Object.values(proposed).every((r) => Object.values(r.milestones).every((m) => Math.abs(m.hours.steps) <= 1 || m.hours.rel <= tolerance));
	const streakRec = reconcileStreakOnCore();
	const replayExact = replayMax.maxRel < 1e-9 && Object.values(replay).every((r) => !r.missing.length && r.levelsMatch && r.exactMilestones === r.milestonesCompared);
	const day30 = Object.fromEntries(Object.entries(proposed).map(([k, r]) => [k, round(Math.max(...LEDGER_FIELDS.map(([f]) => r.checkpoints[30][f].rel)), 4)]));
	const lastDay = (r) => Math.max(...Object.keys(r.checkpoints).map(Number));
	const perUnitLast = Object.fromEntries(Object.entries(proposed).map(([k, r]) => [k, { day: lastDay(r), ...r.checkpoints[lastDay(r)].valuePerUnitUsed }]));
	const lastCheckpoint = Object.fromEntries(Object.entries(proposed).map(([k, r]) => [k, { day: lastDay(r), maxRel: round(Math.max(...LEDGER_FIELDS.map(([f]) => r.checkpoints[lastDay(r)][f].rel)), 4) }]));
	validation = {
		method: 'LC.simulate with buffs.system() + lifecycle()\'s assumptions as systems (lifecycleGear: LC.provisionalRods\' purchase rule + the rods \'assembly\' event; LC.provisionalDaily(); lifecycleSources: the streak box of each played day and quests.questIncome\'s Daily Boxes as \'box\' events; the event budget from the system itself) + a probe, per archetype (F.ARCHETYPES, to Lv 60 and at least 90 days) and the minimum-daily player (364 days) vs lifecycle(). Hours compared step-exact (lifecycle() rounds to 0.01 h); calendar days differ by convention (the core counts a level reached on a day\'s final step in that day, lifecycle()\'s ceil(h / dayH) the next day), so hours are compared, not days.',
		tolerance,
		replay: {
			options: { ...LIFECYCLE_CONVENTIONS },
			exact: replayExact,
			maxRelativeDifference: replayMax.maxRel,
			worst: replayMax.at,
			milestonesCompared: count(replay, 'milestonesCompared'),
			exactMilestones: count(replay, 'exactMilestones'),
			byArchetype: replay,
		},
		system: {
			options: { ...SYSTEM_DEFAULTS },
			hoursMaxRelativeDifference: sysHours.maxRel,
			hoursWorst: sysHours.at,
			hoursMaxAbsSteps: maxSteps,
			hoursWithinTolerance: hoursOk,
			ledgerMaxRelativeDifference: sysLedger.maxRel,
			ledgerWorst: sysLedger.at,
			ledgerMaxRelativeDifferenceAtDay30: day30,
			ledgerMaxRelativeDifferenceAtLastCheckpoint: lastCheckpoint,
			valuePerUnitUsedAtLastCheckpoint: perUnitLast,
			milestonesCompared: count(proposed, 'milestonesCompared'),
			exactMilestones: count(proposed, 'exactMilestones'),
			minimumDailyStepping,
			byArchetype: proposed,
			differences: [
				'Activation timing (the one rule difference). lifecycle() valued every buff received on a day at that day\'s end, at the rates of the day\'s last step, as if it had covered min(1 h, the day\'s play) of that same day. The system activates a held Double XP / Double Cash at the NEXT session start and pays the bonus on the casts its window actually covers (play minutes of that session, each step at its own rates). A box granted at a session\'s end (the Daily Box, the Streak Crate) can only be used in a later session, and a player who plays an hour or less gets the whole window only by starting the buff with the session, so the system is right. Event buffs arrive with the first cast of a played day and are used that day in both.',
				'Hours: every milestone within 1 step (1 min) of lifecycle(); a box-borne Double XP now pays over the next day\'s session instead of at the previous day\'s end, so a level reached early in a session can come one step later (regular L10: 81 vs 80 steps).',
				'Ledgers at a checkpoint: the gap in Double XP XP / Double Cash to date is the one-day lag. The system still holds the last played day\'s box-borne units (stockAtEnd: about 0.023 Double XP and 0.023 Double Cash, one day of Streak Crate + Daily Box odds), which lifecycle() had already paid, at that day\'s last-step rates (a level that crosses a biome or tier late in the day prices the whole day\'s arrivals at the new stage). So the relative gap falls like 1/days: 16-22% at day 7, 1.5-4.3% at day 30, about 1% at day 90, 0.2-0.3% at day 364 (ledgerMaxRelativeDifferenceAtDay30 / AtLastCheckpoint). Per unit actually USED the two agree within 0.75% for Double Cash and 0.12% for Double XP (valuePerUnitUsedAtLastCheckpoint). The residual: lifecycle() priced a day\'s units at its last step\'s rates, the system at the rates of the steps each window covers, which differ on days a biome or tier changes mid-session and, for sessions over an hour (active, grinder), because a session-start window meets the session\'s first hour. Fishing XP / cash and levels are unchanged to within the 1-step hour shifts. The 30-day shares (shares30d) move by at most 0.15 percentage point of income (casual cash 6.12% -> 5.97%).',
				'Lucky Draw: the same rule in both (one reserved for the next tier assembly and credited at it as cash \'luckyDraw\', the surplus on Streak Crates at the day end); it differs only through the level at which the surplus is spent.',
				'Minimum-daily player: lifecycle()\'s fixed 3-min day drifts through floating point (the play clock sometimes crosses a day boundary one step late: a 4-step day, later a 2-step day); F.MINIMUM_DAILY plays exactly the 20-cast gate every day (3 steps). minimumDailyStepping: the same valuation as lifecycle(), only the archetype changed. The shared archetype is right.',
				'Days: hours are compared, not days (the core counts a level reached on a day\'s final step in that day).',
			],
		},
		shares30d,
		streak: streakRec,
		matches: replayExact && hoursOk && streakRec.replayMatch,
		maxRelativeDifference: replayMax.maxRel,
	};
	return validation;
}

/** The system block of report(). */
function systemReport() {
	return {
		name: SYSTEM_NAME,
		defaults: { ...SYSTEM_DEFAULTS },
		lifecycleConventions: { ...LIFECYCLE_CONVENTIONS },
		hooks: ['init', 'on(box)', 'on(assembly)', 'onDayStart', 'onCasts', 'onDayEnd', 'sessionDone'],
		ledger: LEDGER_SOURCES,
		events: { listens: ['box', 'assembly'], emits: [] },
		sinks: 'none',
		validation: validateSystem(),
	};
}

// ---------------------------------------------------------------------------------------------
let checksCache = null;
function checks() {
	if (checksCache) return checksCache;
	const T = PARAMS.targets;
	const list = [];
	const add = (id, pass, detail) => list.push({ id, pass: Boolean(pass), detail });
	add('baseline-reproduces-curve-json', baselineMatchesCurveJson(), 'lifecycle with no buff source, on the provisional path curve.json was fitted on = docs/economy/5b/curve.json hours, every archetype and milestone');
	const rec = reconcileWithStreak();
	add('streak-buff-values-reconcile', Object.values(rec).every((r) => r.match), 'streak-only Double Cash and Double XP XP equal streak.lifecycle() at 30 days, every archetype');
	add('lucky-chain-reproduces-rods', TIERS.every((t) => Math.abs(luckyAssembly(t, { opens: 0 }) - rods.cratesDistribution(t).expected) < 1e-9), 'Lucky Draw chain with 0 lucky opens = rods.cratesDistribution(t).expected, T1-T5');
	for (const name of Object.keys(F.ARCHETYPES)) {
		const s = buffIncomeShare(name, { days: 30 });
		add(`cash-share-${name}`, s.cash <= T.cashShareMax30d[name], `buffs add ${(100 * s.cash).toFixed(2)}% of fishing income in 30 days (max ${100 * T.cashShareMax30d[name]}%)`);
		add(`xp-share-${name}`, s.xp <= T.xpShareMax, `Double XP adds ${(100 * s.xp).toFixed(2)}% of XP in 30 days (max ${100 * T.xpShareMax}%)`);
	}
	const reg = buffIncomeShare(F.REFERENCE_ARCHETYPE, { days: 30 });
	add('buffs-per-30-days', reg.buffsPer30dTotal >= T.buffsPerThirtyDays[0] && reg.buffsPer30dTotal <= T.buffsPerThirtyDays[1], `${reg.buffsPer30dTotal.toFixed(2)} buffs per 30 days for a daily player (target ${T.buffsPerThirtyDays.join('-')})`);
	const R = r2();
	add('regular-in-windows-with-buffs', Object.values(R.windows).every((w) => w.inside), Object.entries(R.windows).map(([L, w]) => `L${L} ${w.with} h`).join(', '));
	add('window-shift-small', R.archetypes.regular.maxHoursDelta <= T.windowShiftMax, `regular milestones move ${(100 * R.archetypes.regular.maxHoursDelta).toFixed(2)}% (max ${100 * T.windowShiftMax}%)`);
	add('minimum-daily-never-leads', !R.minimumDaily.leadsAnywhere, R.minimumDaily.verdict);
	add('no-miss-grinder', R.noMissGrinder.maxHoursDelta <= T.windowShiftMax, R.noMissGrinder.verdict);
	const dc = doubleCashModels(F.REFERENCE_ARCHETYPE, { days: 90 });
	add('sale-time-uncapped-rewards-stockpiles', dc.share.saleTimeHoarderUncapped > 3 * dc.share.catchTime, `90 days, regular: sale-time hoarder +${(100 * dc.share.saleTimeHoarderUncapped).toFixed(1)}% vs catch-time +${(100 * dc.share.catchTime).toFixed(1)}% (why catch-time)`);
	const ld = TIERS.map((t) => luckyDrawValue(t));
	add('lucky-draw-never-inert', ld.every((x) => x.stageHours >= T.luckyDrawMinHoursAnyTier), `proposed Lucky Draw saves ${ld.map((x) => `${x.stageHours.toFixed(2)} h`).join(' / ')} of stage income on the T1-T5 assemblies (min ${T.luckyDrawMinHoursAnyTier})`);
	add('today-lucky-draw-inert-on-floored-crates', current().luckyToday.tierCrates.filter((x) => x.inert).length >= 3, 'today\'s +50% rare+ Lucky Draw saves 0 crates on the Expert, Master and Gilded crates');
	const V = validateSystem();
	add('system-replays-lifecycle', V.replay.exact, `5b.3 system on the shared core with lifecycle()'s conventions reproduces lifecycle(): ${V.replay.exactMilestones}/${V.replay.milestonesCompared} milestones step-exact, max relative difference ${V.replay.maxRelativeDifference} (every archetype + minimum-daily)`);
	add('system-hours-within-tolerance', V.system.hoursWithinTolerance, `system() defaults (activation at the next session start) move milestone hours by at most ${V.system.hoursMaxAbsSteps} step (${(100 * V.system.hoursMaxRelativeDifference).toFixed(2)}% at ${V.system.hoursWorst}; tolerance ${100 * V.tolerance}% or 1 step)`);
	add('system-streak-counted-once', V.streak.replayMatch && V.streak.withStreakSystem !== false, 'streak boxes\' Double Cash / Double XP valued once, by the buffs system, = streak.lifecycle() (and streak.system() + buffs.system() add up to it when streak.js exports its system)');
	checksCache = { pass: list.every((c) => c.pass), list };
	return checksCache;
}

// ---------------------------------------------------------------------------------------------
let reportCache = null;
function report() {
	if (reportCache) return reportCache;
	const archetypes = Object.keys(F.ARCHETYPES);
	const shares = Object.fromEntries(archetypes.map((a) => [a, Object.fromEntries([7, 30, 90].map((d) => [d, buffIncomeShare(a, { days: d })]))]));
	shares.minimumDaily = { 30: buffIncomeShare('minimumDaily', { days: 30 }) };
	const noEvents = Object.fromEntries(archetypes.map((a) => [a, buffIncomeShare(a, { days: 30, sources: ['streak', 'quests'] })]));
	const decision8 = Object.fromEntries(archetypes.map((a) => [a, { 30: doubleCashModels(a, { days: 30 }), 90: doubleCashModels(a, { days: 90 }) }]));
	// Buff frequency sensitivity of the uncapped sale-time hoarder (why a cap would be needed).
	const frequency = Object.fromEntries([
		['today: Daily Box only', ['todayDailyBox']],
		['today: Daily Box + Top.gg votes', ['todayDailyBox', 'todayVotes']],
		['proposed without events', ['streak', 'quests']],
		['proposed', ALL_SOURCES],
	].map(([label, sources]) => [label, Object.fromEntries(archetypes.map((a) => {
		const m = doubleCashModels(a, { days: 90, sources });
		return [a, { doubleCashPer30d: m.doubleCashPer30d, catchTime: m.share.catchTime, saleTimeHoarderUncapped: m.share.saleTimeHoarderUncapped, saleTimeHoarderCapped: m.share.saleTimeHoarderCapped }];
	}))]));
	// Duration models side by side (30 days): wall-clock hour (proposed) vs casts-based (alternative).
	const durationAlternatives = Object.fromEntries([...archetypes, 'minimumDaily'].map((a) => {
		const m = doubleCashModels(a === 'minimumDaily' ? minimumDailyArchetype() : a, { days: 30 });
		return [a, { doubleCash: { wallclock: m.share.catchTime, castsBased: m.share.catchTimeCastsBased }, doubleXp: m.doubleXpShare, castsBasedCasts: m.castsBasedCasts }];
	}));
	const stages = F.LIVE_BIOMES.map((b) => F.BIOME_LEVEL[b]);
	const perBuff = Object.fromEntries(archetypes.map((a) => [a, stages.map((L) => valuePerBuff(L, a))]));
	const luckyDraw = {
		proposed: TIERS.map((t) => luckyDrawValue(t)),
		byOpens: Object.fromEntries(PARAMS.alternatives.luckyDrawOpens.map((k) => [k, TIERS.map((t) => luckyDrawValue(t, { opens: k }))])),
		bonusSlot: ['Daily Box', 'Streak Crate'].map((b) => ({ box: b, perStage: stages.map((L) => ({ level: L, biome: F.biomeAt(L), value: bonusSlotValue(b, L) })) })),
	};
	reportCache = {
		...F.stamp(),
		gearPathSource: F.GEAR_PATH_SOURCE,
		params: PARAMS,
		referenceCastsPerHour: referenceCastsPerHour(),
		current: current(),
		sources: {
			perOpen: {
				'Streak Crate': boxBuffOdds('Streak Crate', 0),
				'Streak Chest': boxBuffOdds('Streak Chest', 0),
				'Daily Box': boxBuffOdds(DAILY_BOX, 0),
			},
			perThirtyDays: Object.fromEntries(archetypes.map((a) => [a, { total: shares[a][30].buffsPer30dTotal, byType: shares[a][30].buffsPer30d, bySource: Object.fromEntries(Object.entries(shares[a][30].bySource).map(([k, v]) => [k, v.buffsPer30d])) }])),
		},
		buffIncomeShare: shares,
		buffIncomeShareWithoutEvents: noEvents,
		decision8,
		durationAlternatives,
		frequency,
		perBuff,
		luckyDraw,
		r2: r2(),
		founder: founderView(),
		reconcileWithStreak: reconcileWithStreak(),
		baselineMatchesCurveJson: baselineMatchesCurveJson(),
		system: systemReport(),
		ruleExamples: ruleExamples(),
		checks: checks(),
	};
	return reportCache;
}

module.exports = {
	PARAMS,
	defaultState, activate, effectsAt, consumeOpen, temporaryMultiplier, catchValue, catchXp, legacyKind, ruleExamples,
	boxBuffOdds, arrivals, bonusSlotValue, luckyAssembly, luckyDrawValue,
	lifecycle, doubleCashModels, saleTimeHoarder, buffIncomeShare, valuePerBuff,
	current, r2, founderView, baselineMatchesCurveJson, reconcileWithStreak, checks, minimumDailyArchetype,
	SYSTEM_NAME, SYSTEM_DEFAULTS, LIFECYCLE_CONVENTIONS, LEDGER_SOURCES, system, validateSystem, coverage, coreRun,
	report,
};

if (require.main === module) process.stdout.write(`${JSON.stringify(module.exports.report(), null, 1)}\n`);
