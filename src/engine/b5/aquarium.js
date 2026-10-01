// The 5B aquarium (step C.10; P-AQUARIUM-*). Licences grant a number of tanks × size per water type and
// companion slots (best tier held, level-capped like rods' parts); thriving pets in those slots add a small
// cash-only sell bonus (bond ramps it from half to full). Care actions have per-pet cooldowns and give bond
// XP capped at the bond maximum; a pet sells for its species value × age × origin × condition × attraction
// (never its XP), at most a few times a week; breeding uses today's formula with the comparison fixed (A2).
// Tanks built before the flip are grandfathered (never deleted or collapsed); new tanks need free capacity.
const { ObjectId } = require('mongoose').Types;
const { need5b } = require('../balance');
const { User: UserModel } = require('../../schemas/UserSchema');
const { ItemData, Item } = require('../../schemas/ItemSchema');
const { withUserLock } = require('../userLock');
const { debitMoney } = require('../purchase');
const { grantItem } = require('../rewards');
const { gateLevelOf } = require('../levelGate');
const { effectiveTemperature } = require('../aquariumRules');

const A = () => need5b().aquarium;
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const lower = (s) => String(s || '').toLowerCase();
const canonWater = (w) => (lower(w) === 'saltwater' ? 'Saltwater' : lower(w) === 'freshwater' ? 'Freshwater' : null);
const licenseRow = (name) => A().licenses.find((l) => l.name === name) || null;
const tierIndex = (tier) => A().tierOrder.indexOf(tier);
/** A stored time (epoch ms number or Date) as ms; NaN when absent. */
const toMs = (t) => (t instanceof Date ? t.getTime() : t === null || t === undefined ? NaN : Number(t));

/** Best licence tier held per water type from owned licence documents: { Freshwater: 'advanced', ... }. */
function holdingsOf(licenseDocs) {
	const out = {};
	for (const doc of licenseDocs) {
		const row = licenseRow(doc.name);
		if (!row) continue;
		if (!out[row.water] || tierIndex(row.tier) > tierIndex(out[row.water])) out[row.water] = row.tier;
	}
	return out;
}

const tierRow = (water, tier) => A().licenses.find((l) => l.water === water && l.tier === tier);

/** Companion slots: the best tier held, capped to the best tier whose gate the player has reached. */
function companionSlots(holdings, level) {
	const capped = (water) => {
		const held = holdings[water];
		if (!held) return 0;
		const usable = A().tierOrder.slice(0, tierIndex(held) + 1).filter((t) => level >= tierRow(water, t).level);
		return usable.length ? tierRow(water, usable.at(-1)).companionSlots : 0;
	};
	const slots = ['Freshwater', 'Saltwater'].map(capped);
	return A().secondWaterAddsSlots ? slots.reduce((a, b) => a + b, 0) : Math.max(0, ...slots);
}

const bondFactor = (xp) => {
	const b = A().companion.bond;
	return b.minFactor + (1 - b.minFactor) * Math.min(1, Math.max(0, xp || 0) / b.maxXp);
};

/** Is a pet thriving in its tank at `now`? (fed recently, tank clean enough, temperature near the ideal). */
function thriving(pet, tank, now) {
	const t = A().companion.thrive;
	const fed = toMs(pet?.lastFed);
	const fedOk = Number.isFinite(fed) && now - fed <= t.fedWithinH * HOUR;
	const cleanOk = (tank?.cleanliness ?? 0) >= t.minCleanliness;
	const tempOk = Math.abs(effectiveTemperature(tank?.temperature) - A().temperature.idealC) <= t.temperatureBandC;
	return fedOk && cleanOk && tempOk;
}

/** The companion bonus: the best thriving pets up to the slots. `pets`: [{ rarity, xp, thriving }]. */
function companionBonus(pets, slots) {
	const per = A().companion.perPet;
	const values = pets.filter((p) => p.thriving).map((p) => (per[lower(p.rarity)] || 0) * bondFactor(p.xp)).filter((v) => v > 0).sort((a, b) => b - a);
	const counted = values.slice(0, slots);
	return { bonus: counted.reduce((a, b) => a + b, 0), counted: counted.length, slots };
}

