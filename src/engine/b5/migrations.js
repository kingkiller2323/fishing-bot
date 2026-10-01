// Migrations of the 5B release that must run only once the 5B flag is on (at the flip). Each is additive,
// guarded and safe to rerun: a marker (bootstrap runOnce) records it, and each write is guarded on the field
// it adds. Flag-neutral additive migrations live in src/bootstrap/migrations.js.
const { ItemData } = require('../../schemas/ItemSchema');
const { User: UserModel } = require('../../schemas/UserSchema');
const { DevAudit } = require('../../schemas/DevAuditSchema');
const { need5b, levelForXp, isFounderId } = require('../balance');
const { gateLevelOf } = require('../levelGate');
const world = require('./world');

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

/**
 * P-WORLD-GRANDFATHER: every account WITHOUT a permits field gets its grandfathered permits (live biomes at or
 * below max(stored level, today's curve level of xp), plus its current biome). Only the missing field is set
 * (guarded), so a second run, or an account that has the field (even empty), is untouched.
 */
async function migrateBiomePermits({ now = new Date() } = {}) {
	const users = await UserModel.collection.find({ permits: { $exists: false } }, { projection: { userId: 1, level: 1, xp: 1, currentBiome: 1 } }).toArray();
	let written = 0;
	for (const u of users) {
		const permits = world.grandfatheredPermits(u, { now, legacyLevelForXp: levelForXp });
		const res = await UserModel.collection.updateOne({ _id: u._id, permits: { $exists: false } }, { $set: { permits } });
		written += res.modifiedCount;
	}
	return { scanned: users.length, written };
}

/**
 * P-FOUNDER-MIGRATION (with P-FOUNDER-GATE): a real Founder (FOUNDER_IDS) whose current biome is not legal for
 * its gate (public) level and permits is moved to the highest legal biome, guarded on the biome it had, so the
 * cast guard never shows on a public card. Audited per account; rerunning moves nothing.
 */
async function migrateFounderBiome() {
	const moved = [];
	const founders = await UserModel.collection.find({ userId: { $in: (require('../../config').users?.founders || []).map(String) } }).toArray();
	for (const u of founders.filter((x) => isFounderId(x.userId))) {
		const level = gateLevelOf(u);
		if (world.canFish(level, u.permits, u.currentBiome || 'ocean')) continue;
		const target = world.highestAccessible(level, u.permits).toLowerCase();
		const res = await UserModel.collection.updateOne({ _id: u._id, currentBiome: u.currentBiome }, { $set: { currentBiome: target } });
		if (res.modifiedCount === 1) {
			moved.push({ from: u.currentBiome, to: target, gateLevel: level });
			await DevAudit.create({ actor: 'migration', target: String(u.userId), operation: '5b-founder-biome', details: { gateLevel: level }, before: { currentBiome: u.currentBiome }, after: { currentBiome: target } });
		}
	}
	return { moved };
}

/**
 * P-QUESTS-LEGACY questLog backfill: each player's completed QuestData, by title mapped to its 5B key, is
 * recorded in questLog with $max (completions, lastCompletedAt) and $min (firstCompletedAt). Nothing is
 * deleted or rewritten; rerunning changes nothing.
 */
async function migrateQuestLog() {
	const { QuestData } = require('../../schemas/QuestSchema');
	const { logField } = require('./quests');
	const map = need5b().quests.legacyMap;
	const rows = await QuestData.collection.aggregate([
		{ $match: { status: 'completed', user: { $ne: null }, kind: { $exists: false } } },
		{ $group: { _id: { user: '$user', title: '$title' }, n: { $sum: 1 }, first: { $min: { $ifNull: ['$endDate', 0] } }, last: { $max: { $ifNull: ['$endDate', 0] } } } },
	]).toArray();
	const byUser = new Map();
	for (const r of rows) {
		const key = map[r._id.title];
		if (!key) continue;
		const u = byUser.get(r._id.user) || {};
		const f = logField(key);
		const cur = u[f] || { completions: 0, first: Infinity, last: 0 };
		u[f] = { completions: cur.completions + r.n, first: Math.min(cur.first, r.first || 0), last: Math.max(cur.last, r.last || 0) };
		byUser.set(r._id.user, u);
	}
	let written = 0;
	for (const [userId, log] of byUser) {
		const max = {};
		const min = {};
		for (const [f, v] of Object.entries(log)) {
			max[`questLog.${f}.completions`] = v.completions;
			max[`questLog.${f}.lastCompletedAt`] = v.last;
			min[`questLog.${f}.firstCompletedAt`] = v.first;
		}
		const res = await UserModel.collection.updateOne({ userId }, { $max: max, $min: min });
		written += res.modifiedCount;
	}
	return { players: byUser.size, written };
}

/** Clears legacy activations that already ended (display only; counts untouched; P-BUFFS migration 1). */
async function migrateStaleBuffActivations(now = Date.now()) {
	const { BuffData } = require('../../schemas/BuffSchema');
	const res = await BuffData.collection.updateMany({ active: true, endTime: { $lte: now } }, { $set: { active: false } });
	return { cleared: res.modifiedCount };
}

/** Runs the flag-on migrations (called by bootstrap runMigrations only while the 5B flag is on). */
async function runMigrations5b({ runOnce, log }) {
	const crates = await runOnce('5b-legacy-fishing-crates', migrateLegacyFishingCrates);
	if (!crates.skipped) log(`Migration 5b-legacy-fishing-crates: ${crates.result.marked} owned Fishing Crate stack(s) snapshotted into legacyCount.`, 'done');
	// Permits before the Founder move: the move reads the grandfathered permits.
	const permits = await migrateBiomePermits();
	if (permits.written > 0) log(`Migration 5b-biome-permits: ${permits.written} account(s) received their grandfathered permits.`, 'done');
	const questLog = await runOnce('5b-quest-log', migrateQuestLog);
	if (!questLog.skipped) log(`Migration 5b-quest-log: ${questLog.result.players} player(s) have legacy completions recorded in questLog.`, 'done');
	const stale = await migrateStaleBuffActivations();
	if (stale.cleared > 0) log(`Migration 5b-stale-buffs: ${stale.cleared} ended booster activation(s) marked inactive (counts untouched).`, 'done');
	const founder = await migrateFounderBiome();
	for (const m of founder.moved) log(`Migration 5b-founder-biome: a Founder account moved from ${m.from} to ${m.to} (gate level ${m.gateLevel}).`, 'done');
}

module.exports = { migrateStaleBuffActivations, migrateQuestLog, migrateLegacyFishingCrates, migrateBiomePermits, migrateFounderBiome, runMigrations5b };
