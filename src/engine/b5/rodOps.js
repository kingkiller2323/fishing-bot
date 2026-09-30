// Player rod operations under the 5B rules (step C.2). Every money movement is a guarded atomic write under
// the player's lock (engine/purchase.js); every grant is idempotent. Used only while the 5B flag is on.
//
//   buyStandardRod   the shop's standard ladder: level gate, one copy per rod, guarded debit, then the grant
//   equipGate        L6B: the level a rod requires (standard: its level; crafted: its highest part's level)
//   craftRod         the Rod Workshop craft: gate refused below the requirement, parts consumed, 5B stats
//   repairRod        unlimited repairs at the rule cost, to the effective max (a destroyed crafted rod counts
//                    as broken); the Old Rod never needs one
//   salvagePart      one spare part unit for its salvage value
//   ensureRod        the unbreakable Old Rod as the fallback: re-equip the owned one, grant one only if none
const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types;
const { need5b } = require('../balance');
const { User: UserModel } = require('../../schemas/UserSchema');
const { Item, ItemData } = require('../../schemas/ItemSchema');
const { withUserLock } = require('../userLock');
const { debitMoney } = require('../purchase');
const { grantItem } = require('../rewards');
const { gateLevelOf } = require('../levelGate');
const rods5b = require('./rods');

const oid = (id) => (id instanceof ObjectId ? id : new ObjectId(String(id)));
const refuse = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });
const userDoc = (userId) => UserModel.collection.findOne({ userId: String(userId) });

/** Owned rods (documents) of a player. */
async function ownedRods(user) {
	return ItemData.collection.find({ _id: { $in: (user?.inventory?.rods || []).map(oid) } }).toArray();
}

/** The level a rod requires under 5B, with the part(s) that set it for crafted rods. */
async function equipGate(rod, user) {
	const profile = await rods5b.resolveRod(rod);
	const level = gateLevelOf(user);
	const required = profile.requiredLevel || 0;
	return { ok: level >= required, level, required, setBy: profile.setBy || null, profile };
}

/**
 * Equips an owned rod (L6B): refused below its required level; the equipped rod is never unequipped by a gate
 * (grandfathered), and re-equipping the rod already equipped is a no-op.
 */
async function equipRod(userId, rodId) {
	return withUserLock(userId, async () => {
		const user = await userDoc(userId);
		if (!user) return refuse('NO_USER', 'Player not found.');
		if (!(user.inventory?.rods || []).some((r) => String(r) === String(rodId))) return refuse('NOT_OWNED', 'You do not own that rod.');
		if (String(user.inventory?.equippedRod) === String(rodId)) return { ok: true, unchanged: true };
		const rod = await ItemData.collection.findOne({ _id: oid(rodId) });
		const gate = await equipGate(rod, user);
		if (!gate.ok) return refuse('LEVEL_LOCKED', lockReason(rod, gate), { required: gate.required, level: gate.level });
		await UserModel.collection.updateOne({ userId: String(userId) }, { $set: { 'inventory.equippedRod': oid(rodId), updatedAt: new Date() } });
		return { ok: true, rod };
	});
}

/** "🔒 This rod requires Lv 30 (Rare EVA Handle). You are Lv 10." */
function lockReason(rod, gate) {
	const by = gate.setBy?.length ? ` (${gate.setBy.map((p) => `${p.rarity} ${p.name}`).join(', ')})` : '';
	return `🔒 ${rod?.name || 'This rod'} requires Lv ${gate.required}${by}. You are Lv ${gate.level}.`;
}

/** "🔒 Needs Lv 30 because of the Rare EVA Handle. You are Lv 10." */
const craftLockReason = (rod, level) => `🔒 Needs Lv ${rod.requiredLevel} because of the ${rod.setBy.map((p) => `${p.rarity} ${p.name}`).join(', ')}. You are Lv ${level}.`;

/** The Workshop's craft preview for four parts at a player's level (nothing is written). */
function craftPreview(parts, level) {
	const rod = rods5b.craftedRod(parts);
	return { rod, allowed: level >= rod.requiredLevel && level >= need5b().rods.custom.minLevel, reason: level >= rod.requiredLevel ? null : craftLockReason(rod, level) };
}

