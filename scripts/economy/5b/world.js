// Phase 5B subsystem: WORLD. Biome income ladder, biome PERMITS, Mountain Stream (Lv 60, the first
// expansion biome) and the post-50 curve. ANALYSIS ONLY: nothing here touches the live game, src/ or
// production data.
//
// Every economic number is computed at runtime from the shared framework (./framework.js, which
// re-exports assumptions.js): archetypes, reference archetype, lifecycle step/milestones, daily XP,
// biome levels/order, gear path, curve, value model and multi-catch all come from F and are never copied
// here. Rod progression costs and upkeep come from ./rods.js (assembly(), crate unlock levels, repair
// cost / durability of the reference sets); rods.js is NEVER read as a gear source (R3): income and XP
// always come from F.gearPath() (since 5b.3 that IS the designed rods path, through the framework). Only the
// design parameters in PARAMS are hand-set, and permit prices are a formula of expected stage income, so a
// framework version bump regenerates every figure.
//
//   node -e "require('./scripts/economy/5b/world.js').report()"      (returns the report object)
//   node scripts/economy/5b/world.js                                   (prints it as JSON)
//
// Exports (pure and synchronous; no database, no randomness):
//   PARAMS                   frozen design parameters: permit price rule (stage share), purchase schedule,
//                            time-to-afford target, Mountain Stream species ladder, expansion sketch
//   gearStep(step)           a gear-path step as castOutcome input ({qualities, stats, multiChance})
//   biomeOutcome(biome, step), biomeHourly(biome, step, overheadS)
//                            F.castOutcome / F.hourly for any biome incl. the PROPOSED Mountain Stream
//                            ladder (live biomes go straight to F; Mountain Stream uses ladderOutcome)
//   valueTable(path)         $/fish, $/h, XP/h per live biome for every step of a gear path (weak-only
//                            and weak+strong access), plus strong premium per biome
//   monotonicity(path)       checks: income rises with biome at every tier, and with tier in every biome
//   stageLadder(path)        "home" income per biome (the tier typically held there) and step ratios
//   ladderSpecies(), currentMountainStream(), liveSpecies(biome)
//                            species lists in catalog shape (proposed Mountain Stream ladder, today's 3
//                            salmon, a live biome's catalog fish) with their framework expected value
//   ladderDraw(species, qualities, table, {weather})
//                            per-draw distribution over a species list: exact mirror of
//                            lib/catalog-model.drawDistribution (checked by mirrorParity())
//   ladderOutcome(species, g, {weather})
//                            F.castOutcome over a species list (same aggregation as the framework)
//   engineCatch(species, qualities, table, {weather})
//                            probability that one draw lands a catch / a fish in the REAL engine (re-rolls,
//                            fallback, NO_CATCH): exact for biomes without a year-round fallback species
//   mirrorParity()           ladderOutcome == F.castOutcome for every live biome x gear step (max rel. error)
//   mountainStream()         proposed ladder summary: counts, per-weather premium, $/fish and $/h by tier,
//                            step over Swamp, BIOME_VALUE rule (band check, requested value), today's
//                            3-salmon biome in the real engine
//   lifecycle(archetype, opts)
//                            curve.js-style lifecycle (same XP stepping) with rods bought on schedule from
//                            rods.assembly() costs, permits bought when due, biome = highest biome with
//                            level AND permit. opts: { permits, prices, schedule 'rod-first'|'permit-first',
//                            purchase 'rods'|'curve', otherSpendShare, extraCashPerDay(L, rates, arch),
//                            maxLevel, path, expansion (Mountain Stream live), grandfathered }
//   referenceStages({path}) stage hours / $ per h / expected earnings of the reference player per biome
//   permitPrice(biome, {share, path})
//                            INTEGRATOR ENTRY POINT: one-time permit price for a biome (0 for Ocean);
//                            share/path overrides are for sensitivity only
//   permitTable()            INTEGRATOR ENTRY POINT: every permit with its formula inputs, payback, and
//                            simulated time-to-afford per archetype (lifecycle delay and standalone hours)
//   timeToAfford(opts)       per archetype and permit: level reached, permit bought, delay (h, sessions)
//   shareSweep()             max permit delay per archetype for alternative stage shares
//   budget()                 lifecycle spend split (upkeep / rods / permits / saved) per archetype
//   accessibleBiomes(level, permits, {biomes}), canFish(level, permits, biome)
//                            the access rule the engine will use: level (gate level) AND permit
//   grandfatheredPermits(user, {now})
//                            additive migration rule: permits a legacy account receives (pure)
//   postFifty()              L50 -> L60 hours/days per archetype, per-level hours, the 50-60 stage budget,
//                            and post-60 pacing with Mountain Stream live (sketch to Lv 100)
//   expansionSketch()        Deep Sea / Arctic / Abyss placement (indicative levels, value, permit)
//   replicationCheck()       lifecycle(purchase 'curve', no permits, F.PROVISIONAL_GEAR_PATH) reproduces
//                            docs/economy/5b/curve.json
//   system(opts)             SHARED LIFECYCLE CORE (framework 5b.3; integrate.js 'world'): a fresh lifecycle.js
//                            system per call: canFish = permit held (live biomes only), goals = permits due
//                            by gate level ('progression', item 'permit:<biome>'). opts: { permits, prices,
//                            schedule, priority, expansion, grandfatheredLevel, grandfathered }
//   permitPriority(biome, state, ctx), permitSavings(state, ctx, priority)
//                            the design's due-level purchase order against rods; money kept for the next permit
//   permitSummary(result)    time to afford per permit from an LC.simulate() result that ran system()
//   scheduledRodsBaseline()  VALIDATION ONLY: lifecycle()'s rod purchases and repairs as a lifecycle.js system
//   validateSystem()         system() on the core vs lifecycle() for every archetype and configuration, permit
//                            prices from the core's stage hours, curve.json replication (cached)
//   today()                  today's measured Old Rod $/fish per biome (docs/economy/measurements.json)
//   checks()                 design-target checks (pass/fail; the Mountain Stream value check is
//                            non-blocking and raises a framework change request when it misses)
//   report()                 every key number of docs/economy/5b/world.md, computed (cached), with
//                            ...F.stamp() and report().integration (the system contract + validateSystem()).
const F = require('./framework');
// The shared lifecycle core (framework 5b.3): system() plugs the world into it.
const LC = require('./lifecycle');
// Rod PRICES and UPKEEP only (never a gear source; R3): assembly(t), crate unlock levels, craftRod(
// referenceSet(t)).repairCost / maxDurability; system() for the informational composition in validateSystem().
const rods = require('./rods');
const { FISH, ENV, LUCKY_ITEMS, LUCKY_ITEM_SHARE, drawDistribution } = require('../lib/catalog-model');
const { RARITIES, levelForXp: legacyLevelForXp } = require('../../../src/engine/balance');
const { MAX_DRAW_ATTEMPTS } = require('../../../src/engine/cast');
const CURVE_JSON = require('../../../docs/economy/5b/curve.json');
const MEASUREMENTS = require('../../../docs/economy/measurements.json');

const deepFreeze = (o) => {
	for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
	return Object.freeze(o);
};

// ---------------------------------------------------------------------------------------------
// Design parameters (the only hand-set numbers in this subsystem).
const PARAMS = deepFreeze({
	id: 'world-5b',
	permits: {
		// PRICE RULE (permitPrice): permit(k) = stageShare x E(k), rounded to priceSigDigits significant
		// digits, where E(k) is the expected fish income of the reference player (F.REFERENCE_ARCHETYPE)
		// over the stage before biome k: the hours of play from the previous biome's level to biome k's
		// level (lifecycle() with no permits) x the $/h of the previous biome with the gear typically held
		// there (F.typicalTier), at the reference cadence. Equivalently: H(k) = stageShare x stage hours of
		// the income the player is earning right before the level.
		stageShare: 0.1,
		priceSigDigits: 2,
		// Biomes that never need a permit (the starting biome).
		free: ['Ocean'],
		// A permit can be bought once the player's gate level reaches the biome's level (money can be saved
		// earlier). One-time, account-bound, never expires, never consumed. A permit does NOT require the
		// previous biome's permit (each is an independent milestone).
		requiresPrevious: false,
	},
	// Purchase schedule of the lifecycle model. Goals (the next rod tier from its crate unlock level, the
	// next permit from the previous biome's level) are funded in order of the level they are due at; on a
	// tie the rod goes first ('rod-first', conservative for permits). 'permit-first' is reported as the
	// alternative so the rod delay it would cause is visible.
	schedule: { tieBreak: 'rod-first' },
	// Time-to-afford design target: the permit is owned within this many of the archetype's daily
	// sessions (F.ARCHETYPES[a].minutesPerDay) after the level is reached, with rods bought on schedule
	// and fish income only (no quest/streak cash, no bait).
	targets: { maxDelaySessions: 1, referenceMaxDelaySessions: 0 },
	sensitivity: {
		shareSweep: [0.06, 0.08, 0.1, 0.12, 0.15, 0.2],
		otherSpendShares: [0.15, 0.3],
	},
	// Mountain Stream: the first expansion biome (level F.BIOME_LEVEL['Mountain Stream']). Freshwater
	// fast water; the WEATHER decides the premium tier: one strong Ultra salmon per weather (the three
	// existing salmon keep their weather and stay Ultra; Sunny and Snowy get new ones), so no weather is
	// empty. Every rarity has weak and strong species, like every live biome, so the Old Rod (the safety
	// net) still catches the weak ladder; the premium fish need a crafted rod (strong access).
	// Names are illustrative (final names/art at implementation). Do not name a fish 'Golden Trout' (the
	// broken 'Catch 15 Trout' quest target).
	mountainStream: {
		water: 'freshwater',
		ladder: [
			{ name: 'Brook Minnow', rarity: 'common', quality: 'weak' },
			{ name: 'Stone Sculpin', rarity: 'common', quality: 'weak' },
			{ name: 'Torrent Dace', rarity: 'common', quality: 'strong' },
			{ name: 'Creek Shiner', rarity: 'common', quality: 'strong' },
			{ name: 'Riffle Sucker', rarity: 'uncommon', quality: 'weak' },
			{ name: 'Pebble Darter', rarity: 'uncommon', quality: 'weak' },
			{ name: 'Brook Trout', rarity: 'uncommon', quality: 'strong' },
			{ name: 'Cutthroat Trout', rarity: 'uncommon', quality: 'strong' },
			{ name: 'Alpine Grayling', rarity: 'rare', quality: 'weak' },
			{ name: 'Mountain Whitefish', rarity: 'rare', quality: 'weak' },
			{ name: 'Bull Trout', rarity: 'rare', quality: 'strong' },
			{ name: 'Speckled Char', rarity: 'rare', quality: 'strong' },
			{ name: 'Tiger Trout', rarity: 'rare', quality: 'strong' },
			{ name: 'Highland Grayling', rarity: 'ultra', quality: 'weak' },
			// The weather premium tier: the three existing salmon (unchanged) + two new ones.
			{ name: 'Flashfin Salmon', rarity: 'ultra', quality: 'strong', weather: 'Rainy', existing: true },
			{ name: 'Shrouded Salmon', rarity: 'ultra', quality: 'strong', weather: 'Cloudy', existing: true },
			{ name: 'Zephyr Salmon', rarity: 'ultra', quality: 'strong', weather: 'Windy', existing: true },
			{ name: 'Sunrun Salmon', rarity: 'ultra', quality: 'strong', weather: 'Sunny' },
			{ name: 'Snowmelt Salmon', rarity: 'ultra', quality: 'strong', weather: 'Snowy' },
			{ name: 'Canyon Barbel', rarity: 'giant', quality: 'weak' },
			{ name: 'Headwater Huchen', rarity: 'giant', quality: 'strong' },
			{ name: 'Silverback Grayling', rarity: 'legendary', quality: 'weak' },
			{ name: 'Cascade Taimen', rarity: 'legendary', quality: 'strong' },
			{ name: 'Crystal Char', rarity: 'lucky', quality: 'weak' },
			{ name: 'Aurora Salmon', rarity: 'lucky', quality: 'strong' },
		],
		// BIOME_VALUE rule: Mountain Stream's same-tier income step over Swamp (endgame tier) must not be an
		// outlier of the live ladder: it must lie inside [min, max] of the live same-tier steps after the
		// starter jump (River->Lake ... Coast->Swamp). Otherwise a framework change is requested for the value
		// that puts it at their mean: round(BIOME_VALUE x mean / actual) ($/h is linear in BIOME_VALUE).
		valueRule: 'inside the live late-ladder same-tier step band; request the mean-step value otherwise',
	},
	// Post-60 world (sketch only; nothing is designed or implemented). Levels are indicative placements
	// one 10-level stage apart; valueStep continues the BIOME_VALUE ladder geometrically (computed).
	expansions: [
		{ biome: 'Deep Sea', level: 70, water: 'saltwater', identity: 'heavy tackle; Giant/Legendary-weighted; strong-only premium; the biggest repair burn' },
		{ biome: 'Arctic', level: 80, water: 'saltwater', identity: 'Winter/Snowy-weighted; seasonal exclusives; prestige collection' },
		{ biome: 'Abyss', level: 90, water: 'saltwater', identity: 'endgame, luck-driven; highest value and highest costs' },
	],
	priceSigDigits: 2,
	// Lifecycle safety cap (hours of play) and the post-60 sketch horizon.
	hoursCap: 20000,
	sketchMaxLevel: 100,
});

