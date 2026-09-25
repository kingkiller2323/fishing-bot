// Phase 5B subsystem: RODS, CRAFTING, CRATES, REPAIRS, OLD ROD. Analysis only: nothing here touches
// the live game, src/ or production data. Every economic number below is computed at runtime from the
// shared framework (./framework.js). Only the design parameters in PARAMS are hand-set; prices are
// formulas of stage income, so a framework change regenerates every figure without manual scaling.
//
//   node -e "require('./scripts/economy/5b/rods.js').report()"     (returns the report object)
//   node scripts/economy/5b/rods.js                                  (prints it as JSON)
//
// Exports (all pure; no database, no randomness):
//   PARAMS                      frozen design parameters (part levels, slot stat families, variants,
//                               durability lives, upkeep share, crate tables, assembly hours, salvage)
//   RARITY_ORDER, SLOTS         part rarities (low -> high) and slot -> catalog type
//   CATALOG                     the seeded rod parts (src/bootstrap/data/rodParts.js)
//   tierLevel(t), homeBiome(t), stageBiome(t)
//                               level of a tier, biome a tier is built for, biome of the stage before it
//   capRarity(rarity, level)    highest part rarity a player of `level` gets the full effect of
//   partProfile(part, {playerLevel})
//                               one part's contribution under the proposed slot families
//   matchedSet(rarity)          catalog-free "balanced" part set of one rarity (per slot: the highest
//                               rarity <= `rarity` that exists in the catalog for that slot)
//   referenceSet(tier)          the tier-appropriate set every tier figure is quoted for
//   craftRod(parts, {playerLevel})
//                               the proposed crafted rod: tier, level requirement, qualities, stats,
//                               meanFish, multiChance, jackpot odds, cooldown, maxDurability, repairCost
//   oldRod()                    the proposed starter rod (unbreakable, weak only, 1 fish)
//   rodOutcome(rod, biome)      F.castOutcome for a rod (normal profile)
//   rodHourly(rod, biome, overheadS)
//                               F.hourly of rodOutcome
//   upkeepShare(rod, biome)     repair cost as a share of the fish income the same durability earns
//   legacyCraft(parts)          TODAY's crafted rod for a part set (real FishingRod.combineQualities +
//                               resolveModifiers rules): level, fish/cast, durability, repair
//   legacySignature(capabilities), convertLegacyRod(storedRod, partDocs)
//                               converter for EXISTING crafted rods (no data rewrite)
//   evaluateAllCombos()         all 2,450 catalog part combinations under today's and the proposed rules
//   crateDefinitions()          proposed Gacha V2 box definitions with prices (formula of stage income)
//   crateSlotOdds(tier)         per crate slot: P(part of each slot at each rarity)
//   assembly(tier)              expected / median / P90 crates, $ and hours of stage income to assemble
//                               the tier-appropriate set, plus leftover parts and salvage refund
//   salvageValue(rarity)        cash for salvaging one part of that rarity
//   gearPath()                  integrator-facing path: per tier {tier, level, qualities, stats,
//                               multiChance, meanFish, cooldownMs, maxDurability, repairCost, assembly...}
//   lifecycle(archetype, opts)  curve.js-style lifecycle on this gear path, with crates bought from stage
//                               income (checks the chosen XP curve still meets the approved targets)
//   ARCHETYPES                  casual / regular / active / grinder cadence
//   report()                    every key number of docs/economy/5b/rods.md, computed
const F = require('./framework');
const CATALOG = require('../../../src/bootstrap/data/rodParts');
const { baseTable } = require('../../../src/engine/gacha');
const { applyPity, normalize } = require('../../../src/engine/rarity');
const { RARITIES, PROFILES } = require('../../../src/engine/balance');
const { resolveModifiers } = require('../../../src/engine/modifiers');

const deepFreeze = (o) => {
	for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
	return Object.freeze(o);
};

const RARITY_ORDER = ['Common', 'Uncommon', 'Rare', 'Ultra', 'Legendary', 'Lucky'];
const SLOTS = { rod: 'part_rod', reel: 'part_reel', hook: 'part_hook', handle: 'part_handle' };
const SLOT_OF_TYPE = Object.fromEntries(Object.entries(SLOTS).map(([s, t]) => [t, s]));
const rank = (r) => RARITY_ORDER.indexOf(r);
const canon = (r) => RARITY_ORDER.find((x) => x.toLowerCase() === String(r).toLowerCase());