/** The cast's aquarium source (a 5B modifier source) for a player: null when nothing counts. */
async function companionSource(user, now) {
	const { PetFish } = require('../../schemas/PetSchema');
	const { Habitat } = require('../../schemas/HabitatSchema');
	const { FishData } = require('../../schemas/FishSchema');
	const licenses = await ItemData.collection.find({ _id: { $in: (user.inventory?.items || []).map((id) => new ObjectId(String(id))) }, type: 'license' }).toArray();
	const slots = companionSlots(holdingsOf(licenses), gateLevelOf(user));
	if (!slots) return null;
	const pets = await PetFish.find({ owner: String(user.userId), aquarium: { $ne: null } }).lean();
	if (!pets.length) return null;
	const tanks = new Map((await Habitat.find({ _id: { $in: pets.map((p) => p.aquarium) } }).lean()).map((h) => [String(h._id), h]));
	const fish = new Map((await FishData.find({ _id: { $in: pets.map((p) => p.fish).filter(Boolean) } }).select('rarity').lean()).map((f) => [String(f._id), f]));
	const list = pets.map((p) => ({ rarity: fish.get(String(p.fish))?.rarity || 'common', xp: p.xp, thriving: thriving(p, tanks.get(String(p.aquarium)), now) }));
	const r = companionBonus(list, slots);
	return r.bonus > 0 ? { source: 'aquarium', slots: r.slots, counted: r.counted, stats: { sellBonus: Number(r.bonus.toFixed(6)) } } : null;
}

/** Bond multiplier of a pet: today's XP traits, counting only UNLOCKED traits (A10). */
function bondMultiplier(traits = {}) {
	let m = 1;
	const t = (k) => (traits?.[k]?.unlocked ? traits[k].trait : null);
	if (t('finSize') === 'Long Fins') m += 0.2;
	if (['Pointed Fins', 'Frilly Fins'].includes(t('finShape'))) m += 0.1;
	m += ({ Golden: 0.1, Platinum: 0.2, Diamond: 0.3, Rainbow: 0.4 })[t('color')] || 0;
	return m;
}

/**
 * A care action ('feed' | 'play') on a pet: refused on cooldown (nothing changes); otherwise today's effect
 * (hunger -50 × trait / mood +30) and bond XP (50 × the unlocked-trait multiplier), capped at the bond max.
 */
async function care(petId, action, now = Date.now()) {
	const { PetFish } = require('../../schemas/PetSchema');
	const pet = await PetFish.findById(petId).lean();
	if (!pet) return { ok: false, code: 'NO_PET', message: 'Pet not found.' };
	const field = action === 'feed' ? 'lastFed' : 'lastPlayed';
	const cooldown = (action === 'feed' ? A().care.feedCooldownH : A().care.playCooldownH) * HOUR;
	const last = toMs(pet[field]) || 0;
	if (now - last < cooldown) return { ok: false, code: 'COOLDOWN', message: `${pet.name} can ${action === 'feed' ? 'be fed' : 'play'} again in ${((cooldown - (now - last)) / HOUR).toFixed(1)} h.`, retryInMs: cooldown - (now - last) };
	const set = { [field]: now };
	if (action === 'feed') {
		const factor = ({ 'Big Eater': 0.75, 'Light Eater': 1.5, 'Normal Eater': 1 })[pet.traits?.hunger?.trait] || 1;
		set.hunger = Math.floor(Math.max(Math.min((pet.hunger || 0) - 50 * factor, 100), 0));
	}
	else {
		set.mood = Math.max(Math.min((pet.mood || 0) + 30, 100), 0);
	}
	const cap = A().companion.bond.maxXp;
	const gain = A().companion.bond.xpPerCare * bondMultiplier(pet.traits);
	// The stored XP is never reduced: a pet already above the cap keeps it.
	set.xp = Math.max(pet.xp || 0, Math.min(cap, (pet.xp || 0) + gain));
	const res = await PetFish.updateOne({ _id: pet._id, [field]: pet[field] ?? null }, { $set: set });
	if (res.modifiedCount !== 1) return { ok: false, code: 'COOLDOWN', message: `${pet.name} was just cared for.` };
	return { ok: true, bond: set.xp };
}

const ageFactor = (days) => {
	const s = A().sale;
	return s.minAgeFactor + (1 - s.minAgeFactor) * Math.min(1, Math.max(0, (days || 1) - 1) / (s.fullValueAgeDays - 1));
};