// ---------------------------------------------------------------------------------------------
// Helpers
const MS = 'Mountain Stream';
const round = (x, d = 2) => Number(x.toFixed(d));
const r0 = (x) => Math.round(x);
function nicePrice(x, digits = PARAMS.priceSigDigits) {
	if (!(x > 0)) return 0;
	const p = 10 ** (Math.floor(Math.log10(x)) - digits + 1);
	return Math.round(x / p) * p;
}
const arch = (a) => (typeof a === 'string' ? F.ARCHETYPES[a] : a);
const sessionH = (a) => arch(a).minutesPerDay / 60;
const prevBiome = (b) => F.BIOME_ORDER[F.BIOME_ORDER.indexOf(b) - 1] ?? null;
const isFree = (b) => PARAMS.permits.free.includes(b);
const PERMIT_BIOMES = F.BIOME_ORDER.filter((b) => !isFree(b));

/** A gear-path step as castOutcome input. Provisional steps carry meanFish only; rods steps carry multiChance. */
const gearStep = (step) => ({ qualities: step.qualities, stats: step.stats, multiChance: step.multiChance ?? F.chanceForMean(step.meanFish) });

// ---------------------------------------------------------------------------------------------
// Species lists (catalog shape) and the draw mirror, so a PROPOSED biome can be evaluated with exactly the
// framework's rules before its fish exist in the catalog.
const qualityOf = (f) => ((f.qualities || []).includes('weak') ? 'weak' : 'strong');
/** A live (or catalog) biome's fish with their framework expected value. */
const liveSpecies = (biome) => FISH.filter((f) => f.biome === biome).map((f) => ({ ...f, value: F.proposedValue(f), existing: true }));
/** Today's Mountain Stream: the three catalog salmon. */
const currentMountainStream = () => liveSpecies(MS);
/**
 * Species factor of a NEW species: the mean F.speciesFactor of the live catalog fish of the same rarity and
 * quality (a new fish is valued like an average existing fish of its rarity and quality, so the proposed
 * biome keeps the live ladder's weak/strong structure).
 */
const factorCache = new Map();
function newSpeciesFactor(rarity, quality) {
	const key = `${rarity}|${quality}`;
	if (!factorCache.has(key)) {
		const group = FISH.filter((f) => F.LIVE_BIOMES.includes(f.biome) && f.rarity === rarity && qualityOf(f) === quality);
		factorCache.set(key, group.length ? group.reduce((s, f) => s + F.speciesFactor(f), 0) / group.length : 1);
	}
	return factorCache.get(key);
}
/** The proposed Mountain Stream ladder. Existing salmon keep F.proposedValue; new species use newSpeciesFactor. */
function ladderSpecies() {
	return PARAMS.mountainStream.ladder.map((s) => {
		const cat = s.existing ? FISH.find((f) => f.name === s.name && f.biome === MS) : null;
		if (s.existing && !cat) throw new Error(`Mountain Stream ladder: existing species ${s.name} not in the catalog`);
		if (cat) return { ...cat, value: F.proposedValue(cat), existing: true };
		return {
			name: s.name, biome: MS, rarity: s.rarity, qualities: [s.quality], weather: s.weather || 'all', season: s.season || 'all', existing: false,
			value: F.BIOME_VALUE[MS] * F.RARITY_VALUE[s.rarity] * F.QUALITY_VALUE[s.quality] * newSpeciesFactor(s.rarity, s.quality),
		};
	});
}

const matches = (qualities, t) => qualities.some((q) => (t.qualities || []).includes(q));
/**
 * Per-draw distribution over a species list: the exact rule of lib/catalog-model.drawDistribution (rarity
 * rolled from the table restricted to rarities that can produce something in the environment, uniform
 * within a rarity, a Lucky roll is a catalog Lucky item `itemShare` of the time: default today's 20%;
 * ladderOutcome passes the framework's F.RULES.luckyItems share, as castOutcome does). `weather` restricts
 * the steady-state environment mix to one weather (renormalised); otherwise ENV weights are used as they are.
 */
function ladderDraw(species, qualities, table, { weather = null, itemShare = LUCKY_ITEM_SHARE } = {}) {
	const envs = weather ? ENV.filter((e) => e.weather === weather) : ENV;
	const norm = weather ? envs.reduce((s, e) => s + e.p, 0) : 1;
	const acc = new Map();
	for (const env of envs) {
		const w = env.p / norm;
		const byRarity = {};
		for (const r of RARITIES) byRarity[r] = species.filter((f) => f.rarity === r && [env.weather, 'all'].includes(f.weather) && [env.season, 'all'].includes(f.season) && matches(qualities, f));
		const accept = {};
		for (const r of RARITIES) {
			const fishOk = byRarity[r].length > 0 ? 1 : 0;
			if (r === 'lucky') {
				const itemOk = LUCKY_ITEMS.length ? LUCKY_ITEMS.filter((i) => matches(qualities, i)).length / LUCKY_ITEMS.length : 0;
				accept[r] = (1 - itemShare) * fishOk + itemShare * itemOk;
			}
			else {
				accept[r] = fishOk;
			}
		}
		const mass = RARITIES.reduce((s, r) => s + (table[r] || 0) * accept[r], 0);
		if (mass <= 0) continue;
		for (const r of RARITIES) {
			const pr = ((table[r] || 0) * accept[r]) / mass;
			if (!pr) continue;
			const fishShare = r === 'lucky' ? ((1 - itemShare) * (byRarity[r].length ? 1 : 0)) / accept[r] : 1;
			for (const f of byRarity[r]) {
				const key = `fish:${f.name}`;
				const cur = acc.get(key) || { kind: 'fish', template: f, rarity: r, p: 0 };
				cur.p += (w * pr * fishShare) / byRarity[r].length;
				acc.set(key, cur);
			}
			if (r === 'lucky' && fishShare < 1) {
				const valid = LUCKY_ITEMS.filter((i) => matches(qualities, i));
				for (const it of valid) {
					const key = `item:${it.name}`;
					const cur = acc.get(key) || { kind: 'item', template: it, rarity: r, p: 0 };
					cur.p += (w * pr * (1 - fishShare)) / valid.length;
					acc.set(key, cur);
				}
			}
		}
	}
	return [...acc.values()];
}

/**
 * Probability that ONE draw lands something in the real engine (cast.js drawTemplates): up to
 * MAX_DRAW_ATTEMPTS rarity re-rolls, then the deterministic fallback (a year-round species matching the
 * cast's qualities); with neither, the cast fails with NO_CATCH. The draw model above renormalises over
 * acceptable rarities, which is exact whenever a fallback exists (every live biome and the proposed
 * ladder) but not for today's 3-salmon Mountain Stream; this gives the engine's real catch odds.
 */
function engineCatch(species, qualities, table, { weather = null } = {}) {
	const envs = weather ? ENV.filter((e) => e.weather === weather) : ENV;
	const norm = envs.reduce((s, e) => s + e.p, 0);
	let p = 0;
	let fishOnly = 0;
	for (const env of envs) {
		const inEnv = species.filter((f) => [env.weather, 'all'].includes(f.weather) && [env.season, 'all'].includes(f.season) && matches(qualities, f));
		const fallback = species.some((f) => f.weather === 'all' && f.season === 'all' && matches(qualities, f));
		let mass = 0;
		let fishMass = 0;
		for (const r of RARITIES) {
			const fishOk = inEnv.some((f) => f.rarity === r) ? 1 : 0;
			const itemOk = r === 'lucky' && LUCKY_ITEMS.length ? LUCKY_ITEMS.filter((i) => matches(qualities, i)).length / LUCKY_ITEMS.length : 0;
			const accept = r === 'lucky' ? 0.8 * fishOk + 0.2 * itemOk : fishOk;
			mass += (table[r] || 0) * accept;
			fishMass += (table[r] || 0) * (r === 'lucky' ? 0.8 * fishOk : fishOk);
		}
		// Some attempt succeeds with probability hit; a successful attempt is a fish with fishMass / mass.
		const hit = 1 - (1 - mass) ** MAX_DRAW_ATTEMPTS;
		const fishShare = mass > 0 ? fishMass / mass : 0;
		p += (env.p / norm) * (fallback ? 1 : hit);
		fishOnly += (env.p / norm) * (hit * fishShare + (fallback ? 1 - hit : 0));
	}
	return { catchProbability: p, fishProbability: fishOnly };
}

/** F.castOutcome over a species list (the framework's aggregation; biome-independent parts come from F). */
function ladderOutcome(species, g, { weather = null } = {}) {
	// Rarity table, multi-catch, cooldown and durability do not depend on the biome: take them from F.
	const ref = F.castOutcome({ ...g, biome: F.BIOME_ORDER[0] });
	const stats = { sellBonus: 0, xpBonus: 0, ...(g.stats || {}) };
	// The Lucky item/fish split follows the framework rule (F.RULES.luckyItems) exactly as castOutcome does.
	const dist = ladderDraw(species, g.qualities || ['weak'], ref.table, { weather, itemShare: ref.luckyItemShare });
	let fishP = 0;
	let value = 0;
	let xpw = 0;
	let catchP = 0;
	const rarity = Object.fromEntries(RARITIES.map((r) => [r, 0]));
	for (const d of dist) {
		catchP += d.p;
		rarity[d.rarity] += d.p;
		xpw += d.p * F.XP_RARITY[d.rarity];
		if (d.kind === 'fish') {
			fishP += d.p;
			value += d.p * d.template.value;
		}
	}
	const sellMult = (1 + stats.sellBonus) * (g.sellMult || 1);
	const xpMult = (1 + stats.xpBonus) * (g.xpMult || 1);
	const fish = ref.fishPerCast;
	return {
		biome: species[0]?.biome ?? null,
		fishPerCast: fish,
		jackpot3plus: ref.jackpot3plus,
		jackpot5: ref.jackpot5,
		valuePerFish: (value * sellMult) / Math.max(fishP, 1e-9),
		valuePerCast: fish * value * sellMult,
		xpPerCast: fish * F.XP_PER_FISH_MEAN * xpw * xpMult,
		cooldownMs: ref.cooldownMs,
		durabilityPerCast: ref.durabilityPerCast,
		rarity,
		catchShare: catchP,
		table: ref.table,
	};
}