// ---------------------------------------------------------------------------------------------
// Design parameters (the only hand-set numbers in this subsystem).
const PARAMS = deepFreeze({
	id: 'rods-5b',
	craft: {
		// Crafting and equipping a crafted rod needs Lv 20 (the first-rod milestone). Above that, a part
		// works at full strength once the player reaches its level (see capRarity); below it, it works
		// at the best rarity the player has unlocked. Every crafted rod catches strong fish.
		minLevel: 20,
		qualities: ['weak', 'strong'],
	},
	// Level at which a part of each rarity works at full strength. The rod's requirement (shown on the
	// rod) is the highest of its four parts; its tier follows from that level.
	partLevel: { Common: 20, Uncommon: 20, Rare: 30, Ultra: 40, Legendary: 50, Lucky: 60 },
	tierOfRarity: { Common: 1, Uncommon: 1, Rare: 2, Ultra: 3, Legendary: 4, Lucky: 5 },
	// The tier-appropriate set every tier figure is quoted for (matchedSet of this rarity).
	referenceRarity: { 1: 'Uncommon', 2: 'Rare', 3: 'Ultra', 4: 'Legendary', 5: 'Lucky' },
	// Each SLOT has its own stat family; magnitudes scale with the part's rarity and ADD across parts
	// (PART_RARITY_STATS semantics: every part contributes by its rarity; now each slot contributes a
	// different family instead of the same uniform bundle).
	slots: {
		rod: {
			family: 'Multi-catch (mean fish per cast) and the durability base',
			meanFish: { Common: 1.10, Uncommon: 1.20, Rare: 1.30, Ultra: 1.50, Legendary: 1.65, Lucky: 1.80 },
		},
		reel: {
			family: 'Fishing speed (cooldown) and trophy/drag (Giant weight)',
			fishingSpeed: { Common: 0, Uncommon: 0.03, Rare: 0.05, Ultra: 0.10, Legendary: 0.15, Lucky: 0.20 },
			trophyChance: { Common: 0, Uncommon: 0.05, Rare: 0.10, Ultra: 0.30, Legendary: 0.50, Lucky: 0.70 },
		},
		hook: {
			family: 'Rarity targeting: Rare Find (Rare/Ultra) and Luck (Legendary/Lucky)',
			rareFind: { Common: 0.10, Uncommon: 0.20, Rare: 0.40, Ultra: 0.60, Legendary: 0.90, Lucky: 1.20 },
			luck: { Common: 0.05, Uncommon: 0.10, Rare: 0.20, Ultra: 0.40, Legendary: 0.60, Lucky: 0.80 },
		},
		handle: {
			family: 'Durability efficiency (casts per life, so upkeep per fish) and clean handling (sell bonus)',
			durabilityMult: { Common: 1.0, Uncommon: 1.1, Rare: 1.25, Ultra: 1.45, Legendary: 1.7, Lucky: 2.0 },
			sellBonus: { Common: 0, Uncommon: 0, Rare: 0.02, Ultra: 0.04, Legendary: 0.06, Lucky: 0.08 },
		},
	},
	// Same-slot, same-rarity parts get a specialty tilt (derived from today's catalog identity: more legacy
	// draws = faster action, more legacy durability = backbone, 'quick' = light retrieve, extra draw on a
	// reel = trolling). Multipliers apply to that slot's stats; meanDelta is added to mean fish per cast.
	variants: {
		'Fiberglass Rod Piece': { label: 'Fast action', meanDelta: 0.03, durability: 0.85 },
		'Graphite Rod Piece': { label: 'Backbone', meanDelta: -0.03, durability: 1.2 },
		'Centerpin Reel': { label: 'Free-spool', fishingSpeed: 1.4, trophyChance: 0.6 },
		'Jigging Reel': { label: 'Heavy drag', fishingSpeed: 0.6, trophyChance: 1.4 },
		'Fly Fishing Reel': { label: 'Light retrieve', fishingSpeed: 1.4, trophyChance: 0.6 },
		'Trolling Reel': { label: 'Trolling drag', fishingSpeed: 0.6, trophyChance: 1.4 },
		'Swimbait Hook': { label: 'Big bait', rareFind: 0.8, luck: 1.3 },
		'Worm Hook': { label: 'Natural bait', rareFind: 1.2, luck: 0.75 },
	},
	// Normal-player multi-catch ceiling (framework endgame mean).
	multi: { ceilingMean: 1.8 },
	durability: {
		// Hours of play (regular cadence) one life of a MATCHED set lasts, by rod-piece rarity. The handle
		// multiplies it. Durability still costs 1 per fish (the engine rule is unchanged).
		lifeHours: { Common: 2.5, Uncommon: 3, Rare: 4, Ultra: 5, Legendary: 6, Lucky: 8 },
		designOverheadS: 4,
		roundTo: 50,
	},
	repair: {
		// Mandatory upkeep: a matched set's repair costs this share of the fish income its durability
		// earns in the tier's home biome. Repair cost follows the rod piece's rarity.
		upkeepShare: 0.04,
		// Crafted rods: unlimited repairs (no destruction); legacy 'destroyed' crafted rods become repairable.
		craftedMaxRepairs: null,
	},
	oldRod: { unbreakable: true, meanFish: 1.0, qualities: ['weak'] },
	crates: {
		slots: 3,
		strategy: 'independent',
		duplicates: 'unique',
		// Featured weights make each slot type equally likely within a rarity (the catalog has 10 reels,
		// 7 rod pieces, 7 hooks and 5 handles; without this the coupon-collector tail is the handle/hook).
		balanceSlots: true,
		tiers: {
			1: { name: 'Fishing Crate', existing: true, unlockLevel: 10, rarityTable: { common: 50, uncommon: 47, rare: 3 }, rarityFloor: null, guaranteed: 'uncommon' },
			2: { name: 'Pro Tackle Crate', unlockLevel: 20, rarityTable: { uncommon: 45, rare: 52, ultra: 3 }, rarityFloor: 'uncommon', guaranteed: 'rare' },
			3: { name: 'Expert Tackle Crate', unlockLevel: 30, rarityTable: { rare: 45, ultra: 52, legendary: 3 }, rarityFloor: 'rare', guaranteed: 'ultra' },
			4: { name: 'Master Tackle Crate', unlockLevel: 40, rarityTable: { ultra: 45, legendary: 54, lucky: 1 }, rarityFloor: 'ultra', guaranteed: 'legendary' },
			5: {
				name: 'Gilded Tackle Crate', unlockLevel: 50, rarityTable: { legendary: 80, lucky: 20 }, rarityFloor: 'legendary', guaranteed: null,
				pity: { lucky: { counter: 'lucky', tiers: ['lucky'], softStart: 3, rampPerCast: 0.1, maxBonus: 0.5, hard: 8 } },
			},
		},
	},
	// Progression purchase: expected cost of assembling tier t's set, in hours of the income of the stage
	// that leads up to it (previous tier's rod in the biome unlocked 10 levels before tier t).
	assemblyHours: { 1: 1.25, 2: 2.5, 3: 4, 4: 6, 5: 8 },
	salvage: {
		// Salvaging a part pays this share of one crate slot of the crate whose guaranteed rarity it is.
		share: 0.25,
		commonOfUncommon: 0.25,
	},
	priceSigDigits: 2,
});

// ---------------------------------------------------------------------------------------------
// Helpers
const MODELLED_BIOMES = F.BIOME_ORDER.filter((b) => b !== 'Mountain Stream'); // future content (3 fish)
const biomeForLevel = (L) => [...MODELLED_BIOMES].reverse().find((b) => L >= F.BIOME_LEVEL[b]);
const tierLevel = (t) => PARAMS.partLevel[PARAMS.referenceRarity[t]];
const homeBiome = (t) => biomeForLevel(tierLevel(t));
const stageBiome = (t) => biomeForLevel(tierLevel(t) - 10);
const TIERS = [1, 2, 3, 4, 5];
const round4 = (x) => Number(x.toFixed(4));
const roundTo = (x, step) => Math.round(x / step) * step;
function nicePrice(x, digits = PARAMS.priceSigDigits) {
	if (!(x > 0)) return 0;
	const p = 10 ** (Math.floor(Math.log10(x)) - digits + 1);
	return Math.round(x / p) * p;
}

/** Highest part rarity (<= rarity) whose full effect a player of `level` has unlocked; null below Lv 20. */
function capRarity(rarity, level = Infinity) {
	for (let i = rank(rarity); i >= 0; i--) if (PARAMS.partLevel[RARITY_ORDER[i]] <= level) return RARITY_ORDER[i];
	return null;
}

/** One part's contribution under the proposed slot families. `part` = { name, type, rarity }. */
function partProfile(part, { playerLevel = Infinity } = {}) {
	const slot = SLOT_OF_TYPE[part.type];
	const rarity = canon(part.rarity);
	if (!slot || !rarity) throw new Error(`Not a rod part: ${part.name} (${part.type}, ${part.rarity})`);
	const eff = capRarity(rarity, playerLevel) || 'Common';
	const v = PARAMS.variants[part.name] || {};
	const S = PARAMS.slots[slot];
	const out = { slot, name: part.name, rarity, effectiveRarity: eff, level: PARAMS.partLevel[rarity], tier: PARAMS.tierOfRarity[rarity], variant: v.label || 'Balanced', stats: {} };
	if (slot === 'rod') out.meanFish = S.meanFish[eff] + (v.meanDelta || 0);
	if (slot === 'reel') out.stats = { fishingSpeed: S.fishingSpeed[eff] * (v.fishingSpeed ?? 1), trophyChance: S.trophyChance[eff] * (v.trophyChance ?? 1) };
	if (slot === 'hook') out.stats = { rareFind: S.rareFind[eff] * (v.rareFind ?? 1), luck: S.luck[eff] * (v.luck ?? 1) };
	if (slot === 'handle') out.stats = { sellBonus: S.sellBonus[eff] };
	// Durability is a property of the physical rod (nominal rarity), never level-capped.
	if (slot === 'rod') out.durabilityVariant = v.durability ?? 1;
	if (slot === 'handle') out.durabilityMult = S.durabilityMult[rarity];
	for (const k of Object.keys(out.stats)) out.stats[k] = round4(out.stats[k]);
	return out;
}

