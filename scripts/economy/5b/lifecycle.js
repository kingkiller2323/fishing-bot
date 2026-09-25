// Phase 5B shared LIFECYCLE CORE (framework 5b.3): the one stepping loop every Phase 5B model uses.
// Subsystems never step time themselves; they plug in as SYSTEMS (hook objects) and the core runs them.
//
//   const { simulate } = require('./lifecycle');   // or F.lifecycle.simulate
//   simulate({ archetype: 'regular', systems: [...], days, stopAtLevel, gate, curve, gearPath })
//
// Time model (identical to curve.js through 5b.2, which it reproduces exactly with the provisional
// systems): play advances in steps of F.LIFECYCLE.stepH hours. A fixed-session player plays until the
// play-hour clock crosses the next multiple of minutesPerDay/60 (the crossing step's overshoot carries
// into the next day, as before). A 'minimumDaily' player (F.MINIMUM_DAILY) plays each day only until
// every system reports its daily minimum met. Calendar days a player does not attend (daysPerWeek < 7)
// pass without play.
//
// A system is an object with any of these hooks (all optional, all synchronous):
//   name                                  ledger/state key (state.sys[name] is its private state)
//   init(state, ctx)                      set up state.sys[name]
//   canFish(biome, state, ctx) -> bool    access rule (e.g. biome permits); the core fishes the highest
//                                         live biome unlocked by the gate level that every system allows
//   modifyCast(input, state, ctx)         mutate the castOutcome input (stats, sellMult, xpMult, table,
//                                         fishDist, multiChance) and/or push per-cast costs onto input.costs:
//                                         { category, item, perCast } (category: see CATEGORIES)
//   outcome(input, state, ctx) -> o       replace castOutcome entirely (e.g. the Founder profile); o must
//                                         have fishPerCast, xpPerCast, valuePerCast, cooldownMs,
//                                         durabilityPerCast and may add xpBasePerCast / valueBasePerCast.
//                                         AT MOST ONE system per run may provide it (simulate() throws
//                                         otherwise; everything else composes through modifyCast). Its
//                                         result is NOT cached unless the system also provides
//   outcomeCacheKey(input, state, ctx) -> string
//                                         a key covering every piece of state the outcome depends on
//                                         (the core caches on input + this key). Plain F.castOutcome is a
//                                         pure function of the input and is always cached.
//   beforeStep(state, ctx, rates)         runs after this step's rates are fixed, before they accrue
//   onCasts(state, ctx, { casts, fish, rates })
//                                         after accrual (repairs, counters)
//   goals(state, ctx) -> [goal]           purchases; goal = { id, category, cost, priority, available,
//                                         blocking (default: category === 'progression'), buy() }
//   sessionDone(state, ctx) -> bool       'minimumDaily' sessions end when every system returns true
//   onDayStart(state, ctx) / onDayEnd(state, ctx) / onMissedDay(state, ctx)
//   on(event, payload, state, ctx)        events sent with ctx.emit (e.g. 'box', 'levelUp')
//
// Ledgers (every number the Phase 5B tables quote comes from these):
//   ledger.xp[source] (account XP), ledger.publicXp[source] (base/competitive XP), ledger.cash[source],
//   ledger.spend[category][item]. Milestones snapshot the ledgers, so XP-source decompositions (R2) are
//   exact at every level.
const F = require('./framework');

/** Sink categories (user decision 10): mandatory upkeep, progression purchases, optional/aspirational. */
const CATEGORIES = ['upkeep', 'progression', 'optional', 'aspirational'];
/** Default purchase priorities (lower first). Systems may pass their own. */
const PRIORITY = { permit: 10, rod: 20, license: 50, optional: 80, aspirational: 90 };

function normalizeArchetype(a) {
	const base = typeof a === 'string' ? (a === F.MINIMUM_DAILY.name ? F.MINIMUM_DAILY : F.ARCHETYPES[a]) : a;
	if (!base) throw new Error(`Unknown archetype ${a}`);
	const name = typeof a === 'string' ? a : (a.name || 'custom');
	return { name, session: 'fixed', daysPerWeek: 7, ...base };
}

/** Deterministic attendance: `daysPerWeek` play days spread evenly over each week. */
const attends = (day, daysPerWeek) => daysPerWeek >= 7 || Math.floor(((day % 7) + 1) * daysPerWeek / 7) > Math.floor((day % 7) * daysPerWeek / 7);

