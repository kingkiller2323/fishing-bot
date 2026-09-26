// Additive, idempotent migrations of player data. They only fill fields that are missing and
// never remove or rewrite existing progression.
const { User: UserModel } = require('../schemas/UserSchema');
const { FishData } = require('../schemas/FishSchema');
const { Cast } = require('../schemas/CastSchema');
const { migratePublicXp } = require('../engine/publicLevel');

/**
 * autoLock.species: before Foundation V2, locking a species also locked future catches of it.
 * Accounts without the field get the species they currently have locked, so behaviour is unchanged.
 */
async function migrateAutoLockSpecies() {
	const users = await UserModel.find({ 'autoLock.species': { $exists: false } }).select('userId inventory.fish').lean();
	let withRules = 0;
	for (const user of users) {
		const names = await FishData.distinct('name', { _id: { $in: user.inventory?.fish || [] }, locked: true });
		const species = [...new Set(names.map((n) => n.toLowerCase()))];
		await UserModel.updateOne({ _id: user._id, 'autoLock.species': { $exists: false } }, { $set: { 'autoLock.species': species } });
		if (species.length > 0) withRules++;
	}
	return { scanned: users.length, withRules };
}

async function runMigrations(log) {
	const autoLock = await migrateAutoLockSpecies();
	if (autoLock.scanned > 0) log(`Migration autoLock.species: ${autoLock.scanned} player(s) initialised, ${autoLock.withRules} with species auto-lock.`, 'done');
	const publicXp = await migratePublicXp({ UserModel, Cast });
	if (publicXp.scanned > 0) log(`Migration publicXp: ${publicXp.scanned} player(s) initialised, ${publicXp.withBonus} with private profile bonuses excluded.`, 'done');
}

module.exports = { runMigrations, migrateAutoLockSpecies, migratePublicXp };