const bySlot = (parts) => {
	const list = Array.isArray(parts) ? parts : Object.values(parts);
	const out = {};
	for (const p of list) out[SLOT_OF_TYPE[p.type]] = p;
	for (const s of Object.keys(SLOTS)) if (!out[s]) throw new Error(`Missing ${s} part`);
	return out;
};

/** Balanced (variant-free) virtual part set of one rarity: per slot, the highest catalog rarity <= it. */
function matchedSet(rarity) {
	const set = {};
	for (const [slot, type] of Object.entries(SLOTS)) {
		const have = new Set(CATALOG.filter((p) => p.type === type).map((p) => canon(p.rarity)));
		let r = rarity;
		while (!have.has(r)) r = RARITY_ORDER[rank(r) - 1];
		set[slot] = { name: `${r} ${slot} (balanced)`, type, rarity: r };
	}
	return set;
}
const referenceSet = (t) => matchedSet(PARAMS.referenceRarity[t]);

/** Performance of a set (no durability): stats, mean fish, multi-catch chance, cooldown. */
function performance(parts, { playerLevel = Infinity } = {}) {
	const s = bySlot(parts);
	const prof = Object.fromEntries(Object.entries(s).map(([k, p]) => [k, partProfile(p, { playerLevel })]));
	const stats = { rareFind: 0, luck: 0, trophyChance: 0, sellBonus: 0, xpBonus: 0, fishingSpeed: 0, durabilityEfficiency: 0 };
	for (const p of Object.values(prof)) for (const [k, v] of Object.entries(p.stats)) stats[k] = round4(stats[k] + v);
	const meanFish = Math.min(PARAMS.multi.ceilingMean, Math.max(1, prof.rod.meanFish));
	const multiChance = meanFish > 1 ? F.chanceForMean(meanFish) : 0;
	const dist = F.fishDistribution(multiChance);
	const topRarity = RARITY_ORDER[Math.max(...Object.values(prof).map((p) => rank(p.rarity)))];
	return {
		parts: prof,
		tier: PARAMS.tierOfRarity[topRarity],
		level: PARAMS.partLevel[topRarity],
		qualities: [...PARAMS.craft.qualities],
		stats,
		meanFish,
		multiChance,
		jackpot3plus: dist.p3plus,
		jackpot5: dist.p5,
		cooldownMs: Math.max(F.COOLDOWN.minMs, Math.round(F.COOLDOWN.fishMs * (1 - stats.fishingSpeed))),
	};
}

const fishPerHour = (perf, overheadS = PARAMS.durability.designOverheadS) => (3600 / (perf.cooldownMs / 1000 + overheadS)) * perf.meanFish;

/** Durability base of a rod piece rarity: its matched set lasts lifeHours[rarity] at the design cadence. */
const baseDurabilityCache = new Map();
function baseDurability(rarity) {
	if (!baseDurabilityCache.has(rarity)) {
		const set = matchedSet(rarity);
		const perf = performance(set);
		const handleMult = PARAMS.slots.handle.durabilityMult[set.handle.rarity];
		baseDurabilityCache.set(rarity, (PARAMS.durability.lifeHours[rarity] * fishPerHour(perf)) / handleMult);
	}
	return baseDurabilityCache.get(rarity);
}

/** Repair cost by rod-piece rarity: upkeepShare of what the matched set's durability earns at home. */
const repairCache = new Map();
function repairCostFor(rarity) {
	if (!repairCache.has(rarity)) {
		const set = matchedSet(rarity);
		const perf = performance(set);
		const maxDurability = roundTo(baseDurability(rarity) * PARAMS.slots.handle.durabilityMult[set.handle.rarity], PARAMS.durability.roundTo);
		const o = F.castOutcome({ biome: homeBiome(PARAMS.tierOfRarity[rarity]), qualities: perf.qualities, stats: perf.stats, multiChance: perf.multiChance });
		repairCache.set(rarity, nicePrice(PARAMS.repair.upkeepShare * maxDurability * o.valuePerFish));
	}
	return repairCache.get(rarity);
}

/** The proposed crafted rod for a part set (catalog parts or matchedSet virtual parts). */
function craftRod(parts, { playerLevel = Infinity } = {}) {
	const perf = performance(parts, { playerLevel });
	const s = bySlot(parts);
	const rp = perf.parts.rod;
	const maxDurability = roundTo(baseDurability(rp.rarity) * perf.parts.handle.durabilityMult * rp.durabilityVariant, PARAMS.durability.roundTo);
	return {
		...perf,
		names: Object.values(s).map((p) => p.name),
		rarities: Object.fromEntries(Object.entries(s).map(([k, p]) => [k, canon(p.rarity)])),
		maxDurability,
		lifeHoursRegular: maxDurability / fishPerHour(perf, ARCHETYPES.regular.overheadS),
		repairCost: repairCostFor(rp.rarity),
		maxRepairs: PARAMS.repair.craftedMaxRepairs,
	};
}

/** The proposed starter rod: unbreakable, weak only, one fish per cast, no stats. */
function oldRod() {
	return {
		tier: 0, level: 0, qualities: [...PARAMS.oldRod.qualities], stats: {}, meanFish: PARAMS.oldRod.meanFish, multiChance: 0, jackpot3plus: 0, jackpot5: 0,
		cooldownMs: F.COOLDOWN.fishMs, maxDurability: null, unbreakable: PARAMS.oldRod.unbreakable, repairCost: 0, maxRepairs: null,
	};
}

const rodOutcome = (rod, biome, extra = {}) => F.castOutcome({ biome, qualities: rod.qualities, stats: rod.stats, multiChance: rod.multiChance, ...extra });
const rodHourly = (rod, biome, overheadS = 4) => F.hourly(rodOutcome(rod, biome), overheadS);
/** Repair cost / fish income earned by one durability life (cadence-independent: both are per fish). */
function upkeepShare(rod, biome) {
	if (!rod.maxDurability || !rod.repairCost) return 0;
	return rod.repairCost / (rod.maxDurability * rodOutcome(rod, biome).valuePerFish);
}

const ARCHETYPES = {
	casual: { minutesPerDay: 12.5, overheadS: 7 },
	regular: { minutesPerDay: 45, overheadS: 4 },
	active: { minutesPerDay: 120, overheadS: 3 },
	grinder: { minutesPerDay: 300, overheadS: 2 },
};

