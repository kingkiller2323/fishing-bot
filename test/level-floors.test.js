// Level floors (P-CURVE-EXISTING, P-FOUNDER-PUBLIC-LEVEL): every level read is max(stored floor,
// curve(xp)) and every level write keeps the floors monotonic. With today's curve the floor equals the
// curve for every account, so nothing visible changes; a floor ABOVE the curve (what the steeper 5B
// curve will produce for existing players) keeps the level and never announces a spurious level-up.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { addPoolFish, useTestRod, userDoc } = require('./helpers/castFixtures');
const { castLine, applyCastResult } = require('../src/engine/cast');
const { levelForXp } = require('../src/engine/balance');
const { CURVES, activeCurve, levelOf, migrateLevelFloors } = require('../src/engine/levels');
const { publicLevelOf, publicProgressOf } = require('../src/engine/publicLevel');
const { levelOfUserDoc, checkLevelGate } = require('../src/engine/levelGate');
const { User } = require('../src/class/User');
const dev = require('../src/engine/dev');
const { rng } = require('../src/engine/rng');
const { resetCooldowns } = require('../src/engine/cooldown');
const { User: UserModel } = require('../src/schemas/UserSchema');
const config = require('../src/config');
const fishCommand = require('../src/commands/slash/Fish/fish.js');

const saved = { developers: config.users.developers };
const DEV = 'floor-dev';

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
	await addPoolFish([{ name: 'Pool Minnow', rarity: 'Common', baseValue: 40 }]);
	config.users.developers = [DEV];
});
test.after(async () => {
	config.users.developers = saved.developers;
	rng.reset();
	await stopDb();
	restore();
});

// Today's formulas, verbatim from before the floors (User.getXPToNextLevel / publicProgressOf).
const oldProgress = (xp) => {
	const level = levelForXp(xp);
	const progress = Math.max(xp - level ** 2 * 100, 0);
	const next = (level + 1) ** 2 * 100 - level ** 2 * 100;
	return `${progress.toLocaleString()} / ${next.toLocaleString()}`;
};
const XP_SAMPLES = [0, 1, 99, 100, 399, 400, 401, 2499, 2500, 9999, 10000, 90000, 249999, 250000, 1234567];

test('the active curve is today\'s 100·L² curve (the 5B curve is a pure function, not selected)', () => {
	assert.equal(activeCurve().name, 'current');
	for (const xp of XP_SAMPLES) assert.equal(activeCurve().levelForXp(xp), levelForXp(xp));
	const c5 = CURVES['5b'];
	assert.equal(c5.xpForLevel(50), 578125);
	assert.equal(c5.levelForXp(578125), 50);
	assert.equal(c5.levelForXp(578124), 49);
	assert.equal(c5.levelForXp(615273), 50);
	assert.equal(c5.levelForXp(615274), 51);
	assert.equal(c5.levelForXp(0), 1);
	for (let l = 1; l <= 200; l++) {
		assert.equal(c5.levelForXp(Math.ceil(c5.xpForLevel(l))), l);
		if (l > 1) assert.equal(c5.levelForXp(Math.ceil(c5.xpForLevel(l)) - 1), l - 1);
	}
});

test('with floor == today\'s curve every level read is identical to before', async () => {
	for (const xp of XP_SAMPLES) {
		for (const doc of [{ xp, publicXp: xp }, { xp, publicXp: xp, levelFloor: levelForXp(xp), publicLevelFloor: levelForXp(xp) }]) {
			const user = new User(doc);
			assert.equal(await user.getLevel(), levelForXp(xp));
			assert.equal(await user.getXPToNextLevel(), oldProgress(xp));
			assert.equal(await user.getPublicLevel(), levelForXp(xp));
			assert.equal(await user.getPublicXPToNextLevel(), oldProgress(xp));
			assert.equal(levelOfUserDoc(doc), levelForXp(xp));
			assert.equal(publicLevelOf(doc), levelForXp(xp));
			assert.equal(publicProgressOf(doc), oldProgress(xp));
		}
	}
});

