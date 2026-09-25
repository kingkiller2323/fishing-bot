// Phase 5B subsystem: AQUARIUM, PETS and AQUARIUM LICENSES. ANALYSIS ONLY: nothing here touches the live
// game, src/ or production data.
//
// Every economic number is computed at runtime from the shared framework (./framework.js, which
// re-exports assumptions.js: archetypes, lifecycle step, daily XP placeholder, purchase delay, biome
// levels, gear path) and from the finished rods design (./rods.js crate/assembly costs and its repair
// upkeep share; rods is NOT used as a gear source, R3). Only the design parameters in PARAMS are hand-set,
// and prices are formulas of stage income, so a framework version bump regenerates every figure.
//
//   node -e "require('./scripts/economy/5b/aquarium.js').report()"     (returns the report object)
//   node scripts/economy/5b/aquarium.js                                  (prints it as JSON)
//
// Exports (pure and synchronous; no database, no randomness):
//   PARAMS                       frozen design parameters: water types, license tiers (gate level, tanks,
//                                tank size, companion slots, price in hours of stage income), companion bonus,
//                                care/bond rules, temperature, pet sale formula, breeding, display tanks,
//                                upkeep decision, model settings and design targets
//   CURRENT                      frozen mirror of TODAY's rules (src/class/Pet.js, Aquarium.js, pet.js,
//                                licenses.js) used only to quantify the current exploits
//   waterOf(biome)               'Freshwater' | 'Saltwater' | null
//   stageAt(level, {overheadS})  F.castOutcome/F.hourly at the biome and shared gear tier of a level
//   licensePrice(tier)           proposed price: PARAMS priceHours x the gate stage's income (2 sig. digits)
//   licenses()                   the six proposed license rows (both water types x 3 tiers)
//   licenseByName(name)          proposed definition for an existing catalog license name (read-time rules)
//   bondFactor(bondXp)           share of a pet's companion bonus unlocked by its bond (0.5 -> 1.0)
//   perPetBonus(rarity, opts)    one pet's companion sell bonus ({ bondXp, thriving })
//   companionSlots(holdings)     companion slots of a holding { Freshwater: tier|null, Saltwater: tier|null }
//   companionBonus(pets, opts)   total companion bonus of a player's pets: best `slots` thriving pets count
//   holdingsBonus(holdings, o)   INTEGRATOR: the sellBonus a holding gives for a pet mix ({ mix, bond, care })
//   thriving(state)              the proposed "thriving" rule for one pet ({ hoursSinceFed, cleanliness,
//                                temperatureC }) plus hours until it stops thriving
//   effectiveTemperature(c)      stored tank temperature read under the proposed rules (clamped, no drift)
//   petSaleValue(pet)            proposed pet sale value ({ speciesValue, ageDays, bred, attraction, thriving })
//   speciesValue(name|template)  F.proposedValue of a catalog species
//   breedingRate(stress, health) today's success-rate formula (kept) and its current vs fixed probability
//   petIncomeBound(opts)         upper bound on weekly cash from breeding + selling for a capacity/species value
//   availability(level)          fish of each rarity caught per hour at a level (pet supply)
//   aquariumOptions(level, o)    INTEGRATOR ENTRY POINT: what a player can buy at `level` given what they own:
//                                [{ kind, name, waterType, tier, price, upkeepPerDay, benefit, capacityAfter }]
//   displayTanks()               aspirational sink: display-tank prices and time to afford per archetype
//   lifecycle(archetype, opts)   curve.js-style lifecycle (identical XP timeline) with money: rods first
//                                (rods.assembly costs + repair upkeep), licenses bought when affordable,
//                                companion bonus with bond ramp; purchases, payback, shares of income
//                                (5b.3: superseded by system(); kept until the old loops are retired)
//   baselineMatchesCurveJson()   the lifecycle reproduces docs/economy/5b/curve.json milestone hours exactly
//                                (on F.PROVISIONAL_GEAR_PATH, the path curve.json was fitted on)
//   system(opts)                 framework 5b.3: this subsystem as a lifecycle.js SYSTEM (fresh object per
//                                call): licenses ('optional') and display tanks ('aspirational') as
//                                non-blocking goals from aquariumOptions(), the companion sell bonus with its
//                                bond ramp in modifyCast, no XP effect (see the system() comment)
//   systemSummary(result)        the aquarium's figures from a lifecycle.js result (purchases, payback,
//                                companion cash, shares of income)
//   validateSystem()             system() on the shared core vs lifecycle() (every archetype; other-spend,
//                                mix, care and water variants), the no-XP check, the gear-rule sensitivity
//                                and the aquarium on the integrated reference loop (integrate.run)
//   lifecycleMoney, lifecycleReserve, coreLifecycle
//                                validation baselines: lifecycle()'s gear rule, money and rods-first reserve
//                                as systems on the shared core
//   currentExploit()             today's /pet play -> /pet sell money rate, breeding odds, temperature factors
//   currentLicenses()            today's license catalog priced in hours of proposed stage income
//   upkeepAlternatives()         why no money upkeep: a flat daily fee as a share of the bonus per archetype
//   checks()                     design-target checks (pass/fail)
//   report()                     every number in docs/economy/5b/aquarium.md (cached), with ...F.stamp();
//                                report().system: the system's contract and validateSystem()
const F = require('./framework');
const LC = require('./lifecycle');
// rods: crate assembly costs, crate unlock levels and the repair upkeep share (never its gear path).
const rods = require('./rods');
const { FISH, drawDistribution } = require('../lib/catalog-model');
const { RARITIES } = require('../../../src/engine/balance');
const LICENSE_CATALOG = require('../../../src/bootstrap/data/licenses');
const MEASURED = require('../../../docs/economy/measurements.json');
const CURVE_JSON = require('../../../docs/economy/5b/curve.json');

const deepFreeze = (o) => {
	for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
	return Object.freeze(o);
};
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const sig = (x, n = 2) => {
	if (!x) return 0;
	const p = 10 ** (Math.floor(Math.log10(Math.abs(x))) - n + 1);
	return Math.round(x / p) * p;
};

// ---------------------------------------------------------------------------------------------
// Design parameters (the only hand-set values in this module).
const PARAMS = deepFreeze({
	id: 'aquarium-5b',
	// Water type of each biome: today's Aquarium.compareBiome, plus Mountain Stream (freshwater salmon).
	waterOf: { Ocean: 'Saltwater', Coast: 'Saltwater', River: 'Freshwater', Lake: 'Freshwater', Pond: 'Freshwater', Swamp: 'Freshwater', 'Mountain Stream': 'Freshwater' },
	licenses: {
		order: ['basic', 'advanced', 'expert'],
		// Gate levels sit every 15 levels. Prerequisites stay as today (Basic -> Advanced -> Expert per water type).
		// tanks x tankSize = pets of that water type. companionSlots = pets whose bonus counts (best tier held).
		// priceHours = hours of the gate stage's income (regular cadence, the shared gear tier at that level).
		tiers: {
			basic: { label: 'Basic', level: 15, tanks: 1, tankSize: 3, companionSlots: 2, priceHours: 2 },
			advanced: { label: 'Advanced', level: 30, tanks: 2, tankSize: 4, companionSlots: 5, priceHours: 2.5 },
			expert: { label: 'Expert', level: 45, tanks: 3, tankSize: 5, companionSlots: 9, priceHours: 3 },
		},
		waterTypes: ['Freshwater', 'Saltwater'],
		// A second water type costs the same and adds tanks (collection, breeding, display), not companion slots.
		secondWaterAddsSlots: false,
		roundSig: 2,
	},
	companion: {
		// Thriving pets add to the cast's sellBonus stat (the modifier pipeline's reserved pets/aquarium source).
		// Cash only: no XP, rarity or multi-catch effect, so the curve windows (R1) and R2 are untouched.
		stat: 'sellBonus',
		perPet: { common: 0.0025, uncommon: 0.003, rare: 0.0035, ultra: 0.004, giant: 0.0045, legendary: 0.005, lucky: 0.0055 },
		// Bond (the pet XP field) ramps a pet from half to full bonus; care is the only bond source.
		bond: { minFactor: 0.5, maxXp: 700, xpPerCare: 50 },
		// A pet thrives when fed within fedWithinH hours, its tank is at least minCleanliness clean, and the
		// tank is within temperatureBandC of the ideal. One care session a day keeps every pet thriving.
		thrive: { fedWithinH: 30, minCleanliness: 50, temperatureBandC: 3 },
	},
	care: {
		// Care actions grant bond XP only off cooldown (per pet); /aquarium feed feeds every pet off cooldown.
		feedCooldownH: 8,
		playCooldownH: 8,
		// Lifecycle model: one feed and one play per pet per play day.
		actionsPerDayModel: 2,
	},
	temperature: {
		// One ideal for every formula (hunger already uses 25 C; mood/stress/health used 0 C). The heater holds
		// the set temperature (the unbounded +1 C/h drift is removed); stored values are read clamped to the
		// /aquarium adjust range, and new tanks start at the ideal.
		idealC: 25,
		adjustRangeC: [-30, 30],
		newTankC: 25,
		driftPerHour: 0,
	},
	cleanliness: { decayPerHour: 1 },
	sale: {
		// Sale value = species value (F.proposedValue) x age x origin x condition x (1 + attraction%).
		// Pet XP no longer converts to cash. Max = 1.25 x species value (wild, 28+ days, attraction 25).
		fullValueAgeDays: 28,
		minAgeFactor: 0.25,
		bredFactor: 0.5,
		notThrivingFactor: 0.5,
		attractionPerPoint: 0.01,
		maxAttraction: 25,
		// Rehoming limit: at most this many pet sales per 7 days (bounds pet income whatever the capacity).
		maxPerWeek: 3,
	},
	breeding: {
		// Today's success-rate formula is kept (it yields 10-65%); the bug is the percent comparison.
		minAgeDays: 20,
		minHealth: 50,
		cooldownDays: 7,
		// Babies need a free slot in the chosen tank and are marked bred (half sale value).
	},
	display: {
		// Aspirational sink: extra display tanks for an Expert water type. Capacity only (no companion slots),
		// priced in hours of the top live stage's income, doubling per tank.
		requires: 'expert',
		perWaterType: 3,
		tankSize: 5,
		firstPriceHours: 3,
		growth: 2,
	},
	upkeep: {
		// Decision: no money upkeep. Care (attention) is the upkeep; see upkeepAlternatives() for why a flat
		// daily fee is regressive. The alternative fee is sized at this share of the reference player's bonus.
		moneyPerDay: 0,
		alternativeShareOfReferenceBonus: 0.25,
	},
	model: {
		primaryWater: 'Freshwater',
		typicalMix: 'legendary',
		mixes: ['common', 'rare', 'legendary', 'lucky'],
		care: 1,
		otherSpendShares: [0, 0.15, 0.3],
		incomeBoundParents: ['legendary', 'lucky'],
	},
	targets: {
		// Checked by checks(): the aquarium stays a small, bounded, optional system.
		maxCompanionBonus: 0.05,
		maxPetIncomeShareRegular: 0.05,
		maxPetIncomeShareCasual: 0.1,
		// Hours of play after purchase for the reference player to earn a license back (higher tiers are luxuries).
		paybackHoursRegular: { basic: 60, advanced: 90, expert: 120 },
	},
});