// ---------------------------------------------------------------------------------------------
// Today's rules (for Current -> Proposed and the legacy converter).
const NORMAL = { name: 'normal', ...PROFILES.normal };
/** Synchronous mirror of FishingRod.combineQualities (verifyLegacyParity() checks it against the class). */
function legacyCombine(list) {
	const combined = new Set();
	let numbers = 0;
	let counts = 0;
	let durability = 0;
	for (const part of list) {
		for (const q of part.qualities) {
			if (/^\d+$/.test(q)) numbers += parseInt(q, 10);
			else if (q.includes('count')) counts += parseInt(q.split(' ')[0], 10);
			else if (q.includes('durability')) durability += parseInt(q.split(' ')[0], 10);
			else combined.add(q);
		}
	}
	if (numbers > 0) combined.add(numbers.toString());
	if (counts > 0) combined.add(`${counts} count`);
	if (durability > 0) combined.add(`${durability} durability`);
	return Array.from(combined);
}
/** TODAY's crafted rod (FishingRod.generateStats + resolveModifiers for a normal player). */
function legacyCraft(parts) {
	const list = Object.values(bySlot(parts));
	const capabilities = legacyCombine(list);
	let durability = 0;
	let count = 0;
	for (const q of capabilities) {
		if (q.includes('durability')) durability = parseInt(q, 10);
		else if (q.includes('count')) count = parseInt(q, 10);
	}
	const m = resolveModifiers({ profile: NORMAL, rod: { name: 'x', type: 'customrod', capabilities }, rodParts: list.map((p) => ({ ...p })) });
	return { capabilities, level: count * 10, fishPerCast: m.draws * m.perDraw, durability, repairCost: count * 10000, cooldownMs: m.cooldownMs };
}
/** Async: every catalog combination's capabilities from the real FishingRod.combineQualities equal the mirror's. */
async function verifyLegacyParity() {
	const { FishingRod } = require('../../../src/class/FishingRod');
	let mismatches = 0;
	for (const c of evaluateAllCombos()) {
		const list = c.names.map((n) => CATALOG.find((p) => p.name === n));
		const real = await FishingRod.prototype.combineQualities.call(null, list);
		if (JSON.stringify(real) !== JSON.stringify(legacyCombine(list))) mismatches++;
	}
	return { combos: evaluateAllCombos().length, mismatches };
}

/** What a stored crafted rod's capabilities still say about it (the legacy fingerprint). */
function legacySignature(capabilities = []) {
	const num = capabilities.find((c) => /^\d+$/.test(c)) || '0';
	const count = (capabilities.find((c) => /^\d+\s*count$/i.test(c)) || '0').split(' ')[0];
	const dur = (capabilities.find((c) => /durability$/i.test(c)) || '0').split(' ')[0];
	return `n${num}|c${count}|d${dur}|${capabilities.includes('quick') ? 'q' : '-'}|${capabilities.includes('strong') ? 's' : '-'}`;
}

let combosCache = null;
/** All 2,450 catalog combinations: today's craft and the proposed craft (at the rod's own level). */
function evaluateAllCombos() {
	if (combosCache) return combosCache;
	const byType = (t) => CATALOG.filter((p) => p.type === t);
	const rows = [];
	for (const rod of byType('part_rod')) {
		for (const reel of byType('part_reel')) {
			for (const hook of byType('part_hook')) {
				for (const handle of byType('part_handle')) {
					const set = { rod, reel, hook, handle };
					const legacy = legacyCraft(set);
					const p = craftRod(set);
					const biome = homeBiome(p.tier);
					const o = rodOutcome(p, biome);
					const h = F.hourly(o, ARCHETYPES.regular.overheadS);
					rows.push({
						names: p.names, rarities: p.rarities, variants: Object.fromEntries(Object.entries(p.parts).map(([k, x]) => [k, x.variant])),
						legacy: { level: legacy.level, fishPerCast: legacy.fishPerCast, durability: legacy.durability, repairCost: legacy.repairCost, signature: legacySignature(legacy.capabilities) },
						tier: p.tier, level: p.level, meanFish: p.meanFish, jackpot3plus: p.jackpot3plus, stats: p.stats, cooldownMs: p.cooldownMs,
						maxDurability: p.maxDurability, lifeHoursRegular: p.lifeHoursRegular, repairCost: p.repairCost,
						homeBiome: biome, xpPerHour: h.xp, cashPerHour: h.cash, valuePerFish: o.valuePerFish, upkeepShare: upkeepShare(p, biome),
						oceanCashPerHour: rodHourly(p, 'Ocean').cash,
					});
				}
			}
		}
	}
	combosCache = rows;
	return rows;
}

let legacyIndex = null;
function legacyIndexMap() {
	if (legacyIndex) return legacyIndex;
	legacyIndex = new Map();
	for (const r of evaluateAllCombos()) {
		const cur = legacyIndex.get(r.legacy.signature);
		// Conservative: the weakest catalog combination consistent with what is stored.
		if (!cur || r.tier < cur.tier || (r.tier === cur.tier && r.oceanCashPerHour < cur.oceanCashPerHour)) legacyIndex.set(r.legacy.signature, r);
	}
	return legacyIndex;
}

/**
 * Converter for an EXISTING crafted rod (read-only; nothing is rewritten).
 * A: all four part documents resolve (always, in practice: crafting only decrements part counts) ->
 *    the proposed rules on those parts.
 * B: a part is missing -> the weakest catalog combination with the same legacy fingerprint
 *    (bare-number sum, 'N count', durability, quick, strong).
 * C: unknown fingerprint (admin/custom data) -> a matched Common set.
 * Durability is grandfathered: effective max = max(stored maxDurability, proposed). Repairs are
 * unlimited and priced by the proposed rules; a legacy 'destroyed' crafted rod counts as 'broken'.
 */
function convertLegacyRod(stored, partDocs = null) {
	let method = 'parts';
	let rod;
	if (partDocs && Object.values(partDocs).filter(Boolean).length === 4) rod = craftRod(partDocs, { playerLevel: stored.playerLevel ?? Infinity });
	else {
		const hit = legacyIndexMap().get(legacySignature(stored.capabilities || []));
		if (hit) {
			method = 'signature';
			const find = (n) => CATALOG.find((p) => p.name === n);
			rod = craftRod(hit.names.map(find), { playerLevel: stored.playerLevel ?? Infinity });
		}
		else {
			method = 'default';
			rod = craftRod(matchedSet('Common'), { playerLevel: stored.playerLevel ?? Infinity });
		}
	}
	const max = Math.max(Number(stored.maxDurability) || 0, rod.maxDurability);
	return {
		method,
		rod,
		durability: { max, remaining: Math.min(max, Number(stored.durability) || 0) },
		state: stored.state === 'destroyed' ? 'broken' : stored.state || 'mint',
		repairCost: rod.repairCost,
		maxRepairs: PARAMS.repair.craftedMaxRepairs,
	};
}

// ---------------------------------------------------------------------------------------------
// Crates (Gacha V2): pools, featured slot balancing, per-slot odds, expected crates to assemble.
const lower = (r) => String(r).toLowerCase();
const PART_POOLS = Object.fromEntries(RARITIES.map((r) => [r, CATALOG.filter((p) => lower(p.rarity) === r)]));

/** Featured groups that give each slot type an equal share within every rarity (V2 `featured`). */
function slotBalanceFeatured() {
	const weights = new Map();
	for (const r of RARITIES) {
		const pool = PART_POOLS[r];
		if (!pool.length) continue;
		const counts = {};
		for (const p of pool) counts[p.type] = (counts[p.type] || 0) + 1;
		const lcm = Object.values(counts).reduce((a, b) => (a * b) / gcd(a, b), 1);
		for (const p of pool) weights.set(p.name, lcm / counts[p.type]);
	}
	const groups = new Map();
	for (const [name, w] of weights) if (w !== 1) groups.set(w, [...(groups.get(w) || []), name]);
	return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([weight, names]) => ({ names, weight }));
}
function gcd(a, b) {
	return b ? gcd(b, a % b) : a;
}