test('migration writes both floors from today\'s curve, only where missing, idempotently', async () => {
	await UserModel.collection.insertMany([
		{ userId: 'fl-m1', xp: 2500, publicXp: 2500 },
		{ userId: 'fl-m2', xp: 90000, publicXp: 1600 },
		{ userId: 'fl-m3', xp: 700 },
		// Already has a floor (e.g. raised by a cast): never lowered or rewritten.
		{ userId: 'fl-m4', xp: 100, publicXp: 100, levelFloor: 30, publicLevelFloor: 20 },
		// Stored level above today's curve (P-CURVE-EXISTING: the floor keeps the stored level).
		{ userId: 'fl-m5', xp: 2500, publicXp: 2500, level: 12 },
		{ userId: 'fl-m6', xp: 90000, publicXp: 1600, level: 35 },
	]);
	const first = await migrateLevelFloors({ UserModel });
	assert.ok(first.levelFloors >= 3);
	const d = async (id) => userDoc(id);
	assert.deepEqual([(await d('fl-m1')).levelFloor, (await d('fl-m1')).publicLevelFloor], [5, 5]);
	assert.deepEqual([(await d('fl-m2')).levelFloor, (await d('fl-m2')).publicLevelFloor], [30, 4]);
	assert.deepEqual([(await d('fl-m3')).levelFloor, (await d('fl-m3')).publicLevelFloor], [2, 2], 'missing publicXp reads as xp');
	assert.deepEqual([(await d('fl-m4')).levelFloor, (await d('fl-m4')).publicLevelFloor], [30, 20]);
	assert.deepEqual([(await d('fl-m5')).levelFloor, (await d('fl-m5')).publicLevelFloor], [12, 12], 'member: max(stored level, curve) for both');
	assert.deepEqual([(await d('fl-m6')).levelFloor, (await d('fl-m6')).publicLevelFloor], [35, 4], 'private bonuses: public floor from publicXp only');
	const again = await migrateLevelFloors({ UserModel });
	assert.deepEqual(again, { scanned: 0, levelFloors: 0, publicLevelFloors: 0 });
});

test('new accounts start with floors at 1; a cast raises the floors with the curve ($max)', async () => {
	await makeUser('fl-new');
	await useTestRod('fl-new', { capabilities: ['weak', '1'] });
	let doc = await userDoc('fl-new');
	assert.equal(doc.levelFloor, 1);
	assert.equal(doc.publicLevelFloor, 1);
	await UserModel.updateOne({ userId: 'fl-new' }, { $set: { xp: 399, publicXp: 399, level: 1 } });
	const r = await castLine({ userId: 'fl-new' });
	await applyCastResult(r);
	doc = await userDoc('fl-new');
	assert.equal(r.level.levelUp, true);
	assert.equal(doc.level, 2);
	assert.equal(doc.levelFloor, 2);
	assert.equal(doc.publicLevelFloor, 2);
});

function interactionFor(user) {
	const sent = [];
	return {
		sent, user,
		channel: { id: 'chan' },
		guild: { id: 'guild' },
		options: { getUser: () => user },
		deferReply: async (opts) => { sent.push({ kind: 'defer', ...(opts || {}) }); },
		reply: async (p) => { sent.push({ kind: 'reply', ...p }); },
		editReply: async (p) => { sent.push({ kind: 'edit', ...p }); return { createMessageComponentCollector: () => ({ on: () => undefined }) }; },
		followUp: async (p) => { sent.push({ kind: 'followUp', ...p }); return { createMessageComponentCollector: () => ({ on: () => undefined }), edit: async () => undefined }; },
	};
}
const discordUser = (id) => ({ id, displayName: `P${id}`, globalName: `P${id}`, username: `p${id}` });
const levelUpField = (card) => (card.fields || []).find((f) => f.name.includes('Level up'));

