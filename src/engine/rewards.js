// Shared reward primitives used by every engine (casts, gacha, dev tools): creating player-owned
// fish records and granting catalog items idempotently. Nothing else should create rewards.
const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types;
const { User: UserModel } = require('../schemas/UserSchema');
const { Item, ItemData } = require('../schemas/ItemSchema');
const { Utils } = require('../class/Utils');

const APPLIED_KEEP = 50;
const oid = (id) => (id instanceof ObjectId ? id : new ObjectId(String(id)));
// Idempotency guard shared by casts, gacha opens and grants. Keys live in `appliedOps`; the legacy
// `appliedCasts` field (the pre-rename name) is still honoured on read so journals written before the
// rename can never be re-applied, but nothing writes it any more.
/** Filter clause: operation `key` has NOT been applied to the document yet. */
const notApplied = (key) => ({ appliedOps: { $ne: key }, appliedCasts: { $ne: key } });
/** Filter clause: operation `key` HAS been applied to the document. */
const appliedTo = (key) => ({ $or: [{ appliedOps: key }, { appliedCasts: key }] });
/** Update clause: remember that operation `key` was applied to a document (last few only). */
const guardPush = (key) => ({ appliedOps: { $each: [key], $slice: -APPLIED_KEEP } });

// Fields that belong to a stored document itself and must not be copied into a clone.
const DOC_OWN_FIELDS = ['_id', '__v', 'createdAt', 'updatedAt', 'appliedOps', 'appliedCasts'];
const copyFields = (doc) => Object.fromEntries(Object.entries(doc).filter(([key]) => !DOC_OWN_FIELDS.includes(key)));

/** Rolls size/weight for a fish template and its raw (unmodified) sale value. */
async function rollFishStats(template) {
	const size = parseFloat((await Utils.binomialRandomInRange(10, 0.5, template.minSize, template.maxSize)).toFixed(3));
	const weight = parseFloat((await Utils.binomialRandomInRange(10, 0.5, template.minWeight, template.maxWeight)).toFixed(3));
	const rawValue = parseInt(await require('../class/Fish').Fish.calculateSellValue(template.baseValue, size, weight, template.rarity), 10);
	return { size, weight, rawValue };
}

/**
 * Builds a player-owned FishData document (inserted later by the engine that owns the write).
 * `meta` carries provenance: castId/openId, profile, balanceVersion, competitiveEligible, source.
 */
function buildFishDoc({ template, id, userId, guildId = null, count, size, weight, value, valueBase, locked = false, now = new Date(), meta = {} }) {
	const fields = copyFields(template);
	return {
		...fields,
		_id: String(id),
		__t: 'FishData',
		user: String(userId),
		obtained: now.getTime(),
		count,
		size,
		weight,
		value,
		valueBase,
		guild: guildId || fields.guild,
		locked,
		...meta,
	};
}

/** Inserts pre-built fish documents; re-running with the same ids is a no-op. */
async function insertFishDocs(fishDocs, session) {
	if (!fishDocs.length) return;
	const { FishData } = require('../schemas/FishSchema');
	const now = new Date();
	const docs = fishDocs.map((d) => ({ ...d, _id: oid(d._id), createdAt: now, updatedAt: now }));
	try {
		await FishData.collection.insertMany(docs, { ...(session ? { session } : {}), ordered: false });
	}
	catch (error) {
		const errors = error.writeErrors || (error.code ? [error] : []);
		if (!errors.length || errors.some((e) => (e.code ?? e.err?.code) !== 11000)) throw error;
	}
}

// How each catalog type is stored when granted (mirrors User.sendToInventory + Utils.clone).
const GRANT_TYPES = {
	rod: { t: 'RodData', array: 'rods', stack: false, extra: { fishCaught: 0 } },
	customrod: { t: 'CustomRodData', array: 'rods', stack: false, extra: { fishCaught: 0 } },
	bait: { t: 'BaitData', array: 'baits', stack: true },
	buff: { t: 'BuffData', array: 'buffs', stack: true },
	gacha: { t: 'GachaData', array: 'gacha', stack: true },
	license: { t: 'LicenseData', array: 'items', stack: 'ifCount' },
	part_rod: { t: 'PartRodData', array: 'items', stack: 'ifCount' },
	part_reel: { t: 'PartReelData', array: 'items', stack: 'ifCount' },
	part_hook: { t: 'PartHookData', array: 'items', stack: 'ifCount' },
	part_handle: { t: 'PartHandleData', array: 'items', stack: 'ifCount' },
	default: { t: 'ItemData', array: 'items', stack: 'ifCount' },
};

/** Grants a catalog item exactly once per grant key (stacks like sendToInventory). */
async function grantItem(userId, grant, session) {
	const opts = session ? { session } : {};
	const items = ItemData.collection;
	const users = UserModel.collection;

	// Already applied (either as a new stack or an increment of an existing one)?
	const done = await items.findOne({ user: userId, ...appliedTo(grant.key) }, opts);
	if (done) {
		const info = GRANT_TYPES[done.type] || GRANT_TYPES.default;
		await users.updateOne({ userId }, { $addToSet: { [`inventory.${info.array}`]: done._id } }, opts);
		return;
	}

	const template = await Item.collection.findOne({ _id: oid(grant.templateId) }, opts);
	if (!template) return;
	const info = GRANT_TYPES[template.type] || GRANT_TYPES.default;

	if (info.stack) {
		const userDoc = await users.findOne({ userId }, { ...opts, projection: { [`inventory.${info.array}`]: 1 } });
		const owned = userDoc?.inventory?.[info.array] || [];
		const existing = owned.length ? await items.findOne({ _id: { $in: owned }, name: template.name }, opts) : null;
		if (existing && (info.stack === true || existing.count)) {
			await items.updateOne({ _id: existing._id, ...notApplied(grant.key) }, { $inc: { count: grant.count }, $push: guardPush(grant.key) }, opts);
			return;
		}
	}

	const fields = copyFields(template);
	const now = new Date();
	try {
		await items.insertOne({ ...fields, ...(info.extra || {}), _id: oid(grant.newId), __t: info.t, user: userId, obtained: Date.now(), count: grant.count, appliedOps: [grant.key], createdAt: now, updatedAt: now }, opts);
	}
	catch (error) {
		if (error.code !== 11000) throw error;
	}
	await users.updateOne({ userId }, { $addToSet: { [`inventory.${info.array}`]: oid(grant.newId) } }, opts);
}


module.exports = { oid, notApplied, appliedTo, guardPush, copyFields, rollFishStats, buildFishDoc, insertFishDocs, grantItem, GRANT_TYPES };