const add = (obj, key, v) => {
	obj[key] = (obj[key] || 0) + v;
};
const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * Runs one player's lifecycle.
 * @param {object} opts {
 *   archetype   name ('casual'|'regular'|'active'|'grinder'|'minimumDaily') or an archetype object
 *   systems     array of systems (see header)
 *   days        calendar days to simulate at most (default 3650)
 *   stopAtLevel stop once this level (of `stopOn`) is reached (default F.LIFECYCLE.maxLevel)
 *   stopOn      'real' | 'public' | 'gate' (default 'gate')
 *   gate        which level gates content: 'real' (default) | 'public'
 *   curve       XP curve override (coefficient sweeps; default F.CURVE)
 *   gearPath    gear path override (default F.gearPath())
 *   biomes      fishable biome list (default F.LIVE_BIOMES)
 *   onNoAccess  what happens when no biome is legally fishable (every canFish rejects every unlocked
 *               biome): 'throw' (default: a broken access rule fails loudly) | 'idle' (the player cannot
 *               fish: the step passes with no casts and is counted in blockedHours). The core never
 *               falls back to a biome the access rules deny.
 *   milestones  levels to record (default F.LIFECYCLE.milestones)
 *   checkpoints calendar days to snapshot (default [1, 7, 14, 28, 30, 60, 90, 182, 365])
 *   stepH       step length in hours (default F.LIFECYCLE.stepH) }
 */