const priceCache = new Map();
/** Proposed Gacha V2 definition for a tier crate (price attached separately; see cratePrice). */
function crateDefinition(t) {
	const c = PARAMS.crates.tiers[t];
	return {
		id: c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
		name: c.name,
		slots: PARAMS.crates.slots,
		strategy: PARAMS.crates.strategy,
		pool: { types: Object.values(SLOTS), fish: false, exclude: [], featured: PARAMS.crates.balanceSlots ? slotBalanceFeatured() : [] },
		rarityTable: Object.fromEntries(RARITIES.map((r) => [r, c.rarityTable[r] || 0])),
		rarityFloor: c.rarityFloor,
		guaranteedSlots: c.guaranteed ? [{ slot: 0, minRarity: c.guaranteed }] : [],
		duplicates: PARAMS.crates.duplicates,
		pity: c.pity || null,
		shop: { unlockLevel: c.unlockLevel, existingItem: Boolean(c.existing) },
	};
}

/** Share of each slot type among parts of rarity r under the definition's featured weights. */
function slotShares(def, r) {
	const pool = PART_POOLS[r];
	const w = (name) => (def.pool.featured || []).filter((f) => f.names.includes(name)).reduce((a, f) => a * f.weight, 1);
	const total = pool.reduce((s, p) => s + w(p.name), 0);
	const out = Object.fromEntries(Object.keys(SLOTS).map((s) => [s, 0]));
	for (const p of pool) out[SLOT_OF_TYPE[p.type]] += w(p.name) / total;
	return out;
}

/** Per crate slot i: the rarity table the engine rolls (base, floor, guaranteed-slot mask), and pity. */
function slotTables(def, pityCounter = null) {
	let table = baseTable(def, PART_POOLS);
	let guarantee = null;
	if (def.pity && pityCounter !== null) {
		const cfg = Object.fromEntries(Object.entries(def.pity).map(([k, rule]) => [k, { ...rule }]));
		const counters = Object.fromEntries(Object.values(cfg).map((rule) => [rule.counter, pityCounter]));
		const p = applyPity(table, counters, cfg);
		table = p.table;
		guarantee = p.guarantee;
	}
	return Array.from({ length: def.slots }, (_, i) => {
		let t = table;
		const g = def.guaranteedSlots.find((x) => x.slot === i);
		if (g) {
			const masked = Object.fromEntries(RARITIES.map((r) => [r, RARITIES.indexOf(r) >= RARITIES.indexOf(g.minRarity) ? t[r] : 0]));
			if (RARITIES.some((r) => masked[r] > 0)) t = normalize(masked);
		}
		if (i === 0 && guarantee) {
			const tiers = guarantee.filter((r) => t[r] > 0);
			if (tiers.length) t = normalize(Object.fromEntries(RARITIES.map((r) => [r, tiers.includes(r) ? t[r] : 0])));
		}
		return t;
	});
}

/** P(crate slot yields a part of `slot` with rarity >= need), per crate slot. */
function categoryProb(tables, def, slot, need) {
	return tables.map((t) => RARITIES.filter((r) => RARITIES.indexOf(r) >= RARITIES.indexOf(lower(need)) && PART_POOLS[r].length).reduce((s, r) => s + t[r] * slotShares(def, r)[slot], 0));
}

function crateSlotOdds(t) {
	const def = crateDefinition(t);
	const tables = slotTables(def, def.pity ? 0 : null);
	return tables.map((tab, i) => ({
		slot: i,
		rarity: Object.fromEntries(RARITIES.filter((r) => tab[r] > 0).map((r) => [r, round4(tab[r])])),
		bySlotType: Object.fromEntries(Object.keys(SLOTS).map((s) => [s, round4(RARITIES.reduce((a, r) => a + (PART_POOLS[r].length ? tab[r] * slotShares(def, r)[s] : 0), 0))])),
	}));
}

/** Slots (and the rarity each needs) to go from tier t-1's set to tier t's set. */
function neededSlots(t) {
	const cur = referenceSet(t);
	const prev = t > 1 ? referenceSet(t - 1) : null;
	return Object.keys(SLOTS).filter((s) => !prev || prev[s].rarity !== cur[s].rarity).map((s) => ({ slot: s, rarity: cur[s].rarity }));
}

/**
 * Crates-until-complete distribution. Without pity: exact coupon collector with unequal, slot-dependent
 * probabilities (inclusion-exclusion; slots treated as independent, so 'unique' only makes it slightly
 * better). With pity (single needed slot): exact Markov chain over the box's pity counter.
 */
function cratesDistribution(t, maxN = 2000) {
	const def = crateDefinition(t);
	const need = neededSlots(t);
	const survival = [];
	if (def.pity) {
		if (need.length !== 1) throw new Error('pity crates are modelled for a single needed slot');
		let alive = 1;
		for (let n = 0; n < maxN; n++) {
			survival.push(alive);
			const tables = slotTables(def, n); // survival = no hit yet, so the box counter equals n
			const probs = categoryProb(tables, def, need[0].slot, need[0].rarity);
			alive *= probs.reduce((a, p) => a * (1 - p), 1);
			if (alive < 1e-12) break;
		}
	}
	else {
		const tables = slotTables(def);
		const cats = need.map((x) => categoryProb(tables, def, x.slot, x.rarity));
		const subsets = [];
		for (let mask = 1; mask < 1 << cats.length; mask++) {
			const members = cats.filter((_, i) => mask & (1 << i));
			// q = P(one crate yields none of the subset's categories); slots independent.
			const q = tables.map((_, slot) => 1 - members.reduce((s, c) => s + c[slot], 0)).reduce((a, b) => a * b, 1);
			subsets.push({ sign: members.length % 2 ? 1 : -1, q });
		}
		for (let n = 0; n < maxN; n++) {
			const alive = subsets.reduce((s, x) => s + x.sign * x.q ** n, 0);
			survival.push(alive);
			if (alive < 1e-12) break;
		}
	}
	const expected = survival.reduce((a, b) => a + b, 0);
	const quantile = (p) => survival.findIndex((s) => 1 - s >= p);
	return { expected, median: quantile(0.5), p90: quantile(0.9), need };
}

/** Hourly income of the stage leading up to tier t (previous tier's set in the biome unlocked 10 levels earlier). */
function stageIncome(t) {
	const prev = t === 1 ? oldRod() : craftRod(referenceSet(t - 1));
	return rodHourly(prev, stageBiome(t), PARAMS.durability.designOverheadS).cash;
}

/** Crate price: assemblyHours x stage income / expected crates to assemble. */
function cratePrice(t) {
	if (!priceCache.has(t)) priceCache.set(t, nicePrice((PARAMS.assemblyHours[t] * stageIncome(t)) / cratesDistribution(t).expected));
	return priceCache.get(t);
}

function crateDefinitions() {
	return TIERS.map((t) => ({ tier: t, ...crateDefinition(t), price: cratePrice(t), priceFormula: `assemblyHours[${t}] (${PARAMS.assemblyHours[t]} h) x stage income / expected crates` }));
}

/** Cash for salvaging one part of `rarity` (share of one slot of the crate that guarantees that rarity). */
function salvageValue(rarity) {
	const r = canon(rarity);
	if (r === 'Common') return nicePrice(PARAMS.salvage.commonOfUncommon * salvageValue('Uncommon'));
	// The crate of the tier whose reference rarity this is (Uncommon->T1 ... Legendary->T4, Lucky->T5).
	const t = TIERS.find((x) => PARAMS.referenceRarity[x] === r);
	return nicePrice((PARAMS.salvage.share * cratePrice(t)) / PARAMS.crates.slots);
}