/** ladderOutcome equals F.castOutcome on every live biome x gear step x access (max relative error). */
function mirrorParity(path = F.gearPath()) {
	let maxRel = 0;
	let cases = 0;
	const rel = (a, b) => (Math.abs(a - b) / Math.max(Math.abs(b), 1e-12));
	for (const b of [...F.LIVE_BIOMES, MS]) {
		const species = liveSpecies(b);
		for (const step of path) {
			for (const qualities of [['weak'], ['weak', 'strong']]) {
				const g = { ...gearStep(step), qualities };
				const a = ladderOutcome(species, g);
				const f = F.castOutcome({ ...g, biome: b });
				for (const k of ['valuePerCast', 'xpPerCast', 'valuePerFish', 'fishPerCast']) {
					if (b === MS && k === 'valuePerFish' && f.valuePerCast === 0) continue;
					maxRel = Math.max(maxRel, rel(a[k], f[k]));
				}
				cases++;
			}
		}
	}
	// Direct distribution check on one live biome (every species' probability).
	const d1 = ladderDraw(liveSpecies('River'), ['weak', 'strong'], F.castOutcome({ biome: 'River', qualities: ['weak', 'strong'] }).table);
	const d2 = drawDistribution('River', ['weak', 'strong'], F.castOutcome({ biome: 'River', qualities: ['weak', 'strong'] }).table);
	const byKey = new Map(d2.map((d) => [`${d.kind}:${d.template.name}`, d.p]));
	const distMaxAbs = Math.max(...d1.map((d) => Math.abs(d.p - (byKey.get(`${d.kind}:${d.template.name}`) ?? 0))));
	return { cases, maxRelativeError: maxRel, distributionMaxAbsError: distMaxAbs, ok: maxRel < 1e-9 && distMaxAbs < 1e-12 };
}

// ---------------------------------------------------------------------------------------------
// Income per biome and gear (live biomes via F; Mountain Stream via the proposed ladder).
const outcomeCache = new Map();
function biomeOutcome(biome, step, { qualities = null } = {}) {
	const g = { ...gearStep(step), ...(qualities ? { qualities } : {}) };
	const key = `${biome}|${JSON.stringify(g)}`;
	if (!outcomeCache.has(key)) {
		outcomeCache.set(key, biome === MS ? ladderOutcome(ladderSpecies(), g) : F.castOutcome({ ...g, biome }));
	}
	return outcomeCache.get(key);
}
const biomeHourly = (biome, step, overheadS = F.DESIGN_OVERHEAD_S, opts) => F.hourly(biomeOutcome(biome, step, opts), overheadS);

/** $/fish, $/h and XP/h per live biome for every step of a gear path, weak-only and weak+strong access. */
function valueTable(path = F.gearPath(), biomes = F.LIVE_BIOMES) {
	return path.map((step) => ({
		tier: step.tier,
		key: step.key ?? (step.tier === 0 ? 'old' : `t${step.tier}`),
		level: step.level,
		meanFish: step.meanFish,
		qualities: step.qualities,
		biomes: Object.fromEntries(biomes.map((b) => {
			const o = biomeOutcome(b, step);
			const h = biomeHourly(b, step);
			const weak = biomeOutcome(b, step, { qualities: ['weak'] });
			const strong = biomeOutcome(b, step, { qualities: ['weak', 'strong'] });
			return [b, {
				valuePerFish: round(o.valuePerFish, 1), cashPerHour: r0(h.cash), xpPerHour: r0(h.xp), fishPerHour: r0(h.fish),
				weakOnlyValuePerFish: round(weak.valuePerFish, 1), strongAccessValuePerFish: round(strong.valuePerFish, 1),
				weakOnlyCashPerHour: r0(F.hourly(weak).cash), strongAccessCashPerHour: r0(F.hourly(strong).cash),
			}];
		})),
	}));
}

/** Income strictly rises with biome at every tier (both access levels), and never falls with tier in a biome. */
function monotonicity(path = F.gearPath(), biomes = F.LIVE_BIOMES) {
	const failures = [];
	let minBiomeStep = Infinity;
	for (const step of path) {
		for (const access of [['weak'], ['weak', 'strong'], null]) {
			for (let i = 1; i < biomes.length; i++) {
				for (const k of ['valuePerFish', 'valuePerCast']) {
					const a = biomeOutcome(biomes[i - 1], step, { qualities: access })[k];
					const b = biomeOutcome(biomes[i], step, { qualities: access })[k];
					if (k === 'valuePerCast') minBiomeStep = Math.min(minBiomeStep, b / a);
					if (!(b > a)) failures.push(`tier ${step.tier} ${access ? access.join('+') : 'own'} ${k}: ${biomes[i]} ${b.toFixed(1)} <= ${biomes[i - 1]} ${a.toFixed(1)}`);
				}
			}
		}
	}
	let minTierStep = Infinity;
	for (const b of biomes) {
		for (let i = 1; i < path.length; i++) {
			const a = biomeHourly(b, path[i - 1]).cash;
			const c = biomeHourly(b, path[i]).cash;
			minTierStep = Math.min(minTierStep, c / a);
			if (!(c >= a)) failures.push(`${b}: tier ${path[i].tier} $/h ${c.toFixed(0)} < tier ${path[i - 1].tier} ${a.toFixed(0)}`);
		}
	}
	const xp = biomes.flatMap((b) => path.map((s) => biomeOutcome(b, s).xpPerCast / biomeOutcome(biomes[0], s).xpPerCast));
	return { ok: failures.length === 0, failures, minBiomeStepRatio: round(minBiomeStep, 3), minTierStepRatio: round(minTierStep, 3), xpPerCastBiomeSpread: [round(Math.min(...xp), 4), round(Math.max(...xp), 4)] };
}

/** Home income per biome (the tier typically held there) and the step to the next biome. */
function stageLadder(path = F.gearPath(), biomes = [...F.LIVE_BIOMES, MS]) {
	return biomes.map((b, i) => {
		const step = F.typicalTier(b, path);
		const h = biomeHourly(b, step);
		const prev = i > 0 ? biomes[i - 1] : null;
		const prevH = prev ? biomeHourly(prev, F.typicalTier(prev, path)) : null;
		const sameTierPrev = prev ? biomeHourly(prev, step) : null;
		return {
			biome: b, level: F.BIOME_LEVEL[b], tier: step.tier, cashPerHour: r0(h.cash), xpPerHour: r0(h.xp), valuePerFish: round(biomeOutcome(b, step).valuePerFish, 1),
			stepOverPrevHome: prevH ? round(h.cash / prevH.cash, 3) : null,
			stepOverPrevSameTier: sameTierPrev ? round(h.cash / sameTierPrev.cash, 3) : null,
			proposed: b === MS,
		};
	});
}

// ---------------------------------------------------------------------------------------------
// Rod progression costs and upkeep (rods.js prices; never its gear path).
const rodCostCache = new Map();
const rodCost = (tier) => {
	if (!rodCostCache.has(tier)) rodCostCache.set(tier, rods.assembly(tier).expectedCost);
	return rodCostCache.get(tier);
};
const rodUnlock = (tier) => rods.PARAMS.crates.tiers[tier].unlockLevel;
const upkeepCache = new Map();
/** Repair $ per fish of the tier's reference set (0 for the unbreakable Old Rod). */
function upkeepPerFish(tier) {
	if (!tier) return 0;
	if (!upkeepCache.has(tier)) {
		const rod = rods.craftRod(rods.referenceSet(tier));
		upkeepCache.set(tier, rod.repairCost / rod.maxDurability);
	}
	return upkeepCache.get(tier);
}

// ---------------------------------------------------------------------------------------------
// Lifecycle: the curve.js XP stepping (F.LIFECYCLE.stepH, F.DAILY.xpPerLevel x level at each day
// boundary), with money: fish income - rod upkeep - other spend, rods bought on schedule and permits.
const rateCache = new Map();
function rates(biome, step, overheadS) {
	const key = `${biome}|${step.tier}|${JSON.stringify(gearStep(step))}|${overheadS}`;
	if (!rateCache.has(key)) {
		const h = biomeHourly(biome, step, overheadS);
		rateCache.set(key, { ...h, upkeep: upkeepPerFish(step.tier) * h.fish });
	}
	return rateCache.get(key);
}

function lifecycle(archetype, opts = {}) {
	const a = arch(archetype);
	const {
		permits = true,
		prices = null,
		schedule = PARAMS.schedule.tieBreak,
		purchase = 'rods',
		otherSpendShare = 0,
		extraCashPerDay = null,
		maxLevel = F.LIFECYCLE.maxLevel,
		stepH = F.LIFECYCLE.stepH,
		path = F.gearPath(),
		expansion = false,
		grandfathered = [],
	} = opts;
	const biomes = expansion ? F.BIOME_ORDER : F.LIVE_BIOMES;
	const priceOf = permits ? (prices || permitPriceMap()) : null;
	const owned = new Set(permits ? [...PARAMS.permits.free, ...grandfathered] : biomes);
	const queue = biomes.filter((b) => !owned.has(b));
	const dayH = a.minutesPerDay / 60;
	let xp = 0;
	let h = 0;
	let money = 0;
	let idx = 0;
	let progress = 0;
	let saving = 0;
	let lastLevel = 1;
	const levelAt = {};
	const permitLog = {};
	const rodLog = {};
	const totals = { gross: 0, upkeep: 0, rods: 0, permits: 0, other: 0, extra: 0, xpFishing: 0, xpDaily: 0 };
	const band = (L) => [...F.BIOME_ORDER].reverse().find((b) => L >= F.BIOME_LEVEL[b]);
	const stageGross = {};
	const moneyAtLevel = {};
	const affordableAt = {};
	// Ledger totals and money at the end of each play day (validateSystem() compares them with the core).
	const dayEnds = [];
	// Still waiting for a permit or a rod tier that is due by maxLevel (the run continues until bought).
	const pending = () => (priceOf ? queue.some((b) => !owned.has(b) && F.BIOME_LEVEL[b] <= maxLevel) : false)
		|| (purchase === 'rods' && path.slice(idx + 1).some((s) => s.level <= maxLevel));
	while (h < PARAMS.hoursCap) {
		const L = F.levelForXp(xp);
		const cur = path[idx];
		const biome = [...biomes].reverse().find((b) => L >= F.BIOME_LEVEL[b] && owned.has(b));
		const r = rates(biome, cur, a.overheadS);
		const income = r.cash * stepH;
		totals.gross += income;
		totals.upkeep += r.upkeep * stepH;
		totals.other += income * otherSpendShare;
		stageGross[band(L)] = (stageGross[band(L)] || 0) + income;
		money += income * (1 - otherSpendShare) - r.upkeep * stepH;
		const next = path[idx + 1];
		if (purchase === 'curve') {
			// curve.js: save F.PURCHASE.saveHours of current income after reaching the tier's level.
			if (next && L >= next.level) {
				saving += r.cash * stepH;
				if (saving >= r.cash * F.PURCHASE.saveHours) {
					idx++;
					saving = 0;
					rodLog[next.tier] = { equippedH: h, level: L };
				}
			}
		}
		else {
			const goals = [];
			if (next && L >= rodUnlock(next.tier)) goals.push({ kind: 'rod', due: next.level });
			const np = priceOf ? queue.find((b) => !owned.has(b)) : null;
			if (np && L >= F.BIOME_LEVEL[prevBiome(np)]) goals.push({ kind: 'permit', due: F.BIOME_LEVEL[np], biome: np });
			const first = schedule === 'permit-first' ? 'permit' : 'rod';
			goals.sort((x, y) => x.due - y.due || (x.kind === first ? -1 : 1));
			let avail = money;
			for (const g of goals) {
				if (g.kind === 'rod') {
					const pay = Math.max(0, Math.min(avail, rodCost(next.tier) - progress));
					progress += pay;
					money -= pay;
					avail -= pay;
					totals.rods += pay;
				}
				else if (L >= g.due && avail >= priceOf[g.biome]) {
					if (moneyAtLevel[g.biome] === undefined) moneyAtLevel[g.biome] = avail;
					if (affordableAt[g.biome] === undefined) affordableAt[g.biome] = h;
					money -= priceOf[g.biome];
					avail -= priceOf[g.biome];
					totals.permits += priceOf[g.biome];
					owned.add(g.biome);
					permitLog[g.biome] = { boughtH: h, level: L };
				}
				else {
					if (L >= g.due && moneyAtLevel[g.biome] === undefined) moneyAtLevel[g.biome] = avail;
					// First moment the money set aside after earlier-due goals covers the permit.
					if (avail >= priceOf[g.biome] && affordableAt[g.biome] === undefined) affordableAt[g.biome] = h;
					avail -= Math.min(avail, priceOf[g.biome]);
				}
			}
			if (next && progress >= rodCost(next.tier) - 1e-6 && L >= next.level) {
				idx++;
				progress = 0;
				rodLog[next.tier] = { equippedH: h, level: L };
			}
		}
		xp += r.xp * stepH;
		totals.xpFishing += r.xp * stepH;
		const before = h;
		h += stepH;
		if (Math.floor(h / dayH) !== Math.floor(before / dayH)) {
			xp += F.DAILY.xpPerLevel * L;
			totals.xpDaily += F.DAILY.xpPerLevel * L;
			if (extraCashPerDay) {
				const c = extraCashPerDay(L, r, a);
				money += c;
				totals.extra += c;
			}
			dayEnds.push({ day: Math.floor(h / dayH), h, ...totals, money });
		}
		const L2 = F.levelForXp(xp);
		for (let k = lastLevel + 1; k <= L2; k++) levelAt[k] = h;
		lastLevel = Math.max(lastLevel, L2);
		if (L2 >= maxLevel && (purchase === 'curve' || !pending())) break;
	}
	const day = (x) => Math.max(1, Math.ceil(x / dayH - 1e-9));
	const at = (L) => (L <= 1 ? 0 : levelAt[L]);
	const permitsOut = Object.fromEntries(queue.filter((b) => F.BIOME_LEVEL[b] <= maxLevel).map((b) => {
		const reachedH = at(F.BIOME_LEVEL[b]);
		const bought = permitLog[b];
		const delayH = bought && reachedH !== undefined ? Math.max(0, bought.boughtH - reachedH) : null;
		return [b, {
			level: F.BIOME_LEVEL[b], price: priceOf ? priceOf[b] : 0,
			reachedH: reachedH === undefined ? null : round(reachedH), reachedDay: reachedH === undefined ? null : day(reachedH),
			boughtH: bought ? round(bought.boughtH) : null, boughtDay: bought ? day(bought.boughtH) : null,
			delayH: delayH === null ? null : round(delayH), delaySessions: delayH === null ? null : round(delayH / dayH),
			coverageAtLevel: moneyAtLevel[b] === undefined || !priceOf ? null : round(moneyAtLevel[b] / priceOf[b]),
			// Hours of play before the level at which the set-aside money first covered the price (0 = only at
			// the level or later; see delayH).
			affordableBeforeLevelH: affordableAt[b] === undefined || reachedH === undefined ? null : round(Math.max(0, reachedH - affordableAt[b])),
		}];
	}));
	const rodsOut = Object.fromEntries(path.slice(1).filter((s) => s.level <= maxLevel).map((s) => {
		const reachedH = at(s.level);
		const eq = rodLog[s.tier];
		const delayH = eq && reachedH !== undefined ? Math.max(0, eq.equippedH - reachedH) : null;
		return [s.tier, { level: s.level, equippedH: eq ? round(eq.equippedH) : null, delayH: delayH === null ? null : round(delayH), delaySessions: delayH === null ? null : round(delayH / dayH) }];
	}));
	const marks = new Set([...F.LIFECYCLE.milestones, ...Object.values(F.BIOME_LEVEL), ...PARAMS.expansions.map((e) => e.level), PARAMS.sketchMaxLevel]);
	const reached = Object.fromEntries(Object.keys(levelAt).map(Number).filter((L) => marks.has(L)).map((L) => [L, { hours: round(levelAt[L]), day: day(levelAt[L]) }]));
	return { reached, levelAt, permits: permitsOut, rods: rodsOut, totals, stageGross, moneyEnd: money, hours: round(h), dayEnds, log: { permits: permitLog, rods: rodLog } };
}

