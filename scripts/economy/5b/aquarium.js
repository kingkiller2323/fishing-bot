// Phase 5B · Aquarium, pets and aquarium licenses (framework 5b.4). ANALYSIS ONLY: nothing here touches the
// live game, src/ or production data.
//
// The aquarium is a SYSTEM on the shared lifecycle core (lifecycle.js, composed by integrate.js). This module
// never steps time. Per-stage figures (license and display-tank prices, companion cash per hour, pet supply,
// upkeep sizing, the pet income bound) come from the framework's castOutcome()/hourly() at the shared gear tier
// of a level (F.gearPath(), the rods design). Every number over a player's lifecycle (when licenses are bought,
// payback, shares of income, the no-XP proof) comes from integrate.run(): the reference core loop (rods, world,
// quests, streak, buffs) with variant.aquarium true against false. Only design parameters are hand-set
// (PARAMS); every non-obvious choice in them, and each fix-first correctness item, is a PROPOSED decision in
// DECISIONS (only the user approves). docs/economy/5b/aquarium.md's tables are generated from markdownTables()
// by render-docs.js.
//
//   node scripts/economy/5b/aquarium.js              prints report() as JSON
//   node scripts/economy/5b/render-docs.js           fills docs/economy/5b/aquarium.md from markdownTables()
//
// Exports
//   PARAMS, CURRENT, DECISIONS   design parameters; a frozen mirror of TODAY's rules (src/class/Pet.js,
//                                Aquarium.js, pet.js, licenses.js), used only for the exploit and bug figures; the
//                                proposed decisions (decisions.js shape, joined there)
//   waterOf(biome)               'Freshwater' | 'Saltwater' | null
//   stageAt(level, {overheadS})  F.castOutcome/F.hourly at the biome and shared gear tier of a level
//   licensePrice(tier)           PARAMS priceHours x the gate stage's income (2 significant digits)
//   licenses(), licenseByName(n) the six proposed license rows; the proposed definition of a catalog name
//   bondFactor, perPetBonus, companionSlots, companionBonus, holdingsBonus
//                                the companion bonus rules (holdingsBonus: the sellBonus a holding gives)
//   thriving, effectiveTemperature, petSaleValue, speciesValue, breedingRate, petIncomeBound, availability
//                                care, temperature, sale, breeding and pet-supply rules (pure)
//   aquariumOptions(level, o)    what a player can buy at `level` given what they own (what system() offers)
//   displayTanks()               display-tank prices and hours of top-stage income per archetype
//   currentExploit(), currentLicenses(), upkeepAlternatives()
//                                today's /pet play -> /pet sell rate, breeding odds and temperature factors; today's
//                                license catalog in hours of proposed income; why no money upkeep
//   system(opts), systemSummary(result)
//                                the aquarium system (lifecycle.js hooks; see system()); its figures from a run
//   lifecycle(archetype, opts)   one INTEGRATED lifecycle (integrate.run, reference loop + this system, against the
//                                same loop without it): purchases, payback, shares of income, XP and progression effect
//   integratedReport()           every archetype (and the minimum-daily player), the money-bait variant and the
//                                sensitivity runs (pet mix, care, both water types, display tanks)
//   RETIRED_LOOP_PARITY          the recorded parity of system() with the retired private loop (a83b5f0)
//   checks(), report(), markdownTables()
const F = require('./framework');
const LC = require('./lifecycle');
const { FISH, drawDistribution } = require('../lib/catalog-model');
const { RARITIES } = require('../../../src/engine/balance');
const LICENSE_CATALOG = require('../../../src/bootstrap/data/licenses');
const MEASURED = require('../../../docs/economy/measurements.json');
// integrate.js loads this module through its registry: required lazily.
const INTEGRATE = () => require('./integrate');

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
// Design parameters (the only hand-set values in this module). Every non-obvious choice is in DECISIONS.
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
		// Model settings (not design choices): the water type licensed first, the pets filling the companion
		// slots, the share of fishing time they thrive, the sensitivity mixes and the income-bound parents.
		primaryWater: 'Freshwater',
		typicalMix: 'legendary',
		mixes: ['common', 'rare', 'legendary', 'lucky'],
		care: 1,
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

// Sensitivity probes on the integrated model (not design values): care on half the fishing time.
const SENSITIVITY = deepFreeze({ care: [0.5] });

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
	// /build (src/commands/slash/Pet/build.js): needs any license of the water type and a unique name; no
	// tank limit; command cooldown options.cooldown 10_000 ms. Habitat documents carry createdAt
	// (HabitatSchema { timestamps: true }).
	buildCooldownS: 10,
	tankLimit: null,
	driftPerHour: 1,
	temperatureIdeal: { hunger: 25, mood: 0, stress: 0, health: 0 },
	// HabitatSchema.temperature default.
	newTankC: 0,
});
// Tank temperatures the temperature table reads today's factors and the proposed read at (the last one is a
// long-drifted legacy tank).
const TEMPERATURE_EXAMPLES_C = [0, 25, 50, 100, 812];

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
	const key = `${biome}|${tier.key}|${tier.meanFish}|${tier.qualities.join(',')}|${JSON.stringify(tier.stats)}|${overheadS}`;
	if (!rateCache.has(key)) {
		const outcome = F.castOutcome({ biome, qualities: tier.qualities, stats: tier.stats, multiChance: tier.multiChance ?? F.chanceForMean(tier.meanFish) });
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
/** The sellBonus a holding gives with every companion slot filled by `mix` pets. */
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
/** Proposed sale value. Pet XP (bond) is deliberately not an input: it never converts to cash. */
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
	const best = incomeA >= incomeB ? { strategy: 'sell at birth', births: birthsA, weekly: incomeA } : { strategy: 'age to full value', births: birthsB, weekly: incomeB };
	// The weekly rehoming limit caps sales whatever the capacity.
	const sales = Math.min(best.births, s.maxPerWeek);
	const weekly = best.births > 0 ? best.weekly * (sales / best.births) : 0;
	return { strategy: best.strategy, births: r2(best.births), sales: r2(sales), capped: best.births > s.maxPerWeek, weeklyUncapped: Math.round(best.weekly), weekly: Math.round(weekly) };
}

/**
 * Fish of each rarity caught per hour at a level's stage (framework draw model; Lucky items excluded), under
 * the framework's Lucky-item rule (the stage outcome's own item share), so the counts match castOutcome().
 */
function availability(level, { overheadS = F.DESIGN_OVERHEAD_S } = {}) {
	const s = stageAt(level, { overheadS });
	const tier = F.tierAt(level, sharedPath());
	const fishByRarity = Object.fromEntries(RARITIES.map((r) => [r, 0]));
	for (const d of drawDistribution(s.biome, tier.qualities, s.outcome.table, { luckyItemShare: s.outcome.luckyItemShare })) if (d.kind === 'fish') fishByRarity[d.rarity] += d.p;
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
	const top = stageAt(topLevel());
	const byArchetype = Object.fromEntries(Object.keys(F.ARCHETYPES).map((name) => {
		const cash = stageAt(topLevel(), { overheadS: F.ARCHETYPES[name].overheadS }).cashPerHour;
		const h = totalPerWater / cash;
		return [name, { hoursPerWater: r2(h), daysPerWater: r2(h / hoursPerDay(name)), hoursBoth: r2(2 * h), daysBoth: r2((2 * h) / hoursPerDay(name)) }];
	}));
	return { stage: { level: topLevel(), biome: top.biome, tier: top.tier, cashPerHour: Math.round(top.cashPerHour) }, tanks, totalPerWater, totalBoth: 2 * totalPerWater, byArchetype };
}

// ---------------------------------------------------------------------------------------------
/**
 * Legacy tanks built before A6 ships (EXP-5). /build has no tank limit today (CURRENT.tankLimit null, one
 * tank per CURRENT.buildCooldownS), and P-AQUARIUM-LEGACY-LICENSES grandfathers every existing Habitat at
 * max(stored size, the license's new tank size). Capacity at release of the tanks one minute of /build
 * makes today, per water type, as proposed and under the two alternatives: upsize only up to the license's
 * new tank count (extra legacy tanks keep their stored size), or grandfather only Habitats created before a
 * cutoff (later ones count against the new limit). Display tanks (the aspirational sink) are the priced
 * comparison. Capacity only: companion slots come from the license tier and pet sales are weekly-limited.
 */
function legacyTankExposure({ minutes = 1 } = {}) {
	const built = Math.floor((minutes * 60) / CURRENT.buildCooldownS);
	const dt = displayTanks();
	const displayCapacity = PARAMS.display.perWaterType * PARAMS.display.tankSize;
	const displayReplaced = (extra) => {
		const n = Math.min(PARAMS.display.perWaterType, Math.floor(extra / PARAMS.display.tankSize));
		return { tanks: n, price: dt.tanks.slice(0, n).reduce((a, t) => a + t.price, 0) };
	};
	const rows = TIERS.map((k) => {
		const t = LT[k];
		const cat = LICENSE_CATALOG.find((l) => l.name === licenseName(k, PARAMS.model.primaryWater));
		const stored = cat.aquarium.size;
		const read = Math.max(stored, t.tankSize);
		const allowance = t.tanks * t.tankSize;
		const capacity = {
			proposed: built * read,
			upsizeUpToTankCount: Math.min(built, t.tanks) * read + Math.max(0, built - t.tanks) * stored,
			cutoffBeforeBuild: Math.min(built, t.tanks) * read,
		};
		const extra = Object.fromEntries(Object.entries(capacity).map(([o, c]) => [o, Math.max(0, c - allowance)]));
		const tanksToMatchDisplay = Math.ceil(displayCapacity / read);
		return {
			tier: k, license: cat.name, tanks: t.tanks, tankSize: t.tankSize, allowance, storedSize: stored, readSize: read,
			built, capacity, extra,
			displayReplacedAsProposed: displayReplaced(extra.proposed),
			displayReplacedUpsizeUpToTankCount: displayReplaced(extra.upsizeUpToTankCount),
			tanksToMatchDisplay, secondsToMatchDisplay: tanksToMatchDisplay * CURRENT.buildCooldownS,
			displayNeedsExpert: PARAMS.display.requires !== k,
		};
	});
	// The rows are for the primary water type; do the other water type's licenses have the same stored sizes?
	const sizesOf = (w) => TIERS.map((k) => LICENSE_CATALOG.find((l) => l.name === licenseName(k, w)).aquarium.size);
	const sameForEveryWater = WATER_TYPES.every((w) => JSON.stringify(sizesOf(w)) === JSON.stringify(sizesOf(PARAMS.model.primaryWater)));
	return { minutes, built, buildCooldownS: CURRENT.buildCooldownS, displayCapacityPerWater: displayCapacity, displayPricePerWater: dt.totalPerWater, water: PARAMS.model.primaryWater, sameForEveryWater, rows };
}

// ---------------------------------------------------------------------------------------------
/**
 * What a player at `level` can buy from this subsystem (what system() offers).
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
// Today (quantified from the mirrored rules and the measurements).
function currentExploit() {
	const traits = traitDistribution();
	const actionsPerHour = 3600 / CURRENT.commandCooldownS;
	const perPet = (m, att) => actionsPerHour * CURRENT.careXp * m * att;
	const measuredBest = MEASURED.results.filter((x) => x.profile === 'normal').map((x) => ({ key: x.key, cashPerHour: (x.valueBase / x.casts) * (3600 / (x.cooldownMs / 1000 + F.DESIGN_OVERHEAD_S)) })).sort((a, b) => b.cashPerHour - a.cashPerHour)[0];
	const [measuredBiome, measuredRod] = measuredBest.key.split('|');
	const best = F.LIVE_BIOMES.flatMap((b) => sharedPath().map((t) => ({ biome: b, tier: t.key, cash: gearRates(b, t, F.DESIGN_OVERHEAD_S).cash }))).reduce((a, x) => (x.cash > a.cash ? x : a));
	// Low case: no XP multiplier and the smallest non-zero attraction a trait gives; high case: both at their maximum.
	const minAttraction = Math.min(...['color', 'finShape'].flatMap((t) => Object.values(CURRENT.traits[t].attraction)).filter((a) => a > 0));
	const low = perPet(1, minAttraction);
	const high = perPet(traits.multiplier.max, traits.attraction.max);
	// One Expert tank (3 pets) with both commands: /pet (1 pet) + /aquarium feed (3 pets) each every 3 s.
	const tank = (actionsPerHour * (1 + 3) * CURRENT.careXp) * traits.multiplier.max * traits.attraction.max;
	const temps = TEMPERATURE_EXAMPLES_C.map((T) => ({
		temperatureC: T,
		hungerFactor: r2(1 + Math.abs(T - CURRENT.temperatureIdeal.hunger) / 25),
		moodStressFactor: r2(1 + Math.abs(T - CURRENT.temperatureIdeal.mood) / 100),
		healthFactor: r2(Math.max(0, 1 - Math.abs(T - CURRENT.temperatureIdeal.health) / 100)),
		proposedReadC: effectiveTemperature(T),
		proposedDeviationC: Math.abs(effectiveTemperature(T) - PARAMS.temperature.idealC),
		proposedTempOk: Math.abs(effectiveTemperature(T) - PARAMS.temperature.idealC) <= PARAMS.companion.thrive.temperatureBandC,
	}));
	return {
		playSell: {
			actionsPerHour, xpPerAction: CURRENT.careXp, commandCooldownS: CURRENT.commandCooldownS, attractionUnlockDays: CURRENT.traits.finShape.unlockAgeDays,
			lowCase: { multiplier: 1, attraction: minAttraction }, highCase: { multiplier: traits.multiplier.max, attraction: traits.attraction.max },
			cashPerHourOnePet: { low: Math.round(low), high: Math.round(high) },
			cashPerHourExpertTank: Math.round(tank),
			vsBestProposedFishing: { biome: best.biome, tier: best.tier, cashPerHour: Math.round(best.cash), ratioLow: r2(low / best.cash), ratioHigh: r2(high / best.cash), ratioTank: r2(tank / best.cash) },
			vsBestMeasuredToday: { key: measuredBest.key, biome: measuredBiome, rod: measuredRod, cashPerHour: Math.round(measuredBest.cashPerHour), ratioHigh: r2(high / measuredBest.cashPerHour), ratioTank: r2(tank / measuredBest.cashPerHour) },
			breedingAttemptsPerSuccessAtBest: { today: Math.round(1 / breedingRate(0, 100).today), fixed: r2(1 / breedingRate(0, 100).fixed) },
		},
		traits,
		breeding: {
			formula: 'max(min(0.65, (50 - stress)/50), max(min(0.6, health/100 - 0.5), 0.1)); success if rng.random()*100 < rate',
			examples: [[0, 100], [20, 80], [40, 60], [80, 50]].map(([s, hp]) => ({ stress: s, health: hp, ...breedingRate(s, hp) })),
		},
		temperature: { driftPerHour: CURRENT.driftPerHour, ideal: CURRENT.temperatureIdeal, newTankC: CURRENT.newTankC, factors: temps, hoursToZeroHealthFromNewTank: (100 - CURRENT.newTankC) / CURRENT.driftPerHour },
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
		share,
		rows,
		perCastAlternative: 'a fee per cast (food eaten per catch) is only a smaller bonus: it changes no decision',
	};
}

// Pet income bound per capacity and parent rarity, against weekly fishing income at the top live stage.
function incomeBoundTable() {
	const top = topLevel();
	const biome = F.biomeAt(top);
	const ex = PARAMS.licenses.tiers.expert;
	const rows = [];
	for (const parents of PARAMS.model.incomeBoundParents) {
		const v = speciesValues(biome, parents);
		if (!v) continue;
		const setups = [
			['Expert, one water type', ex.tanks * ex.tankSize, ex.tanks],
			['Expert, both water types + all display tanks', 2 * (ex.tanks * ex.tankSize + PARAMS.display.perWaterType * PARAMS.display.tankSize), 2 * (ex.tanks + PARAMS.display.perWaterType)],
		];
		for (const [label, capacity, tanks] of setups) {
			const b = petIncomeBound({ capacity, tanks, value: v.max });
			const shareOfWeeklyFishing = Object.fromEntries(Object.keys(F.ARCHETYPES).map((name) => {
				const weekly = stageAt(top, { overheadS: F.ARCHETYPES[name].overheadS }).cashPerHour * hoursPerDay(name) * 7;
				return [name, { uncapped: r4(b.weeklyUncapped / weekly), capped: r4(b.weekly / weekly) }];
			}));
			rows.push({ parents, biome, speciesValueMax: Math.round(v.max), capacity: label, slots: capacity, ...b, shareOfWeeklyFishing });
		}
	}
	return { stage: `${biome} ${F.tierAt(top, sharedPath()).key}`, rows };
}

// ---------------------------------------------------------------------------------------------
// The aquarium as a SYSTEM on the shared lifecycle core (lifecycle.js; contract in its header and integrate.js).
// License and display-tank purchases, and the companion sell bonus with its bond ramp. No XP effect, no boxes,
// no money upkeep.
const SYSTEM_NAME = 'aquarium';
/** Ledger spend items and purchase rules per option kind (aquariumOptions()). */
const SPEND = Object.freeze({
	license: Object.freeze({ category: 'optional', priority: LC.PRIORITY.license, prefix: 'license:' }),
	display: Object.freeze({ category: 'aspirational', priority: LC.PRIORITY.aspirational, prefix: 'display:' }),
});

