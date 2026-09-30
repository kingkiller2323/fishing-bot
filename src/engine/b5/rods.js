// Rods under the 5B rules (step C.2): the unbreakable Old Rod, the standard shop ladder, crafted rods from
// the Rod Workshop's slot families, the L6B level gate and the read-time converter for existing crafted
// rods. Pure except resolveRod (reads part documents). Numbers come from the generated 5B data only.
//
// Existing crafted rods are never rewritten (P-RODS-LEGACY-RODS): their parts resolve (path A), else the
// legacy fingerprint picks the weakest catalog combination with it (path B), else a matched Common set
// (path C). Durability is grandfathered: effective max = max(stored maxDurability, rule). Repairs are
// unlimited; a legacy 'destroyed' crafted rod counts as broken. Parts always work at full strength.
const mongoose = require('mongoose');
const { need5b } = require('../balance');
const { chanceForMean } = require('./multicatch');

const PART_RARITIES = ['Common', 'Uncommon', 'Rare', 'Ultra', 'Legendary', 'Lucky'];
const SLOT_OF_TYPE = { part_rod: 'rod', part_reel: 'reel', part_hook: 'hook', part_handle: 'handle' };
const TYPE_OF_SLOT = Object.fromEntries(Object.entries(SLOT_OF_TYPE).map(([t, s]) => [s, t]));
const SLOT_KEYS = ['rod', 'reel', 'hook', 'handle'];
const STAT_KEYS = ['rareFind', 'luck', 'trophyChance', 'fishingSpeed', 'sellBonus'];

const canon = (r) => PART_RARITIES.find((x) => x.toLowerCase() === String(r).toLowerCase()) || null;
const round4 = (x) => Number(x.toFixed(4));
const roundTo = (x, step) => Math.round(x / step) * step;
const R = () => need5b().rods;

const isOldRod = (rod) => rod?.type === 'rod' && rod?.name === R().oldRod.name;
const standardRow = (name) => R().standard.find((s) => s.name === name) || null;
const isStandardRod = (rod) => rod?.type === 'rod' && Boolean(standardRow(rod?.name));
const isCraftedRod = (rod) => rod?.type === 'customrod';

/** Parts keyed by slot (throws if a slot is missing or a part is not a rod part). */
function bySlot(parts) {
	const list = Array.isArray(parts) ? parts : Object.values(parts || {});
	const out = {};
	for (const p of list.filter(Boolean)) {
		const slot = SLOT_OF_TYPE[p.type];
		if (!slot || !canon(p.rarity)) throw new Error(`Not a rod part: ${p.name} (${p.type}, ${p.rarity})`);
		out[slot] = p;
	}
	for (const s of SLOT_KEYS) if (!out[s]) throw new Error(`Missing ${s} part`);
	return out;
}

/** One part's contribution (full strength; the model's partProfile). */
function partProfile(part) {
	const C = R().custom;
	const slot = SLOT_OF_TYPE[part.type];
	const rarity = canon(part.rarity);
	const v = C.variants[part.name] || {};
	const S = C.slots[slot];
	const out = { slot, name: part.name, rarity, level: C.partLevel[rarity], tier: C.tierOfRarity[rarity], variant: v.label || 'Balanced', stats: {} };
	if (slot === 'rod') {
		out.meanFish = S.meanFish[rarity] + (v.meanDelta || 0);
		out.durabilityVariant = v.durability ?? 1;
	}
	if (slot === 'reel') out.stats = { fishingSpeed: S.fishingSpeed[rarity] * (v.fishingSpeed ?? 1), trophyChance: S.trophyChance[rarity] * (v.trophyChance ?? 1) };
	if (slot === 'hook') out.stats = { rareFind: S.rareFind[rarity] * (v.rareFind ?? 1), luck: S.luck[rarity] * (v.luck ?? 1) };
	if (slot === 'handle') {
		out.stats = { sellBonus: S.sellBonus[rarity] };
		out.durabilityMult = S.durabilityMult[rarity];
	}
	for (const k of Object.keys(out.stats)) out.stats[k] = round4(out.stats[k]);
	return out;
}