// ---------------------------------------------------------------------------------------------
// Permits.
const pathKey = (path) => JSON.stringify(path.map((s) => [s.tier, s.level, gearStep(s)]));
const refCache = new Map();
/**
 * The reference player's stages on a gear path (default F.gearPath()): hours of play per stage (lifecycle
 * without permits) and the stage's $/h (previous biome, typical tier there, reference cadence).
 */
function referenceStages({ path = F.gearPath() } = {}) {
	const key = pathKey(path);
	if (!refCache.has(key)) {
		const ref = F.REFERENCE_ARCHETYPE;
		const life = lifecycle(ref, { permits: false, path });
		const at = (L) => (L <= 1 ? 0 : life.levelAt[L]);
		refCache.set(key, Object.fromEntries(PERMIT_BIOMES.map((b) => {
			const pb = prevBiome(b);
			const step = F.typicalTier(pb, path);
			const perHour = biomeHourly(pb, step, F.ARCHETYPES[ref].overheadS).cash;
			const hours = at(F.BIOME_LEVEL[b]) - at(F.BIOME_LEVEL[pb]);
			return [b, {
				biome: b, level: F.BIOME_LEVEL[b], stageBiome: pb, stageLevels: [F.BIOME_LEVEL[pb], F.BIOME_LEVEL[b]], stageTier: step.tier,
				stageHours: hours, stageCashPerHour: perHour, expectedEarnings: hours * perHour,
				lifecycleStageGross: life.stageGross[pb] ?? null,
			}];
		})));
	}
	return refCache.get(key);
}

/** One-time permit price for a biome (0 for a free biome). opts: { share, path } (sensitivity only). */
function permitPrice(biome, { share = PARAMS.permits.stageShare, path = F.gearPath() } = {}) {
	if (isFree(biome)) return 0;
	const s = referenceStages({ path })[biome];
	if (!s) throw new Error(`permitPrice: unknown biome ${biome}`);
	return nicePrice(share * s.expectedEarnings);
}
const priceMapCache = new Map();
function permitPriceMap(share = PARAMS.permits.stageShare, path = F.gearPath()) {
	const key = `${share}|${pathKey(path)}`;
	if (!priceMapCache.has(key)) priceMapCache.set(key, Object.fromEntries(PERMIT_BIOMES.map((b) => [b, permitPrice(b, { share, path })])));
	return priceMapCache.get(key);
}

const lifeCache = new Map();
function cachedLifecycle(a, opts = {}) {
	const key = `${a}|${JSON.stringify(opts)}`;
	if (!lifeCache.has(key)) lifeCache.set(key, lifecycle(a, opts));
	return lifeCache.get(key);
}

/** Per archetype and permit: level reached, permit bought, delay in hours and sessions (lifecycle). */
function timeToAfford({ schedule = PARAMS.schedule.tieBreak, otherSpendShare = 0, share = PARAMS.permits.stageShare, expansion = true } = {}) {
	const prices = permitPriceMap(share);
	return Object.fromEntries(Object.keys(F.ARCHETYPES).map((a) => {
		const life = cachedLifecycle(a, { schedule, otherSpendShare, prices, expansion });
		const noPermit = cachedLifecycle(a, { permits: false, otherSpendShare, expansion });
		const rodDelayVsNoPermits = Object.fromEntries(Object.entries(life.rods).map(([t, v]) => [t, v.equippedH === null || noPermit.rods[t].equippedH === null ? null : round(v.equippedH - noPermit.rods[t].equippedH)]));
		return [a, { sessionHours: round(sessionH(a), 3), permits: life.permits, rods: life.rods, rodDelayVsNoPermits, maxDelaySessions: Math.max(0, ...Object.values(life.permits).map((p) => p.delaySessions ?? Infinity)) }];
	}));
}

/** Every permit: formula inputs, price, payback, time-to-afford (standalone and lifecycle) per archetype. */
function permitTable() {
	const stages = referenceStages();
	const tta = timeToAfford();
	return PERMIT_BIOMES.map((b) => {
		const s = stages[b];
		const price = permitPrice(b);
		// Payback: the extra income the new biome pays with the gear held on reaching its level.
		const gear = F.tierAt(F.BIOME_LEVEL[b]);
		const gain = biomeHourly(b, gear).cash - biomeHourly(s.stageBiome, gear).cash;
		return {
			biome: b,
			level: s.level,
			live: F.LIVE_BIOMES.includes(b),
			stageBiome: s.stageBiome,
			stageTier: s.stageTier,
			stageHoursReference: round(s.stageHours),
			stageCashPerHourReference: r0(s.stageCashPerHour),
			stageEarningsReference: r0(s.expectedEarnings),
			share: PARAMS.permits.stageShare,
			price,
			priceHoursOfStageIncome: round(price / s.stageCashPerHour),
			gainPerHourWithGearAtLevel: r0(gain),
			gearAtLevel: gear.tier,
			paybackHours: round(price / gain),
			standaloneHoursToAfford: Object.fromEntries(Object.keys(F.ARCHETYPES).map((a) => {
				const r = rates(s.stageBiome, F.typicalTier(s.stageBiome), F.ARCHETYPES[a].overheadS);
				const hrs = price / (r.cash - r.upkeep);
				return [a, { hours: round(hrs), sessions: round(hrs / sessionH(a)) }];
			})),
			lifecycle: Object.fromEntries(Object.entries(tta).map(([a, v]) => [a, v.permits[b]])),
		};
	});
}

/** Max permit delay (sessions) per archetype for alternative stage shares. */
function shareSweep() {
	return PARAMS.sensitivity.shareSweep.map((share) => {
		const t = timeToAfford({ share });
		return {
			share,
			prices: permitPriceMap(share),
			maxDelaySessions: Object.fromEntries(Object.entries(t).map(([a, v]) => [a, v.maxDelaySessions])),
			maxRodDelayHoursVsNoPermits: Object.fromEntries(Object.entries(t).map(([a, v]) => [a, Math.max(0, ...Object.values(v.rodDelayVsNoPermits).filter((x) => x !== null))])),
		};
	});
}

/** Lifecycle spend split per archetype to Lv F.LIFECYCLE.maxLevel (Mountain Stream live at its level). */
function budget({ otherSpendShare = 0 } = {}) {
	return Object.fromEntries(Object.keys(F.ARCHETYPES).map((a) => {
		const life = cachedLifecycle(a, { otherSpendShare, prices: permitPriceMap(), expansion: true });
		const t = life.totals;
		return [a, {
			grossFishIncome: r0(t.gross),
			upkeepShare: round(t.upkeep / t.gross, 4),
			rodsShare: round(t.rods / t.gross, 4),
			permitsShare: round(t.permits / t.gross, 4),
			otherShare: round(t.other / t.gross, 4),
			savedShare: round(life.moneyEnd / t.gross, 4),
			moneyAtEnd: r0(life.moneyEnd),
			hours: life.hours,
		}];
	}));
}

// ---------------------------------------------------------------------------------------------
// Access rule and the grandfathering migration (pure; the engine mirrors these).
/** Biomes a player may fish: gate level >= biome level AND (free OR permit owned). */
function accessibleBiomes(level, permits = [], { biomes = F.LIVE_BIOMES } = {}) {
	const owned = new Set((permits || []).map((p) => (typeof p === 'string' ? p : p.biome)));
	return biomes.filter((b) => level >= F.BIOME_LEVEL[b] && (isFree(b) || owned.has(b)));
}
const canFish = (level, permits, biome, opts) => accessibleBiomes(level, permits, opts).includes(biome);

/**
 * Additive migration rule: an account with no `permits` field receives a 'grandfathered' permit for every
 * live non-free biome it already qualifies for (level = max(stored level, today's levelForXp(xp)); levels
 * never drop) plus its current biome. Returns null when the account already has the field (idempotent).
 */
function grandfatheredPermits(user, { now = new Date(0) } = {}) {
	if (user.permits !== undefined) return null;
	const level = Math.max(user.level || 1, legacyLevelForXp(user.xp || 0));
	const current = F.LIVE_BIOMES.find((b) => b.toLowerCase() === String(user.currentBiome || '').toLowerCase());
	const biomes = F.LIVE_BIOMES.filter((b) => !isFree(b) && (level >= F.BIOME_LEVEL[b] || b === current));
	return biomes.map((biome) => ({ biome, source: 'grandfathered', acquiredAt: now, pricePaid: 0 }));
}

/** Legacy accounts used as migration examples (report().migration) and by the grandfathered validation run. */
const MIGRATION_EXAMPLES = deepFreeze([
	{ user: { level: 34, xp: 118000, currentBiome: 'pond' } },
	{ user: { level: 7, xp: 5200, currentBiome: 'ocean' } },
	{ user: { level: 55, xp: 310000, currentBiome: 'swamp' } },
	{ user: { level: 15, xp: 22500, currentBiome: 'lake' } },
	{ user: { level: 12, xp: 15000, currentBiome: 'river', permits: [] } },
]);

