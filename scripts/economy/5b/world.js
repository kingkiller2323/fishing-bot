// Phase 5B subsystem: WORLD. Biome income ladder, biome PERMITS, Mountain Stream (the first expansion biome)
// and the post-50 curve. ANALYSIS ONLY: nothing here touches the live game, src/ or production data.
//
// Framework 5b.4. The world is a SYSTEM on the shared lifecycle core (lifecycle.js): integrate.js composes
// system() as 'world' in the REFERENCE core loop (rods + world + quests + streak + buffs). This module steps no
// time itself: every lifecycle-derived number (stage hours and so permit prices, time to afford, budget, level
// times, the 50 -> 60 stage) comes from integrate.run / lifecycle.simulate with the designed systems (CONFIGS).
// Per-cast figures (value ladder, Mountain Stream ladder) come from F.castOutcome / F.hourly. Shared values come
// from ./framework.js (which re-exports assumptions.js) and are never copied here; the only hand-set numbers are
// the design parameters in PARAMS. Every number table of docs/economy/5b/world.md is generated from
// markdownTables() by render-docs.js.
//
//   node scripts/economy/5b/world.js                 (prints report() as JSON)
//   node scripts/economy/5b/render-docs.js           (regenerates the doc's tables)
//
// Exports (pure and synchronous; no database, no randomness):
//   PARAMS                   frozen design parameters: permit price rule (stage share), time-to-afford target,
//                            sensitivity sets, Mountain Stream species ladder, expansion sketch
//   DECISIONS                this design's PROPOSED decisions (decisions.js shape; joined into its registry)
//   system(opts)             the world as a lifecycle.js system (integrate.js 'world'): canFish = permit held
//                            (live biomes only), goals = permits due by gate level ('progression')
//   permitPriority(biome, state, ctx)
//                            the design's due-level purchase order against the pending rod tier
//   permitSummary(result)    per permit from any simulate() result that ran system(): level reached, bought,
//                            delay (hours, sessions), money held at the level / price
//   CONFIGS, lifecycle(archetype, opts)
//                            one integrated lifecycle with the world system (reference loop or a stress
//                            configuration); returns the simulate() result, permitSummary() and rod equip times
//   referenceStages()        the reference player's stages (integrated, no permits): hours, stage $/h, earnings
//   permitPrice(biome, {share}), permitPriceMap(share), formulaPermitPrice(biome, {share})
//                            INTEGRATOR ENTRY POINT: one-time permit prices (0 for Ocean)
//   permitTable()            every permit: formula inputs, price, payback, standalone and integrated time to afford
//   timeToAfford({config, share}), sensitivity(), shareSweep(), budget(), levelTimes()
//   accessibleBiomes(level, permits, {biomes}), canFish(level, permits, biome)
//                            the access rule the engine will use: gate level AND permit
//   grandfatheredPermits(user, {now})
//                            additive migration rule: permits a legacy account receives (pure)
//   gearStep, biomeOutcome, biomeHourly, valueTable, monotonicity, stageLadder
//                            the value model per biome and gear step (F.castOutcome; Mountain Stream via the ladder)
//   ladderSpecies, currentMountainStream, liveSpecies, ladderDraw, ladderOutcome, engineCatch, mirrorParity,
//   mountainStream()         the proposed Mountain Stream ladder, today's 3-salmon biome in the real engine, and
//                            the BIOME_VALUE band check (decisions.js P-MS-VALUE)
//   postFifty()              L50 -> L60 on the integrated core; post-60 sketch from F.xpForLevel and the
//                            integrated XP rate (outside the integrated model: Mountain Stream is not live)
//   expansionSketch()        Deep Sea / Arctic / Abyss placement (indicative levels, value, permit)
//   today()                  today's measured Old Rod $/fish per biome (docs/economy/measurements.json)
//   checks(), report(), markdownTables()
//   RETIRED_LOOP_PARITY      the recorded parity of system() with the deleted private loop (commit a83b5f0)
const F = require('./framework');
// The shared lifecycle core and the integrator (the only way this module runs a lifecycle).
const LC = require('./lifecycle');
const I = require('./integrate');
const { FISH, ENV, LUCKY_ITEMS, LUCKY_ITEM_SHARE, drawDistribution } = require('../lib/catalog-model');
const { RARITIES, levelForXp: legacyLevelForXp } = require('../../../src/engine/balance');
const { MAX_DRAW_ATTEMPTS } = require('../../../src/engine/cast');
// R1's authoritative record (curve.js integrated): checks() confirms the reference loop still reproduces it.
const CURVE_INTEGRATED = require('../../../docs/economy/5b/curve-integrated.json');
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
		// level (the integrated reference loop without permits: referenceStages()) x the $/h of the previous
		// biome with the gear typically held there (F.typicalTier), at the reference cadence. Equivalently:
		// H(k) = stageShare x stage hours of the income the player is earning right before the level.
		stageShare: 0.1,
		priceSigDigits: 2,
		// USER-APPROVED and locked (Phase 5B decision set, P-WORLD-PERMIT-PRICES): the formula's output at framework
		// 5b.4. From 5b.5 (standard rod ladder) permitPrice() returns these at the default stage share; the formula at
		// the current framework is formulaPermitPrice() (reported for information; sensitivities at other shares
		// still use the formula).
		approved: { River: 1000, Lake: 6200, Pond: 23000, Coast: 62000, Swamp: 160000, 'Mountain Stream': 380000 },
		// Biomes that never need a permit (the starting biome).
		free: ['Ocean'],
		// A permit can be bought once the player's gate level reaches the biome's level (money can be saved
		// earlier). One-time, account-bound, never expires, never consumed. A permit does NOT require the
		// previous biome's permit (each is an independent milestone).
		requiresPrevious: false,
	},
	// Purchase order of a permit against the pending rod tier on the shared core (permitPriority()): goals
	// are funded in order of the level they are due at (a permit at its biome's level, a rod tier at its
	// tier level); on a tie the rod goes first ('rod-first', conservative for permits). 'permit-first' is
	// reported as the alternative (CONFIGS.permitFirst).
	schedule: { tieBreak: 'rod-first' },
	// Time-to-afford design target: the permit is owned within this many of the archetype's daily
	// sessions (F.ARCHETYPES[a].minutesPerDay) after the level is reached, with rods bought by
	// rods.system(). checks() holds it on the integrated reference loop AND on fish income alone (quests,
	// streak and buffs excluded), with and without other spending (CONFIGS).
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
		// that puts it at their mean: round(BIOME_VALUE x mean / actual) ($/h is linear in BIOME_VALUE). Applied
		// at 5b.3 (143 -> 149); the value itself is the framework-level proposal decisions.js P-MS-VALUE.
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
	// The post-60 sketch horizon (postFifty(), outside the integrated model).
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
// The world system's name (integrate.js registry key) and its ledger spend item per permit.
const SYSTEM_NAME = 'world';
const permitItem = (biome) => `permit:${biome}`;