/**
 * The L6B gate: a crafted rod requires its highest-rarity part's level. Returns the required level, the
 * part(s) that set it and whether a player of `playerLevel` may craft / equip it.
 */
function rodGate(parts, playerLevel = Infinity) {
	const C = R().custom;
	const list = Object.values(bySlot(parts));
	const levels = list.map((p) => C.partLevel[canon(p.rarity)]);
	const requiredLevel = Math.max(...levels);
	const setBy = list.filter((p, i) => levels[i] === requiredLevel).map((p) => ({ name: p.name, slot: SLOT_OF_TYPE[p.type], rarity: canon(p.rarity) }));
	const allowed = requiredLevel <= playerLevel;
	return { requiredLevel, setBy, allowed, blockedParts: list.filter((p, i) => levels[i] > playerLevel).map((p) => p.name) };
}

/** A crafted rod from four parts under the 5B rules (the model's craftRod). */
function craftedRod(parts) {
	const C = R().custom;
	const s = bySlot(parts);
	const prof = Object.fromEntries(SLOT_KEYS.map((k) => [k, partProfile(s[k])]));
	const stats = Object.fromEntries(STAT_KEYS.map((k) => [k, 0]));
	for (const p of Object.values(prof)) for (const [k, v] of Object.entries(p.stats)) stats[k] = round4(stats[k] + v);
	const meanFish = Math.min(need5b().multiCatch.ceilingMean, Math.max(1, prof.rod.meanFish));
	const top = PART_RARITIES[Math.max(...Object.values(prof).map((p) => PART_RARITIES.indexOf(p.rarity)))];
	const gate = rodGate(s);
	return {
		kind: 'custom',
		parts: prof,
		tier: C.tierOfRarity[top],
		requiredLevel: gate.requiredLevel,
		setBy: gate.setBy,
		qualities: [...C.qualities],
		stats,
		meanFish,
		multiChance: meanFish > 1 ? chanceForMean(meanFish) : 0,
		maxDurability: roundTo(C.durabilityBase[prof.rod.rarity] * prof.handle.durabilityMult * prof.rod.durabilityVariant, C.durabilityRoundTo),
		repairCost: C.repairCost[prof.rod.rarity],
		maxRepairs: C.maxRepairs,
		unbreakable: false,
	};
}

/** The Old Rod: unbreakable, weak only, one fish, no stats. */
function oldRodProfile(name = R().oldRod.name) {
	const o = R().oldRod;
	return { kind: 'old', name, requiredLevel: o.unlockLevel, qualities: [...o.qualities], stats: {}, meanFish: o.meanFish, multiChance: o.multiChance, maxDurability: null, repairCost: 0, maxRepairs: null, unbreakable: true };
}

/** A standard shop rod by name. */
function standardProfile(name) {
	const s = standardRow(name);
	return { kind: 'standard', name: s.name, tier: s.tier, requiredLevel: s.unlockLevel, qualities: [...s.qualities], stats: { ...s.stats }, meanFish: s.meanFish, multiChance: s.multiChance, maxDurability: s.maxDurability, repairCost: s.repairCost, maxRepairs: s.maxRepairs, unbreakable: false, price: s.price };
}

/** The legacy fingerprint of a crafted rod's stored capabilities (the model's legacySignature). */
function legacySignature(capabilities = []) {
	const num = capabilities.find((c) => /^\d+$/.test(c)) || '0';
	const count = (capabilities.find((c) => /^\d+\s*count$/i.test(c)) || '0').split(' ')[0];
	const dur = (capabilities.find((c) => /durability$/i.test(c)) || '0').split(' ')[0];
	return `n${num}|c${count}|d${dur}|${capabilities.includes('quick') ? 'q' : '-'}|${capabilities.includes('strong') ? 's' : '-'}`;
}