/**
 * The bond clock (days of care since a purchase, at one feed + one play per pet per play day): fixed sessions
 * count play hours / the session's hours, so bond grows only on days the player attends and cares. Sessions
 * without a fixed length (F.MINIMUM_DAILY) count completed play days.
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
 *   init        state.sys.aquarium: { owned: { Freshwater, Saltwater, display }, purchases (one per purchase:
 *               price, slots added, bond clock start, stamps, companion cash earned, payback), gates, spent,
 *               companionCash, xpEffect, milestones, publicMilestones }
 *   goals       aquariumOptions(gate level, { owned }) as chains per water type in `waters` (see offerChains):
 *               licenses ('optional', LC.PRIORITY.license, item 'license:<name>') and, with displayTanks, display
 *               tanks of an Expert water type ('aspirational', LC.PRIORITY.aspirational, item 'display:<name>').
 *               All non-blocking (user decision 10: big sinks are choices), so a blocking progression goal of
 *               higher priority (rods, permits) is always served first. `reserve` keeps cash back. buy() records
 *               the holding and the companion slots it adds (companionSlots(), level capped at the gate level).
 *   modifyCast  adds the companion bonus to input.stats.sellBonus: per purchase, slots added x
 *               PARAMS.companion.perPet[mix] x bondFactorAfterDays(care days owned) x care (holdingsBonus() per
 *               purchase, with each purchase's own bond; at full bond the sum is holdingsBonus(owned)).
 *   onCasts     the bonus's marginal cash this step, measured on the core's own cast: cash minus the same cast
 *               without the bonus (other systems' changes kept, the run's outcome function), split over purchases
 *               by their share of the bonus; the XP effect is measured the same way (0: cash only). Payback is
 *               stamped when a purchase's companion cash covers its price.
 *   on          'levelUp': snapshots companion cash and spend at each recorded milestone.
 * Ledgers: the core's 'fishing' cash already includes the companion bonus (it is a cast stat). The system writes
 * NO XP or cash source; its share of 'fishing' is state.sys.aquarium.companionCash (never edit 'fishing').
 * Spend: ledger.spend.optional['license:<name>'] and ledger.spend.aspirational['display:<name>']. No money upkeep
 * (PARAMS.upkeep.moneyPerDay 0: care is the upkeep). Grants no boxes, so no 'box' events. Profile: the rules are
 * profile-independent; an outcome override (Founder) honours input.stats.sellBonus, so its sell multiplier
 * multiplies the bonus as it multiplies gear.
 * @param {object} opts {
 *   buy          buy licenses (default true; false: an inert system)
 *   displayTanks also buy display tanks once a water type is Expert (default false)
 *   waters       water types whose licenses are bought, in order (default [PARAMS.model.primaryWater]; a second
 *                water type adds tanks, not companion slots)
 *   tiers        license tiers to buy (a prefix of the ladder; default all)
 *   mix          pet rarity filling the companion slots (default PARAMS.model.typicalMix)
 *   care         share of fishing time the pets are thriving (default PARAMS.model.care)
 *   reserve      cash to keep after a purchase: a number or (state, ctx) => number (default 0: in the integrated
 *                run the rods and world systems' blocking progression goals already come first) }
 */