// ---------------------------------------------------------------------------------------------
// Shared lifecycle core (framework 5b.3): the world as a lifecycle.js SYSTEM (integrate.js 'world').
//
//   LC.simulate({ archetype, systems: [rods.system(), world.system(), ...] })
//
// Hooks (all per-run state in state.sys.world; system() returns a fresh object each call):
//   init         permits held from the start: the free biome (Ocean) and grandfathered permits
//                (opts.grandfatheredLevel: every live non-free biome at or below that level; opts.grandfathered:
//                biome names or grandfatheredPermits() records)
//   canFish      a LIVE biome whose permit is held (every live biome with opts.permits false). Mountain Stream
//                stays out of the live biomes: the core never fishes it (its proposed ladder is priced by
//                mountainStream() / postFifty(), not by castOutcome)
//   goals        one 'progression' goal per unowned permit whose level the gate level has reached: item
//                'permit:<biome>', cost = its price (permitPriceMap(), or opts.prices), priority from
//                permitPriority() (due-level order against the rod purchases, PARAMS.schedule); a permit the
//                player cannot afford yet blocks the goals after it (the core's default for 'progression')
//   on           'levelUp' of the gate kind (real, or public under the Founder's public gate) records when each
//                biome's level is reached (time to afford: permitSummary())
//   onDayStart / onDayEnd
//                flag purchases made by the core's end-of-day purchase pass
// Ledger: no XP or cash source (the world grants nothing); spend items 'permit:<biome>' ('progression').

const SYSTEM_NAME = 'world';
const permitItem = (biome) => `permit:${biome}`;
const gateKind = (ctx) => (ctx.gate === 'public' ? 'public' : 'real');

/**
 * Purchase priority of a permit goal. The design funds goals in order of the level they are due at, a tie
 * going to the rod ('rod-first', PARAMS.schedule.tieBreak; 'permit-first' is the sensitivity), so a fixed
 * LC.PRIORITY.permit (always before rods) is NOT the design order. The pending rod purchase is the tier after
 * the equipped one (ctx.path[state.equippedTier + 1], bought at LC.PRIORITY.rod): a permit due before it (or
 * tied, under 'permit-first') takes LC.PRIORITY.permit, otherwise it goes right after the rod
 * (LC.PRIORITY.rod + 1). opts.priority replaces this with a fixed priority. Permits keep biome order.
 */
function permitPriority(biome, state, ctx) {
	const w = state.sys[SYSTEM_NAME];
	const order = F.BIOME_ORDER.indexOf(biome) / 100;
	if (w.priority !== null) return w.priority + order;
	const rod = ctx.path[state.equippedTier + 1];
	const due = F.BIOME_LEVEL[biome];
	const rodFirst = Boolean(rod) && (rod.level < due || (rod.level === due && w.schedule !== 'permit-first'));
	return (rodFirst ? LC.PRIORITY.rod + 1 : LC.PRIORITY.permit) + order;
}

/**
 * Money the player keeps aside for the next permit before its level ("money can be saved earlier"): the price
 * of the first unowned permit while the gate level is inside its saving window (the previous biome's level up
 * to its own), when that permit ranks before `priority`. The core has no saving primitive, so a system whose
 * purchases should respect it passes this as their goals' `reserve` (lifecycle() funded goals this way; under
 * 'rod-first' it is 0 for rod purchases).
 */
function permitSavings(state, ctx, priority) {
	const w = state.sys[SYSTEM_NAME];
	if (!w || !w.permits) return 0;
	const b = w.offered.find((x) => !w.held[x]);
	if (!b) return 0;
	const L = ctx.gateLevel();
	if (L >= F.BIOME_LEVEL[b] || L < F.BIOME_LEVEL[prevBiome(b)]) return 0;
	return permitPriority(b, state, ctx) < priority ? w.prices[b] : 0;
}

/**
 * The world as a lifecycle.js system. opts: { permits (default true; false = every live biome open at its
 * level: the reference-stage model), prices (default permitPriceMap()), schedule ('rod-first' |
 * 'permit-first', default PARAMS.schedule.tieBreak), priority (a fixed base priority instead of the due-level
 * order), expansion (also offer the Mountain Stream permit at its level; it is still never fished),
 * grandfatheredLevel, grandfathered }.
 */
function system(opts = {}) {
	const {
		permits = true,
		prices = null,
		schedule = PARAMS.schedule.tieBreak,
		priority = null,
		expansion = false,
		grandfatheredLevel = null,
		grandfathered = [],
	} = opts;
	const offered = (expansion ? F.BIOME_ORDER : F.LIVE_BIOMES).filter((b) => !isFree(b));
	const markReached = (state, ctx) => {
		const w = state.sys[SYSTEM_NAME];
		const L = ctx.gateLevel();
		for (const b of F.BIOME_ORDER) if (!w.reached[b] && L >= F.BIOME_LEVEL[b]) w.reached[b] = { hours: state.h, day: state.day + 1 };
	};
	return {
		name: SYSTEM_NAME,
		init(state, ctx) {
			const listed = new Set((grandfathered || []).map((p) => (typeof p === 'string' ? p : p.biome)));
			const held = Object.fromEntries(PARAMS.permits.free.map((b) => [b, { source: 'free', price: 0 }]));
			for (const b of F.LIVE_BIOMES) {
				if (permits && !isFree(b) && (listed.has(b) || (grandfatheredLevel !== null && grandfatheredLevel >= F.BIOME_LEVEL[b]))) held[b] = { source: 'grandfathered', price: 0 };
			}
			state.sys[SYSTEM_NAME] = {
				permits, schedule, priority, offered,
				prices: permits ? { ...(prices || permitPriceMap()) } : {},
				held, reached: {}, dayEnd: false,
			};
			markReached(state, ctx);
		},
		canFish(biome, state) {
			const w = state.sys[SYSTEM_NAME];
			return F.LIVE_BIOMES.includes(biome) && (!w.permits || Boolean(w.held[biome]));
		},
		goals(state, ctx) {
			const w = state.sys[SYSTEM_NAME];
			if (!w.permits) return [];
			const L = ctx.gateLevel();
			return w.offered.filter((b) => !w.held[b] && L >= F.BIOME_LEVEL[b]).map((b) => ({
				id: permitItem(b),
				item: permitItem(b),
				category: 'progression',
				cost: w.prices[b],
				priority: permitPriority(b, state, ctx),
				buy(st, c) {
					st.sys[SYSTEM_NAME].held[b] = {
						source: 'purchased', price: w.prices[b], hours: st.h,
						// Start of the step whose purchase pass bought it (lifecycle()'s convention); the end-of-day
						// pass buys before the next step, at st.h.
						boughtH: w.dayEnd ? st.h : st.h - c.stepH,
						day: st.day + 1, level: c.gateLevel(), atDayEnd: w.dayEnd,
					};
				},
			}));
		},
		onDayStart(state) {
			state.sys[SYSTEM_NAME].dayEnd = false;
		},
		onDayEnd(state) {
			state.sys[SYSTEM_NAME].dayEnd = true;
		},
		on(event, payload, state, ctx) {
			if (event === 'levelUp' && payload.kind === gateKind(ctx)) markReached(state, ctx);
		},
	};
}

/**
 * Permit time to afford from a lifecycle.js result that ran system(): per offered permit, its price, when the
 * gate level reached its level and when it was held (lifecycle()'s conventions: boughtH is the start of the
 * buying step; delay = max(0, boughtH - reachedH); sessions = delay / the archetype's daily session).
 */
function permitSummary(result) {
	const w = result.sys[SYSTEM_NAME];
	if (!w || !w.permits) return null;
	const dayH = result.archetype.minutesPerDay ? result.archetype.minutesPerDay / 60 : null;
	return Object.fromEntries(w.offered.map((b) => {
		const reached = w.reached[b] || null;
		const held = w.held[b] || null;
		const purchased = held && held.source === 'purchased';
		let delayH = null;
		if (held && !purchased) delayH = 0;
		else if (purchased && reached) delayH = Math.max(0, held.boughtH - reached.hours);
		return [b, {
			level: F.BIOME_LEVEL[b], price: w.prices[b], source: held ? held.source : null,
			reachedH: reached ? round(reached.hours, 4) : null, reachedDay: reached ? reached.day : null,
			boughtH: purchased ? round(held.boughtH, 4) : null, boughtDay: purchased ? held.day : null,
			delayH: delayH === null ? null : round(delayH, 4),
			delaySessions: delayH === null || !dayH ? null : round(delayH / dayH, 4),
		}];
	}));
}

// ---------------------------------------------------------------------------------------------
// Validation baselines: lifecycle()'s other assumptions as lifecycle.js systems. They are NOT designs and only
// validateSystem() uses them; the integrated economy uses rods.system() and the designed daily systems.
const BASELINE_RODS = 'scheduledRods';
/**
 * lifecycle()'s rods: the next tier's expected assembly cost (rodCost) is paid in instalments from its crate
 * unlock level (rodUnlock) at LC.PRIORITY.rod, keeping permitSavings() aside; the tier is equipped once paid
 * and at its level; repairs = upkeepPerFish(tier) x fish ('upkeep'). An instalment is whatever money is left
 * when its turn comes in the purchase pass, so the goal costs 0, never blocks, and buy() spends the instalment.
 * lifecycle()'s step order is kept exactly: its goal list is fixed at the start of a step's purchase pass (so
 * the saving is read in goals(), before an earlier permit of the same pass is bought), and a tier equipped in
 * a step starts the next tier's instalments in the following step.
 */
function scheduledRodsBaseline() {
	const equip = (state, ctx, atH) => {
		const s = state.sys[BASELINE_RODS];
		const next = ctx.path[state.equippedTier + 1];
		if (next && s.progress >= rodCost(next.tier) - 1e-6 && ctx.gateLevel() >= next.level) {
			state.equippedTier++;
			s.progress = 0;
			s.equipped[next.tier] = atH;
			return true;
		}
		return false;
	};
	return {
		name: BASELINE_RODS,
		init(state) {
			state.sys[BASELINE_RODS] = { progress: 0, equipped: {}, dayEnd: false, skipPass: false };
		},
		onDayStart(state) {
			state.sys[BASELINE_RODS].dayEnd = false;
		},
		onDayEnd(state) {
			state.sys[BASELINE_RODS].dayEnd = true;
		},
		onCasts(state, ctx, step) {
			const perFish = upkeepPerFish(step.rates.tier);
			if (perFish > 0) ctx.spend('upkeep', 'rodRepair', perFish * step.fish);
			// A tier paid earlier is equipped in the first step at its level (labelled with the step's start,
			// state.h); lifecycle() equipped it after that step's goals, so the next tier waits one pass.
			if (equip(state, ctx, state.h)) state.sys[BASELINE_RODS].skipPass = true;
		},
		goals(state, ctx) {
			const s = state.sys[BASELINE_RODS];
			if (s.skipPass) {
				s.skipPass = false;
				return [];
			}
			const next = ctx.path[state.equippedTier + 1];
			if (!next || ctx.gateLevel() < rodUnlock(next.tier) || s.progress >= rodCost(next.tier) - 1e-6) return [];
			const item = `rodAssembly:t${next.tier}`;
			const reserve = permitSavings(state, ctx, LC.PRIORITY.rod);
			return [{
				id: item, item, category: 'progression', cost: 0, blocking: false, priority: LC.PRIORITY.rod,
				buy(st, c) {
					const pay = Math.max(0, Math.min(st.money - reserve, rodCost(next.tier) - s.progress));
					if (pay > 0) c.spend('progression', item, pay);
					s.progress += pay;
					equip(st, c, s.dayEnd ? st.h : st.h - c.stepH);
				},
			}];
		},
	};
}

/** lifecycle()'s otherSpendShare: that share of fish income is spent elsewhere as it is earned ('optional'). */
function otherSpendBaseline(share) {
	return {
		name: 'otherSpend',
		onCasts(state, ctx, step) {
			ctx.spend('optional', 'otherSpend', share * step.rates.cash);
		},
	};
}