/** Sale value of a pet (P-AQUARIUM-PET-SALE): species value × age × origin × condition × attraction; never XP. */
function petSaleValue({ speciesValue, ageDays, bred = false, attraction = 0, isThriving = true }) {
	const s = A().sale;
	const attr = Math.min(s.maxAttraction, Math.max(0, attraction || 0));
	return Math.round(speciesValue * ageFactor(ageDays) * (bred ? s.bredFactor : 1) * (isThriving ? 1 : s.notThrivingFactor) * (1 + attr * s.attractionPerPoint));
}

/**
 * Sells a pet under the owner's lock: at most maxPerWeek sales in 7 days; the pet is claimed atomically and the
 * value paid with $inc. Returns { ok, amount } or a refusal.
 */
async function sellPet(ownerId, petId, now = Date.now()) {
	const { PetFish } = require('../../schemas/PetSchema');
	const { Habitat } = require('../../schemas/HabitatSchema');
	const { FishData } = require('../../schemas/FishSchema');
	return withUserLock(ownerId, async () => {
		const user = await UserModel.collection.findOne({ userId: String(ownerId) });
		const recent = (user?.aquarium5b?.sales || []).filter((t) => now - t < 7 * DAY);
		if (recent.length >= A().sale.maxPerWeek) return { ok: false, code: 'SALE_LIMIT', message: `You can sell ${A().sale.maxPerWeek} pets per 7 days. The next sale opens in ${((Math.min(...recent) + 7 * DAY - now) / DAY).toFixed(1)} days.` };
		const pet = await PetFish.findOne({ _id: petId, owner: String(ownerId) }).lean();
		if (!pet) return { ok: false, code: 'NOT_OWNED', message: 'That pet is not yours to sell.' };
		const fish = await FishData.findById(pet.fish).select('biome name').lean();
		const species = fish ? need5b().value.species[`${fish.biome}|${fish.name}`] : null;
		if (!species) return { ok: false, code: 'NO_VALUE_DATA', message: 'This pet cannot be sold.' };
		const tank = pet.aquarium ? await Habitat.findById(pet.aquarium).lean() : null;
		const ageDays = Math.max(1, Number(pet.age) || ((now - (pet.adoptTime || now)) / DAY));
		const amount = petSaleValue({ speciesValue: species.proposed, ageDays, bred: Boolean(pet.bred), attraction: pet.attraction, isThriving: thriving(pet, tank, now) });
		const claimed = await PetFish.findOneAndUpdate({ _id: pet._id, owner: String(ownerId) }, { $set: { owner: '', aquarium: null } }).lean();
		if (!claimed) return { ok: false, code: 'NOT_OWNED', message: 'That pet was already sold.' };
		await UserModel.collection.updateOne({ userId: String(ownerId) }, { $inc: { 'inventory.money': amount }, $set: { 'aquarium5b.sales': [...recent, now] } });
		await Habitat.updateMany({ fish: pet._id }, { $pull: { fish: pet._id } });
		return { ok: true, amount };
	});
}

/** Breeding success under 5B (A2): today's rate formula, compared as a probability. */
const breedingRate = (stress, health) => Math.max(Math.min(0.65, (50 - stress) / 50), Math.max(Math.min(0.6, health / 100 - 0.5), 0.1));

/** Tank allowance per water type: tanks of the best tier held plus display tanks bought; the new tank size. */
function tankAllowance(holdings, user, water) {
	const tier = holdings[water];
	if (!tier) return { tanks: 0, tankSize: 0 };
	const row = tierRow(water, tier);
	const display = Number(user?.aquarium5b?.displayTanks?.[water]) || 0;
	return { tanks: row.tanks + display, tankSize: row.tankSize, display };
}

/** /build under 5B: refused when the water type's tanks are used up (existing tanks always count, never removed). */
async function canBuild(userId, waterType) {
	const { Habitat } = require('../../schemas/HabitatSchema');
	const water = canonWater(waterType);
	const user = await UserModel.collection.findOne({ userId: String(userId) });
	const licenses = await ItemData.collection.find({ _id: { $in: (user.inventory?.items || []).map((id) => new ObjectId(String(id))) }, type: 'license' }).toArray();
	const allowance = tankAllowance(holdingsOf(licenses), user, water);
	if (!allowance.tanks) return { ok: false, code: 'NO_LICENSE', message: `You need a ${water} aquarium license.` };
	const built = await Habitat.countDocuments({ owner: String(userId), waterType: { $in: [water, lower(water)] } });
	if (built >= allowance.tanks) return { ok: false, code: 'TANKS_FULL', message: `Your licences allow ${allowance.tanks} ${water} tank(s); you have ${built}.` };
	return { ok: true, tankSize: allowance.tankSize };
}

