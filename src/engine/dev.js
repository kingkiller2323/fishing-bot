// Developer operations behind /dev. Every mutation is authorised against DEVELOPER_IDS and writes a
// DevAudit record (actor, target, operation, before, after, timestamp).
const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types;
const config = require('../config');
const { User } = require('../class/User');
const { User: UserModel } = require('../schemas/UserSchema');
const { Fish: FishTemplate, FishData } = require('../schemas/FishSchema');
const { Item, ItemData } = require('../schemas/ItemSchema');
const { DevAudit } = require('../schemas/DevAuditSchema');
const { BALANCE_VERSION, isFounderId } = require('./balance');
const { publicXpOf, publicLevelOf } = require('./publicLevel');
const { levelOf, curveLevel, floorOf, levelWithFloor } = require('./levels');
const { grantItem } = require('./cast');
const { Utils } = require('../class/Utils');

class DevAuthError extends Error {
	constructor(actor) {
		super(`User ${actor} is not a developer.`);
		this.name = 'DevAuthError';
		this.code = 'NOT_DEVELOPER';
	}
}

function assertDeveloper(actor, cfg = config) {
	if (!(cfg.users?.developers || []).includes(String(actor))) throw new DevAuthError(actor);
}

async function audit(actor, target, operation, before, after, details = {}) {
	return DevAudit.create({ actor: String(actor), target: String(target), operation, before, after, details, timestamp: new Date() });
}

/** Ensures the target player exists and returns their current document. */
async function targetDoc(target) {
	await User.get(String(target));
	return UserModel.findOne({ userId: String(target) }).lean();
}

const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function money(actor, target, mode, amount) {
	assertDeveloper(actor);
	if (!Number.isFinite(amount)) throw new Error('Amount must be a number.');
	const before = (await targetDoc(target)).inventory.money || 0;
	const update = mode === 'set' ? { $set: { 'inventory.money': amount } } : { $inc: { 'inventory.money': amount } };
	await UserModel.updateOne({ userId: String(target) }, update);
	const after = (await UserModel.findOne({ userId: String(target) }).lean()).inventory.money;
	await audit(actor, target, `money.${mode}`, { money: before }, { money: after }, { amount });
	return { before, after };
}

async function xp(actor, target, mode, amount) {
	assertDeveloper(actor);
	if (!Number.isFinite(amount)) throw new Error('Amount must be a number.');
	const doc = await targetDoc(target);
	const publicBefore = publicXpOf(doc);
	const before = { xp: doc.xp || 0, level: levelOf(doc), publicXp: publicBefore };
	const floorsBefore = { levelFloor: doc.levelFloor ?? null, publicLevelFloor: doc.publicLevelFloor ?? null, publicLevel: publicLevelOf(doc) };
	const newXp = Math.max(0, mode === 'set' ? amount : before.xp + amount);
	// A developer XP change applies to the public XP too (set -> the same value, add -> the same delta),
	// never leaving publicXp above xp. publicXpOf already falls back to xp for a document without the
	// field, so the write heals it (F4).
	const newPublic = Math.min(newXp, Math.max(0, mode === 'set' ? amount : publicBefore + amount));
	// Levels: `add` keeps max(stored floor, curve) and never lowers a floor; `set` is the one explicit,
	// audited demotion: both floors are reset to the curve of the new values.
	const level = mode === 'set' ? curveLevel(newXp) : levelWithFloor(doc.levelFloor, newXp);
	const publicLevel = mode === 'set' ? curveLevel(newPublic) : levelWithFloor(doc.publicLevelFloor, newPublic);
	const update = mode === 'set'
		? { $set: { xp: newXp, level, publicXp: newPublic, levelFloor: level, publicLevelFloor: publicLevel } }
		: { $set: { xp: newXp, level, publicXp: newPublic }, $max: { levelFloor: level, publicLevelFloor: publicLevel } };
	await UserModel.updateOne({ userId: String(target) }, update);
	const stored = await UserModel.findOne({ userId: String(target) }).lean();
	const after = { xp: newXp, level, publicXp: newPublic };
	const floorsAfter = { levelFloor: floorOf(stored?.levelFloor), publicLevelFloor: floorOf(stored?.publicLevelFloor), publicLevel };
	await audit(actor, target, `xp.${mode}`, before, after, { amount, floors: { before: floorsBefore, after: floorsAfter } });
	return { before, after };
}

/** Gives catalog items (stacks like normal inventory). */
async function give(actor, target, itemName, count = 1) {
	assertDeveloper(actor);
	const template = await Item.findOne({ name: new RegExp(`^${escape(itemName)}$`, 'i'), user: null }).lean();
	if (!template) throw new Error(`No catalog item named "${itemName}".`);
	await targetDoc(target);
	const owned = async () => (await ItemData.find({ user: String(target), name: template.name }).lean()).reduce((s, i) => s + (i.count || 0), 0);
	const before = await owned();
	const key = `dev:${new ObjectId()}`;
	await grantItem(String(target), { key, templateId: String(template._id), count: Math.max(1, Math.floor(count)), newId: new ObjectId().toString(), reason: 'dev' });
	const after = await owned();
	await audit(actor, target, 'give', { [template.name]: before }, { [template.name]: after }, { item: template.name, count });
	return { item: template.name, before, after };
}

