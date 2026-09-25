const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDb, stopDb } = require('./helpers/db');
const { quiet, restore } = require('./helpers/quiet');
const { seedGame, makeUser } = require('./helpers/fixtures');
const { userDoc } = require('./helpers/castFixtures');
const { giveBox, withTestBox, ALL } = require('./helpers/gachaFixtures');
const { openLine, applyGachaResult, recoverPendingOpens, openBox, buildPools, baseTable, canonicalRarity } = require('../src/engine/gacha');
const { boxDefinition, BOXES } = require('../src/engine/gachaBoxes');
const { buildTable, roll } = require('../src/engine/rarity');
const { PROFILES, RARITIES } = require('../src/engine/balance');
const { createRng, rng } = require('../src/engine/rng');
const { ItemData } = require('../src/schemas/ItemSchema');
const { FishData } = require('../src/schemas/FishSchema');
const { GachaOpen } = require('../src/schemas/GachaOpenSchema');
const { User: UserModel } = require('../src/schemas/UserSchema');
const config = require('../src/config');

const savedFounders = config.users.founders;
const sum = (t) => RARITIES.reduce((s, r) => s + t[r], 0);
const itemsOwned = async (userId, name) => (await ItemData.find({ user: userId, name }).lean()).reduce((s, i) => s + (i.count || 0), 0);

test.before(async () => {
	quiet();
	await startDb();
	await seedGame();
	config.users.founders = ['founder-g'];
});
test.after(async () => {
	config.users.founders = savedFounders;
	rng.reset();
	await stopDb();
	restore();
});

test('canonical rarity: legacy casing is normalised at the boundary', () => {
	assert.equal(canonicalRarity('Rare'), 'rare');
	assert.equal(canonicalRarity('common'), 'common');
	assert.equal(canonicalRarity(' LUCKY '), 'lucky');
	assert.equal(canonicalRarity('mythic'), null);
});

test('every catalog box has a definition, non-empty pools and a normalised table', async () => {
	for (const name of ['Fishing Crate', 'Booster Pack', 'Voter\'s Crate', 'Daily Box']) {
		const def = boxDefinition(name);
		const pools = await buildPools(def);
		const t = baseTable(def, pools);
		assert.ok(Math.abs(sum(t) - 1) < 1e-9, name);
		for (const r of RARITIES) if (t[r] > 0) assert.ok(pools[r].length > 0, `${name} ${r} has rewards`);
	}
});

test('box-specific pools: each box only gives its own reward types', async () => {
	const types = async (name) => {
		const pools = await buildPools(boxDefinition(name));
		return new Set(Object.values(pools).flat().map((e) => (e.kind === 'fish' ? 'fish' : e.template.type)));
	};
	assert.deepEqual([...await types('Booster Pack')], ['buff']);
	const crate = await types('Fishing Crate');
	assert.ok(!crate.has('fish') && !crate.has('buff') && crate.has('bait') && crate.has('part_rod'));
	const daily = await types('Daily Box');
	assert.ok(daily.has('fish') && daily.has('buff') && !daily.has('rod'));
	assert.ok((await types('Voter\'s Crate')).has('rod'));
	// Fish rewards only come from catchable fish (no unknown-biome fish).
	const fish = Object.values(await buildPools(boxDefinition('Daily Box'))).flat().filter((e) => e.kind === 'fish');
	assert.ok(!fish.some((e) => e.template.biome === 'Mountain Stream'));
});

test('slots roll independently (not one rarity for the whole box)', async () => {
	await makeUser('indep');
	await giveBox('indep', 'Daily Box', 60);
	rng.seed(77);
	let mixed = 0;
	for (let i = 0; i < 60; i++) {
		const r = await openBox({ userId: 'indep', boxName: 'Daily Box' });
		assert.equal(r.slots.length, 3);
		if (new Set(r.slots.map((s) => s.rarity)).size > 1) mixed++;
	}
	// P(3 identical rarities) = sum p^3 ~ 34%; the old shared roll would give 0 mixed opens.
	assert.ok(mixed > 20, `mixed opens: ${mixed}`);
});

