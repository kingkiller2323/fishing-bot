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
//   checks()                      design-target checks (pass/fail)
//   report()                      every number in docs/economy/5b/buffs.md (cached), with ...F.stamp()
const F = require('./framework');
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
// Design parameters (the only hand-set numbers in this subsystem).
const PARAMS = deepFreeze({
	id: 'buffs-5b',
	// The rule every choice below follows: a buff multiplies PLAY inside its window, never a STOCKPILE
	// built outside it (hoarded fish sold at x2, hoarded boxes opened in one lucky hour).
	principle: 'A buff multiplies play, never a stockpile.',
	// Decision 8: Double Cash rewards fish CAUGHT during the buff. The bonus is stamped into the fish's
	// stored value at catch (like every other sell modifier today), so the sale path never reads buffs.
	doubleCash: { timing: 'catch' },
	catalog: {
		'Double XP': { kind: 'xp', multiplier: 2, duration: { type: 'wallclock', seconds: 3600 }, applies: 'XP of fish caught by casting (never quest XP, never box fish)' },
		'Double Cash': { kind: 'cash', multiplier: 2, duration: { type: 'wallclock', seconds: 3600 }, applies: 'value of fish caught by casting, stamped into the stored value (never quest cash, box fish or items)' },
		// Lucky Draw: today's +50% rare+ weights are inert on floored crates (see current()); proposed: one
		// bonus slot on each of the next `opens` box opens, any box.
		// The Booster Pack keeps its exact contents (decision 12): a Lucky Draw charge is not used on it.
		'Lucky Draw': { kind: 'gacha', bonusSlots: 1, duration: { type: 'charges', opens: 2 }, excludeBoxes: ['Booster Pack'], applies: 'the next box opens (any box, including legacy Voter\'s Crates; not the Booster Pack)' },
	},
	stacking: {
		// A second buff of a running kind queues behind it (extends the timer or adds charges) instead of
		// stacking its multiplier; at most `maxQueued` durations can be banked per kind.
		sameKind: 'queue',
		maxQueued: 3,
		acrossKinds: 'independent',
		// Temporary boosts in one category ADD their bonuses: x2 buff during a x2 event pays x3, not x4.
		withEvent: 'additive',
		// Gear/aquarium stats and the private profile keep multiplying, as today.
		withGearAndProfile: 'multiply',
	},
	sources: {
		// Streak Crate / Streak Chest pools exactly as the streak design proposes (buff odds via streak.boxEV).
		streak: { from: 'streak.js' },
		// Daily/weekly quest Daily Boxes (quests.js questIncome().boxes), today's Daily Box pool unchanged.
		quests: { from: 'quests.js' },
		// The deliberate, tunable lever: an event calendar grants at most this many buffs per 30 days to
		// players who fish during the event. No Double XP from events (XP events use event multipliers).
		events: { perThirtyDays: { 'Double XP': 0, 'Double Cash': 1, 'Lucky Draw': 1 } },
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
		{ case: 'queue bound', before: `${PARAMS.stacking.maxQueued} Double XP activated at t0 (ends t0 + ${(q.state.active.xp.endsAt - t0) / H} h)`, event: `activate one more`, after: `${full.reason}, stock kept at ${full.state.stock['Double XP']}` },
		{ case: 'Lucky Draw charges', before: 'stock Lucky Draw 1', event: 'activate, then open Master Tackle Crate, Booster Pack, Streak Crate, Daily Box', after: `bonus slots per open: ${[o1.bonusSlots, ob.bonusSlots, o2.bonusSlots, o3.bonusSlots].join(', ')} (the Booster Pack uses no charge)` },
		{ case: 'buff + event', before: 'Double Cash x2, event sell x2', event: 'catch a $100 fish (no gear bonus)', after: `stored $${catchValue({ rawValue: 100, buffCash: 2, eventSell: 2 }).final} (x3, not x4)` },
		{ case: 'gear and profile multiply', before: 'Double Cash, handle +5%, private profile x10', event: 'catch a $100 fish', after: `public $${catchValue({ rawValue: 100, sellBonus: 0.05, buffCash: 2, profileSell: 10 }).base}, stored $${catchValue({ rawValue: 100, sellBonus: 0.05, buffCash: 2, profileSell: 10 }).final}` },
		{ case: 'sale pays the stored value', before: 'fish caught under Double Cash, sold later', event: 'sell with no buff active', after: 'paid the stored value (x2 already in it); a fish caught before the buff is never doubled' },
	];
}

// ---------------------------------------------------------------------------------------------
// Stage rates (the same castOutcome/hourly call as curve.js).
const rateCache = new Map();
function rates(biome, tier, overheadS) {
	const key = `${biome}|${tier.tier}|${overheadS}`;
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
	const key = `${band}|${tier.tier}|${arch.minutesPerDay}|${arch.overheadS}|${Boolean(arch.minimumDaily)}`;
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
/** Liquid value (fish + part salvage) of one extra, non-guaranteed slot of `box` at `level`. */
function bonusSlotValue(box, level = 0) {
	const def = typeof box === 'string' ? streak.boxDefinitions()[box] || (box === 'Daily Box' ? DAILY_BOX : null) : box;
	return streak.boxEV({ ...def, id: `${def.id}+1`, slots: 1, guaranteedSlots: [] }, { level }).liquid;
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
/**
 * @param {string|object} archetype  F.ARCHETYPES name/entry, or minimumDailyArchetype()
 * @param {object} opts sources (default proposed), dailyXp, applyXp (Double XP XP feeds the level),
 *   maxDays, maxLevel, snapshots
 */
function lifecycle(archetype, { sources = ALL_SOURCES, dailyXp = true, applyXp = true, maxDays = Infinity, maxLevel = F.LIFECYCLE.maxLevel, snapshots = [7, 30, 90] } = {}) {
	const arch = archOf(archetype);
	const path = F.gearPath();
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
function baselineMatchesCurveJson() {
	return Object.keys(F.ARCHETYPES).every((name) => {
		const lc = lifecycle(name, { sources: [] });
		return Object.entries(CURVE_JSON.archetypes[name]).every(([L, v]) => lc.reached[L] && lc.reached[L].hours === v.hours && lc.reached[L].day === v.day);
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
let checksCache = null;
function checks() {
	if (checksCache) return checksCache;
	const T = PARAMS.targets;
	const list = [];
	const add = (id, pass, detail) => list.push({ id, pass: Boolean(pass), detail });
	add('baseline-reproduces-curve-json', baselineMatchesCurveJson(), 'lifecycle with no buff source = docs/economy/5b/curve.json, every archetype and milestone');
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
	report,
};

if (require.main === module) process.stdout.write(`${JSON.stringify(module.exports.report(), null, 1)}\n`);