/** A matched set of one rarity from the catalog parts (per slot, the highest catalog rarity <= it). */
function matchedSet(rarity, catalogParts) {
	const set = {};
	for (const [slot, type] of Object.entries(TYPE_OF_SLOT)) {
		const have = new Set(catalogParts.filter((p) => p.type === type).map((p) => canon(p.rarity)));
		let i = PART_RARITIES.indexOf(rarity);
		while (i > 0 && !have.has(PART_RARITIES[i])) i--;
		set[slot] = { name: `${PART_RARITIES[i]} ${slot} (balanced)`, type, rarity: PART_RARITIES[i] };
	}
	return set;
}

/**
 * The 5B profile of a crafted rod whose parts are known or recovered (paths A/B/C), with grandfathered
 * durability. `partDocs`: the rod's four part documents (null entries when missing); `catalogParts`: the
 * catalog rod parts (for paths B/C).
 */
function convertCraftedRod(stored, partDocs, catalogParts) {
	let method = 'parts';
	let parts = (partDocs || []).filter(Boolean);
	let valid = parts.length === 4;
	if (valid) {
		try {
			bySlot(parts);
		}
		catch {
			valid = false;
		}
	}
	if (!valid) {
		const names = R().legacy.signatures[legacySignature(stored.capabilities || [])];
		const found = names ? names.map((n) => catalogParts.find((p) => p.name === n)) : null;
		if (found && found.every(Boolean)) {
			method = 'signature';
			parts = found;
		}
		else {
			method = 'default';
			parts = matchedSet(R().legacy.defaultRarity, catalogParts);
		}
	}
	const rod = craftedRod(parts);
	return { ...rod, name: stored.name, method, maxDurability: Math.max(Number(stored.maxDurability) || 0, rod.maxDurability) };
}

/**
 * The 5B profile of any stored rod. Crafted rods read their part documents (and the catalog parts only
 * when a part is missing). An unknown shop rod plays as the Old Rod.
 */
async function resolveRod(rod) {
	if (!rod) return null;
	if (isStandardRod(rod)) return standardProfile(rod.name);
	if (isCraftedRod(rod)) {
		const { ItemData, Item } = require('../../schemas/ItemSchema');
		const ids = [rod.rod, rod.reel, rod.hook, rod.handle].filter(Boolean).map((id) => new mongoose.Types.ObjectId(String(id)));
		const docs = await ItemData.collection.find({ _id: { $in: ids } }).toArray();
		const ordered = [rod.rod, rod.reel, rod.hook, rod.handle].map((id) => docs.find((d) => id && String(d._id) === String(id)) || null);
		const catalogParts = ordered.filter(Boolean).length === 4 ? [] : await Item.collection.find({ user: null, type: { $in: Object.keys(SLOT_OF_TYPE) } }).toArray();
		return convertCraftedRod(rod, ordered, catalogParts);
	}
	return oldRodProfile(rod.name);
}

/** The rod's state under 5B: the Old Rod never breaks; a crafted rod is never destroyed (legacy destroyed = broken). */
function effectiveState(rod, profile) {
	if (profile?.unbreakable) return 'mint';
	if (rod?.state === 'destroyed') return 'broken';
	return rod?.state || 'mint';
}

/** Durability charged by a cast of n fish (P-DURABILITY): n × (1 − efficiency), stochastic rounding, no minimum. */
function durabilityCharge(n, efficiency, rng) {
	const x = n * (1 - Math.min(1, Math.max(0, efficiency || 0)));
	const whole = Math.floor(x);
	return whole + (rng.random() < x - whole ? 1 : 0);
}

module.exports = {
	PART_RARITIES, SLOT_OF_TYPE, canon, isOldRod, isStandardRod, isCraftedRod, standardRow, bySlot, partProfile, rodGate, craftedRod,
	oldRodProfile, standardProfile, legacySignature, matchedSet, convertCraftedRod, resolveRod, effectiveState, durabilityCharge,
};