/** Buys a standard shop rod: level gate, not already owned, guarded debit, idempotent grant. */
async function buyStandardRod(userId, name, { equip = false, key = new ObjectId().toString() } = {}) {
	const row = rods5b.standardRow(name);
	if (!row) return refuse('UNKNOWN_ROD', 'That rod is not sold in the shop.');
	return withUserLock(userId, async () => {
		const user = await userDoc(userId);
		if (!user) return refuse('NO_USER', 'Player not found.');
		const level = gateLevelOf(user);
		if (level < row.unlockLevel) return refuse('LEVEL_LOCKED', `The ${row.name} unlocks at Lv ${row.unlockLevel}. You are Lv ${level}.`, { required: row.unlockLevel, level });
		if ((await ownedRods(user)).some((r) => r.name === row.name)) return refuse('OWNED', `You already own the ${row.name}.`);
		const template = await Item.collection.findOne({ name: row.name, user: null, type: 'rod' });
		if (!template) return refuse('NOT_SEEDED', 'That rod is not available yet.');
		if (!await debitMoney(userId, row.price)) return refuse('INSUFFICIENT', `You need $${row.price.toLocaleString()} (you have $${(user.inventory?.money || 0).toLocaleString()}).`, { price: row.price, money: user.inventory?.money || 0 });
		const grant = { key: `buy-rod:${key}`, templateId: String(template._id), count: 1, newId: new ObjectId().toString(), reason: 'shop' };
		try {
			await grantItem(String(userId), grant);
			// A shop rod starts at its full 5B durability, whatever the catalog row's defaults.
			await ItemData.collection.updateOne({ _id: oid(grant.newId) }, { $set: { durability: row.maxDurability, maxDurability: row.maxDurability, repairCost: row.repairCost, maxRepairs: row.maxRepairs, state: 'mint', repairs: 0 } });
			if (equip) await UserModel.collection.updateOne({ userId: String(userId) }, { $set: { 'inventory.equippedRod': oid(grant.newId) } });
		}
		catch (error) {
			await UserModel.collection.updateOne({ userId: String(userId) }, { $inc: { 'inventory.money': row.price } });
			throw error;
		}
		return { ok: true, rodId: grant.newId, price: row.price, equipped: equip };
	});
}

/**
 * Crafts a rod from four owned part documents (one unit each). Refused below the requirement (the parts stay
 * owned). The rod gets the 5B stats: weak + strong, the highest part's level, the formula durability and
 * repair cost, unlimited repairs.
 */
async function craftRod(userId, { name, description = null, partIds }) {
	return withUserLock(userId, async () => {
		const user = await userDoc(userId);
		if (!user) return refuse('NO_USER', 'Player not found.');
		const owned = new Set((user.inventory?.items || []).map(String));
		if (!partIds || partIds.length !== 4 || partIds.some((id) => !owned.has(String(id)))) return refuse('NOT_OWNED', 'You must own the four parts.');
		const parts = await ItemData.collection.find({ _id: { $in: partIds.map(oid) } }).toArray();
		if (parts.length !== 4 || parts.some((p) => (p.count ?? 1) < 1)) return refuse('NOT_OWNED', 'You must own the four parts.');
		let rod;
		try {
			rod = rods5b.craftedRod(parts);
		}
		catch (error) {
			return refuse('BAD_PARTS', error.message);
		}
		const level = gateLevelOf(user);
		if (level < need5b().rods.custom.minLevel) return refuse('WORKSHOP_LOCKED', `The Rod Workshop opens at Lv ${need5b().rods.custom.minLevel}.`);
		if (level < rod.requiredLevel) return refuse('LEVEL_LOCKED', craftLockReason(rod, level), { required: rod.requiredLevel, level, preview: rod });
		// Consume one unit of each part (guarded), then create the rod.
		const taken = [];
		for (const p of parts) {
			const res = await ItemData.collection.updateOne({ _id: p._id, count: { $gte: 1 } }, { $inc: { count: -1 } });
			if (res.modifiedCount !== 1) {
				for (const t of taken) await ItemData.collection.updateOne({ _id: t }, { $inc: { count: 1 } });
				return refuse('NOT_OWNED', 'A part was used up in the meantime.');
			}
			taken.push(p._id);
		}
		const slot = Object.fromEntries(parts.map((p) => [rods5b.SLOT_OF_TYPE[p.type], p._id]));
		const _id = new ObjectId();
		const now = new Date();
		await ItemData.collection.insertOne({
			_id, __t: 'CustomRodData', user: String(userId), name: String(name || 'Custom Rod').slice(0, 64), description: description || 'Crafted in the Rod Workshop', rarity: 'Custom', type: 'customrod',
			rod: slot.rod, reel: slot.reel, hook: slot.hook, handle: slot.handle, capabilities: [...rod.qualities], requirements: { level: rod.requiredLevel },
			obtained: Date.now(), fishCaught: 0, state: 'mint', durability: rod.maxDurability, maxDurability: rod.maxDurability, repairs: 0, maxRepairs: rod.maxRepairs, repairCost: rod.repairCost,
			balanceVersion: '5b', createdAt: now, updatedAt: now,
		});
		await UserModel.collection.updateOne({ userId: String(userId) }, { $push: { 'inventory.rods': _id } });
		return { ok: true, rodId: String(_id), rod };
	});
}