function system(opts = {}) {
	const {
		buy = true, displayTanks: withDisplay = false, waters = [PARAMS.model.primaryWater], tiers = TIERS,
		mix = PARAMS.model.typicalMix, care = PARAMS.model.care, reserve = 0,
	} = opts;
	if (!(mix in PARAMS.companion.perPet)) throw new Error(`Unknown pet mix ${mix}`);
	for (const w of waters) if (!WATER_TYPES.includes(w)) throw new Error(`Unknown water type ${w}`);
	for (const t of tiers) if (!TIERS.includes(t)) throw new Error(`Unknown license tier ${t}`);
	const perPet = PARAMS.companion.perPet[mix];
	const own = (state) => state.sys[SYSTEM_NAME];

	function chains(s, level, ctx) {
		const key = `${level}|${JSON.stringify(s.owned)}`;
		if (!s.offers.has(key)) s.offers.set(key, offerChains(level, s.owned, { waters, tiers, display: withDisplay, mix, arch: ctx.arch }));
		return s.offers.get(key);
	}
	function markGate(state, ctx, o) {
		const s = own(state);
		if (!s.gates[o.name]) s.gates[o.name] = { h: state.h, day: state.day + 1, level: ctx.gateLevel() };
	}
	function acquire(state, ctx, o) {
		const s = own(state);
		const L = ctx.gateLevel();
		const before = companionSlots(s.owned, L);
		if (o.kind === 'license') s.owned[o.waterType] = o.tier;
		else s.owned.display[o.waterType] = (s.owned.display[o.waterType] || 0) + 1;
		s.spent[o.kind] += o.price;
		s.purchases.push({
			name: o.name, kind: o.kind, water: o.waterType, tier: o.tier, price: o.price, slots: companionSlots(s.owned, L) - before,
			from: careDays(state.h, state, ctx), h: state.h, day: state.day + 1, level: L, cash: 0, paybackH: null,
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
				options: { buy, displayTanks: withDisplay, waters: [...waters], tiers: [...tiers], mix, perPet, care },
				owned: { ...Object.fromEntries(WATER_TYPES.map((w) => [w, null])), display: Object.fromEntries(WATER_TYPES.map((w) => [w, 0])) },
				purchases: [], gates: {}, spent: { license: 0, display: 0 },
				companionCash: 0, xpEffect: { maxAbs: 0, total: 0 }, lastUnit: null, endH: 0,
				milestones: {}, publicMilestones: {},
			};
			// Per-run scratch kept out of the result's JSON: offer chains by (level, holding), no-bonus outcomes and
			// the step's bonus.
			const s = own(state);
			for (const [k, v] of [['offers', new Map()], ['outcomes', new Map()], ['current', null]]) Object.defineProperty(s, k, { value: v, writable: true, enumerable: false });
		},
		goals(state, ctx) {
			const s = own(state);
			if (!buy) return [];
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
			const paidH = state.h + ctx.stepH;
			cur.parts.forEach((b, i) => {
				const p = s.purchases[i];
				p.cash += (extra * b) / cur.bonus;
				if (p.paybackH === null && p.slots > 0 && p.cash >= p.price) p.paybackH = paidH;
			});
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
 * slots added, companion cash earned and payback in hours of play after purchase (extrapolated past the end at
 * the last step's income per unit of bonus, at full bond); totals and shares of income (income = every ledger
 * cash source; fish income = 'fishing' minus the companion cash).
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
			gate: gate ? { hours: r4(gate.h), day: gate.day, level: gate.level } : null,
			bought: { hours: r4(p.h), day: p.day, level: p.level, hoursAfterGate: gate ? r4(p.h - gate.h) : null },
			slotsAdded: p.slots, companionCash: Math.round(p.cash), recoveredByEnd: p.slots ? r4(p.cash / p.price) : 0,
			paybackHoursAfterPurchase: after === null || !p.slots ? null : r2(after), paybackDaysAfterPurchase: after === null || !p.slots || !dayH ? null : Math.round(after / dayH),
			paybackExtrapolated: p.slots > 0 && p.paybackH === null,
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
	};
}

// ---------------------------------------------------------------------------------------------
// Retired private loop: the record of system()'s parity with it. The loop (lifecycle() on its own 1-minute
// steps with the 5b.1 placeholder gear rule, rods' assembly costs and repairs, and the placeholder daily XP)
// and its validateSystem() were deleted at 5b.4. This is validateSystem()'s output at commit a83b5f0; it was
// re-run on this tree before the deletion and was identical (framework, lifecycle core and this system
// unchanged since).
const RETIRED_LOOP_PARITY = deepFreeze({
	commit: 'a83b5f0',
	source: 'validateSystem() output at a83b5f0 (deleted with the private loop)',
	method: 'LC.simulate with system(), the retired loop\'s assumptions as baseline systems (its gear rule on stage income without the bonus, rods\' assembly cost at each equip, repairs at rods\' upkeep share, other spend, the placeholder daily XP, and its rods-first reserve) on the shared gear path, against the retired lifecycle(archetype, variant). Compared: milestone hours as step indices, each license\'s purchase pass, payback hours after purchase, share of the price recovered by the end, run totals, shares of income and final money.',
	cases: ['casual', 'regular', 'active', 'grinder', 'every archetype with 15% and 30% of income spent elsewhere', 'regular with Common, Rare and Lucky pets', 'regular with care on half the time', 'regular licensing Saltwater'],
	caseCount: 17,
	milestonesCompared: 102,
	exactMilestones: 102,
	maxPurchasePassShiftSteps: 0,
	maxRelativeDifference: 0.0005,
	worst: 'grinder, 15% of income elsewhere: Basic payback hours (41.92 h against 41.90 h)',
	tolerance: 0.005,
	companionCashRegular: { retiredLoop: 223143, system: 223121 },
	maxPaybackDifferenceHours: 0.02,
	replay: { conventions: 'the retired loop\'s stamps and bond clock', exactMilestones: 102, maxRelativeDifference: 0 },
	noXpEffect: { archetypes: 4, levels: 60, identical: true },
	ruleDifference: 'bond clock: the retired loop started a purchase\'s bond ramp one step (1 min of play) before adoption; system() starts it at the purchase, which is right. The replay isolated this rule and was exact.',
});

// ---------------------------------------------------------------------------------------------
// INTEGRATED lifecycle: every lifecycle number this module reports is an integrate.run() of the reference core
// loop (rods, world, quests, streak, buffs) with variant.aquarium true (this system; systemOpts.aquarium = the
// options) against the same loop with variant.aquarium false; optionally with the money-bait variant on both
// sides. Runs record every level (1-60), so the no-XP comparison is exact at each level.
const ARCHETYPE_ROWS = [...Object.keys(F.ARCHETYPES), F.MINIMUM_DAILY.name];
const ALL_LEVELS = Array.from({ length: F.LIFECYCLE.maxLevel }, (_, i) => i + 1);
const modelNote = (bait) => `integrate.run(): the reference core loop (${INTEGRATE().REFERENCE.join(', ')})${bait !== 'none' ? ` + ${bait} bait` : ''}, with variant.aquarium true against false`;

const runMemo = new Map();
/** One integrated run (memoised per archetype, aquarium on/off, bait policy and system options). */
function integratedRun(archetype, { aquarium = true, bait = 'none', opts = {} } = {}) {
	const key = JSON.stringify([archetype, aquarium, bait, aquarium ? opts : null]);
	if (!runMemo.has(key)) runMemo.set(key, INTEGRATE().run({ archetype, variant: { aquarium, bait }, milestones: ALL_LEVELS, systemOpts: aquarium ? { aquarium: opts } : {} }));
	return runMemo.get(key);
}

/** The level a reference-loop purchase is needed at: a rod tier's level (equip) or a biome's permit level. */
function neededLevel(id) {
	const rod = /^rods:T(\d+)$/.exec(id);
	if (rod) return sharedPath().find((t) => t.tier === Number(rod[1]))?.level ?? null;
	const permit = /^permit:(.+)$/.exec(id);
	if (permit) return F.BIOME_LEVEL[permit[1]] ?? null;
	return null;
}

/**
 * What adding the aquarium changes on the rest of the loop: XP (every level: same step, same XP by source) and
 * the other systems' purchases (which move, and whether each is still bought by the time its level is reached;
 * a purchase not bought at all is a failure).
 */
function aquariumEffect(withA, without) {
	const levels = ALL_LEVELS.filter((L) => without.milestones[L]);
	const xpIdentical = levels.every((L) => withA.milestones[L] && withA.milestones[L].hours === without.milestones[L].hours && JSON.stringify(withA.milestones[L].ledger.xp) === JSON.stringify(without.milestones[L].ledger.xp));
	const others = (r) => r.purchases.filter((p) => !p.id.startsWith(`${SYSTEM_NAME}:`));
	const before = Object.fromEntries(others(without).map((p) => [p.id, p]));
	const moved = others(withA).filter((p) => before[p.id] && p.hours !== before[p.id].hours).map((p) => {
		const need = neededLevel(p.id);
		const needH = need === null || !withA.milestones[need] ? null : withA.milestones[need].hours;
		return { id: p.id, hoursWithout: r4(before[p.id].hours), hoursWith: r4(p.hours), levelWith: p.level, neededAtLevel: need, neededAtHours: needH === null ? null : r4(needH), inTime: p.hours <= Math.max(before[p.id].hours, needH ?? -Infinity) };
	});
	const missing = Object.keys(before).filter((id) => !others(withA).some((p) => p.id === id));
	return { levelsCompared: levels.length, xpIdentical, xpEffectMaxAbs: withA.sys[SYSTEM_NAME].xpEffect.maxAbs, moved, missing, progressionInTime: moved.every((m) => m.inTime) && !missing.length };
}

/**
 * One INTEGRATED lifecycle with the aquarium (integrate.run, reference loop + system(opts), against the same loop
 * without it).
 * @param archetype an F.ARCHETYPES name or F.MINIMUM_DAILY.name
 * @param opts { tiers, water (licensed first) | waters, mix, care, displayTanks (system() options), bait ('none' |
 *   'cash' | 'xp': the bait variant on both sides) }
 * @returns { archetype, bait, model, systems, options, hours, days, reached (milestone hours and days),
 *   purchases (by tier, first water type: price, gate, bought, slotsAdded, companionCash, recoveredByEnd,
 *   paybackHoursAfterPurchase, paybackDaysAfterPurchase, paybackExtrapolated), byWater, displayTanks, totals,
 *   shares, finalMoney, effect (aquariumEffect()) }
 */
function lifecycle(archetype = F.REFERENCE_ARCHETYPE, opts = {}) {
	const { tiers = TIERS, water = PARAMS.model.primaryWater, waters = [water], mix = PARAMS.model.typicalMix, care = PARAMS.model.care, displayTanks: withDisplay = false, bait = 'none' } = opts;
	const withA = integratedRun(archetype, { bait, opts: { waters, tiers, mix, care, displayTanks: withDisplay } });
	const without = integratedRun(archetype, { aquarium: false, bait });
	const sum = systemSummary(withA);
	const gates = withA.sys[SYSTEM_NAME].gates;
	const byTier = (w) => Object.fromEntries(tiers.map((k) => {
		const name = licenseName(k, w);
		const g = gates[name];
		return [k, sum.purchases[name] || { price: licensePrice(k), gate: g ? { hours: r4(g.h), day: g.day, level: g.level } : null, bought: null }];
	}));
	const spend = (cat) => Object.values(withA.ledger.spend[cat] || {}).reduce((a, b) => a + b, 0);
	return {
		archetype, bait, model: modelNote(bait), systems: withA.systems, options: sum.options,
		hours: r2(withA.hours), days: withA.days, finalLevel: withA.final.level,
		reached: Object.fromEntries(F.LIFECYCLE.milestones.filter((L) => withA.milestones[L]).map((L) => [L, { hours: r4(withA.milestones[L].hours), day: withA.milestones[L].day }])),
		purchases: byTier(waters[0]),
		byWater: Object.fromEntries(waters.map((w) => [w, byTier(w)])),
		displayTanks: Object.values(sum.purchases).filter((p) => p.kind === 'display').map((p) => ({ water: p.water, price: p.price, hours: p.bought.hours, day: p.bought.day, level: p.bought.level })),
		totals: { ...sum.totals, progression: Math.round(spend('progression')), upkeep: Math.round(spend('upkeep')), saved: Math.round(withA.final.money) },
		shares: sum.shares,
		finalMoney: Math.round(withA.final.money),
		effect: aquariumEffect(withA, without),
	};
}

let integratedMemo = null;
/**
 * Every archetype and the minimum-daily player (default system), every archetype with the money-bait variant,
 * and the sensitivity runs: the reference player with each pet mix and with care on part of the time; every
 * archetype licensing both water types, and buying display tanks.
 */
function integratedReport() {
	if (integratedMemo) return integratedMemo;
	const ref = F.REFERENCE_ARCHETYPE;
	const names = Object.keys(F.ARCHETYPES);
	integratedMemo = {
		model: modelNote('none'),
		reference: ref,
		byArchetype: Object.fromEntries(ARCHETYPE_ROWS.map((a) => [a, lifecycle(a)])),
		withBait: Object.fromEntries(names.map((a) => [a, lifecycle(a, { bait: 'cash' })])),
		sensitivity: {
			mix: Object.fromEntries(PARAMS.model.mixes.map((m) => [m, lifecycle(ref, { mix: m })])),
			care: Object.fromEntries(SENSITIVITY.care.map((c) => [c, lifecycle(ref, { care: c })])),
			bothWaters: Object.fromEntries(names.map((a) => [a, lifecycle(a, { waters: [...WATER_TYPES] })])),
			display: Object.fromEntries(names.map((a) => [a, lifecycle(a, { displayTanks: true })])),
		},
	};
	return integratedMemo;
}

// ---------------------------------------------------------------------------------------------
// Checks against the design targets (lifecycle checks on the integrated model).
let checksMemo = null;
function checks() {
	if (checksMemo) return checksMemo;
	const out = [];
	const maxBonus = PARAMS.licenses.tiers.expert.companionSlots * PARAMS.companion.perPet.lucky;
	out.push({ id: 'bonus-bounded', check: 'companion bonus is small and bounded', value: r4(maxBonus), target: `<= ${PARAMS.targets.maxCompanionBonus}`, pass: maxBonus <= PARAMS.targets.maxCompanionBonus + 1e-12 });
	const saleMax = petSaleValue({ speciesValue: 1, ageDays: 1e6, attraction: 1e6 });
	out.push({ id: 'sale-max', check: 'a pet never sells for more than 1.25x the fish it was adopted from', value: r4(saleMax), target: '<= 1.25', pass: saleMax <= 1.25 + 1e-12 });
	const br = [breedingRate(0, 100), breedingRate(100, 0), breedingRate(50, 50)];
	out.push({ id: 'breeding-range', check: 'breeding chance (fixed) within the intended 10-65%', value: `${Math.min(...br.map((b) => b.fixed))}-${Math.max(...br.map((b) => b.fixed))}`, target: '0.1-0.65', pass: br.every((b) => b.fixed >= 0.1 && b.fixed <= 0.65) });
	const inc = incomeBoundTable();
	const worst = Math.max(...inc.rows.map((r) => r.shareOfWeeklyFishing.regular.capped));
	out.push({ id: 'pet-income-regular', check: 'pet income bound (any parents, any capacity) within the target share of a regular player\'s fishing', value: worst, target: `<= ${PARAMS.targets.maxPetIncomeShareRegular}`, pass: worst <= PARAMS.targets.maxPetIncomeShareRegular });
	const worstCasual = Math.max(...inc.rows.map((r) => r.shareOfWeeklyFishing.casual.capped));
	out.push({ id: 'pet-income-casual', check: 'pet income bound (any parents, any capacity) within the target share of a casual player\'s fishing', value: worstCasual, target: `<= ${PARAMS.targets.maxPetIncomeShareCasual}`, pass: worstCasual <= PARAMS.targets.maxPetIncomeShareCasual });
	const I = integratedReport();
	const runs = [...Object.values(I.byArchetype), ...Object.values(I.withBait)];
	const noXp = runs.every((l) => l.effect.xpIdentical && l.effect.xpEffectMaxAbs === 0);
	out.push({ id: 'no-xp', check: 'the aquarium adds no XP: every level is reached on the same step with the same XP by source, with and without it (integrated: every archetype and the minimum-daily player; reference loop and money bait)', value: noXp, target: true, pass: noXp, runs: runs.length });
	const beforeNextGate = runs.every((l) => TIERS.every((k, i) => {
		const p = l.purchases[k];
		if (!p.gate) return true;
		const nextGate = TIERS[i + 1] ? PARAMS.licenses.tiers[TIERS[i + 1]].level : Infinity;
		return Boolean(p.bought) && p.bought.level < nextGate;
	}));
	out.push({ id: 'before-next-gate', check: 'every license is bought before the next tier\'s gate (integrated: every archetype and the minimum-daily player; reference loop and money bait)', value: beforeNextGate, target: true, pass: beforeNextGate });
	const inTime = runs.every((l) => l.effect.progressionInTime);
	out.push({ id: 'progression-in-time', check: 'licenses never delay progression: every rod assembly or permit they move is still bought by the time its level is reached, and none is dropped (integrated)', value: inTime, target: true, pass: inTime });
	const reg = I.byArchetype[F.REFERENCE_ARCHETYPE];
	const paybacks = Object.fromEntries(TIERS.map((k) => [k, reg.purchases[k].paybackHoursAfterPurchase ?? null]));
	const rampOk = TIERS.every((k) => paybacks[k] !== null && paybacks[k] <= PARAMS.targets.paybackHoursRegular[k]) && TIERS.every((k, i) => !i || paybacks[k] >= paybacks[TIERS[i - 1]]);
	out.push({ id: 'payback', check: 'reference player earns each license back within its payback target, and higher tiers take longer (integrated)', value: paybacks, target: PARAMS.targets.paybackHoursRegular, pass: rampOk });
	const legacy = companionSlots({ Freshwater: 'expert' }, PARAMS.licenses.tiers.basic.level);
	out.push({ id: 'level-cap', check: 'a legacy Expert license at the Basic gate level gives only Basic companion slots (level cap)', value: legacy, target: PARAMS.licenses.tiers.basic.companionSlots, pass: legacy === PARAMS.licenses.tiers.basic.companionSlots });
	out.push({ id: 'no-upkeep', check: 'no mandatory money upkeep', value: PARAMS.upkeep.moneyPerDay, target: 0, pass: PARAMS.upkeep.moneyPerDay === 0 });
	checksMemo = { pass: out.every((c) => c.pass), checks: out };
	return checksMemo;
}

// ---------------------------------------------------------------------------------------------
// PROPOSED decisions (status 'proposed' only: only the user approves). get() reads what the model runs;
// decisions.verify() checks it against `expected`. The framework-level entries this design relies on (P-LUCKY,
// P-DOUBLE-CASH, P-EVENTS) live in decisions.js. Fix-first correctness items are marked in their titles.
const LT = PARAMS.licenses.tiers;
const byTierOf = (f) => Object.fromEntries(TIERS.map((k) => [k, f(LT[k], k)]));
const listTiers = (f) => TIERS.map((k) => `${LT[k].label} ${f(LT[k], k)}`).join(', ');
/** A fraction as a percentage for decision texts (no float noise). */
const pctOf = (x) => `${+(x * 100).toFixed(6)}%`;
const money = (x) => `$${Math.round(x).toLocaleString('en-US')}`;
const DECISIONS = [
	{
		id: 'P-AQUARIUM-LICENSE-PRICE', status: 'proposed',
		title: 'License prices are hours of the gate stage\'s income (regular cadence, the shared gear tier at the gate), rounded to two significant digits; both water types cost the same',
		modelled: `${listTiers((t, k) => `${t.priceHours} h = ${money(licensePrice(k))}`)}; ${PARAMS.licenses.roundSig} significant digits`,
		alternatives: ['today: fixed prices of hundreds of hours of proposed stage income (Current → proposed)', 'fixed prices (drift with every framework change)', 'more hours (a wall rather than a milestone)'],
		source: 'aquarium design', why: 'a milestone, not a wall; prices regenerate with any framework change (Licenses)',
		get: () => ({ priceHours: byTierOf((t) => t.priceHours), roundSig: PARAMS.licenses.roundSig, prices: byTierOf((t, k) => licensePrice(k)) }),
		expected: { priceHours: { basic: 2, advanced: 2.5, expert: 3 }, roundSig: 2, prices: { basic: 30000, advanced: 120000, expert: 260000 } },
	},
	{
		id: 'P-AQUARIUM-LICENSE-GATES', status: 'proposed',
		title: `License gates every ${LT.advanced.level - LT.basic.level} levels; prerequisites stay Basic → Advanced → Expert per water type`,
		modelled: listTiers((t) => `Lv ${t.level}`),
		alternatives: [`today: Lv ${TIERS.map((k) => LICENSE_CATALOG.find((l) => l.name === licenseName(k, PARAMS.model.primaryWater)).requirements.level).join(' / ')}`, 'gates at biome unlocks'],
		source: 'aquarium design', why: 'Basic follows the first freshwater species (River); Expert is ready before Swamp',
		get: () => byTierOf((t) => t.level), expected: { basic: 15, advanced: 30, expert: 45 },
	},
	{
		id: 'P-AQUARIUM-TANKS', status: 'proposed',
		title: 'A license grants a number of tanks of a size per water type (capacity becomes finite)',
		modelled: listTiers((t) => `${t.tanks} × ${t.tankSize} (${t.tanks * t.tankSize} pets)`),
		alternatives: ['today: unlimited tanks of the license\'s size (bug A6)'],
		source: 'aquarium design', why: 'closes the unlimited-tanks loophole; companion slots, not capacity, are the power lever',
		get: () => byTierOf((t) => ({ tanks: t.tanks, tankSize: t.tankSize })), expected: { basic: { tanks: 1, tankSize: 3 }, advanced: { tanks: 2, tankSize: 4 }, expert: { tanks: 3, tankSize: 5 } },
	},
	{
		id: 'P-AQUARIUM-COMPANION-SLOTS', status: 'proposed',
		title: 'Companion slots come from the best license tier held; only the best thriving pets up to that count add a bonus',
		modelled: listTiers((t) => `${t.companionSlots} slots`),
		alternatives: ['every pet counts (bonus scales with capacity)', 'one slot per tank'],
		source: 'aquarium design', why: 'rarer pets reach the maximum in the same slots, leaving room for collection and breeding',
		get: () => byTierOf((t) => t.companionSlots), expected: { basic: 2, advanced: 5, expert: 9 },
	},
	{
		id: 'P-AQUARIUM-SECOND-WATER', status: 'proposed',
		title: 'A second water type costs the same and adds tanks (collection, breeding, display), not companion slots',
		modelled: `secondWaterAddsSlots ${PARAMS.licenses.secondWaterAddsSlots}`,
		alternatives: ['its own companion slots too (the maximum bonus doubles)'],
		source: 'aquarium design', why: 'no power creep from buying the same benefit twice (Sensitivity: both water types)',
		get: () => PARAMS.licenses.secondWaterAddsSlots, expected: false,
	},
	{
		id: 'P-AQUARIUM-COMPANION-BONUS', status: 'proposed',
		title: 'Thriving companion pets add to the cast\'s sell bonus by species rarity: cash only (no XP, rarity or multi-catch effect)',
		modelled: `${PARAMS.companion.stat}: ${Object.entries(PARAMS.companion.perPet).map(([r, v]) => `${r} +${pctOf(v)}`).join(', ')}`,
		alternatives: ['an XP bonus (moves the approved windows and R2)', 'a rarity or luck bonus (moves catches and competitive standings)', 'no benefit (today)'],
		source: 'aquarium design', why: 'a small, bounded reason to own an aquarium that leaves progression and leaderboards untouched (Companion bonus by tier; Effects on progression)',
		get: () => ({ stat: PARAMS.companion.stat, perPet: PARAMS.companion.perPet }),
		expected: { stat: 'sellBonus', perPet: { common: 0.0025, uncommon: 0.003, rare: 0.0035, ultra: 0.004, giant: 0.0045, legendary: 0.005, lucky: 0.0055 } },
	},
	{
		id: 'P-AQUARIUM-THRIVE', status: 'proposed',
		title: 'A pet thrives (and counts) when fed recently, its tank is clean enough and the temperature is near the ideal',
		modelled: `fed within ${PARAMS.companion.thrive.fedWithinH} h; cleanliness ≥ ${PARAMS.companion.thrive.minCleanliness}; within ±${PARAMS.companion.thrive.temperatureBandC} °C of ${PARAMS.temperature.idealC} °C`,
		alternatives: ['stat-based thresholds on hunger, mood and health', 'no condition (the bonus is passive)'],
		source: 'aquarium design', why: 'one short care session a day keeps every pet thriving; neglect costs the bonus, never the pets (Pet rules)',
		get: () => PARAMS.companion.thrive, expected: { fedWithinH: 30, minCleanliness: 50, temperatureBandC: 3 },
	},
	{
		id: 'P-AQUARIUM-BOND', status: 'proposed',
		title: 'Pet XP becomes a capped bond: care off cooldown adds bond XP, and bond ramps a pet\'s bonus from half to full',
		modelled: `+${PARAMS.companion.bond.xpPerCare} × trait multiplier per care action; cap ${PARAMS.companion.bond.maxXp} (stored xp never reduced); bonus ${pctOf(PARAMS.companion.bond.minFactor)} → 100%`,
		alternatives: ['no bond (full bonus at adoption)', 'uncapped XP (today)'],
		source: 'aquarium design', why: 'a new companion earns its place in about a week of care; the cap ends XP farming (Pet rules)',
		get: () => PARAMS.companion.bond, expected: { minFactor: 0.5, maxXp: 700, xpPerCare: 50 },
	},
	{
		id: 'P-AQUARIUM-CARE-COOLDOWN', status: 'proposed',
		title: '/pet feed, /pet play and /aquarium feed act on a pet at most once per cooldown each; /aquarium feed feeds every pet off cooldown',
		modelled: `feed ${PARAMS.care.feedCooldownH} h, play ${PARAMS.care.playCooldownH} h, per pet`,
		alternatives: ['today: only the command cooldown (bug A1)', 'once per day'],
		source: 'aquarium design', why: 'care is a daily ritual, not a clicker; bounds bond XP per pet per day (Pet rules)',
		get: () => ({ feedCooldownH: PARAMS.care.feedCooldownH, playCooldownH: PARAMS.care.playCooldownH }), expected: { feedCooldownH: 8, playCooldownH: 8 },
	},
	{
		id: 'P-AQUARIUM-UPKEEP', status: 'proposed',
		title: 'No money upkeep: upkeep is care (the bonus needs thriving pets)',
		modelled: `moneyPerDay ${PARAMS.upkeep.moneyPerDay}`,
		alternatives: [`a flat fee per pet per day (sized at ${pctOf(PARAMS.upkeep.alternativeShareOfReferenceBonus)} of the regular player's bonus it is regressive: Upkeep)`, 'a fee per cast (only a smaller bonus; changes no decision)'],
		source: 'aquarium design (user decision 10: modest mandatory upkeep)', why: 'the benefit scales with hours fished and a daily fee with calendar days, so any flat fee hits casual players hardest (Upkeep)',
		get: () => PARAMS.upkeep.moneyPerDay, expected: 0,
	},
	{
		id: 'P-AQUARIUM-PET-SALE', status: 'proposed',
		title: `A pet sells for its species value × age × origin × condition × attraction, never its XP (at most ${+(1 + PARAMS.sale.maxAttraction * PARAMS.sale.attractionPerPoint).toFixed(6)}× the fish it came from)`,
		modelled: `age ${PARAMS.sale.minAgeFactor} → 1 at ${PARAMS.sale.fullValueAgeDays} days; bred ×${PARAMS.sale.bredFactor}; not thriving ×${PARAMS.sale.notThrivingFactor}; +${pctOf(PARAMS.sale.attractionPerPoint)} per attraction point up to ${PARAMS.sale.maxAttraction}`,
		alternatives: ['today: xp × attraction (unbounded; bug A1)', 'no pet sales'],
		source: 'aquarium design', why: 'pets are companions, not a money printer; adopting and selling never beats selling the fish (Sale value)',
		get: () => ({ fullValueAgeDays: PARAMS.sale.fullValueAgeDays, minAgeFactor: PARAMS.sale.minAgeFactor, bredFactor: PARAMS.sale.bredFactor, notThrivingFactor: PARAMS.sale.notThrivingFactor, attractionPerPoint: PARAMS.sale.attractionPerPoint, maxAttraction: PARAMS.sale.maxAttraction }),
		expected: { fullValueAgeDays: 28, minAgeFactor: 0.25, bredFactor: 0.5, notThrivingFactor: 0.5, attractionPerPoint: 0.01, maxAttraction: 25 },
	},
	{
		id: 'P-AQUARIUM-SALE-LIMIT', status: 'proposed',
		title: 'Weekly rehoming limit on pet sales',
		modelled: `${PARAMS.sale.maxPerWeek} sales per 7 days`,
		alternatives: ['no limit (the pet income bound rises: Pet income bound, uncapped columns)'],
		source: 'aquarium design', why: 'bounds calendar-based pet cash whatever the capacity, so breeding stays a way to get rare pets (Pet income bound)',
		get: () => PARAMS.sale.maxPerWeek, expected: 3,
	},
	{
		id: 'P-AQUARIUM-BREEDING', status: 'proposed',
		title: 'Breeding keeps today\'s success formula and age/health rules; adds a cooldown per parent and a free-slot check; babies are marked bred (half sale value)',
		modelled: `parents ≥ ${PARAMS.breeding.minAgeDays} days, health ≥ ${PARAMS.breeding.minHealth}; cooldown ${PARAMS.breeding.cooldownDays} days per parent; bred ×${PARAMS.sale.bredFactor}`,
		alternatives: ['no cooldown (with the comparison fixed, a pair could breed every command cooldown)', 'bred pets sell at full value'],
		source: 'aquarium design', why: 'breeding is how players get Legendary and Lucky companions, not income (Breeding; Pet income bound)',
		get: () => ({ ...PARAMS.breeding, bredFactor: PARAMS.sale.bredFactor }), expected: { minAgeDays: 20, minHealth: 50, cooldownDays: 7, bredFactor: 0.5 },
	},
	{
		id: 'P-AQUARIUM-DISPLAY-TANKS', status: 'proposed',
		title: 'Display tanks for an Expert water type: an aspirational sink with capacity only (no companion slots), priced in hours of the top live stage\'s income, doubling per tank',
		modelled: `${PARAMS.display.perWaterType} per water type × ${PARAMS.display.tankSize} pets; first ${PARAMS.display.firstPriceHours} h, ×${PARAMS.display.growth} each: ${displayTanks().tanks.map((t) => money(t.price)).join(' / ')}`,
		alternatives: ['no aspirational aquarium sink', 'display tanks with companion slots (power creep)'],
		source: 'aquarium design (user decision 10: aspirational sinks)', why: 'absorbs late-game cash with no power (Display tanks)',
		get: () => ({ ...PARAMS.display, prices: displayTanks().tanks.map((t) => t.price) }),
		expected: { requires: 'expert', perWaterType: 3, tankSize: 5, firstPriceHours: 3, growth: 2, prices: [430000, 870000, 1700000] },
	},
	{
		id: 'P-AQUARIUM-OPTIONAL-SINK', status: 'proposed',
		title: 'License spending is an optional sink and display tanks an aspirational one: never blocking, so rods and permits always come first',
		modelled: Object.entries(SPEND).map(([k, v]) => `${k}: ${v.category}, priority ${v.priority}, non-blocking`).join('; '),
		alternatives: ['licenses as progression (blocking) purchases'],
		source: 'aquarium design (user decision 10 categories)', why: 'the aquarium is a choice; it may never delay gear or a biome (Effects on progression)',
		get: () => Object.fromEntries(Object.entries(SPEND).map(([k, v]) => [k, v.category])), expected: { license: 'optional', display: 'aspirational' },
	},
	{
		id: 'P-AQUARIUM-LEGACY-LICENSES', status: 'proposed',
		title: 'Legacy licenses keep their stored fields and extra tanks; capacity is the larger of the stored and the new tank size; companion slots are level-capped; no refunds. Ordering: the /build tank limit (A6) ships before or with this read, or a cutoff applies',
		modelled: `read-time LICENSE_DEFS by name; a legacy Expert gives ${companionSlots({ Freshwater: 'expert' }, LT.basic.level)} slots at Lv ${LT.basic.level} and ${companionSlots({ Freshwater: 'expert' }, LT.advanced.level)} at Lv ${LT.advanced.level}`,
		alternatives: [
			'a partial credit to legacy buyers',
			'no level cap (legacy Expert holders get full slots early)',
			'grandfather only Habitats created before a cutoff (HabitatSchema createdAt; e.g. the approval date): tanks built later count against the new limit (Legacy tanks)',
			'upsize legacy tanks only up to the license\'s new tank count; extra legacy tanks keep their stored size (Legacy tanks)',
		],
		source: 'aquarium design (user decision 13: non-destructive)', why: 'no player document is rewritten; legacy buyers get more capacity than they paid for today (Legacy licenses). /build has no tank limit until A6 ships (A6 needs P-AQUARIUM-TANKS), so every tank built before then is grandfathered and upsized: a minute of /build matches the display-tank sink (Legacy tanks). Capacity only, no power; a cutoff closes this whatever the ship date',
		get: () => ({ expertAtBasicGate: companionSlots({ Freshwater: 'expert' }, LT.basic.level), expertAtAdvancedGate: companionSlots({ Freshwater: 'expert' }, LT.advanced.level) }),
		expected: { expertAtBasicGate: 2, expertAtAdvancedGate: 5 },
	},
	{
		id: 'P-AQUARIUM-NO-CLAWBACK', status: 'proposed',
		title: 'No clawback of past /pet sell proceeds (optionally an analytics audit)',
		modelled: 'migration rule (not a PARAMS value)',
		alternatives: ['claw back proceeds identified by Interaction analytics'],
		source: 'aquarium design (user decision 13: never wipe)', why: 'the farmed XP is kept as bond; it simply stops selling',
	},
	{
		id: 'P-AQUARIUM-FIX-PLAY-SELL', status: 'proposed',
		title: 'Fix first (A1): close the /pet play → /pet sell money loop (needs the proposed values of the four decisions it names; not a today\'s-numbers fix)',
		modelled: 'care cooldowns (P-AQUARIUM-CARE-COOLDOWN), capped bond (P-AQUARIUM-BOND), sale value from species, never XP (P-AQUARIUM-PET-SALE), weekly limit (P-AQUARIUM-SALE-LIMIT), atomic sale (A8)',
		alternatives: ['cooldowns only (the sale still pays xp × attraction)', 'remove pet sales'],
		source: 'aquarium design', why: 'today one pet out-earns the best proposed fishing (Fixes)',
		get: () => ({ maxShareOfSpeciesValue: r4(petSaleValue({ speciesValue: 1, ageDays: 1e6, attraction: 1e6 })), dependsOnXp: petSaleValue({ speciesValue: 1, ageDays: 28, xp: 1e9 }) !== petSaleValue({ speciesValue: 1, ageDays: 28 }) }),
		expected: { maxShareOfSpeciesValue: 1.25, dependsOnXp: false },
	},
	{
		id: 'P-AQUARIUM-FIX-BREEDING', status: 'proposed',
		title: 'Fix first (A2, A3, A5): breeding compares rng.random() < rate, reads lastBred for the cooldown, and gives parents the success XP',
		modelled: `thriving pair ${pctOf(breedingRate(0, 100).fixed)} per attempt (today ${pctOf(breedingRate(0, 100).today)})`,
		alternatives: ['keep the percent comparison (breeding practically never succeeds)', 'a new success formula'],
		source: 'aquarium design', why: 'restores the intended odds; the cooldown keeps them from becoming a farm (Breeding). A2 and A5 use today\'s numbers; A3\'s cooldown length is P-AQUARIUM-BREEDING\'s proposed value. A2 must not ship before A1 is closed (more pets while the play-sell loop is open) and ships with A3 (Fixes)',
		get: () => {
			const all = [breedingRate(0, 100), breedingRate(100, 0), breedingRate(50, 50)].map((b) => b.fixed);
			return { thrivingPair: breedingRate(0, 100).fixed, range: [Math.min(...all), Math.max(...all)], cooldownDays: PARAMS.breeding.cooldownDays };
		},
		expected: { thrivingPair: 0.65, range: [0.1, 0.65], cooldownDays: 7 },
	},
	{
		id: 'P-AQUARIUM-FIX-CAPACITY', status: 'proposed',
		title: 'Fix first (A4): the breeding capacity check awaits the tank size (it compares a number with a Promise today) and the baby is added to the tank',
		modelled: 'code fix (not a PARAMS value): await aquarium.getSize() against the effective capacity; aquarium.addFish in the same flow',
		alternatives: ['none (tanks overfill)'],
		source: 'aquarium design', why: 'capacity is the rule every other limit relies on (P-AQUARIUM-TANKS)',
	},
	{
		id: 'P-AQUARIUM-FIX-DUPLICATE-LICENSE', status: 'proposed',
		title: 'Fix first (A7): the shop never offers an owned license or a lower tier of an owned water type',
		modelled: 'aquariumOptions() offers only the next tier per water type',
		alternatives: ['refund duplicates on purchase'],
		source: 'aquarium design', why: 'a second copy is wasted money today',
		get: () => aquariumOptions(Infinity, { owned: { Freshwater: 'expert', Saltwater: 'advanced' } }).filter((o) => o.kind === 'license').map((o) => o.name),
		expected: ['Expert Saltwater Aquarium License'],
	},
	{
		id: 'P-AQUARIUM-FIX-SALE-RACE', status: 'proposed',
		title: 'Fix first (A8): a pet sale claims the pet atomically and pays with $inc under the user lock (no whole-document save)',
		modelled: 'code fix (not a PARAMS value): PetFish.updateOne({ _id, owner }) claim, then $inc only if it matched, under withUserLock',
		alternatives: ['keep the read-modify-write save (lost cast income, double sells)'],
		source: 'aquarium design', why: 'the whole-document save can overwrite concurrent cast income, and two sells can race',
	},
	{
		id: 'P-AQUARIUM-FIX-TEMPERATURE', status: 'proposed',
		title: 'Fix first (A9): one ideal temperature in every formula, no drift, stored values read clamped to the adjust range, new tanks at the ideal',
		modelled: `ideal ${PARAMS.temperature.idealC} °C; drift ${PARAMS.temperature.driftPerHour} °C/h; read clamped to ${PARAMS.temperature.adjustRangeC.join('…')} °C; new tanks ${PARAMS.temperature.newTankC} °C`,
		alternatives: ['a bounded drift toward a room temperature (a chore without a decision)', 'fix only the ideal and keep the drift'],
		source: 'aquarium design', why: 'today no temperature is ideal for all four formulas and drift is unbounded (Temperature)',
		get: () => ({ ...PARAMS.temperature, legacyDriftedReadsAs: effectiveTemperature(TEMPERATURE_EXAMPLES_C[TEMPERATURE_EXAMPLES_C.length - 1]) }),
		expected: { idealC: 25, adjustRangeC: [-30, 30], newTankC: 25, driftPerHour: 0, legacyDriftedReadsAs: 30 },
	},
];

// ---------------------------------------------------------------------------------------------
/** The system's contract and the retired loop's parity record, for report(). */
function systemReport() {
	return {
		name: SYSTEM_NAME,
		defaults: { buy: true, displayTanks: false, waters: [PARAMS.model.primaryWater], tiers: [...TIERS], mix: PARAMS.model.typicalMix, care: PARAMS.model.care, reserve: 0 },
		hooks: ['init', 'goals', 'modifyCast', 'onCasts', 'on'],
		events: { listens: ['levelUp'], emits: [] },
		ledger: {
			xpSources: [], cashSources: [],
			spend: Object.entries(SPEND).map(([kind, x]) => ({ kind, category: x.category, item: `${x.prefix}<name>`, priority: x.priority, blocking: false })),
			note: 'The core\'s \'fishing\' cash includes the companion bonus (a cast stat). Its share is state.sys.aquarium.companionCash (per purchase: purchases[i].cash; at milestones: milestones / publicMilestones). No money upkeep, no boxes.',
		},
		integration: 'integrate.run({ variant: { aquarium: true } }) adds system(); systemOpts.aquarium passes its options',
		retiredLoopParity: RETIRED_LOOP_PARITY,
	};
}

const decisionRows = () => DECISIONS.map((d) => ({ ...Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'get' && k !== 'expected')), recordMatchesModel: d.get ? JSON.stringify(d.get()) === JSON.stringify(d.expected) : null }));