test('independent slot odds match the box table over a large seeded simulation', async () => {
	const def = boxDefinition('Daily Box');
	const table = baseTable(def, await buildPools(def));
	const r = createRng(11);
	const n = 300_000;
	const counts = Object.fromEntries(RARITIES.map((k) => [k, 0]));
	let allSame = 0;
	for (let i = 0; i < n / 3; i++) {
		const rs = [roll(table, r), roll(table, r), roll(table, r)];
		rs.forEach((x) => counts[x]++);
		if (rs[0] === rs[1] && rs[1] === rs[2]) allSame++;
	}
	for (const k of RARITIES) {
		const p = table[k];
		assert.ok(Math.abs(counts[k] / n - p) <= 5 * Math.sqrt(p * (1 - p) / n) + 1e-12, k);
	}
	const expectedSame = RARITIES.reduce((s, k) => s + table[k] ** 3, 0);
	assert.ok(Math.abs(allSame / (n / 3) - expectedSame) < 0.01);
});

test('Founder: stronger high-tier odds per box, and it converges in simulation', async () => {
	const founder = PROFILES.founder.gacha.stats;
	for (const name of ['Fishing Crate', 'Voter\'s Crate', 'Daily Box']) {
		const def = boxDefinition(name);
		const normal = baseTable(def, await buildPools(def));
		const boosted = buildTable(normal, founder);
		for (const tier of ['rare', 'ultra', 'legendary', 'lucky']) if (normal[tier] > 0) assert.ok(boosted[tier] > normal[tier], `${name} ${tier}`);
		// At least as good as the old blunt x3 on Rare-and-above for Legendary/Lucky.
		const blunt = Object.fromEntries(RARITIES.map((r) => [r, normal[r] * (RARITIES.indexOf(r) >= 2 ? 3 : 1)]));
		const bluntTotal = sum(blunt);
		assert.ok(boosted.legendary >= blunt.legendary / bluntTotal - 1e-12, `${name} legendary vs blunt x3`);
		const r = createRng(5);
		const n = 200_000;
		let high = 0;
		for (let i = 0; i < n; i++) if (['legendary', 'lucky'].includes(roll(boosted, r))) high++;
		const p = boosted.legendary + boosted.lucky;
		assert.ok(Math.abs(high / n - p) <= 5 * Math.sqrt(p * (1 - p) / n), name);
	}
});

test('Founder opens record the modifier privately; the public reveal is identical in structure', async () => {
	const { revealEmbed } = require('../src/commands/slash/Economy/open.js');
	await makeUser('founder-g');
	await makeUser('member-g');
	await giveBox('founder-g', 'Daily Box', 1);
	await giveBox('member-g', 'Daily Box', 1);
	const f = await openBox({ userId: 'founder-g', boxName: 'Daily Box' });
	const m = await openBox({ userId: 'member-g', boxName: 'Daily Box' });
	assert.equal(f.profile, 'founder');
	assert.deepEqual(f.modifiers.stats, { rareFind: 2, luck: 4, trophyChance: 2 });
	assert.deepEqual(m.modifiers.stats, { rareFind: 0, luck: 0, trophyChance: 0 });
	const fe = revealEmbed(f).toJSON();
	const me = revealEmbed(m).toJSON();
	assert.deepEqual(Object.keys(fe).sort(), Object.keys(me).sort());
	assert.equal(fe.footer.text, me.footer.text);
	assert.ok(!/founder|luck|pity|bonus|×/i.test(JSON.stringify(fe)));
});