/** lifecycle.js ledger in lifecycle()'s `totals` terms. */
function coreTotals(ledger) {
	const sum = (o, keep = () => true) => Object.entries(o || {}).filter(([k]) => keep(k)).reduce((s, [, v]) => s + v, 0);
	return {
		gross: ledger.cash.fishing || 0,
		upkeep: sum(ledger.spend.upkeep),
		rods: sum(ledger.spend.progression, (k) => k.startsWith('rodAssembly:')),
		permits: sum(ledger.spend.progression, (k) => k.startsWith('permit:')),
		other: sum(ledger.spend.optional),
		xpFishing: ledger.xp.fishing || 0,
		xpDaily: ledger.xp.daily || 0,
	};
}

/** Records the ledger at the end of each play day, after every other system's onDayEnd (list it last). */
function dayEndRecorder() {
	return {
		name: 'dayEnds',
		init(state) {
			state.sys.dayEnds = [];
		},
		onDayEnd(state) {
			state.sys.dayEnds.push({ day: state.playDay + 1, h: state.h, ...coreTotals(state.ledger), money: state.money });
		},
	};
}

const LEDGER_KEYS = ['gross', 'upkeep', 'rods', 'permits', 'other', 'xpFishing', 'xpDaily', 'money'];
const EVENT_KINDS = ['permitBoughtH', 'rodEquippedH'];
function relDiff(a, b, floor = 0) {
	if (a === null && b === null) return 0;
	if (a === null || b === null) return Infinity;
	const d = Math.abs(a - b);
	return d === 0 ? 0 : d / Math.max(Math.abs(a), Math.abs(b), floor, 1e-12);
}

/**
 * One lifecycle() run against one core run: level hours (every milestone), permit purchase and rod equip
 * times (lifecycle()'s start-of-step labels), and the ledger at the end of each play day on which a milestone
 * was reached (both loops snapshot the same instant: after that day's last step and daily XP). Money is
 * compared relative to the larger balance or the gross fish income so far (a balance near $0 while rods are
 * paid in instalments would otherwise turn a cent into 100%).
 */
function compareRuns(old, core, { kinds = null } = {}) {
	const rows = [];
	const add = (kind, key, a, b, floor = 0) => {
		if (!kinds || kinds.includes(kind.split('.')[0])) rows.push({ kind, key, old: a, core: b, rel: relDiff(a, b, floor) });
	};
	for (const L of F.LIFECYCLE.milestones) add('levelHours', L, old.levelAt[L] ?? null, core.milestones[L]?.hours ?? null);
	const held = core.sys[SYSTEM_NAME]?.held || {};
	for (const [b, p] of Object.entries(old.log.permits)) add('permitBoughtH', b, p.boughtH, held[b]?.boughtH ?? null);
	const equipped = core.sys[BASELINE_RODS]?.equipped || {};
	for (const [t, e] of Object.entries(old.log.rods)) add('rodEquippedH', Number(t), e.equippedH, equipped[t] ?? null);
	const coreDays = new Map((core.sys.dayEnds || []).map((d) => [d.day, d]));
	const days = [...new Set(F.LIFECYCLE.milestones.map((L) => old.dayEnds.find((d) => old.levelAt[L] !== undefined && d.h >= old.levelAt[L] - 1e-9)?.day).filter(Boolean))];
	for (const day of days) {
		const o = old.dayEnds.find((d) => d.day === day);
		const c = coreDays.get(day) || null;
		for (const k of LEDGER_KEYS) add(`ledger.${k}`, day, o[k], c ? c[k] : null, k === 'money' ? o.gross : 0);
	}
	const byKind = {};
	for (const r of rows) byKind[r.kind] = Math.max(byKind[r.kind] ?? 0, r.rel);
	const found = rows.filter((r) => EVENT_KINDS.includes(r.kind) && r.old !== null && r.core !== null);
	const missing = rows.filter((r) => r.rel === Infinity).map((r) => `${r.kind} ${r.key}`);
	const worst = rows.filter((r) => r.rel !== Infinity).reduce((w, r) => (!w || r.rel > w.rel ? r : w), null);
	const maxRel = missing.length ? 1 : Math.max(0, ...rows.map((r) => r.rel));
	return {
		compared: rows.length,
		maxRelativeDifference: maxRel,
		byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v === Infinity ? 'missing' : v])),
		maxEventDifferenceSteps: Math.max(0, ...found.map((r) => Math.round(Math.abs(r.old - r.core) / F.LIFECYCLE.stepH))),
		worst: worst && worst.rel > 0 ? { kind: worst.kind, key: worst.key, old: worst.old, core: worst.core, rel: worst.rel } : null,
		missing,
	};
}

/** The world system on the core with lifecycle()'s baselines (rods on schedule, provisional daily XP). */
function coreRun(archetype, sysOpts, { otherSpendShare = 0, days } = {}) {
	const systems = [scheduledRodsBaseline(), otherSpendShare ? otherSpendBaseline(otherSpendShare) : null, LC.provisionalDaily(), system(sysOpts), dayEndRecorder()];
	return LC.simulate({ archetype, systems, days, stopAtLevel: null });
}

/**
 * validateSystem(): the world SYSTEM on the shared lifecycle core reproduces this module's lifecycle() for every
 * archetype, in every configuration the report uses (design time to afford, permit-first, other spend,
 * grandfathered, no permits), plus the curve.json replication (provisional model) and the permit prices
 * recomputed from the core's reference stage hours. Baselines: scheduledRodsBaseline() (lifecycle()'s rod
 * purchases and repairs), LC.provisionalDaily() (its daily XP), otherSpendBaseline() (its other-spend share).
 */
function computeValidation() {
	const prices = permitPriceMap();
	const gfLevel = MIGRATION_EXAMPLES[0].user.level;
	const gfBiomes = F.LIVE_BIOMES.filter((b) => !isFree(b) && gfLevel >= F.BIOME_LEVEL[b]);
	const share = PARAMS.sensitivity.otherSpendShares[0];
	const design = (o = {}) => ({ schedule: PARAMS.schedule.tieBreak, otherSpendShare: 0, prices, expansion: true, ...o });
	const configs = [
		{ key: 'design', note: 'timeToAfford() / permitTable() / checks(): rod-first, Mountain Stream permit offered at its level', old: design(), sys: { prices, expansion: true } },
		{ key: 'permitFirst', note: 'scheduleComparison: permit-first (a not-yet-due permit reserves its price ahead of the rod)', old: design({ schedule: 'permit-first' }), sys: { schedule: 'permit-first', prices, expansion: true } },
		{ key: `otherSpend${share}`, note: `otherSpend: ${share} of fish income spent elsewhere (non-zero permit delays for casual)`, old: design({ otherSpendShare: share }), sys: { prices, expansion: true }, otherSpendShare: share },
		{ key: 'grandfathered', note: `a legacy Lv ${gfLevel} account starting with ${gfBiomes.join(', ')} (grandfatheredLevel)`, old: design({ grandfathered: gfBiomes }), sys: { grandfatheredLevel: gfLevel, prices, expansion: true } },
		{ key: 'noPermits', note: 'referenceStages(): every live biome open at its level (the permit price basis)', old: { permits: false }, sys: { permits: false } },
	];
	const archetypes = Object.keys(F.ARCHETYPES);
	const runs = {};
	const results = Object.fromEntries(configs.map((cfg) => [cfg.key, {
		note: cfg.note,
		archetypes: Object.fromEntries(archetypes.map((a) => {
			const old = cachedLifecycle(a, cfg.old);
			const dayH = sessionH(a);
			const core = coreRun(a, cfg.sys, { otherSpendShare: cfg.otherSpendShare || 0, days: Math.ceil(old.hours / dayH) + 1 });
			runs[`${cfg.key}|${a}`] = { old, core };
			return [a, compareRuns(old, core)];
		})),
	}]));
	for (const r of Object.values(results)) r.maxRelativeDifference = Math.max(...Object.values(r.archetypes).map((x) => x.maxRelativeDifference));

	// Time to afford through the core (design configuration) against lifecycle()'s (the checks() target).
	const timeToAffordCore = Object.fromEntries(archetypes.map((a) => {
		const { old, core } = runs[`design|${a}`];
		const summary = permitSummary(core);
		return [a, {
			maxDelaySessions: { core: Math.max(0, ...Object.values(summary).map((p) => p.delaySessions ?? Infinity)), old: Math.max(0, ...Object.values(old.permits).map((p) => p.delaySessions ?? Infinity)) },
			delayH: Object.fromEntries(Object.entries(summary).map(([b, p]) => [b, { core: p.delayH, old: old.permits[b]?.delayH ?? null }])),
			boughtAtDayEnd: Object.entries(core.sys[SYSTEM_NAME].held).filter(([, p]) => p.atDayEnd).map(([b]) => b),
		}];
	}));

	// Permit prices recomputed from the core's reference stage hours (regular, no permits).
	const ref = runs[`noPermits|${F.REFERENCE_ARCHETYPE}`].core;
	const at = (L) => (L <= 1 ? 0 : ref.milestones[L]?.hours ?? null);
	const pricesFromCore = Object.fromEntries(PERMIT_BIOMES.map((b) => {
		const pb = prevBiome(b);
		const perHour = biomeHourly(pb, F.typicalTier(pb), F.ARCHETYPES[F.REFERENCE_ARCHETYPE].overheadS).cash;
		return [b, { lifecycle: prices[b], core: nicePrice(PARAMS.permits.stageShare * (at(F.BIOME_LEVEL[b]) - at(F.BIOME_LEVEL[pb])) * perHour) }];
	}));

	// curve.json replication on the core: provisional path, LC.provisionalRods + LC.provisionalDaily, no permits.
	const provOld = lifecycle(F.REFERENCE_ARCHETYPE, { permits: false, purchase: 'curve', path: F.PROVISIONAL_GEAR_PATH });
	const provCore = LC.simulate({ archetype: F.REFERENCE_ARCHETYPE, systems: [LC.provisionalRods(), LC.provisionalDaily(), system({ permits: false })], gearPath: F.PROVISIONAL_GEAR_PATH });
	const expected = CURVE_JSON.best.regular;
	const replication = {
		vsLifecycle: compareRuns(provOld, provCore, { kinds: ['levelHours'] }),
		vsCurveJson: {
			expected,
			core: Object.fromEntries(Object.keys(expected).map((L) => [L, provCore.milestones[L] ? round(provCore.milestones[L].hours) : null])),
			maxAbsHours: Math.max(...Object.keys(expected).map((L) => Math.abs((provCore.milestones[L]?.hours ?? Infinity) - expected[L]))),
		},
	};
	replication.vsCurveJson.ok = replication.vsCurveJson.maxAbsHours <= 0.011;

	const maxRel = Math.max(replication.vsLifecycle.maxRelativeDifference, ...Object.values(results).map((r) => r.maxRelativeDifference));
	const pricesIdentical = Object.values(pricesFromCore).every((p) => p.core === p.lifecycle);
	return {
		method: 'LC.simulate with world.system() + validation baselines (scheduledRodsBaseline: lifecycle()\'s rods on schedule and repairs; LC.provisionalDaily: its daily XP; otherSpendBaseline) vs world.lifecycle(), every archetype, run to the end of lifecycle()\'s last day; compared: hours to every milestone level, permit purchase and rod equip times (start-of-step labels), and the ledger (gross fish $, repairs, rods, permits, other spend, fishing/daily XP, money) at the end of each play day that reached a milestone',
		maxRelativeDifference: maxRel,
		ok: maxRel < 0.005 && pricesIdentical && replication.vsCurveJson.ok,
		configs: results,
		timeToAffordCore,
		pricesFromCore: { identical: pricesIdentical, prices: pricesFromCore },
		replication,
		conventions: [
			'Hours, not days: the core counts a level reached on a day\'s last step in that day (ceil(h / dayH) counted the next).',
			'Purchases: the core runs a purchase pass after every step (as lifecycle() did, after the step\'s income) and one more at the end of each day (after the daily XP); a permit or instalment that pass makes is bought before the next day\'s first step instead of after it. lifecycle() labels a purchase with the start of its step, so the times agree; only that one step of income differs (the core rule is the right one: the player holds the money and level at the end of the session).',
			'The core snapshots a milestone inside the step (before the day-end daily XP), lifecycle() after the daily XP: ledgers are compared at day ends, where both loops snapshot the same instant.',
		],
		withRodsSystem: withRodsSystem(prices),
	};
}