// Today's rules, mirrored from src (for the exploit and bug numbers only). A test should keep the trait
// weights equal to Pet.generateTraits.
const CURRENT = deepFreeze({
	commandCooldownS: 3,
	careXp: 50,
	// Pet.calculateMultiplier (XP) and Pet.calculateAttraction (sale) contributions per trait.
	traits: {
		color: { weights: { Normal: 10000, Golden: 5000, Platinum: 2000, Diamond: 1000, Rainbow: 50, Striped: 7500, Spotted: 7500 }, attraction: { Golden: 5, Platinum: 10, Diamond: 15, Rainbow: 20, Striped: 5, Spotted: 5 }, multiplier: { Golden: 0.1, Platinum: 0.2, Diamond: 0.3, Rainbow: 0.4 }, unlockAgeDays: 14 },
		finShape: { weights: { 'Rounded Fins': 10, 'Pointed Fins': 5, 'Frilly Fins': 5 }, attraction: { 'Frilly Fins': 5 }, multiplier: { 'Pointed Fins': 0.1, 'Frilly Fins': 0.1 }, unlockAgeDays: 7 },
		finSize: { weights: { 'Long Fins': 10, 'Short Fins': 10 }, attraction: {}, multiplier: { 'Long Fins': 0.2 }, unlockAgeDays: 7 },
	},
	licenseSizes: 'licenses.js aquarium.size: tank capacity; no limit on the number of tanks',
	driftPerHour: 1,
	temperatureIdeal: { hunger: 25, mood: 0, stress: 0, health: 0 },
});

const TIERS = PARAMS.licenses.order;
const WATER_TYPES = PARAMS.licenses.waterTypes;
const waterOf = (biome) => PARAMS.waterOf[biome] || null;
const archOf = (a) => (typeof a === 'string' ? { name: a, ...F.ARCHETYPES[a] } : a);
const hoursPerDay = (a) => archOf(a).minutesPerDay / 60;
const REFERENCE = archOf(F.REFERENCE_ARCHETYPE);

// ---------------------------------------------------------------------------------------------
// Stage income (framework): the biome unlocked at a level with the shared gear tier held at that level.
const rateCache = new Map();
function gearRates(biome, tier, overheadS) {
	// Keyed by the tier's content, not its key: the shared (rods) and provisional paths reuse 't1'..'t5'.
	const key = `${biome}|${tier.key}|${tier.meanFish}|${tier.qualities.join(',')}|${JSON.stringify(tier.stats)}|${overheadS}`;
	if (!rateCache.has(key)) {
		const outcome = F.castOutcome({ biome, qualities: tier.qualities, stats: tier.stats, multiChance: F.chanceForMean(tier.meanFish) });
		rateCache.set(key, { ...F.hourly(outcome, overheadS), outcome, gearSell: tier.stats.sellBonus || 0 });
	}
	return rateCache.get(key);
}
// The shared gear path, read once: F.gearPath() rebuilds rods' path (crate odds) on every call, and it is
// deterministic, so stage lookups (stageAt, aquariumOptions every purchase pass) reuse it.
let sharedPathCache = null;
const sharedPath = () => sharedPathCache || (sharedPathCache = F.gearPath());
function stageAt(level, { overheadS = F.DESIGN_OVERHEAD_S } = {}) {
	const tier = F.tierAt(level, sharedPath());
	const biome = F.biomeAt(level);
	const r = gearRates(biome, tier, overheadS);
	return { level, biome, water: waterOf(biome), tier: tier.key, cashPerHour: r.cash, xpPerHour: r.xp, fishPerHour: r.fish, castsPerHour: r.casts, gearSell: r.gearSell, outcome: r.outcome };
}
/** Extra cash per hour a companion sellBonus adds on top of a gear outcome (sellBonus stats add). */
const companionCash = (cashPerHour, gearSell, bonus) => (cashPerHour * bonus) / (1 + gearSell);

// ---------------------------------------------------------------------------------------------
// Licenses.
function licensePrice(tierKey) {
	const t = PARAMS.licenses.tiers[tierKey];
	return sig(t.priceHours * stageAt(t.level).cashPerHour, PARAMS.licenses.roundSig);
}
const licenseName = (tierKey, water) => `${PARAMS.licenses.tiers[tierKey].label} ${water} Aquarium License`;
function licenses() {
	const rows = [];
	for (const water of WATER_TYPES) {
		TIERS.forEach((k, i) => {
			const t = PARAMS.licenses.tiers[k];
			const s = stageAt(t.level);
			const current = LICENSE_CATALOG.find((l) => l.name === licenseName(k, water));
			rows.push({
				name: licenseName(k, water), water, tier: k, prerequisite: i ? licenseName(TIERS[i - 1], water) : null,
				level: t.level, tanks: t.tanks, tankSize: t.tankSize, capacity: t.tanks * t.tankSize, companionSlots: t.companionSlots,
				price: licensePrice(k), priceHours: t.priceHours, gateStage: { biome: s.biome, tier: s.tier, cashPerHour: Math.round(s.cashPerHour) },
				typicalBonus: r4(t.companionSlots * PARAMS.companion.perPet[PARAMS.model.typicalMix]), maxBonus: r4(t.companionSlots * PARAMS.companion.perPet.lucky),
				upkeepPerDay: PARAMS.upkeep.moneyPerDay,
				current: current ? { price: current.price, level: current.requirements.level, size: current.aquarium.size, tanks: 'unlimited' } : null,
			});
		});
	}
	return rows;
}
/** Proposed definition for an existing catalog license (engine reads it by name: LICENSE_DEFS). */
function licenseByName(name) {
	return licenses().find((l) => l.name === name) || null;
}

// ---------------------------------------------------------------------------------------------
// Companion bonus (the benefit loop).
function bondFactor(bondXp) {
	const b = PARAMS.companion.bond;
	return b.minFactor + (1 - b.minFactor) * Math.min(1, Math.max(0, bondXp || 0) / b.maxXp);
}
/** Days of care for a new pet to reach full bond under the model (one feed + one play per day). */
const bondDays = () => PARAMS.companion.bond.maxXp / (PARAMS.companion.bond.xpPerCare * PARAMS.care.actionsPerDayModel);
const bondFactorAfterDays = (days) => bondFactor(Math.max(0, days) * PARAMS.companion.bond.xpPerCare * PARAMS.care.actionsPerDayModel);
function perPetBonus(rarity, { bondXp = PARAMS.companion.bond.maxXp, thriving: isThriving = true } = {}) {
	if (!isThriving) return 0;
	return (PARAMS.companion.perPet[String(rarity).toLowerCase()] || 0) * bondFactor(bondXp);
}
/**
 * Companion slots of a holding { Freshwater: tierKey|null, Saltwater: tierKey|null }: the best tier held,
 * level-capped like rods' parts (a legacy license above the player's level works at the best tier whose gate
 * the player has reached; tanks and capacity are never capped).
 */
function companionSlots(holdings = {}, level = Infinity) {
	const capped = (k) => {
		if (!k) return 0;
		const usable = TIERS.slice(0, TIERS.indexOf(k) + 1).filter((t) => level >= PARAMS.licenses.tiers[t].level);
		return usable.length ? PARAMS.licenses.tiers[usable[usable.length - 1]].companionSlots : 0;
	};
	const slots = WATER_TYPES.map((w) => capped(holdings[w]));
	return PARAMS.licenses.secondWaterAddsSlots ? slots.reduce((a, b) => a + b, 0) : Math.max(0, ...slots);
}
/** pets: [{ rarity, bondXp, thriving }]; only the best `slots` thriving pets count. */
function companionBonus(pets, { slots }) {
	const values = pets.map((p) => perPetBonus(p.rarity, p)).filter((v) => v > 0).sort((a, b) => b - a);
	const counted = values.slice(0, slots);
	return { bonus: counted.reduce((a, b) => a + b, 0), counted: counted.length, slots, maxBonus: slots * PARAMS.companion.perPet.lucky };
}
/** INTEGRATOR: sellBonus from a holding with every companion slot filled by `mix` pets. */
function holdingsBonus(holdings, { mix = PARAMS.model.typicalMix, bond = 1, care = PARAMS.model.care, level = Infinity } = {}) {
	const b = PARAMS.companion.bond;
	return companionSlots(holdings, level) * PARAMS.companion.perPet[mix] * (b.minFactor + (1 - b.minFactor) * bond) * care;
}

// ---------------------------------------------------------------------------------------------
// Care, temperature, sale, breeding (pure rules the engine would implement).
function effectiveTemperature(storedC) {
	const [lo, hi] = PARAMS.temperature.adjustRangeC;
	const t = Number.isFinite(storedC) ? storedC : PARAMS.temperature.newTankC;
	return Math.min(hi, Math.max(lo, t));
}
function thriving({ hoursSinceFed, cleanliness, temperatureC }) {
	const t = PARAMS.companion.thrive;
	const deviation = Math.abs(effectiveTemperature(temperatureC) - PARAMS.temperature.idealC);
	const fedOk = hoursSinceFed <= t.fedWithinH;
	const cleanOk = cleanliness >= t.minCleanliness;
	const tempOk = deviation <= t.temperatureBandC;
	const hoursLeft = fedOk && cleanOk && tempOk ? Math.min(t.fedWithinH - hoursSinceFed, (cleanliness - t.minCleanliness) / PARAMS.cleanliness.decayPerHour) : 0;
	return { thriving: fedOk && cleanOk && tempOk, fedOk, cleanOk, tempOk, temperatureDeviationC: deviation, hoursUntilNotThriving: r2(hoursLeft) };
}
function speciesValue(nameOrTemplate) {
	const f = typeof nameOrTemplate === 'string' ? FISH.find((x) => x.name === nameOrTemplate) : nameOrTemplate;
	return f ? F.proposedValue(f) : null;
}
function ageFactor(ageDays) {
	const s = PARAMS.sale;
	return s.minAgeFactor + (1 - s.minAgeFactor) * Math.min(1, Math.max(0, (ageDays || 1) - 1) / (s.fullValueAgeDays - 1));
}
function petSaleValue({ speciesValue: v, ageDays = 1, bred = false, attraction = 0, thriving: isThriving = true }) {
	const s = PARAMS.sale;
	const attr = Math.min(s.maxAttraction, Math.max(0, attraction || 0));
	return v * ageFactor(ageDays) * (bred ? s.bredFactor : 1) * (isThriving ? 1 : s.notThrivingFactor) * (1 + attr * s.attractionPerPoint);
}
/** Today's Pet.breed success-rate formula (kept), and what it yields today vs with the comparison fixed. */
function breedingRate(stress, health) {
	const rate = Math.max(Math.min(0.65, (50 - stress) / 50), Math.max(Math.min(0.6, health / 100 - 0.5), 0.1));
	return { rate: r4(rate), today: r4(rate / 100), fixed: r4(rate) };
}

// Trait distributions (today's generation weights): attraction and XP multiplier once unlocked.
function traitDistribution() {
	const dist = (trait) => {
		const w = CURRENT.traits[trait].weights;
		const total = Object.values(w).reduce((a, b) => a + b, 0);
		return Object.entries(w).map(([name, x]) => ({ name, p: x / total }));
	};
	let attractionMean = 0;
	let attractionMax = 0;
	let multiplierMean = 1;
	const attractionDist = new Map();
	for (const c of dist('color')) {
		for (const s of dist('finShape')) {
			const a = (CURRENT.traits.color.attraction[c.name] || 0) + (CURRENT.traits.finShape.attraction[s.name] || 0);
			attractionMean += c.p * s.p * a;
			attractionMax = Math.max(attractionMax, a);
			attractionDist.set(a, (attractionDist.get(a) || 0) + c.p * s.p);
		}
	}
	for (const t of ['color', 'finShape', 'finSize']) for (const d of dist(t)) multiplierMean += d.p * (CURRENT.traits[t].multiplier[d.name] || 0);
	const multiplierMax = 1 + Math.max(...Object.values(CURRENT.traits.color.multiplier)) + Math.max(...Object.values(CURRENT.traits.finShape.multiplier)) + Math.max(...Object.values(CURRENT.traits.finSize.multiplier));
	return {
		attraction: { mean: r2(attractionMean), max: attractionMax, pZero: r4(attractionDist.get(0) || 0), p20plus: r4([...attractionDist].filter(([a]) => a >= 20).reduce((s, [, p]) => s + p, 0)) },
		multiplier: { mean: r4(multiplierMean), max: r2(multiplierMax) },
	};
}