test('rarity floor and guaranteed slots', async () => {
	await makeUser('floors');
	await withTestBox('Floor Box', { slots: 3, pool: { types: ['bait', 'part_rod', 'part_reel', 'part_hook', 'part_handle'], fish: false }, rarityTable: { ...ALL, common: 1000 }, rarityFloor: 'uncommon', guaranteedSlots: [{ slot: 0, minRarity: 'legendary' }] }, async () => {
		await giveBox('floors', 'Floor Box', 40);
		for (let i = 0; i < 40; i++) {
			const r = await openBox({ userId: 'floors', boxName: 'Floor Box' });
			assert.ok(RARITIES.indexOf(r.slots[0].rarity) >= RARITIES.indexOf('legendary'), `slot 0 ${r.slots[0].rarity}`);
			assert.equal(r.slots[0].guaranteed, true);
			for (const s of r.slots) assert.notEqual(s.rarity, 'common');
		}
	});
});

test('featured rewards, exclusions and unique duplicates', async () => {
	await makeUser('featured');
	await withTestBox('Feature Box', {
		slots: 3, duplicates: 'unique', rarityTable: { rare: 1 },
		pool: { types: ['buff'], fish: false, exclude: ['Lucky Draw'], featured: [{ names: ['Double XP'], weight: 1000 }] },
	}, async () => {
		await giveBox('featured', 'Feature Box', 20);
		let doubleXpFirst = 0;
		for (let i = 0; i < 20; i++) {
			const r = await openBox({ userId: 'featured', boxName: 'Feature Box' });
			const names = r.slots.map((s) => s.reward.name);
			assert.ok(!names.includes('Lucky Draw'), 'excluded');
			// Only 2 eligible buffs: 2 unique, then a duplicate is unavoidable.
			assert.equal(new Set(names.slice(0, 2)).size, 2);
			if (names[0] === 'Double XP') doubleXpFirst++;
		}
		assert.ok(doubleXpFirst >= 18, `featured picked first ${doubleXpFirst}/20`);
	});
});

test('box pity: soft ramp, hard guarantee and reset only when the tier is awarded', async () => {
	await makeUser('pity-box');
	const pity = { legendaryPlus: { counter: 'legendaryPlus', tiers: ['legendary', 'lucky'], softStart: 2, rampPerCast: 0.1, maxBonus: 0.5, hard: 5 } };
	await withTestBox('Pity Box', { slots: 1, pool: { types: ['bait', 'part_rod', 'part_reel', 'part_hook', 'part_handle'], fish: false }, rarityTable: { common: 1000000, legendary: 1 }, pity }, async () => {
		await giveBox('pity-box', 'Pity Box', 12);
		const counters = [];
		let sawSoft = false;
		for (let i = 0; i < 12; i++) {
			const r = await openBox({ userId: 'pity-box', boxName: 'Pity Box' });
			const key = 'pity-box:legendaryPlus';
			if (r.pity.applied.legendaryPlus?.bonus > 0) sawSoft = true;
			if (r.pity.before[key] === 4) assert.equal(r.slots[0].rarity, 'legendary', 'hard pity on the 5th open');
			counters.push(r.pity.after[key]);
			assert.equal(r.pity.after[key], r.slots[0].rarity === 'legendary' ? 0 : r.pity.before[key] + 1);
		}
		assert.ok(sawSoft);
		assert.ok(counters.includes(0));
		assert.ok(Math.max(...counters) <= 4);
		assert.equal((await userDoc('pity-box')).pity.gacha['pity-box:legendaryPlus'], counters.at(-1));
	});
});