// Markdown formatting (markdownTables()).
const fmtNum = (x, d = 0) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtMoney = (x) => (x === null || x === undefined ? '—' : `$${fmtNum(x)}`);
const fmtPct = (x, d = 1) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(d)}%`);
const fmtX = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `×${x.toFixed(d)}`);
const fmtH = (x, d = 2) => (x === null || x === undefined ? '—' : Number.isFinite(x) ? `${x.toFixed(d)} h` : 'not bought');
const mdTable = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

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
// Rod figures read from the shared gear path (F.gearPath(), the rods design since 5b.3): the expected assembly
// cost of a tier and the repair $ per fish of its reference set (0 for the unbreakable Old Rod).
const assemblyCost = (step) => step?.assembly?.expectedCost ?? null;
const upkeepPerFish = (step) => (step && step.maxDurability && step.repairCost ? step.repairCost / step.maxDurability : 0);

// ---------------------------------------------------------------------------------------------
// The world on the INTEGRATED lifecycle. Every run below composes integrate.js systems on the shared core;
// nothing in this module steps time.

/** Stress only (not a design): spends `share` of each step's fish income outside the modelled systems. */
function otherSpendSystem(share) {
	return {
		name: 'otherSpend',
		onCasts(state, ctx, { rates }) {
			if (share > 0) ctx.spend('optional', 'otherSpend', share * rates.cash);
		},
	};
}

const FISH_ONLY = ['quests', 'streak', 'buffs'];
/** The integrated configurations the report runs (lifecycle()'s `config`). */
const CONFIGS = deepFreeze({
	reference: { label: 'Reference loop (rods + world + quests + streak + buffs), rod first on a tie', exclude: [] },
	permitFirst: { label: 'Reference loop, permit first on a tie', exclude: [], world: { schedule: 'permit-first' } },
	withSinks: { label: 'Reference loop + the designed optional sinks (cash bait, aquarium)', exclude: [], variant: { bait: 'cash', aquarium: true } },
	fishOnly: { label: 'Fish income only (quests, streak and buffs excluded)', exclude: FISH_ONLY },
	...Object.fromEntries(PARAMS.sensitivity.otherSpendShares.map((s) => [`fishOnlyOther${s}`, {
		label: `Fish income only, ${fmtPct(s, 0)} of it spent elsewhere as earned`, exclude: FISH_ONLY, otherSpendShare: s,
	}])),
});
/** The harshest configuration: fish income only with the largest other-spend share. */
const STRESS = `fishOnlyOther${Math.max(...PARAMS.sensitivity.otherSpendShares)}`;
/** Runs stop one level past the last permit's level, so a permit bought after that level's session is measured. */
const HORIZON = F.LIFECYCLE.maxLevel + 1;
const allLevels = (to) => Array.from({ length: to }, (_, i) => i + 1);

const runCache = new Map();
/** One cached integrated run: the configuration's systems (integrate.js) with these world options. */
function integratedRun(archetype, { config = 'reference', world = {}, stopAtLevel = HORIZON } = {}) {
	const cfg = CONFIGS[config];
	if (!cfg) throw new Error(`world: unknown configuration ${config}`);
	const worldOpts = { ...(cfg.world || {}), ...world };
	const key = JSON.stringify([archetype, config, worldOpts, stopAtLevel]);
	if (!runCache.has(key)) {
		// Every level is a milestone: per-level hours and the money held on reaching each biome's level.
		const common = { archetype, stopAtLevel, milestones: allLevels(stopAtLevel) };
		let result;
		if (cfg.otherSpendShare) {
			// integrate.run composes registered systems only: the same composition plus the stress system.
			const systems = I.REFERENCE.filter((n) => !cfg.exclude.includes(n)).map((n) => I.systemOf(n, n === SYSTEM_NAME ? worldOpts : {}));
			result = { ...LC.simulate({ ...common, systems: [...systems, otherSpendSystem(cfg.otherSpendShare)] }), systems: [...I.REFERENCE.filter((n) => !cfg.exclude.includes(n)), 'otherSpend'], ...F.stamp() };
		}
		else {
			result = I.run({ ...common, exclude: cfg.exclude, variant: cfg.variant || {}, systemOpts: { [SYSTEM_NAME]: worldOpts } });
		}
		runCache.set(key, result);
	}
	return runCache.get(key);
}

/**
 * Rod tiers in a run: the loop's non-permit 'progression' purchases are rods.system()'s tier assemblies, in tier
 * order; a tier fishes from max(its purchase, reaching its level). Read from the core's purchase log and
 * milestones only (no rods internals).
 */
function rodEquips(result, path = F.gearPath()) {
	const buys = result.purchases.filter((p) => p.category === 'progression' && !p.id.startsWith(permitItem('')));
	return Object.fromEntries(path.slice(1).map((step, i) => {
		const buy = buys[i] || null;
		const at = result.milestones[step.level] || null;
		return [step.tier, {
			level: step.level, purchasedH: buy ? buy.hours : null, cost: buy ? r0(buy.cost) : null,
			equippedH: buy && at ? round(Math.max(buy.hours, at.hours), 4) : null,
		}];
	}));
}

/**
 * One player's lifecycle with the world system on the shared core.
 * opts: { config (a CONFIGS key, default 'reference'), permits (default true; false = every live biome open at its
 *   level: the reference-stage model), share (price the permits at this stage share), prices (default
 *   permitPriceMap(share)), expansion (default true: the Mountain Stream permit is offered at its level; the core
 *   never fishes it), grandfatheredLevel, stopAtLevel (default HORIZON) }
 * Returns { result, reached { level: { hours, day } }, permits (permitSummary()), rods (rodEquips()) }.
 */
function lifecycle(archetype, opts = {}) {
	const { config = 'reference', permits = true, share = PARAMS.permits.stageShare, prices = null, expansion = true, grandfatheredLevel = null, stopAtLevel = HORIZON } = opts;
	const world = permits
		? { prices: prices || permitPriceMap(share), expansion, ...(grandfatheredLevel === null ? {} : { grandfatheredLevel }) }
		: { permits: false };
	const result = integratedRun(archetype, { config, world, stopAtLevel });
	const reached = Object.fromEntries(Object.entries(result.milestones).filter(([L]) => /^\d+$/.test(L)).map(([L, m]) => [L, { hours: m.hours, day: m.day }]));
	return { result, reached, permits: permitSummary(result), rods: rodEquips(result) };
}

// ---------------------------------------------------------------------------------------------
// Permits.
let stagesCache = null;
/**
 * The reference player's (F.REFERENCE_ARCHETYPE) stages on the integrated reference loop without permits (every
 * live biome open at its level): hours of play from the previous biome's level to this biome's level, and the
 * stage's $/h (the previous biome with the tier typically held there, F.typicalTier, at the reference cadence).
 * integratedFishIncome is the fish income the integrated run actually earned in the stage (a cross-check of E(k)).
 */
function referenceStages() {
	if (!stagesCache) {
		const ref = F.REFERENCE_ARCHETYPE;
		const m = lifecycle(ref, { permits: false, stopAtLevel: F.LIFECYCLE.maxLevel }).result.milestones;
		const at = (L) => (L <= 1 ? 0 : m[L]?.hours);
		const fishCash = (L) => (L <= 1 ? 0 : m[L]?.ledger.cash.fishing ?? 0);
		stagesCache = Object.fromEntries(PERMIT_BIOMES.map((b) => {
			const pb = prevBiome(b);
			const [lo, hi] = [F.BIOME_LEVEL[pb], F.BIOME_LEVEL[b]];
			if (at(lo) === undefined || at(hi) === undefined) throw new Error(`referenceStages: the reference run does not reach Lv ${hi}`);
			const step = F.typicalTier(pb);
			const perHour = biomeHourly(pb, step, F.ARCHETYPES[ref].overheadS).cash;
			const hours = at(hi) - at(lo);
			return [b, {
				biome: b, level: hi, stageBiome: pb, stageLevels: [lo, hi], stageTier: step.tier,
				stageHours: hours, stageCashPerHour: perHour, expectedEarnings: hours * perHour,
				integratedFishIncome: fishCash(hi) - fishCash(lo),
			}];
		}));
	}
	return stagesCache;
}

/** The price rule's output at the current framework (stageShare x E(k)); informational from 5b.5. */
function formulaPermitPrice(biome, { share = PARAMS.permits.stageShare } = {}) {
	if (isFree(biome)) return 0;
	const s = referenceStages()[biome];
	if (!s) throw new Error(`permitPrice: unknown biome ${biome}`);
	return nicePrice(share * s.expectedEarnings);
}
/**
 * One-time permit price for a biome (0 for a free biome): the user-approved, locked price at the default stage
 * share (PARAMS.permits.approved); opts.share (sensitivity only) prices by the formula at that share.
 */
function permitPrice(biome, { share = PARAMS.permits.stageShare } = {}) {
	if (isFree(biome)) return 0;
	if (share === PARAMS.permits.stageShare && PARAMS.permits.approved[biome] !== undefined) return PARAMS.permits.approved[biome];
	return formulaPermitPrice(biome, { share });
}
const priceMapCache = new Map();
/** Every permit's price at a stage share (default PARAMS.permits.stageShare). */
function permitPriceMap(share = PARAMS.permits.stageShare) {
	if (!priceMapCache.has(share)) priceMapCache.set(share, Object.fromEntries(PERMIT_BIOMES.map((b) => [b, permitPrice(b, { share })])));
	return priceMapCache.get(share);
}

const maxOf = (xs) => xs.reduce((m, x) => Math.max(m, x ?? Infinity), 0);
const minOf = (xs) => xs.reduce((m, x) => Math.min(m, x ?? Infinity), Infinity);

/**
 * Per archetype and permit (integrated): level reached, permit bought, delay (hours, sessions), money held at the
 * level / price, and (withRods) each rod tier's equip delay against the same configuration without permits.
 * A permit not bought by the end of the run counts as an infinite delay.
 */
function timeToAfford({ config = 'reference', share = PARAMS.permits.stageShare, withRods = true } = {}) {
	return Object.fromEntries(Object.keys(F.ARCHETYPES).map((a) => {
		const life = lifecycle(a, { config, share });
		const none = withRods ? lifecycle(a, { config, permits: false }) : null;
		const rodDelayVsNoPermits = none ? Object.fromEntries(Object.entries(life.rods).map(([t, v]) => {
			const base = none.rods[t].equippedH;
			return [t, v.equippedH === null || base === null ? null : round(v.equippedH - base, 4)];
		})) : null;
		const permits = Object.values(life.permits);
		return [a, {
			sessionHours: round(sessionH(a), 3),
			permits: life.permits,
			rods: life.rods,
			rodDelayVsNoPermits,
			maxDelaySessions: maxOf(permits.map((p) => p.delaySessions)),
			minCoverage: minOf(permits.map((p) => p.coverageAtLevel)),
			maxRodDelayH: rodDelayVsNoPermits ? maxOf(Object.values(rodDelayVsNoPermits)) : null,
		}];
	}));
}

/** Every permit: formula inputs, price, payback, standalone time to afford, integrated time to afford. */
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
			integratedStageFishIncome: r0(s.integratedFishIncome),
			share: PARAMS.permits.stageShare,
			price,
			priceHoursOfStageIncome: round(price / s.stageCashPerHour),
			gainPerHourWithGearAtLevel: r0(gain),
			gearAtLevel: gear.tier,
			paybackHours: round(price / gain),
			// From $0 at the archetype's own cadence, net of repairs, fishing the stage biome with its typical tier.
			standaloneHoursToAfford: Object.fromEntries(Object.keys(F.ARCHETYPES).map((a) => {
				const step = F.typicalTier(s.stageBiome);
				const h = biomeHourly(s.stageBiome, step, F.ARCHETYPES[a].overheadS);
				const hrs = price / (h.cash - upkeepPerFish(step) * h.fish);
				return [a, { hours: round(hrs), sessions: round(hrs / sessionH(a)) }];
			})),
			lifecycle: Object.fromEntries(Object.entries(tta).map(([a, v]) => [a, v.permits[b]])),
		};
	});
}

/** Every configuration (CONFIGS) per archetype: worst permit delay, lowest coverage at the level, worst rod delay. */
function sensitivity() {
	return Object.fromEntries(Object.entries(CONFIGS).map(([config, c]) => {
		const tta = timeToAfford({ config });
		return [config, {
			label: c.label,
			archetypes: Object.fromEntries(Object.entries(tta).map(([a, v]) => [a, { maxDelaySessions: v.maxDelaySessions, minCoverage: v.minCoverage, maxRodDelayH: v.maxRodDelayH }])),
			maxDelaySessions: maxOf(Object.values(tta).map((v) => v.maxDelaySessions)),
			minCoverage: minOf(Object.values(tta).map((v) => v.minCoverage)),
			maxRodDelayH: maxOf(Object.values(tta).map((v) => v.maxRodDelayH)),
		}];
	}));
}

/** Alternative stage shares: prices and, per archetype, worst delay and lowest coverage (reference and STRESS). */
function shareSweep() {
	return PARAMS.sensitivity.shareSweep.map((share) => {
		const out = { share, prices: permitPriceMap(share) };
		for (const config of ['reference', STRESS]) {
			const t = timeToAfford({ config, share, withRods: false });
			out[config] = {
				maxDelaySessions: Object.fromEntries(Object.entries(t).map(([a, v]) => [a, v.maxDelaySessions])),
				minCoverage: minOf(Object.values(t).map((v) => v.minCoverage)),
			};
		}
		return out;
	});
}

/**
 * Where income goes per archetype on the integrated reference loop to Lv F.LIFECYCLE.maxLevel (the R1 economy:
 * integrate.run defaults; the Mountain Stream permit belongs to the expansion and is not offered).
 */
function budget() {
	return Object.fromEntries(Object.keys(F.ARCHETYPES).map((a) => {
		const { result } = lifecycle(a, { expansion: false, stopAtLevel: F.LIFECYCLE.maxLevel });
		const s = I.sinkSummary(result);
		const prog = result.ledger.spend.progression;
		const permits = Object.entries(prog).filter(([k]) => k.startsWith(permitItem(''))).reduce((t, [, v]) => t + v, 0);
		const progression = Object.values(prog).reduce((t, v) => t + v, 0);
		const other = Object.entries(s.byCategory).filter(([c]) => !['upkeep', 'progression'].includes(c)).reduce((t, [, v]) => t + v.total, 0);
		return [a, {
			income: s.income,
			fishingShare: round((result.ledger.cash.fishing || 0) / s.income, 4),
			upkeepShare: s.byCategory.upkeep.share,
			rodsShare: round((progression - permits) / s.income, 4),
			permitsShare: round(permits / s.income, 4),
			permitsShareOfFishIncome: round(permits / (result.ledger.cash.fishing || 1), 4),
			otherShare: round(other / s.income, 4),
			savedShare: s.savedShare,
			saved: s.saved,
			hours: result.hours,
			minMoney: r0(result.final.minMoney),
			blockedHours: result.final.blockedHours,
		}];
	}));
}

/**
 * Level times on the reference loop with and without permits (every archetype), and the regular player's hours
 * against R1's record (docs/economy/5b/curve-integrated.json).
 */
// Two minutes: a tolerance of two core steps (1-minute steps), used only in a comparison.
const TWO_STEPS_H = 2 / 60;
function levelTimes() {
	const levels = F.LIFECYCLE.milestones;
	const archetypes = Object.fromEntries(Object.keys(F.ARCHETYPES).map((a) => {
		const w = lifecycle(a).reached;
		const wo = lifecycle(a, { permits: false }).reached;
		return [a, {
			with: Object.fromEntries(levels.map((L) => [L, w[L] ? round(w[L].hours) : null])),
			without: Object.fromEntries(levels.map((L) => [L, wo[L] ? round(wo[L].hours) : null])),
			maxAbsDiffH: maxOf(levels.map((L) => (w[L] && wo[L] ? Math.abs(w[L].hours - wo[L].hours) : null))),
		}];
	}));
	const reg = archetypes[F.REFERENCE_ARCHETYPE].with;
	const record = CURVE_INTEGRATED.framework?.regular || {};
	const recordDiff = maxOf(Object.keys(record).map((L) => (reg[L] === undefined || reg[L] === null ? null : Math.abs(reg[L] - record[L]))));
	return {
		levels, archetypes,
		maxAbsDiffH: maxOf(Object.values(archetypes).map((v) => v.maxAbsDiffH)),
		r1Record: { file: 'docs/economy/5b/curve-integrated.json', quartic: CURVE_INTEGRATED.framework?.quartic ?? CURVE_INTEGRATED.chosen, sharedDigest: CURVE_INTEGRATED.sharedDigest, regular: record, maxAbsDiffH: round(recordDiff, 4) },
	};
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

/** Legacy accounts used as migration examples (report().migration and DECISIONS P-WORLD-GRANDFATHER). */
const MIGRATION_EXAMPLES = deepFreeze([
	{ user: { level: 34, xp: 118000, currentBiome: 'pond' } },
	{ user: { level: 7, xp: 5200, currentBiome: 'ocean' } },
	{ user: { level: 55, xp: 310000, currentBiome: 'swamp' } },
	{ user: { level: 15, xp: 22500, currentBiome: 'lake' } },
	{ user: { level: 12, xp: 15000, currentBiome: 'river', permits: [] } },
]);

// ---------------------------------------------------------------------------------------------
// The world as a SYSTEM on the shared lifecycle core (lifecycle.js; integrate.js composes it as 'world' in the
// REFERENCE core loop):
//
//   integrate.run({ archetype })   or   LC.simulate({ archetype, systems: [..., world.system(), ...] })
//
// Hooks (all per-run state in state.sys.world; system() returns a fresh object each call):
//   init         permits held from the start: the free biome (Ocean) and grandfathered permits
//                (opts.grandfatheredLevel: every live non-free biome at or below that level; opts.grandfathered:
//                biome names or grandfatheredPermits() records)
//   canFish      a LIVE biome whose permit is held (every live biome with opts.permits false). Mountain Stream
//                stays out of the live biomes: the core never fishes it (its proposed ladder is priced by
//                mountainStream(), and the post-60 sketch by postFifty(), not by the core)
//   goals        one 'progression' goal per unowned permit whose level the gate level has reached: item
//                'permit:<biome>', cost = its price (permitPriceMap(), or opts.prices), priority from
//                permitPriority() (due-level order against the pending rod tier, PARAMS.schedule); a permit the
//                player cannot afford yet blocks the goals after it (the core's default for 'progression')
//   on           'levelUp' of the gate kind (real, or public under the Founder's public gate) records when each
//                biome's level is reached (time to afford: permitSummary())
//   onDayStart / onDayEnd
//                flag purchases made by the core's end-of-day purchase pass (labelled at the session's end)
// Ledger: no XP or cash source (the world grants nothing); spend items 'permit:<biome>' ('progression').

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
	if (!['rod-first', 'permit-first'].includes(schedule)) throw new Error(`world.system: unknown schedule ${schedule}`);
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
						// The core's purchase pass runs after a step's casts: the permit is labelled with the start of
						// that step (the first moment the player could buy it); the end-of-day pass labels at st.h.
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
 * gate level reached its level and when it was held (boughtH is the start of the buying step; delay =
 * max(0, boughtH - reachedH); sessions = delay / the archetype's daily session), and coverageAtLevel = the money
 * held on reaching the level / the price (from the gate kind's milestone snapshot, when that level was recorded).
 */
function permitSummary(result) {
	const w = result.sys[SYSTEM_NAME];
	if (!w || !w.permits) return null;
	const dayH = result.archetype.minutesPerDay ? result.archetype.minutesPerDay / 60 : null;
	const snapshots = result.gate === 'public' ? result.publicMilestones : result.milestones;
	return Object.fromEntries(w.offered.map((b) => {
		const reached = w.reached[b] || null;
		const held = w.held[b] || null;
		const purchased = held && held.source === 'purchased';
		let delayH = null;
		if (held && !purchased) delayH = 0;
		else if (purchased && reached) delayH = Math.max(0, held.boughtH - reached.hours);
		const atLevel = snapshots?.[F.BIOME_LEVEL[b]];
		return [b, {
			level: F.BIOME_LEVEL[b], price: w.prices[b], source: held ? held.source : null,
			reachedH: reached ? round(reached.hours, 4) : null, reachedDay: reached ? reached.day : null,
			boughtH: purchased ? round(held.boughtH, 4) : null, boughtDay: purchased ? held.day : null,
			delayH: delayH === null ? null : round(delayH, 4),
			delaySessions: delayH === null || !dayH ? null : round(delayH / dayH, 4),
			coverageAtLevel: atLevel && w.prices[b] > 0 ? round(atLevel.money / w.prices[b]) : null,
		}];
	}));
}

// ---------------------------------------------------------------------------------------------
// Mountain Stream (not live: priced per cast through the ladder mirror, never fished by the core).
/**
 * The proposed ladder: counts, per-weather premium, $/fish and $/h by tier, step over Swamp, the BIOME_VALUE band
 * rule (PARAMS.mountainStream.valueRule; the value itself is decisions.js P-MS-VALUE), today's 3-salmon biome in
 * the real engine.
 */
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
	// Every Mountain Stream value is proportional to its BIOME_VALUE, so figures at another value are the
	// framework figures scaled by value / current (shown for the decision; F stays authoritative).
	const scale = requested ? requested / F.BIOME_VALUE[MS] : 1;
	const alternative = require('./decisions').DECISIONS.find((d) => d.id === 'P-MS-VALUE')?.alternatives?.[0] ?? null;
	const homeStep = F.hourly(biomeOutcome(MS, top)).cash / F.hourly(biomeOutcome('Swamp', F.typicalTier('Swamp', path))).cash;
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
			homeStepOverSwamp: round(homeStep, 3),
			atAlternative: typeof alternative === 'number' ? {
				biomeValue: alternative,
				stepOverSwamp: round((actual * alternative) / F.BIOME_VALUE[MS], 3),
				inBand: (actual * alternative) / F.BIOME_VALUE[MS] >= Math.min(...lateSteps) && (actual * alternative) / F.BIOME_VALUE[MS] <= Math.max(...lateSteps),
				homeStepOverSwamp: round((homeStep * alternative) / F.BIOME_VALUE[MS], 3),
			} : null,
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

// ---------------------------------------------------------------------------------------------
// The post-50 curve.
let postFiftyCache = null;
/**
 * Lv 50 (the last live biome) -> Lv 60 (Mountain Stream's level) on the integrated reference loop per archetype,
 * the reference player's per-level hours and stage lengths, and the stage before Mountain Stream.
 * POST-60 IS OUTSIDE THE INTEGRATED MODEL (Mountain Stream is not live; nothing past 60 is designed). Its sketch
 * spans are curve-based: (F.xpForLevel(y) - F.xpForLevel(x)) / the archetype's integrated XP rate, i.e. its XP per
 * hour of play over the L50 -> L60 stage (every source), with the fishing part raised by the endgame tier's fishing
 * XP gain (the tier held from Lv 60 on; fishing XP per cast is biome-independent: monotonicity()).
 */
function postFifty() {
	if (postFiftyCache) return postFiftyCache;
	const path = F.gearPath();
	const lastLive = F.LIVE_BIOMES[F.LIVE_BIOMES.length - 1];
	const from = F.BIOME_LEVEL[lastLive];
	const to = F.BIOME_LEVEL[MS];
	const endTier = path.find((s) => s.level === to) || path[path.length - 1];
	const stageTier = F.tierAt(from, path);
	const sketchLevels = [to, ...PARAMS.expansions.map((e) => e.level), PARAMS.sketchMaxLevel];
	const xpTotal = (snap) => Object.values(snap.ledger.xp).reduce((t, v) => t + v, 0);
	const archetypes = Object.fromEntries(Object.keys(F.ARCHETYPES).map((a) => {
		const life = lifecycle(a);
		const m = life.result.milestones;
		if (!m[from] || !m[to]) throw new Error(`postFifty: ${a} does not reach Lv ${to}`);
		const endEquip = life.rods[endTier.tier]?.equippedH ?? null;
		const dayH = sessionH(a);
		const hours = m[to].hours - m[from].hours;
		const xp = xpTotal(m[to]) - xpTotal(m[from]);
		const fishingShare = ((m[to].ledger.xp.fishing || 0) - (m[from].ledger.xp.fishing || 0)) / xp;
		const oh = F.ARCHETYPES[a].overheadS;
		const gain = biomeHourly(lastLive, endTier, oh).xp / biomeHourly(lastLive, stageTier, oh).xp;
		const rate = xp / hours;
		const post60Rate = rate * (fishingShare * gain + (1 - fishingShare));
		const sketch = sketchLevels.slice(1).map((y, i) => {
			const x = sketchLevels[i];
			const h = (F.xpForLevel(y) - F.xpForLevel(x)) / post60Rate;
			return { from: x, to: y, hours: round(h), days: round(h / dayH, 1) };
		});
		return [a, {
			reach: { [from]: { hours: round(m[from].hours), day: m[from].day }, [to]: { hours: round(m[to].hours), day: m[to].day } },
			stage: { hours: round(hours), days: round(hours / dayH, 1) },
			// The endgame tier fishes from max(its purchase, reaching its level): hours after reaching Lv `to`.
			endTierEquipDelayH: endEquip === null ? null : round(Math.max(0, endEquip - m[to].hours), 4),
			xpRate: { stage: r0(rate), fishingShare: round(fishingShare, 3), endTierFishingGain: round(gain, 3), post60: r0(post60Rate) },
			sketch,
		}];
	}));
	const regM = lifecycle(F.REFERENCE_ARCHETYPE).result.milestones;
	const perLevel = {};
	for (let L = from - 5; L <= to; L++) perLevel[L] = round(regM[L].hours - regM[L - 1].hours, 3);
	const bounds = [0, ...[...new Set(Object.values(F.BIOME_LEVEL))].filter((L) => L > 0 && L <= to).sort((x, y) => x - y)];
	const integratedStages = bounds.slice(1).map((L, i) => ({ stage: `${bounds[i]}-${L}`, hours: round(regM[L].hours - (bounds[i] ? regM[bounds[i]].hours : 0)), source: 'integrated' }));
	const sketchStages = archetypes[F.REFERENCE_ARCHETYPE].sketch.map((s) => ({ stage: `${s.from}-${s.to}`, hours: s.hours, source: 'curve-based sketch' }));
	const stages = [...integratedStages, ...sketchStages].map((x, i, arr) => ({ ...x, ratio: i ? round(x.hours / arr[i - 1].hours, 3) : null }));
	const stage = referenceStages()[MS];
	const endCost = assemblyCost(endTier);
	const xpHour = (step) => biomeHourly(lastLive, step, F.ARCHETYPES[F.REFERENCE_ARCHETYPE].overheadS).xp;
	postFiftyCache = {
		curve: { base: F.CURVE.base, quartic: F.CURVE.quartic, xpAt: Object.fromEntries([from, ...sketchLevels].map((L) => [L, r0(F.xpForLevel(L))])) },
		from, to, sketchLevels,
		archetypes,
		perLevelHoursReference: perLevel,
		stageHoursReference: stages,
		stageBeforeMountainStream: {
			biome: stage.stageBiome, tier: stage.stageTier, hours: round(stage.stageHours), cashPerHour: r0(stage.stageCashPerHour), earnings: r0(stage.expectedEarnings),
			endgameTier: endTier.tier, endgameTierAssembly: endCost === null ? null : r0(endCost), endgameTierShareOfStage: endCost === null ? null : round(endCost / stage.expectedEarnings, 4),
			permit: permitPrice(MS), permitShareOfStage: round(permitPrice(MS) / stage.expectedEarnings, 4),
		},
		// Fishing XP/h at the reference cadence: the endgame tier over the tier held in the 50 -> 60 stage.
		xpPerHourReference: { stageTier: stageTier.tier, endTier: endTier.tier, stage: r0(xpHour(stageTier)), end: r0(xpHour(endTier)), gain: round(xpHour(endTier) / xpHour(stageTier), 3) },
	};
	return postFiftyCache;
}

/** Deep Sea / Arctic / Abyss: indicative placement, value continuation and permit (not designed; curve-based). */
function expansionSketch() {
	const bv = F.BIOME_VALUE;
	const live = [...F.LIVE_BIOMES, MS];
	// Geometric continuation of the last three BIOME_VALUE steps.
	const k = 3;
	const valueStep = (bv[live[live.length - 1]] / bv[live[live.length - 1 - k]]) ** (1 / k);
	const sketch = postFifty().archetypes[F.REFERENCE_ARCHETYPE].sketch;
	const path = F.gearPath();
	const msRate = biomeHourly(MS, path[path.length - 1]).cash;
	let prevValue = bv[MS];
	return {
		valueStep: round(valueStep, 3),
		biomes: PARAMS.expansions.map((e) => {
			const value = prevValue * valueStep;
			const before = sketch.find((x) => x.to === e.level) || null;
			// Indicative permit: the same rule, the stage before it fished in the previous biome with the endgame tier.
			const prevRate = msRate * (prevValue / bv[MS]);
			const out = { ...e, indicativeBiomeValue: r0(value), stageHoursReference: before ? before.hours : null, indicativePermit: before ? nicePrice(PARAMS.permits.stageShare * before.hours * prevRate) : null };
			prevValue = value;
			return out;
		}),
	};
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
	const out = [];
	const ref = F.REFERENCE_ARCHETYPE;
	const limit = (a) => (a === ref ? PARAMS.targets.referenceMaxDelaySessions : PARAMS.targets.maxDelaySessions);
	const sens = sensitivity();
	for (const config of ['reference', 'fishOnly', STRESS]) {
		const s = sens[config];
		const per = Object.entries(s.archetypes);
		out.push({
			check: `${s.label}: every permit owned within the target after reaching its level (reference player ${PARAMS.targets.referenceMaxDelaySessions} sessions, others ${PARAMS.targets.maxDelaySessions})`,
			value: Object.fromEntries(per.map(([a, v]) => [a, v.maxDelaySessions])),
			ok: per.every(([a, v]) => v.maxDelaySessions <= limit(a) + 1e-9),
		});
		out.push({
			check: `${s.label}: permits delay no rod tier by more than one session`,
			value: Object.fromEntries(per.map(([a, v]) => [a, v.maxRodDelayH])),
			ok: per.every(([a, v]) => v.maxRodDelayH <= sessionH(a) + 1e-9),
		});
	}
	const lt = levelTimes();
	// 5b.5: permits compete with optional Angler Upgrades for cash; a permit can shift an Experience upgrade and
	// so a level by a step. Permits themselves add no XP: the check allows two lifecycle steps.
	out.push({ check: 'permits change level times by at most two 1-minute steps (only through optional upgrade timing; reference loop, every archetype, every milestone)', value: lt.maxAbsDiffH, ok: lt.maxAbsDiffH <= TWO_STEPS_H + 1e-9 });
	out.push({ check: 'the reference loop at these permit prices reproduces R1\'s record (curve-integrated.json, regular, to its 2 decimals)', value: lt.r1Record.maxAbsDiffH, ok: lt.r1Record.maxAbsDiffH <= 0.005 + 1e-9 && lt.r1Record.quartic === F.CURVE.quartic });
	const spend = Object.values(budget());
	out.push({ check: 'reference loop to the last milestone: never blocked, never below $0 (every archetype)', value: { blockedHours: maxOf(spend.map((v) => v.blockedHours)), minMoney: minOf(spend.map((v) => v.minMoney)) }, ok: spend.every((v) => v.blockedHours === 0 && v.minMoney >= 0) });
	const mono = monotonicity();
	out.push({ check: 'income rises with biome at every tier and access level (F.gearPath())', value: mono.minBiomeStepRatio, ok: mono.ok });
	const prices = PERMIT_BIOMES.map((b) => permitPrice(b));
	out.push({ check: 'permit prices rise with biome level', value: prices, ok: prices.every((p, i) => i === 0 || p > prices[i - 1]) });
	const ms = mountainStream();
	out.push({ check: 'Mountain Stream same-tier step over Swamp inside the live late-ladder band (at the modelled BIOME_VALUE, P-MS-VALUE)', value: { step: ms.valueCheck.actualStep, band: ms.valueCheck.band }, ok: ms.valueCheck.inBand });
	out.push({ check: 'Mountain Stream: every weather has one premium Ultra and a certain catch', value: ms.perWeatherAtTopTier.map((x) => x.premiumUltra.length), ok: ms.perWeatherAtTopTier.every((x) => x.premiumUltra.length === 1 && x.catchProbability > 0.999) });
	const parity = mirrorParity();
	out.push({ check: 'ladder mirror equals F.castOutcome on every live biome', value: parity.maxRelativeError, ok: parity.ok });
	return out;
}

// ---------------------------------------------------------------------------------------------
// Integration contract and the retired loop's parity record.

/**
 * RETIRED at the 5b.4 migration: world.lifecycle()'s private stepping loop (curve.js-style XP with the provisional
 * daily XP, rods paid on schedule, permits). Before it was deleted, validateSystem() compared system() on the
 * shared core (plus baselines replaying the loop's rods, daily XP and other spend) with it for every archetype in
 * five configurations. The loop no longer exists to recompute this; the values below are that output.
 */
const RETIRED_LOOP_PARITY = deepFreeze({
	commit: 'a83b5f0',
	check: 'validateSystem(): system() on the shared core vs the private loop; 4 archetypes x 5 configurations (design, permit-first, 15% other spend, grandfathered Lv 34, no permits): level hours, permit and rod times, ledgers at milestone day ends',
	maxRelativeDifference: 0.0000263,
	recorded: 'the a83b5f0 commit message records world 0.03% (a framework 5b.3 run); the a83b5f0 code re-run at 5b.4 just before the deletion gave 0.0026%',
	timeToAffordIdentical: true,
	pricesFromCoreIdentical: true,
	remainingDifference: 'the core buys in an end-of-day pass after the daily XP, the loop after the next step: one step of income, the core rule is the right one',
});

function integrationSection() {
	return {
		framework: `${F.FRAMEWORK_VERSION} shared lifecycle core (lifecycle.js); integrate.js system '${SYSTEM_NAME}' in the REFERENCE core loop (${I.REFERENCE.join(', ')})`,
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
				goals: 'one \'progression\' goal per unowned permit whose level the gate level has reached (item \'permit:<biome>\'); priority LC.PRIORITY.permit when due before the pending rod tier (or tied under \'permit-first\'), else LC.PRIORITY.rod + 1; blocking while unaffordable',
				on: '\'levelUp\' of the gate kind (public under the Founder\'s public gate) records when each biome level is reached',
				onDayStart: 'clears the end-of-day purchase flag',
				onDayEnd: 'flags purchases made by the core\'s end-of-day purchase pass',
			},
			ledger: { xpSources: [], cashSources: [], spend: { progression: F.LIVE_BIOMES.filter((b) => !isFree(b)).map(permitItem), progressionWithExpansion: [permitItem(MS)] } },
			helpers: {
				permitSummary: 'time to afford per permit from a simulate() result (reached, bought, delay in hours and sessions, money held at the level / price)',
				lifecycle: 'one integrated run of a CONFIGS configuration with the world system (reference loop or stress)',
			},
		},
		configs: Object.fromEntries(Object.entries(CONFIGS).map(([k, c]) => [k, c.label])),
		retiredLoopParity: RETIRED_LOOP_PARITY,
	};
}

// ---------------------------------------------------------------------------------------------
// Decisions for the user's approval (decisions.js shape; status 'proposed' only: only the user approves).
const DECISIONS = [
	{
		id: 'P-WORLD-PERMIT-SHARE', status: 'proposed',
		title: 'Permit price = a stage share of the reference player\'s expected fish income in the stage before the biome (H(k) = share x stage hours of the income earned just before the level), rounded to significant digits',
		modelled: `stageShare ${PARAMS.permits.stageShare}, ${PARAMS.priceSigDigits} significant digits (permitPrice(); stage hours from the integrated reference loop without permits)`,
		alternatives: [`another share (shareSweep: ${PARAMS.sensitivity.shareSweep.join(', ')})`, 'a flat number of hours of income per permit (punitive early, trivial late)', 'hand-set prices'],
		source: 'world design',
		why: 'scales with both stage length and stage income, so the permit reads as the same milestone at every biome and regenerates with the framework',
		get: () => ({ stageShare: PARAMS.permits.stageShare, sigDigits: PARAMS.priceSigDigits }),
		expected: { stageShare: 0.1, sigDigits: 2 },
	},
	{
		id: 'P-WORLD-PERMIT-PRICES', status: 'proposed',
		title: 'The resulting permit prices (framework 5b.4, integrated reference stage hours)',
		modelled: 'permitPriceMap()',
		alternatives: ['re-derive at a later framework version before baking into balance.js', 'prices at another share (shareSweep)'],
		source: 'world design',
		why: 'the formula\'s output at the final framework; the engine bakes these constants (a test asserts they equal permitPriceMap())',
		get: () => permitPriceMap(),
		expected: { River: 1000, Lake: 6200, Pond: 23000, Coast: 62000, Swamp: 160000, 'Mountain Stream': 380000 },
	},
	{
		id: 'P-WORLD-PERMIT-RULES', status: 'proposed',
		title: 'Permits: Ocean free; one-time, account-bound, never expire, not consumed, not refundable; no chain (a permit does not require the previous one); bought once the gate level reaches the biome; one price for everyone (the Founder pays it from final cash); a progression purchase, not upkeep',
		modelled: `free ${JSON.stringify(PARAMS.permits.free)}, requiresPrevious ${PARAMS.permits.requiresPrevious} (system(), accessibleBiomes())`,
		alternatives: ['a sequential chain (Pond requires Lake)', 'permits that expire or recur (upkeep)'],
		source: 'world design (user decision 3: a milestone purchase alongside the level)',
		why: 'a milestone, never a second wall: a player who does not buy keeps fishing the biome below and keeps their money',
		get: () => ({ free: PARAMS.permits.free, requiresPrevious: PARAMS.permits.requiresPrevious }),
		expected: { free: ['Ocean'], requiresPrevious: false },
	},
	{
		id: 'P-WORLD-AFFORD-TARGET', status: 'proposed',
		title: 'Time-to-afford target: every permit owned within this many daily sessions of reaching its level (the reference player: at the level), with rods bought on schedule, on the reference loop and on fish income alone',
		modelled: `maxDelaySessions ${PARAMS.targets.maxDelaySessions}, referenceMaxDelaySessions ${PARAMS.targets.referenceMaxDelaySessions} (checks())`,
		alternatives: ['a looser target (a permit may take a few sessions to save for)'],
		source: 'world design',
		why: 'the permit is announced at level-up and should be affordable then; a real wait would read as a second level gate',
		get: () => PARAMS.targets,
		expected: { maxDelaySessions: 1, referenceMaxDelaySessions: 0 },
	},
	{
		id: 'P-WORLD-GRANDFATHER', status: 'proposed',
		title: 'Grandfathering: an account with no permits field receives a grandfathered permit for every live biome at or below max(stored level, today\'s levelForXp(xp)) plus its current biome; an account that has the field (even empty) is untouched',
		modelled: 'grandfatheredPermits(user) on the migration examples',
		alternatives: ['level only (without the current biome)', 'no grandfathering (everyone buys)'],
		source: 'world design (user decision 3)',
		why: 'nobody loses access or is moved out of the water they are standing in; levels never drop, so today\'s level is the most generous correct basis; additive and idempotent',
		get: () => MIGRATION_EXAMPLES.map((x) => {
			const g = grandfatheredPermits(x.user);
			return g === null ? null : g.map((p) => p.biome);
		}),
		expected: [['River', 'Lake', 'Pond'], [], ['River', 'Lake', 'Pond', 'Coast', 'Swamp'], ['River', 'Lake'], null],
	},
	{
		id: 'P-WORLD-MS-LADDER', status: 'proposed',
		title: 'Mountain Stream is the first expansion biome at its shared level: a freshwater ladder where the weather decides the premium (one strong Ultra salmon per weather: the three existing salmon unchanged plus two new), every rarity with year-round species; not live until approved and seeded',
		modelled: 'PARAMS.mountainStream.ladder (mountainStream())',
		alternatives: ['keep today\'s three weather-exclusive salmon only (NO_CATCH on most casts)', 'a rarity-weighted premium instead of the weather'],
		source: 'world design (user decision 11)',
		why: 'no weather is dead or a farm; the forecast decides which premium salmon can be caught (collections, quests, aquarium); the draw model is exact because a fallback species always exists',
		get: () => {
			const s = ladderSpecies();
			return { level: F.BIOME_LEVEL[MS], species: s.length, newSpecies: s.filter((x) => !x.existing).length, weatherPremium: PARAMS.mountainStream.ladder.filter((x) => x.weather).map((x) => `${x.name}:${x.weather}`) };
		},
		expected: { level: 60, species: 25, newSpecies: 22, weatherPremium: ['Flashfin Salmon:Rainy', 'Shrouded Salmon:Cloudy', 'Zephyr Salmon:Windy', 'Sunrun Salmon:Sunny', 'Snowmelt Salmon:Snowy'] },
	},
	{
		id: 'P-WORLD-MS-WEAK-LADDER', status: 'proposed',
		title: 'Mountain Stream keeps a weak species at every rarity, so the Old Rod (the safety net) still catches the weak ladder; the premium fish need a crafted rod',
		modelled: 'weak species per rarity in PARAMS.mountainStream.ladder',
		alternatives: ['a strong-only biome (the Old Rod catches nothing there)'],
		source: 'world design',
		why: 'the safety net holds in every biome; a generous Old Rod at the endgame costs nothing',
		get: () => Object.fromEntries(RARITIES.map((r) => [r, PARAMS.mountainStream.ladder.filter((x) => x.rarity === r && x.quality === 'weak').length])),
		expected: { common: 2, uncommon: 2, rare: 2, ultra: 1, giant: 1, legendary: 1, lucky: 1 },
	},
	{
		id: 'P-WORLD-POST50', status: 'proposed',
		title: 'Post-50 outline: the 50 -> 60 stage buys the endgame rod tier and the Mountain Stream permit; later expansions one biome per 10-level stage (sketch only, not designed), each to arrive with its own gear tier and aspirational sinks',
		modelled: 'PARAMS.expansions (postFifty(), expansionSketch(); outside the integrated model)',
		alternatives: ['no post-60 content plan yet', 'other placements'],
		source: 'world design',
		why: 'every stage stays anchored to a new place and each permit stays a milestone; no curve change is needed for Mountain Stream',
		get: () => PARAMS.expansions.map((e) => [e.biome, e.level]),
		expected: [['Deep Sea', 70], ['Arctic', 80], ['Abyss', 90]],
	},
	{
		id: 'P-WORLD-L60-WINDOW', status: 'proposed',
		title: 'Optional: add a Lv 60 target window for the regular player so R1 also guards the Mountain Stream stage (the range is the user\'s call; the integrated Lv 60 time is in the post-50 table)',
		modelled: 'not modelled: F.TARGET_WINDOWS has no Lv 60 entry',
		alternatives: ['no Lv 60 window (today)'],
		source: 'world design',
		why: 'the 50 -> 60 stage is the longest; a window would stop a later change from stretching it unnoticed',
	},
];

// ---------------------------------------------------------------------------------------------
// Report.
function buildReport() {
	const path = F.gearPath();
	return {
		...F.stamp(),
		gearPathSource: F.GEAR_PATH_SOURCE,
		method: `framework ${F.FRAMEWORK_VERSION}: per-cast figures from F.castOutcome / F.hourly on F.gearPath() (${F.GEAR_PATH_SOURCE}); lifecycle figures from the shared core (${I.REFERENCE_NOTE}; stress configurations in CONFIGS); post-60 curve-based (outside the integrated model)`,
		params: PARAMS,
		configs: Object.fromEntries(Object.entries(CONFIGS).map(([k, c]) => [k, c.label])),
		today: { oldRodValuePerFish: today() },
		valueModel: {
			table: valueTable(path),
			monotonicity: monotonicity(path),
			stageLadder: stageLadder(path),
			oldRodValuePerFish: Object.fromEntries(F.LIVE_BIOMES.map((b) => [b, round(biomeOutcome(b, path[0]).valuePerFish, 1)])),
		},
		permits: {
			formula: `permit(k) = nicePrice(${PARAMS.permits.stageShare} x stageHours(ref, level(k-1) -> level(k); integrated, no permits) x $/h(biome k-1, F.typicalTier(k-1), ref cadence))`,
			prices: permitPriceMap(),
			table: permitTable(),
			referenceStages: referenceStages(),
			sensitivity: sensitivity(),
			shareSweep: shareSweep(),
			levelTimes: levelTimes(),
		},
		budget: budget(),
		migration: {
			examples: MIGRATION_EXAMPLES.map((x) => {
				const g = grandfatheredPermits(x.user);
				return { ...x, grandfathered: g === null ? 'already migrated (no change)' : g.map((p) => p.biome) };
			}),
			recordShape: { biome: 'River', source: 'grandfathered or purchased', acquiredAt: 'Date', pricePaid: 0 },
		},
		mountainStream: mountainStream(path),
		postFifty: postFifty(),
		expansions: expansionSketch(),
		mirrorParity: mirrorParity(path),
		integration: integrationSection(),
		decisions: DECISIONS.map((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'get' && k !== 'expected'))),
		checks: checks(),
	};
}

let reportCache = null;
/** Every key number of docs/economy/5b/world.md, computed from the framework and the integrated model (cached). */
function report() {
	if (!reportCache) reportCache = buildReport();
	return reportCache;
}

// ---------------------------------------------------------------------------------------------
// Generated doc tables (render-docs.js): { blockId: markdown }. Every number table of world.md comes from here.
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const tierLabel = (t) => (t === 0 ? 'Old Rod' : `T${t}`);
const range = (xs, f) => `${f(Math.min(...xs))}–${f(Math.max(...xs))}`;

function markdownTables() {
	const R = report();
	const T = {};
	const archs = Object.keys(F.ARCHETYPES);
	const live = F.LIVE_BIOMES;
	const prices = R.permits.prices;
	const ptable = R.permits.table;
	const sens = R.permits.sensitivity;
	const vt = R.valueModel.table;
	const mono = R.valueModel.monotonicity;
	const ms = R.mountainStream;
	const pf = R.postFifty;
	const lt = R.permits.levelTimes;
	const share = PARAMS.permits.stageShare;
	const lastLive = live[live.length - 1];
	const homeTop = F.typicalTier(lastLive);
	const strongPremium = live.map((b) => vt[0].biomes[b].strongAccessValuePerFish / vt[0].biomes[b].weakOnlyValuePerFish);
	const refName = F.REFERENCE_ARCHETYPE;
	const priceList = PERMIT_BIOMES.map((b) => `${b} ${fmtMoney(prices[b])}`).join(' · ');
	const worstRodDelay = maxOf(Object.values(sens).map((s) => s.maxRodDelayH));
	const budgetRows = Object.values(R.budget);

	T['world-key-numbers'] = mdTable(['Key number', 'Value', 'Table'], [
		[`Permit prices (stage share ${fmtPct(share, 0)})`, priceList, '§3.3'],
		['Price, in hours of the income earned just before the level', range(ptable.map((p) => p.priceHoursOfStageIncome), (x) => `${x.toFixed(2)}`) + ' h', '§3.3'],
		['Payback in the new biome, hours of play', range(ptable.map((p) => p.paybackHours), (x) => `${x.toFixed(2)}`) + ' h', '§3.3'],
		[`Worst permit delay after reaching the level, in daily sessions: reference loop / harshest stress (${CONFIGS[STRESS].label.toLowerCase()})`, `${fmtNum(sens.reference.maxDelaySessions, 2)} / ${fmtNum(sens[STRESS].maxDelaySessions, 2)}`, '§3.4, §3.5'],
		['Lowest money held on reaching a level ÷ that permit\'s price: reference loop / harshest stress', `${fmtX(sens.reference.minCoverage, 1)} / ${fmtX(sens[STRESS].minCoverage, 1)}`, '§3.4, §3.5'],
		['Worst rod-tier delay caused by permits, any configuration', fmtH(worstRodDelay), '§3.5'],
		['Largest level-time change caused by permits (every archetype and milestone)', fmtH(lt.maxAbsDiffH), '§3.7'],
		[`${cap(refName)} player, reference loop: ${lt.levels.map((L) => `L${L}`).join(' / ')} (hours of play)`, lt.levels.map((L) => fmtNum(lt.archetypes[refName].with[L], 2)).join(' / '), '§3.7'],
		['Smallest same-tier income step between biomes / between tiers', `${fmtX(mono.minBiomeStepRatio, 3)} / ${fmtX(mono.minTierStepRatio, 3)}`, '§2.3'],
		['Strong premium on $/fish (weak + strong vs weak only, no stats)', range(strongPremium, (x) => fmtX(x)), '§2.2'],
		[`Permits as a share of all income to Lv ${F.LIFECYCLE.maxLevel} (reference loop)`, range(budgetRows.map((v) => v.permitsShare), (x) => fmtPct(x)), '§3.6'],
		['Mountain Stream: species (new) / top-tier $/h / same-tier step over Swamp (live band)', `${ms.speciesTotal} (${ms.newSpecies}) / ${fmtMoney(ms.byTier[ms.byTier.length - 1].cashPerHour)} / ${fmtX(ms.valueCheck.actualStep, 3)} (${ms.valueCheck.band.map((x) => fmtX(x, 3)).join('–')})`, '§5'],
		[`Lv ${pf.from} → ${pf.to}, hours of play (${archs.join(' / ')})`, archs.map((a) => fmtNum(pf.archetypes[a].stage.hours, 2)).join(' / '), '§6.1'],
	]);

	const endTier = R.postFifty.stageBeforeMountainStream.endgameTier;
	T['world-current-proposed'] = mdTable(['Item', 'Current', 'Proposed', 'Rationale'], [
		['Biome access', 'Level only. `/biome` checks the level; the cast engine checks nothing.', `**Gate level ≥ biome level and a permit** (${PARAMS.permits.free.join(', ')} free). One-time, account-bound, never expires, no chain.`, 'User decision 3: a milestone purchase alongside the level.'],
		['Permit prices', 'none', priceList, `${fmtPct(share, 0)} of the reference player's expected fish income in the previous stage (§3.2). Affordable at the level for every archetype (§3.4).`],
		['Existing players', '—', 'Grandfathered permits for every biome they already qualify for, plus their current biome (§4)', 'Nobody loses access.'],
		['Biome value ladder (Old Rod $/fish)', `Measured today: ${live.map((b) => `${b} ${fmtNum(R.today.oldRodValuePerFish[b], 1)}`).join(', ')}`, `Framework value model: ${live.map((b) => fmtNum(R.valueModel.oldRodValuePerFish[b], 1)).join(' / ')}`, 'Each biome pays more than the one before, at every tier (§2).'],
		['Weak vs strong', 'The weak/strong split halves every biome until strong is unlocked (PHASE5_REPORT §7.1)', `Strong premium ${range(strongPremium, (x) => fmtX(x))} with no stats (§2.2)`, 'Crafted rods (always weak + strong) earn more, without a cliff.'],
		['Mountain Stream', `${ms.today.species.length} Ultra salmon (weather-exclusive, strong only). No Biome document, so it can't be reached.`, `Lv ${ms.level} expansion biome: ${ms.speciesTotal} species (${ms.newSpecies} new), one Ultra salmon per weather, permit ${fmtMoney(prices[MS])}. BIOME_VALUE ${ms.biomeValue} (P-MS-VALUE). Not implemented now.`, 'User decision 11. Keeps the existing salmon.'],
		[`After Lv ${pf.from}`, 'Nothing to unlock', `${pf.from}→${pf.to} stage: the ${tierLabel(endTier)} set and the Mountain Stream permit; expansions sketched at ${PARAMS.expansions.map((e) => e.level).join('/')}.`, `Gives the longest stage (${fmtNum(pf.archetypes[refName].stage.hours, 2)} h for the ${refName} player) its goals.`],
	]);

	const stepLabel = (row) => (row.tier === 0 ? 'Old Rod' : `T${row.tier} (Lv ${row.level}, ${fmtNum(row.meanFish, 2)} fish)`);
	T['world-value-per-fish'] = mdTable(['Gear', ...live], vt.map((row) => [stepLabel(row), ...live.map((b) => fmtNum(row.biomes[b].valuePerFish, 1))]));
	T['world-value-per-hour'] = mdTable(['Gear', 'XP/h', ...live], vt.map((row) => {
		const home = F.biomeAt(row.level);
		return [tierLabel(row.tier), fmtNum(row.biomes[live[0]].xpPerHour), ...live.map((b) => (b === home && row.tier > 0 ? `**${fmtNum(row.biomes[b].cashPerHour)}**` : fmtNum(row.biomes[b].cashPerHour)))];
	}));
	const topRow = vt.find((row) => row.tier === homeTop.tier);
	T['world-strong-weak'] = mdTable(['', ...live], [
		['Today, Old Rod $/fish (measured)', ...live.map((b) => fmtNum(R.today.oldRodValuePerFish[b], 1))],
		['Weak-only $/fish (Old Rod)', ...live.map((b) => fmtNum(vt[0].biomes[b].weakOnlyValuePerFish, 1))],
		['Weak + strong $/fish (no stats)', ...live.map((b) => fmtNum(vt[0].biomes[b].strongAccessValuePerFish, 1))],
		['Strong premium', ...strongPremium.map((x) => fmtX(x))],
		[`${tierLabel(homeTop.tier)} weak-only $/fish`, ...live.map((b) => fmtNum(topRow.biomes[b].weakOnlyValuePerFish, 1))],
		[`${tierLabel(homeTop.tier)} weak + strong $/fish`, ...live.map((b) => fmtNum(topRow.biomes[b].strongAccessValuePerFish, 1))],
	]);
	T['world-value-checks'] = mdTable(['Check (`monotonicity()`)', 'Result'], [
		['$/fish and $/cast rise strictly with biome at every tier (weak only, weak + strong, own access)', mono.ok ? `pass (${mono.failures.length} failures)` : `FAIL (${mono.failures.length})`],
		['Smallest same-tier biome step ($/cast)', fmtX(mono.minBiomeStepRatio, 3)],
		['Smallest tier step ($/h, same biome)', fmtX(mono.minTierStepRatio, 3)],
		['XP per cast across live biomes (relative to Ocean, min–max)', `${fmtNum(mono.xpPerCastBiomeSpread[0], 4)}–${fmtNum(mono.xpPerCastBiomeSpread[1], 4)}`],
	]);
	T['world-stage-ladder'] = mdTable(['Biome', 'Level', 'Tier', '$/fish', '$/h', 'Step over previous home', 'Step over previous, same tier'], R.valueModel.stageLadder.map((s) => [
		s.proposed ? `*${s.biome} (proposed)*` : s.biome, s.level, tierLabel(s.tier), fmtNum(s.valuePerFish, 1), fmtNum(s.cashPerHour),
		s.stepOverPrevHome === null ? '—' : fmtX(s.stepOverPrevHome), s.stepOverPrevSameTier === null ? '—' : fmtX(s.stepOverPrevSameTier, 3),
	]));

	T['world-permit-table'] = mdTable(['Permit', 'Level', 'Stage before (biome, gear)', 'Stage hours (ref)', 'Stage $/h (ref)', 'E(k)', 'Fish income the integrated run earned in the stage', '**Price**', '= hours of stage income', 'Extra $/h in the new biome (gear at level)', 'Payback (h of play)'], ptable.map((p) => [
		p.biome, p.level, `${p.stageBiome}, ${tierLabel(p.stageTier)}`, fmtNum(p.stageHoursReference, 2), fmtMoney(p.stageCashPerHourReference), fmtMoney(p.stageEarningsReference), fmtMoney(p.integratedStageFishIncome),
		`**${fmtMoney(p.price)}**`, fmtNum(p.priceHoursOfStageIncome, 2), `${fmtMoney(p.gainPerHourWithGearAtLevel)} (${tierLabel(p.gearAtLevel)})`, fmtNum(p.paybackHours, 2),
	]));
	T['world-time-to-afford'] = mdTable(['Permit', ...archs.map((a) => `${cap(a)} (${fmtNum(F.ARCHETYPES[a].minutesPerDay, Number.isInteger(F.ARCHETYPES[a].minutesPerDay) ? 0 : 1)} min/day)`)], ptable.map((p) => [p.biome, ...archs.map((a) => {
		const x = p.lifecycle[a];
		if (!x) return '—';
		return `${fmtH(x.reachedH)} / d${x.reachedDay} · **${x.delaySessions === null ? 'not bought' : fmtNum(x.delaySessions, 2)}** · ${fmtX(x.coverageAtLevel, 1)}`;
	})]));
	T['world-standalone'] = mdTable(['Permit', ...archs.map(cap)], ptable.map((p) => [p.biome, ...archs.map((a) => `${fmtH(p.standaloneHoursToAfford[a].hours)} (${fmtNum(p.standaloneHoursToAfford[a].sessions, 2)})`)]));
	T['world-sensitivity'] = mdTable(['Configuration', `Worst permit delay, sessions (${archs.join(' / ')})`, 'Lowest money at the level ÷ price', 'Worst rod-tier delay vs no permits'], Object.entries(sens).map(([k, s]) => [
		k === 'reference' ? `**${s.label}**` : s.label,
		archs.map((a) => fmtNum(s.archetypes[a].maxDelaySessions, 2)).join(' / '),
		fmtX(s.minCoverage, 1),
		fmtH(s.maxRodDelayH),
	]));
	T['world-share-sweep'] = mdTable(['Share', PERMIT_BIOMES.join(' / '), `${CONFIGS.reference.label}: worst delay (sessions) · lowest coverage`, `${CONFIGS[STRESS].label}: worst delay (sessions) · lowest coverage`], R.permits.shareSweep.map((row) => {
		const cell = (c) => `${fmtNum(maxOf(Object.values(row[c].maxDelaySessions)), 2)} · ${fmtX(row[c].minCoverage, 1)}`;
		const label = row.share === share ? `**${fmtPct(row.share, 0)} (proposed)**` : fmtPct(row.share, 0);
		return [label, PERMIT_BIOMES.map((b) => fmtNum(row.prices[b])).join(' / '), cell('reference'), cell(STRESS)];
	}));
	T['world-budget'] = mdTable(['Player', `All income to Lv ${F.LIFECYCLE.maxLevel}`, 'From fishing', 'Upkeep (repairs)', 'Rods (progression)', 'Permits (progression)', 'Permits ÷ fish income', 'Saved'], archs.map((a) => {
		const v = R.budget[a];
		return [cap(a), fmtMoney(v.income), fmtPct(v.fishingShare), fmtPct(v.upkeepShare), fmtPct(v.rodsShare), fmtPct(v.permitsShare), fmtPct(v.permitsShareOfFishIncome), `${fmtPct(v.savedShare)} (${fmtMoney(v.saved)})`];
	}));
	T['world-level-times'] = mdTable(['Player', ...lt.levels.map((L) => `L${L}`), 'Largest change from permits'], [
		...archs.map((a) => [cap(a), ...lt.levels.map((L) => fmtNum(lt.archetypes[a].with[L], 2)), fmtH(lt.archetypes[a].maxAbsDiffH, 4)]),
		[`R1 record (\`curve-integrated.json\`, ${refName}, quartic ${lt.r1Record.quartic})`, ...lt.levels.map((L) => fmtNum(lt.r1Record.regular[L], 2)), `record vs this run: ${fmtH(lt.r1Record.maxAbsDiffH, 4)}`],
	]);

	T['world-migration'] = mdTable(['Account', 'Grandfathered'], R.migration.examples.map((x) => [
		`Lv ${x.user.level}, ${fmtNum(x.user.xp)} XP, current biome ${x.user.currentBiome}${x.user.permits ? ', `permits: []` already present' : ''}`,
		Array.isArray(x.grandfathered) ? (x.grandfathered.length ? x.grandfathered.join(', ') : 'none (Ocean is free)') : 'no change (idempotent)',
	]));

	const td = ms.today;
	T['world-ms-today'] = mdTable(['Today\'s biome in the real engine (`engineCatch()`)', 'Value'], [
		['Species', td.species.join('; ')],
		['Old Rod cast lands a fish', fmtPct(td.oldRodFishProbability, 2)],
		['Old Rod cast lands anything (a Lucky item)', fmtPct(td.oldRodCatchProbability, 3)],
		[`Endgame (${tierLabel(F.gearPath().length - 1)}) cast lands a fish`, fmtPct(td.topTierFishProbability)],
		['By weather', Object.entries(td.topTierFishProbabilityByWeather).map(([w, p]) => `${w} ${fmtPct(p)}`).join(', ')],
		['Proposed ladder, same cast', fmtPct(td.proposedFishProbability)],
	]);
	const ultraNames = ms.perWeatherAtTopTier.map((x) => `${x.premiumUltra.join(', ')} (${x.weather})`).join('; ');
	T['world-ms-ladder'] = mdTable(['Rarity', 'Species', 'Weak', 'Strong', 'Weather-exclusive', 'Notes'], [
		...RARITIES.filter((r) => ms.counts[r]).map((r) => {
			const c = ms.counts[r];
			return [r === 'ultra' ? '**Ultra (premium)**' : cap(r), c.total, c.weak, c.strong, c.weatherExclusive, r === 'ultra' ? `One strong salmon per weather: ${ultraNames}. Existing: ${ms.keptSpecies.join('; ')}.` : ''];
		}),
		['**Total**', `**${ms.speciesTotal}** (${ms.newSpecies} new)`, RARITIES.reduce((t, r) => t + (ms.counts[r]?.weak || 0), 0), RARITIES.reduce((t, r) => t + (ms.counts[r]?.strong || 0), 0), RARITIES.reduce((t, r) => t + (ms.counts[r]?.weatherExclusive || 0), 0), ''],
	]);
	T['world-ms-by-tier'] = mdTable(['Gear', '$/fish', 'Weak-only $/fish', '$/h', 'XP/h', 'Over Swamp, same tier'], ms.byTier.map((row) => [tierLabel(row.tier), fmtNum(row.valuePerFish, 1), fmtNum(row.weakOnlyValuePerFish, 1), fmtNum(row.cashPerHour), fmtNum(row.xpPerHour), fmtX(row.stepOverSwamp, 3)]));
	T['world-ms-weather'] = mdTable(['Weather', 'Share of time', 'Premium Ultra', 'Today: fish per cast', 'Proposed catch', '$/fish', '$/h'], ms.perWeatherAtTopTier.map((x) => [
		x.weather, fmtPct(x.envShare), x.premiumUltra.join(', '), fmtPct(td.topTierFishProbabilityByWeather[x.weather]), fmtPct(x.catchProbability, 0), fmtNum(x.valuePerFish, 1), fmtNum(x.cashPerHour),
	]));
	const vc = ms.valueCheck;
	T['world-ms-value'] = mdTable(['BIOME_VALUE rule (`mountainStream().valueCheck`)', 'Value'], [
		['Modelled BIOME_VALUE[\'Mountain Stream\'] (decisions.js P-MS-VALUE)', fmtNum(ms.biomeValue)],
		['Live late-ladder same-tier steps at the endgame tier (River→Lake … Coast→Swamp)', vc.lateLiveSameTierSteps.map((x) => fmtX(x, 3)).join(', ')],
		['Band / mean', `${vc.band.map((x) => fmtX(x, 3)).join('–')} / ${fmtX(vc.targetStep, 3)}`],
		['Mountain Stream step over Swamp, same tier', `${fmtX(vc.actualStep, 3)} (${vc.inBand ? 'inside the band' : 'outside the band'})`],
		['Home step over Swamp (endgame tier vs Swamp\'s typical tier)', fmtX(vc.homeStepOverSwamp, 3)],
		['Value that puts the step at the band mean', fmtNum(vc.impliedBiomeValue, 1)],
		...(vc.atAlternative ? [[`At the alternative value ${vc.atAlternative.biomeValue}: step / home step`, `${fmtX(vc.atAlternative.stepOverSwamp, 3)} (${vc.atAlternative.inBand ? 'inside' : 'outside'} the band) / ${fmtX(vc.atAlternative.homeStepOverSwamp, 3)}`]] : []),
	]);
	const sb = pf.stageBeforeMountainStream;
	const msOwned = archs.map((a) => ptable.find((p) => p.biome === MS).lifecycle[a]);
	T['world-ms-stage'] = mdTable([`The ${pf.from}→${pf.to} stage (\`postFifty().stageBeforeMountainStream\`, ${refName})`, 'Value'], [
		['Stage (biome, gear)', `${sb.biome}, ${tierLabel(sb.tier)}`],
		['Hours of play (integrated) · $/h · expected earnings E', `${fmtNum(sb.hours, 2)} h · ${fmtMoney(sb.cashPerHour)} · ${fmtMoney(sb.earnings)}`],
		[`${tierLabel(sb.endgameTier)} assembly (expected) · share of E`, `${fmtMoney(sb.endgameTierAssembly)} · ${fmtPct(sb.endgameTierShareOfStage)}`],
		['Mountain Stream permit · share of E', `${fmtMoney(sb.permit)} · ${fmtPct(sb.permitShareOfStage)}`],
		[`Mountain Stream permit delay after reaching Lv ${pf.to}, sessions (${archs.join(' / ')})`, msOwned.map((x) => (x ? fmtNum(x.delaySessions, 2) : '—')).join(' / ')],
		[`${tierLabel(sb.endgameTier)} fishing after reaching Lv ${pf.to}, hours (${archs.join(' / ')})`, archs.map((a) => fmtH(pf.archetypes[a].endTierEquipDelayH)).join(' / ')],
	]);

	const spans = pf.archetypes[refName].sketch.map((s) => `L${s.from} → L${s.to}*`);
	T['world-post50'] = mdTable(['Player', `Reach L${pf.from}`, `Reach L${pf.to}`, `**L${pf.from} → L${pf.to}** (integrated)`, 'XP/h in that stage (fishing share)', 'Post-60 XP/h used*', ...spans], archs.map((a) => {
		const v = pf.archetypes[a];
		return [
			cap(a), `${fmtH(v.reach[pf.from].hours)} (d${v.reach[pf.from].day})`, `${fmtH(v.reach[pf.to].hours)} (d${v.reach[pf.to].day})`,
			`**${fmtH(v.stage.hours)} (${fmtNum(v.stage.days, 1)} days)**`, `${fmtNum(v.xpRate.stage)} (${fmtPct(v.xpRate.fishingShare, 0)})`, fmtNum(v.xpRate.post60),
			...v.sketch.map((s) => `${fmtH(s.hours)} (${fmtNum(s.days, 1)} d)`),
		];
	}));
	const perLevel = Object.entries(pf.perLevelHoursReference);
	T['world-per-level'] = mdTable(['Level', ...perLevel.map(([L]) => L)], [['Hours', ...perLevel.map(([, h]) => fmtNum(h, 2))]]);
	const stages = pf.stageHoursReference;
	T['world-stage-lengths'] = mdTable(['Stage', ...stages.map((s) => (s.source === 'integrated' ? s.stage.replace('-', '–') : `${s.stage.replace('-', '–')}*`))], [
		['Hours', ...stages.map((s) => fmtNum(s.hours, 2))],
		['Ratio to previous', ...stages.map((s) => (s.ratio === null ? '—' : fmtX(s.ratio)))],
	]);
	const ex = R.expansions;
	T['world-expansions'] = mdTable(['Biome', 'Level', 'Water', 'Identity', 'Indicative BIOME_VALUE (geometric step)', 'Stage before it (regular, sketch)', 'Indicative permit (same rule)'], ex.biomes.map((e) => [
		e.biome, e.level, e.water, e.identity, `${fmtNum(e.indicativeBiomeValue)} (${fmtX(ex.valueStep, 3)})`, fmtH(e.stageHoursReference), `≈ ${fmtMoney(e.indicativePermit)}`,
	]));
	const par = RETIRED_LOOP_PARITY;
	T['world-parity'] = mdTable(['Retired private loop (`RETIRED_LOOP_PARITY`)', 'Recorded value'], [
		['Commit', `\`${par.commit}\``],
		['Check', par.check],
		['Largest relative difference', `${fmtPct(par.maxRelativeDifference, 4)} (${par.recorded})`],
		['Time to afford through the core / permit prices from the core\'s stage hours', `${par.timeToAffordIdentical ? 'identical' : 'different'} / ${par.pricesFromCoreIdentical ? 'identical' : 'different'}`],
		['Remaining difference', par.remainingDifference],
	]);
	const fmtVal = (v) => {
		if (v === null || v === undefined) return '—';
		if (typeof v === 'number') return Number.isFinite(v) ? fmtNum(v, Number.isInteger(v) ? 0 : Math.abs(v) < 0.01 ? 6 : 3) : 'not bought';
		if (Array.isArray(v)) return v.map(fmtVal).join(', ');
		return Object.entries(v).map(([k, x]) => `${k} ${fmtVal(x)}`).join('; ');
	};
	T['world-checks'] = mdTable(['Check (`checks()`)', 'Value', 'Result'], R.checks.map((c) => [c.check, fmtVal(c.value), c.ok ? 'pass' : '**FAIL**']));
	T['world-decisions'] = mdTable(['ID', 'Proposed decision', 'Modelled', 'Alternatives', 'Why'], DECISIONS.map((d) => [
		`\`${d.id}\` (${d.status})`, d.title, d.get ? `${d.modelled}: \`${JSON.stringify(d.get())}\`` : d.modelled, d.alternatives.join('; '), d.why,
	]));
	return T;
}

module.exports = { formulaPermitPrice,
	PARAMS, DECISIONS, CONFIGS, RETIRED_LOOP_PARITY,
	system, permitPriority, permitSummary,
	lifecycle, referenceStages, permitPrice, permitPriceMap, permitTable, timeToAfford, sensitivity, shareSweep, budget, levelTimes,
	accessibleBiomes, canFish, grandfatheredPermits,
	gearStep, biomeOutcome, biomeHourly, valueTable, monotonicity, stageLadder,
	ladderSpecies, currentMountainStream, liveSpecies, ladderDraw, ladderOutcome, engineCatch, mirrorParity, mountainStream,
	postFifty, expansionSketch, today, checks, report, markdownTables,
};

if (require.main === module) process.stdout.write(`${JSON.stringify(report(), null, 1)}\n`);