/** Expected salvage value of everything in one crate, as a share of its price (must stay well below 1). */
function crateSalvageRatio(t) {
	const def = crateDefinition(t);
	const tables = slotTables(def, def.pity ? 0 : null);
	const v = tables.reduce((s, tab) => s + RARITIES.reduce((a, r) => a + (PART_POOLS[r].length ? tab[r] * salvageValue(r) : 0), 0), 0);
	return v / cratePrice(t);
}

function assembly(t) {
	const d = cratesDistribution(t);
	const price = cratePrice(t);
	const income = stageIncome(t);
	const def = crateDefinition(t);
	const tables = slotTables(def, def.pity ? 0 : null);
	const partsPerCrate = Object.fromEntries(RARITIES.filter((r) => PART_POOLS[r].length).map((r) => [r, tables.reduce((s, tab) => s + tab[r], 0)]));
	const totalParts = d.expected * def.slots;
	// Leftovers: everything opened minus the parts the set uses (Wald: E[parts] = E[crates] x per crate).
	const salvageAll = RARITIES.reduce((s, r) => s + (partsPerCrate[r] || 0) * d.expected * (PART_POOLS[r].length ? salvageValue(r) : 0), 0);
	const salvageUsed = d.need.reduce((s, x) => s + salvageValue(x.rarity), 0);
	const cost = d.expected * price;
	return {
		tier: t,
		crate: def.name,
		price,
		stageBiome: stageBiome(t),
		stageIncomePerHour: income,
		needs: d.need.map((x) => `${x.rarity} ${x.slot}`),
		expectedCrates: d.expected,
		medianCrates: d.median,
		p90Crates: d.p90,
		expectedCost: cost,
		p90Cost: d.p90 * price,
		hoursOfStageIncome: cost / income,
		p90HoursOfStageIncome: (d.p90 * price) / income,
		expectedParts: totalParts,
		leftoverParts: totalParts - d.need.length,
		salvageRefund: salvageAll - salvageUsed,
		netCostAfterSalvage: cost - (salvageAll - salvageUsed),
		salvageReturnPerCrate: crateSalvageRatio(t),
	};
}

// ---------------------------------------------------------------------------------------------
// Integrator-facing gear path and a lifecycle check against the approved XP-curve targets.
function gearPath() {
	const steps = [{ ...oldRod(), label: 'Old Rod', crateUnlockLevel: 0, homeBiome: 'Ocean', assembly: null, upkeepShareHome: 0, lifeHoursRegular: null }];
	for (const t of TIERS) {
		const rod = craftRod(referenceSet(t));
		const a = assembly(t);
		steps.push({
			tier: t,
			label: `Tier ${t} (${PARAMS.referenceRarity[t]} set)`,
			level: rod.level,
			crateUnlockLevel: PARAMS.crates.tiers[t].unlockLevel,
			homeBiome: homeBiome(t),
			qualities: rod.qualities,
			stats: rod.stats,
			multiChance: rod.multiChance,
			meanFish: rod.meanFish,
			jackpot3plus: rod.jackpot3plus,
			jackpot5: rod.jackpot5,
			cooldownMs: rod.cooldownMs,
			maxDurability: rod.maxDurability,
			lifeHoursRegular: rod.lifeHoursRegular,
			repairCost: rod.repairCost,
			maxRepairs: rod.maxRepairs,
			upkeepShareHome: upkeepShare(rod, homeBiome(t)),
			assembly: { crate: a.crate, price: a.price, expectedCrates: a.expectedCrates, p90Crates: a.p90Crates, expectedCost: a.expectedCost, hoursOfStageIncome: a.hoursOfStageIncome },
		});
	}
	return steps;
}

const DAILY_XP_PER_LEVEL = 60; // same assumption as curve.js (level-scaled daily quest)
const TARGETS = { 20: [5, 6], 30: [12, 15], 40: [24, 30], 50: [40, 45] };

/**
 * Hours of play to each level on this gear path. Crates for tier t are bought from Lv (crate unlock)
 * with net income (fish income - repairs - otherSpendShare x income); the rod is equipped once the
 * expected assembly cost is paid AND the player reaches the tier's level. Same XP model as curve.js.
 */
function lifecycle(arch, { otherSpendShare = 0, maxLevel = 60, steps = gearPath(), stepH = 1 / 60 } = {}) {
	const a = typeof arch === 'string' ? ARCHETYPES[arch] : arch;
	const cache = new Map();
	const rates = (step, biome) => {
		const key = `${step.tier}|${biome}`;
		if (!cache.has(key)) {
			const h = rodHourly(step, biome, a.overheadS);
			const upkeep = step.maxDurability ? (step.repairCost / step.maxDurability) * h.fish : 0;
			cache.set(key, { ...h, upkeep });
		}
		return cache.get(key);
	};
	let xp = 0;
	let h = 0;
	let money = 0;
	let idx = 0;
	let progress = 0;
	const dayH = a.minutesPerDay / 60;
	const reached = {};
	const upgrades = {};
	const totals = { gross: 0, repairs: 0, crates: 0 };
	while (h < 5000) {
		const L = F.levelForXp(xp);
		const cur = steps[idx];
		const r = rates(cur, biomeForLevel(L));
		totals.gross += r.cash * stepH;
		totals.repairs += r.upkeep * stepH;
		money += (r.cash * (1 - otherSpendShare) - r.upkeep) * stepH;
		const next = steps[idx + 1];
		if (next && L >= next.crateUnlockLevel) {
			const spend = Math.max(0, Math.min(money, next.assembly.expectedCost - progress));
			progress += spend;
			money -= spend;
			totals.crates += spend;
			if (progress >= next.assembly.expectedCost - 1e-6 && L >= next.level) {
				idx++;
				progress = 0;
				upgrades[next.tier] = { hours: +h.toFixed(2), level: L, day: Math.ceil(h / dayH) };
			}
		}
		const before = h;
		xp += r.xp * stepH;
		h += stepH;
		if (Math.floor(h / dayH) !== Math.floor(before / dayH)) xp += DAILY_XP_PER_LEVEL * L;
		const L2 = F.levelForXp(xp);
		for (const T of [10, 20, 30, 40, 50, 60]) if (T <= maxLevel && !reached[T] && L2 >= T) reached[T] = { hours: +h.toFixed(2), day: Math.ceil(h / dayH) };
		// Stop at maxLevel once every tier usable by then has been bought.
		if (L2 >= maxLevel && !steps.slice(idx + 1).some((s) => s.level <= maxLevel)) break;
	}
	return { reached, upgrades, totals: { ...totals, repairShare: totals.repairs / totals.gross, crateShare: totals.crates / totals.gross }, hours: +h.toFixed(2) };
}

const inTarget = (reached) => Object.fromEntries(Object.entries(TARGETS).map(([L, [lo, hi]]) => [L, { hours: reached[L]?.hours ?? null, target: `${lo}-${hi}h`, ok: reached[L] ? reached[L].hours >= lo && reached[L].hours <= hi : false }]));