let validationCache = null;
/** validateSystem() (see computeValidation), computed once per process like report(). */
function validateSystem() {
	if (!validationCache) validationCache = computeValidation();
	return validationCache;
}

/** report().integration: the world SYSTEM's contract (framework 5b.3) and its validation. */
function integrationSection() {
	return {
		framework: `${F.FRAMEWORK_VERSION} shared lifecycle core (lifecycle.js); integrate.js system '${SYSTEM_NAME}' (REFERENCE core loop)`,
		system: {
			options: {
				permits: 'default true; false = every live biome open at its level (the reference-stage model behind permitPrice())',
				prices: 'default permitPriceMap()',
				schedule: `'rod-first' | 'permit-first' (default PARAMS.schedule.tieBreak '${PARAMS.schedule.tieBreak}')`,
				priority: 'a fixed base priority instead of the due-level order (sensitivity)',
				expansion: 'also offer the Mountain Stream permit at its level (it is still never fished)',
				grandfatheredLevel: 'permits held from the start for every live non-free biome at or below this level',
				grandfathered: 'biome names or grandfatheredPermits(user) records held from the start',
			},
			hooks: {
				init: 'state.sys.world: permits held (free Ocean, grandfathered), prices, levels reached, purchases',
				canFish: 'a live biome whose permit is held; Mountain Stream stays out of the live biomes (never fished)',
				goals: `one 'progression' goal per unowned permit whose level the gate level has reached (item 'permit:<biome>'); priority LC.PRIORITY.permit (${LC.PRIORITY.permit}) when due before the pending rod tier (or tied under 'permit-first'), else LC.PRIORITY.rod + 1 (${LC.PRIORITY.rod + 1}): the design's due-level order, rod first on a tie; blocking while unaffordable`,
				on: '\'levelUp\' of the gate kind (public under the Founder\'s public gate) records when each biome level is reached',
				onDayStart: 'clears the end-of-day purchase flag',
				onDayEnd: 'flags purchases made by the core\'s end-of-day purchase pass',
			},
			ledger: {
				xpSources: [], cashSources: [],
				spend: { progression: F.LIVE_BIOMES.filter((b) => !isFree(b)).map(permitItem), progressionWithExpansion: [permitItem(MS)] },
			},
			helpers: {
				permitSummary: 'time to afford per permit from a simulate() result (reached, bought, delay in hours and sessions)',
				permitSavings: 'money kept aside for the next permit ahead of a goal priority, for a system that honours permit savings through `reserve` (0 for rods under rod-first)',
			},
		},
		validation: validateSystem(),
	};
}

/**
 * Informational (not part of the validation): the integration configuration, system() (live permits) with
 * rods.system() instead of the baseline, provisional daily XP, to Lv F.LIFECYCLE.maxLevel.
 */
function withRodsSystem(prices) {
	if (typeof rods.system !== 'function') return { skipped: 'rods.system() is not exported yet' };
	try {
		return Object.fromEntries(Object.keys(F.ARCHETYPES).map((a) => {
			const r = LC.simulate({ archetype: a, systems: [rods.system(), LC.provisionalDaily(), system({ prices })] });
			const summary = permitSummary(r);
			const reached = Object.entries(summary).filter(([, p]) => p.reachedH !== null);
			return [a, {
				maxDelaySessions: Math.max(0, ...reached.filter(([, p]) => p.delaySessions !== null).map(([, p]) => p.delaySessions)),
				notBought: reached.filter(([, p]) => p.delayH === null).map(([b]) => b),
				permits: summary,
			}];
		}));
	}
	catch (e) {
		return { error: e.message };
	}
}

// ---------------------------------------------------------------------------------------------
// Mountain Stream and the post-50 world.
function mountainStream(path = F.gearPath()) {
	const species = ladderSpecies();
	const counts = {};
	for (const s of species) {
		counts[s.rarity] = counts[s.rarity] || { total: 0, weak: 0, strong: 0, weatherExclusive: 0 };
		counts[s.rarity].total++;
		counts[s.rarity][qualityOf(s)]++;
		if (s.weather !== 'all') counts[s.rarity].weatherExclusive++;
	}
	const top = path[path.length - 1];
	const weathers = [...new Set(ENV.map((e) => e.weather))];
	const perWeather = weathers.map((w) => {
		const o = ladderOutcome(species, gearStep(top), { weather: w });
		const premium = species.filter((s) => s.rarity === 'ultra' && s.weather === w).map((s) => s.name);
		const c = engineCatch(species, gearStep(top).qualities, o.table, { weather: w });
		return { weather: w, envShare: round(ENV.filter((e) => e.weather === w).reduce((s, e) => s + e.p, 0), 4), premiumUltra: premium, valuePerFish: round(o.valuePerFish, 1), cashPerHour: r0(F.hourly(o).cash), catchProbability: round(c.catchProbability, 4) };
	});
	const byTier = path.map((step) => {
		const ms = biomeOutcome(MS, step);
		const sw = biomeOutcome('Swamp', step);
		return {
			tier: step.tier, valuePerFish: round(ms.valuePerFish, 1), cashPerHour: r0(F.hourly(ms).cash), xpPerHour: r0(F.hourly(ms).xp),
			weakOnlyValuePerFish: round(biomeOutcome(MS, step, { qualities: ['weak'] }).valuePerFish, 1),
			stepOverSwamp: round(ms.valuePerCast / sw.valuePerCast, 3),
		};
	});
	// Implied BIOME_VALUE: $/h scales linearly with BIOME_VALUE (every species' value is proportional to it),
	// so the value that puts Mountain Stream's same-tier step over Swamp at the mean live late-ladder step
	// (River->Lake ... Coast->Swamp, at the endgame tier) is BIOME_VALUE x target / actual.
	const live = F.LIVE_BIOMES;
	const lateSteps = live.slice(2).map((b, i) => biomeOutcome(b, top).valuePerCast / biomeOutcome(live[i + 1], top).valuePerCast);
	const target = lateSteps.reduce((s, x) => s + x, 0) / lateSteps.length;
	const actual = biomeOutcome(MS, top).valuePerCast / biomeOutcome('Swamp', top).valuePerCast;
	const implied = (F.BIOME_VALUE[MS] * target) / actual;
	const inBand = actual >= Math.min(...lateSteps) && actual <= Math.max(...lateSteps);
	const requested = inBand ? null : Math.round(implied);
	// Every Mountain Stream value is proportional to its BIOME_VALUE, so figures at the requested value are
	// the framework figures scaled by requested / current (shown for the decision; F stays authoritative).
	const scale = requested ? requested / F.BIOME_VALUE[MS] : 1;
	const current = currentMountainStream();
	const table = F.castOutcome({ ...gearStep(top), biome: F.BIOME_ORDER[0] }).table;
	const curWeak = engineCatch(current, ['weak'], F.castOutcome({ ...gearStep(path[0]), biome: F.BIOME_ORDER[0] }).table);
	const curStrong = engineCatch(current, gearStep(top).qualities, table);
	const curByWeather = Object.fromEntries(weathers.map((w) => [w, round(engineCatch(current, gearStep(top).qualities, table, { weather: w }).fishProbability, 4)]));
	return {
		level: F.BIOME_LEVEL[MS],
		biomeValue: F.BIOME_VALUE[MS],
		speciesTotal: species.length,
		counts,
		newSpecies: species.filter((s) => !s.existing).length,
		keptSpecies: species.filter((s) => s.existing).map((s) => `${s.name} (${s.rarity}, ${s.weather})`),
		perWeatherAtTopTier: perWeather,
		byTier,
		valueCheck: {
			lateLiveSameTierSteps: lateSteps.map((x) => round(x, 3)),
			targetStep: round(target, 3),
			actualStep: round(actual, 3),
			band: [round(Math.min(...lateSteps), 3), round(Math.max(...lateSteps), 3)],
			inBand,
			impliedBiomeValue: round(implied, 1),
			requestedBiomeValue: requested,
			atRequested: requested ? {
				stepOverSwamp: round(actual * scale, 3),
				topTierCashPerHour: r0(F.hourly(biomeOutcome(MS, top)).cash * scale),
				topTierValuePerFish: round(biomeOutcome(MS, top).valuePerFish * scale, 1),
				homeStepOverSwampTier4: round((F.hourly(biomeOutcome(MS, top)).cash * scale) / F.hourly(biomeOutcome('Swamp', F.typicalTier('Swamp', path))).cash, 3),
			} : null,
		},
		// Today's biome in the real engine (one draw): Old Rod casts land nothing but the rare Lucky item;
		// endgame-tier casts land a salmon only in its weather, and only when a re-roll hits Ultra.
		today: {
			species: current.map((s) => `${s.name} (${s.rarity}, ${qualityOf(s)}, ${s.weather})`),
			oldRodFishProbability: round(curWeak.fishProbability, 6),
			oldRodCatchProbability: round(curWeak.catchProbability, 6),
			topTierFishProbability: round(curStrong.fishProbability, 4),
			topTierFishProbabilityByWeather: curByWeather,
			proposedFishProbability: round(engineCatch(species, gearStep(top).qualities, table).fishProbability, 4),
		},
	};
}

/**
 * The post-50 curve: Swamp's level (50) -> Mountain Stream's level (60) per archetype, per-level hours around
 * it, what the reference player buys in that stage, and post-60 pacing with Mountain Stream live and no
 * further gear tier (a sketch up to PARAMS.sketchMaxLevel; an upper bound on post-60 stage lengths).
 */
function postFifty() {
	const prices = permitPriceMap();
	const lastLive = F.LIVE_BIOMES[F.LIVE_BIOMES.length - 1];
	const from = F.BIOME_LEVEL[lastLive];
	const marks = [from, F.BIOME_LEVEL[MS], ...PARAMS.expansions.map((e) => e.level), PARAMS.sketchMaxLevel];
	const sketch = Object.fromEntries(Object.keys(F.ARCHETYPES).map((a) => [a, cachedLifecycle(a, { prices, expansion: true, maxLevel: PARAMS.sketchMaxLevel })]));
	const at = (life, L) => (L <= 1 ? 0 : life.levelAt[L]);
	const archetypes = Object.fromEntries(Object.entries(sketch).map(([a, life]) => {
		const dayH = sessionH(a);
		const reach = Object.fromEntries(marks.slice(0, 2).map((L) => [`L${L}`, { hours: round(at(life, L)), day: Math.ceil(at(life, L) / dayH) }]));
		const spans = Object.fromEntries(marks.slice(1).map((y, i) => {
			const x = marks[i];
			return [`L${x}-L${y}`, { hours: round(at(life, y) - at(life, x)), days: round((at(life, y) - at(life, x)) / dayH, 1) }];
		}));
		return [a, { reach, spans }];
	}));
	const reg = sketch[F.REFERENCE_ARCHETYPE];
	const perLevel = {};
	for (let L = from - 5; L <= F.BIOME_LEVEL[MS] + 10; L++) perLevel[L] = round(at(reg, L) - at(reg, L - 1), 3);
	// The stage before Mountain Stream for the reference player: what they buy while fishing the last live
	// biome with its typical tier.
	const stage = referenceStages()[MS];
	const endTier = F.gearPath().find((s) => s.level === F.BIOME_LEVEL[MS]);
	const endCost = endTier ? rodCost(endTier.tier) : null;
	// Stage-length growth: hours per 10-level stage (biome levels, then the sketch placements).
	const levels = [...new Set([...Object.values(F.BIOME_LEVEL).filter((L) => L > 0), ...PARAMS.expansions.map((e) => e.level), PARAMS.sketchMaxLevel])].sort((x, y) => x - y);
	const stages = levels.map((L, i) => {
		const lo = i ? levels[i - 1] : 0;
		return { stage: `${lo}-${L}`, hours: round(at(reg, L) - at(reg, lo)) };
	}).map((x, i, arr) => ({ ...x, ratio: i ? round(x.hours / arr[i - 1].hours, 3) : null }));
	const path = F.gearPath();
	const top = path[path.length - 1];
	const prevTop = path[path.length - 2];
	const xpHour = (step) => biomeHourly(MS, step, F.ARCHETYPES[F.REFERENCE_ARCHETYPE].overheadS).xp;
	return {
		curve: { base: F.CURVE.base, quartic: F.CURVE.quartic, xpAt: Object.fromEntries(marks.map((L) => [L, r0(F.xpForLevel(L))])) },
		marks,
		archetypes,
		perLevelHoursReference: perLevel,
		stageHoursReference: stages,
		stageBeforeMountainStream: {
			biome: stage.stageBiome, tier: stage.stageTier, hours: round(stage.stageHours), cashPerHour: r0(stage.stageCashPerHour), earnings: r0(stage.expectedEarnings),
			endgameTier: endTier ? endTier.tier : null,
			endgameTierAssembly: endCost === null ? null : r0(endCost), endgameTierShareOfStage: endCost === null ? null : round(endCost / stage.expectedEarnings, 4),
			permit: permitPrice(MS), permitShareOfStage: round(permitPrice(MS) / stage.expectedEarnings, 4),
		},
		// XP/h at the reference cadence: the endgame tier over the tier before it (no tier beyond it is modelled).
		xpPerHourReference: { [`tier${prevTop.tier}`]: r0(xpHour(prevTop)), [`tier${top.tier}`]: r0(xpHour(top)), gain: round(xpHour(top) / xpHour(prevTop), 3) },
	};
}