test('stackable rewards stack; rods become separate owned instances; fish become owned fish records', async () => {
	await makeUser('dupes');
	await withTestBox('Buff Box', { slots: 3, rarityTable: { rare: 1 }, pool: { types: ['buff'], fish: false, exclude: ['Double Cash', 'Lucky Draw'] } }, async () => {
		await giveBox('dupes', 'Buff Box', 1);
		await openBox({ userId: 'dupes', boxName: 'Buff Box' });
		const buffs = await ItemData.find({ user: 'dupes', name: 'Double XP' }).lean();
		assert.equal(buffs.length, 1, 'one stack');
		assert.equal(buffs[0].count, 3);
	});
	await withTestBox('Rod Box', { slots: 2, rarityTable: { common: 1 }, pool: { types: ['rod'], fish: false } }, async () => {
		const before = (await userDoc('dupes')).inventory.rods.length;
		await giveBox('dupes', 'Rod Box', 1);
		await openBox({ userId: 'dupes', boxName: 'Rod Box' });
		const rods = (await userDoc('dupes')).inventory.rods;
		assert.equal(rods.length, before + 2, 'each rod is its own instance');
		const docs = await ItemData.find({ _id: { $in: rods.slice(-2) } }).lean();
		for (const d of docs) {
			assert.equal(d.__t, 'RodData');
			assert.equal(d.user, 'dupes');
			assert.equal(d.fishCaught, 0);
		}
	});
	await withTestBox('Fish Box', { slots: 2, rarityTable: { ...ALL }, pool: { types: [], fish: true } }, async () => {
		await giveBox('dupes', 'Fish Box', 1);
		const r = await openBox({ userId: 'dupes', boxName: 'Fish Box' });
		const inv = (await userDoc('dupes')).inventory.fish.map(String);
		for (const s of r.slots) {
			const fish = await FishData.findById(s.reward.id).lean();
			assert.ok(inv.includes(s.reward.id));
			assert.ok(Number.isFinite(fish.size) && Number.isFinite(fish.weight) && Number.isFinite(fish.value));
			assert.equal(fish.source, 'gacha');
			assert.equal(fish.competitiveEligible, false);
			assert.equal(fish.user, 'dupes');
		}
	});
});

test('empty rarity pools: never rolled; a box with no usable rarity is rejected clearly', async () => {
	await makeUser('empty');
	// Giant has no bait/parts: its weight is dropped from the table instead of rerolling.
	await withTestBox('Mostly Giant Box', { slots: 3, rarityTable: { giant: 1000, common: 1 }, pool: { types: ['bait'], fish: false } }, async () => {
		await giveBox('empty', 'Mostly Giant Box', 1);
		const r = await openBox({ userId: 'empty', boxName: 'Mostly Giant Box' });
		assert.equal(r.status, 'ok');
		for (const s of r.slots) assert.equal(s.table.giant, 0);
	});
	await withTestBox('Broken Box', { slots: 1, rarityTable: { giant: 1 }, pool: { types: ['bait'], fish: false } }, async () => {
		await giveBox('empty', 'Broken Box', 1);
		await assert.rejects(openBox({ userId: 'empty', boxName: 'Broken Box' }), { code: 'GACHA_DEFINITION' });
		// The box was not consumed.
		assert.equal(await itemsOwned('empty', 'Broken Box'), 1);
		const { validateBoxes } = require('../src/engine/gacha');
		assert.equal((await validateBoxes(['Broken Box'])).problems.length, 1);
	});
});

test('applying the same result twice never duplicates rewards or consumes twice', async () => {
	await makeUser('twice');
	await giveBox('twice', 'Daily Box', 2);
	const r = await openLine({ userId: 'twice', boxName: 'Daily Box' });
	await applyGachaResult(r);
	await applyGachaResult(r);
	await recoverPendingOpens({ userId: 'twice' });
	assert.equal(await itemsOwned('twice', 'Daily Box'), 1);
	assert.equal((await userDoc('twice')).stats.gachaBoxesOpened, 1);
	for (const s of r.slots) {
		if (s.reward.kind === 'fish') assert.equal(await FishData.countDocuments({ _id: s.reward.id }), 1);
		else assert.equal(await ItemData.countDocuments({ user: 'twice', appliedOps: `${r.openId}:slot:${s.slot}` }), 1);
	}
});