// Species values for the income bound: per biome and rarity, mean and max of F.proposedValue.
function speciesValues(biome, rarity) {
	const vals = FISH.filter((f) => f.biome === biome && f.rarity === rarity).map((f) => F.proposedValue(f));
	if (!vals.length) return null;
	return { mean: vals.reduce((a, b) => a + b, 0) / vals.length, max: Math.max(...vals), species: vals.length };
}

/**
 * Upper bound on weekly cash from breeding and selling pets, for a pet capacity and parent species value.
 * Two strategies (sell babies at birth, or age them to full value in the remaining slots); the better
 * one is returned. Parents are assumed thriving (65% success) and every bred baby gets maximum attraction.
 */
function petIncomeBound({ capacity, tanks, value }) {
	const s = PARAMS.sale;
	const p = breedingRate(0, 100).fixed;
	const perWeek = 7 / PARAMS.breeding.cooldownDays;
	const attr = 1 + s.maxAttraction * s.attractionPerPoint;
	// (a) sell at birth: one slot per tank kept free for the baby.
	const parentsA = Math.max(0, capacity - tanks);
	const birthsA = Math.floor(parentsA / 2) * p * perWeek;
	const incomeA = birthsA * value * s.bredFactor * ageFactor(1);
	// (b) age to full value: P parents + B babies = capacity, births/week = sales/week.
	const k = (p * perWeek) / 2 / (7 / s.fullValueAgeDays);
	const parentsB = capacity / (1 + k);
	const birthsB = (parentsB / 2) * p * perWeek;
	const incomeB = birthsB * value * s.bredFactor * attr;
	const best = incomeA >= incomeB ? { strategy: 'sell at birth', births: birthsA, weekly: incomeA } : { strategy: 'age to 28 days', births: birthsB, weekly: incomeB };
	// The weekly rehoming limit caps sales whatever the capacity.
	const sales = Math.min(best.births, s.maxPerWeek);
	const weekly = best.births > 0 ? best.weekly * (sales / best.births) : 0;
	return { strategy: best.strategy, births: r2(best.births), sales: r2(sales), capped: best.births > s.maxPerWeek, weeklyUncapped: Math.round(best.weekly), weekly: Math.round(weekly) };
}

/** Fish of each rarity caught per hour at a level's stage (framework draw model; Lucky items excluded). */
function availability(level, { overheadS = F.DESIGN_OVERHEAD_S } = {}) {
	const s = stageAt(level, { overheadS });
	const tier = F.tierAt(level, sharedPath());
	const fishByRarity = Object.fromEntries(RARITIES.map((r) => [r, 0]));
	for (const d of drawDistribution(s.biome, tier.qualities, s.outcome.table)) if (d.kind === 'fish') fishByRarity[d.rarity] += d.p;
	const fishShare = Object.values(fishByRarity).reduce((a, b) => a + b, 0);
	const perHour = Object.fromEntries(RARITIES.map((r) => [r, r2((s.fishPerHour * fishByRarity[r]) / fishShare)]));
	return { level, biome: s.biome, water: s.water, tier: s.tier, fishPerHour: Math.round(s.fishPerHour), perHour };
}

// ---------------------------------------------------------------------------------------------
// Display tanks (aspirational sink): priced at the top live stage.
const topLevel = () => F.BIOME_LEVEL[F.LIVE_BIOMES[F.LIVE_BIOMES.length - 1]];
function displayTankPrice(n) {
	const d = PARAMS.display;
	return sig(d.firstPriceHours * d.growth ** (n - 1) * stageAt(topLevel()).cashPerHour, PARAMS.licenses.roundSig);
}
function displayTanks() {
	const d = PARAMS.display;
	const tanks = Array.from({ length: d.perWaterType }, (_, i) => ({ n: i + 1, price: displayTankPrice(i + 1), capacity: d.tankSize, companionSlots: 0 }));
	const totalPerWater = tanks.reduce((a, t) => a + t.price, 0);
	const byArchetype = Object.fromEntries(Object.keys(F.ARCHETYPES).map((name) => {
		const cash = stageAt(topLevel(), { overheadS: F.ARCHETYPES[name].overheadS }).cashPerHour;
		const h = totalPerWater / cash;
		return [name, { hoursPerWater: r2(h), daysPerWater: r2(h / hoursPerDay(name)), hoursBoth: r2(2 * h), daysBoth: r2((2 * h) / hoursPerDay(name)) }];
	}));
	return { stage: { level: topLevel(), biome: stageAt(topLevel()).biome, tier: stageAt(topLevel()).tier, cashPerHour: Math.round(stageAt(topLevel()).cashPerHour) }, tanks, totalPerWater, totalBoth: 2 * totalPerWater, byArchetype };
}

// ---------------------------------------------------------------------------------------------
// Integrator entry point.
/**
 * What a player at `level` can buy from this subsystem.
 * @param {number} level
 * @param {object} opts { owned: { Freshwater: tier|null, Saltwater: tier|null, display: { Freshwater: n, Saltwater: n } },
 *                        mix (pet rarity filling the slots), archetype (for hours of income) }
 */
function aquariumOptions(level, { owned = {}, mix = PARAMS.model.typicalMix, archetype = F.REFERENCE_ARCHETYPE } = {}) {
	const a = archOf(archetype);
	const stage = stageAt(level, { overheadS: a.overheadS });
	const slotsNow = companionSlots(owned, level);
	const options = [];
	for (const water of WATER_TYPES) {
		const have = owned[water] ? TIERS.indexOf(owned[water]) : -1;
		const next = TIERS[have + 1];
		if (next && level >= PARAMS.licenses.tiers[next].level) {
			const t = PARAMS.licenses.tiers[next];
			const slotsAfter = companionSlots({ ...owned, [water]: next }, level);
			const price = licensePrice(next);
			options.push({
				kind: 'license', name: licenseName(next, water), waterType: water, tier: next, level: t.level, price,
				upkeepPerDay: PARAMS.upkeep.moneyPerDay, capacityAfter: t.tanks * t.tankSize, tanksAfter: t.tanks,
				hoursOfIncome: r2(price / stage.cashPerHour),
				benefit: {
					stat: PARAMS.companion.stat, xpBonus: 0, slotsAfter, slotsAdded: slotsAfter - slotsNow,
					typicalBonusAdded: r4((slotsAfter - slotsNow) * PARAMS.companion.perPet[mix]), maxBonusAdded: r4((slotsAfter - slotsNow) * PARAMS.companion.perPet.lucky),
					typicalCashPerHourAdded: Math.round(companionCash(stage.cashPerHour, stage.gearSell, (slotsAfter - slotsNow) * PARAMS.companion.perPet[mix])),
				},
			});
		}
		const displayOwned = owned.display?.[water] || 0;
		if (owned[water] === PARAMS.display.requires && level >= PARAMS.licenses.tiers[PARAMS.display.requires].level && displayOwned < PARAMS.display.perWaterType) {
			const price = displayTankPrice(displayOwned + 1);
			options.push({ kind: 'display', name: `${water} Display Tank ${displayOwned + 1}`, waterType: water, tier: null, level: PARAMS.licenses.tiers[PARAMS.display.requires].level, price, upkeepPerDay: 0, capacityAfter: PARAMS.display.tankSize, hoursOfIncome: r2(price / stage.cashPerHour), benefit: { stat: null, xpBonus: 0, slotsAdded: 0, typicalBonusAdded: 0, maxBonusAdded: 0, typicalCashPerHourAdded: 0 } });
		}
	}
	return options;
}

// ---------------------------------------------------------------------------------------------
// Lifecycle: curve.js XP timeline (identical), plus money. The aquarium adds no XP, so milestones match
// curve.json; money decides when licenses are bought and how much the companion bonus returns.
const assemblyCache = new Map();
const rodCost = (t) => {
	if (!assemblyCache.has(t)) assemblyCache.set(t, rods.assembly(t).expectedCost);
	return assemblyCache.get(t);
};
const crateUnlock = (t) => rods.PARAMS.crates.tiers[t].unlockLevel;

/**
 * 5b.3: superseded by system() on the shared core (validateSystem() proves they agree); kept until the
 * old loops are retired.
 * @param {string|object} archetype
 * @param {object} opts { tiers (license tiers to buy, in order), water, mix, care, otherSpendShare (share of
 *   income spent elsewhere, e.g. permits), rodSpend (charge rods.assembly + repairs), reserveRods (keep the
 *   next rod tier's cost when its crates are unlocked), maxLevel, gearPath (default F.gearPath(), the shared
 *   path; baselineMatchesCurveJson() passes F.PROVISIONAL_GEAR_PATH, the path curve.json was fitted on) }
 */
function lifecycle(archetype, opts = {}) {
	const a = archOf(archetype);
	const { tiers = TIERS, water = PARAMS.model.primaryWater, mix = PARAMS.model.typicalMix, care = PARAMS.model.care, otherSpendShare = 0, rodSpend = true, reserveRods = true, maxLevel = F.LIFECYCLE.maxLevel, gearPath = sharedPath() } = opts;
	const path = gearPath;
	const stepH = F.LIFECYCLE.stepH;
	const dayH = a.minutesPerDay / 60;
	const perPet = PARAMS.companion.perPet[mix];
	const prices = Object.fromEntries(tiers.map((k) => [k, licensePrice(k)]));
	let xp = 0;
	let h = 0;
	let tierIdx = 0;
	let saving = 0;
	let money = 0;
	const reached = {};
	const gate = {};
	const bought = {};
	const groups = [];
	const rodBuys = [];
	const totals = { fishCash: 0, companionCash: 0, repairs: 0, rods: 0, licenses: 0, otherSpend: 0 };
	let slotsHeld = 0;
	let last = null;
	while (h < 5000) {
		const L = F.levelForXp(xp);
		const cur = path[tierIdx];
		const next = path[tierIdx + 1];
		const r = gearRates(F.biomeAt(L), cur, a.overheadS);
		last = r;
		// Rod tiers: exactly curve.js (save purchaseHours of stage income, then upgrade); rods' assembly cost is charged.
		if (next && L >= next.level) {
			saving += r.cash * stepH;
			if (saving >= r.cash * F.PURCHASE.saveHours) {
				tierIdx++;
				saving = 0;
				if (rodSpend) {
					money -= rodCost(path[tierIdx].tier);
					totals.rods += rodCost(path[tierIdx].tier);
					rodBuys.push({ tier: path[tierIdx].tier, hours: r2(h), moneyAfter: Math.round(money) });
				}
			}
		}
		// Companion bonus of every owned slot group (bond ramps in calendar days since adoption).
		const day = h / dayH;
		let bonus = 0;
		for (const g of groups) {
			const b = g.slots * perPet * bondFactorAfterDays(day - g.day) * care;
			g.cash += companionCash(r.cash, r.gearSell, b) * stepH;
			bonus += b;
		}
		const extra = companionCash(r.cash, r.gearSell, bonus) * stepH;
		const fish = r.cash * stepH;
		const repairs = rodSpend && cur.tier > 0 ? rods.PARAMS.repair.upkeepShare * fish : 0;
		const other = otherSpendShare * (fish + extra);
		money += fish + extra - repairs - other;
		totals.fishCash += fish;
		totals.companionCash += extra;
		totals.repairs += repairs;
		totals.otherSpend += other;
		// License purchases in order (prerequisites), rods first.
		for (const k of tiers) {
			if (bought[k]) continue;
			const t = PARAMS.licenses.tiers[k];
			if (L < t.level) break;
			if (!gate[k]) gate[k] = { hours: h, day: Math.max(1, Math.ceil(h / dayH)), level: L };
			const nt = path[tierIdx + 1];
			const reserve = reserveRods && rodSpend && nt && L >= crateUnlock(nt.tier) ? rodCost(nt.tier) : 0;
			if (money - reserve < prices[k]) break;
			money -= prices[k];
			totals.licenses += prices[k];
			const slotsAfter = t.companionSlots;
			groups.push({ tier: k, slots: slotsAfter - slotsHeld, day, cash: 0, price: prices[k], boughtH: h });
			slotsHeld = slotsAfter;
			bought[k] = { hours: h, day: Math.max(1, Math.ceil(h / dayH)), level: L };
		}
		for (const g of groups) if (g.paybackH == null && g.cash >= g.price) g.paybackH = h;
		// XP: exactly curve.js.
		const before = h;
		xp += r.xp * stepH;
		h += stepH;
		if (Math.floor(h / dayH) !== Math.floor(before / dayH)) xp += F.DAILY.xpPerLevel * L;
		const L2 = F.levelForXp(xp);
		for (const T of F.LIFECYCLE.milestones) if (!reached[T] && L2 >= T) reached[T] = { hours: +h.toFixed(2), day: Math.ceil(h / dayH) };
		if (L2 >= maxLevel) break;
	}
	// Payback after maxLevel: extrapolated at the final stage's income (Mountain Stream would pay more).
	const purchases = Object.fromEntries(tiers.map((k) => {
		const g = groups.find((x) => x.tier === k);
		const gt = gate[k];
		if (!g) return [k, { price: prices[k], gate: gt ? { hours: r2(gt.hours), day: gt.day, level: gt.level } : null, bought: null }];
		const rate = companionCash(last.cash, last.gearSell, g.slots * perPet * care);
		const paybackH = g.paybackH != null ? g.paybackH : h + (g.price - g.cash) / rate;
		return [k, {
			price: prices[k], gate: { hours: r2(gt.hours), day: gt.day, level: gt.level },
			bought: { hours: r2(bought[k].hours), day: bought[k].day, level: bought[k].level, hoursAfterGate: r2(bought[k].hours - gt.hours), daysAfterGate: bought[k].day - gt.day },
			slotsAdded: g.slots, recoveredByEnd: r4(g.cash / g.price), paybackHoursAfterPurchase: r2(paybackH - g.boughtH), paybackDaysAfterPurchase: Math.round((paybackH - g.boughtH) / dayH), paybackExtrapolated: g.paybackH == null,
		}];
	}));
	return {
		archetype: a.name, water, mix, care, otherSpendShare, hours: r2(h), days: Math.ceil(h / dayH), reached, purchases,
		totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Math.round(v)])),
		shares: {
			companionOfFish: r4(totals.companionCash / totals.fishCash),
			licensesOfIncome: r4(totals.licenses / (totals.fishCash + totals.companionCash)),
			netOfIncome: r4((totals.companionCash - totals.licenses) / (totals.fishCash + totals.companionCash)),
			rodsOfIncome: r4((totals.rods + totals.repairs) / (totals.fishCash + totals.companionCash)),
			upkeepOfIncome: 0,
		},
		finalMoney: Math.round(money),
		rodShortfalls: rodBuys.filter((b) => b.moneyAfter < 0),
	};
}

