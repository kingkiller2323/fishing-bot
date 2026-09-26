// Additive, idempotent migrations of player data. They only fill fields that are missing and
// never remove or rewrite existing progression. Catalog migrations use guarded updates on catalog
// rows only (no owner); player-owned copies are never touched.
const { User: UserModel } = require('../schemas/UserSchema');
const { FishData } = require('../schemas/FishSchema');
const { Cast } = require('../schemas/CastSchema');
const { Item } = require('../schemas/ItemSchema');
const { migratePublicXp } = require('../engine/publicLevel');
const { migrateLevelFloors } = require('../engine/levels');

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

/**
 * Hotfix L5: the $750 Fishing Crate is removed from the shop. The seed only inserts missing catalog
 * rows, so deployed databases keep `shopItem: true` until this guarded update flips it. Only the
 * catalog row(s) are matched (catalog lives in `items` and has no owner: `user` null or missing);
 * owned crates are per-user `itemdatas` documents and are never touched. Price and the box
 * definition are unchanged, so owned crates still open. Idempotent: once delisted, nothing matches.
 */
async function migrateDelistFishingCrate() {
	const res = await Item.collection.updateMany(
		{ name: 'Fishing Crate', user: null, shopItem: true },
		{ $set: { shopItem: false } },
	);
	return { delisted: res.modifiedCount };
}

async function runMigrations(log) {
	const autoLock = await migrateAutoLockSpecies();
	if (autoLock.scanned > 0) log(`Migration autoLock.species: ${autoLock.scanned} player(s) initialised, ${autoLock.withRules} with species auto-lock.`, 'done');
	const publicXp = await migratePublicXp({ UserModel, Cast });
	if (publicXp.scanned > 0) log(`Migration publicXp: ${publicXp.scanned} player(s) initialised, ${publicXp.withBonus} with private profile bonuses excluded.`, 'done');
	// Level floors from TODAY's curve, after publicXp is final (the public floor anchors on it).
	const floors = await migrateLevelFloors({ UserModel });
	if (floors.scanned > 0) log(`Migration levelFloors: ${floors.scanned} player(s); ${floors.levelFloors} levelFloor and ${floors.publicLevelFloors} publicLevelFloor written from today's curve.`, 'done');
	const crate = await migrateDelistFishingCrate();
	if (crate.delisted > 0) log(`Migration delistFishingCrate: ${crate.delisted} catalog row(s) removed from the shop (shopItem -> false); owned crates untouched.`, 'done');
}

module.exports = { runMigrations, migrateAutoLockSpecies, migratePublicXp, migrateLevelFloors, migrateDelistFishingCrate };