/** Spawns a specific fish into the target's inventory. Always non-competitive. */
async function spawn(actor, target, fishName, { count = 1, size, weight } = {}) {
	assertDeveloper(actor);
	const template = await FishTemplate.findOne({ name: new RegExp(`^${escape(fishName)}$`, 'i'), user: null }).lean();
	if (!template) throw new Error(`No catalog fish named "${fishName}".`);
	await targetDoc(target);
	const s = Number.isFinite(size) ? size : parseFloat((await Utils.binomialRandomInRange(10, 0.5, template.minSize, template.maxSize)).toFixed(3));
	const w = Number.isFinite(weight) ? weight : parseFloat((await Utils.binomialRandomInRange(10, 0.5, template.minWeight, template.maxWeight)).toFixed(3));
	const value = parseInt(await require('../class/Fish').Fish.calculateSellValue(template.baseValue, s, w, template.rarity), 10);
	const fields = Object.fromEntries(Object.entries(template).filter(([k]) => !['_id', '__v', 'createdAt', 'updatedAt', 'appliedOps', 'appliedCasts'].includes(k)));
	const _id = new ObjectId();
	const now = new Date();
	await FishData.collection.insertOne({
		...fields, _id, __t: 'FishData', user: String(target), obtained: Date.now(), count: Math.max(1, Math.floor(count)),
		size: s, weight: w, value, locked: false, profile: 'dev-spawn', balanceVersion: BALANCE_VERSION, competitiveEligible: false, createdAt: now, updatedAt: now,
	});
	await UserModel.updateOne({ userId: String(target) }, { $push: { 'inventory.fish': _id } });
	await audit(actor, target, 'spawn', null, { fishId: String(_id), name: template.name, count, size: s, weight: w, value }, { fish: template.name });
	return { fishId: String(_id), name: template.name, size: s, weight: w, value };
}

/** Temporary Luck override (value 0 clears it). Catches under it are non-competitive. */
async function luck(actor, target, value, minutes = 60) {
	assertDeveloper(actor);
	const doc = await targetDoc(target);
	const before = doc.devOverrides?.luck || null;
	const after = value ? { value, expiresAt: new Date(Date.now() + minutes * 60_000) } : null;
	await UserModel.updateOne({ userId: String(target) }, after ? { $set: { 'devOverrides.luck': after } } : { $unset: { 'devOverrides.luck': 1 } });
	await audit(actor, target, 'luck', before, after, { value, minutes });
	return { before, after };
}

// /dev founder modes -> profile override stored on the player (FOUNDER_IDS itself is never changed).
const FOUNDER_MODES = { on: 'founder', off: 'normal', test: 'test', default: null };

/**
 * Per-player profile override: 'on' (Founder) | 'off' (Normal) | 'test' | 'default' (FOUNDER_IDS decides).
 * P-FOUNDER-DEV-OVERRIDE (locked): the override changes cast mechanics only. Identity stays FOUNDER_IDS:
 * a real Founder is never competitive and its gates never follow the override (balance.resolveProfile,
 * levelGate.gateLevelOf). 'on' is refused for a non-Founder (use 'test'), before anything is written.
 * When a non-Founder returns to Normal ('off' / 'default'), the Normal invariant is restored in the same
 * audited update: publicXp = xp and publicLevelFloor raised to levelFloor. A real Founder's publicXp is never touched.
 */
async function founder(actor, target, mode) {
	assertDeveloper(actor);
	if (!(mode in FOUNDER_MODES)) throw new Error('Mode must be on, off, test or default.');
	const founderIdentity = isFounderId(target);
	if (mode === 'on' && !founderIdentity) {
		throw Object.assign(new Error('`on` is only for FOUNDER_IDS accounts. Use `test` to test on a non-Founder account.'), { code: 'NOT_FOUNDER' });
	}
	const doc = await targetDoc(target);
	const before = doc.devOverrides?.profile || 'default';
	const profile = FOUNDER_MODES[mode];
	const update = profile ? { $set: { 'devOverrides.profile': profile } } : { $unset: { 'devOverrides.profile': 1 } };
	const filter = { userId: String(target) };
	let repair = null;
	if (!founderIdentity && (mode === 'off' || mode === 'default')) {
		const realXp = doc.xp || 0;
		const levelFloor = floorOf(doc.levelFloor);
		const publicFloor = floorOf(doc.publicLevelFloor);
		const floorAfter = Math.max(publicFloor, levelFloor);
		if (doc.publicXp !== realXp || floorAfter !== publicFloor) {
			repair = { publicXp: { before: doc.publicXp ?? null, after: realXp }, publicLevelFloor: { before: doc.publicLevelFloor ?? null, after: floorAfter } };
			update.$set = { ...(update.$set || {}), publicXp: realXp, publicLevelFloor: floorAfter };
			// Compare-and-set on xp: a cast landing in between is never overwritten.
			filter.xp = doc.xp;
		}
	}
	const res = await UserModel.updateOne(filter, update);
	if (res.matchedCount === 0) throw new Error('The account changed while updating; nothing was written. Try again.');
	await audit(actor, target, 'founder', { profile: before }, { profile: profile || 'default' }, repair ? { mode, repair } : { mode });
	return { before, after: profile || 'default', repair };
}

module.exports = { assertDeveloper, DevAuthError, money, xp, give, spawn, luck, founder, audit };