/**
 * The lifecycle's XP timeline equals docs/economy/5b/curve.json for every archetype, and the aquarium adds no
 * XP (identical milestones with and without it, on the shared path). curve.json is curve.js's 'provisional'
 * model, fitted on F.PROVISIONAL_GEAR_PATH, so the stepping is checked on that path. Hours only: curve.json
 * is generated on the shared core, which counts a level reached on a day's final step in that day
 * (ceil(h/dayH) here counts the next day), so the day column may differ by 1.
 */
let baselineCache = null;
function baselineMatchesCurveJson() {
	if (baselineCache) return baselineCache;
	const rows = Object.keys(F.ARCHETYPES).map((name) => {
		const mine = lifecycle(name, { tiers: [], gearPath: F.PROVISIONAL_GEAR_PATH }).reached;
		const theirs = CURVE_JSON.archetypes[name];
		const same = Object.keys(theirs).every((L) => mine[L] && mine[L].hours === theirs[L].hours);
		return { archetype: name, same };
	});
	const withAquarium = Object.keys(F.ARCHETYPES).every((name) => JSON.stringify(lifecycle(name).reached) === JSON.stringify(lifecycle(name, { tiers: [] }).reached));
	baselineCache = { pass: rows.every((r) => r.same) && withAquarium && CURVE_JSON.chosen === F.CURVE.quartic && CURVE_JSON.model === 'provisional', rows, aquariumChangesXp: !withAquarium };
	return baselineCache;
}

// ---------------------------------------------------------------------------------------------
// Today (quantified from the mirrored rules and the measurements).
function currentExploit() {
	const traits = traitDistribution();
	const actionsPerHour = 3600 / CURRENT.commandCooldownS;
	const perPet = (m, att) => actionsPerHour * CURRENT.careXp * m * att;
	const measuredBest = MEASURED.results.filter((x) => x.profile === 'normal').map((x) => ({ key: x.key, cashPerHour: (x.valueBase / x.casts) * (3600 / (x.cooldownMs / 1000 + F.DESIGN_OVERHEAD_S)) })).sort((a, b) => b.cashPerHour - a.cashPerHour)[0];
	const bestProposed = Math.max(...F.LIVE_BIOMES.flatMap((b) => sharedPath().map((t) => gearRates(b, t, F.DESIGN_OVERHEAD_S).cash)));
	const low = perPet(1, 5);
	const high = perPet(traits.multiplier.max, traits.attraction.max);
	// One Expert tank (3 pets) with both commands: /pet (1 pet) + /aquarium feed (3 pets) each every 3 s.
	const tank = (actionsPerHour * (1 + 3) * CURRENT.careXp) * traits.multiplier.max * traits.attraction.max;
	const temps = [0, 25, 50, 100].map((T) => ({
		temperatureC: T,
		hungerFactor: r2(1 + Math.abs(T - CURRENT.temperatureIdeal.hunger) / 25),
		moodStressFactor: r2(1 + Math.abs(T - CURRENT.temperatureIdeal.mood) / 100),
		healthFactor: r2(Math.max(0, 1 - Math.abs(T - CURRENT.temperatureIdeal.health) / 100)),
	}));
	return {
		playSell: {
			actionsPerHour, xpPerAction: CURRENT.careXp, attractionUnlockDays: CURRENT.traits.finShape.unlockAgeDays,
			cashPerHourOnePet: { low: Math.round(low), high: Math.round(high) },
			cashPerHourExpertTank: Math.round(tank),
			vsBestProposedFishing: { cashPerHour: Math.round(bestProposed), ratioLow: r2(low / bestProposed), ratioHigh: r2(high / bestProposed), ratioTank: r2(tank / bestProposed) },
			vsBestMeasuredToday: { key: measuredBest.key, cashPerHour: Math.round(measuredBest.cashPerHour), ratioHigh: r2(high / measuredBest.cashPerHour), ratioTank: r2(tank / measuredBest.cashPerHour) },
			breedingAttemptsPerSuccessAtBest: { today: Math.round(1 / breedingRate(0, 100).today), fixed: r2(1 / breedingRate(0, 100).fixed) },
		},
		traits,
		breeding: {
			formula: 'max(min(0.65, (50 - stress)/50), max(min(0.6, health/100 - 0.5), 0.1)); success if rng.random()*100 < rate',
			examples: [[0, 100], [20, 80], [40, 60], [80, 50]].map(([s, hp]) => ({ stress: s, health: hp, ...breedingRate(s, hp) })),
		},
		temperature: { driftPerHour: CURRENT.driftPerHour, ideal: CURRENT.temperatureIdeal, factors: temps, hoursToZeroHealthFromZero: 100 / CURRENT.driftPerHour },
	};
}
function currentLicenses() {
	return LICENSE_CATALOG.map((l) => {
		const s = stageAt(l.requirements.level);
		return { name: l.name, price: l.price, level: l.requirements.level, size: l.aquarium.size, stage: `${s.biome} ${s.tier}`, hoursOfProposedStageIncome: r2(l.price / s.cashPerHour), regularDays: r2(l.price / s.cashPerHour / hoursPerDay(REFERENCE)) };
	});
}

// ---------------------------------------------------------------------------------------------
// Upkeep: a flat daily money fee, sized at a share of the reference player's bonus, per archetype.
function upkeepAlternatives() {
	const share = PARAMS.upkeep.alternativeShareOfReferenceBonus;
	const perPet = PARAMS.companion.perPet[PARAMS.model.typicalMix];
	const rows = TIERS.map((k) => {
		const t = PARAMS.licenses.tiers[k];
		const ref = stageAt(t.level, { overheadS: REFERENCE.overheadS });
		const feePerPetDay = share * companionCash(ref.cashPerHour, ref.gearSell, perPet) * hoursPerDay(REFERENCE);
		const byArchetype = Object.fromEntries(Object.keys(F.ARCHETYPES).map((name) => {
			const s = stageAt(t.level, { overheadS: F.ARCHETYPES[name].overheadS });
			const bonusPerDay = companionCash(s.cashPerHour, s.gearSell, perPet) * hoursPerDay(name);
			return [name, { bonusPerPetDay: Math.round(bonusPerDay), feeShareOfBonus: r4(feePerPetDay / bonusPerDay), feeShareOfIncome: r4(feePerPetDay * t.companionSlots / (s.cashPerHour * hoursPerDay(name))) }];
		}));
		return { tier: k, level: t.level, stage: `${ref.biome} ${ref.tier}`, feePerPetDay: Math.round(feePerPetDay), byArchetype };
	});
	return {
		decision: 'no money upkeep (care-based upkeep only)',
		alternative: `flat fee per pet per day = ${share} x the reference player's daily bonus from that pet at the gate stage`,
		rows,
		perCastAlternative: 'a fee per cast (food eaten per catch) is only a smaller bonus: it changes no decision',
	};
}

// ---------------------------------------------------------------------------------------------
// Checks against the design targets.
function checks() {
	const out = [];
	const maxBonus = PARAMS.licenses.tiers.expert.companionSlots * PARAMS.companion.perPet.lucky;
	out.push({ check: 'companion bonus is small and bounded', value: r4(maxBonus), target: `<= ${PARAMS.targets.maxCompanionBonus}`, pass: maxBonus <= PARAMS.targets.maxCompanionBonus + 1e-12 });
	const saleMax = petSaleValue({ speciesValue: 1, ageDays: 1e6, attraction: 1e6 });
	out.push({ check: 'a pet never sells for more than 1.25x the fish it was adopted from', value: r4(saleMax), target: '<= 1.25', pass: saleMax <= 1.25 + 1e-12 });
	const br = [breedingRate(0, 100), breedingRate(100, 0), breedingRate(50, 50)];
	out.push({ check: 'breeding chance (fixed) within the intended 10-65%', value: `${Math.min(...br.map((b) => b.fixed))}-${Math.max(...br.map((b) => b.fixed))}`, target: '0.1-0.65', pass: br.every((b) => b.fixed >= 0.1 && b.fixed <= 0.65) });
	const inc = incomeBoundTable();
	const worst = Math.max(...inc.rows.map((r) => r.shareOfWeeklyFishing.regular));
	out.push({ check: 'pet income bound (any parents, any capacity) <= target share of a regular player\'s fishing', value: worst, target: `<= ${PARAMS.targets.maxPetIncomeShareRegular}`, pass: worst <= PARAMS.targets.maxPetIncomeShareRegular });
	const worstCasual = Math.max(...inc.rows.map((r) => r.shareOfWeeklyFishing.casual));
	out.push({ check: 'pet income bound (any parents, any capacity) <= target share of a casual player\'s fishing', value: worstCasual, target: `<= ${PARAMS.targets.maxPetIncomeShareCasual}`, pass: worstCasual <= PARAMS.targets.maxPetIncomeShareCasual });
	const base = baselineMatchesCurveJson();
	out.push({ check: 'aquarium adds no XP: lifecycle milestones equal curve.json with and without it', value: base.pass, target: true, pass: base.pass });
	const aff = Object.keys(F.ARCHETYPES).map((n) => lifecycle(n));
	const within = aff.every((l) => TIERS.every((k, i) => {
		const p = l.purchases[k];
		if (!p.gate) return true;
		const nextGate = TIERS[i + 1] ? PARAMS.licenses.tiers[TIERS[i + 1]].level : Infinity;
		return p.bought && p.bought.level < nextGate;
	}));
	out.push({ check: 'every license is affordable before the next tier\'s gate for every archetype (rods first)', value: within, target: true, pass: within });
	const noShortfall = aff.every((l) => l.rodShortfalls.length === lifecycle(l.archetype, { tiers: [] }).rodShortfalls.length);
	out.push({ check: 'buying licenses never leaves a rod tier unaffordable that was affordable without them', value: noShortfall, target: true, pass: noShortfall });
	const reg = aff.find((l) => l.archetype === F.REFERENCE_ARCHETYPE);
	const paybacks = Object.fromEntries(TIERS.map((k) => [k, reg.purchases[k].paybackHoursAfterPurchase]));
	const rampOk = TIERS.every((k) => paybacks[k] != null && paybacks[k] <= PARAMS.targets.paybackHoursRegular[k]) && TIERS.every((k, i) => !i || paybacks[k] >= paybacks[TIERS[i - 1]]);
	out.push({ check: 'reference player earns each license back within its payback target, and higher tiers take longer', value: paybacks, target: PARAMS.targets.paybackHoursRegular, pass: rampOk });
	const legacy = companionSlots({ Freshwater: 'expert' }, PARAMS.licenses.tiers.basic.level);
	out.push({ check: 'a legacy Expert license at the Basic gate level gives only Basic companion slots (level cap)', value: legacy, target: PARAMS.licenses.tiers.basic.companionSlots, pass: legacy === PARAMS.licenses.tiers.basic.companionSlots });
	out.push({ check: 'no mandatory money upkeep', value: PARAMS.upkeep.moneyPerDay, target: 0, pass: PARAMS.upkeep.moneyPerDay === 0 });
	return { pass: out.every((c) => c.pass), checks: out };
}

