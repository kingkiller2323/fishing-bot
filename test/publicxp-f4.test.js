// publicXp self-healing (founder F4): a cast on a document without publicXp starts it from the
// document's own xp; a one-time, marker-guarded reconcile repairs what earlier code left wrong; a
// read-only boot check reports members whose publicXp != xp.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { addPoolFish, useTestRod, userDoc } = require('./helpers/castFixtures');
const { castLine, applyCastResult, recoverPendingCasts } = require('../src/engine/cast');
const { migratePublicXp, reconcilePublicXp, checkPublicXp, expectedPublicXp } = require('../src/engine/publicLevel');
const { runMigrations, migrateReconcilePublicXp, PUBLIC_XP_RECONCILE } = require('../src/bootstrap/migrations');
const dev = require('../src/engine/dev');
const { rng } = require('../src/engine/rng');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { Cast } = require('../src/schemas/CastSchema');
const { DevAudit } = require('../src/schemas/DevAuditSchema');
const config = require('../src/config');

const saved = { founders: config.users.founders, developers: config.users.developers };
const DEV = 'f4-dev';

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
	await addPoolFish([{ name: 'Pool Minnow', rarity: 'Common', baseValue: 40 }]);
	config.users.developers = [DEV];
});
test.after(async () => {
	config.users.founders = saved.founders;
	config.users.developers = saved.developers;
	rng.reset();
	await stopDb();
	restore();
});

/** A player whose document has no publicXp (as before the hotfix migration reached it). */
async function legacyPlayer(id, xp) {
	await makeUser(id);
	await useTestRod(id, { capabilities: ['weak', '1'] });
	await UserModel.collection.updateOne({ userId: id }, { $set: { xp }, $unset: { publicXp: 1 } });
}

test('F4: a cast on a legacy member document without publicXp leaves publicXp == xp; a later migration keeps it', async () => {
	await legacyPlayer('f4-member', 5000);
	rng.seed(11);
	const r = await castLine({ userId: 'f4-member' });
	await applyCastResult(r);
	let d = await userDoc('f4-member');
	assert.equal(d.xp, 5000 + r.xp.total);
	assert.equal(d.publicXp, d.xp, 'started from its own xp, not from 0');
	await migratePublicXp({ UserModel, Cast });
	await reconcilePublicXp({ UserModel, Cast, DevAudit });
	d = await userDoc('f4-member');
	assert.equal(d.publicXp, d.xp);
});

test('F4: a cast interrupted after the publicXp init but before the commit recovers exactly once', async () => {
	await legacyPlayer('f4-crash', 2000);
	const r = await castLine({ userId: 'f4-crash' });
	await assert.rejects(applyCastResult(r, { fault: async (s) => { if (s === 'commit') throw new Error('boom'); } }));
	assert.equal((await userDoc('f4-crash')).publicXp, 2000, 'initialised from xp');
	await recoverPendingCasts({ userId: 'f4-crash' });
	await recoverPendingCasts({ userId: 'f4-crash' });
	const d = await userDoc('f4-crash');
	assert.equal(d.xp, 2000 + r.xp.total);
	assert.equal(d.publicXp, d.xp);
});

test('F4: a Founder document without publicXp starts from its xp and adds only the base XP', async () => {
	await legacyPlayer('f4-founder', 3000);
	config.users.founders = ['f4-founder'];
	try {
		rng.seed(12);
		const r = await castLine({ userId: 'f4-founder' });
		assert.equal(r.profile, 'founder');
		await applyCastResult(r);
		const d = await userDoc('f4-founder');
		assert.equal(d.publicXp, 3000 + r.rewards.xp.base);
		assert.ok(d.publicXp < d.xp);
	}
	finally {
		config.users.founders = saved.founders;
	}
});

test('F4: developer XP grants on a document without publicXp heal it from xp', async () => {
	await legacyPlayer('f4-devgrant', 700);
	await dev.xp(DEV, 'f4-devgrant', 'add', 50);
	const d = await userDoc('f4-devgrant');
	assert.equal(d.xp, 750);
	assert.equal(d.publicXp, 750);
});

