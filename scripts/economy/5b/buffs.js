// Phase 5B subsystem: BUFFS (Double XP, Double Cash, Lucky Draw) and the Double Cash timing decision
// (user decision 8). ANALYSIS ONLY: nothing here touches the live game, src/ or production data.
//
// Framework 5b.4. The buff layer is a SYSTEM on the shared lifecycle core (lifecycle.js): system() below.
// integrate.js composes it with rods, world, quests and streak into the reference loop, and every
// lifecycle-derived number in this module comes from integrate.run(). This module steps no time itself.
// Static figures (box buff odds, the Lucky Draw crate chains, one buff's value at a stage, today's catalog)
// come from the framework's pure functions and finished-design helpers: streak.boxEV() / boxDefinitions()
// (box odds; the streak ladder is the streak system's own) and the rods crate helpers (crateDefinition,
// openOutcomes, cratesDistribution, cratePrice, stageIncome, assembly; never a gear source, R3).
// Only PARAMS is hand-set; every non-obvious choice in it is a PROPOSED decision in DECISIONS (joined to
// decisions.js). The shared buff rules (F.BUFFS) and event budget (F.EVENTS) are read, never restated.
//
//   node scripts/economy/5b/buffs.js          prints report() as JSON
//   node scripts/economy/5b/render-docs.js    fills docs/economy/5b/buffs.md from markdownTables()
//
// Exports (pure and synchronous; no database, no randomness):
//   PARAMS, DECISIONS             design parameters; the proposed decisions (status 'proposed' only)
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
//   --- static model (no lifecycle) ---
//   boxBuffOdds(box, level, {profile})  expected buffs of each type per open (streak.boxEV; exact)
//   bonusSlotValue(box, level)    liquid value (fish + salvage) of one extra non-guaranteed slot
//   luckyAssembly(t, {opens, mode})
//                                 exact expected tier-t crates to assemble the rods reference set when the
//                                 first `opens` opens are lucky ('slot' = proposed bonus slot, 'luck' =
//                                 today's +50% rare+ weights); opens = 0 reproduces rods exactly
//   luckyDrawValue(t)             proposed Lucky Draw on tier t's assembly: crates, $, stage hours
//   valuePerBuff(level, archetype)
//                                 one buff of each type at a stage: $ / XP and minutes of own play
//   current()                     today's buffs: catalog, measured box odds, bugs (with fixes and the deploy
//                                 each ships in, PARAMS.rollout), stacking, Lucky Draw inertness
//   liveBuffPaths()               the live buff readers and the slash-only expiry sweep, as src/ file:line
//                                 read at report time (evidence for B2/B3; nothing runs the bot)
//   LIVE_REPRO                    the recorded reproduction of B2 + B3 on the in-memory test database
//   --- the system ---
//   system(opts)                  the buffs SYSTEM (lifecycle.js hooks; integrate.js runs it). opts:
//                                 sources (which buff sources it receives), trace (observational record)
//   SYSTEM_NAME, SYSTEM_DEFAULTS, SOURCES, TODAY_SOURCES, LEDGER_SOURCES, coverage()
//   SYSTEM_PARITY                 the recorded parity of system() with the retired private loop (a83b5f0)
//   --- the integrated model (integrate.run) ---
//   lifecycle(archetype, {sources})
//                                 one traced integrated run over the archetype's horizon: exact ledger
//                                 closes per day, daily rows (the Double Cash alternatives), milestones
//   buffIncomeShare(archetype, {days, sources})
//                                 share of fishing income (cash) and of XP that buffs add, by buff and source
//   doubleCashModels(archetype, {days, sources})
//                                 decision 8: catch-time (the system), buff saver, casts-based duration,
//                                 sale-time non-hoarder / hoarder uncapped (exact renewal DP) / capped
//   saleTimeHoarder(rows, {capHours})
//                                 sale-time hoarder bonus from the daily rows (analytic, no stepping)
//   r2(), founderView(), checks()
//   report()                      every number in docs/economy/5b/buffs.md (cached), with ...F.stamp()
//   markdownTables()              the doc's generated tables ({ blockId: markdown })
const fs = require('fs');
const nodePath = require('path');
const F = require('./framework');
const I = require('./integrate');
const streak = require('./streak');
const rods = require('./rods');
const { buildTable } = require('../../../src/engine/rarity');
const { RARITIES, PROFILES } = require('../../../src/engine/balance');
const { BOXES } = require('../../../src/engine/gachaBoxes');
const { buffEffects: engineBuffEffects } = require('../../../src/engine/modifiers');
const BUFF_CATALOG = require('../../../src/bootstrap/data/buffs');
const GACHA_EV = require('../../../docs/economy/gacha-ev.json');

const deepFreeze = (o) => {
	for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
	return Object.freeze(o);
};
const sum = (a) => a.reduce((s, x) => s + x, 0);
const clone = (o) => JSON.parse(JSON.stringify(o));
const BUFF_NAMES = ['Double XP', 'Double Cash', 'Lucky Draw'];
const ARCHETYPE_NAMES = Object.keys(F.ARCHETYPES);

// ---------------------------------------------------------------------------------------------
// Design parameters (the only hand-set numbers in this subsystem). The rules this design proposed for the
// framework are the SHARED F.BUFFS (timing, duration, multipliers, Lucky Draw, stacking) and F.EVENTS (event
// budget); they are read from there (copied, so deepFreeze never freezes the shared objects).
const PARAMS = deepFreeze({
	id: 'buffs-5b',
	// The rule every choice below follows: a buff multiplies PLAY inside its window, never a STOCKPILE
	// built outside it (hoarded fish sold at x2, hoarded boxes opened in one lucky hour).
	principle: 'A buff multiplies play, never a stockpile.',
	// Decision 8: Double Cash rewards fish CAUGHT during the buff. The bonus is stamped into the fish's
	// stored value at catch (like every other sell modifier today), so the sale path never reads buffs.
	// PROPOSED at framework level (decisions.js P-DOUBLE-CASH).
	doubleCash: { timing: F.BUFFS.doubleCashTiming },
	// Deploy order of the correctness fixes (bugs table "Ships"; P-BUFFS-HOTFIX, P-BUFFS-FIX-DURATION). B3 alone
	// restores today's intended behaviour (the few-second window of B1) and can ship now. B1 + B2 turn every
	// held unit into a real hour, so they ship only in the deploy that also stamps Double Cash at catch
	// (P-DOUBLE-CASH) and removes cash buffs from every sale path; earlier, each held Double Cash would be an
	// hour of sale-time hoarding. B4 and B5 need proposed values (P-BUFFS-QUEUE, the new catalog text).
	rollout: { hotfix: ['B3'], withDoubleCash: ['B1', 'B2'], withBalanceRelease: ['B4', 'B5'], anyTime: ['B6'] },
	catalog: {
		'Double XP': { kind: 'xp', multiplier: F.BUFFS.multipliers.xp, duration: { type: 'wallclock', seconds: F.BUFFS.durationSeconds }, applies: 'XP of fish caught by casting (never quest XP, never box fish)' },
		'Double Cash': { kind: 'cash', multiplier: F.BUFFS.multipliers.cash, duration: { type: 'wallclock', seconds: F.BUFFS.durationSeconds }, applies: 'value of fish caught by casting, stamped into the stored value (never quest cash, box fish or items)' },
		// Lucky Draw: today's +50% rare+ weights are inert on floored crates (see current()); proposed: one
		// bonus slot on each of the next `opens` box opens, any box.
		// The Booster Pack keeps its exact contents (decision 12): a Lucky Draw charge is not used on it.
		'Lucky Draw': { kind: 'gacha', bonusSlots: F.BUFFS.luckyDraw.bonusSlots, duration: { type: 'charges', opens: F.BUFFS.luckyDraw.opens }, excludeBoxes: ['Booster Pack'], applies: 'the next box opens (any box, including legacy Voter\'s Crates; not the Booster Pack)' },
	},
	// Activation: a buff runs only when the player activates a unit from stock (never on receipt). The model
	// assumes rational use: held Double XP / Double Cash are activated at the start of the next session, one
	// unit per started hour of the planned session (queued; a minimum-daily session: one), so a whole window
	// meets play. system() reads this.
	activation: { by: 'player', modelledAt: 'sessionStart', unitsPerSession: 'startedHours' },
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
		// Streak Crate / Streak Chest pools exactly as the streak design proposes (buff odds via streak.boxEV):
		// Double XP and Double Cash, never a Lucky Draw (user decision; streak.js P-STREAK-ITEM-POOL).
		streak: { from: 'streak.js' },
		// Where a Lucky Draw can come from: a rarer reward than the streak (user decision). The Booster Pack
		// keeps its Lucky Draw too but is never valued (below). checks() 'lucky-draw-sources' verifies it.
		luckyDrawFrom: ['quests', 'events'],
		// Daily/weekly quest Daily Boxes (the quests system's 'box' events), today's Daily Box pool unchanged.
		quests: { from: 'quests.js' },
		// The deliberate, tunable lever: an event calendar grants at most this many buffs per 30 days to
		// players who fish during the event. No Double XP from events (XP events use event multipliers).
		// PROPOSED at framework level (decisions.js P-EVENTS): the shared F.EVENTS budget.
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
		{ case: 'gear and profile multiply', before: 'Double Cash, handle +5%, private profile x10', event: 'catch a $100 fish', after: `public $${catchValue({ rawValue: 100, sellBonus: 0.05, buffCash: 2, profileSell: 10 }).base.toLocaleString('en-US')}, stored $${catchValue({ rawValue: 100, sellBonus: 0.05, buffCash: 2, profileSell: 10 }).final.toLocaleString('en-US')}` },
		{ case: 'sale pays the stored value', before: 'fish caught under Double Cash, sold later', event: 'sell with no buff active', after: 'paid the stored value (x2 already in it); a fish caught before the buff is never doubled' },
	];
}

// ---------------------------------------------------------------------------------------------
// Stage rates (F.castOutcome / F.hourly at a stage; static, no lifecycle).
const rateCache = new Map();
/** Cache key of a gear tier by content. */
const tierKey = (tier) => JSON.stringify([tier.qualities, tier.stats, tier.meanFish, tier.multiChance ?? null]);
function rates(biome, tier, overheadS) {
	const key = `${biome}|${tierKey(tier)}|${overheadS}`;
	if (!rateCache.has(key)) {
		const o = F.castOutcome({ biome, qualities: tier.qualities, stats: tier.stats, multiChance: tier.multiChance ?? F.chanceForMean(tier.meanFish) });
		rateCache.set(key, { ...F.hourly(o, overheadS), valuePerCast: o.valuePerCast });
	}
	return rateCache.get(key);
}
const archOf = (a) => (typeof a === 'string' ? F.ARCHETYPES[a] : a) || F.ARCHETYPES[F.REFERENCE_ARCHETYPE];
/** Casts in one reference hour (Old Rod cooldown + design overhead): the casts-based alternative. */
const referenceCastsPerHour = () => 3600 / (F.COOLDOWN.fishMs / 1000 + F.DESIGN_OVERHEAD_S);

// ---------------------------------------------------------------------------------------------
// Box buff odds.
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
/** 'box' event names priced by a definition rather than by name (streak.boxEV knows the rest). */
const BOX_REFS = { 'Daily Box': DAILY_BOX, 'Voter\'s Crate': VOTERS_TODAY };
const boxRef = (name) => BOX_REFS[name] || name;

// ---------------------------------------------------------------------------------------------
// Lucky Draw.
const slotCache = new Map();
/**
 * Liquid value (fish + part salvage) of one extra, non-guaranteed slot of `box` at `level`. profile
 * 'founder': the Founder gacha stats (streak.boxEV) and its fish sold at the PROPOSED Founder sell
 * multiplier (founder.founderProfile(), as streak.boxContents values a Founder's box).
 */