test('a floor above the curve (the future steeper curve) keeps the level and never shows a spurious level-up', async () => {
	// 399 XP is Lv 1 on the curve and any cast crosses 400 (curve Lv 2); the floor is Lv 50.
	const id = 'fl-high';
	await makeUser(id);
	await useTestRod(id, { capabilities: ['weak', '1'] });
	await UserModel.updateOne({ userId: id }, { $set: { xp: 399, publicXp: 399, level: 50, levelFloor: 50, publicLevelFloor: 50 } });

	const wrapper = new User(await UserModel.findOne({ userId: id }));
	assert.equal(await wrapper.getLevel(), 50);
	assert.equal(await wrapper.getPublicLevel(), 50);
	assert.equal(await wrapper.getXPToNextLevel(), `0 / ${(51 ** 2 * 100 - 50 ** 2 * 100).toLocaleString()}`, 'progress from the displayed level');
	assert.equal(await wrapper.getPublicXPToNextLevel(), `0 / ${(51 ** 2 * 100 - 50 ** 2 * 100).toLocaleString()}`);
	assert.equal(levelOfUserDoc(await userDoc(id)), 50);
	assert.equal((await checkLevelGate(wrapper, { requirements: { level: 45 } })).ok, true, 'gates read the floor');

	for (let i = 0; i < 5; i++) {
		rng.seed(500 + i);
		resetCooldowns();
		const fi = interactionFor(discordUser(id));
		await fishCommand.run({}, fi, null, discordUser(id));
		const card = fi.sent.find((s) => s.kind === 'followUp').embeds[0].toJSON();
		assert.equal(levelUpField(card), undefined, `cast ${i}: no level-up line below the floor`);
	}
	const doc = await userDoc(id);
	assert.ok(doc.xp > 400, 'the curve level rose (Lv 1 -> 2+) under the floor');
	assert.equal(doc.level, 50, 'the stored level is never written below the floor');
	assert.equal(doc.levelFloor, 50);
	assert.equal(doc.publicLevelFloor, 50);
	const r = await castLine({ userId: id });
	assert.deepEqual([r.level.before, r.level.after, r.level.levelUp], [50, 50, false]);
	assert.deepEqual([r.level.public.before, r.level.public.after, r.level.public.levelUp], [50, 50, false]);

	// Once the curve passes the floor, levels rise normally and the line names the new level.
	await UserModel.updateOne({ userId: id }, { $set: { xp: 51 ** 2 * 100 - 1, publicXp: 51 ** 2 * 100 - 1 } });
	resetCooldowns();
	const fi = interactionFor(discordUser(id));
	await fishCommand.run({}, fi, null, discordUser(id));
	const card = fi.sent.find((s) => s.kind === 'followUp').embeds[0].toJSON();
	assert.match(levelUpField(card).value, /level \*\*51\*\*/);
	assert.equal((await userDoc(id)).levelFloor, 51);
});

test('/dev xp: add never lowers the level or a floor; set is the explicit, audited reset', async () => {
	const id = 'fl-dev';
	await makeUser(id);
	await UserModel.updateOne({ userId: id }, { $set: { xp: 10000, publicXp: 10000, levelFloor: 10, publicLevelFloor: 10 } });
	let r = await dev.xp(DEV, id, 'add', -9000);
	let doc = await userDoc(id);
	assert.equal(doc.xp, 1000);
	assert.deepEqual([r.after.level, doc.level, doc.levelFloor, doc.publicLevelFloor, levelOf(doc)], [10, 10, 10, 10, 10]);
	r = await dev.xp(DEV, id, 'add', 20000);
	doc = await userDoc(id);
	assert.deepEqual([r.after.level, doc.levelFloor, doc.publicLevelFloor], [14, 14, 14]);
	r = await dev.xp(DEV, id, 'set', 400);
	doc = await userDoc(id);
	assert.deepEqual([r.after.level, doc.level, doc.levelFloor, doc.publicLevelFloor, levelOf(doc)], [2, 2, 2, 2, 2]);
	const { DevAudit } = require('../src/schemas/DevAuditSchema');
	const audit = await DevAudit.findOne({ target: id, operation: 'xp.set' }).lean();
	assert.deepEqual(audit.details.floors.before, { levelFloor: 14, publicLevelFloor: 14, publicLevel: 14 });
	assert.deepEqual(audit.details.floors.after, { levelFloor: 2, publicLevelFloor: 2, publicLevel: 2 });
});