// Pet income bound per capacity and parent rarity, against weekly fishing income at the top live stage.
function incomeBoundTable() {
	const top = topLevel();
	const biome = F.biomeAt(top);
	const rows = [];
	for (const parents of PARAMS.model.incomeBoundParents) {
		const v = speciesValues(biome, parents);
		if (!v) continue;
		for (const [label, capacity, tanks] of [['Expert, one water type', PARAMS.licenses.tiers.expert.tanks * PARAMS.licenses.tiers.expert.tankSize, PARAMS.licenses.tiers.expert.tanks], ['Expert, both water types + all display tanks', 2 * (PARAMS.licenses.tiers.expert.tanks * PARAMS.licenses.tiers.expert.tankSize + PARAMS.display.perWaterType * PARAMS.display.tankSize), 2 * (PARAMS.licenses.tiers.expert.tanks + PARAMS.display.perWaterType)]]) {
			const b = petIncomeBound({ capacity, tanks, value: v.max });
			const shareOfWeeklyFishing = Object.fromEntries(Object.keys(F.ARCHETYPES).map((name) => {
				const weekly = stageAt(top, { overheadS: F.ARCHETYPES[name].overheadS }).cashPerHour * hoursPerDay(name) * 7;
				return [name, r4(b.weekly / weekly)];
			}));
			rows.push({ parents, biome, speciesValueMax: Math.round(v.max), capacity: label, slots: capacity, ...b, shareOfWeeklyFishing });
		}
	}
	return { stage: `${biome} ${F.tierAt(top, sharedPath()).key}`, rows };
}

// ---------------------------------------------------------------------------------------------
// Framework 5b.3: the aquarium as a SYSTEM on the shared lifecycle core (lifecycle.js; contract in its
// header and integrate.js). License and display-tank purchases, and the companion sell bonus with its bond
// ramp. No XP effect, no boxes, no money upkeep.
const SYSTEM_NAME = 'aquarium';
const CONVENTIONS = ['core', 'lifecycle'];
/** Ledger spend items and purchase rules per option kind (aquariumOptions()). */
const SPEND = Object.freeze({
	license: Object.freeze({ category: 'optional', priority: LC.PRIORITY.license, prefix: 'license:' }),
	display: Object.freeze({ category: 'aspirational', priority: LC.PRIORITY.aspirational, prefix: 'display:' }),
});

/**
 * The bond clock (days of care since a purchase, at one feed + one play per pet per play day): fixed sessions
 * count play hours / the session's hours (continuous; lifecycle()'s clock), so bond grows only on days the
 * player attends and cares. Sessions without a fixed length (F.MINIMUM_DAILY) count completed play days.
 */
const careDays = (h, state, ctx) => (ctx.arch.minutesPerDay ? h / (ctx.arch.minutesPerDay / 60) : state.playDay);

/**
 * What the player can buy next, as purchase chains per water type (aquariumOptions() applied repeatedly to
 * the holding each offer would leave): the next license tiers in `tiers`, then (with `display`) the display
 * tanks of an Expert water type. Every offer is level-reached. Prices rise along a chain, so in one purchase
 * pass a later offer is affordable only after its prerequisite was bought (the chain stops if they did not).
 */
function offerChains(level, owned, { waters, tiers, display, mix, arch }) {
	const hypo = { ...owned, display: { ...owned.display } };
	const chains = [];
	for (const water of waters) {
		const chain = [];
		for (;;) {
			const o = aquariumOptions(level, { owned: hypo, mix, archetype: arch }).find((x) => x.waterType === water && (x.kind === 'license' ? tiers.includes(x.tier) : display));
			if (!o || (chain.length && o.price < chain[chain.length - 1].price)) break;
			chain.push(o);
			if (o.kind === 'license') hypo[water] = o.tier;
			else hypo.display[water] = (hypo.display[water] || 0) + 1;
		}
		if (chain.length) chains.push(chain);
	}
	return chains;
}

/**
 * The aquarium SYSTEM (lifecycle.js hooks). A fresh object per call; per-run state lives in
 * state.sys.aquarium only.
 *   init        state.sys.aquarium: { owned: { Freshwater, Saltwater, display }, purchases (one per
 *               purchase: price, slots added, bond clock start, stamps, companion cash earned, payback),
 *               gates, spent, companionCash, xpEffect, milestones, publicMilestones }
 *   goals       aquariumOptions(gate level, { owned }) as chains per water type in `waters` (see offerChains):
 *               licenses ('optional', LC.PRIORITY.license, item 'license:<name>') and, with displayTanks,
 *               display tanks of an Expert water type ('aspirational', LC.PRIORITY.aspirational, item
 *               'display:<name>'). All non-blocking (user decision 10: big sinks are choices), so a blocking
 *               progression goal of higher priority (rods, permits) is always served first. `reserve` keeps
 *               cash back. buy() records the holding and the companion slots it adds (companionSlots(), level
 *               capped at the gate level).
 *   modifyCast  adds the companion bonus to input.stats.sellBonus: per purchase, slots added x
 *               PARAMS.companion.perPet[mix] x bondFactorAfterDays(care days owned) x care (holdingsBonus()
 *               per purchase, with each purchase's own bond; at full bond the sum is holdingsBonus(owned)).
 *   beforeStep  notes the step's start (lifecycle() conventions' stamps).
 *   onCasts     the bonus's marginal cash this step, measured on the core's own cast: cash minus the same
 *               cast without the bonus (other systems' changes kept, the run's outcome function), split over
 *               purchases by their share of the bonus; the XP effect is measured the same way (0: cash only).
 *               Payback is stamped when a purchase's companion cash covers its price.
 *   onDayStart / onDayEnd   mark the day-end purchase pass (skipped under lifecycle() conventions).
 *   on          'levelUp': snapshots companion cash and spend at each recorded milestone.
 * Ledgers: the core's 'fishing' cash already includes the companion bonus (it is a cast stat). The system
 * writes NO XP or cash source; its share of 'fishing' is state.sys.aquarium.companionCash (never edit
 * 'fishing'). Spend: ledger.spend.optional['license:<name>'] and ledger.spend.aspirational['display:<name>'].
 * No money upkeep (PARAMS.upkeep.moneyPerDay 0: care is the upkeep). Grants no boxes, so no 'box' events.
 * Profile: the rules are profile-independent (§10); an outcome override (Founder) honours
 * input.stats.sellBonus, so its sell multiplier multiplies the bonus as it multiplies gear.
 * @param {object} opts {
 *   buy          buy licenses (default true; false: an inert system, the no-aquarium baseline)
 *   displayTanks also buy display tanks once a water type is Expert (default false)
 *   waters       water types whose licenses are bought, in order (default [PARAMS.model.primaryWater]; a second
 *                water type adds tanks, not companion slots)
 *   tiers        license tiers to buy (a prefix of the ladder; default all)
 *   mix          pet rarity filling the companion slots (default PARAMS.model.typicalMix)
 *   care         share of fishing time the pets are thriving (default PARAMS.model.care)
 *   reserve      cash to keep after a purchase: a number or (state, ctx) => number (default 0; in the
 *                integrated run the rods system's blocking progression goal already puts rods first)
 *   conventions  'core' (default) | 'lifecycle' (validation replay of lifecycle()'s timing: stamps and the
 *                bond clock at the start of the step whose income paid; no day-end purchase pass) }
 */
