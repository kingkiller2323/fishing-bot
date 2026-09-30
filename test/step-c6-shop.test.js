// Step C.6 (dark behind the 5B flag): the 5B shop: tabs built only when non-empty, rod ladder states and the
// "$X away" line, bait packs, upgrades, supplies (permits due, repair), the Rod Workshop and its purchases.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { userDoc } = require('./helpers/castFixtures');
const { with5b } = require('./helpers/withFlag');
const view = require('../src/engine/b5/shopView');
const shopOps = require('../src/engine/b5/shopOps');
const Shop5b = require('../src/class/Shop5b');
const levels = require('../src/engine/levels');
const { User: UserModel } = require('../src/schemas/UserSchema');
const { ItemData } = require('../src/schemas/ItemSchema');

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
});
test.after(async () => {
	await stopDb();
	restore();
});

async function atLevel(userId, level, money, extra = {}) {
	const xp = levels.CURVES['5b'].xpForLevel(level);
	await UserModel.updateOne({ userId }, { $set: { xp, publicXp: xp, level, levelFloor: level, publicLevelFloor: level, 'inventory.money': money, permits: [], ...extra } });
}

test('a new player sees only non-empty tabs; the rods tab previews the next rod with the $ away line', async () => {
	await makeUser('c6-new');
	await with5b(async () => {
		await atLevel('c6-new', 1, 1000);
		const ctx = await Shop5b.context('c6-new');
		assert.deepEqual(ctx.tabs.map((t) => t.key), ['rods', 'bait'], 'no upgrades before Lv 5, no supplies without a due permit');
		const rods = ctx.tabs[0];
		assert.deepEqual(rods.rows.map((r) => [r.name, r.status]), [['Trusty Rod', 'locked']]);
		assert.equal(rods.footer, 'Next: Trusty Rod at Lv 10 · you are $4,100 away');
		assert.deepEqual(rods.buyable, []);
		assert.equal(ctx.workshop.open, false);
		const out = Shop5b.render(ctx, 'rods');
		assert.equal(out.components[0].components.length, 2);
	});
});

test('at Lv 10: Trusty Rod buyable, River permit due in Supplies, upgrades listed, Workshop open', async () => {
	await makeUser('c6-ten');
	await with5b(async () => {
		await atLevel('c6-ten', 10, 20000);
		const ctx = await Shop5b.context('c6-ten');
		assert.deepEqual(ctx.tabs.map((t) => t.key), ['rods', 'bait', 'upgrades', 'supplies']);
		assert.deepEqual(ctx.tabs[0].buyable.map((b) => b.id), ['Trusty Rod']);
		assert.deepEqual(ctx.tabs[3].rows.permits, [{ biome: 'River', price: 1000 }]);
		assert.equal(ctx.workshop.open, true);
		assert.deepEqual(ctx.workshop.crates.map((c) => c.name), ['Fishing Crate']);
		// Buying through the shop's dispatcher.
		assert.match(await Shop5b.buy('c6-ten', 'rods', 'Trusty Rod'), /Bought for \$5,100/);
		assert.match(await Shop5b.buy('c6-ten', 'supplies', 'permit:River'), /Bought for \$1,000/);
		assert.match(await Shop5b.buy('c6-ten', 'upgrades', 'casting'), /Bought for \$2,600/);
		const after = await Shop5b.context('c6-ten');
		assert.equal(after.tabs.find((t) => t.key === 'supplies'), undefined, 'nothing due any more');
		assert.deepEqual(after.tabs[0].rows.map((r) => [r.name, r.status]), [['Trusty Rod', 'owned'], ['Angler\'s Rod', 'locked']]);
		assert.equal((await userDoc('c6-ten')).inventory.money, 20000 - 5100 - 1000 - 2600);
	});
});

test('bait packs: packs × 10 units at the pack price, level gated, stacking on the owned stack', async () => {
	await makeUser('c6-bait');
	await with5b(async () => {
		await atLevel('c6-bait', 5, 500);
		assert.equal((await shopOps.buyBaitPacks('c6-bait', 'Worm', 1)).code, 'LEVEL_LOCKED');
		assert.equal((await shopOps.buyBaitPacks('c6-bait', 'Shrimp', 2)).price, 80);
		assert.equal((await shopOps.buyBaitPacks('c6-bait', 'Shrimp', 1)).ok, true);
		const u = await userDoc('c6-bait');
		const stacks = await ItemData.collection.find({ user: 'c6-bait', name: 'Shrimp' }).toArray();
		assert.equal(stacks.reduce((s, x) => s + x.count, 0), 30);
		assert.equal(u.inventory.money, 500 - 120);
		assert.equal((await shopOps.buyBaitPacks('c6-bait', 'Shrimp', 50)).code, 'INSUFFICIENT');
	});
});

test('Rod Workshop crates: tier gate and one crate per purchase at the tier price', async () => {
	await makeUser('c6-crate');
	await with5b(async () => {
		await atLevel('c6-crate', 19, 1e6);
		assert.equal((await shopOps.buyCrate('c6-crate', 'Pro Tackle Crate')).code, 'LEVEL_LOCKED');
		assert.equal((await shopOps.buyCrate('c6-crate', 'Fishing Crate')).price, 4900);
		await atLevel('c6-crate', 20, 1e6);
		assert.equal((await shopOps.buyCrate('c6-crate', 'Pro Tackle Crate')).price, 21000);
		const crates = await ItemData.collection.find({ user: 'c6-crate', type: 'gacha' }).toArray();
		assert.deepEqual(crates.map((c) => c.name).sort(), ['Fishing Crate', 'Pro Tackle Crate']);
		const w = await Shop5b.renderWorkshop('c6-crate');
		assert.match(w.embeds[0].data.title, /Rod Workshop · you are Lv 20/);
	});
});

test('the view is pure data per tab: upgrades show the unlock level when locked', async () => {
	await with5b(async () => {
		const user = { userId: 'x', xp: levels.CURVES['5b'].xpForLevel(5), levelFloor: 5, inventory: { money: 0 }, permits: [], upgrades: { casting: 1 } };
		const tab = view.upgradesTab(5, 0, user);
		const casting = tab.rows.find((r) => r.key === 'casting');
		assert.equal(casting.unlocked, false);
		assert.equal(casting.unlockLevel, 15);
		assert.ok(!tab.buyable.some((b) => b.id === 'casting'));
	});
});