/** The shop's Aquarium tab: the next licence per water type (gate reached, prerequisite held) and display tanks. */
async function shopTab(user) {
	const level = gateLevelOf(user);
	const licenses = await ItemData.collection.find({ _id: { $in: (user?.inventory?.items || []).map((id) => new ObjectId(String(id))) }, type: 'license' }).toArray();
	const holdings = holdingsOf(licenses);
	const rows = [];
	for (const water of ['Freshwater', 'Saltwater']) {
		const held = holdings[water];
		const next = A().tierOrder[held ? tierIndex(held) + 1 : 0];
		const row = next ? tierRow(water, next) : null;
		if (row && level >= row.level) rows.push({ id: `license:${row.name}`, label: `${row.name} · $${row.price.toLocaleString()}`, text: `**${row.name}** $${row.price.toLocaleString()} · ${row.tanks} × ${row.tankSize} tanks · ${row.companionSlots} companion slots` });
		const owned = Number(user?.aquarium5b?.displayTanks?.[water]) || 0;
		if (held === A().display.requires && owned < A().display.perWaterType) {
			const price = A().display.prices[owned];
			rows.push({ id: `display:${water}`, label: `${water} display tank ${owned + 1} · $${price.toLocaleString()}`, text: `**${water} display tank ${owned + 1}/${A().display.perWaterType}** $${price.toLocaleString()} · ${A().display.tankSize} pets, no companion slots` });
		}
	}
	if (!rows.length) return null;
	return { key: 'aquarium', title: 'Aquarium', rows, buyable: rows.map((r) => ({ id: r.id, label: r.label })), render: () => rows.map((r) => r.text) };
}

/** Buys a licence or a display tank from the shop's Aquarium tab (guarded, under the lock). */
async function buyFromShop(userId, id) {
	return withUserLock(userId, async () => {
		const user = await UserModel.collection.findOne({ userId: String(userId) });
		const tab = await shopTab(user);
		if (!tab?.rows.some((r) => r.id === id)) return { ok: false, code: 'NOT_OFFERED', message: 'That is not on offer for you.' };
		if (id.startsWith('license:')) {
			const row = licenseRow(id.slice('license:'.length));
			const template = await Item.collection.findOne({ name: row.name, user: null, type: 'license' });
			if (!await debitMoney(userId, row.price)) return { ok: false, code: 'INSUFFICIENT', message: `The ${row.name} costs $${row.price.toLocaleString()}.` };
			try {
				await grantItem(String(userId), { key: `buy-license:${new ObjectId()}`, templateId: String(template._id), count: 1, newId: new ObjectId().toString(), reason: 'shop' });
			}
			catch (error) {
				await UserModel.collection.updateOne({ userId: String(userId) }, { $inc: { 'inventory.money': row.price } });
				throw error;
			}
			return { ok: true, price: row.price };
		}
		const water = id.slice('display:'.length);
		const owned = Number(user?.aquarium5b?.displayTanks?.[water]) || 0;
		const price = A().display.prices[owned];
		const res = await UserModel.collection.updateOne(
			{ userId: String(userId), 'inventory.money': { $gte: price }, [`aquarium5b.displayTanks.${water}`]: owned === 0 ? { $in: [null, 0] } : owned },
			{ $inc: { 'inventory.money': -price }, $set: { [`aquarium5b.displayTanks.${water}`]: owned + 1 } },
		);
		if (res.modifiedCount !== 1) return { ok: false, code: 'INSUFFICIENT', message: `That display tank costs $${price.toLocaleString()}.` };
		return { ok: true, price };
	});
}

module.exports = {
	holdingsOf, companionSlots, bondFactor, thriving, companionBonus, companionSource, bondMultiplier, care, ageFactor, petSaleValue,
	sellPet, breedingRate, tankAllowance, canBuild, shopTab, buyFromShop,
};
