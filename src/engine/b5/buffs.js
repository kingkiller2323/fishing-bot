// Buffs under the 5B rules (step C.9; P-BUFFS-*, P-DOUBLE-CASH). Activation consumes exactly one unit (B2)
// and runs in real time (B1: seconds), recorded on the user as activeBuffs.{xp,cash,gacha}; one active per
// kind, a second activation queues (extends the time or adds charges) up to maxQueued activations' worth.
// Effects are read at use time (endsAt > now). Double Cash is stamped at CATCH into the fish value; no sale
// path applies a cash buff. Lucky Draw: one bonus slot on each of the next K opens (not Booster Packs).
// Buff + event of the same category add their bonuses: 1 + (buff - 1) + (event - 1).
const { ObjectId } = require('mongoose').Types;
const { need5b } = require('../balance');
const { User: UserModel } = require('../../schemas/UserSchema');
const { BuffData } = require('../../schemas/BuffSchema');
const { withUserLock } = require('../userLock');

const B = () => need5b().buffs;
const LEGACY_KIND = { xp: 'xp', cash: 'cash', gacha: 'gacha' };

/** The 5B definition of a buff document (by catalog name; legacy capabilities map by kind, P-BUFFS-LEGACY). */
function buffDef(doc) {
	const byName = B().catalog[doc?.name];
	if (byName) return { name: doc.name, ...byName };
	const kind = LEGACY_KIND[(doc?.capabilities || [])[0]];
	const entry = Object.entries(B().catalog).find(([, d]) => d.kind === kind);
	return entry ? { name: entry[0], ...entry[1] } : null;
}

/** The buffs in effect at `now` from a user document: { xp, cash, gacha } (null when none). */
function effectsAt(user, now = Date.now()) {
	const a = user?.activeBuffs || {};
	return {
		xp: a.xp && a.xp.endsAt > now ? a.xp : null,
		cash: a.cash && a.cash.endsAt > now ? a.cash : null,
		gacha: a.gacha && a.gacha.chargesLeft > 0 ? a.gacha : null,
	};
}

/** Additive temporary multiplier of a buff and an event in one category. */
const temporaryMultiplier = (buff = 1, event = 1) => 1 + (buff - 1) + (event - 1);

/**
 * Activates one unit of an owned buff stack. Refused without stock (NO_STOCK) or when the kind's queue is
 * full (QUEUE_FULL; the unit is kept). Returns the new state of the kind.
 */
async function activate(userId, buffId, now = Date.now()) {
	return withUserLock(userId, async () => {
		const stack = await BuffData.collection.findOne({ _id: new ObjectId(String(buffId)), user: String(userId) });
		if (!stack || !((stack.count ?? 1) >= 1)) return { ok: false, code: 'NO_STOCK', message: 'You have none of that booster.' };
		const def = buffDef(stack);
		if (!def) return { ok: false, code: 'UNKNOWN', message: 'That booster cannot be activated.' };
		const user = await UserModel.collection.findOne({ userId: String(userId) });
		const current = effectsAt(user, now)[def.kind];
		const max = B().queue.maxQueued;
		let next;
		if (def.kind === 'gacha') {
			const charges = (current?.chargesLeft || 0) + def.duration.opens;
			if (charges > max * def.duration.opens) return { ok: false, code: 'QUEUE_FULL', message: `You already have ${current.chargesLeft} bonus draws banked.` };
			next = { name: def.name, bonusSlots: def.bonusSlots, chargesLeft: charges, activationId: new ObjectId().toString() };
		}
		else {
			const length = def.duration.seconds * 1000;
			const start = current ? current.endsAt : now;
			const endsAt = start + length;
			if (endsAt - now > max * length) return { ok: false, code: 'QUEUE_FULL', message: `${def.name} is already queued for ${Math.round((current.endsAt - now) / 60000)} minutes.` };
			next = { name: def.name, multiplier: def.multiplier, endsAt, activationId: new ObjectId().toString() };
		}
		const took = await BuffData.collection.updateOne({ _id: stack._id, count: { $gte: 1 } }, { $inc: { count: -1 } });
		if (took.modifiedCount !== 1) return { ok: false, code: 'NO_STOCK', message: 'You have none of that booster.' };
		const set = { [`activeBuffs.${def.kind}`]: next };
		const pull = (stack.count ?? 1) - 1 <= 0 ? { $pull: { 'inventory.buffs': stack._id } } : {};
		await UserModel.collection.updateOne({ userId: String(userId) }, { $set: set, ...pull });
		return { ok: true, kind: def.kind, state: next, extended: Boolean(current) };
	});
}

/** The cast's buff source for the 5B modifiers: xp bonus and cash multiplier at `now`. */
function castBuffs(user, now) {
	const e = effectsAt(user, now);
	const list = [e.xp, e.cash].filter(Boolean).map((b) => ({ name: b.name, kind: b === e.xp ? 'xp' : 'cash', multiplier: b.multiplier, endsAt: b.endsAt }));
	return { xp: e.xp ? e.xp.multiplier - 1 : 0, cash: e.cash ? e.cash.multiplier - 1 : 0, list };
}

/** Lucky Draw bonus slots for an open of `boxName` (none for excluded boxes). */
function luckyDrawFor(user, boxName) {
	const g = effectsAt(user).gacha;
	const excluded = B().catalog['Lucky Draw']?.excludeBoxes || [];
	if (!g || excluded.includes(boxName)) return null;
	return { bonusSlots: g.bonusSlots || 1, chargesBefore: g.chargesLeft, chargesAfter: g.chargesLeft - 1 };
}

module.exports = { buffDef, effectsAt, temporaryMultiplier, activate, castBuffs, luckyDrawFor };