test('reconcile: members get publicXp = xp; a Founder is recomputed from its committed journals', async () => {
	await UserModel.collection.insertMany([
		// A member whose publicXp was created by $inc from zero (the F4 edge case).
		{ userId: 'rc-member', xp: 5000, publicXp: 40 },
		// A Founder that missed casts during a deploy overlap: publicXp too low.
		{ userId: 'rc-founder', xp: 9000, publicXp: 10, appliedOps: ['rc-f3'] },
		// A Founder with a developer `xp set` after its first journal.
		{ userId: 'rc-set', xp: 1500, publicXp: 1500 },
	]);
	const t0 = new Date(Date.now() - 3 * 60_000);
	const t1 = new Date(Date.now() - 2 * 60_000);
	const t2 = new Date(Date.now() - 60_000);
	await Cast.collection.insertMany([
		{ _id: 'rc-m1', userId: 'rc-member', status: 'applied', createdAt: t0, result: { rewards: { xp: { base: 20, profileBonus: 0, final: 20 } } } },
		{ _id: 'rc-f1', userId: 'rc-founder', status: 'applied', createdAt: t0, result: { rewards: { xp: { base: 100, profileBonus: 400, final: 500 } } } },
		// Pending, but its user update committed (its key is on the user's guard): its bonus counts.
		{ _id: 'rc-f3', userId: 'rc-founder', status: 'pending', createdAt: t1, result: { rewards: { xp: { base: 10, profileBonus: 40, final: 50 } } } },
		// Pending and NOT committed: the engine applies it later (adding its base), so it does not count.
		{ _id: 'rc-f4', userId: 'rc-founder', status: 'pending', createdAt: t1, result: { rewards: { xp: { base: 10, profileBonus: 90, final: 100 } } } },
		{ _id: 'rc-s1', userId: 'rc-set', status: 'applied', createdAt: t0, result: { rewards: { xp: { base: 100, profileBonus: 900, final: 1000 } } } },
		{ _id: 'rc-s2', userId: 'rc-set', status: 'applied', createdAt: t2, result: { rewards: { xp: { base: 100, profileBonus: 400, final: 500 } } } },
	]);
	// /dev xp set 1000 between rc-s1 and rc-s2: xp and publicXp were both set to 1000 then.
	await DevAudit.collection.insertOne({ actor: DEV, target: 'rc-set', operation: 'xp.set', before: {}, after: { xp: 1000, publicXp: 1000 }, timestamp: t1 });

	assert.deepEqual(await expectedPublicXp(await userDoc('rc-founder'), { Cast, DevAudit }), { publicXp: 9000 - 440, bonus: 440 });
	const res = await reconcilePublicXp({ UserModel, Cast, DevAudit });
	assert.equal((await userDoc('rc-member')).publicXp, 5000);
	assert.equal((await userDoc('rc-founder')).publicXp, 8560);
	assert.equal((await userDoc('rc-set')).publicXp, 1100, 'only journals after the last xp set count');
	const audit = Object.fromEntries(res.recomputed.map((f) => [f.userId, f]));
	assert.deepEqual(audit['rc-founder'], { userId: 'rc-founder', xp: 9000, before: 10, after: 8560, bonus: 440 });
	assert.ok(res.membersChanged >= 1);
	// Running it again changes nothing.
	const again = await reconcilePublicXp({ UserModel, Cast, DevAudit });
	assert.equal(again.membersChanged, 0);
	assert.equal((await userDoc('rc-founder')).publicXp, 8560);
});

test('reconcile migration runs once (marker) and logs its result; the boot check is read-only', async () => {
	const markers = mongoose.connection.db.collection('migrations');
	await markers.deleteOne({ _id: PUBLIC_XP_RECONCILE });
	await UserModel.collection.insertOne({ userId: 'rc-once', xp: 800, publicXp: 1 });
	const lines = [];
	config.users.founders = ['f4-founder', 'rc-founder', 'rc-set'];
	try {
		await runMigrations((line, style) => lines.push([line, style]));
	}
	finally {
		config.users.founders = saved.founders;
	}
	assert.equal((await userDoc('rc-once')).publicXp, 800);
	const marker = await markers.findOne({ _id: PUBLIC_XP_RECONCILE });
	assert.ok(marker?.appliedAt, 'marker written');
	assert.ok(lines.some(([l]) => l.startsWith(`Migration ${PUBLIC_XP_RECONCILE}:`)), JSON.stringify(lines));
	assert.ok(lines.some(([l, s]) => /^Check publicXp: all \d+ member\(s\) have publicXp == xp\.$/.test(l) && s === 'info'), JSON.stringify(lines));

	// Guarded: with the marker present it does not run again, even if data drifted.
	await UserModel.collection.updateOne({ userId: 'rc-once' }, { $set: { publicXp: 2 } });
	assert.deepEqual(await migrateReconcilePublicXp(), { skipped: true });
	assert.equal((await userDoc('rc-once')).publicXp, 2);

	// The check reports the drift (read-only: it does not repair it) and ignores Founders.
	await UserModel.collection.insertOne({ userId: 'rc-check-founder', xp: 900, publicXp: 100 });
	const check = await checkPublicXp({ UserModel, founders: ['f4-founder', 'rc-founder', 'rc-set', 'rc-check-founder'] });
	assert.equal(check.mismatched, 1);
	assert.deepEqual(check.sample, ['rc-once']);
	assert.equal((await userDoc('rc-once')).publicXp, 2, 'the check never writes');
	const warn = [];
	config.users.founders = ['f4-founder', 'rc-founder', 'rc-set', 'rc-check-founder'];
	try {
		await runMigrations((line, style) => warn.push([line, style]));
	}
	finally {
		config.users.founders = saved.founders;
	}
	assert.ok(warn.some(([l, s]) => /^Check publicXp: 1 of \d+ member\(s\) have publicXp != xp \(e\.g\. …once\)\.$/.test(l) && s === 'warn'), JSON.stringify(warn));
	await UserModel.collection.updateOne({ userId: 'rc-once' }, { $set: { publicXp: 800 } });
});