test('concurrent opens of a 3-box stack: exactly 3 succeed', async () => {
	await makeUser('rush');
	await giveBox('rush', 'Fishing Crate', 3);
	const results = await Promise.all(Array.from({ length: 6 }, () => openBox({ userId: 'rush', boxName: 'Fishing Crate' })));
	assert.equal(results.filter((r) => r.status === 'ok').length, 3);
	assert.equal(results.filter((r) => r.failure?.code === 'NO_BOX').length, 3);
	assert.equal((await userDoc('rush')).stats.gachaBoxesOpened, 3);
	assert.ok(!(await userDoc('rush')).inventory.gacha.length);
});

for (const step of ['consume', 'fish', 'commit']) {
	test(`failure at "${step}": no rewards are owned yet; recovery grants everything exactly once`, async () => {
		const id = `gfail-${step}`;
		await makeUser(id);
		await giveBox(id, 'Voter\'s Crate', 2);
		rng.seed(3);
		const r = await openLine({ userId: id, boxName: 'Voter\'s Crate' });
		await assert.rejects(applyGachaResult(r, { fault: async (s) => { if (s === step) throw new Error('boom'); } }));
		const mid = await userDoc(id);
		assert.equal(mid.stats.gachaBoxesOpened || 0, 0);
		assert.equal(mid.inventory.fish.length, 0);
		assert.equal((await GachaOpen.findById(r.openId).lean()).status, 'pending');

		assert.equal(await recoverPendingOpens({ userId: id }), 1);
		await recoverPendingOpens({ userId: id });
		const after = await userDoc(id);
		assert.equal(after.stats.gachaBoxesOpened, 1);
		assert.equal(await itemsOwned(id, 'Voter\'s Crate'), 1);
		assert.equal(after.inventory.fish.length, r.slots.filter((s) => s.reward.kind === 'fish').length);
		for (const s of r.slots.filter((x) => x.reward.kind === 'item')) assert.equal(await ItemData.countDocuments({ user: id, appliedOps: `${r.openId}:slot:${s.slot}` }), 1);
		assert.equal((await GachaOpen.findById(r.openId).lean()).status, 'applied');
	});
}

test('failure after the commit (grants): the open is recorded, item grants recover exactly once', async () => {
	await makeUser('gfail-grants');
	await withTestBox('Grant Box', { slots: 2, rarityTable: { rare: 1 }, pool: { types: ['buff'], fish: false, exclude: ['Double Cash', 'Lucky Draw'] } }, async () => {
		await giveBox('gfail-grants', 'Grant Box', 1);
		const r = await openLine({ userId: 'gfail-grants', boxName: 'Grant Box' });
		await assert.rejects(applyGachaResult(r, { fault: async (s) => { if (s === 'grants') throw new Error('boom'); } }));
		assert.equal((await userDoc('gfail-grants')).stats.gachaBoxesOpened, 1);
		assert.equal(await itemsOwned('gfail-grants', 'Double XP'), 0);
		await recoverPendingOpens({ userId: 'gfail-grants' });
		await recoverPendingOpens({ userId: 'gfail-grants' });
		assert.equal(await itemsOwned('gfail-grants', 'Double XP'), 2);
	});
});

test('legacy owned boxes still open: catalog names use V2, unknown boxes use their stored fields', async () => {
	await makeUser('legacy');
	const oid = () => new mongoose.Types.ObjectId();
	const oldDaily = oid();
	const mystery = oid();
	await ItemData.collection.insertMany([
		// A Daily Box owned before V2 (old snapshot fields, legacy __t).
		{ _id: oldDaily, __t: 'GachaData', type: 'gacha', name: 'Daily Box', user: 'legacy', count: 1, capabilities: ['bait'], items: 3, weights: { common: 1 }, rarity: 'Uncommon', description: 'x' },
		// A box that no longer exists in the catalog.
		{ _id: mystery, __t: 'GachaData', type: 'gacha', name: 'Mystery Crate', user: 'legacy', count: 1, capabilities: ['bait', 'fish'], items: 2, weights: { common: 10, uncommon: 0, rare: 1, ultra: 0, giant: 0, legendary: 0, lucky: 0 }, rarity: 'Rare', description: 'x' },
	]);
	await UserModel.updateOne({ userId: 'legacy' }, { $push: { 'inventory.gacha': { $each: [oldDaily, mystery] } } });

	const daily = await openBox({ userId: 'legacy', boxName: 'daily box' });
	assert.equal(daily.status, 'ok');
	assert.equal(daily.box.definitionId, 'daily-box');
	assert.equal(daily.slots.length, 3);

	const legacy = await openBox({ userId: 'legacy', boxName: 'Mystery Crate' });
	assert.equal(legacy.status, 'ok');
	assert.equal(legacy.box.legacy, true);
	assert.equal(legacy.slots.length, 2);
	for (const s of legacy.slots) assert.ok(['common', 'rare'].includes(s.rarity));
	assert.equal((await userDoc('legacy')).inventory.gacha.length, 0);
});