// ---------------------------------------------------------------------------------------------
const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const r0 = (x) => Math.round(x);
const quant = (arr, q) => {
	const s = [...arr].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
};
const spread = (arr) => ({ min: Math.min(...arr), median: quant(arr, 0.5), max: Math.max(...arr) });

function buildReport() {
	const combos = evaluateAllCombos();
	const path = gearPath();

	// Slot families at each rarity (balanced variants), as a table.
	const slotTable = RARITY_ORDER.map((r) => {
		const set = matchedSet(r);
		const prof = Object.fromEntries(Object.entries(set).map(([k, p]) => [k, partProfile(p)]));
		return {
			rarity: r, level: PARAMS.partLevel[r], tier: PARAMS.tierOfRarity[r],
			rod: { meanFish: PARAMS.slots.rod.meanFish[r], baseDurability: r0(baseDurability(r)), repairCost: repairCostFor(r), multiChance: round4(F.chanceForMean(PARAMS.slots.rod.meanFish[r])) },
			reel: { fishingSpeed: PARAMS.slots.reel.fishingSpeed[r], trophyChance: PARAMS.slots.reel.trophyChance[r] },
			hook: { rareFind: PARAMS.slots.hook.rareFind[r], luck: PARAMS.slots.hook.luck[r] },
			handle: { durabilityMult: PARAMS.slots.handle.durabilityMult[r], sellBonus: PARAMS.slots.handle.sellBonus[r] },
			matchedSetUses: Object.fromEntries(Object.entries(prof).map(([k, p]) => [k, p.rarity])),
		};
	});

	// Per-tier rates for every modelled biome (reference sets) + Old Rod.
	const rates = path.map((s) => ({
		tier: s.tier, label: s.label,
		byBiome: Object.fromEntries(MODELLED_BIOMES.map((b) => {
			const o = rodOutcome(s, b);
			const hr = F.hourly(o, 4);
			return [b, { fishPerCast: round4(o.fishPerCast), valuePerFish: r0(o.valuePerFish), xpPerHour: r0(hr.xp), cashPerHour: r0(hr.cash), upkeepShare: round4(upkeepShare(s, b)) }];
		})),
	}));

	// All combos.
	const hist = {};
	for (const c of combos) hist[c.meanFish.toFixed(2)] = (hist[c.meanFish.toFixed(2)] || 0) + 1;
	const legacyHist = {};
	for (const c of combos) legacyHist[c.legacy.fishPerCast] = (legacyHist[c.legacy.fishPerCast] || 0) + 1;
	const ceiling = combos.filter((c) => c.meanFish >= PARAMS.multi.ceilingMean - 1e-9).length;
	const perTier = {};
	for (const t of TIERS) {
		const rows = combos.filter((c) => c.tier === t);
		const ref = path[t];
		const refH = rodHourly(ref, homeBiome(t));
		perTier[t] = {
			combos: rows.length,
			level: tierLevel(t),
			homeBiome: homeBiome(t),
			meanFish: spread(rows.map((c) => c.meanFish)),
			jackpot3plus: spread(rows.map((c) => round4(c.jackpot3plus))),
			rareFind: spread(rows.map((c) => c.stats.rareFind)),
			luck: spread(rows.map((c) => c.stats.luck)),
			trophyChance: spread(rows.map((c) => c.stats.trophyChance)),
			fishingSpeed: spread(rows.map((c) => c.stats.fishingSpeed)),
			sellBonus: spread(rows.map((c) => c.stats.sellBonus)),
			lifeHoursRegular: spread(rows.map((c) => +c.lifeHoursRegular.toFixed(2))),
			xpPerHour: spread(rows.map((c) => r0(c.xpPerHour))),
			cashPerHour: spread(rows.map((c) => r0(c.cashPerHour))),
			cashVsReference: spread(rows.map((c) => round4(c.cashPerHour / refH.cash))),
			xpVsReference: spread(rows.map((c) => round4(c.xpPerHour / refH.xp))),
			upkeepShareHome: spread(rows.map((c) => round4(c.upkeepShare))),
			legacyLevel: spread(rows.map((c) => c.legacy.level)),
			legacyFishPerCast: spread(rows.map((c) => c.legacy.fishPerCast)),
		};
	}
	// Level bypass check: best rod usable at each level, today vs proposed (fish per cast).
	const bestAtLevel = Object.fromEntries([20, 30, 40, 50, 60].map((L) => [L, {
		todayFishPerCast: Math.max(...combos.filter((c) => c.legacy.level <= L).map((c) => c.legacy.fishPerCast)),
		proposedMeanFish: Math.max(...combos.filter((c) => c.level <= L).map((c) => c.meanFish)),
		proposedBestCashPerHour: r0(Math.max(...combos.filter((c) => c.level <= L).map((c) => rodHourly(craftRod(c.names.map((n) => CATALOG.find((p) => p.name === n))), biomeForLevel(L)).cash))),
	}]));

	// Specialties: variants of the same slot at the same rarity, in the home biome (reference set otherwise).
	const specialties = [];
	for (const name of Object.keys(PARAMS.variants)) {
		const part = CATALOG.find((p) => p.name === name);
		const slot = SLOT_OF_TYPE[part.type];
		const t = PARAMS.tierOfRarity[canon(part.rarity)];
		const set = { ...matchedSet(canon(part.rarity)), [slot]: part };
		const rod = craftRod(set);
		const base = craftRod(matchedSet(canon(part.rarity)));
		const hv = rodHourly(rod, homeBiome(t));
		const hb = rodHourly(base, homeBiome(t));
		specialties.push({ part: name, rarity: part.rarity, slot, variant: PARAMS.variants[name].label, xpVsBalanced: round4(hv.xp / hb.xp), cashVsBalanced: round4(hv.cash / hb.cash), lifeVsBalanced: round4(rod.maxDurability / base.maxDurability) });
	}

	// Legacy converter calibration.
	const idx = legacyIndexMap();
	const sigGroups = new Map();
	for (const c of combos) sigGroups.set(c.legacy.signature, [...(sigGroups.get(c.legacy.signature) || []), c]);
	let exactTier = 0;
	let underTier = 0;
	for (const c of combos) {
		const pick = idx.get(c.legacy.signature);
		if (pick.tier === c.tier) exactTier++;
		else if (pick.tier < c.tier) underTier++;
	}
	const sampleLegacy = convertLegacyRod({ capabilities: ['weak', 'strong', 'quick', '9', '5 count', '10500 durability'], durability: 4200, maxDurability: 10500, state: 'destroyed' });

	// Crates.
	const crates = crateDefinitions().map((d) => ({ ...d, slotOdds: crateSlotOdds(d.tier) }));
	const assemblies = TIERS.map(assembly);
	const entryT1 = (() => {
		// Budget T1: any Common+ part in every slot from Fishing Crates.
		const def = crateDefinition(1);
		const tables = slotTables(def);
		const cats = Object.keys(SLOTS).map((s) => categoryProb(tables, def, s, 'Common'));
		let e = 0;
		for (let mask = 1; mask < 16; mask++) {
			const members = cats.filter((_, i) => mask & (1 << i));
			const q = tables.map((_, slot) => 1 - members.reduce((s, c) => s + c[slot], 0)).reduce((a, b) => a * b, 1);
			e += (members.length % 2 ? 1 : -1) / (1 - q);
		}
		const rod = craftRod(matchedSet('Common'));
		return { expectedCrates: e, expectedCost: e * cratePrice(1), hoursOfStageIncome: (e * cratePrice(1)) / stageIncome(1), meanFish: rod.meanFish, cashPerHourLake: r0(rodHourly(rod, 'Lake').cash) };
	})();
	const salvage = Object.fromEntries(RARITY_ORDER.map((r) => [r, salvageValue(r)]));

	// Lifecycle check (regular, and every archetype), rods-only and with 30% of income spent elsewhere.
	const life = Object.fromEntries(Object.keys(ARCHETYPES).map((k) => [k, lifecycle(k)]));
	const lifeOther = lifecycle('regular', { otherSpendShare: 0.3 });
	const stageHours = TIERS.map((t) => {
		const reg = life.regular.reached;
		const from = reg[tierLevel(t) - 10]?.hours ?? null;
		const to = reg[tierLevel(t)]?.hours ?? null;
		return { tier: t, stage: `Lv ${tierLevel(t) - 10}-${tierLevel(t)}`, hours: from === null || to === null ? null : +(to - from).toFixed(2) };
	});
	const stageShare = assemblies.map((a, i) => ({ tier: a.tier, assemblyShareOfStageIncome: stageHours[i].hours ? round4(a.hoursOfStageIncome / stageHours[i].hours) : null }));

	return {
		frameworkVersion: F.FRAMEWORK_VERSION,
		params: PARAMS.id,
		curve: { ...F.CURVE },
		slotFamilies: Object.fromEntries(Object.entries(PARAMS.slots).map(([k, v]) => [k, v.family])),
		slotTable,
		gearPath: path.map((s) => ({
			tier: s.tier, label: s.label, level: s.level, crateUnlockLevel: s.crateUnlockLevel, homeBiome: s.homeBiome, qualities: s.qualities, stats: s.stats,
			meanFish: s.meanFish, multiChance: round4(s.multiChance), jackpot3plus: round4(s.jackpot3plus), jackpot5: round4(s.jackpot5), cooldownMs: s.cooldownMs,
			maxDurability: s.maxDurability, lifeHoursRegular: s.lifeHoursRegular && +s.lifeHoursRegular.toFixed(2), repairCost: s.repairCost, upkeepShareHome: round4(s.upkeepShareHome),
			assembly: s.assembly && { ...s.assembly, expectedCrates: +s.assembly.expectedCrates.toFixed(2), expectedCost: r0(s.assembly.expectedCost), hoursOfStageIncome: +s.assembly.hoursOfStageIncome.toFixed(2) },
		})),
		rates,
		combos: {
			total: combos.length,
			meanFishHistogram: hist,
			atCeiling: { count: ceiling, share: round4(ceiling / combos.length), ceilingMean: PARAMS.multi.ceilingMean },
			today: { fishPerCastHistogram: legacyHist, atCap15: { count: combos.filter((c) => c.legacy.fishPerCast >= 15).length, share: round4(combos.filter((c) => c.legacy.fishPerCast >= 15).length / combos.length) } },
			perTier,
			bestAtLevel,
		},
		specialties,
		upkeep: {
			rule: `repairCost(rod-piece rarity) = ${PARAMS.repair.upkeepShare} x matched-set maxDurability x its $/fish at home; unlimited repairs`,
			byTierHome: path.slice(1).map((s) => ({ tier: s.tier, repairCost: s.repairCost, maxDurability: s.maxDurability, lifeHoursRegular: +s.lifeHoursRegular.toFixed(2), shareHome: round4(s.upkeepShareHome), repairCostInMinutesOfHomeIncome: +((s.repairCost / rodHourly(s, s.homeBiome).cash) * 60).toFixed(1) })),
			oldRod: 'unbreakable: no upkeep, no replacement, no soft-lock',
		},
		crates: crates.map((c) => ({ tier: c.tier, name: c.name, price: c.price, unlockLevel: c.shop.unlockLevel, existingItem: c.shop.existingItem, rarityTable: c.rarityTable, rarityFloor: c.rarityFloor, guaranteedSlots: c.guaranteedSlots, duplicates: c.duplicates, pity: c.pity, featured: c.pool.featured, slotOdds: c.slotOdds })),
		assembly: assemblies.map((a) => ({ ...a, expectedCrates: +a.expectedCrates.toFixed(2), expectedCost: r0(a.expectedCost), p90Cost: r0(a.p90Cost), stageIncomePerHour: r0(a.stageIncomePerHour), hoursOfStageIncome: +a.hoursOfStageIncome.toFixed(2), p90HoursOfStageIncome: +a.p90HoursOfStageIncome.toFixed(2), expectedParts: +a.expectedParts.toFixed(1), leftoverParts: +a.leftoverParts.toFixed(1), salvageRefund: r0(a.salvageRefund), netCostAfterSalvage: r0(a.netCostAfterSalvage), salvageReturnPerCrate: round4(a.salvageReturnPerCrate) })),
		assemblyShareOfStage: stageShare,
		entryT1,
		salvage,
		legacyConverter: {
			signatures: sigGroups.size,
			uniqueSignatures: [...sigGroups.values()].filter((g) => g.length === 1).length,
			signatureTierExact: round4(exactTier / combos.length),
			signatureTierUnder: round4(underTier / combos.length),
			signatureTierOver: 0,
			sample: { input: '["weak","strong","quick","9","5 count","10500 durability"], durability 4200/10500, destroyed, parts missing', method: sampleLegacy.method, tier: sampleLegacy.rod.tier, meanFish: sampleLegacy.rod.meanFish, durability: sampleLegacy.durability, state: sampleLegacy.state, repairCost: sampleLegacy.repairCost },
		},
		lifecycle: {
			method: 'curve.js XP model (daily 60 x level XP); this gear path; crates bought from net income from the crate unlock level; rod equipped when paid for and at its level',
			regular: { ...life.regular, targets: inTarget(life.regular.reached) },
			regularWith30pctOtherSpend: { reached: lifeOther.reached, upgrades: lifeOther.upgrades, targets: inTarget(lifeOther.reached) },
			archetypes: Object.fromEntries(Object.entries(life).map(([k, v]) => [k, { reached: v.reached, upgrades: v.upgrades, repairShare: round4(v.totals.repairShare), crateShare: round4(v.totals.crateShare) }])),
			stageHoursRegular: stageHours,
		},
	};
}

let reportCache = null;
/** Every key number, computed from framework.js (synchronous; cached per process). */
function report() {
	if (!reportCache) reportCache = buildReport();
	return reportCache;
}

module.exports = {
	PARAMS, RARITY_ORDER, SLOTS, CATALOG, ARCHETYPES, TARGETS,
	tierLevel, homeBiome, stageBiome, capRarity, partProfile, matchedSet, referenceSet, performance, craftRod, oldRod,
	rodOutcome, rodHourly, upkeepShare, baseDurability, repairCostFor,
	legacyCombine, legacyCraft, verifyLegacyParity, legacySignature, convertLegacyRod, evaluateAllCombos,
	crateDefinition, crateDefinitions, crateSlotOdds, cratesDistribution, cratePrice, stageIncome, assembly, salvageValue, slotBalanceFeatured,
	gearPath, lifecycle, report,
};

if (require.main === module) {
	process.stdout.write(JSON.stringify(report(), null, 1));
}