function system(opts = {}) {
	const {
		buy = true, displayTanks: withDisplay = false, waters = [PARAMS.model.primaryWater], tiers = TIERS,
		mix = PARAMS.model.typicalMix, care = PARAMS.model.care, reserve = 0, conventions = 'core',
	} = opts;
	if (!CONVENTIONS.includes(conventions)) throw new Error(`Unknown conventions ${conventions} (${CONVENTIONS.join(' | ')})`);
	if (!(mix in PARAMS.companion.perPet)) throw new Error(`Unknown pet mix ${mix}`);
	for (const w of waters) if (!WATER_TYPES.includes(w)) throw new Error(`Unknown water type ${w}`);
	for (const t of tiers) if (!TIERS.includes(t)) throw new Error(`Unknown license tier ${t}`);
	const perPet = PARAMS.companion.perPet[mix];
	const replay = conventions === 'lifecycle';
	const own = (state) => state.sys[SYSTEM_NAME];
	/** A purchase pass's stamp: the pass time (core) or the start of the step whose income paid (lifecycle()). */
	const stampH = (state) => (replay ? own(state).stepStartH : state.h);

	function chains(s, level, ctx) {
		const key = `${level}|${JSON.stringify(s.owned)}`;
		if (!s.offers.has(key)) s.offers.set(key, offerChains(level, s.owned, { waters, tiers, display: withDisplay, mix, arch: ctx.arch }));
		return s.offers.get(key);
	}
	function markGate(state, ctx, o) {
		const s = own(state);
		if (!s.gates[o.name]) s.gates[o.name] = { h: stampH(state), passH: state.h, day: state.day + 1, level: ctx.gateLevel() };
	}
	function acquire(state, ctx, o) {
		const s = own(state);
		const L = ctx.gateLevel();
		const before = companionSlots(s.owned, L);
		if (o.kind === 'license') s.owned[o.waterType] = o.tier;
		else s.owned.display[o.waterType] = (s.owned.display[o.waterType] || 0) + 1;
		const h = stampH(state);
		s.spent[o.kind] += o.price;
		s.purchases.push({
			name: o.name, kind: o.kind, water: o.waterType, tier: o.tier, price: o.price, slots: companionSlots(s.owned, L) - before,
			from: careDays(h, state, ctx), h, passH: state.h, day: state.day + 1, level: L, cash: 0, paybackH: null,
		});
	}
	/** The same cast without the companion bonus (the outcome function the core used; memoised per run). */
	function baseOutcome(s, cur, state, ctx) {
		const input = { ...cur.input, stats: { ...cur.input.stats } };
		if (input.stats.sellBonus === cur.after) {
			if (cur.before === undefined) delete input.stats.sellBonus;
			else input.stats.sellBonus = cur.before;
		}
		else {
			// A later system also changed sellBonus: remove only the companion part.
			input.stats.sellBonus -= cur.bonus;
		}
		const provider = ctx.systems.find((x) => typeof x.outcome === 'function');
		let key = JSON.stringify(input);
		if (provider) key = typeof provider.outcomeCacheKey === 'function' ? `${key}|${provider.outcomeCacheKey(input, state, ctx)}` : null;
		let o = key === null ? null : s.outcomes.get(key);
		if (!o) {
			o = provider ? provider.outcome(input, state, ctx) : F.castOutcome(input);
			if (key !== null) s.outcomes.set(key, o);
		}
		return o;
	}
	const snapshot = (s) => ({ companionCash: s.companionCash, licenses: s.spent.license, displayTanks: s.spent.display });

	return {
		name: SYSTEM_NAME,
		init(state) {
			state.sys[SYSTEM_NAME] = {
				options: { buy, displayTanks: withDisplay, waters: [...waters], tiers: [...tiers], mix, perPet, care, conventions },
				owned: { ...Object.fromEntries(WATER_TYPES.map((w) => [w, null])), display: Object.fromEntries(WATER_TYPES.map((w) => [w, 0])) },
				purchases: [], gates: {}, spent: { license: 0, display: 0 },
				companionCash: 0, xpEffect: { maxAbs: 0, total: 0 }, lastUnit: null, endH: 0,
				milestones: {}, publicMilestones: {},
			};
			// Per-run scratch kept out of the result's JSON: offer chains by (level, holding), no-bonus outcomes,
			// the step's bonus, the step's start and the day-end pass flag.
			const s = own(state);
			for (const [k, v] of [['offers', new Map()], ['outcomes', new Map()], ['current', null], ['stepStartH', 0], ['dayEnd', false]]) Object.defineProperty(s, k, { value: v, writable: true, enumerable: false });
		},
		goals(state, ctx) {
			const s = own(state);
			if (!buy || (replay && s.dayEnd)) return [];
			const list = chains(s, ctx.gateLevel(), ctx);
			if (!list.length) return [];
			const keep = typeof reserve === 'function' ? reserve(state, ctx) : reserve;
			const goals = [];
			for (const chain of list) {
				markGate(state, ctx, chain[0]);
				chain.forEach((o, i) => goals.push({
					id: `${SYSTEM_NAME}:${o.name}`, item: `${SPEND[o.kind].prefix}${o.name}`, category: SPEND[o.kind].category,
					priority: SPEND[o.kind].priority, cost: o.price, available: true, blocking: false, reserve: keep,
					buy(st, c) {
						acquire(st, c, o);
						if (chain[i + 1]) markGate(st, c, chain[i + 1]);
					},
				}));
			}
			return goals;
		},
		modifyCast(input, state, ctx) {
			const s = own(state);
			s.current = null;
			const now = careDays(state.h, state, ctx);
			let bonus = 0;
			const parts = s.purchases.map((p) => {
				const b = p.slots * perPet * bondFactorAfterDays(now - p.from) * care;
				bonus += b;
				return b;
			});
			if (!(bonus > 0)) return;
			const before = input.stats.sellBonus;
			input.stats.sellBonus = (before || 0) + bonus;
			s.current = { input, before, after: input.stats.sellBonus, bonus, parts };
		},
		beforeStep(state) {
			own(state).stepStartH = state.h;
		},
		onCasts(state, ctx, { casts, rates }) {
			const s = own(state);
			const cur = s.current;
			s.current = null;
			s.endH = state.h + ctx.stepH;
			if (!cur || rates.blocked || !(casts > 0)) return;
			const base = baseOutcome(s, cur, state, ctx);
			const baseCasts = (ctx.stepH * 3600) / (base.cooldownMs / 1000 + ctx.arch.overheadS);
			const extra = rates.cash - baseCasts * base.valuePerCast;
			const xp = rates.xp - baseCasts * base.xpPerCast;
			s.companionCash += extra;
			s.xpEffect.total += xp;
			s.xpEffect.maxAbs = Math.max(s.xpEffect.maxAbs, Math.abs(xp));
			s.lastUnit = extra / cur.bonus / ctx.stepH;
			const paidH = replay ? s.stepStartH : state.h + ctx.stepH;
			cur.parts.forEach((b, i) => {
				const p = s.purchases[i];
				p.cash += (extra * b) / cur.bonus;
				if (p.paybackH === null && p.slots > 0 && p.cash >= p.price) p.paybackH = paidH;
			});
		},
		onDayStart(state) {
			own(state).dayEnd = false;
		},
		onDayEnd(state) {
			own(state).dayEnd = true;
		},
		on(event, payload, state) {
			if (event !== 'levelUp') return;
			const s = own(state);
			const [recorded, mine] = payload.kind === 'public' ? [state.publicMilestones, s.publicMilestones] : [state.milestones, s.milestones];
			for (const T of Object.keys(recorded)) if (/^\d+$/.test(T) && !mine[T]) mine[T] = snapshot(s);
		},
	};
}

/**
 * The aquarium's figures from a lifecycle.js result that ran system(): per purchase, gate and purchase stamps,
 * slots added, companion cash earned and payback in hours of play after purchase (extrapolated past the end
 * at the last step's income per unit of bonus, at full bond, as lifecycle() did); totals and shares of income
 * (income = every ledger cash source; fish income = 'fishing' minus the companion cash).
 */
function systemSummary(result) {
	const s = result.sys[SYSTEM_NAME];
	if (!s) return null;
	const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
	const income = sum(result.ledger.cash);
	const fishCash = (result.ledger.cash.fishing || 0) - s.companionCash;
	const dayH = result.archetype.minutesPerDay ? result.archetype.minutesPerDay / 60 : null;
	const purchases = Object.fromEntries(s.purchases.map((p) => {
		const gate = s.gates[p.name];
		const rate = s.lastUnit === null ? 0 : p.slots * s.options.perPet * s.options.care * s.lastUnit;
		const paybackH = p.paybackH !== null ? p.paybackH : rate > 0 ? s.endH + (p.price - p.cash) / rate : null;
		const after = paybackH === null ? null : paybackH - p.h;
		return [p.name, {
			kind: p.kind, water: p.water, tier: p.tier, price: p.price,
			gate: gate ? { hours: r4(gate.h), passHours: r4(gate.passH), day: gate.day, level: gate.level } : null,
			bought: { hours: r4(p.h), passHours: r4(p.passH), day: p.day, level: p.level, hoursAfterGate: gate ? r4(p.h - gate.h) : null },
			slotsAdded: p.slots, companionCash: Math.round(p.cash), recoveredByEnd: p.slots ? r4(p.cash / p.price) : 0,
			paybackHoursAfterPurchase: after === null || !p.slots ? null : r2(after), paybackDaysAfterPurchase: after === null || !p.slots || !dayH ? null : Math.round(after / dayH),
			paybackExtrapolated: p.slots > 0 && p.paybackH === null,
			// Unrounded, for validateSystem().
			raw: { gateH: gate ? gate.h : null, gatePassH: gate ? gate.passH : null, h: p.h, passH: p.passH, cash: p.cash, paybackAfterH: after },
		}];
	}));
	return {
		options: s.options, owned: s.owned, purchases,
		totals: { income: Math.round(income), fishCash: Math.round(fishCash), companionCash: Math.round(s.companionCash), licenses: Math.round(s.spent.license), displayTanks: Math.round(s.spent.display) },
		shares: {
			companionOfFish: r4(s.companionCash / fishCash),
			licensesOfIncome: r4(s.spent.license / income),
			displayTanksOfIncome: r4(s.spent.display / income),
			netOfIncome: r4((s.companionCash - s.spent.license - s.spent.display) / income),
			upkeepOfIncome: 0,
		},
		xpEffect: s.xpEffect,
		milestones: s.milestones,
		raw: { income, fishCash, companionCash: s.companionCash },
	};
}

// Validation (5b.3): system() on the shared core against lifecycle().
/** lifecycle()'s "rods first" rule: keep the next rod tier's assembly cost once its crates unlock. */
function lifecycleReserve(state, ctx) {
	const nt = ctx.path[state.equippedTier + 1];
	return nt && ctx.gateLevel() >= crateUnlock(nt.tier) ? rodCost(nt.tier) : 0;
}

/**
 * lifecycle()'s gear and money assumptions as a validation-only system.
 *   gear   LC.provisionalRods' rule (curve.js): once the next tier's level is reached, save each step's stage
 *          income until it covers F.PURCHASE.saveHours of it, then equip. income 'stage' (lifecycle()'s rule):
 *          the stage's fish income WITHOUT the companion bonus (gearRates), so the XP timeline does not depend
 *          on the aquarium; 'cast': the core's cast income, bonus included (exactly LC.provisionalRods).
 *   money  each equip is charged the tier's rods.assembly(t).expectedCost ('progression', item 'rods'); each
 *          step on a crafted rod pays repairs at rods' upkeep share of that step's fish income without the
 *          bonus ('upkeep', 'repairs'); optionally `otherSpendShare` of each step's income, bonus included
 *          ('optional', 'other').
 */
function lifecycleMoney({ otherSpendShare = 0, income = 'stage' } = {}) {
	const name = 'aquariumLifecycleMoney';
	return {
		name,
		init(state) {
			state.sys[name] = { saving: 0 };
		},
		beforeStep(state, ctx, rates) {
			const next = ctx.path[state.equippedTier + 1];
			if (!next || rates.blocked || state.stepStartLevel < next.level) return;
			const m = state.sys[name];
			const perHour = income === 'cast' ? rates.perHour.cash : gearRates(rates.biome, ctx.path[state.equippedTier], ctx.arch.overheadS).cash;
			m.saving += income === 'cast' ? rates.cash : perHour * ctx.stepH;
			if (m.saving >= perHour * F.PURCHASE.saveHours) {
				state.equippedTier++;
				m.saving = 0;
				ctx.spend('progression', 'rods', rodCost(ctx.path[state.equippedTier].tier));
			}
		},
		onCasts(state, ctx, { rates }) {
			if (rates.blocked) return;
			const gear = ctx.path[rates.tier];
			if (gear.tier > 0) ctx.spend('upkeep', 'repairs', rods.PARAMS.repair.upkeepShare * gearRates(rates.biome, gear, ctx.arch.overheadS).cash * ctx.stepH);
			if (otherSpendShare > 0) ctx.spend('optional', 'other', otherSpendShare * rates.cash);
		},
	};
}

/** lifecycle()'s model on the shared core: system() + lifecycleMoney (its gear rule and money) + LC.provisionalDaily. */
function coreLifecycle(archetype, { conventions = 'core', otherSpendShare = 0, income = 'stage', water = PARAMS.model.primaryWater, mix, care, tiers, buy = true, ...simOpts } = {}) {
	return LC.simulate({
		archetype,
		gearPath: sharedPath(),
		systems: [
			system({ buy, conventions, reserve: lifecycleReserve, waters: [water], mix, care, tiers }),
			lifecycleMoney({ otherSpendShare, income }), LC.provisionalDaily(),
		],
		...simOpts,
	});
}

/**
 * One comparison of the core with lifecycle() (same archetype and options). Hours are compared step-exact:
 * lifecycle() rounds hours to 0.01 h (under a third of a step), from which its step index is recovered.
 * Purchases compare the purchase PASS (lifecycle() stamps the start of the step whose pass bought, i.e. one
 * step before its pass). Values are rounded as lifecycle() rounds them: totals to $1, payback to 0.01 h,
 * recoveredByEnd to 1e-4 (compared on its own scale, the price: a purchase made just before the end has
 * recovered a tiny share, and a relative difference of two 4-decimal roundings of it would be noise). Shares
 * of income are recomputed on both sides from the $1-rounded totals (lifecycle() prints them to 4 decimals,
 * where a 1e-4 difference straddling a rounding boundary would read as up to 0.4%).
 */