/** Deep Sea / Arctic / Abyss: indicative placement, value continuation and permit (not designed). */
function expansionSketch() {
	const bv = F.BIOME_VALUE;
	const live = [...F.LIVE_BIOMES, MS];
	// Geometric continuation of the last three BIOME_VALUE steps.
	const k = 3;
	const step = (bv[live[live.length - 1]] / bv[live[live.length - 1 - k]]) ** (1 / k);
	const reg = cachedLifecycle(F.REFERENCE_ARCHETYPE, { prices: permitPriceMap(), expansion: true, maxLevel: PARAMS.sketchMaxLevel });
	let prevValue = bv[MS];
	let prevLevel = F.BIOME_LEVEL[MS];
	const top = F.gearPath()[F.gearPath().length - 1];
	const msRate = biomeHourly(MS, top).cash;
	return {
		valueStep: round(step, 3),
		biomes: PARAMS.expansions.map((e) => {
			const value = prevValue * step;
			const hours = reg.levelAt[e.level] - reg.levelAt[prevLevel];
			// Indicative permit: same rule, the stage before it fished in the previous biome with the endgame tier.
			const prevRate = msRate * (prevValue / bv[MS]);
			const out = { ...e, indicativeBiomeValue: r0(value), stageHoursReference: round(hours), indicativePermit: nicePrice(PARAMS.permits.stageShare * hours * prevRate) };
			prevValue = value;
			prevLevel = e.level;
			return out;
		}),
	};
}

/**
 * lifecycle(purchase 'curve', no permits) reproduces docs/economy/5b/curve.json (regular player). curve.json
 * is the provisional-model fit, so this runs on F.PROVISIONAL_GEAR_PATH (F.gearPath() is the rods path
 * since the 5b.3 R3 cutover).
 */
function replicationCheck() {
	const life = lifecycle(F.REFERENCE_ARCHETYPE, { permits: false, purchase: 'curve', path: F.PROVISIONAL_GEAR_PATH });
	const expected = CURVE_JSON.best.regular;
	const got = Object.fromEntries(Object.keys(expected).map((L) => [L, life.reached[L]?.hours ?? null]));
	const maxAbs = Math.max(...Object.keys(expected).map((L) => Math.abs((got[L] ?? Infinity) - expected[L])));
	return { expected, got, maxAbsHours: round(maxAbs, 4), ok: maxAbs <= 0.011 && CURVE_JSON.chosen === F.CURVE.quartic };
}

/** Today's measured (real engine, BALANCE_VERSION 3.2.0) Old Rod $/fish per biome. */
function today() {
	return Object.fromEntries(F.LIVE_BIOMES.map((b) => {
		const m = MEASUREMENTS.results.find((x) => x.key === `${b.toLowerCase()}|Old Rod|-|normal`);
		return [b, m ? round(m.valueBase / m.fishUnits, 1) : null];
	}));
}

/** Target checks (pass/fail). */
function checks() {
	const tta = timeToAfford();
	const ref = F.REFERENCE_ARCHETYPE;
	const out = [];
	for (const [a, v] of Object.entries(tta)) {
		const limit = a === ref ? PARAMS.targets.referenceMaxDelaySessions : PARAMS.targets.maxDelaySessions;
		out.push({ check: `${a}: every permit owned within ${limit} session(s) of reaching its level (rods on schedule, fish income only)`, value: v.maxDelaySessions, ok: v.maxDelaySessions <= limit + 1e-9 });
		const rodDelay = Math.max(0, ...Object.values(v.rodDelayVsNoPermits).filter((x) => x !== null));
		out.push({ check: `${a}: permits delay no rod tier by more than one session`, value: rodDelay, ok: rodDelay <= sessionH(a) + 1e-9 });
	}
	const mono = monotonicity();
	out.push({ check: 'income rises with biome at every tier and access level (F.gearPath())', value: mono.minBiomeStepRatio, ok: mono.ok });
	const prices = PERMIT_BIOMES.map((b) => permitPrice(b));
	out.push({ check: 'permit prices rise with biome level', value: prices, ok: prices.every((p, i) => i === 0 || p > prices[i - 1]) });
	const ms = mountainStream();
	out.push({ check: 'Mountain Stream same-tier step over Swamp inside the live late-ladder band (non-blocking: a miss raises a BIOME_VALUE framework change request)', value: { step: ms.valueCheck.actualStep, band: ms.valueCheck.band, requested: ms.valueCheck.requestedBiomeValue }, ok: ms.valueCheck.inBand, blocking: false });
	out.push({ check: 'Mountain Stream: every weather has a premium Ultra and a catch', value: ms.perWeatherAtTopTier.map((w) => w.premiumUltra.length), ok: ms.perWeatherAtTopTier.every((w) => w.premiumUltra.length === 1 && w.catchProbability > 0.999) });
	const parity = mirrorParity();
	out.push({ check: 'ladder mirror equals F.castOutcome on every live biome', value: parity.maxRelativeError, ok: parity.ok });
	const rep = replicationCheck();
	out.push({ check: 'lifecycle reproduces curve.json (regular, curve purchase model)', value: rep.maxAbsHours, ok: rep.ok });
	const v = validateSystem();
	out.push({ check: 'world.system() on the shared lifecycle core reproduces lifecycle() (every archetype and configuration, < 0.5%), permit prices and curve.json', value: v.maxRelativeDifference, ok: v.ok });
	return out;
}

// ---------------------------------------------------------------------------------------------
function questCashSensitivity() {
	// Sensitivity only: quests.js is an in-flight design. Its cash reaches the player once per day on top of
	// fish income (XP model unchanged). Skipped with a note if its entry point is unavailable.
	let quests;
	try {
		quests = require('./quests');
	}
	catch (e) {
		return { skipped: `quests.js not loadable: ${e.message}` };
	}
	if (typeof quests.questIncome !== 'function') return { skipped: 'quests.questIncome() not exported' };
	const prices = permitPriceMap();
	const extraCashPerDay = (L, r, a) => {
		const dayH = a.minutesPerDay / 60;
		return quests.questIncome(L, r.fish * dayH, dayH).cash;
	};
	return Object.fromEntries([0, ...PARAMS.sensitivity.otherSpendShares].map((otherSpendShare) => [otherSpendShare, Object.fromEntries(Object.keys(F.ARCHETYPES).map((a) => {
		const life = lifecycle(a, { prices, expansion: true, extraCashPerDay, otherSpendShare });
		return [a, {
			maxDelaySessions: Math.max(0, ...Object.values(life.permits).map((p) => p.delaySessions ?? Infinity)),
			questCashShareOfIncome: round(life.totals.extra / (life.totals.extra + life.totals.gross), 4),
			minCoverageAtLevel: Math.min(...Object.values(life.permits).map((p) => p.coverageAtLevel ?? Infinity)),
		}];
	}))]));
}

function buildReport() {
	const path = F.gearPath();
	const table = permitTable();
	const sched = Object.fromEntries(['rod-first', 'permit-first'].map((s) => [s, timeToAfford({ schedule: s })]));
	const other = Object.fromEntries(PARAMS.sensitivity.otherSpendShares.map((o) => [o, Object.fromEntries(Object.entries(timeToAfford({ otherSpendShare: o })).map(([a, v]) => [a, { maxDelaySessions: v.maxDelaySessions, delaysH: Object.fromEntries(Object.entries(v.permits).map(([b, p]) => [b, p.delayH])), rodDelayVsNoPermitsH: v.rodDelayVsNoPermits }]))]));
	const noPermitRef = cachedLifecycle(F.REFERENCE_ARCHETYPE, { permits: false });
	const withPermitRef = cachedLifecycle(F.REFERENCE_ARCHETYPE, { prices: permitPriceMap(), expansion: true });
	return {
		...F.stamp(),
		gearPathSource: F.GEAR_PATH_SOURCE,
		method: `exact analytic model (framework ${F.FRAMEWORK_VERSION}); income from F.gearPath() (${F.GEAR_PATH_SOURCE}); curve.js XP stepping (daily ${F.DAILY.xpPerLevel} x level); rods bought from rods.assembly() expected costs from their crate unlock level; upkeep = rods repair $/fish; permits funded by due level (${PARAMS.schedule.tieBreak} on ties); fish income only`,
		params: PARAMS,
		today: { oldRodValuePerFish: today() },
		valueModel: {
			table: valueTable(path),
			monotonicity: monotonicity(path),
			stageLadder: stageLadder(path),
			oldRodValuePerFish: Object.fromEntries(F.LIVE_BIOMES.map((b) => [b, round(biomeOutcome(b, path[0]).valuePerFish, 1)])),
		},
		permits: {
			formula: `permit(k) = nicePrice(${PARAMS.permits.stageShare} x stageHours(ref, level(k-1) -> level(k)) x $/h(biome k-1, F.typicalTier(k-1), ref cadence))`,
			table,
			referenceStages: referenceStages(),
			scheduleComparison: Object.fromEntries(Object.entries(sched).map(([s, v]) => [s, Object.fromEntries(Object.entries(v).map(([a, x]) => [a, { maxDelaySessions: x.maxDelaySessions, rodDelayVsNoPermits: x.rodDelayVsNoPermits }]))])),
			otherSpend: other,
			questCash: questCashSensitivity(),
			shareSweep: shareSweep(),
			levelTimesWithVsWithoutPermits: Object.fromEntries(F.LIFECYCLE.milestones.map((L) => [L, { without: noPermitRef.reached[L]?.hours ?? null, with: withPermitRef.reached[L]?.hours ?? null }])),
		},
		budget: budget(),
		migration: {
			examples: MIGRATION_EXAMPLES.map((x) => {
				const g = grandfatheredPermits(x.user);
				return { ...x, grandfathered: g === null ? 'already migrated (no change)' : g.map((p) => p.biome) };
			}),
			recordShape: { biome: 'River', source: 'grandfathered | purchased', acquiredAt: 'Date', pricePaid: 0 },
		},
		mountainStream: mountainStream(path),
		postFifty: postFifty(),
		expansions: expansionSketch(),
		mirrorParity: mirrorParity(path),
		replication: replicationCheck(),
		integration: integrationSection(),
		checks: checks(),
	};
}

let reportCache = null;
/** Every key number of docs/economy/5b/world.md, computed from framework.js (cached per process). */
function report() {
	if (!reportCache) reportCache = buildReport();
	return reportCache;
}

module.exports = {
	PARAMS,
	gearStep, biomeOutcome, biomeHourly, valueTable, monotonicity, stageLadder,
	ladderSpecies, currentMountainStream, liveSpecies, ladderDraw, ladderOutcome, engineCatch, mirrorParity, mountainStream,
	lifecycle, referenceStages, permitPrice, permitTable, timeToAfford, shareSweep, budget,
	accessibleBiomes, canFish, grandfatheredPermits,
	system, permitPriority, permitSavings, permitSummary, scheduledRodsBaseline, validateSystem,
	postFifty, expansionSketch, replicationCheck, today, checks, report,
};

if (require.main === module) process.stdout.write(`${JSON.stringify(report(), null, 1)}\n`);