function bonusSlotValue(box, level = 0, { profile = 'normal' } = {}) {
	const def = typeof box === 'string' ? streak.boxDefinitions()[box] || BOX_REFS[box] || null : box;
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
/** Today's buff window after activation: the catalog length (seconds) added as milliseconds (B1). */
const TODAY_WINDOW_S = BUFF_CATALOG[0].length / 1000;
const luckyDef = (def, mode) => (mode === 'slot'
	? { ...def, id: `${def.id}+slot`, slots: def.slots + buffOf('Lucky Draw').bonusSlots }
	: { ...def, id: `${def.id}+luck`, rarityTable: buildTable(def.rarityTable, TODAY_LUCKY_STATS) });

const assemblyCache = new Map();
/**
 * Exact expected crates to assemble tier t's reference set (rods.assembly(t).needs) when the first
 * `opens` opens are lucky. Mirrors rods.cratesDistribution (same Markov chain over collected slots and
 * the box pity counter, same openOutcomes); opens = 0 reproduces it exactly (checks()).
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
	let dist = new Map([['0|0', 1]]);
	let expected = 0;
	for (let n = 0; n < maxN; n++) {
		let alive = 0;
		for (const [k, p] of dist) if (Number(k.split('|')[0]) !== full) alive += p;
		expected += alive;
		if (alive < 1e-12) break;
		const def = n < opens ? lucky : base;
		const next = new Map();
		for (const [k, p] of dist) {
			const [mask, c] = k.split('|').map(Number);
			if (mask === full) continue;
			for (const tr of transFor(def, c)) {
				const nk = `${mask | tr.mask}|${rule ? (tr.pityHit ? 0 : c + 1) : 0}`;
				next.set(nk, (next.get(nk) || 0) + p * tr.p);
			}
		}
		dist = next;
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
	const streakCrate = buffOf('Lucky Draw').duration.opens * bonusSlotValue('Streak Crate', level);
	return {
		level, biome, tier: tier.key,
		doubleCash: { dollars: w * r.cash, minutesOfOwnPlay: w * 60, ifSavedForAnHourSession: windowHours('Double Cash') * r.cash, shareOfDay: w / dayH },
		doubleXp: { xp: w * r.xp, shareOfDay: w / dayH },
		luckyDraw: {
			nextAssembly: ld ? { tier: ld.tier, crate: ld.crate, cratesSaved: ld.cratesSaved, dollars: ld.dollars, hoursOfOwnPlay: ld.dollars / r.cash } : null,
			onStreakCrates: { dollars: streakCrate, hoursOfOwnPlay: streakCrate / r.cash },
		},
	};
}

// ---------------------------------------------------------------------------------------------
// Today: the live buff code paths, read from src/ at report time (evidence only; nothing here runs the bot),
// and the recorded reproduction of B2 + B3.
const SRC = nodePath.join(__dirname, '../../../src');
const srcLines = (rel) => {
	try {
		return fs.readFileSync(nodePath.join(SRC, rel), 'utf8').split('\n');
	}
	catch {
		return [];
	}
};
/** `src/<rel>:<line>` of the first line matching `re`, and the text of that line and the next two. */
function srcAt(rel, re) {
	const lines = srcLines(rel);
	const i = lines.findIndex((l) => re.test(l));
	return i < 0 ? { ref: `src/${rel} (not found)`, text: '' } : { ref: `src/${rel}:${i + 1}`, text: lines.slice(i, i + 3).join('\n') };
}
/** Every production reader of active buffs. `button`: reachable from a button chain that never sweeps. */
const BUFF_READERS = [
	{ path: 'engine/cast.js', reads: 'Double XP on every cast', button: '\'Fish again\' casts' },
	{ path: 'components/buttons/sell-one-fish.js', reads: 'Double Cash on the catch-card sale', button: 'the catch-card Sell button' },
	{ path: 'engine/gacha.js', reads: 'Lucky Draw on every open', button: '\'Open another\' opens' },
	{ path: 'class/Fish.js', reads: 'Double Cash on /sell', button: null },
];
/**
 * The live buff paths (B2, B3) as src/ file:line. `live` is true while some buff query has no expiry
 * filter (the B3 hotfix is not in src/).
 */
function liveBuffPaths() {
	const readers = BUFF_READERS.map((r) => {
		const at = srcAt(r.path, /BuffData\.find\(/);
		return { ...r, ref: at.ref, checksExpiry: /endTime|endsAt/.test(at.text) };
	});
	const IC = 'events/Guild/interactionCreate.js';
	return {
		commandOnly: srcAt(IC, /if \(!interaction\.isCommand\(\)\) return;/).ref,
		sweep: srcAt(IC, /endTime\s*<=\s*Date\.now\(\)/).ref,
		fishAgain: srcAt('commands/slash/Fish/fish.js', /this\.run\(client, collectionInteraction/).ref,
		openAnother: srcAt('commands/slash/Economy/open.js', /module\.exports\.run\(client, i\b/).ref,
		activation: srcAt('commands/slash/User/equip.js', /startBooster\(/).ref,
		startBooster: srcAt('class/User.js', /endTime = Date\.now\(\) \+ buff\.length/).ref,
		endBoosterFilter: srcAt('class/User.js', /b\.id !== buff\.id/).ref,
		readers,
		live: readers.some((r) => !r.checksExpiry),
	};
}
/**
 * B2 + B3 reproduced with a scratch node:test on the in-memory MongoDB of test/helpers (never production),
 * code of commit 16edf3c. Recorded, not recomputed: rendering never starts a database. Steps: /equip's sweep,
 * then startBooster for a Double XP, a Double Cash and a Lucky Draw (as /equip's select menu does); wait past
 * endTime; castLine (the 'Fish again' path, no sweep); the sell-one-fish button on that cast; openLine (the
 * 'Open another' path). Then a sweep, the same Double Cash re-activated, the /sell command's own sweep and
 * Fish.sellByRarity at once (a /sell inside the window) on a fish stored at $1,000.
 */
const LIVE_REPRO = deepFreeze({
	source: 'scratch node:test on the in-memory MongoDB of the test helpers (never production), code of commit 16edf3c',
	activationWindowMs: 3603,
	fishAgain: { msAfterEnd: 643, xpMultiplier: 2, xp: 36, xpBase: 18 },
	sellButton: { stored: 30, paid: 60 },
	openAnother: { buffApplied: 'Lucky Draw' },
	afterUse: { count: 1, active: true },
	slashSellInsideWindow: { stored: 1000, paid: 2000, countAfter: 1 },
	reviewers: 'The adversarial review reproduced the same (Double XP x2 at 4.5 s and 7.5 s after activation; a re-activated Double Cash paid $62 for a $31 catch)',
});
/** Where each fix ships (PARAMS.rollout), as the bugs table prints it. */
function shipsLabel(id, seconds, needs = null) {
	const R = PARAMS.rollout;
	if (R.hotfix.includes(id)) return `**Now, alone (hotfix candidate).** Restores today's intended ${seconds} s window (B1 unchanged); changes no unit, catalog row or stored value`;
	if (R.withDoubleCash.includes(id)) return 'In the same deploy as the catch-time Double Cash stamp (`P-DOUBLE-CASH`), which removes cash buffs from every sale path; never before it';
	if (R.withBalanceRelease.includes(id)) return `Balance release (needs a proposed value: ${needs})`;
	if (R.anyTime.includes(id)) return 'Any time (dead code; no behaviour change)';
	throw new Error(`buffs: bug ${id} has no deploy in PARAMS.rollout`);
}

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
		level: L,
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
	const len = BUFF_CATALOG[0].length;
	const s = TODAY_WINDOW_S;
	const P = liveBuffPaths();
	const X = LIVE_REPRO;
	const todayMult = (name) => parseFloat(BUFF_CATALOG.find((b) => b.name === name).capabilities[1]);
	const buttonReaders = P.readers.filter((r) => r.button);
	const slashReader = P.readers.find((r) => !r.button);
	const bugs = [
		{
			id: 'B3',
			title: P.live
				? `**Live exploit.** Expiry is checked only before slash commands: an activated buff keeps working on ${buttonReaders.slice(0, -1).map((r) => r.button).join(', ')} and ${buttonReaders[buttonReaders.length - 1].button} until the player's next slash command, and (B2) the same unit can be activated again at will`
				: 'Expiry only on slash commands (every buff query in src/ now filters on endTime: hotfix present)',
			evidence: `${P.commandOnly} returns for every interaction that is not a command, so the expiry sweep (${P.sweep}) runs before slash commands only. Button chains reach the engine with no sweep: 'Fish again' (${P.fishAgain}), the catch-card Sell button and 'Open another' (${P.openAnother}). Every buff query trusts active: true: ${P.readers.map((r) => `${r.ref} (${r.reads})`).join('; ')}. /equip activates after its own sweep (${P.activation}). So /fish, then /equip a buff, then a click on the catch card starts a chain that keeps x${todayMult('Double XP')} XP and x${todayMult('Double Cash')} button sales for as long as the player keeps clicking. Reproduced (${X.source}): a 'Fish again' cast ${X.fishAgain.msAfterEnd} ms after endTime got XP x${X.fishAgain.xpMultiplier} (${X.fishAgain.xp} against ${X.fishAgain.xpBase}); the Sell button paid $${X.sellButton.paid} for a catch stored at $${X.sellButton.stored}; an 'Open another' open still applied the ${X.openAnother.buffApplied}; each stack afterwards: count ${X.afterUse.count}, active ${X.afterUse.active}. Also reproduced, on the slash path: after a sweep, the same Double Cash re-activated and a /sell inside the ${s} s window (${slashReader.ref}) paid $${X.slashSellInsideWindow.paid.toLocaleString('en-US')} for a fish stored at $${X.slashSellInsideWindow.stored.toLocaleString('en-US')}, unit count still ${X.slashSellInsideWindow.countAfter}. ${X.reviewers}. Past use in production is not measured (migrations, past use).`,
			fix: `Hotfix: add endTime > now (endTime: { $gt: Date.now() }) to each buff query listed (${P.readers.map((r) => r.ref.replace(/^src\//, '')).join(', ')}); nothing else changes. It does not close the /sell-inside-the-window case (a slash path, ${s} s, reusable through B2): that closes with B1 + B2 and P-DOUBLE-CASH (alternatives in P-BUFFS-HOTFIX). Later every consumer uses effectsAt(state, now) (endsAt > now); the sweep stays as display cleanup.`,
		},
		{ id: 'B1', title: `Every buff lasts ${s} s (on slash commands; on button paths see B3)`, evidence: `User.startBooster (${P.startBooster}): endTime = Date.now() + buff.length; the catalog length ${len} is in seconds but is added as ms. Reproduced on the in-memory MongoDB of the test helpers (never production): endTime - start = ${X.activationWindowMs.toLocaleString('en-US')} ms.`, fix: 'endsAt = now + durationSeconds x 1000.' },
		{ id: 'B2', title: 'A buff is never consumed', evidence: `startBooster never decrements count; endBooster filters inventory with b.id !== buff.id (${P.endBoosterFilter}; ObjectId.id is a Buffer, buff.id a string: always true), so nothing is removed. Reproduced: after expiry the stack still has count 1, is still in inventory, and /equip re-activates it; with B3 each re-activation is another button chain.`, fix: 'Activation atomically takes one unit ($inc count -1 guarded by count >= 1) with the activation record, in one transaction under the user lock; the stack leaves the inventory only at count 0. Ships WITH B1: fixing B1 alone would make every buff permanent.' },
		{ id: 'B4', title: 'Inconsistent same-kind stacking', evidence: `modifiers.buffEffects adds every active buff (two Double XP = x${1 + stackXp}); the sale paths use the first cash buff; gacha.js sums Lucky Draws.`, fix: 'One rule for every kind: one active per kind, extra units queue (P-BUFFS-QUEUE).', needs: '`P-BUFFS-QUEUE`' },
		{ id: 'B5', title: 'Descriptions over-promise', evidence: 'Double XP "from all activities" and Double Cash "income from all activities": quest XP/cash never take a buff (modifiers quest multiplier = profile x event).', fix: 'New catalog text (catalog table).', needs: 'the new catalog text, `P-BUFFS-SCOPE`' },
		{ id: 'B6', title: 'Dead code', evidence: 'User.generateBoostedXP / generateBoostedCash have no callers (each reads buffs with .find).', fix: 'Remove both.' },
	].map(({ needs, ...b }) => ({ ...b, ships: shipsLabel(b.id, s, needs) }));
	return {
		catalog,
		measured,
		buffsPer30dToday: { dailyBoxOnly: daily30, withTopggVotes: daily30 + votes30, eachType: (daily30 + votes30) / 3 },
		stacking: { twoDoubleXpInEngine: `+${stackXp * 100}% (x${1 + stackXp})`, twoDoubleXpMultiplier: 1 + stackXp, cashAtSale: 'Fish.sellByRarity and sell-one-fish take the FIRST active cash buff only (.find)', gacha: 'gacha.js sums every active Lucky Draw' },
		luckyToday,
		livePaths: P,
		liveRepro: LIVE_REPRO,
		bugs,
	};
}

// ---------------------------------------------------------------------------------------------
// SYSTEM: the buff layer on the shared lifecycle core (lifecycle.js). The core steps time and accrues base
// fishing (ledger source 'fishing'); this system receives buffs, activates them and credits only their
// BONUS, into its own ledger sources: XP / public XP 'buff' (Double XP), cash 'buff' (Double Cash) and cash
// 'luckyDraw' (Lucky Draw). No sinks, no purchases.
// Counting rule (integrate.js): a box's non-buff contents are valued once, by the system that grants it
// (quests: Daily Box; streak: Streak Crate / Chest); its buffs reach this system as
// emit('box', { name, count, level, source }) and are valued here, once.
const SYSTEM_NAME = 'buffs';
const BUFF_SOURCE = 'buff';
const LUCKY_SOURCE = 'luckyDraw';
/** Ledger sources this system writes (it has no spend items). */
const LEDGER_SOURCES = Object.freeze({ xp: [BUFF_SOURCE], publicXp: [BUFF_SOURCE], cash: [BUFF_SOURCE, LUCKY_SOURCE], spend: [] });
/** Buffs with a wall-clock window (Double XP, Double Cash); the Lucky Draw works by charges. */
const TIMED = BUFF_NAMES.filter((n) => buffOf(n).duration.type === 'wallclock');
/** The proposed buff sources (payload.source of the 'box' events, and the event budget). */
const SOURCES = Object.freeze(['streak', 'quests', 'events']);
/**
 * Today's live sources, for comparison only (the frequency table): one Daily Box a day (today's daily
 * quest) and a Voter's Crate every 12 h (Top.gg votes, being retired). Credited by this system at the day end.
 */
const TODAY_SOURCES = deepFreeze({ todayDailyBox: { box: 'Daily Box', perDay: 1 }, todayVotes: { box: 'Voter\'s Crate', perDay: 2 } });
/** system() defaults: the design's sources, no trace. */
const SYSTEM_DEFAULTS = deepFreeze({ sources: [...SOURCES], trace: false });
const zeroBuffs = () => Object.fromEntries(BUFF_NAMES.map((n) => [n, 0]));
/** Box names this module can price: the streak boxes, the Daily Box, the legacy Voter's Crate. */
const knownBox = (name) => Boolean(BOX_REFS[name] || streak.boxDefinitions()[name]);
/** The buff state a trace close records. */
const STATE_KEYS = ['received', 'receivedBySource', 'activated', 'buffedMinutes', 'value', 'valueBySource', 'luckyUse', 'boxes', 'ignored', 'stock'];
const pickState = (s) => clone(Object.fromEntries(STATE_KEYS.map((k) => [k, s[k]])));
const spendTotals = (spend) => Object.fromEntries(Object.entries(spend).map(([c, items]) => [c, sum(Object.values(items))]));

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
 * Stocks are EXPECTED units (the model is linear in them).
 *   on('box')      a granted box { name, count, level, source }: its expected buffs of each type
 *                  (boxBuffOdds: streak.boxEV at the payload level and the run's profile) join the stock,
 *                  attributed to payload.source. The Booster Pack is never valued (decision 12); an
 *                  unknown box throws (a box with buffs must be priced here, once). A box from a proposed
 *                  source that opts.sources leaves out is counted in `ignored` and not valued.
 *   events         the event budget (F.EVENTS.buffsPerThirtyDays = PARAMS.sources.events) accrues per
 *                  CALENDAR day and is delivered at the start of the next played day (a player who fishes
 *                  during the event; days not played still count toward the 30-day budget).
 *   onDayStart     events delivered, then the Double XP and Double Cash in stock are activated at the
 *                  session start (PARAMS.activation): up to one unit per started hour of the planned session
 *                  (the queue, at most PARAMS.stacking.maxQueued; the minimum-daily session: one). A unit
 *                  received mid-session waits for the next session's start, where its whole window meets play.
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
 *   onDayEnd       an unexpired window ends with the session (wall clock). Lucky Draws above the reserve
 *                  (PARAMS.luckyDrawReserve while a tier is still ahead) go on Streak Crates: opens x
 *                  bonusSlotValue('Streak Crate', level), cash 'luckyDraw'. TODAY_SOURCES in opts.sources
 *                  arrive here (comparison only).
 *   sessionDone    always true (buffs set no daily minimum).
 * Profile: state.profile 'founder' (the founder system's init) takes the Founder box odds (gacha luck) and
 * sells the Streak Crate bonus slot's fish at the Founder's sell multiplier. Buff XP is base (public) XP for
 * everyone; the final XP and the cash follow the profile's step rates (the private multipliers apply after
 * the buff). The Lucky Draw assembly rebate uses the Normal crate chain.
 * @param {object} opts { sources: subset of SOURCES and TODAY_SOURCES keys (default SOURCES), trace: false |
 *   true (observational: exact ledger closes at every day start, one row per played day, the by-source buff
 *   value at each milestone; changes no number, checks() 'trace-is-observational') }
 */
function system(opts = {}) {
	const cfg = { ...SYSTEM_DEFAULTS, ...opts };
	const sources = new Set(cfg.sources);
	for (const src of sources) if (!SOURCES.includes(src) && !TODAY_SOURCES[src]) throw new Error(`Unknown buff source ${src}`);
	if (PARAMS.activation.modelledAt !== 'sessionStart') throw new Error(`Unsupported activation ${PARAMS.activation.modelledAt}`);
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
		if (!sources.has('events') || days <= 0) return;
		s.eventDays = state.day + 1;
		for (const n of BUFF_NAMES) receive(s, n, (days * PARAMS.sources.events.perThirtyDays[n]) / 30, 'events');
	}
	function startSession(state, ctx) {
		const s = own(state);
		// Planned play of a fixed session (a minimum-daily session has no planned length: one unit).
		const planned = (ctx.arch.session === 'fixed' && ctx.arch.minutesPerDay) || 0;
		for (const n of TIMED) {
			const perSession = PARAMS.activation.unitsPerSession === 'startedHours' ? Math.min(PARAMS.stacking.maxQueued, Math.max(1, Math.ceil(planned / windowMinutes(n) - 1e-9))) : 1;
			const a = Math.min(s.stock[n], perSession);
			s.active[n] = { units: a, mix: takeStock(s, n, a) };
			s.activated[n] += a;
		}
	}
	function onBox(state, ctx, payload) {
		const s = own(state);
		const count = payload.count ?? 1;
		const name = payload.name;
		if (!(count > 0)) return;
		const source = payload.source || name;
		if (SOURCES.includes(source) && !sources.has(source)) {
			s.ignored[name] = (s.ignored[name] || 0) + count;
			return;
		}
		s.boxes[name] = (s.boxes[name] || 0) + count;
		if (name === 'Booster Pack' && !PARAMS.sources.boosterPack.valued) {
			s.unvalued[name] = (s.unvalued[name] || 0) + count;
			return;
		}
		if (!knownBox(name)) throw new Error(`buffs system: no buff odds for box '${name}' (a granted box with buffs must be priced here, once)`);
		const odds = boxBuffOdds(boxRef(name), payload.level ?? ctx.gateLevel(), { profile: profileOf(state) });
		for (const n of BUFF_NAMES) receive(s, n, count * odds[n], source);
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
	/** Trace close: the exact ledgers and buff state after `state.day` calendar days. */
	const close = (state) => ({
		day: state.day, hours: state.h, level: state.level, publicLevel: state.publicLevel,
		xp: { ...state.ledger.xp }, publicXp: { ...state.ledger.publicXp }, cash: { ...state.ledger.cash }, spend: spendTotals(state.ledger.spend),
		buffs: pickState(own(state)),
	});

	return {
		name: SYSTEM_NAME,
		init(state) {
			state.sys[SYSTEM_NAME] = {
				options: { sources: [...sources], trace: Boolean(cfg.trace) },
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
				ignored: {},
				unvalued: {},
				eventDays: 0,
				assembled: state.equippedTier,
				lastRates: null,
				trace: cfg.trace ? { closes: {}, rows: [], milestones: {} } : null,
			};
		},
		on(event, payload, state, ctx) {
			if (event === 'box') {
				onBox(state, ctx, payload);
			}
			else if (event === 'assembly') {
				onAssembly(state, ctx, payload);
			}
			else if (event === 'levelUp' && payload.kind === 'real' && own(state).trace) {
				// Trace: the by-source buff value at each milestone (the core snapshots only the ledgers).
				const s = own(state);
				for (const T of F.LIFECYCLE.milestones) if (payload.from < T && payload.to >= T) s.trace.milestones[T] = { hours: state.h, valueBySource: clone(s.valueBySource) };
			}
		},
		onDayStart(state, ctx) {
			const s = own(state);
			if (s.trace) s.trace.closes[state.day] = close(state);
			s.lastRates = null;
			creditEvents(state);
			startSession(state, ctx);
		},
		onCasts(state, ctx, { rates: r }) {
			const s = own(state);
			s.lastRates = { tier: r.tier, xpPerH: r.perHour.xp, xpBasePerH: r.xpBase / ctx.stepH, cashPerH: r.perHour.cash, castsPerH: r.perHour.casts, cooldownS: r.outcome ? r.outcome.cooldownMs / 1000 : null };
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
			for (const [src, def] of Object.entries(TODAY_SOURCES)) {
				if (!sources.has(src)) continue;
				const odds = boxBuffOdds(boxRef(def.box), ctx.gateLevel(), { profile: profileOf(state) });
				for (const n of BUFF_NAMES) receive(s, n, def.perDay * odds[n], src);
			}
			for (const n of TIMED) s.active[n] = null;
			spendLuckySurplus(state, ctx);
			if (s.trace) s.trace.rows.push({ day: state.day + 1, level: state.level, tier: state.equippedTier, biome: state.biome, minutes: state.minutesToday, casts: state.castsToday, rates: s.lastRates ? { ...s.lastRates } : null });
		},
		sessionDone() {
			return true;
		},
	};
}

/**
 * Parity of system() with the retired private loop, recorded (not recomputed: the loop is deleted). Values
 * are buffs.validateSystem()'s output at framework 5b.4 (digest d9e4938f85074918) with the code of commit
 * a83b5f0, which compared system() on the shared core with the old buffs.lifecycle() for every archetype
 * and the minimum-daily player.
 */
const SYSTEM_PARITY = deepFreeze({
	source: 'buffs.validateSystem() at framework 5b.4, code of commit a83b5f0',
	method: 'LC.simulate with buffs.system() plus the old loop\'s assumptions as systems (its gear rule and \'assembly\' event, LC.provisionalDaily(), its streak and Daily Box arrivals as \'box\' events) vs the retired buffs.lifecycle(), every archetype to Lv 60 and at least 90 days, and the minimum-daily player to day 364; hours compared step-exact',
	replay: { rule: 'the old loop\'s day-end valuation', exactMilestones: '30/30', maxRelativeDifference: 0 },
	system: {
		rule: 'the design defaults (activation at the next session start; the bonus on the casts each window covers)',
		exactMilestones: '20/30', maxAbsSteps: 1, hoursMaxRelativeDifference: 0.007353, hoursWorst: 'minimum-daily L20',
		ledgerMaxRelativeDifferenceAtDay30: { casual: 0.0309, regular: 0.0322, active: 0.0471, grinder: 0.0365, minimumDaily: 0.0325 },
		ledgerMaxRelativeDifferenceAtLastCheckpoint: { casual: 0.0101, regular: 0.0088, active: 0.0111, grinder: 0.0108, minimumDaily: 0.0027 },
		valuePerUnitUsedMaxRelativeDifference: { doubleCash: 0.006211, doubleXpXp: 0.001949 },
		cause: 'a box granted at a session\'s end pays in the next session (a one-day lag that falls like 1/days); per unit used the two agree',
	},
	streakCountedOnce: { replay: true, withStreakSystem: true, regular30d: { streakNonBuffContents: 17908.98, buffsDoubleCash: 15815.9, streakCashEquivalent: 33724.88 } },
	matches: true,
});

// ---------------------------------------------------------------------------------------------
// The integrated model: every lifecycle figure below comes from integrate.run() (the reference loop:
// rods, world, quests, streak and this system), traced (system opts.trace) so exact ledger closes per day
// and one row per played day are available. Calendar horizon: 90 days (casual and minimum-daily: 364,
// for the R2 comparison).
const HORIZON_DAYS = 90;
const LONG_HORIZON_DAYS = 364;
const LONG_HORIZON = ['casual', F.MINIMUM_DAILY.name];
const SHARE_DAYS = [7, 30, 90];
const R2_DAYS = [7, 28, 91, 182, 364];
const horizonOf = (archetype) => (LONG_HORIZON.includes(archetype) ? LONG_HORIZON_DAYS : HORIZON_DAYS);

/** The close after a run's last day (the run's final ledgers). */
function finalClose(result) {
	return {
		day: result.days, hours: result.hours, level: result.final.level, publicLevel: result.final.publicLevel,
		xp: { ...result.ledger.xp }, publicXp: { ...result.ledger.publicXp }, cash: { ...result.ledger.cash }, spend: spendTotals(result.ledger.spend),
		buffs: pickState(result.sys[SYSTEM_NAME]),
	};
}

/** A traced integrated run as a view: exact closes by calendar day, enriched daily rows, milestones. */
function viewOf(result, archetype, sources) {
	const s = result.sys[SYSTEM_NAME];
	const closes = { ...s.trace.closes, [result.days]: finalClose(result) };
	const days = Object.keys(closes).map(Number).sort((a, b) => a - b);
	const at = (d) => {
		if (d > result.days) throw new Error(`buffs: day ${d} is beyond the ${archetype} run (${result.days} days)`);
		let k = days[0];
		for (const x of days) if (x <= d) k = x;
		return closes[k];
	};
	const overheadS = result.archetype.overheadS;
	const rows = s.trace.rows.map((r) => {
		const a = at(r.day - 1);
		const b = at(r.day);
		const delta = (get) => get(b) - get(a);
		const q = r.rates || { xpPerH: 0, cashPerH: 0, castsPerH: 0, cooldownS: null };
		return {
			day: r.day, level: r.level, tier: r.tier, biome: r.biome, minutes: r.minutes, casts: r.casts,
			cashPerH: q.cashPerH, xpPerH: q.xpPerH, castsPerH: q.castsPerH,
			// The stage's cash per hour at the reference cadence (the sale-time cap is one reference hour).
			refCashPerH: q.cooldownS === null ? 0 : (q.cashPerH * (q.cooldownS + overheadS)) / (q.cooldownS + F.DESIGN_OVERHEAD_S),
			fishing: delta((c) => c.cash.fishing || 0),
			// Non-fish cash (quests, streak, salvage, Lucky Draw rebates; not the Double Cash bonus itself).
			otherCash: delta((c) => sum(Object.values(c.cash)) - (c.cash.fishing || 0) - (c.cash[BUFF_SOURCE] || 0)),
			fishingXp: delta((c) => c.xp.fishing || 0),
			xp: delta((c) => sum(Object.values(c.xp))),
			buffXp: delta((c) => c.xp[BUFF_SOURCE] || 0),
			upkeep: delta((c) => c.spend.upkeep || 0),
			purchase: delta((c) => c.spend.progression || 0),
			lambda: Object.fromEntries(BUFF_NAMES.map((n) => [n, delta((c) => c.buffs.received[n])])),
		};
	});
	return { archetype, sources: [...sources], days: result.days, horizon: result.days, result, closes, at, rows, milestones: result.milestones, trace: s.trace };
}

const views = new Map();
/**
 * One traced integrated run (integrate.run: the reference loop) for `archetype` over its horizon, with the
 * buffs system receiving `sources`. Replaces the retired private loop; returns a view (see viewOf).
 */
function lifecycle(archetype = F.REFERENCE_ARCHETYPE, { sources = SOURCES } = {}) {
	const key = `${archetype}|${sources.join(',')}`;
	if (!views.has(key)) {
		const result = I.run({ archetype, stopAtLevel: null, days: horizonOf(archetype), systemOpts: { [SYSTEM_NAME]: { sources, trace: true } } });
		views.set(key, viewOf(result, archetype, sources));
	}
	return views.get(key);
}

const levelRuns = new Map();
/** Integrated run to Lv 60 (the default stop) with or without the buffs system (exclude), traced when on. */
function levelRun(archetype, withBuffs = true) {
	const key = `${archetype}|${withBuffs}`;
	if (!levelRuns.has(key)) {
		levelRuns.set(key, withBuffs
			? I.run({ archetype, systemOpts: { [SYSTEM_NAME]: { trace: true } } })
			: I.run({ archetype, exclude: [SYSTEM_NAME] }));
	}
	return levelRuns.get(key);
}

const shareCache = new Map();
/**
 * Share of the archetype's fishing income (cash) and of its XP that buffs add over the first `days` days,
 * on the integrated model. .cash is Double Cash plus the Lucky Draw cash-equivalent over fishing income,
 * .cashOfAllIncome the same over every cash source, .xp Double XP XP over all XP, .bySource by buff source
 * (the streak's part is bySource.streak; the streak system books only its boxes' non-buff contents).
 */
function buffIncomeShare(archetype = F.REFERENCE_ARCHETYPE, { days = 30, sources = SOURCES } = {}) {
	const key = `${archetype}|${days}|${sources.join(',')}`;
	if (shareCache.has(key)) return shareCache.get(key);
	const c = lifecycle(archetype, { sources }).at(days);
	const b = c.buffs;
	const fishing = c.cash.fishing || 0;
	const allCash = sum(Object.values(c.cash));
	const totalXp = sum(Object.values(c.xp));
	const doubleCash = c.cash[BUFF_SOURCE] || 0;
	const luckyDraw = c.cash[LUCKY_SOURCE] || 0;
	const buffXp = c.xp[BUFF_SOURCE] || 0;
	const res = {
		archetype, days, level: c.level, playHours: c.hours, fishingIncome: fishing, allCashIncome: allCash,
		doubleCash, luckyDraw,
		cash: (doubleCash + luckyDraw) / fishing,
		cashDoubleCashOnly: doubleCash / fishing,
		cashLuckyDrawOnly: luckyDraw / fishing,
		cashOfAllIncome: (doubleCash + luckyDraw) / allCash,
		xp: buffXp / totalXp,
		doubleXpXp: buffXp,
		buffsPer30d: Object.fromEntries(BUFF_NAMES.map((n) => [n, (b.received[n] * 30) / days])),
		buffsPer30dTotal: (sum(Object.values(b.received)) * 30) / days,
		bySource: Object.fromEntries(Object.entries(b.receivedBySource).map(([src, v]) => [src, {
			buffsPer30d: Object.fromEntries(BUFF_NAMES.map((n) => [n, (v[n] * 30) / days])),
			cashShare: (b.valueBySource[src]?.doubleCash || 0) / fishing,
			xpShare: (b.valueBySource[src]?.doubleXpXp || 0) / totalXp,
		}])),
		boxes: { ...b.boxes },
		luckyDrawUse: { ...b.luckyUse },
	};
	shareCache.set(key, res);
	return res;
}

// ---------------------------------------------------------------------------------------------
// Decision 8: Double Cash under each timing model. Catch-time is the system itself (its ledger); the
// alternatives are analytic on the same integrated run's daily rows (no stepping).
/**
 * Spending the sale-time hoarder funds by selling fish at x1, per row: the day's upkeep and progression
 * purchases beyond the non-fish cash it holds (a running wallet of rows[].otherCash: quests, streak, salvage,
 * Lucky Draw rebates). Rows without otherCash pay every purchase from fish.
 */
function fishFundedSpend(rows) {
	let wallet = 0;
	return rows.map((r) => {
		wallet += r.otherCash || 0;
		const need = r.purchase + r.upkeep;
		const paid = Math.min(wallet, need);
		wallet -= paid;
		return need - paid;
	});
}

/**
 * Sale-time hoarder. g = fish income minus the spending it must fund from fish (fishFundedSpend, sold at x1);
 * everything else is hoarded and sold under the next Double Cash. Uncapped: exact renewal DP over "day of
 * the last hoard sale" (P(arrival on a day) = 1 - exp(-lambda)). Capped: the hoarder sells exactly the
 * capped amount under each buff and keeps the rest (mean-field; exact once hoard >= cap).
 */
function saleTimeHoarder(rows, { capHours = null } = {}) {
	const extra = buffOf('Double Cash').multiplier - 1;
	const fromFish = fishFundedSpend(rows);
	let bonus = 0;
	if (capHours === null) {
		let entries = [{ p: 1, hoard: 0 }];
		for (const [i, r] of rows.entries()) {
			const g = r.fishing - fromFish[i];
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
	for (const [i, r] of rows.entries()) {
		hoard = Math.max(0, hoard + r.fishing - fromFish[i]);
		const pa = 1 - Math.exp(-r.lambda['Double Cash']);
		const sold = Math.min(hoard, capHours * r.refCashPerH);
		bonus += pa * sold * extra;
		hoard -= pa * sold;
	}
	return bonus;
}

const dcCache = new Map();
function doubleCashModels(archetype = F.REFERENCE_ARCHETYPE, { days = 30, sources = SOURCES } = {}) {
	const key = `${archetype}|${days}|${sources.join(',')}`;
	if (dcCache.has(key)) return dcCache.get(key);
	const v = lifecycle(archetype, { sources });
	const rows = v.rows.filter((r) => r.day <= days);
	const c = v.at(days);
	const b = c.buffs;
	const D = windowHours('Double Cash');
	const extra = buffOf('Double Cash').multiplier - 1;
	const N = PARAMS.alternatives.castsReferenceHours * referenceCastsPerHour();
	const fishing = c.cash.fishing || 0;
	const catchTime = c.cash[BUFF_SOURCE] || 0;
	// Per cast of the day's last step (rows with no casts carry no buff value).
	const perCast = (r, perH) => (r.castsPerH > 0 ? perH / r.castsPerH : 0);
	const castsBased = (name, perH) => sum(rows.map((r) => Math.min(r.lambda[name] * N, r.casts) * perCast(r, perH(r)))) * (buffOf(name).multiplier - 1);
	const models = {
		catchTime,
		// The same units, each played for its whole window at the rates it met (the session made long enough).
		catchTimeBuffSaver: b.buffedMinutes['Double Cash'] > 0 ? (catchTime * b.activated['Double Cash'] * D * 60) / b.buffedMinutes['Double Cash'] : 0,
		catchTimeCastsBased: castsBased('Double Cash', (r) => r.cashPerH),
		saleTimeNonHoarder: catchTime,
		saleTimeHoarderUncapped: saleTimeHoarder(rows),
		saleTimeHoarderCapped: saleTimeHoarder(rows, { capHours: PARAMS.alternatives.saleTimeCapHours }),
	};
	// The same two duration models for Double XP (share of all XP: every source, including the buff's).
	const totalXp = sum(Object.values(c.xp));
	const buffXp = c.xp[BUFF_SOURCE] || 0;
	const dxpCasts = castsBased('Double XP', (r) => r.xpPerH);
	const out = {
		archetype, days, extra,
		level: c.level,
		fishingIncome: fishing,
		doubleCashPer30d: (b.received['Double Cash'] * 30) / days,
		hoardableShare: (fishing - sum(fishFundedSpend(rows))) / fishing,
		castsBasedCasts: N,
		value: models,
		share: Object.fromEntries(Object.entries(models).map(([k, x]) => [k, x / fishing])),
		doubleXpShare: { wallclock: buffXp / totalXp, castsBased: dxpCasts / (totalXp - buffXp + dxpCasts) },
	};
	dcCache.set(key, out);
	return out;
}

// ---------------------------------------------------------------------------------------------
// R2 for the buff layer, on the integrated model (with vs without the buffs system).
const QUEST_XP = ['daily', 'weekly', 'repeatable', 'story'];
function decomposition(run) {
	const dec = I.xpDecomposition(run);
	const ms = run.sys[SYSTEM_NAME]?.trace?.milestones || {};
	return Object.fromEntries(Object.keys(F.TARGET_WINDOWS).map(Number).filter((T) => dec[T]).map((T) => {
		const d = dec[T];
		const x = d.bySource;
		const fishingXp = x.fishing || 0;
		const questXp = sum(QUEST_XP.map((k) => x[k] || 0));
		const buffXp = x[BUFF_SOURCE] || 0;
		const other = d.totalXp - fishingXp - questXp - buffXp;
		return [T, {
			hours: d.hours, day: d.day, totalXp: d.totalXp, fishingXp, questXp, buffXp, otherXp: other,
			buffXpBySource: Object.fromEntries(Object.entries(ms[T]?.valueBySource || {}).map(([k, v]) => [k, Math.round(v.doubleXpXp)])),
			shares: { fishing: fishingXp / d.totalXp, quests: questXp / d.totalXp, buff: buffXp / d.totalXp },
		}];
	}));
}

let r2Cache = null;
function r2() {
	if (r2Cache) return r2Cache;
	const archetypes = {};
	for (const name of ARCHETYPE_NAMES) {
		const on = levelRun(name, true);
		const off = levelRun(name, false);
		const keys = F.LIFECYCLE.milestones.filter((T) => on.milestones[T] && off.milestones[T]);
		archetypes[name] = {
			decomposition: decomposition(on),
			hoursWithoutBuffs: Object.fromEntries(keys.map((k) => [k, off.milestones[k].hours])),
			hoursWithBuffs: Object.fromEntries(keys.map((k) => [k, on.milestones[k].hours])),
			maxHoursDelta: Math.max(...keys.map((k) => Math.abs(on.milestones[k].hours - off.milestones[k].hours) / off.milestones[k].hours)),
		};
	}
	const reg = archetypes[F.REFERENCE_ARCHETYPE];
	const windows = Object.fromEntries(Object.entries(F.TARGET_WINDOWS).map(([L, [lo, hi]]) => [L, { window: [lo, hi], without: reg.hoursWithoutBuffs[L], with: reg.hoursWithBuffs[L], inside: reg.hoursWithBuffs[L] >= lo && reg.hoursWithBuffs[L] <= hi }]));
	// The minimum-daily player (F.MINIMUM_DAILY: plays until every daily minimum is met) vs the casual player.
	const md = lifecycle(F.MINIMUM_DAILY.name);
	const cas = lifecycle('casual');
	const view = (c, d) => {
		const xp = sum(Object.values(c.xp));
		return { level: c.level, hours: c.hours, xpPerActiveHour: xp / c.hours, xpPerDay: xp / d, buffXpShare: (c.xp[BUFF_SOURCE] || 0) / xp, buffCashShare: ((c.cash[BUFF_SOURCE] || 0) + (c.cash[LUCKY_SOURCE] || 0)) / (c.cash.fishing || 1) };
	};
	const rows = R2_DAYS.map((d) => ({ day: d, minimumDaily: view(md.at(d), d), casual: view(cas.at(d), d), minimumDailyLeadsInLevel: md.at(d).level > cas.at(d).level }));
	const minimumDaily = { archetype: F.MINIMUM_DAILY, rows, leadsAnywhere: rows.some((r) => r.minimumDailyLeadsInLevel) };
	minimumDaily.buffXpShareBelowCasual = rows.every((r) => r.minimumDaily.buffXpShare <= r.casual.buffXpShare);
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
		? 'PASS: every buff source on top of grinding moves the grinder\'s milestones by less than the window-shift target, and the regular player stays inside every window.'
		: 'FAIL: buffs move milestones materially.';
	r2Cache = { model: I.REFERENCE_NOTE, archetypes, windows, minimumDaily, noMissGrinder };
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
	const names = ['Streak Crate', 'Streak Chest', 'Daily Box'];
	const boxes = names.map((b) => ({ box: b, normal: boxBuffOdds(boxRef(b), L), founder: boxBuffOdds(boxRef(b), L, { profile: 'founder' }) }));
	// Boxes a regular player is granted in 30 days on the integrated model, at each profile's odds.
	const counts = lifecycle(F.REFERENCE_ARCHETYPE).at(30).buffs.boxes;
	const per30 = (profile) => Object.fromEntries(BUFF_NAMES.map((n) => [n, sum(boxes.map((x) => (counts[x.box] || 0) * x[profile][n])) + PARAMS.sources.events.perThirtyDays[n]]));
	const normal = per30('normal');
	const founder = per30('founder');
	// Public XP drift: a Founder's extra Double XP units each double a regular session's fishing XP (the
	// window covers the whole session), so the extra public XP share = extra units per day x fishing's share
	// of the regular player's XP at L50 (integrated); then in levels at L50.
	const L50 = Math.max(...Object.keys(F.TARGET_WINDOWS).map(Number));
	const fishingShare = r2().archetypes[F.REFERENCE_ARCHETYPE].decomposition[L50].shares.fishing;
	const drift = ((founder['Double XP'] - normal['Double XP']) / 30) * fishingShare;
	return {
		profileGachaStats: PROFILES.founder.gacha?.stats || {},
		level: L,
		boxes,
		boxesPer30d: { ...counts },
		buffsPer30d: { normal, founder, ratio: founder['Double XP'] / normal['Double XP'] },
		fishingShareAtL50: fishingShare,
		publicXpDriftShare: drift,
		publicLevelDriftAtL50: levelExact(F.xpForLevel(L50) * (1 + drift)) - L50,
		note: 'Buff effects are base (public) rewards for everyone; the private profile multiplies the final. Founder boxes hold more buffs (gacha luck), so a Founder\'s public XP can run ahead of an identical normal player by the drift share.',
	};
}

// ---------------------------------------------------------------------------------------------
// Proposed decisions (status 'proposed' only: only the user approves). get() reads what the model runs;
// decisions.verify() checks it against `expected`. Framework-level entries this design relies on and does
// not repeat: P-DOUBLE-CASH (catch-time Double Cash), P-EVENTS (the event budget), P-LUCKY (pinned Lucky items).
const DECISIONS = [
	{
		id: 'P-BUFFS-HOTFIX', status: 'proposed',
		title: `Hotfix now, alone: read-time expiry (B3: endTime > now in every buff query). It ends the live button-path exploit and restores today's intended ${TODAY_WINDOW_S} s window; B1 and B2 stay until the P-DOUBLE-CASH deploy`,
		modelled: 'PARAMS.rollout: B3 now; B1 + B2 in the P-DOUBLE-CASH deploy; B4 and B5 with the balance release; B6 any time (bugs table, "Ships")',
		alternatives: [
			`B3 + B2 now: one unit per activation while B1 still limits a buff to ${TODAY_WINDOW_S} s (a /sell inside the window then costs a unit, so each unit doubles at most one hoard; but until the balance release every activation spends a unit on ${TODAY_WINDOW_S} s of effect)`,
			'B3 + no cash buff in any sale path now (closes the /sell window; Double Cash has no effect until P-DOUBLE-CASH ships)',
			'no hotfix: wait for the balance release (the button-path exploit stays live)',
		],
		source: 'buffs design (adversarial review)',
		why: `the exploit is live and reproduced (bugs table, B3). B3 alone changes no unit, catalog row or stored value. It leaves one gap: a /sell sent within ${TODAY_WINDOW_S} s of activation still doubles the whole hoard, and B2 lets the unit be activated again (reproduced; bugs table)`,
		get: () => clone(PARAMS.rollout),
		expected: { hotfix: ['B3'], withDoubleCash: ['B1', 'B2'], withBalanceRelease: ['B4', 'B5'], anyTime: ['B6'] },
	},
	{
		id: 'P-BUFFS-FIX-DURATION', status: 'proposed',
		title: 'Correctness fix: a buff lasts its catalog length in SECONDS and activation consumes exactly one unit (B1 + B2 together), in the same deploy as the catch-time Double Cash stamp (P-DOUBLE-CASH) that removes cash buffs from every sale path; read-time expiry (B3) ships before it, alone (P-BUFFS-HOTFIX)',
		modelled: 'activate(): endsAt = now + durationSeconds x 1000; stock - 1 atomically; effectsAt(): endsAt > now; shipped with PARAMS.rollout.withDoubleCash',
		alternatives: [
			'fix B1 alone (every buff becomes permanent: B2 never consumes it)',
			'ship B1 + B2 before P-DOUBLE-CASH, while sales still apply cash buffs (every held Double Cash becomes an hour of sale-time hoarding; the uncapped hoarder at today\'s arrival rates is in the frequency table)',
			`keep today (a buff lasts ${TODAY_WINDOW_S} s on slash commands and until the next slash command on button paths, and is never used up)`,
		],
		source: 'buffs design',
		why: 'fixing only the duration would make each buff permanent (B2), and B1 + B2 while cash still pays at sale would open the hoarding that decision 8 closes (Decision 8 and frequency tables). The fix is not only a latent correction: today an activated buff keeps applying on button paths and the unit is reusable (bugs table, B2 and B3)',
		get: () => {
			const a = activate({ stock: { 'Double Cash': 1 }, active: {} }, 'Double Cash', 0);
			return { endsAtMs: a.state.active.cash.endsAt, stockAfter: a.state.stock['Double Cash'], activeAfterWindow: effectsAt(a.state, a.state.active.cash.endsAt).cash };
		},
		expected: { endsAtMs: 3600000, stockAfter: 0, activeAfterWindow: 1 },
	},
	{
		id: 'P-BUFFS-DURATION', status: 'proposed',
		title: `Double XP and Double Cash run for ${F.BUFFS.durationSeconds / 3600} real (wall-clock) hour from activation`,
		modelled: `${F.BUFFS.durationSeconds} s of real time; the modelled window is counted in play minutes of the session it starts`,
		alternatives: [`casts-based: the next ${Math.round(PARAMS.alternatives.castsReferenceHours * referenceCastsPerHour())} casts (one reference hour), however long that takes`],
		source: 'buffs design', why: 'a real hour covers a whole casual/regular session, so their share is the share of buffed days; a casts-based buff rewards barely fishing (duration table)',
		get: () => Object.fromEntries(TIMED.map((n) => [n, buffOf(n).duration])),
		expected: { 'Double XP': { type: 'wallclock', seconds: 3600 }, 'Double Cash': { type: 'wallclock', seconds: 3600 } },
	},
	{
		id: 'P-BUFFS-ACTIVATION', status: 'proposed',
		title: 'A buff runs only when the player activates a unit from stock; the model assumes activation at the start of the next session (one unit per started hour of the planned session)',
		modelled: 'held Double XP / Double Cash activated at the session start, queued up to the per-kind limit; a unit received mid-session waits for the next session',
		alternatives: ['auto-activate on receipt (a box opened at the end of a session wastes most of the hour)', 'activate at receipt time in the model (the old loop\'s day-end valuation; parity table)'],
		source: 'buffs design', why: 'the player chooses when to play the hour; rational use is the honest model (a box granted at a session\'s end is used in the next one)',
		get: () => ({ ...PARAMS.activation }),
		expected: { by: 'player', modelledAt: 'sessionStart', unitsPerSession: 'startedHours' },
	},
	{
		id: 'P-BUFFS-QUEUE', status: 'proposed',
		title: `Same kind queues (a second unit extends the timer or adds charges; the multiplier stays x${F.BUFFS.multipliers.cash}), at most ${PARAMS.stacking.maxQueued} banked per kind; different kinds run independently`,
		modelled: `sameKind '${PARAMS.stacking.sameKind}', maxQueued ${PARAMS.stacking.maxQueued}, across kinds '${PARAMS.stacking.acrossKinds}'; an activation beyond maxQueued returns QUEUE_FULL and keeps the unit`,
		alternatives: ['additive same-kind stacking (today\'s XP: two Double XP = x3)', 'first buff only (today\'s sale path)', 'refuse a second activation while one runs'],
		source: 'buffs design', why: 'one rule for every kind (B4); a buff always adds exactly +100% of the unbuffed value, so banking gains nothing but convenience',
		get: () => ({ sameKind: PARAMS.stacking.sameKind, maxQueued: PARAMS.stacking.maxQueued, acrossKinds: PARAMS.stacking.acrossKinds }),
		expected: { sameKind: 'queue', maxQueued: 3, acrossKinds: 'independent' },
	},
	{
		id: 'P-BUFFS-EVENT-STACKING', status: 'proposed',
		title: `A buff and an event of the same category ADD their bonuses (x2 + x2 = x${temporaryMultiplier(2, 2)}); gear, aquarium and the private profile keep multiplying`,
		modelled: 'stored value = raw x (1 + sellBonus) x (1 + (buff - 1) + (event - 1)) x profile.sell; XP the same shape',
		alternatives: [`multiply (today: a x2 buff during a x2 event pays x${2 * 2})`],
		source: 'buffs design', why: 'no reason to save every buff for an event; the event lever stays measurable',
		get: () => ({ withEvent: PARAMS.stacking.withEvent, withGearAndProfile: PARAMS.stacking.withGearAndProfile, buffTimesEvent: temporaryMultiplier(2, 2) }),
		expected: { withEvent: 'additive', withGearAndProfile: 'multiply', buffTimesEvent: 3 },
	},
	{
		id: 'P-BUFFS-LUCKY-DRAW', status: 'proposed',
		title: `Lucky Draw becomes charges: +${F.BUFFS.luckyDraw.bonusSlots} bonus slot on each of the next ${F.BUFFS.luckyDraw.opens} box opens (any box except the Booster Pack), replacing today's +${Math.round(100 * TODAY_LUCKY_STATS.rareFind)}% rare+ weights for an hour. A rarer reward: Daily Box, events and the Booster Pack, never a streak box (P-BUFFS-SOURCES)`,
		modelled: `${buffOf('Lucky Draw').bonusSlots} bonus slot x ${buffOf('Lucky Draw').duration.opens} opens; the slot rolls the box's own table (floors, unique, pity respected); the charge is spent in the open's journal commit`,
		alternatives: ['keep today\'s rare+ weights for an hour (inert on floored tier crates; rewards opening a stockpile in one hour)', `K = ${PARAMS.alternatives.luckyDrawOpens.filter((k) => k !== F.BUFFS.luckyDraw.opens).join(' or ')} opens (Lucky Draw K table)`],
		source: 'buffs design', why: 'never inert, bounded at K opens however many boxes are saved, worth up to about a Double Cash hour on an assembly (Lucky Draw tables)',
		get: () => ({ bonusSlots: buffOf('Lucky Draw').bonusSlots, opens: buffOf('Lucky Draw').duration.opens, excludeBoxes: [...buffOf('Lucky Draw').excludeBoxes] }),
		expected: { bonusSlots: 1, opens: 2, excludeBoxes: ['Booster Pack'] },
	},
	{
		id: 'P-BUFFS-SCOPE', status: 'proposed',
		title: 'Double XP and Double Cash apply only to fish caught by casting: never quest XP or cash, box fish or items',
		modelled: 'the system credits (multiplier - 1) x the step\'s fishing rates only; the catalog descriptions say so (B5)',
		alternatives: ['"all activities" as today\'s descriptions claim (quest rewards doubled)'],
		source: 'buffs design', why: 'a buff multiplies play; quest rewards already have their own lever (P-DAILY-FACTOR)',
		get: () => Object.fromEntries(TIMED.map((n) => [n, buffOf(n).applies])),
		expected: { 'Double XP': 'XP of fish caught by casting (never quest XP, never box fish)', 'Double Cash': 'value of fish caught by casting, stamped into the stored value (never quest cash, box fish or items)' },
	},
	{
		id: 'P-BUFFS-SOURCES', status: 'proposed',
		title: 'Buff sources: the streak boxes (Double XP and Double Cash only, no Lucky Draw), the quest Daily Boxes (pool unchanged) and the event budget; the Lucky Draw is a rarer reward from the Daily Box, events and the Booster Pack; no shop sale; the Booster Pack keeps its buffs and is never valued',
		modelled: `streak (Streak Crate / Chest, without ${streak.PARAMS.pool.excludeBuffs.join(', ')}: streak.js P-STREAK-ITEM-POOL), quests (Daily Box), events (F.EVENTS, P-EVENTS); Lucky Draw from ${PARAMS.sources.luckyDrawFrom.join(', ')} (+ the unvalued Booster Pack); Booster Pack unvalued; shop none`,
		alternatives: ['Lucky Draw in streak boxes too (the earlier proposal: about a Lucky Draw more per 30 days for a daily player, most of it an early-assembly rebate)', 'a shop sale (converts cash into levels, or a guaranteed-return investment)', 're-weighted streak/quest pools (a Gacha V2 featured change)'],
		source: 'buffs design; user decision (Lucky Draw removed from Streak Crates and Streak Chests; kept in the Daily Box, the Booster Pack and events)', why: 'Double XP stays at the streak rate (the regular player\'s windows have little headroom); the Lucky Draw is worth the most on a tier assembly, so a daily source made it common and its rebate the largest buff value for casual players; the event budget is the one lever the operator can schedule, measure and switch off (sources tables)',
		get: () => ({ sources: [...SYSTEM_DEFAULTS.sources], streakExcludes: [...streak.PARAMS.pool.excludeBuffs], luckyDrawFrom: [...PARAMS.sources.luckyDrawFrom], boosterPackValued: PARAMS.sources.boosterPack.valued, shop: PARAMS.sources.shop }),
		expected: { sources: ['streak', 'quests', 'events'], streakExcludes: ['Lucky Draw'], luckyDrawFrom: ['quests', 'events'], boosterPackValued: false, shop: false },
	},
	{
		id: 'P-BUFFS-PUBLIC', status: 'proposed',
		title: 'A buff is a normal mechanic: its effect is part of the BASE (public) reward for everyone; the private profile multiplies after it',
		modelled: 'catchValue(): public = raw x (1 + sellBonus) x temporary; stored = public x profile.sell (buff XP is public XP)',
		alternatives: ['exclude buffs from public values (public level would lag a buffed normal player)'],
		source: 'buffs design', why: 'one public presentation for every profile; the Founder drift it implies is small (Founder table)',
		get: () => {
			const v = catchValue({ rawValue: 100, sellBonus: 0.05, buffCash: 2, profileSell: 10 });
			return { base: v.base, final: v.final };
		},
		expected: { base: 210, final: 2100 },
	},
	{
		id: 'P-BUFFS-LEGACY', status: 'proposed',
		title: `Existing buffs keep their counts and map to the new kinds at read time (a held Lucky Draw becomes ${F.BUFFS.luckyDraw.opens} charges); no document is rewritten`,
		modelled: 'legacyKind([\'gacha\', \'1.5\']) = Lucky Draw charges; stale activations cleared once (migration 1)',
		alternatives: [
			'rewrite every BuffData capability array',
			'consume one unit from every stack that was ever activated (endTime set), as a stand-in for past use (rewrites counts, and also takes a unit from players who only had the few-second window)',
			'size past use first from production (read-only: Cast journals list the buffs each cast read, GachaOpen journals list buff sources; button sales record no multiplier), then choose',
		],
		source: 'buffs design', why: 'additive and idempotent; nobody loses a unit, because B2 never consumed one. That does not mean units had no effect: on button paths an activated buff kept applying until the next slash command (B3; how often is not measured). Any XP and cash gained that way stays, like every carried balance (P-LEGACY-WEALTH), and each held unit, used or not, becomes one real hour after B1 + B2 (migrations, past use)',
		get: () => ({ gacha: legacyKind(['gacha', '1.5']).duration, cash: legacyKind(['cash', '2.0']).name, xp: legacyKind(['xp', '2.0']).name }),
		expected: { gacha: { type: 'charges', opens: 2 }, cash: 'Double Cash', xp: 'Double XP' },
	},
];

// ---------------------------------------------------------------------------------------------
let checksCache = null;
function checks() {
	if (checksCache) return checksCache;
	const T = PARAMS.targets;
	const list = [];
	const add = (id, pass, detail) => list.push({ id, pass: Boolean(pass), detail });
	add('lucky-chain-reproduces-rods', TIERS.every((t) => Math.abs(luckyAssembly(t, { opens: 0 }) - rods.cratesDistribution(t).expected) < 1e-9), 'Lucky Draw chain with 0 lucky opens = rods.cratesDistribution(t).expected, T1-T5');
	for (const name of ARCHETYPE_NAMES) {
		const s = buffIncomeShare(name, { days: 30 });
		add(`cash-share-${name}`, s.cash <= T.cashShareMax30d[name], `buffs add ${(100 * s.cash).toFixed(2)}% of fishing income in 30 days (max ${100 * T.cashShareMax30d[name]}%)`);
		add(`xp-share-${name}`, s.xp <= T.xpShareMax, `Double XP adds ${(100 * s.xp).toFixed(2)}% of XP in 30 days (max ${100 * T.xpShareMax}%)`);
	}
	const reg = buffIncomeShare(F.REFERENCE_ARCHETYPE, { days: 30 });
	// User decision: the Lucky Draw arrives only from PARAMS.sources.luckyDrawFrom (never a streak box).
	const ldFrom = PARAMS.sources.luckyDrawFrom;
	const ldBySource = Object.fromEntries(Object.entries(reg.bySource).map(([src, v]) => [src, v.buffsPer30d['Lucky Draw']]));
	const streakLd = ['Streak Crate', 'Streak Chest'].map((b) => boxBuffOdds(b, 0)['Lucky Draw'] || 0);
	add('lucky-draw-sources', streakLd.every((x) => x === 0) && Object.entries(ldBySource).every(([src, u]) => ldFrom.includes(src) || !(u > 0)) && ldFrom.every((src) => ldBySource[src] > 0),
		`regular, 30 days: Lucky Draws by source ${Object.entries(ldBySource).map(([src, u]) => `${src} ${u.toFixed(2)}`).join(', ')} (allowed: ${ldFrom.join(', ')}); Streak Crate / Chest odds ${streakLd.map((x) => x.toFixed(4)).join(' / ')}`);
	add('buffs-per-30-days', reg.buffsPer30dTotal >= T.buffsPerThirtyDays[0] && reg.buffsPer30dTotal <= T.buffsPerThirtyDays[1], `${reg.buffsPer30dTotal.toFixed(2)} buffs per 30 days for the regular player (target ${T.buffsPerThirtyDays.join('-')})`);
	const R = r2();
	add('regular-in-windows-with-buffs', Object.values(R.windows).every((w) => w.inside), Object.entries(R.windows).map(([L, w]) => `L${L} ${w.with} h`).join(', '));
	add('window-shift-small', R.archetypes.regular.maxHoursDelta <= T.windowShiftMax, `regular milestones move ${(100 * R.archetypes.regular.maxHoursDelta).toFixed(2)}% with the buffs system (max ${100 * T.windowShiftMax}%)`);
	add('minimum-daily-never-leads', !R.minimumDaily.leadsAnywhere, R.minimumDaily.verdict);
	add('no-miss-grinder', R.noMissGrinder.maxHoursDelta <= T.windowShiftMax, `grinder milestones move ${(100 * R.noMissGrinder.maxHoursDelta).toFixed(2)}% with the buffs system (max ${100 * T.windowShiftMax}%)`);
	const dc = doubleCashModels(F.REFERENCE_ARCHETYPE, { days: HORIZON_DAYS });
	add('sale-time-uncapped-rewards-stockpiles', dc.share.saleTimeHoarderUncapped > 3 * dc.share.catchTime, `${HORIZON_DAYS} days, regular: sale-time hoarder +${(100 * dc.share.saleTimeHoarderUncapped).toFixed(1)}% vs catch-time +${(100 * dc.share.catchTime).toFixed(1)}% (why catch-time)`);
	const ld = TIERS.map((t) => luckyDrawValue(t));
	add('lucky-draw-never-inert', ld.every((x) => x.stageHours >= T.luckyDrawMinHoursAnyTier), `proposed Lucky Draw saves ${ld.map((x) => `${x.stageHours.toFixed(2)} h`).join(' / ')} of stage income on the T1-T5 assemblies (min ${T.luckyDrawMinHoursAnyTier})`);
	add('today-lucky-draw-inert-on-floored-crates', current().luckyToday.tierCrates.filter((x) => x.inert).length >= 3, 'today\'s +50% rare+ Lucky Draw saves 0 crates on the Expert, Master and Gilded crates');
	// Counting rule: buff value lives only in this system's ledger sources, exactly what it credited, and
	// every buff unit the streak system grants is received here.
	const v = lifecycle(F.REFERENCE_ARCHETYPE);
	const res = v.result;
	const st = res.sys[SYSTEM_NAME];
	const streakGranted = res.sys.streak?.buffs ? sum(Object.values(res.sys.streak.buffs)) : null;
	const streakReceived = sum(Object.values(st.receivedBySource.streak || {}));
	const once = res.ledger.xp[BUFF_SOURCE] === st.value.doubleXpXp && res.ledger.cash[BUFF_SOURCE] === st.value.doubleCash && res.ledger.cash[LUCKY_SOURCE] === st.value.luckyDraw
		&& (streakGranted === null || Math.abs(streakGranted - streakReceived) <= 1e-9 * Math.max(1, streakGranted));
	add('buff-value-counted-once', once, `regular, ${HORIZON_DAYS} days: ledger 'buff' / 'luckyDraw' = the system's own credits; streak buff units granted ${streakGranted === null ? '(not exposed by streak.js)' : streakGranted.toFixed(4)} = received here ${streakReceived.toFixed(4)}`);
	// The trace is observational: an untraced 30-day run has exactly the traced run's day-30 close.
	const plain = I.run({ archetype: F.REFERENCE_ARCHETYPE, stopAtLevel: null, days: 30 });
	const c30 = v.at(30);
	const same = (a, b) => Object.keys({ ...a, ...b }).every((k) => (a[k] || 0) === (b[k] || 0));
	add('trace-is-observational', same(plain.ledger.xp, c30.xp) && same(plain.ledger.cash, c30.cash) && plain.final.level === c30.level, 'regular: integrate.run() without the trace, 30 days = the traced run\'s day-30 close (every XP and cash source, level)');
	checksCache = { pass: list.every((c) => c.pass), list };
	return checksCache;
}

// ---------------------------------------------------------------------------------------------
const FREQUENCY_SETS = [
	['today: Daily Box only', ['todayDailyBox']],
	['today: Daily Box + Top.gg votes', ['todayDailyBox', 'todayVotes']],
	['proposed without events', ['streak', 'quests']],
	['proposed', [...SOURCES]],
];
const DURATION_ARCHETYPES = [...ARCHETYPE_NAMES, F.MINIMUM_DAILY.name];

let reportCache = null;
function report() {
	if (reportCache) return reportCache;
	const shares = Object.fromEntries(ARCHETYPE_NAMES.map((a) => [a, Object.fromEntries(SHARE_DAYS.map((d) => [d, buffIncomeShare(a, { days: d })]))]));
	shares[F.MINIMUM_DAILY.name] = { 30: buffIncomeShare(F.MINIMUM_DAILY.name, { days: 30 }) };
	const noEvents = Object.fromEntries(ARCHETYPE_NAMES.map((a) => [a, buffIncomeShare(a, { days: 30, sources: ['streak', 'quests'] })]));
	const decision8 = Object.fromEntries(ARCHETYPE_NAMES.map((a) => [a, { 30: doubleCashModels(a, { days: 30 }), [HORIZON_DAYS]: doubleCashModels(a, { days: HORIZON_DAYS }) }]));
	// Buff frequency sensitivity of the uncapped sale-time hoarder (why a cap would be needed).
	const frequency = Object.fromEntries(FREQUENCY_SETS.map(([setName, sources]) => [setName, Object.fromEntries(ARCHETYPE_NAMES.map((a) => {
		const m = doubleCashModels(a, { days: HORIZON_DAYS, sources });
		return [a, { sources, doubleCashPer30d: m.doubleCashPer30d, catchTime: m.share.catchTime, saleTimeHoarderUncapped: m.share.saleTimeHoarderUncapped, saleTimeHoarderCapped: m.share.saleTimeHoarderCapped }];
	}))]));
	// Duration models side by side (30 days): wall-clock hour (proposed) vs casts-based (alternative).
	const durationAlternatives = Object.fromEntries(DURATION_ARCHETYPES.map((a) => {
		const m = doubleCashModels(a, { days: 30 });
		return [a, { doubleCash: { wallclock: m.share.catchTime, castsBased: m.share.catchTimeCastsBased }, doubleXp: m.doubleXpShare, castsBasedCasts: m.castsBasedCasts }];
	}));
	const stages = F.LIVE_BIOMES.map((b) => F.BIOME_LEVEL[b]);
	const perBuff = Object.fromEntries(ARCHETYPE_NAMES.map((a) => [a, stages.map((L) => valuePerBuff(L, a))]));
	const luckyDraw = {
		proposed: TIERS.map((t) => luckyDrawValue(t)),
		byOpens: Object.fromEntries(PARAMS.alternatives.luckyDrawOpens.map((k) => [k, TIERS.map((t) => luckyDrawValue(t, { opens: k }))])),
		bonusSlot: ['Daily Box', 'Streak Crate'].map((b) => ({ box: b, perStage: stages.map((L) => ({ level: L, biome: F.biomeAt(L), value: bonusSlotValue(b, L) })) })),
	};
	reportCache = {
		...F.stamp(),
		gearPathSource: F.GEAR_PATH_SOURCE,
		model: I.REFERENCE_NOTE,
		params: PARAMS,
		referenceCastsPerHour: referenceCastsPerHour(),
		current: current(),
		sources: {
			perOpen: Object.fromEntries(['Streak Crate', 'Streak Chest', 'Daily Box', 'Voter\'s Crate'].map((b) => [b, boxBuffOdds(boxRef(b), 0)])),
			perThirtyDays: Object.fromEntries(ARCHETYPE_NAMES.map((a) => [a, { total: shares[a][30].buffsPer30dTotal, byType: shares[a][30].buffsPer30d, bySource: Object.fromEntries(Object.entries(shares[a][30].bySource).map(([k, v]) => [k, v.buffsPer30d])), boxes: shares[a][30].boxes }])),
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
		system: {
			name: SYSTEM_NAME,
			defaults: SYSTEM_DEFAULTS,
			hooks: ['init', 'on(box)', 'on(assembly)', 'on(levelUp) (trace only)', 'onDayStart', 'onCasts', 'onDayEnd', 'sessionDone'],
			ledger: LEDGER_SOURCES,
			events: { listens: ['box', 'assembly', 'levelUp'], emits: [] },
			sinks: 'none',
			parity: SYSTEM_PARITY,
		},
		ruleExamples: ruleExamples(),
		decisions: DECISIONS.map((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'get' && k !== 'expected'))),
		checks: checks(),
	};
	return reportCache;
}

// ---------------------------------------------------------------------------------------------
// Generated doc tables (render-docs.js). Every number comes from report(); nothing is hand-typed.
const mdTable = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n');
const usd = (x) => `$${Math.round(x).toLocaleString('en-US')}`;
const pct = (x, d = 1) => `${(100 * x).toFixed(d)}%`;
const fx = (x, d = 2) => Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const int = (x) => Math.round(x).toLocaleString('en-US');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const label = (a) => (a === F.MINIMUM_DAILY.name ? 'Minimum-daily' : cap(a));
const range = (xs, f) => {
	const lo = Math.min(...xs);
	const hi = Math.max(...xs);
	return lo === hi ? f(lo) : `${f(lo)}–${f(hi)}`;
};
const yes = (b) => (b ? 'yes' : '**NO**');

function markdownTables() {
	const R = report();
	const P = PARAMS;
	const C = R.current;
	const out = {};
	const s30 = Object.fromEntries(ARCHETYPE_NAMES.map((a) => [a, R.buffIncomeShare[a][30]]));
	const reg30 = s30[F.REFERENCE_ARCHETYPE];
	const d8 = R.decision8;
	const r2r = R.r2;
	const N = Math.round(R.durationAlternatives[F.REFERENCE_ARCHETYPE].castsBasedCasts);
	const cutK = R.luckyDraw.proposed.map((x) => x.cratesSaved / x.expectedCrates);
	const regWin = Object.entries(r2r.windows);

	const X = C.liveRepro;
	out['buffs-headline'] = mdTable(['Figure', 'Value', 'Table'], [
		['Live in production today (B2 + B3)', C.livePaths.live
			? `an activated buff keeps applying on 'Fish again' casts, catch-card sales and 'Open another' until the player's next slash command, and the unit is never used up (reproduced on the in-memory test database: XP x${X.fishAgain.xpMultiplier} ${X.fishAgain.msAfterEnd} ms after expiry, $${X.sellButton.paid} paid for a $${X.sellButton.stored} catch); hotfix: B3 alone, now`
			: 'every buff query in src/ filters on endTime (B3 hotfix present); B2 open', 'Bugs'],
		['Buffs a regular player receives per 30 days (integrated)', `${fx(reg30.buffsPer30dTotal)}: ${BUFF_NAMES.map((n) => `${n} ${fx(reg30.buffsPer30d[n])}`).join(', ')}; today ${fx(C.buffsPer30dToday.dailyBoxOnly)} (${fx(C.buffsPer30dToday.withTopggVotes)} with the retiring Top.gg votes)`, 'Sources per 30 days'],
		['Share of fishing income buffs add, first 30 days (Double Cash + Lucky Draw)', ARCHETYPE_NAMES.map((a) => `${a} ${pct(s30[a].cash)} (${pct(s30[a].cashDoubleCashOnly)} + ${pct(s30[a].cashLuckyDrawOnly)})`).join(', '), 'Income share'],
		['Share of XP from Double XP, first 30 days', range(ARCHETYPE_NAMES.map((a) => s30[a].xp), (x) => pct(x, 2)), 'Income share'],
		[`Decision 8, regular player, ${HORIZON_DAYS} days`, `uncapped sale-time hoarder +${pct(d8.regular[HORIZON_DAYS].share.saleTimeHoarderUncapped)} of fishing income vs catch-time +${pct(d8.regular[HORIZON_DAYS].share.catchTime)}`, 'Decision 8'],
		['Regular player with buffs (reference loop)', `${regWin.map(([L, w]) => `L${L} ${fx(w.with)} h`).join(', ')}; ${Object.values(r2r.windows).every((w) => w.inside) ? 'every approved window met' : 'a window is MISSED'}; milestones ${pct(r2r.archetypes.regular.maxHoursDelta, 2)} earlier than without buffs at most`, 'R2 windows'],
		['Minimum-daily player vs casual (R2)', r2r.minimumDaily.verdict.split(':')[0], 'R2 minimum-daily'],
		['No-miss grinder: largest milestone shift from buffs', `${pct(r2r.noMissGrinder.maxHoursDelta, 2)} (${r2r.noMissGrinder.verdict.split(':')[0]})`, 'R2 windows'],
		['Lucky Draw (proposed) on a tier assembly', `saves ${range(cutK, (x) => pct(x, 0))} of the crates, ${range(R.luckyDraw.proposed.map((x) => x.stageHours), (x) => fx(x))} h of stage income; today's Lucky Draw is inert on ${C.luckyToday.tierCrates.filter((x) => x.inert).length} of ${TIERS.length} tier crates`, 'Lucky Draw'],
		['Design checks', `${R.checks.list.filter((c) => c.pass).length} of ${R.checks.list.length} pass${R.checks.pass ? '' : ` (failing: ${R.checks.list.filter((c) => !c.pass).map((c) => c.id).join(', ')})`}`, 'Checks'],
	]);

	out['buffs-decisions'] = `${mdTable(['ID', 'Proposed decision', 'Modelled', 'Alternatives', 'Why', 'Record = model'], DECISIONS.map((d) => [
		`\`${d.id}\``, d.title, d.modelled, d.alternatives.join('; '), d.why,
		d.get ? yes(JSON.stringify(d.get()) === JSON.stringify(d.expected)) : 'n/a',
	]))}\n\nStatus of every entry: \`${[...new Set(DECISIONS.map((d) => d.status))].join(', ')}\`. Only the user approves. \`decisions.js\` joins these to the Phase 5B registry, next to the framework-level entries this design relies on and does not repeat: \`P-DOUBLE-CASH\` (catch-time Double Cash), \`P-EVENTS\` (the event budget) and \`P-LUCKY\`. \`check-shared.js\` verifies each record against the model.`;

	out['buffs-bugs'] = mdTable(['#', 'Bug', 'Evidence (src/ lines read at render time)', 'Fix', 'Ships'], C.bugs.map((b) => [`**${b.id}**`, b.title, b.evidence, b.fix, b.ships]));

	const m = C.measured;
	const perOpen = R.sources.perOpen;
	const noEv = R.buffIncomeShareWithoutEvents;
	out['buffs-current-proposed'] = mdTable(['Item', 'Current', 'Proposed'], [
		['Double Cash timing', 'At **sale**: the sale paths multiply the sale by the first active cash buff, so a hoard sold under it pays the multiplier', `At **catch**: the x${P.catalog['Double Cash'].multiplier} is stamped into \`value\` and \`valueBase\` of each fish caught by a cast during the buff; a sale always pays the stored value (P-DOUBLE-CASH)`],
		['Double Cash scope', 'Every fish sale', 'Fish caught by casting; not quest cash, box fish or items'],
		['Double XP scope', 'Catch XP (the description says "all activities")', 'Catch XP only, as today; quest XP never takes a buff; the description is fixed'],
		['Duration', `\`length: ${C.catalog[0].length}\` added as ms: **${C.catalog[0].actualSecondsAfterActivation} s** on slash commands (B1); on button paths until the player's next slash command (B3)`, `${F.BUFFS.durationSeconds.toLocaleString('en-US')} s of real time for Double XP and Double Cash; Lucky Draw: **${P.catalog['Lucky Draw'].duration.opens} charges** (box opens)`],
		['Consumption', 'Never consumed: the same unit can be activated again at will (B2)', 'One unit per activation, atomically'],
		['Expiry', 'Swept before slash commands only; \'Fish again\', the catch-card Sell button and \'Open another\' never check it (B3)', 'Read-time `endsAt > now` in cast, sale and gacha (the B3 hotfix ships first, alone)'],
		['Same kind', `XP additive (two Double XP = x${C.stacking.twoDoubleXpMultiplier}); cash: first buff only; gacha additive`, `Queue: a second activation extends the timer or adds charges; the multiplier stays x${P.catalog['Double Cash'].multiplier}; at most ${P.stacking.maxQueued} banked per kind`],
		['With events', 'buff x event', `**Additive**: 1 + (buff - 1) + (event - 1) = x${temporaryMultiplier(2, 2)} for a x2 buff in a x2 event`],
		['With gear / aquarium / profile', 'Multiply', 'Multiply (unchanged): raw x (1 + sellBonus) x temporary x profile'],
		['Lucky Draw', `+${Math.round(100 * TODAY_LUCKY_STATS.rareFind)}% to every rare+ weight for 1 h; inert on ${C.luckyToday.tierCrates.filter((x) => x.inert).length} tier crates`, `+${P.catalog['Lucky Draw'].bonusSlots} bonus slot on each of the next ${P.catalog['Lucky Draw'].duration.opens} opens (any box except the Booster Pack)`],
		['Sources', `Daily Box ${pct(m['Daily Box'].buffShareOfSlots, 2)} of slots, Voter's Crate ${pct(m['Voter\'s Crate'].buffShareOfSlots, 2)}, Booster Pack ${pct(m['Booster Pack'].buffShareOfSlots, 0)}`, `Streak Crate / Chest: Double XP and Double Cash only (${pct(perOpen['Streak Crate']['Double Cash'], 2)} / ${pct(perOpen['Streak Chest']['Double Cash'], 2)} per type per open), no Lucky Draw; Daily Box unchanged; Lucky Draw from ${PARAMS.sources.luckyDrawFrom.map((x) => ({ quests: 'the Daily Box', events: 'events' })[x] || x).join(', ')} and the Booster Pack; events (P-EVENTS: ${BUFF_NAMES.map((n) => `${P.sources.events.perThirtyDays[n]} ${n}`).join(', ')} per 30 days), Booster Pack unvalued, no shop`],
		['Buffs per 30 days (regular player)', `${fx(C.buffsPer30dToday.dailyBoxOnly)} (Daily Box); ${fx(C.buffsPer30dToday.withTopggVotes)} with Top.gg votes (being retired)`, `**${fx(reg30.buffsPer30dTotal)}** (${fx(noEv.regular.buffsPer30dTotal)} without events)`],
		['Share of fishing income from buffs (30 d)', `Not measured in production: an activated buff applies to every button cast and button sale until the next slash command and is reusable (B2, B3). If B1 + B2 shipped while cash still pays at sale, the uncapped hoarder over ${HORIZON_DAYS} days at today's arrival rates (proposed economy): ${range(ARCHETYPE_NAMES.map((a) => R.frequency[FREQUENCY_SETS[0][0]][a].saleTimeHoarderUncapped), (x) => pct(x))} of fishing income (${FREQUENCY_SETS[0][0]}), ${range(ARCHETYPE_NAMES.map((a) => R.frequency[FREQUENCY_SETS[1][0]][a].saleTimeHoarderUncapped), (x) => pct(x))} (${FREQUENCY_SETS[1][0]}); frequency table`, `${ARCHETYPE_NAMES.map((a) => `${a} ${pct(s30[a].cash)}`).join(', ')}; XP ${range(ARCHETYPE_NAMES.map((a) => s30[a].xp), (x) => pct(x))}`],
		['Public presentation', 'The sale message shows base x cash buff', 'Catch card: base values, which include the buff, plus one line with the time left; the sale message shows the sum of `valueBase`'],
	]);

	out['buffs-dc-models'] = mdTable(['Model', 'Rule'], [
		['**Catch-time (proposed)**', 'The buffs system itself: each Double Cash doubles the catch of the play its window covers (the session it starts, at each step\'s rates).'],
		['Catch-time, buff saver', 'Upper bound: the same units, each played for its whole hour (casual and regular players would have to play longer that day).'],
		['Catch-time, casts-based', `Alternative duration: the buff lasts the next **${N} casts** (one reference hour: \`F.COOLDOWN\` + \`F.DESIGN_OVERHEAD_S\`), however long that takes; mean-field on the daily rows.`],
		['Sale-time, sells every session', 'Sells what they catch, so the buff hour doubles that hour\'s sales: equals catch-time.'],
		['**Sale-time hoarder, uncapped**', 'Sells at x1 only the fish needed for the day\'s upkeep and progression purchases (gear, permits) beyond the non-fish cash it holds (quests, streak, salvage, Lucky Draw rebates); hoards the rest and sells it under the next Double Cash. Exact renewal DP over the day of the last hoard sale, P(arrival on a day) = 1 - e^(-lambda).'],
		['Sale-time hoarder, capped', `The bonus per buff is capped at **${P.alternatives.saleTimeCapHours} h of the player's stage income** at the reference cadence; the hoarder sells exactly the capped amount under each buff.`],
	]);

	out['buffs-dc-share'] = mdTable(['Player', 'Period', 'Level at end', 'Fishing income', 'Double Cash / 30 d', '**Catch-time (proposed)**', 'Buff saver', 'Casts-based', 'Sale-time, sells every session', 'Sale-time hoarder, uncapped', 'Sale-time hoarder, capped', 'Hoardable share (fish not needed for spending)'],
		ARCHETYPE_NAMES.flatMap((a) => [30, HORIZON_DAYS].map((d) => {
			const x = d8[a][d];
			return [label(a), `${d} d`, x.level, usd(x.fishingIncome), fx(x.doubleCashPer30d), `**${pct(x.share.catchTime)}**`, pct(x.share.catchTimeBuffSaver), pct(x.share.catchTimeCastsBased), pct(x.share.saleTimeNonHoarder), pct(x.share.saleTimeHoarderUncapped), pct(x.share.saleTimeHoarderCapped), pct(x.hoardableShare, 0)];
		})));

	out['buffs-frequency'] = mdTable(['Sources', 'Double Cash / 30 d (regular)', ...ARCHETYPE_NAMES.map(label)], Object.entries(R.frequency).map(([k, row]) => [k, fx(row.regular.doubleCashPer30d), ...ARCHETYPE_NAMES.map((a) => `${pct(row[a].catchTime)} / ${pct(row[a].saleTimeHoarderUncapped)} / ${pct(row[a].saleTimeHoarderCapped)}`)]));

	out['buffs-duration'] = mdTable(['Player', 'Double Cash: real hour (proposed)', `Double Cash: ${N} casts`, 'Double XP: real hour (proposed)', `Double XP: ${N} casts`],
		DURATION_ARCHETYPES.map((a) => {
			const x = R.durationAlternatives[a];
			return [label(a), pct(x.doubleCash.wallclock, 2), pct(x.doubleCash.castsBased, 2), pct(x.doubleXp.wallclock, 2), pct(x.doubleXp.castsBased, 2)];
		}));

	const VPB = { casual: ['Ocean', 'Lake', 'Coast', 'Swamp'], regular: F.LIVE_BIOMES, grinder: ['Lake', 'Swamp'] };
	out['buffs-value-per-buff'] = mdTable(['Player', 'Stage', 'Double Cash, used on a normal day', 'Double Cash, saved for a 1 h session', 'Double XP (XP)', 'Lucky Draw on the next tier assembly (hours of own play)', `Lucky Draw on ${P.catalog['Lucky Draw'].duration.opens} Streak Crates`],
		Object.entries(VPB).flatMap(([a, biomes]) => R.perBuff[a].filter((x) => biomes.includes(x.biome)).map((x) => [
			label(a), `${x.biome} (Lv ${x.level}, ${x.tier})`, `${usd(x.doubleCash.dollars)} (${fx(x.doubleCash.minutesOfOwnPlay, 1)} min)`, usd(x.doubleCash.ifSavedForAnHourSession), int(x.doubleXp.xp),
			x.luckyDraw.nextAssembly ? `T${x.luckyDraw.nextAssembly.tier}: ${usd(x.luckyDraw.nextAssembly.dollars)} (${fx(x.luckyDraw.nextAssembly.hoursOfOwnPlay)} h)` : 'none (last tier)', usd(x.luckyDraw.onStreakCrates.dollars),
		])));

	out['buffs-per-open'] = mdTable(['Box', 'Per type per open', 'Any buff per open'], [
		...['Streak Crate', 'Streak Chest', 'Daily Box', 'Voter\'s Crate'].map((b) => [b === 'Voter\'s Crate' ? 'Voter\'s Crate (legacy, finite stock)' : b, pct(perOpen[b]['Double Cash'], 3), pct(sum(Object.values(perOpen[b])), 2)]),
		['Booster Pack (Easter egg; never valued)', pct(m['Booster Pack'].perOpenAnyBuff / 3, 1), `${pct(m['Booster Pack'].perOpenAnyBuff, 0)}; never valued`],
	]);

	const src30 = R.sources.perThirtyDays[F.REFERENCE_ARCHETYPE];
	const bx = src30.boxes;
	const srcLabel = { streak: `Streak (${int(bx['Streak Crate'] || 0)} crates + ${int(bx['Streak Chest'] || 0)} chests)`, quests: `Quests (${fx((bx['Daily Box'] || 0) / 30)} Daily Boxes a day)`, events: '**Events (P-EVENTS budget)**' };
	out['buffs-per-30d'] = mdTable(['Source (regular player, first 30 days)', ...BUFF_NAMES], [
		...SOURCES.map((s) => [srcLabel[s], ...BUFF_NAMES.map((n) => fx(src30.bySource[s]?.[n] || 0))]),
		['**Total**', ...BUFF_NAMES.map((n) => `**${fx(src30.byType[n])}**`)],
	]);

	out['buffs-income-share'] = mdTable(['Player', 'Period', 'Level at end', 'Play-hours', 'Fishing income', 'Double Cash', 'Lucky Draw', '**Cash share (of fishing)**', 'Of all cash income', '**XP share**'],
		[...ARCHETYPE_NAMES.flatMap((a) => SHARE_DAYS.map((d) => R.buffIncomeShare[a][d])), R.buffIncomeShare[F.MINIMUM_DAILY.name][30]].map((x) => [
			label(x.archetype), `${x.days} d`, x.level, fx(x.playHours, 1), usd(x.fishingIncome), `${usd(x.doubleCash)} (${pct(x.cashDoubleCashOnly, 2)})`, `${usd(x.luckyDraw)} (${pct(x.cashLuckyDrawOnly, 2)})`, `**${pct(x.cash, 2)}**`, pct(x.cashOfAllIncome, 2), `**${pct(x.xp, 2)}**`,
		]));

	out['buffs-events'] = mdTable(['Player', 'Without events: buffs / 30 d', 'cash share', 'XP share', 'Proposed: buffs / 30 d', 'cash share', 'XP share', 'Double Cash share by source: streak / quests / events'],
		ARCHETYPE_NAMES.map((a) => {
			const w = noEv[a];
			const p = s30[a];
			return [label(a), fx(w.buffsPer30dTotal), pct(w.cash, 2), pct(w.xp, 2), fx(p.buffsPer30dTotal), pct(p.cash, 2), pct(p.xp, 2), SOURCES.map((s) => pct(p.bySource[s]?.cashShare || 0, 2)).join(' / ')];
		}));

	const failingShare = R.checks.list.filter((c) => c.id.startsWith('cash-share-') && !c.pass).map((c) => `\`${c.id}\``);
	out['buffs-cash-share-checks'] = `${mdTable(['Player', 'Target (first 30 days)', '**Buffs of fishing income (the check)**', 'Double Cash only', 'Lucky Draw only', 'Buffs of all cash income', 'Buffs of fishing income, without events', 'Check'],
		ARCHETYPE_NAMES.map((a) => {
			const t = P.targets.cashShareMax30d[a];
			const x = s30[a];
			const cell = (v) => `${pct(v, 2)}${v > t ? ' (over)' : ''}`;
			const c = R.checks.list.find((k) => k.id === `cash-share-${a}`);
			return [label(a), `at most ${pct(t, 0)}`, `**${cell(x.cash)}**`, cell(x.cashDoubleCashOnly), cell(x.cashLuckyDrawOnly), cell(x.cashOfAllIncome), cell(noEv[a].cash), `\`${c.id}\` ${c.pass ? 'passes' : '**fails**'}`];
		}))}\n\n${failingShare.length ? `Failing: ${failingShare.join(', ')}.` : 'Every cash-share check passes.'} Each column divides the same buff value (or its Double Cash or Lucky Draw part) by the column's income and compares it with the same target (\`PARAMS.targets.cashShareMax30d\`); "(over)" marks a cell above it. No parameter was tuned to pass; the options are in the buffs design (Risks and open issues).`;

	const lt = C.luckyToday;
	out['buffs-lucky-today'] = `${mdTable(['Box (Lake-stage fish)', 'P(rare+) per slot: today -> with Lucky Draw', 'Liquid value per open'], lt.boxes.map((b) => [b.box, `${pct(b.rarePlusPerSlot)} -> ${pct(b.rarePlusPerSlotLucky)}`, `${usd(b.liquid)} -> ${usd(b.liquidLucky)} (+${usd(b.liquidGain)})`]))}\n\n${mdTable(['Tier crate (rods design)', 'Expected crates per assembly', 'With **every** open lucky (today)', 'Saved'], lt.tierCrates.map((t) => [`T${t.tier} ${t.crate}`, fx(t.expectedCrates, 3), fx(t.expectedCratesAllOpensLucky, 3), t.inert ? '**0 (inert)**' : fx(t.cratesSaved, 3)]))}`;

	out['buffs-lucky-k'] = mdTable(['K (opens)', ...R.luckyDraw.proposed.map((x) => `T${x.tier} ${x.crate.replace(/ (Tackle )?Crate$/, '')}`)],
		Object.entries(R.luckyDraw.byOpens).map(([k, row]) => {
			const bold = Number(k) === P.catalog['Lucky Draw'].duration.opens;
			const b = (s) => (bold ? `**${s}**` : s);
			return [b(`${k}${bold ? ' (proposed)' : ''}`), ...row.map((x) => b(`${fx(x.cratesSaved)} cr (${pct(x.cratesSaved / x.expectedCrates, 0)}) · ${usd(x.dollars)} · ${fx(x.stageHours)} h`))];
		}));

	out['buffs-lucky-slot'] = mdTable(['Box', ...F.LIVE_BIOMES.map((b) => `${b} (Lv ${F.BIOME_LEVEL[b]})`)], R.luckyDraw.bonusSlot.map((b) => [b.box, ...b.perStage.map((x) => usd(x.value))]));

	out['buffs-catalog'] = mdTable(['Buff', 'Effect', 'Duration', 'Description (new text)'], [
		['Double XP', `x${P.catalog['Double XP'].multiplier} XP of fish caught by casting`, `${windowHours('Double XP')} h (real time)`, '"Doubles the XP of fish you catch for one hour. Quest XP is not affected."'],
		['Double Cash', `x${P.catalog['Double Cash'].multiplier} value of fish caught by casting, stored on the fish`, `${windowHours('Double Cash')} h (real time)`, '"Fish you catch in the next hour are worth double. The bonus stays on the fish: sell whenever you like."'],
		['Lucky Draw', `+${P.catalog['Lucky Draw'].bonusSlots} bonus slot`, `next ${P.catalog['Lucky Draw'].duration.opens} box opens`, `"Your next ${P.catalog['Lucky Draw'].duration.opens} box openings each roll one bonus slot. (Not Booster Packs.)"`],
	]);

	out['buffs-rules'] = mdTable(['Case', 'Before', 'Event', 'After'], R.ruleExamples.map((x) => [x.case, x.before, x.event, x.after]));

	out['buffs-r2'] = mdTable(['Player', 'Level', 'Play-hours (no buffs -> buffs)', 'Calendar day', 'Fishing XP', 'Quest XP', 'Buff XP (by source)', 'Shares: fishing / quests / buff'],
		ARCHETYPE_NAMES.flatMap((a) => {
			const x = r2r.archetypes[a];
			return Object.entries(x.decomposition).map(([L, d]) => [label(a), L, `${fx(x.hoursWithoutBuffs[L])} -> ${fx(x.hoursWithBuffs[L])}`, d.day, int(d.fishingXp), int(d.questXp),
				`${int(d.buffXp)} (${Object.entries(d.buffXpBySource).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${int(v)}`).join(', ') || 'none'})`, `${pct(d.shares.fishing)} / ${pct(d.shares.quests)} / ${pct(d.shares.buff, 2)}`]);
		}));

	out['buffs-r2-windows'] = mdTable(['Player', ...F.LIFECYCLE.milestones.map((L) => `L${L}`), 'Largest shift'], ARCHETYPE_NAMES.map((a) => {
		const x = r2r.archetypes[a];
		return [label(a), ...F.LIFECYCLE.milestones.map((L) => (x.hoursWithBuffs[L] === undefined ? 'n/a' : `${fx(x.hoursWithoutBuffs[L])} -> ${fx(x.hoursWithBuffs[L])}`)), pct(x.maxHoursDelta, 2)];
	})) + `\n\n${mdTable(['Regular player window', 'Hours without buffs', 'Hours with buffs', 'Inside'], regWin.map(([L, w]) => [`L${L}: ${w.window[0]}–${w.window[1]} h`, fx(w.without), fx(w.with), yes(w.inside)]))}`;

	out['buffs-r2-min-daily'] = mdTable(['Day', 'Min-daily: level', 'play-h', 'XP / active h', 'XP / day', 'buff XP share', 'Casual: level', 'play-h', 'XP / active h', 'XP / day', 'buff XP share', 'Leads?'],
		r2r.minimumDaily.rows.map((r) => [r.day, r.minimumDaily.level, fx(r.minimumDaily.hours), int(r.minimumDaily.xpPerActiveHour), int(r.minimumDaily.xpPerDay), pct(r.minimumDaily.buffXpShare, 2), r.casual.level, fx(r.casual.hours), int(r.casual.xpPerActiveHour), int(r.casual.xpPerDay), pct(r.casual.buffXpShare, 2), r.minimumDailyLeadsInLevel ? '**yes**' : 'no']))
		+ `\n\nVerdict: ${r2r.minimumDaily.verdict} The minimum-daily player's buff XP share is ${r2r.minimumDaily.buffXpShareBelowCasual ? 'below' : 'NOT below'} the casual player's at every checkpoint.`;

	const fv = R.founder;
	out['buffs-founder'] = mdTable(['Figure', 'Normal', 'Founder', 'Note'], [
		...fv.boxes.map((b) => [`${b.box}: each buff type per open`, pct(b.normal['Double XP'], 2), pct(b.founder['Double XP'], 2), 'Founder gacha luck (buffs are Rare items)']),
		...BUFF_NAMES.map((n) => [`${n} per 30 days (regular play)`, fx(fv.buffsPer30d.normal[n]), fx(fv.buffsPer30d.founder[n]), n === 'Double XP' ? `x${fx(fv.buffsPer30d.ratio)}` : 'events grant the same to everyone']),
		['Public XP drift (share of XP)', '0', pct(fv.publicXpDriftShare, 2), `extra Double XP units a day x fishing's share of XP at L50 (${pct(fv.fishingShareAtL50, 1)})`],
		['Public level drift at L50', '0', fx(fv.publicLevelDriftAtL50), 'levels ahead of an identical normal player'],
	]);

	out['buffs-system'] = mdTable(['Hook', 'What it does'], [
		['`on(\'box\')`', 'Adds a granted box\'s expected buffs to the stock (`{ name, count, level, source }`, priced by `boxBuffOdds` at the payload level and the run\'s profile). The Booster Pack is never valued; an unknown box throws. A box from a source that `opts.sources` leaves out is counted as ignored.'],
		['events', `The \`F.EVENTS\` budget (${BUFF_NAMES.map((n) => `${P.sources.events.perThirtyDays[n]} ${n}`).join(', ')} per 30 days) accrues per calendar day and is delivered at the start of the next played day.`],
		['`onDayStart`', `Activates held Double XP / Double Cash at the session start: one unit per started hour of the planned session, queued up to ${P.stacking.maxQueued} (the minimum-daily session: one).`],
		['`onCasts`', 'While a window is open (counted in play minutes), credits the bonus on the step\'s catch: XP `\'buff\'` final (multiplier - 1) x `rates.xp` with public base (multiplier - 1) x `rates.xpBase`; cash `\'buff\'` (multiplier - 1) x `rates.cash`. The rest of the window ends with the session.'],
		['`on(\'assembly\')`', 'On the rods system\'s assembly event, one held Lucky Draw goes into the tier assembly: cash `\'luckyDraw\'` = `luckyDrawValue(tier).dollars`, a rebate at the assembly (the goal and its cost stay the rods system\'s).'],
		['`onDayEnd`', `Lucky Draws above the reserve (${P.luckyDrawReserve} while a tier is still ahead) go on Streak Crates: ${P.catalog['Lucky Draw'].duration.opens} x \`bonusSlotValue('Streak Crate', level)\`, cash \`'luckyDraw'\`.`],
		['`sessionDone`', 'Always true: buffs set no daily minimum.'],
		['Ledger', `Writes XP / public XP \`'${BUFF_SOURCE}'\` and cash \`'${BUFF_SOURCE}'\`, \`'${LUCKY_SOURCE}'\`; no spend items, no purchases.`],
		['Options', `\`sources\` (default ${SOURCES.join(', ')}; the frequency table also uses ${Object.keys(TODAY_SOURCES).join(', ')}), \`trace\` (observational closes, rows and milestone values; checks \`trace-is-observational\`).`],
	]);

	const SP = SYSTEM_PARITY;
	out['buffs-parity'] = mdTable(['Comparison (recorded, commit a83b5f0)', 'Result'], [
		['Replay of the old loop\'s day-end valuation on the core', `${SP.replay.exactMilestones} milestones step-exact, max relative difference ${SP.replay.maxRelativeDifference}`],
		['Design defaults vs the old loop: milestone hours', `${SP.system.exactMilestones} step-exact, every milestone within ${SP.system.maxAbsSteps} step (worst ${pct(SP.system.hoursMaxRelativeDifference, 2)} at ${SP.system.hoursWorst})`],
		['Design defaults: ledgers at day 30', Object.entries(SP.system.ledgerMaxRelativeDifferenceAtDay30).map(([k, x]) => `${k} ${pct(x, 1)}`).join(', ')],
		['Design defaults: ledgers at the last checkpoint', Object.entries(SP.system.ledgerMaxRelativeDifferenceAtLastCheckpoint).map(([k, x]) => `${k} ${pct(x, 2)}`).join(', ')],
		['Value per unit actually used', `Double Cash within ${pct(SP.system.valuePerUnitUsedMaxRelativeDifference.doubleCash, 2)}, Double XP within ${pct(SP.system.valuePerUnitUsedMaxRelativeDifference.doubleXpXp, 2)}`],
		['Why they differ', SP.system.cause],
		['Streak buff value counted once', `replay ${yes(SP.streakCountedOnce.replay)}, with streak.system() ${yes(SP.streakCountedOnce.withStreakSystem)} (regular, 30 d: ${usd(SP.streakCountedOnce.regular30d.streakNonBuffContents)} + ${usd(SP.streakCountedOnce.regular30d.buffsDoubleCash)} = ${usd(SP.streakCountedOnce.regular30d.streakCashEquivalent)})`],
	]);

	out['buffs-checks'] = mdTable(['Check', 'Pass', 'Detail'], R.checks.list.map((c) => [`\`${c.id}\``, yes(c.pass), c.detail]));
	return out;
}

module.exports = {
	PARAMS, DECISIONS,
	defaultState, activate, effectsAt, consumeOpen, temporaryMultiplier, catchValue, catchXp, legacyKind, ruleExamples,
	boxBuffOdds, bonusSlotValue, luckyAssembly, luckyDrawValue, valuePerBuff, current,
	SYSTEM_NAME, SYSTEM_DEFAULTS, SOURCES, TODAY_SOURCES, LEDGER_SOURCES, SYSTEM_PARITY, system, coverage,
	lifecycle, buffIncomeShare, doubleCashModels, saleTimeHoarder, r2, founderView, checks,
	report, markdownTables,
};

if (require.main === module) process.stdout.write(`${JSON.stringify(module.exports.report(), null, 1)}\n`);
