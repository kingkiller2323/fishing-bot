// Migrations of the 5B release that must run only once the 5B flag is on (at the flip). Each is additive,
// guarded and safe to rerun: a marker (bootstrap runOnce) records it, and each write is guarded on the field
// it adds. Flag-neutral additive migrations live in src/bootstrap/migrations.js.
const { ItemData } = require('../../schemas/ItemSchema');
const { need5b } = require('../balance');

/**
 * P-RODS-FISHING-CRATE option (b): snapshot every owned Fishing Crate stack into an additive legacyCount (= its
 * count at the flip). Those units open first under today's definition; units acquired later open as the T1
 * part crate. Stacks that already carry legacyCount are skipped.
 */
async function migrateLegacyFishingCrates() {
	const marker = need5b().rods.legacyCrate.marker;
	const stacks = await ItemData.collection.find({ name: 'Fishing Crate', user: { $ne: null }, count: { $gte: 1 }, [marker]: { $exists: false } }, { projection: { count: 1 } }).toArray();
	let marked = 0;
	for (const s of stacks) {
		const res = await ItemData.collection.updateOne({ _id: s._id, [marker]: { $exists: false } }, { $set: { [marker]: s.count } });
		marked += res.modifiedCount;
	}
	return { stacks: stacks.length, marked };
}

/** Runs the flag-on migrations (called by bootstrap runMigrations only while the 5B flag is on). */
async function runMigrations5b({ runOnce, log }) {
	const crates = await runOnce('5b-legacy-fishing-crates', migrateLegacyFishingCrates);
	if (!crates.skipped) log(`Migration 5b-legacy-fishing-crates: ${crates.result.marked} owned Fishing Crate stack(s) snapshotted into legacyCount.`, 'done');
}

module.exports = { migrateLegacyFishingCrates, runMigrations5b };
