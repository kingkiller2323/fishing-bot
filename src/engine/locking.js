// Two separate protection concepts:
//   - Individual lock: FishData.locked on one specific catch (protects that fish).
//   - Auto-lock rules: user.autoLock decides which FUTURE catches start locked.
//     `species` holds species names; `rules` is reserved for rarity/variant/record/value rules.
// The current /lock <species> command uses both: it locks what you own and auto-locks the species.
const { User: UserModel } = require('../schemas/UserSchema');
const { FishData } = require('../schemas/FishSchema');

const norm = (name) => String(name).trim().toLowerCase();
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Locks or unlocks one specific fish owned by the player. */
async function setFishLocked(userId, fishId, locked) {
	const res = await FishData.updateOne({ _id: fishId, user: String(userId) }, { $set: { locked: Boolean(locked) } });
	return res.matchedCount > 0;
}

/** Locks or unlocks every owned fish of a species (case-insensitive). Returns how many changed. */
async function setOwnedSpeciesLocked(userId, species, locked) {
	const user = await UserModel.findOne({ userId: String(userId) }).select('inventory.fish').lean();
	if (!user) return 0;
	const res = await FishData.updateMany(
		{ _id: { $in: user.inventory?.fish || [] }, name: new RegExp(`^${escape(String(species).trim())}$`, 'i'), locked: { $ne: Boolean(locked) } },
		{ $set: { locked: Boolean(locked) } },
	);
	return res.modifiedCount;
}

/** Turns species auto-lock on or off for future catches. */
async function setSpeciesAutoLock(userId, species, enabled) {
	const update = enabled
		? { $addToSet: { 'autoLock.species': norm(species) } }
		: { $pull: { 'autoLock.species': norm(species) } };
	await UserModel.updateOne({ userId: String(userId) }, update);
}

module.exports = { setFishLocked, setOwnedSpeciesLocked, setSpeciesAutoLock };