/** Repairs a rod at its 5B rule cost to its effective max. The debit happens only if the repair applies. */
async function repairRod(userId, rodId) {
	return withUserLock(userId, async () => {
		const rod = await ItemData.collection.findOne({ _id: oid(rodId), user: String(userId) });
		if (!rod) return refuse('NOT_OWNED', 'You do not own that rod.');
		const profile = await rods5b.resolveRod(rod);
		if (profile.unbreakable) return refuse('UNBREAKABLE', `The ${rod.name} never needs a repair.`);
		if (rods5b.effectiveState(rod, profile) !== 'broken') return refuse('NOT_BROKEN', 'Your rod is not broken.');
		const cost = profile.repairCost;
		if (!await debitMoney(userId, cost)) return refuse('INSUFFICIENT', `A repair costs $${cost.toLocaleString()}.`, { cost });
		const res = await ItemData.collection.updateOne(
			{ _id: rod._id, state: rod.state },
			{ $set: { state: 'repaired', durability: profile.maxDurability, maxDurability: profile.maxDurability, updatedAt: new Date() }, $inc: { repairs: 1 } },
		);
		if (res.modifiedCount !== 1) {
			await UserModel.collection.updateOne({ userId: String(userId) }, { $inc: { 'inventory.money': cost } });
			return refuse('NOT_BROKEN', 'Your rod is no longer broken; you were not charged.');
		}
		return { ok: true, cost, durability: profile.maxDurability };
	});
}

/** Salvages one spare unit of an owned rod part for its salvage value. */
async function salvagePart(userId, partId) {
	return withUserLock(userId, async () => {
		const part = await ItemData.collection.findOne({ _id: oid(partId), user: String(userId) });
		if (!part || !rods5b.SLOT_OF_TYPE[part.type]) return refuse('NOT_A_PART', 'That is not one of your rod parts.');
		const value = need5b().rods.salvage[rods5b.canon(part.rarity)];
		if (!(value > 0)) return refuse('NO_VALUE', 'That part has no salvage value.');
		const res = await ItemData.collection.updateOne({ _id: part._id, count: { $gte: 1 } }, { $inc: { count: -1 } });
		if (res.modifiedCount !== 1) return refuse('NONE_LEFT', 'You have no spare unit of that part.');
		await UserModel.collection.updateOne({ userId: String(userId) }, { $inc: { 'inventory.money': value } });
		return { ok: true, value };
	});
}

/**
 * The fallback rod: with no rod equipped, re-equip an owned Old Rod; grant one only if none is owned
 * (no free replacements). Returns the equipped rod id.
 */
async function ensureRod(userId) {
	return withUserLock(userId, async () => {
		const user = await userDoc(userId);
		if (!user) return null;
		if (user.inventory?.equippedRod) return String(user.inventory.equippedRod);
		const oldName = need5b().rods.oldRod.name;
		const own = (await ownedRods(user)).find((r) => r.name === oldName && r.type === 'rod');
		let id = own?._id;
		if (!id) {
			const template = await Item.collection.findOne({ name: oldName, user: null });
			const grant = { key: `old-rod:${userId}`, templateId: String(template._id), count: 1, newId: new ObjectId().toString(), reason: 'fallback' };
			await grantItem(String(userId), grant);
			id = oid(grant.newId);
		}
		await UserModel.collection.updateOne({ userId: String(userId), 'inventory.equippedRod': null }, { $set: { 'inventory.equippedRod': id } });
		return String(id);
	});
}

/** Equips the player's Old Rod (granting one only if none is owned): the broken-rod card's "Use Old Rod". */
async function useOldRod(userId) {
	await withUserLock(userId, () => UserModel.collection.updateOne({ userId: String(userId) }, { $set: { 'inventory.equippedRod': null } }));
	return ensureRod(userId);
}

module.exports = { useOldRod, ownedRods, equipGate, equipRod, lockReason, craftLockReason, craftPreview, buyStandardRod, craftRod, repairRod, salvagePart, ensureRod };