function compareWithLifecycle(archetype, variant = {}, conventions = 'core') {
	const stepH = F.LIFECYCLE.stepH;
	const stepOf = (hours) => Math.round(hours / stepH);
	const old = lifecycle(archetype, variant);
	const core = coreLifecycle(archetype, { ...variant, conventions });
	const sum = systemSummary(core);
	const water = variant.water || PARAMS.model.primaryWater;
	const out = { maxRel: 0, worst: null, milestonesCompared: 0, exactMilestones: 0, maxPassShiftSteps: 0 };
	const note = (key, a, b, scale = Math.abs(b)) => {
		const d = a === b ? 0 : Math.abs(a - b) / Math.max(scale, 1e-12);
		if (d > out.maxRel) {
			out.maxRel = d;
			out.worst = key;
		}
		return r4(d);
	};
	const milestones = {};
	for (const T of F.LIFECYCLE.milestones) {
		const o = old.reached[T];
		const c = core.milestones[T];
		if (!o || !c) {
			note(`L${T} reached`, o ? 1 : 0, c ? 1 : 0);
			continue;
		}
		const [kOld, kCore] = [stepOf(o.hours), stepOf(c.hours)];
		out.milestonesCompared++;
		if (kOld === kCore) out.exactMilestones++;
		milestones[T] = { old: o.hours, core: r2(c.hours), steps: kCore - kOld, rel: note(`L${T} hours`, kCore, kOld) };
	}
	const purchases = {};
	for (const k of TIERS) {
		const o = old.purchases[k];
		const c = sum.purchases[licenseName(k, water)];
		if (!o.bought || !c) {
			note(`${k} bought`, c ? 1 : 0, o.bought ? 1 : 0);
			purchases[k] = { old: o.bought, core: c ? c.bought : null };
			continue;
		}
		const pass = { gate: stepOf(c.raw.gatePassH) - (stepOf(o.gate.hours) + 1), bought: stepOf(c.raw.passH) - (stepOf(o.bought.hours) + 1) };
		out.maxPassShiftSteps = Math.max(out.maxPassShiftSteps, Math.abs(pass.gate), Math.abs(pass.bought));
		note(`${k} bought pass`, stepOf(c.raw.passH), stepOf(o.bought.hours) + 1);
		const payback = r2(c.raw.paybackAfterH);
		purchases[k] = {
			bought: { old: o.bought.hours, core: r2(c.raw.h), level: { old: o.bought.level, core: c.bought.level }, passShiftSteps: pass.bought, gatePassShiftSteps: pass.gate },
			paybackHoursAfterPurchase: { old: o.paybackHoursAfterPurchase, core: payback, extrapolated: o.paybackExtrapolated, rel: note(`${k} payback hours`, payback, o.paybackHoursAfterPurchase) },
			recoveredByEnd: { old: o.recoveredByEnd, core: c.recoveredByEnd, diffOfPrice: note(`${k} recovered by end (of price)`, c.recoveredByEnd, o.recoveredByEnd, 1) },
		};
	}
	const L = core.ledger;
	const coreTotals = Object.fromEntries(Object.entries({ fishCash: sum.raw.fishCash, companionCash: sum.raw.companionCash, repairs: L.spend.upkeep.repairs || 0, rods: L.spend.progression.rods || 0, licenses: sum.totals.licenses, otherSpend: L.spend.optional.other || 0 }).map(([k, v]) => [k, Math.round(v)]));
	const totals = Object.fromEntries(Object.entries(coreTotals).map(([k, v]) => [k, { old: old.totals[k], core: v, rel: note(`total ${k}`, v, old.totals[k]) }]));
	// lifecycle()'s share formulas (income = fish income + companion cash; no other cash source here).
	const sharesOf = (t) => {
		const income = t.fishCash + t.companionCash;
		return { companionOfFish: t.companionCash / t.fishCash, licensesOfIncome: t.licenses / income, netOfIncome: (t.companionCash - t.licenses) / income, rodsOfIncome: (t.rods + t.repairs) / income };
	};
	const [shOld, shCore] = [sharesOf(old.totals), sharesOf(coreTotals)];
	const shares = Object.fromEntries(Object.keys(shOld).map((k) => [k, { old: old.shares[k], core: r4(shCore[k]), rel: note(`share ${k}`, shCore[k], shOld[k]) }]));
	note('final money', Math.round(core.final.money), old.finalMoney);
	return {
		maxRel: out.maxRel, worst: out.worst, milestonesCompared: out.milestonesCompared, exactMilestones: out.exactMilestones, maxPassShiftSteps: out.maxPassShiftSteps,
		xpEffectMaxAbs: sum.xpEffect.maxAbs,
		row: { milestones, purchases, totals, shares, finalMoney: { old: old.finalMoney, core: Math.round(core.final.money) } },
	};
}

/**
 * The aquarium adds no XP: the core with system() (licenses bought, bonus on) and with system({ buy: false })
 * reach every level on the same step with the same XP ledger (milestone snapshots compared exactly).
 */
function noXpEffect(archetype) {
	const all = Array.from({ length: F.LIFECYCLE.maxLevel }, (_, i) => i + 1);
	const on = coreLifecycle(archetype, { milestones: all });
	const off = coreLifecycle(archetype, { milestones: all, buy: false });
	const same = all.every((T) => on.milestones[T] && off.milestones[T] && on.milestones[T].hours === off.milestones[T].hours && JSON.stringify(on.milestones[T].ledger.xp) === JSON.stringify(off.milestones[T].ledger.xp));
	return { same, levels: all.length, companionCash: Math.round(on.sys[SYSTEM_NAME].companionCash), xpEffectMaxAbs: on.sys[SYSTEM_NAME].xpEffect.maxAbs };
}

/**
 * The aquarium variant on the integrated reference loop (integrate.run, default system()): what it buys and
 * earns there, whether the license spend moves any XP milestone, and which other purchases (permits, rod
 * assemblies) it delays by competing for cash. Informational: other modules' systems are migrating in parallel,
 * so a failure is reported, not thrown.
 */
function integratedEffect(archetypes = Object.keys(F.ARCHETYPES)) {
	try {
		const I = require('./integrate');
		const rows = Object.fromEntries(archetypes.map((archetype) => {
			const withA = I.run({ archetype, variant: { aquarium: true } });
			const without = I.run({ archetype });
			const sum = systemSummary(withA);
			const hoursWith = LC.milestoneHours(withA);
			const hoursWithout = LC.milestoneHours(without);
			const shift = Object.fromEntries(Object.keys(hoursWithout).map((L) => [L, hoursWith[L] === undefined ? null : r4(hoursWith[L] - hoursWithout[L])]));
			const others = Object.fromEntries(without.purchases.map((p) => [p.id, p.hours]));
			const delayed = withA.purchases.filter((p) => !p.id.startsWith(`${SYSTEM_NAME}:`) && others[p.id] !== undefined && p.hours !== others[p.id]).map((p) => ({ id: p.id, hoursWithout: r2(others[p.id]), hoursWith: r2(p.hours) }));
			return [archetype, {
				xpMilestonesIdentical: Object.values(shift).every((d) => d === 0), milestoneShiftHours: shift,
				otherPurchasesMoved: delayed,
				licenses: Object.fromEntries(Object.values(sum.purchases).map((p) => [p.tier, { hours: r2(p.bought.hours), level: p.bought.level, paybackHoursAfterPurchase: p.paybackHoursAfterPurchase, paybackExtrapolated: p.paybackExtrapolated, recoveredByEnd: p.recoveredByEnd }])),
				totals: sum.totals, shares: sum.shares,
			}];
		}));
		return { systems: [...I.REFERENCE, SYSTEM_NAME], xpMilestonesIdentical: Object.values(rows).every((r) => r.xpMilestonesIdentical), byArchetype: rows };
	}
	catch (e) {
		return { error: e.message };
	}
}

let validation = null;
/**
 * validateSystem(): system() on the shared core (LC.simulate) vs this module's lifecycle(), for every archetype
 * (default options, 15% and 30% of income spent elsewhere) and, for the reference player, every pet mix, care on
 * half the days and Saltwater. The baseline systems are the assumptions lifecycle() made: LC.provisionalRods
 * (its gear rule), lifecycleMoney (rods' assembly costs at each equip, repairs, other spend), LC.provisionalDaily
 * (its daily XP) and lifecycleReserve (its rods-first rule, as the goals' reserve). `system` = the default
 * system (core conventions); `replay` = the same system with lifecycle()'s conventions, which isolates them.
 */
function validateSystem({ tolerance = 0.005 } = {}) {
	if (validation) return validation;
	const archetypes = Object.keys(F.ARCHETYPES);
	const ref = F.REFERENCE_ARCHETYPE;
	const cases = [
		...archetypes.map((a) => ({ key: a, archetype: a, variant: {} })),
		...PARAMS.model.otherSpendShares.filter((x) => x > 0).flatMap((x) => archetypes.map((a) => ({ key: `${a}@otherSpend${x}`, archetype: a, variant: { otherSpendShare: x } }))),
		...PARAMS.model.mixes.filter((m) => m !== PARAMS.model.typicalMix).map((m) => ({ key: `${ref}@mix:${m}`, archetype: ref, variant: { mix: m } })),
		{ key: `${ref}@care0.5`, archetype: ref, variant: { care: 0.5 } },
		{ key: `${ref}@Saltwater`, archetype: ref, variant: { water: 'Saltwater' } },
	];
	const run = (conventions) => {
		const agg = { maxRel: 0, worst: null, exact: 0, compared: 0, maxPassShiftSteps: 0, xpEffectMaxAbs: 0, cases: {} };
		for (const c of cases) {
			const r = compareWithLifecycle(c.archetype, c.variant, conventions);
			if (r.maxRel > agg.maxRel) {
				agg.maxRel = r.maxRel;
				agg.worst = `${c.key} ${r.worst}`;
			}
			agg.exact += r.exactMilestones;
			agg.compared += r.milestonesCompared;
			agg.maxPassShiftSteps = Math.max(agg.maxPassShiftSteps, r.maxPassShiftSteps);
			agg.xpEffectMaxAbs = Math.max(agg.xpEffectMaxAbs, r.xpEffectMaxAbs);
			agg.cases[c.key] = r.row;
		}
		return {
			conventions,
			maxRelativeDifference: agg.maxRel, worst: agg.worst,
			exactMilestones: `${agg.exact}/${agg.compared}`, maxPurchasePassShiftSteps: agg.maxPassShiftSteps, xpEffectMaxAbs: agg.xpEffectMaxAbs,
			cases: agg.cases,
		};
	};
	const main = run('core');
	const replay = run('lifecycle');
	const noXp = Object.fromEntries(archetypes.map((a) => [a, noXpEffect(a)]));
	// The gear rule: LC.provisionalRods itself saves the core's cast income, companion bonus included.
	const gearRule = Object.fromEntries(archetypes.map((a) => {
		const on = LC.milestoneHours(coreLifecycle(a, { income: 'cast' }));
		const off = LC.milestoneHours(coreLifecycle(a, { income: 'cast', buy: false }));
		const steps = Object.fromEntries(Object.keys(off).map((T) => [T, Math.round((on[T] - off[T]) / F.LIFECYCLE.stepH)]));
		return [a, { maxShiftSteps: Math.max(...Object.values(steps).map(Math.abs)), steps }];
	}));
	validation = {
		method: 'LC.simulate(system() + lifecycleMoney (LC.provisionalRods\' rule on stage income without the bonus; rods.assembly cost at each equip, repairs at rods\' upkeep share, other spend) + LC.provisionalDaily; goals reserve = lifecycleReserve, lifecycle()\'s rods-first rule) on the shared gear path vs lifecycle(archetype, variant). Compared: milestone hours (step indices), each license\'s purchase pass (step indices), payback hours after purchase, share of the price recovered by the end, run totals (fish income without the bonus, companion cash, repairs, rods, licenses, other spend), shares of income and final money.',
		archetypes, cases: cases.map((c) => c.key),
		matches: main.maxRelativeDifference < tolerance && replay.maxRelativeDifference < 1e-4 && Object.values(noXp).every((x) => x.same),
		tolerance,
		maxRelativeDifference: r4(main.maxRelativeDifference),
		worst: main.worst,
		system: { ...main, maxRelativeDifference: r4(main.maxRelativeDifference) },
		replay: { ...replay, maxRelativeDifference: replay.maxRelativeDifference, cases: undefined, exact: replay.maxRelativeDifference === 0 && replay.maxPurchasePassShiftSteps === 0 },
		noXpEffect: noXp,
		gearRuleSensitivity: {
			note: 'Milestone shift (steps) from buying the aquarium when the gear rule is LC.provisionalRods as is (it saves the core\'s cast income, bonus included) instead of lifecycle()\'s rule (stage income without the bonus). While a bond ramps, the bonus rises step by step, so the saved sum trails "saveHours of the current step\'s income" and a tier can be equipped a step later. That is an artifact of the placeholder rule reading income, not an XP effect of the aquarium (its casts\' XP is measured identical: xpEffectMaxAbs 0). lifecycle()\'s rule is the right baseline here; the integrated rods system buys at a fixed assembly cost (see integrated).',
			byArchetype: gearRule,
		},
		integrated: integratedEffect(),
		differences: [
			'Days: the core counts a level reached on a day\'s final step in that day (ceil(h/dayH) counted the next day), so hours are compared, not days.',
			'Stamps: lifecycle() stamps a purchase (and a gate) at the START of the step whose purchase block bought it; the core buys in the purchase pass after that step (its income is already in), so the comparison uses the pass. lifecycle() stamps payback at the start of the step whose income completed it, the core at its end: payback hours after purchase count the same steps.',
			'Bond clock (the one rule difference, conventions \'core\'): lifecycle() starts a purchase\'s bond ramp at the start of the step that paid for it, one step (1 min of play) before the pets are adopted; the core starts it at the purchase. The ramp (7 care days) is therefore one step behind lifecycle()\'s, which lowers companion cash by about 1e-4 of it and payback hours by at most 0.02 h; the largest relative difference is on a small net (companion cash minus licenses) for the casual player spending 30% elsewhere. The core is right: bond starts at adoption. The replay (conventions \'lifecycle\') isolates this rule and is exact.',
			'Day-end purchase pass (conventions \'core\'): the core also runs goals after a day\'s last step. A gate level reached on that step is acted on before the next session (lifecycle() waited for the next step\'s purchase block, with that step\'s income). The replay skips the day-end pass.',
			'Extrapolated payback (after Lv 60): lifecycle() counts from the start of the paying step to the end of the run, one step more than the steps the purchase actually earned over (its own non-extrapolated paybacks count the earning steps); the core counts the earning steps. The replay reproduces lifecycle()\'s count.',
			'Floats: companion cash is measured on the core\'s cast (cash with minus without the bonus), lifecycle() computes cash x bonus / (1 + gear sellBonus); equal up to rounding.',
		],
	};
	return validation;
}