let reportMemo = null;
/** Every number in docs/economy/5b/aquarium.md (memoised), stamped with the framework version and digest. */
function report() {
	if (reportMemo) return reportMemo;
	const stamp = F.stamp();
	const lic = licenses();
	const archetypes = Object.keys(F.ARCHETYPES);
	const priceTable = TIERS.map((k) => {
		const t = LT[k];
		const row = lic.find((l) => l.tier === k && l.water === PARAMS.model.primaryWater);
		return {
			tier: k, level: t.level, price: row.price, priceHours: t.priceHours, stage: row.gateStage,
			current: lic.filter((l) => l.tier === k).map((l) => ({ name: l.name, price: l.current?.price, level: l.current?.level, size: l.current?.size })),
			hoursOfGateIncome: Object.fromEntries(archetypes.map((n) => {
				const h = row.price / stageAt(t.level, { overheadS: F.ARCHETYPES[n].overheadS }).cashPerHour;
				return [n, { hours: r2(h), days: r2(h / hoursPerDay(n)) }];
			})),
		};
	});
	const saleExamples = [
		{ label: 'adopted 1 day ago', ageDays: 1 },
		{ label: 'half-way to full value', ageDays: Math.ceil(PARAMS.sale.fullValueAgeDays / 2) },
		{ label: 'full age', ageDays: PARAMS.sale.fullValueAgeDays },
		{ label: 'full age, maximum attraction', ageDays: PARAMS.sale.fullValueAgeDays, attraction: PARAMS.sale.maxAttraction },
		{ label: 'full age, bred', ageDays: PARAMS.sale.fullValueAgeDays, bred: true },
		{ label: 'full age, not thriving', ageDays: PARAMS.sale.fullValueAgeDays, thriving: false },
	].map((e) => ({ ...e, factor: r4(petSaleValue({ speciesValue: 1, ...e })) }));
	const speciesExamples = ['common', 'legendary', 'lucky'].flatMap((r) => ['River', 'Swamp'].map((b) => {
		const v = speciesValues(b, r);
		return v ? { biome: b, rarity: r, mean: Math.round(v.mean), max: Math.round(v.max), maxSale: Math.round(petSaleValue({ speciesValue: v.max, ageDays: PARAMS.sale.fullValueAgeDays, attraction: PARAMS.sale.maxAttraction })) } : null;
	})).filter(Boolean);
	const exploit = currentExploit();
	const inc = incomeBoundTable();
	const I = integratedReport();
	const top = inc.rows.reduce((a, b) => (b.weekly > a.weekly ? b : a));
	const md = I.byArchetype[F.MINIMUM_DAILY.name];
	reportMemo = {
		...stamp,
		gearPathSource: F.GEAR_PATH_SOURCE,
		model: I.model,
		params: PARAMS,
		current: { licenses: currentLicenses(), exploit },
		licenses: lic,
		priceTable,
		companion: {
			perPet: PARAMS.companion.perPet, bondDays: bondDays(), thrive: PARAMS.companion.thrive,
			byTier: TIERS.map((k) => ({ tier: k, slots: LT[k].companionSlots, byMix: Object.fromEntries(PARAMS.model.mixes.map((m) => [m, r4(LT[k].companionSlots * PARAMS.companion.perPet[m])])) })),
			cashPerHourAtStages: F.LIVE_BIOMES.map((b) => {
				const L = F.BIOME_LEVEL[b];
				const s = stageAt(L);
				const tierHeld = [...TIERS].reverse().find((k) => LT[k].level <= L) || null;
				const bonus = tierHeld ? holdingsBonus({ Freshwater: tierHeld }) : 0;
				return { biome: b, level: L, gear: s.tier, cashPerHour: Math.round(s.cashPerHour), tierHeld, bonus: r4(bonus), extraCashPerHour: Math.round(companionCash(s.cashPerHour, s.gearSell, bonus)) };
			}),
			petSupply: TIERS.map((k) => availability(LT[k].level)),
		},
		integrated: I,
		upkeep: upkeepAlternatives(),
		sale: { examples: saleExamples, species: speciesExamples },
		breeding: { cooldownDays: PARAMS.breeding.cooldownDays, examples: exploit.breeding.examples },
		petIncome: inc,
		r2: {
			// INTEGRATION_REQUIREMENTS R2: the aquarium is not an XP source; its only calendar-based cash is pet sales,
			// capped per week.
			aquariumXpIdentical: md.effect.xpIdentical, companionBonusRequiresFishing: true,
			minimumDaily: { companionOfFish: md.shares.companionOfFish, licensesOfIncome: md.shares.licensesOfIncome, netOfIncome: md.shares.netOfIncome },
			petCashWeeklyMax: top.weekly, from: `${top.parents} ${top.biome} parents, ${top.capacity}`,
			shareOfWeeklyFishing: top.shareOfWeeklyFishing,
			verdict: 'No XP from the aquarium, and its cash bonus scales with fish caught, so it cannot make barely fishing optimal. Pet sales are the only calendar-based cash; the weekly rehoming limit caps them well below a regular player\'s fishing income.',
		},
		legacy: LICENSE_CATALOG.map((l) => {
			const d = licenseByName(l.name);
			return {
				name: l.name, paidToday: l.price, storedSize: l.aquarium.size, tanksToday: 'unlimited',
				effectiveTankSize: Math.max(l.aquarium.size, d.tankSize), tanksProposed: d.tanks, newPrice: d.price,
				companionSlotsAtLevel: Object.fromEntries([...new Set([0, ...TIERS.map((k) => LT[k].level)])].map((L) => [L, companionSlots({ [d.water]: d.tier }, L)])),
			};
		}),
		display: displayTanks(),
		legacyTanks: legacyTankExposure(),
		options: { atBasicGate: aquariumOptions(LT.basic.level), atExpertGateWithAdvanced: aquariumOptions(LT.expert.level, { owned: { Freshwater: 'advanced' } }) },
		checks: checks(),
		system: systemReport(),
		decisions: decisionRows(),
	};
	return reportMemo;
}

