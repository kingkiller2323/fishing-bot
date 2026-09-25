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
//   baselineMatchesCurveJson()   the lifecycle reproduces docs/economy/5b/curve.json milestones exactly
//   currentExploit()             today's /pet play -> /pet sell money rate, breeding odds, temperature factors
//   currentLicenses()            today's license catalog priced in hours of proposed stage income
//   upkeepAlternatives()         why no money upkeep: a flat daily fee as a share of the bonus per archetype
//   checks()                     design-target checks (pass/fail)
//   report()                     every number in docs/economy/5b/aquarium.md (cached), with ...F.stamp()
const F = require('./framework');
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
	const key = `${biome}|${tier.key}|${overheadS}`;
	if (!rateCache.has(key)) {
		const outcome = F.castOutcome({ biome, qualities: tier.qualities, stats: tier.stats, multiChance: F.chanceForMean(tier.meanFish) });
		rateCache.set(key, { ...F.hourly(outcome, overheadS), outcome, gearSell: tier.stats.sellBonus || 0 });
	}
	return rateCache.get(key);
}
function stageAt(level, { overheadS = F.DESIGN_OVERHEAD_S } = {}) {
	const tier = F.tierAt(level);
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
	const tier = F.tierAt(level);
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
 * @param {string|object} archetype
 * @param {object} opts { tiers (license tiers to buy, in order), water, mix, care, otherSpendShare (share of
 *   income spent elsewhere, e.g. permits), rodSpend (charge rods.assembly + repairs), reserveRods (keep the
 *   next rod tier's cost when its crates are unlocked), maxLevel }
 */
function lifecycle(archetype, opts = {}) {
	const a = archOf(archetype);
	const { tiers = TIERS, water = PARAMS.model.primaryWater, mix = PARAMS.model.typicalMix, care = PARAMS.model.care, otherSpendShare = 0, rodSpend = true, reserveRods = true, maxLevel = F.LIFECYCLE.maxLevel } = opts;
	const path = F.gearPath();
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

/** The lifecycle's XP timeline equals docs/economy/5b/curve.json for every archetype (aquarium adds no XP). */
function baselineMatchesCurveJson() {
	const rows = Object.keys(F.ARCHETYPES).map((name) => {
		const mine = lifecycle(name, { tiers: [] }).reached;
		const theirs = CURVE_JSON.archetypes[name];
		const same = Object.keys(theirs).every((L) => mine[L] && mine[L].hours === theirs[L].hours && mine[L].day === theirs[L].day);
		return { archetype: name, same };
	});
	const withAquarium = Object.keys(F.ARCHETYPES).every((name) => JSON.stringify(lifecycle(name).reached) === JSON.stringify(lifecycle(name, { tiers: [] }).reached));
	return { pass: rows.every((r) => r.same) && withAquarium && CURVE_JSON.chosen === F.CURVE.quartic, rows, aquariumChangesXp: !withAquarium };
}

// ---------------------------------------------------------------------------------------------
// Today (quantified from the mirrored rules and the measurements).
function currentExploit() {
	const traits = traitDistribution();
	const actionsPerHour = 3600 / CURRENT.commandCooldownS;
	const perPet = (m, att) => actionsPerHour * CURRENT.careXp * m * att;
	const measuredBest = MEASURED.results.filter((x) => x.profile === 'normal').map((x) => ({ key: x.key, cashPerHour: (x.valueBase / x.casts) * (3600 / (x.cooldownMs / 1000 + F.DESIGN_OVERHEAD_S)) })).sort((a, b) => b.cashPerHour - a.cashPerHour)[0];
	const bestProposed = Math.max(...F.LIVE_BIOMES.flatMap((b) => F.gearPath().map((t) => gearRates(b, t, F.DESIGN_OVERHEAD_S).cash)));
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
	return { stage: `${biome} ${F.tierAt(top).key}`, rows };
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
};

if (require.main === module) process.stdout.write(`${JSON.stringify(report(), null, 1)}\n`);