/** The system's contract and its validation, for report(). */
function systemReport() {
	return {
		name: SYSTEM_NAME,
		defaults: { buy: true, displayTanks: false, waters: [PARAMS.model.primaryWater], tiers: [...TIERS], mix: PARAMS.model.typicalMix, care: PARAMS.model.care, reserve: 0, conventions: 'core' },
		hooks: ['init', 'goals', 'modifyCast', 'beforeStep', 'onCasts', 'onDayStart', 'onDayEnd', 'on'],
		events: { listens: ['levelUp'], emits: [] },
		ledger: {
			xpSources: [], cashSources: [],
			spend: Object.entries(SPEND).map(([kind, x]) => ({ kind, category: x.category, item: `${x.prefix}<name>`, priority: x.priority, blocking: false })),
			note: 'The core\'s \'fishing\' cash includes the companion bonus (a cast stat). Its share is state.sys.aquarium.companionCash (per purchase: purchases[i].cash; at milestones: milestones / publicMilestones). No money upkeep, no boxes.',
		},
		integration: 'integrate.run({ variant: { aquarium: true } }) adds system()',
		validation: validateSystem(),
	};
}

// ---------------------------------------------------------------------------------------------
let cached = null;
function buildReport() {
	const stamp = F.stamp();
	const lic = licenses();
	const archetypes = Object.keys(F.ARCHETYPES);
	const priceTable = TIERS.map((k) => {
		const t = PARAMS.licenses.tiers[k];
		const row = lic.find((l) => l.tier === k && l.water === PARAMS.model.primaryWater);
		return {
			tier: k, level: t.level, price: row.price, priceHours: t.priceHours, stage: row.gateStage,
			current: lic.filter((l) => l.tier === k).map((l) => ({ name: l.name, price: l.current?.price, level: l.current?.level, size: l.current?.size })),
			hoursOfGateIncome: Object.fromEntries(archetypes.map((n) => {
				const hrs = row.price / stageAt(t.level, { overheadS: F.ARCHETYPES[n].overheadS }).cashPerHour;
				return [n, { hours: r2(hrs), days: r2(hrs / hoursPerDay(n)) }];
			})),
		};
	});
	const lifecycles = Object.fromEntries(archetypes.map((n) => [n, lifecycle(n)]));
	const sensitivity = {
		otherSpend: Object.fromEntries(archetypes.map((n) => [n, Object.fromEntries(PARAMS.model.otherSpendShares.map((s) => [s, Object.fromEntries(TIERS.map((k) => [k, lifecycle(n, { otherSpendShare: s }).purchases[k].bought]))]))])),
		mix: Object.fromEntries(PARAMS.model.mixes.map((m) => {
			const l = lifecycle(F.REFERENCE_ARCHETYPE, { mix: m });
			return [m, { companionOfFish: l.shares.companionOfFish, recovered: Object.fromEntries(TIERS.map((k) => [k, l.purchases[k].recoveredByEnd])), paybackHours: Object.fromEntries(TIERS.map((k) => [k, l.purchases[k].paybackHoursAfterPurchase])) }];
		})),
		care: Object.fromEntries([1, 0.5].map((c) => {
			const l = lifecycle(F.REFERENCE_ARCHETYPE, { care: c });
			return [c, { companionOfFish: l.shares.companionOfFish, recovered: Object.fromEntries(TIERS.map((k) => [k, l.purchases[k].recoveredByEnd])) }];
		})),
		bothWaterTypes: Object.fromEntries(archetypes.map((n) => {
			const fresh = lifecycles[n];
			const salt = lifecycle(n, { water: 'Saltwater' });
			return [n, { extraSpend: salt.totals.licenses, shareOfIncome: r4(salt.totals.licenses / (fresh.totals.fishCash + fresh.totals.companionCash)) }];
		})),
	};
	const levels = TIERS.map((k) => PARAMS.licenses.tiers[k].level);
	const petSupply = levels.map((L) => availability(L));
	const saleExamples = [
		{ label: 'adopted 1 day ago', ageDays: 1 },
		{ label: '14 days', ageDays: 14 },
		{ label: '28+ days', ageDays: 28 },
		{ label: '28+ days, attraction 25', ageDays: 28, attraction: 25 },
		{ label: '28+ days, bred', ageDays: 28, bred: true },
		{ label: '28+ days, not thriving', ageDays: 28, thriving: false },
	].map((e) => ({ ...e, factor: r4(petSaleValue({ speciesValue: 1, ...e })) }));
	const speciesExamples = ['common', 'legendary', 'lucky'].flatMap((r) => ['River', 'Swamp'].map((b) => {
		const v = speciesValues(b, r);
		return v ? { biome: b, rarity: r, mean: Math.round(v.mean), max: Math.round(v.max), maxSale: Math.round(petSaleValue({ speciesValue: v.max, ageDays: 28, attraction: 25 })) } : null;
	})).filter(Boolean);
	return {
		...stamp,
		gearPathSource: F.GEAR_PATH_SOURCE,
		params: PARAMS,
		current: { licenses: currentLicenses(), exploit: currentExploit() },
		licenses: lic,
		priceTable,
		companion: {
			perPet: PARAMS.companion.perPet, bondDays: bondDays(), thrive: PARAMS.companion.thrive,
			byTier: TIERS.map((k) => ({ tier: k, slots: PARAMS.licenses.tiers[k].companionSlots, byMix: Object.fromEntries(PARAMS.model.mixes.map((m) => [m, r4(PARAMS.licenses.tiers[k].companionSlots * PARAMS.companion.perPet[m])])) })),
			cashPerHourAtStages: F.LIVE_BIOMES.map((b) => {
				const L = F.BIOME_LEVEL[b];
				const s = stageAt(L);
				const tierHeld = [...TIERS].reverse().find((k) => PARAMS.licenses.tiers[k].level <= L) || null;
				const bonus = tierHeld ? holdingsBonus({ Freshwater: tierHeld }) : 0;
				return { biome: b, level: L, gear: s.tier, cashPerHour: Math.round(s.cashPerHour), tierHeld, bonus: r4(bonus), extraCashPerHour: Math.round(companionCash(s.cashPerHour, s.gearSell, bonus)) };
			}),
			petSupply,
		},
		lifecycles,
		sensitivity,
		upkeep: upkeepAlternatives(),
		sale: { examples: saleExamples, species: speciesExamples },
		breeding: { cooldownDays: PARAMS.breeding.cooldownDays, examples: currentExploit().breeding.examples },
		petIncome: incomeBoundTable(),
		r2: (() => {
			// INTEGRATION_REQUIREMENTS R2: the aquarium is not an XP source; its only calendar-based cash is pet
			// sales, capped per week. The minimum-daily player can take at most this much from it.
			const inc = incomeBoundTable();
			const top = inc.rows.reduce((a, b) => (b.weekly > a.weekly ? b : a));
			return {
				aquariumXp: 0, companionBonusRequiresFishing: true,
				petCashWeeklyMax: top.weekly, from: `${top.parents} ${top.biome} parents, ${top.capacity}`,
				shareOfWeeklyFishing: top.shareOfWeeklyFishing,
				verdict: 'No XP from the aquarium, and its cash bonus scales with fish caught, so it cannot make barely fishing optimal. Pet sales are the only calendar-based cash. The weekly rehoming limit caps them below a regular player\'s fishing income.',
			};
		})(),
		legacy: LICENSE_CATALOG.map((l) => {
			const d = licenseByName(l.name);
			const tier = d.tier;
			return {
				name: l.name, paidToday: l.price, storedSize: l.aquarium.size, tanksToday: 'unlimited',
				effectiveTankSize: Math.max(l.aquarium.size, d.tankSize), tanksProposed: d.tanks, newPrice: d.price,
				companionSlotsAtLevel: Object.fromEntries([...new Set([0, ...TIERS.map((k) => PARAMS.licenses.tiers[k].level)])].map((L) => [L, companionSlots({ [d.water]: tier }, L)])),
			};
		}),
		display: displayTanks(),
		options: { level15: aquariumOptions(15), level45Advanced: aquariumOptions(45, { owned: { Freshwater: 'advanced' } }), level50Expert: aquariumOptions(50, { owned: { Freshwater: 'expert', Saltwater: 'basic' } }) },
		baseline: baselineMatchesCurveJson(),
		checks: checks(),
		system: systemReport(),
	};
}
function report() {
	if (!cached) cached = buildReport();
	return cached;
}

module.exports = {
	PARAMS, CURRENT,
	waterOf, stageAt, licensePrice, licenses, licenseByName,
	bondFactor, perPetBonus, companionSlots, companionBonus, holdingsBonus,
	thriving, effectiveTemperature, petSaleValue, speciesValue, breedingRate, petIncomeBound, availability,
	aquariumOptions, displayTanks, lifecycle, baselineMatchesCurveJson,
	currentExploit, currentLicenses, upkeepAlternatives, checks, report,
	SYSTEM_NAME, SPEND, system, systemSummary, validateSystem, lifecycleReserve, lifecycleMoney, coreLifecycle,
};

if (require.main === module) process.stdout.write(`${JSON.stringify(report(), null, 1)}\n`);