function simulate(opts = {}) {
	const arch = normalizeArchetype(opts.archetype || F.REFERENCE_ARCHETYPE);
	const curve = opts.curve || F.CURVE;
	const path = opts.gearPath || F.gearPath();
	const biomes = opts.biomes || F.LIVE_BIOMES;
	const systems = (opts.systems || []).filter(Boolean);
	const stepH = opts.stepH ?? F.LIFECYCLE.stepH;
	const maxDays = opts.days ?? 3650;
	const stopAtLevel = opts.stopAtLevel === undefined ? F.LIFECYCLE.maxLevel : opts.stopAtLevel;
	const stopOn = opts.stopOn || 'gate';
	const gate = opts.gate || 'real';
	const milestoneLevels = opts.milestones || F.LIFECYCLE.milestones;
	const checkpoints = new Set(opts.checkpoints || [1, 7, 14, 28, 30, 60, 90, 182, 365]);
	const onNoAccess = opts.onNoAccess || 'throw';
	if (!['throw', 'idle'].includes(onNoAccess)) throw new Error(`Unknown onNoAccess ${onNoAccess}`);
	const dayH = arch.minutesPerDay / 60;
	// At most one full cast-outcome override per run; everything else composes through modifyCast.
	const providers = systems.filter((s) => typeof s.outcome === 'function');
	if (providers.length > 1) throw new Error(`Only one system may override the cast outcome; got ${providers.map((s) => s.name || '(unnamed)').join(', ')}`);
	const provider = providers[0] || null;

	const state = {
		day: 0, playDay: 0, h: 0, minutesToday: 0, castsToday: 0, fishToday: 0, castsTotal: 0, fishTotal: 0,
		xp: 0, publicXp: 0, money: 0, minMoney: 0, level: 1, publicLevel: 1, equippedTier: 0, biome: null,
		stepStartLevel: 1, blocked: false, blockedHours: 0, sys: {},
		ledger: { xp: {}, publicXp: {}, cash: {}, spend: Object.fromEntries(CATEGORIES.map((c) => [c, {}])) },
		milestones: {}, publicMilestones: {}, purchases: [], timeline: [],
	};
	const gateLevel = () => (gate === 'public' ? state.publicLevel : state.level);
	const ctx = {
		F, path, arch, curve, state, gate, gateLevel, stepH, systems,
		addXp(source, final, base = final) {
			state.xp += final;
			state.publicXp += base;
			add(state.ledger.xp, source, final);
			add(state.ledger.publicXp, source, base);
		},
		addCash(source, amount) {
			state.money += amount;
			add(state.ledger.cash, source, amount);
		},
		spend(category, item, amount) {
			if (!CATEGORIES.includes(category)) throw new Error(`Unknown sink category ${category}`);
			state.money -= amount;
			add(state.ledger.spend[category], item, amount);
			state.minMoney = Math.min(state.minMoney, state.money);
		},
		emit(event, payload) {
			for (const s of systems) if (s.on) s.on(event, payload, state, ctx);
		},
		mark(key, extra = {}) {
			if (!state.milestones[key]) state.milestones[key] = { hours: +state.h.toFixed(4), day: state.day + 1, ...extra };
		},
	};
	for (const s of systems) if (s.init) s.init(state, ctx);

	const rateCache = new Map();
	const BLOCKED = Object.freeze({ blocked: true, biome: null, castsPerStep: 0, fish: 0, xp: 0, xpBase: 0, cash: 0, cashBase: 0, durability: 0, costs: [], perHour: { casts: 0, xp: 0, cash: 0 } });
	function castRates() {
		const L = gateLevel();
		const unlocked = biomes.filter((b) => L >= F.BIOME_LEVEL[b]);
		const open = unlocked.filter((b) => systems.every((s) => !s.canFish || s.canFish(b, state, ctx) !== false));
		if (!open.length) {
			// Never bypass an access gate: a denied player is blocked, not silently sent to a default biome.
			if (onNoAccess === 'throw') {
				const denials = unlocked.map((b) => `${b}: ${systems.filter((s) => s.canFish && s.canFish(b, state, ctx) === false).map((s) => s.name || '(unnamed)').join('/')}`);
				throw new Error(`No legally fishable biome at gate level ${L} on day ${state.day + 1} (${denials.join('; ') || 'no biome unlocked'})`);
			}
			state.blocked = true;
			state.biome = null;
			return BLOCKED;
		}
		state.blocked = false;
		const biome = open[open.length - 1];
		state.biome = biome;
		const gear = path[state.equippedTier];
		const input = {
			biome, qualities: [...gear.qualities], stats: { ...gear.stats },
			multiChance: gear.multiChance ?? F.chanceForMean(gear.meanFish), tier: state.equippedTier, costs: [],
		};
		for (const s of systems) if (s.modifyCast) s.modifyCast(input, state, ctx);
		// Cache only what is provably a function of the key: plain castOutcome is pure in its input; a
		// custom outcome() may read state, so it is cached only with its own state-aware key.
		let key = JSON.stringify(input);
		if (provider) key = typeof provider.outcomeCacheKey === 'function' ? `${key}|${provider.outcomeCacheKey(input, state, ctx)}` : null;
		let r = key === null ? null : rateCache.get(key);
		if (!r) {
			const o = provider ? provider.outcome(input, state, ctx) : F.castOutcome(input);
			const casts = (stepH * 3600) / (o.cooldownMs / 1000 + arch.overheadS);
			r = {
				biome, tier: state.equippedTier, outcome: o, castsPerStep: casts,
				fish: casts * o.fishPerCast,
				xp: casts * o.xpPerCast, xpBase: casts * (o.xpBasePerCast ?? o.xpPerCast),
				cash: casts * o.valuePerCast, cashBase: casts * (o.valueBasePerCast ?? o.valuePerCast),
				durability: casts * o.durabilityPerCast,
				costs: input.costs.map((c) => ({ ...c, perStep: c.perCast * casts })),
				// Per-hour figures for systems that price in hours of income.
				perHour: { casts: casts / stepH, xp: (casts * o.xpPerCast) / stepH, cash: (casts * o.valuePerCast) / stepH },
			};
			if (key !== null) rateCache.set(key, r);
		}
		return r;
	}

	function updateLevels() {
		const before = state.level;
		const beforePublic = state.publicLevel;
		state.level = Math.max(state.level, F.levelForXp(state.xp, curve));
		state.publicLevel = Math.max(state.publicLevel, F.levelForXp(state.publicXp, curve));
		for (const T of milestoneLevels) {
			if (!state.milestones[T] && state.level >= T) {
				state.milestones[T] = { hours: +state.h.toFixed(4), day: state.day + 1, playDay: state.playDay + 1, ledger: clone(state.ledger), money: state.money };
			}
			if (!state.publicMilestones[T] && state.publicLevel >= T) {
				state.publicMilestones[T] = { hours: +state.h.toFixed(4), day: state.day + 1, playDay: state.playDay + 1, ledger: clone(state.ledger), money: state.money };
			}
		}
		if (state.level > before) ctx.emit('levelUp', { from: before, to: state.level, kind: 'real' });
		if (state.publicLevel > beforePublic) ctx.emit('levelUp', { from: beforePublic, to: state.publicLevel, kind: 'public' });
	}

	function purchase() {
		const goals = [];
		for (const s of systems) if (s.goals) goals.push(...s.goals(state, ctx).filter(Boolean).map((g) => ({ system: s.name, ...g })));
		goals.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
		for (const g of goals) {
			if (g.available === false) continue;
			const blocking = g.blocking ?? g.category === 'progression';
			if (state.money >= g.cost + (g.reserve || 0)) {
				ctx.spend(g.category, g.item || g.id, g.cost);
				state.purchases.push({ id: g.id, category: g.category, cost: g.cost, hours: +state.h.toFixed(4), day: state.day + 1, level: state.level });
				if (g.buy) g.buy(state, ctx);
			}
			else if (blocking) {
				break;
			}
		}
	}

	function step() {
		state.stepStartLevel = gateLevel();
		const r = castRates();
		for (const s of systems) if (s.beforeStep) s.beforeStep(state, ctx, r);
		ctx.addXp('fishing', r.xp, r.xpBase);
		ctx.addCash('fishing', r.cash);
		for (const c of r.costs) ctx.spend(c.category, c.item, c.perStep);
		state.castsToday += r.castsPerStep;
		state.castsTotal += r.castsPerStep;
		state.fishToday += r.fish;
		state.fishTotal += r.fish;
		for (const s of systems) if (s.onCasts) s.onCasts(state, ctx, { casts: r.castsPerStep, fish: r.fish, rates: r });
		state.h += stepH;
		state.minutesToday += stepH * 60;
		if (r.blocked) state.blockedHours += stepH;
		purchase();
		updateLevels();
	}

	const stopped = () => {
		if (stopAtLevel == null) return false;
		const L = stopOn === 'real' ? state.level : stopOn === 'public' ? state.publicLevel : gateLevel();
		return L >= stopAtLevel;
	};

	while (state.day < maxDays && !stopped()) {
		if (!attends(state.day, arch.daysPerWeek)) {
			for (const s of systems) if (s.onMissedDay) s.onMissedDay(state, ctx);
			state.day++;
			continue;
		}
		state.minutesToday = 0;
		state.castsToday = 0;
		state.fishToday = 0;
		for (const s of systems) if (s.onDayStart) s.onDayStart(state, ctx);
		if (arch.session === 'minimumDaily') {
			const done = () => systems.every((s) => !s.sessionDone || s.sessionDone(state, ctx));
			while (!done() && state.minutesToday < (arch.maxMinutesPerDay ?? 120) - 1e-9) step();
		}
		else {
			// Play until the play-hour clock crosses the end of this day's session (curve.js semantics).
			do step(); while (Math.floor(state.h / dayH) === state.playDay && !stopped());
		}
		for (const s of systems) if (s.onDayEnd) s.onDayEnd(state, ctx);
		purchase();
		updateLevels();
		state.playDay++;
		state.day++;
		if (checkpoints.has(state.day)) {
			state.timeline.push({ day: state.day, hours: +state.h.toFixed(3), level: state.level, publicLevel: state.publicLevel, xp: Math.round(state.xp), publicXp: Math.round(state.publicXp), money: Math.round(state.money), tier: state.equippedTier, biome: state.biome });
		}
	}

	return {
		archetype: arch,
		gate,
		curve,
		stopped: stopped(),
		days: state.day,
		hours: +state.h.toFixed(4),
		milestones: state.milestones,
		publicMilestones: state.publicMilestones,
		timeline: state.timeline,
		purchases: state.purchases,
		ledger: state.ledger,
		final: { level: state.level, publicLevel: state.publicLevel, xp: state.xp, publicXp: state.publicXp, money: state.money, minMoney: state.minMoney, tier: state.equippedTier, biome: state.biome, castsTotal: state.castsTotal, fishTotal: state.fishTotal, blockedHours: state.blockedHours },
		sys: state.sys,
	};
}