test('GachaResult records the full decision', async () => {
	await makeUser('record-g');
	await giveBox('record-g', 'Voter\'s Crate', 1);
	const r = await openLine({ userId: 'record-g', guildId: 'g1', boxName: 'Voter\'s Crate' });
	assert.match(r.openId, /^[0-9a-f]{24}$/);
	assert.equal(r.userId, 'record-g');
	assert.equal(r.guildId, 'g1');
	assert.equal(r.profile, 'normal');
	assert.ok(r.balanceVersion && r.createdAt instanceof Date);
	assert.equal(r.competitiveEligible, true);
	assert.ok(Array.isArray(r.modifiers.sources) && r.modifiers.stats);
	assert.ok(r.pity.before && r.pity.after);
	for (const s of r.slots) {
		assert.ok(Math.abs(Object.values(s.baseTable).reduce((a, b) => a + b, 0) - 100) < 0.01);
		assert.ok(Math.abs(Object.values(s.table).reduce((a, b) => a + b, 0) - 100) < 0.01);
		assert.ok(s.rarity && s.reward.name && s.reward.quantity === 1);
	}
	assert.equal(BOXES['Voter\'s Crate'].slots, r.slots.length);
});

test('legacy appliedCasts guards (pre-rename journals) are still honoured: recovery never re-applies', async () => {
	await makeUser('legacy-guard');
	await giveBox('legacy-guard', 'Daily Box', 2);
	rng.seed(11);
	const r = await openLine({ userId: 'legacy-guard', boxName: 'Daily Box' });
	await applyGachaResult(r);
	const before = await userDoc('legacy-guard');
	const itemsBefore = await ItemData.find({ user: 'legacy-guard' }).lean();

	// Rewrite every guard key into the legacy field, as Phase 2-4 code stored it, and re-open the journal.
	await UserModel.collection.updateOne({ userId: 'legacy-guard' }, { $rename: { appliedOps: 'appliedCasts' } });
	await ItemData.collection.updateMany({ user: 'legacy-guard', appliedOps: { $exists: true } }, { $rename: { appliedOps: 'appliedCasts' } });
	await GachaOpen.updateOne({ _id: r.openId }, { $set: { status: 'pending' } });
	assert.equal(await ItemData.countDocuments({ user: 'legacy-guard', appliedOps: { $exists: true } }), 0);

	await recoverPendingOpens({ userId: 'legacy-guard' });
	const after = await userDoc('legacy-guard');
	assert.equal(after.stats.gachaBoxesOpened, before.stats.gachaBoxesOpened);
	assert.equal(after.inventory.fish.length, before.inventory.fish.length);
	assert.equal(after.inventory.money, before.inventory.money);
	assert.equal(await itemsOwned('legacy-guard', 'Daily Box'), 1);
	const itemsAfter = await ItemData.find({ user: 'legacy-guard' }).lean();
	assert.deepEqual(itemsAfter.map((i) => [String(i._id), i.count]).sort(), itemsBefore.map((i) => [String(i._id), i.count]).sort());
	assert.equal((await GachaOpen.findById(r.openId).lean()).status, 'applied');
});