// ---------------------------------------------------------------------------------------------
// Markdown tables for docs/economy/5b/aquarium.md (render-docs.js). Every number in the doc comes from here.
const esc = (c) => String(c).replace(/\|/g, '\\|');
const mdTable = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map(esc).join(' | ')} |`)].join('\n');
const digits = (x, d) => Math.abs(Number(x)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
/** Sign of x as printed at d decimals (0 when it rounds to zero, so no '-0.00'). */
const signAt = (x, d) => (Number(digits(x, d).replace(/,/g, '')) === 0 ? 0 : Math.sign(x));
const num = (x, d = 2) => `${signAt(x, d) < 0 ? '−' : ''}${digits(x, d)}`;
const usd = (x, d = 0) => `${signAt(x, d) < 0 ? '−' : ''}$${digits(x, d)}`;
const pct = (x, d = 1) => `${num(x * 100, d)}%`;
const spct = (x, d = 1) => `${['−', '', '+'][signAt(x * 100, d) + 1]}${digits(x * 100, d)}%`;
const hrs = (h, d = 2) => (h === undefined || h === null ? '—' : `${num(h, d)} h`);
const int = (x) => num(x, 0);
const yes = (b) => (b ? 'yes' : '**no**');
const passFail = (b) => (b ? 'pass' : '**fail**');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const tierName = (t) => (t === 'old' ? 'Old Rod' : String(t).replace(/^t/, 'T'));
const archLabel = (a) => (a === F.MINIMUM_DAILY.name ? 'Minimum-daily (R2 adversary)' : `${cap(a)} (${F.ARCHETYPES[a].minutesPerDay} min/day)`);
const boughtCell = (p) => {
	if (!p.bought) return p.gate ? '**not bought**' : 'gate not reached';
	const after = p.bought.hoursAfterGate;
	return `Lv ${p.bought.level} · ${hrs(p.bought.hours)} · day ${p.bought.day} (${after > 1e-9 ? `+${hrs(after)} after the gate` : 'at the gate'})`;
};
/** A reference-loop purchase id as text: 'rods:T2' -> 'T2 rod assembly', 'permit:Lake' -> 'Lake permit'. */
const purchaseLabel = (id) => id.replace(/^rods:(T\d+)$/, '$1 rod assembly').replace(/^permit:(.+)$/, '$1 permit');
const paybackCell = (p) => (p.bought ? `${hrs(p.paybackHoursAfterPurchase, 1)}${p.paybackExtrapolated ? '*' : ''}${p.paybackDaysAfterPurchase === null ? '' : ` (${int(p.paybackDaysAfterPurchase)} d)`} / ${pct(p.recoveredByEnd, 0)}` : '—');

function markdownTables() {
	const R = report();
	const I = R.integrated;
	const ref = F.REFERENCE_ARCHETYPE;
	const reg = I.byArchetype[ref];
	const ex = R.current.exploit;
	const ps = ex.playSell;
	const P = PARAMS;
	const T = {};
	const freshRow = (k) => R.licenses.find((l) => l.tier === k && l.water === P.model.primaryWater);
	const typ = P.model.typicalMix;
	const PR = RETIRED_LOOP_PARITY;
	const allRuns = [...Object.values(I.byArchetype), ...Object.values(I.withBait)];
	const incTop = R.petIncome.rows.reduce((a, b) => (b.weekly > a.weekly ? b : a));
	const upBasic = R.upkeep.rows[0];
	const C = R.checks;
	const priceList = TIERS.map((k) => usd(freshRow(k).price)).join(' / ');
	const gateList = TIERS.map((k) => LT[k].level).join(' / ');
	const hoursList = TIERS.map((k) => num(LT[k].priceHours, 1)).join(' / ');

	// ----- Summary -----
	T['aquarium-headline'] = mdTable(['Figure', 'Value', 'Table'], [
		['Today: `/pet play` → `/pet sell`', `${usd(ps.cashPerHourOnePet.low)}–${usd(ps.cashPerHourOnePet.high)} per hour from one pet; ${usd(ps.cashPerHourExpertTank)}/h from one 3-pet tank (${num(ps.vsBestProposedFishing.ratioTank, 1)}× the best proposed fishing income)`, 'Fixes'],
		['Today: breeding a thriving pair', `${pct(breedingRate(0, 100).today, 2)} per attempt (about ${int(ps.breedingAttemptsPerSuccessAtBest.today)} attempts per baby); fixed: ${pct(breedingRate(0, 100).fixed, 0)}`, 'Fixes; Breeding'],
		['License prices (Basic / Advanced / Expert, per water type)', `${priceList} at Lv ${gateList}: ${hoursList} h of the gate stage's income`, 'Licenses'],
		['Companion bonus (cash only)', `${TIERS.map((k) => `+${pct(freshRow(k).typicalBonus, 2)}`).join(' / ')} with ${cap(typ)} pets; at most +${pct(freshRow('expert').maxBonus, 2)}`, 'Companion bonus by tier'],
		['XP effect of the aquarium (integrated)', `none: every level 1–${F.LIFECYCLE.maxLevel} on the same step with the same XP by source, in all ${allRuns.length} runs (every archetype and the minimum-daily player; also with money bait)`, 'Effects on progression'],
		['When licenses are bought (integrated)', `every player buys each license before the next tier's gate; the regular player at Lv ${TIERS.map((k) => reg.purchases[k].bought.level).join(' / ')}`, 'When licenses are bought'],
		['Regular player to L60 (integrated)', `licenses ${pct(reg.shares.licensesOfIncome)} of income; bonus ${pct(reg.shares.companionOfFish, 2)} of fish income; net ${spct(reg.shares.netOfIncome)} of income; Basic pays for itself in ${hrs(reg.purchases.basic.paybackHoursAfterPurchase, 1)} of play after purchase`, 'Payback and shares'],
		['Money upkeep', `none (care-based); a flat fee at ${pct(R.upkeep.share, 0)} of the regular player's bonus would take ${pct(upBasic.byArchetype.casual.feeShareOfBonus, 0)} of a casual player's bonus`, 'Upkeep'],
		['Pet income bound (worst case, weekly limit on)', `${usd(incTop.weekly)}/week: ${pct(incTop.shareOfWeeklyFishing.casual.capped)} of a casual and ${pct(incTop.shareOfWeeklyFishing.regular.capped)} of a regular player's fishing`, 'Pet income bound'],
		['Display tanks (aspirational)', `${usd(R.display.totalPerWater)} per water type: ${hrs(R.display.byArchetype[ref].hoursPerWater, 1)} of top-stage income for the regular player`, 'Display tanks'],
		['Design checks', `${C.checks.filter((c) => c.pass).length} of ${C.checks.length} pass`, 'Checks'],
		['Retired private loop', `system() matched it: ${PR.exactMilestones}/${PR.milestonesCompared} milestones step-exact, largest relative difference ${pct(PR.maxRelativeDifference, 2)} (\`${PR.commit}\`)`, 'Retired-loop parity'],
	]);

	// ----- Decisions for approval -----
	T['aquarium-decisions'] = `${mdTable(['ID', 'Proposed decision', 'Modelled', 'Alternatives', 'Why', 'Record = model'], DECISIONS.map((d) => [
		`\`${d.id}\``, d.title, d.modelled, d.alternatives.join('; '), d.why,
		d.get ? yes(JSON.stringify(d.get()) === JSON.stringify(d.expected)) : 'n/a (not a PARAMS value)',
	]))}\n\nStatus of every entry: \`${[...new Set(DECISIONS.map((d) => d.status))].join(', ')}\`. Only the user approves; \`decisions.js\` joins these to the Phase 5B registry (alongside the framework's \`P-LUCKY\`, \`P-DOUBLE-CASH\` and \`P-EVENTS\`) and \`check-shared.js\` verifies each record against the model.`;

	// ----- Correctness fixes -----
	const temp = ex.temperature;
	const tAt = (c) => temp.factors.find((x) => x.temperatureC === c);
	const newTank = tAt(CURRENT.newTankC);
	const atIdeal = tAt(P.temperature.idealC);
	const vb = ps.vsBestProposedFishing;
	const vm = ps.vsBestMeasuredToday;
	const today = 'today\'s numbers (a correctness change)';
	const needs = (...ids) => `**needs proposed values:** ${ids.map((id) => `\`${id}\``).join(', ')}`;
	const shipsOn = {
		A1: `${needs('P-AQUARIUM-CARE-COOLDOWN', 'P-AQUARIUM-BOND', 'P-AQUARIUM-PET-SALE', 'P-AQUARIUM-SALE-LIMIT')} (and A8)`,
		A2: `${today}. **Not before A1 is closed** and not without A3`,
		A3: `the code fix is correctness; the cooldown length (${P.breeding.cooldownDays} days) is a proposed value: \`P-AQUARIUM-BREEDING\`. Ships with A2`,
		A4: `${today}: checked against the stored size until \`P-AQUARIUM-TANKS\` ships, then against the effective capacity`,
		A5: `${today}; the bond cap arrives with \`P-AQUARIUM-BOND\``,
		A6: `${needs('P-AQUARIUM-TANKS')}. **Before or with** the legacy-license read (effective size), or the cutoff option of \`P-AQUARIUM-LEGACY-LICENSES\` (Legacy tanks)`,
		A7: today,
		A8: today,
		A9: `${today}: ${P.temperature.idealC} °C is today's hunger ideal and ${P.temperature.adjustRangeC.join('…')} °C today's \`/aquarium adjust\` range; which ideal to keep is \`P-AQUARIUM-FIX-TEMPERATURE\``,
		A10: today,
		A11: today,
	};
	const fixRows = [
		['**A1**', '**`/pet play` / `/pet feed` / `/aquarium feed` → `/pet sell`: unbounded money.** Each care action gives pet XP × the trait multiplier, limited only by the command cooldown. `Pet.sell` pays `xp × attraction`.',
			`${int(ps.actionsPerHour)} actions/h at the ${ps.commandCooldownS} s cooldown, +${ps.xpPerAction} XP each. One pet: **${usd(ps.cashPerHourOnePet.low)}/h** (attraction ${ps.lowCase.attraction}, ×${num(ps.lowCase.multiplier, 1)}) to **${usd(ps.cashPerHourOnePet.high)}/h** (attraction ${ps.highCase.attraction}, ×${num(ps.highCase.multiplier, 1)}). One 3-pet tank with \`/pet\` + \`/aquarium feed\`: **${usd(ps.cashPerHourExpertTank)}/h**, ${num(vb.ratioTank, 1)}× the best proposed fishing income (${usd(vb.cashPerHour)}/h, ${vb.biome} · ${tierName(vb.tier)}) and ${num(vm.ratioTank, 1)}× today's best measured rod (${usd(vm.cashPerHour)}/h, ${cap(vm.biome)} · ${vm.rod}). Attraction needs a pet aged ${ps.attractionUnlockDays}+ days; ${pct(ex.traits.attraction.pZero)} of pets have attraction 0.`,
			`Per-pet cooldowns (feed ${P.care.feedCooldownH} h, play ${P.care.playCooldownH} h). Bond XP only off cooldown, capped at ${P.companion.bond.maxXp}. Sale value from species, age and condition, **never XP** (at most ${num(petSaleValue({ speciesValue: 1, ageDays: 1e6, attraction: 1e6 }), 2)}× the species value). At most ${P.sale.maxPerWeek} sales per 7 days. Atomic sale (A8).`,
			'`P-AQUARIUM-FIX-PLAY-SELL`'],
		['**A2**', '**Breeding almost never succeeds.** `rng.random() * 100 < rate`, where `rate` is already a probability (`Pet.js:661`).',
			`A thriving pair (stress 0, health 100) has rate ${num(breedingRate(0, 100).rate, 2)}: **${pct(breedingRate(0, 100).today, 2)} per attempt today, about ${int(ps.breedingAttemptsPerSuccessAtBest.today)} attempts per baby.**`,
			'`rng.random() < rate`. The formula itself is kept (Breeding).', '`P-AQUARIUM-FIX-BREEDING`'],
		['A3', 'Breeding has no cooldown: `lastBred` is written but never read.', 'Code reading. Once A2 is fixed, a pair could breed every command cooldown.', `${P.breeding.cooldownDays}-day cooldown per parent.`, '`P-AQUARIUM-FIX-BREEDING`, `P-AQUARIUM-BREEDING`'],
		['A4', 'The breeding capacity check never blocks: `aquariumPets.length >= aquarium.getSize()` compares a number with a Promise (`pet.js:213`). The baby is never added to the tank\'s `fish` list (only `reconcileOwner` adds it later), so tanks exceed capacity.', 'Code reading.', '`await aquarium.getSize()` against the effective capacity; add the baby with `aquarium.addFish` in the same flow.', '`P-AQUARIUM-FIX-CAPACITY`'],
		['A5', 'On a successful breed the parents get the **failure** XP: `updateBreeding()` is called without `true` (`Pet.js:716–717`).', 'Code reading.', '`updateBreeding(true)` (bond XP, capped).', '`P-AQUARIUM-FIX-BREEDING`'],
		['A6', '**One license allows unlimited tanks.** `/build` checks only that some license exists, and each tank holds the license\'s size.', 'Code reading (`build.js`).', 'A license grants tanks × size per water type (Licenses). Existing extra tanks are grandfathered (as proposed; the cutoff and upsize-limit options are in Legacy tanks).', '`P-AQUARIUM-TANKS`, `P-AQUARIUM-LEGACY-LICENSES`'],
		['A7', 'A license can be bought twice (`buy-other.js` has no ownership check); the second copy is wasted money.', 'Code reading.', 'The shop hides owned licenses and lower tiers of an owned water type.', '`P-AQUARIUM-FIX-DUPLICATE-LICENSE`'],
		['A8', '`Pet.sell` credits money with a read-modify-write `user.save()` of the whole document (`Pet.js:497–501`): it can overwrite concurrent cast income (a lost update), and two sells can race.', 'Code reading.', 'Claim the pet atomically (`PetFish.updateOne({ _id, owner: userId }, { $set: { owner: \'\' } })`); pay with `$inc` only if the claim matched, under `withUserLock`.', '`P-AQUARIUM-FIX-SALE-RACE`'],
		['A9', `**Temperature drift is unbounded and the ideal is inconsistent.** Drift is +${CURRENT.driftPerHour} °C/h with no limit (\`Aquarium.js:89\`). Hunger uses the deviation from ${CURRENT.temperatureIdeal.hunger} °C; mood, stress and health the deviation from ${CURRENT.temperatureIdeal.mood} °C. New tanks start at ${CURRENT.newTankC} °C (\`HabitatSchema\`).`,
			`At ${CURRENT.newTankC} °C hunger is ×${num(newTank.hungerFactor, 2)}. At ${P.temperature.idealC} °C health is ×${num(atIdeal.healthFactor, 2)} and mood/stress ×${num(atIdeal.moodStressFactor, 2)}. **No temperature is ideal for all four.** A new tank left alone reaches health ×0 after ${int(temp.hoursToZeroHealthFromNewTank)} h (Temperature).`,
			`One ideal of ${P.temperature.idealC} °C everywhere; the heater holds its setting; stored values read clamped to ${P.temperature.adjustRangeC.join('…')} °C; new tanks at ${P.temperature.newTankC} °C.`, '`P-AQUARIUM-FIX-TEMPERATURE`'],
		['A10', '`calculateMultiplier` ignores `unlocked`, so locked traits already boost pet XP (`calculateAttraction` respects it).', 'Code reading.', 'Respect `unlocked`, as attraction does.', '—'],
		['A11', 'Cosmetic: the second pet\'s underage message shows the first pet\'s name (`Pet.js:649`).', 'Code reading.', 'Use the second pet\'s name.', '—'],
	];
	T['aquarium-fixes'] = mdTable(['#', 'Bug', 'Evidence', 'Fix', 'Decision', 'Ships on'], fixRows.map((r) => [...r, shipsOn[r[0].replace(/\*/g, '')]])) +
		`\n\nOrder. A1 first: while it is open, every pet is a money source. A2 raises breeding success ${int(breedingRate(0, 100).fixed / breedingRate(0, 100).today)}× (thriving pair: ${pct(breedingRate(0, 100).today, 2)} → ${pct(breedingRate(0, 100).fixed, 0)}), so shipped before A1 it multiplies the pets that A1 turns into cash; it also needs A3's cooldown in the same deploy. A6 before or with the license read that upsizes legacy tanks (Legacy tanks). "Today's numbers" means the fix changes no balance value; a fix that needs a value names the proposed decision that sets it.`;

	// ----- Current -> proposed -----
	const cat = (k) => LICENSE_CATALOG.find((l) => l.name === licenseName(k, P.model.primaryWater));
	const perPetRange = `${pct(P.companion.perPet.common, 2)} (Common) to ${pct(P.companion.perPet.lucky, 2)} (Lucky)`;
	const dt = R.display;
	T['aquarium-current-proposed'] = mdTable(['Item', 'Current', 'Proposed', 'Rationale', 'Decision'], [
		['License prices', `${TIERS.map((k) => usd(cat(k).price)).join(' / ')} per water type: ${TIERS.map((k) => int(R.current.licenses.find((l) => l.name === cat(k).name).hoursOfProposedStageIncome)).join(' / ')} h of proposed income at today's gate stages`, `**${priceList}**: ${hoursList} h of the gate stage's income`, 'A milestone, not a wall.', '`P-AQUARIUM-LICENSE-PRICE`'],
		['License gates', `Lv ${TIERS.map((k) => cat(k).requirements.level).join(' / ')}`, `**Lv ${gateList}**`, `Every ${LT.advanced.level - LT.basic.level} levels: Basic after River's first freshwater species, Expert before Swamp.`, '`P-AQUARIUM-LICENSE-GATES`'],
		['What a license grants', `Tank size ${TIERS.map((k) => cat(k).aquarium.size).join(' / ')}; **unlimited tanks**`, `**${TIERS.map((k) => `${LT[k].tanks} × ${LT[k].tankSize}`).join(' / ')}** tanks × size per water type (${TIERS.map((k) => LT[k].tanks * LT[k].tankSize).join(' / ')} pets), and **${TIERS.map((k) => LT[k].companionSlots).join(' / ')} companion slots**`, 'Capacity becomes finite (A6). Slots are the power lever.', '`P-AQUARIUM-TANKS`, `P-AQUARIUM-COMPANION-SLOTS`'],
		['Benefit to fishing', 'none', `**Companion bonus** on the cast's sell bonus: ${perPetRange} per thriving pet in a slot; ${cap(typ)} pets +${TIERS.map((k) => pct(freshRow(k).typicalBonus, 2)).join(' / +')}; maximum +${pct(freshRow('expert').maxBonus, 2)}`, 'The reason to own an aquarium. Cash only, so no XP-curve impact.', '`P-AQUARIUM-COMPANION-BONUS`'],
		['Second water type', 'same price, same (no) benefit', 'Same price. Adds tanks (collection, breeding, display), **not** companion slots', 'No power creep from buying twice.', '`P-AQUARIUM-SECOND-WATER`'],
		['Legacy licenses above the player\'s level', 'n/a', 'Tanks and capacity kept; companion slots **level-capped** to the best tier whose gate the player has reached', 'Same principle as rods\' part level cap.', '`P-AQUARIUM-LEGACY-LICENSES`'],
		['Upkeep', 'none (cleaning and feeding are free)', `**None in money** (${usd(P.upkeep.moneyPerDay)}/day). Care-based: the bonus needs thriving pets`, 'A flat fee is regressive (Upkeep).', '`P-AQUARIUM-UPKEEP`'],
		['Care actions', `+${CURRENT.careXp} pet XP each, ${CURRENT.commandCooldownS} s command cooldown`, `Feed / play once per ${P.care.feedCooldownH} h / ${P.care.playCooldownH} h per pet. +${P.companion.bond.xpPerCare} × multiplier bond XP, capped at ${P.companion.bond.maxXp}`, `Closes A1. Bond ramps a pet's bonus from ${pct(P.companion.bond.minFactor, 0)} to 100% in ${int(bondDays())} days of care.`, '`P-AQUARIUM-CARE-COOLDOWN`, `P-AQUARIUM-BOND`'],
		['Pet sale', '`xp × attraction` (unbounded)', `Species value × age × origin × condition × attraction: **at most ${num(petSaleValue({ speciesValue: 1, ageDays: 1e6, attraction: 1e6 }), 2)}× the fish it came from**; ${P.sale.maxPerWeek} sales per 7 days`, 'Closes A1. Pets are companions, not a money printer.', '`P-AQUARIUM-PET-SALE`, `P-AQUARIUM-SALE-LIMIT`'],
		['Breeding', `${pct(breedingRate(80, 50).today, 2)}–${pct(breedingRate(0, 100).today, 2)} (bug), no cooldown, no capacity check`, `**${pct(breedingRate(80, 50).fixed, 0)}–${pct(breedingRate(0, 100).fixed, 0)}** (same formula), ${P.breeding.cooldownDays}-day cooldown per parent, needs a free slot; babies marked \`bred\``, 'A2–A5. Breeding is a way to get rare pets, not income.', '`P-AQUARIUM-FIX-BREEDING`, `P-AQUARIUM-BREEDING`'],
		['Temperature', `+${CURRENT.driftPerHour} °C/h unbounded; ideals ${Object.values(CURRENT.temperatureIdeal).join(' / ')} °C (hunger / mood / stress / health); new tanks at ${CURRENT.newTankC} °C`, `Ideal **${P.temperature.idealC} °C** in every formula; the heater holds its setting; read clamped to ${P.temperature.adjustRangeC.join('…')} °C; new tanks at ${P.temperature.newTankC} °C; thriving band ±${P.companion.thrive.temperatureBandC} °C`, 'A9. Temperature becomes a setting, not an endless chore.', '`P-AQUARIUM-FIX-TEMPERATURE`'],
		['Cleanliness', `−${P.cleanliness.decayPerHour}/h (floor 0)`, `Unchanged. Thriving needs ≥ ${P.companion.thrive.minCleanliness}`, 'Existing rule; it gives the care loop.', '`P-AQUARIUM-THRIVE`'],
		['Aspirational sink', 'none', `**Display tanks** for an Expert water type: ${P.display.perWaterType} per water type, ${P.display.tankSize} pets each, **${dt.tanks.map((t) => usd(t.price)).join(' / ')}**; no companion slots`, 'Aquarium expansion as an optional sink (decision 10), with no power.', '`P-AQUARIUM-DISPLAY-TANKS`'],
	]);

	// ----- Licenses -----
	T['aquarium-licenses'] = mdTable(['Tier', 'Gate', 'Gate stage ($/h)', 'Price', 'Price (h of gate income)', 'Tanks × size', 'Pets per water type', 'Companion slots', `Typical bonus (${cap(typ)})`, 'Max (Lucky)', 'Today'], TIERS.map((k) => {
		const l = freshRow(k);
		return [`**${LT[k].label}**`, `Lv ${l.level}`, `${l.gateStage.biome} · ${tierName(l.gateStage.tier)} (${usd(l.gateStage.cashPerHour)})`, `**${usd(l.price)}**`, num(l.priceHours, 1), `${l.tanks} × ${l.tankSize}`, int(l.capacity), int(l.companionSlots), `+${pct(l.typicalBonus, 2)}`, `+${pct(l.maxBonus, 2)}`, `${usd(l.current.price)}, Lv ${l.current.level}, size ${l.current.size}, unlimited tanks`];
	})) + '\n\nBoth water types share these rows. Price = two significant digits of (hours × the gate stage\'s $/h), where the stage is the gate level\'s biome with the shared gear tier held there, at the regular player\'s cadence.';
	T['aquarium-afford-hours'] = mdTable(['Tier', ...Object.keys(F.ARCHETYPES).map((a) => cap(a))], R.priceTable.map((p) => [`${LT[p.tier].label} (${usd(p.price)})`, ...Object.keys(F.ARCHETYPES).map((a) => `${hrs(p.hoursOfGateIncome[a].hours)} (${num(p.hoursOfGateIncome[a].days, 2)} days)`)])) + '\n\nHours of the gate stage\'s fishing income at each archetype\'s cadence (reaction overhead changes $/h); days at its minutes per day. Fishing income only: on the integrated model quests, streak and buffs add to it (When licenses are bought).';
	T['aquarium-afford-integrated'] = mdTable(['Player', ...TIERS.map((k) => `${LT[k].label} (gate Lv ${LT[k].level})`), 'With money bait: bought at'], ARCHETYPE_ROWS.map((a) => {
		const l = I.byArchetype[a];
		const b = I.withBait[a];
		return [a === ref ? `**${archLabel(a)}**` : archLabel(a), ...TIERS.map((k) => boughtCell(l.purchases[k])), b ? TIERS.map((k) => (b.purchases[k].bought ? `Lv ${b.purchases[k].bought.level}` : '—')).join(' / ') : '—'];
	})) + `\n\nModel: ${I.model}. Licenses are non-blocking optional purchases, so rod assemblies and permits (blocking progression goals) are always served first; the licensed water type is ${P.model.primaryWater}.`;

	// ----- Companion bonus -----
	T['aquarium-bonus-tiers'] = mdTable(['Tier', 'Slots', ...P.model.mixes.map((m) => `All ${cap(m)}${m === typ ? ' (typical)' : m === 'lucky' ? ' (max)' : ''}`)], R.companion.byTier.map((t) => [LT[t.tier].label, int(t.slots), ...P.model.mixes.map((m) => (m === typ ? `**+${pct(t.byMix[m], 2)}**` : `+${pct(t.byMix[m], 2)}`))]));
	T['aquarium-bonus-stages'] = mdTable(['Stage', 'Fish income', 'Tier held (gate reached)', 'Bonus', 'Extra $/h'], R.companion.cashPerHourAtStages.filter((s) => s.tierHeld).map((s) => [`${s.biome} · ${tierName(s.gear)} (Lv ${s.level})`, `${usd(s.cashPerHour)}/h`, LT[s.tierHeld].label, `+${pct(s.bonus, 2)}`, usd(s.extraCashPerHour)])) + `\n\nRegular cadence, ${cap(typ)} pets at full bond, one water type.`;
	T['aquarium-pet-supply'] = mdTable(['Gate', 'Stage', 'Water', 'Fish/h', 'Ultra/h', 'Legendary/h', 'Lucky/h', `Hours for ${LT.basic.companionSlots} Legendary`, 'Hours per Lucky'], R.companion.petSupply.map((s) => [`Lv ${s.level}`, `${s.biome} · ${tierName(s.tier)}`, s.water, int(s.fishPerHour), num(s.perHour.ultra, 2), num(s.perHour.legendary, 2), num(s.perHour.lucky, 2), hrs(LT.basic.companionSlots / s.perHour.legendary, 1), hrs(1 / s.perHour.lucky, 0)])) + '\n\nFramework draw model at the regular cadence (Lucky items excluded, under the framework\'s Lucky-item rule). A pet must match the tank\'s water type; the Lv 45 stage (Coast) is saltwater.';

	// ----- Integrated: payback and shares, effects, sensitivity -----
	T['aquarium-integrated'] = mdTable(['Player', ...TIERS.map((k) => `${LT[k].label}: payback / recovered by L60`), 'License spend (share of income)', 'Bonus (share of fish income)', 'Net (share of income)', 'Money upkeep'], ARCHETYPE_ROWS.map((a) => {
		const l = I.byArchetype[a];
		const b = a === ref ? (s) => `**${s}**` : (s) => s;
		return [b(archLabel(a)), ...TIERS.map((k) => b(paybackCell(l.purchases[k]))), b(pct(l.shares.licensesOfIncome)), b(pct(l.shares.companionOfFish, 2)), b(spct(l.shares.netOfIncome)), usd(l.shares.upkeepOfIncome)];
	})) + `\n\nModel: ${I.model}; to L${F.LIFECYCLE.maxLevel}. Payback = hours of play after the purchase until the companion cash it added covers its price; * = after L${F.LIFECYCLE.maxLevel}, extrapolated at the last step's income per unit of bonus at full bond (Mountain Stream would shorten it). Income = every cash source (fishing, quests, streak, buffs, salvage); fish income = fishing without the companion cash. ${cap(typ)} pets, care every day.`;
	T['aquarium-effects'] = mdTable(['Player', 'XP at every level, with vs without the aquarium', 'Progression purchases the licenses move', 'Still bought in time'], ARCHETYPE_ROWS.map((a) => {
		const l = I.byArchetype[a];
		const b = I.withBait[a];
		const xp = `${l.effect.xpIdentical ? 'identical' : '**differs**'} (${l.effect.levelsCompared} levels)${b ? `; with money bait ${b.effect.xpIdentical ? 'identical' : '**differs**'}` : ''}`;
		const moved = l.effect.moved.length ? l.effect.moved.map((m) => `${purchaseLabel(m.id)} ${hrs(m.hoursWithout)} → ${hrs(m.hoursWith)}${m.neededAtLevel !== null ? ` (needed at Lv ${m.neededAtLevel}, ${hrs(m.neededAtHours)})` : ''}`).join('; ') : 'none';
		return [archLabel(a), xp, moved, yes(l.effect.progressionInTime && (!b || b.effect.progressionInTime))];
	})) + '\n\nIdentical = every level reached on the same 1-minute step with the same XP by source. A moved purchase is in time when it is still bought by the time the level that uses it is reached (a rod tier\'s level, a biome\'s permit level); a dropped purchase would fail.';
	const S = I.sensitivity;
	const sensRow = (label, l) => [label, pct(l.shares.companionOfFish, 2), TIERS.map((k) => (l.purchases[k].bought ? pct(l.purchases[k].recoveredByEnd, 0) : '—')).join(' / '), TIERS.map((k) => (l.purchases[k].bought ? `${num(l.purchases[k].paybackHoursAfterPurchase, 1)}${l.purchases[k].paybackExtrapolated ? '*' : ''}` : '—')).join(' / '), pct(l.shares.licensesOfIncome), spct(l.shares.netOfIncome)];
	T['aquarium-sensitivity'] = [
		mdTable(['Variant (regular player)', 'Bonus / fish income', 'Recovered by L60 (B / A / E)', 'Payback h (B / A / E)', 'Licenses / income', 'Net'], [
			...P.model.mixes.map((m) => sensRow(m === typ ? `**All-${cap(m)} pets (typical)**` : `All-${cap(m)} pets${m === 'common' ? ' (floor)' : m === 'lucky' ? ' (ceiling)' : ''}`, S.mix[m])),
			...SENSITIVITY.care.map((c) => sensRow(`Pets thriving ${pct(c, 0)} of the time`, S.care[c])),
			sensRow('Money bait on (both sides)', I.withBait[ref]),
		]),
		mdTable(['Player', 'License spend, one water type (share of income)', 'Both water types', 'Net, both water types', 'Bonus / fish income, both'], Object.keys(F.ARCHETYPES).map((a) => {
			const one = I.byArchetype[a];
			const both = S.bothWaters[a];
			return [archLabel(a), pct(one.shares.licensesOfIncome), pct(both.shares.licensesOfIncome), spct(both.shares.netOfIncome), pct(both.shares.companionOfFish, 2)];
		})),
	].join('\n\n') + '\n\nIntegrated, to L60. * = payback after L60 (extrapolated). The second water type adds spend and capacity but no companion cash (`P-AQUARIUM-SECOND-WATER`).';

	// ----- Upkeep -----
	T['aquarium-upkeep'] = mdTable(['Tier (gate stage)', 'Fee per pet per day', ...Object.keys(F.ARCHETYPES).map((a) => `${cap(a)}: fee / bonus`), 'Casual: fee / income (full slots)'], R.upkeep.rows.map((r) => {
		const [biome, tier] = r.stage.split(' ');
		return [`${LT[r.tier].label} (${biome} · ${tierName(tier)})`, usd(r.feePerPetDay), ...Object.keys(F.ARCHETYPES).map((a) => (a === 'casual' ? `**${pct(r.byArchetype[a].feeShareOfBonus, 0)}**` : pct(r.byArchetype[a].feeShareOfBonus, 1))), pct(r.byArchetype.casual.feeShareOfIncome, 1)];
	})) + `\n\nThe rejected alternative: a flat fee per pet per day sized at ${pct(R.upkeep.share, 0)} of the regular player's daily bonus from that pet (${cap(typ)}) at each gate stage.`;

	// ----- Pets -----
	const tr = ex.traits;
	const actionsPerDay = 24 / P.care.feedCooldownH + 24 / P.care.playCooldownH;
	T['aquarium-pet-rules'] = mdTable(['Rule', 'Value', 'Decision'], [
		['Care cooldowns (per pet)', `feed ${P.care.feedCooldownH} h, play ${P.care.playCooldownH} h; \`/aquarium feed\` feeds every pet off cooldown`, '`P-AQUARIUM-CARE-COOLDOWN`'],
		['Bond XP per care action off cooldown', `+${P.companion.bond.xpPerCare} × the trait multiplier (mean ×${num(tr.multiplier.mean, 2)}, max ×${num(tr.multiplier.max, 1)}, respecting \`unlocked\`)`, '`P-AQUARIUM-BOND`'],
		['Most bond XP per pet per day', `${int(actionsPerDay)} actions × ${P.companion.bond.xpPerCare} × ${num(tr.multiplier.max, 1)} = ${int(actionsPerDay * P.companion.bond.xpPerCare * tr.multiplier.max)}; bond XP has no cash value`, '`P-AQUARIUM-BOND`'],
		['Bond cap and ramp', `cap ${P.companion.bond.maxXp} (stored \`xp\` never reduced); a pet's bonus ramps ${pct(P.companion.bond.minFactor, 0)} → 100%: ${int(bondDays())} days at ${P.care.actionsPerDayModel} care actions a day`, '`P-AQUARIUM-BOND`'],
		['Companion bonus per thriving pet', Object.entries(P.companion.perPet).map(([r, v]) => `${cap(r)} ${pct(v, 2)}`).join(', '), '`P-AQUARIUM-COMPANION-BONUS`'],
		['Thriving', `fed within ${P.companion.thrive.fedWithinH} h; tank cleanliness ≥ ${P.companion.thrive.minCleanliness}; temperature within ±${P.companion.thrive.temperatureBandC} °C of ${P.temperature.idealC} °C`, '`P-AQUARIUM-THRIVE`'],
		['Cleanliness', `−${P.cleanliness.decayPerHour}/h (unchanged): clean at least every ${int((100 - P.companion.thrive.minCleanliness) / P.cleanliness.decayPerHour)} h`, '`P-AQUARIUM-THRIVE`'],
		['Sale value', `species value (\`F.proposedValue\`) × age (${num(P.sale.minAgeFactor, 2)} at day 1 → 1.00 at day ${P.sale.fullValueAgeDays}) × (bred ? ${num(P.sale.bredFactor, 2)} : 1) × (thriving ? 1 : ${num(P.sale.notThrivingFactor, 2)}) × (1 + ${pct(P.sale.attractionPerPoint, 0)} per attraction point, up to ${P.sale.maxAttraction})`, '`P-AQUARIUM-PET-SALE`'],
		['Sales limit', `${P.sale.maxPerWeek} per 7 days`, '`P-AQUARIUM-SALE-LIMIT`'],
		['Breeding', `parents aged ${P.breeding.minAgeDays}+ days, health ≥ ${P.breeding.minHealth}, same water type; ${P.breeding.cooldownDays}-day cooldown per parent; a free slot in the tank; chance ${pct(breedingRate(80, 50).fixed, 0)}–${pct(breedingRate(0, 100).fixed, 0)}`, '`P-AQUARIUM-BREEDING`'],
	]);
	T['aquarium-sale'] = [
		mdTable(['Case', 'Age (days)', 'Share of species value'], R.sale.examples.map((e) => [cap(e.label), int(e.ageDays), e.attraction ? `**${pct(e.factor, 0)}** (the maximum)` : pct(e.factor, 0)])),
		mdTable(['Species', 'Mean value', 'Max value', 'Max sale'], R.sale.species.map((s) => [`${s.biome} ${cap(s.rarity)}`, usd(s.mean), usd(s.max), usd(s.maxSale)])),
	].join('\n\n') + `\n\nAttraction ≥ 20 is rare today (${pct(tr.attraction.p20plus, 1)} of pets); ${pct(tr.attraction.pZero, 1)} have none.`;
	T['aquarium-breeding'] = mdTable(['Stress / health', 'Rate', 'Today (`random()*100 < rate`)', 'Fixed', 'Attempts per baby: today → fixed'], R.breeding.examples.map((e) => [`${e.stress} / ${e.health}${e.stress === 0 && e.health === 100 ? ' (thriving)' : ''}`, num(e.rate, 2), pct(e.today, 2), `**${pct(e.fixed, 0)}**`, `${int(1 / e.today)} → ${num(1 / e.fixed, 2)}`]));
	T['aquarium-pet-income'] = mdTable(['Parents (max species value)', 'Capacity (slots)', 'Best strategy', 'Births/week', 'Sales/week', '$/week (uncapped → capped)', ...Object.keys(F.ARCHETYPES).map((a) => `${cap(a)} (uncapped → capped)`)], R.petIncome.rows.map((r) => [
		`${cap(r.parents)} (${usd(r.speciesValueMax)})`, `${r.capacity} (${r.slots})`, r.strategy, num(r.births, 2), num(r.sales, 2), r.capped ? `${usd(r.weeklyUncapped)} → **${usd(r.weekly)}**` : usd(r.weekly),
		...Object.keys(F.ARCHETYPES).map((a) => (r.capped ? `${pct(r.shareOfWeeklyFishing[a].uncapped, 1)} → ${pct(r.shareOfWeeklyFishing[a].capped, 1)}` : pct(r.shareOfWeeklyFishing[a].capped, 1))),
	])) + `\n\nAn upper bound: thriving parents (${pct(breedingRate(0, 100).fixed, 0)}), the most valuable ${R.petIncome.rows[0].biome} species, every baby at maximum attraction, the better of selling at birth and aging to full value, then the weekly limit. Shares are of weekly fishing income at ${R.petIncome.stage.split(' ')[0]} · ${tierName(R.petIncome.stage.split(' ')[1])}. The minimum-daily player (R2) can take at most the capped figure; the aquarium gives it no XP (Effects on progression).`;

	// ----- Temperature -----
	T['aquarium-temperature'] = mdTable(['Tank °C (stored)', 'Today: hunger', 'Today: mood / stress', 'Today: health', 'Proposed: read as', 'Proposed: deviation from the ideal', 'Proposed: within the thriving band'], temp.factors.map((f) => [
		`${int(f.temperatureC)}${f.temperatureC === CURRENT.newTankC ? ' (new tank today)' : f.temperatureC === P.temperature.idealC ? ' (proposed ideal)' : f.temperatureC === TEMPERATURE_EXAMPLES_C[TEMPERATURE_EXAMPLES_C.length - 1] ? ' (long-drifted legacy tank)' : ` (${int((f.temperatureC - CURRENT.newTankC) / CURRENT.driftPerHour)} h unattended from a new tank)`}`,
		`×${num(f.hungerFactor, 2)}`, `×${num(f.moodStressFactor, 2)}`, `×${num(f.healthFactor, 2)}`, `${int(f.proposedReadC)} °C`, `${int(f.proposedDeviationC)} °C`, f.proposedTempOk ? 'yes' : 'no: set the heater once',
	])) + `\n\nToday's factors multiply the rate of change (hunger, mood, stress) or health. Proposed: every formula uses |T − ${P.temperature.idealC}|, the heater holds its setting (drift ${P.temperature.driftPerHour} °C/h), and stored values are read clamped to the \`/aquarium adjust\` range.`;

	// ----- Display tanks -----
	T['aquarium-display'] = [
		mdTable(['Tank', ...dt.tanks.map((t) => String(t.n)), 'Total per water type', 'Both water types'], [['Price', ...dt.tanks.map((t) => usd(t.price)), usd(dt.totalPerWater), usd(dt.totalBoth)]]),
		mdTable(['Player', `One water type: hours of ${dt.stage.biome} income / days`, 'Both water types', 'Integrated, display tanks on: bought at', 'Display spend / income to L60'], Object.keys(F.ARCHETYPES).map((a) => {
			const x = dt.byArchetype[a];
			const l = S.display[a];
			return [archLabel(a), `${hrs(x.hoursPerWater, 1)} / ${num(x.daysPerWater, 1)} days`, `${hrs(x.hoursBoth, 1)} / ${num(x.daysBoth, 1)} days`, l.displayTanks.length ? l.displayTanks.map((d) => `Lv ${d.level}`).join(' / ') : 'none by L60', pct(l.shares.displayTanksOfIncome)];
		})),
	].join('\n\n') + `\n\nPrice = ${P.display.firstPriceHours} h of the top live stage's income (${dt.stage.biome} · ${tierName(dt.stage.tier)}, ${usd(dt.stage.cashPerHour)}/h at the regular cadence), ×${P.display.growth} per tank, two significant digits. The integrated column runs the reference loop with \`systemOpts.aquarium.displayTanks\` on (one water type).`;

	// ----- Legacy licenses -----
	const levelsShown = [...new Set([0, ...TIERS.map((k) => LT[k].level)])];
	T['aquarium-legacy'] = mdTable(['License', 'Paid today', 'Tank size: stored → effective', 'Tanks: today → proposed', 'New price', `Companion slots at Lv ${levelsShown.join(' / ')}`], R.legacy.map((l) => [l.name, usd(l.paidToday), `${l.storedSize} → ${l.effectiveTankSize}`, `${l.tanksToday} → ${l.tanksProposed} (extra tanks grandfathered)`, usd(l.newPrice), levelsShown.map((L) => l.companionSlotsAtLevel[L]).join(' / ')]));

	// ----- Legacy tanks built before A6 -----
	const lt = R.legacyTanks;
	T['aquarium-legacy-tanks'] = mdTable(['License (one water type)', 'New allowance: tanks × size', 'Legacy tank: stored → read size', `Built in ${lt.minutes} min of /build today`, 'Capacity at release: as proposed (every tank at the read size)', 'Option: upsize only up to the license\'s tank count', 'Option: grandfather only Habitats created before a cutoff (these built after it)', 'Extra capacity as proposed: display tanks it replaces', 'Extra legacy tanks that match one water type\'s display capacity (build time)'], lt.rows.map((r) => [
		r.license.replace(' Aquarium License', ''), `${r.tanks} × ${r.tankSize} = ${r.allowance}`, `${r.storedSize} → ${r.readSize}`, `${r.built} tanks`,
		`**${r.capacity.proposed}** (+${r.extra.proposed})`, `${r.capacity.upsizeUpToTankCount} (+${r.extra.upsizeUpToTankCount})`, `${r.capacity.cutoffBeforeBuild} (+${r.extra.cutoffBeforeBuild})`,
		`${r.displayReplacedAsProposed.tanks} of ${P.display.perWaterType} (${usd(r.displayReplacedAsProposed.price)})${r.displayNeedsExpert ? '; display tanks need Expert' : ''}`,
		`${r.tanksToMatchDisplay} (${r.secondsToMatchDisplay} s)`,
	])) + `\n\n\`legacyTankExposure()\`. Today \`/build\` needs only a license of the water type and a unique name: no tank limit, a ${lt.buildCooldownS} s cooldown (\`build.js:25\`). One water type's display tanks hold ${lt.displayCapacityPerWater} pets for ${usd(lt.displayPricePerWater)} (Display tanks). Capacity = pets the tanks can take after release. Capacity only: companion slots come from the license tier, and pet cash is limited per week (Pet income bound). ${lt.water} rows; ${lt.sameForEveryWater ? 'the other water type is identical (same stored sizes)' : '**the other water type differs**'}.`;

	// ----- Checks -----
	const fmtNum = (x) => (x === null ? '—' : num(x, Number.isInteger(x) ? 0 : 2));
	const fmtVal = (v) => (typeof v === 'object' && v !== null ? Object.entries(v).map(([k, x]) => `${k} ${fmtNum(x)}`).join(', ') : typeof v === 'boolean' ? yes(v) : String(v));
	T['aquarium-checks'] = mdTable(['Check', 'Target', 'Measured', 'Result'], C.checks.map((c) => [c.check, fmtVal(c.target), fmtVal(c.value), passFail(c.pass)]));

	// ----- Retired loop parity -----
	T['aquarium-parity'] = mdTable(['Record', 'Value'], [
		['Source', `${PR.source}, commit \`${PR.commit}\``],
		['Method', PR.method],
		['Cases', `${PR.caseCount}: ${PR.cases.join('; ')}`],
		['Milestones step-exact', `${PR.exactMilestones} of ${PR.milestonesCompared}`],
		['License purchase passes', PR.maxPurchasePassShiftSteps === 0 ? 'identical in every case' : `up to ${PR.maxPurchasePassShiftSteps} steps apart`],
		['Largest relative difference', `${pct(PR.maxRelativeDifference, 2)} (tolerance ${pct(PR.tolerance, 1)}): ${PR.worst}`],
		['Companion cash, regular player to L60', `${usd(PR.companionCashRegular.retiredLoop)} (retired loop) vs ${usd(PR.companionCashRegular.system)} (system)`],
		['Largest payback difference', hrs(PR.maxPaybackDifferenceHours)],
		['Replay of the retired loop\'s conventions', `${PR.replay.exactMilestones} milestones step-exact; relative difference ${PR.replay.maxRelativeDifference} (exact)`],
		['No XP effect', `${PR.noXpEffect.identical ? 'identical' : '**differs**'}: ${PR.noXpEffect.archetypes} archetypes × levels 1–${PR.noXpEffect.levels}`],
		['The one rule difference', PR.ruleDifference],
	]);
	return T;
}

module.exports = {
	PARAMS, CURRENT, DECISIONS, SENSITIVITY,
	waterOf, stageAt, licensePrice, licenses, licenseByName,
	bondFactor, perPetBonus, companionSlots, companionBonus, holdingsBonus,
	thriving, effectiveTemperature, petSaleValue, speciesValue, breedingRate, petIncomeBound, availability,
	aquariumOptions, displayTanks, legacyTankExposure, currentExploit, currentLicenses, upkeepAlternatives,
	SYSTEM_NAME, SPEND, system, systemSummary, RETIRED_LOOP_PARITY,
	lifecycle, integratedReport, checks, report, markdownTables,
};

if (require.main === module) process.stdout.write(`${JSON.stringify(report(), null, 1)}\n`);