// ---------------------------------------------------------------------------------------------
// Provisional systems: exactly the placeholder model the 5b.1 curve fit used (level-scaled daily XP,
// rod tiers bought after saving F.PURCHASE.saveHours of stage income). Kept for provenance: curve.js
// 'provisional' reproduces docs/economy/5b/curve.json with them.

/** Daily XP of F.DAILY.xpPerLevel x level (the level when the day's last step started). */
function provisionalDaily({ xpPerLevel = F.DAILY.xpPerLevel } = {}) {
	return {
		name: 'provisionalDaily',
		onDayEnd(state, ctx) {
			ctx.addXp('daily', xpPerLevel * state.stepStartLevel);
		},
	};
}

/** Next rod tier equipped after saving `saveHours` of current-stage income once its level is reached. */
function provisionalRods({ saveHours = F.PURCHASE.saveHours } = {}) {
	return {
		name: 'provisionalRods',
		init(state) {
			state.sys.provisionalRods = { saving: 0 };
		},
		beforeStep(state, ctx, rates) {
			const next = ctx.path[state.equippedTier + 1];
			if (!next || state.stepStartLevel < next.level) return;
			const s = state.sys.provisionalRods;
			s.saving += rates.cash;
			if (s.saving >= rates.perHour.cash * saveHours) {
				state.equippedTier++;
				s.saving = 0;
			}
		},
	};
}

/** Milestone hours only ({ level: hours }), for compact comparisons. */
const milestoneHours = (result, which = 'milestones') => Object.fromEntries(Object.entries(result[which]).filter(([k]) => /^\d+$/.test(k)).map(([k, v]) => [k, v.hours]));

module.exports = { simulate, CATEGORIES, PRIORITY, attends, normalizeArchetype, provisionalDaily, provisionalRods, milestoneHours };
