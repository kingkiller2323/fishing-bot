// Pure tests of GameBalance, the RarityEngine and PlayerModifiers (no database).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRng } = require('../src/engine/rng');
const { buildTable, applyPity, roll, normalize, toPercent } = require('../src/engine/rarity');
const { resolveModifiers, rodStats, baitStats } = require('../src/engine/modifiers');
const { PROFILES, RARITIES, NORMAL_RARITY_TABLE, FOUNDER_RARITY_TABLE, BAIT_STATS, resolveProfile, activeEvent, COOLDOWN } = require('../src/engine/balance');
const catalogBait = require('../src/bootstrap/data/bait');
const catalogParts = require('../src/bootstrap/data/rodParts');

const oldRod = { _id: 'r', name: 'Old Rod', type: 'rod', capabilities: ['weak', '1'], weights: NORMAL_RARITY_TABLE };
const profile = (name) => ({ name, ...PROFILES[name] });
const bait = (name) => ({ _id: name, ...catalogBait.find((b) => b.name === name) });
const sum = (t) => RARITIES.reduce((s, r) => s + t[r], 0);
const group = (t, tiers) => tiers.reduce((s, r) => s + t[r], 0);

function simulate(table, n, seed) {
	const rng = createRng(seed);
	const counts = Object.fromEntries(RARITIES.map((r) => [r, 0]));
	for (let i = 0; i < n; i++) counts[roll(table, rng)]++;
	return Object.fromEntries(RARITIES.map((r) => [r, counts[r] / n]));
}
// 5 standard deviations of a binomial proportion: never flaky at these sample sizes.
const within = (observed, expected, n) => Math.abs(observed - expected) <= 5 * Math.sqrt(expected * (1 - expected) / n) + 1e-12;

test('normal baseline: starter rod reproduces the legacy odds exactly', () => {
	const mods = resolveModifiers({ profile: profile('normal'), rod: oldRod });
	const legacy = normalize(NORMAL_RARITY_TABLE);
	for (const r of RARITIES) assert.ok(Math.abs(mods.rarity.table[r] - legacy[r]) < 1e-12, r);
	assert.deepEqual(toPercent(mods.rarity.table, 3), { common: 68.823, uncommon: 24.58, rare: 4.916, ultra: 0.983, giant: 0.492, legendary: 0.197, lucky: 0.01 });
});

test('normal baseline distribution holds under a large seeded simulation', () => {
	const table = resolveModifiers({ profile: profile('normal'), rod: oldRod }).rarity.table;
	const n = 400_000;
	const observed = simulate(table, n, 20260925);
	for (const r of RARITIES) assert.ok(within(observed[r], table[r], n), `${r}: ${observed[r]} vs ${table[r]}`);
});

test('Founder distribution converges on 32/28/20/10/5/4/1', () => {
	const table = resolveModifiers({ profile: profile('founder'), rod: oldRod }).rarity.table;
	assert.deepEqual(toPercent(table, 6), { common: 32, uncommon: 28, rare: 20, ultra: 10, giant: 5, legendary: 4, lucky: 1 });
	const n = 400_000;
	const observed = simulate(table, n, 7);
	const target = normalize(FOUNDER_RARITY_TABLE);
	for (const r of RARITIES) assert.ok(within(observed[r], target[r], n), `${r}: ${observed[r]} vs ${target[r]}`);
});

test('tables always normalise, even with negative, huge or invalid stats', () => {
	const rng = createRng(99);
	const weird = [NaN, -5, -1, -0.5, 0, 0.3, 7, 1e9, Infinity, -Infinity, undefined];
	for (let i = 0; i < 500; i++) {
		const stats = { luck: rng.pick(weird), rareFind: rng.pick(weird), trophyChance: rng.pick(weird) };
		for (const base of [NORMAL_RARITY_TABLE, FOUNDER_RARITY_TABLE, { lucky: 1 }, {}, { common: -3 }]) {
			const t = buildTable(base, stats);
			assert.ok(Math.abs(sum(t) - 1) < 1e-9, JSON.stringify(stats));
			assert.ok(RARITIES.every((r) => Number.isFinite(t[r]) && t[r] >= 0));
		}
	}
	// A completely empty base falls back to all-Common rather than an invalid table.
	assert.equal(buildTable({}, {}).common, 1);
});

test('modifier stats are clamped so no source combination can break the table', () => {
	const mods = resolveModifiers({ profile: profile('normal'), rod: { ...oldRod, capabilities: ['weak', '999', '999 count'] }, event: { name: 'x', stats: { luck: -100, rareFind: 1e6 } } });
	assert.equal(mods.stats.luck, -0.9);
	assert.equal(mods.stats.rareFind, 50);
	assert.equal(mods.draws, PROFILES.normal.limits.maxDraws);
	assert.equal(mods.perDraw, PROFILES.normal.limits.maxPerDraw);
	assert.ok(Math.abs(sum(mods.rarity.table) - 1) < 1e-9);
});

test('every catalog bait converts into the stats it advertises, and raises those tiers', () => {
	const base = buildTable(NORMAL_RARITY_TABLE);
	for (const b of catalogBait) {
		const { stats, qualities } = baitStats(bait(b.name));
		for (const [k, v] of Object.entries(BAIT_STATS[b.name])) assert.equal(stats[k], v, `${b.name}.${k}`);
		assert.deepEqual(qualities, b.capabilities.filter((c) => ['weak', 'strong'].includes(c)));
		if (b.multiplier && b.multiplier !== 1) assert.equal(stats.xpBonus, Number((b.multiplier - 1).toFixed(4)));
		const t = buildTable(NORMAL_RARITY_TABLE, stats);
		if (stats.rareFind) assert.ok(group(t, ['rare', 'ultra']) > group(base, ['rare', 'ultra']), `${b.name} rare find`);
		if (stats.luck) assert.ok(group(t, ['legendary', 'lucky']) > group(base, ['legendary', 'lucky']), `${b.name} luck`);
		if (stats.trophyChance) assert.ok(t.giant > base.giant, `${b.name} trophy`);
	}
});

test('Magic Lure genuinely improves high-tier fishing (it used to lower Legendary)', () => {
	const none = resolveModifiers({ profile: profile('normal'), rod: oldRod }).rarity.table;
	const lure = resolveModifiers({ profile: profile('normal'), rod: oldRod, bait: bait('Lure'), baitApplies: true }).rarity.table;
	const magic = resolveModifiers({ profile: profile('normal'), rod: oldRod, bait: bait('Magic Lure'), baitApplies: true }).rarity.table;
	for (const tier of ['rare', 'ultra', 'giant', 'legendary', 'lucky']) assert.ok(magic[tier] > none[tier], tier);
	assert.ok(magic.legendary > lure.legendary && magic.lucky > lure.lucky);
	assert.ok(magic.legendary > 2 * none.legendary);
	// Legacy additive weights: Legendary 20+20 of 21062 total = 0.19% < 0.197% without bait.
	assert.ok(40 / 21062 < 20 / 10171);
});

test('bait catch stats only work in their biomes; the XP bonus always applies', () => {
	const off = resolveModifiers({ profile: profile('normal'), rod: oldRod, bait: bait('Magic Lure'), baitApplies: false });
	assert.equal(off.stats.luck, 0);
	assert.equal(off.perDraw, 1);
	assert.equal(off.stats.xpBonus, 1.5);
});

test('normal players stay near baseline: baits add no extra draws, only their legacy fish-per-draw', () => {
	for (const b of catalogBait) {
		const mods = resolveModifiers({ profile: profile('normal'), rod: oldRod, bait: bait(b.name), baitApplies: true });
		assert.equal(mods.draws, 1, b.name);
		const legacyPerDraw = parseInt(b.capabilities.find((c) => /count/.test(c)) || '1', 10);
		assert.equal(mods.perDraw, legacyPerDraw, b.name);
	}
});

const part = (name) => ({ ...catalogParts.find((p) => p.name === name) });
const customRod = (names) => ({ _id: 'c', name: 'Custom', type: 'customrod', capabilities: ['weak', 'strong', 'quick'], weights: NORMAL_RARITY_TABLE, parts: names.map(part) });

test('custom rods derive rarity stats from their parts', () => {
	const cheap = customRod(['Wooden Rod Piece', 'Plastic Reel', 'Barbed Hook', 'Wooden Handle']);
	const elite = customRod(['Composite Rod Piece', 'Sage Green Reel', 'Worm Hook', 'Composite Handle']);
	const cheapStats = rodStats(cheap, cheap.parts).stats;
	const eliteStats = rodStats(elite, elite.parts).stats;
	assert.equal(cheapStats.luck || 0, 0);
	assert.equal(eliteStats.luck, 0.8);
	assert.equal(eliteStats.rareFind, 1);
	assert.equal(eliteStats.trophyChance, 0.6);
	assert.equal(eliteStats.fishingSpeed, 0.2);

	const t1 = resolveModifiers({ profile: profile('normal'), rod: cheap, rodParts: cheap.parts }).rarity.table;
	const t2 = resolveModifiers({ profile: profile('normal'), rod: elite, rodParts: elite.parts }).rarity.table;
	for (const tier of ['rare', 'ultra', 'giant', 'legendary', 'lucky']) assert.ok(t2[tier] > t1[tier], tier);
});

test('multi-catch: rod draws + profile draws, fish per draw, capped per profile', () => {
	const rod3 = { ...oldRod, capabilities: ['weak', '3', '2 count'] };
	const normal = resolveModifiers({ profile: profile('normal'), rod: rod3 });
	assert.equal(normal.draws, 3);
	assert.equal(normal.perDraw, 2);
	const founder = resolveModifiers({ profile: profile('founder'), rod: rod3, bait: bait('Lure'), baitApplies: true });
	assert.equal(founder.draws, 5, '3 from the rod + 2 Founder');
	assert.equal(founder.perDraw, 3, '2 count rod + 1 Lure');
	const starterFounder = resolveModifiers({ profile: profile('founder'), rod: oldRod });
	assert.equal(starterFounder.draws, 3);
});

test('XP, sell and quest modifiers stack exactly as documented', () => {
	const buffs = [{ _id: 'b', name: 'Double XP', capabilities: ['xp', '2.0'] }, { _id: 'c', name: 'Double Cash', capabilities: ['cash', '2.0'] }];
	const event = { name: 'Weekend', stats: {}, multipliers: { xp: 2, sell: 1.5, questXp: 3, questCash: 2 } };
	const mods = resolveModifiers({ profile: profile('founder'), rod: oldRod, bait: bait('Lure'), baitApplies: true, buffs, event });
	// xp = (1 + gear 0.5) x (1 + buff 1.0) x founder 5 x event 2
	assert.equal(mods.xp.multiplier, 1.5 * 2 * 5 * 2);
	// sell = (1 + gear 0) x founder 10 x event 1.5 ; cash buffs apply at sale time
	assert.equal(mods.sell.multiplier, 10 * 1.5);
	assert.equal(mods.sell.cashBuffAtSale, 1);
	assert.equal(mods.quest.xp, 5 * 3);
	assert.equal(mods.quest.cash, 5 * 2);
	const normal = resolveModifiers({ profile: profile('normal'), rod: oldRod });
	assert.deepEqual([normal.xp.multiplier, normal.sell.multiplier, normal.quest.xp, normal.quest.cash], [1, 1, 1, 1]);
});

test('every source is recorded separately in the snapshot', () => {
	const mods = resolveModifiers({ profile: profile('founder'), rod: oldRod, bait: bait('Fly'), baitApplies: true, buffs: [{ _id: 'b', name: 'Double XP', capabilities: ['xp', '2.0'] }], event: { name: 'E', stats: { luck: 0.1 }, multipliers: {} }, user: { devOverrides: { luck: { value: 1 } } } });
	assert.deepEqual(mods.sources.map((s) => s.source), ['base', 'profile', 'rod', 'bait', 'buff', 'dev', 'event']);
	assert.equal(mods.competitiveEligible, false);
});

test('durability efficiency and fishing speed come from GameBalance', () => {
	const normal = resolveModifiers({ profile: profile('normal'), rod: oldRod });
	const founder = resolveModifiers({ profile: profile('founder'), rod: oldRod });
	assert.equal(normal.durabilityCostPerFish, 1);
	assert.equal(founder.durabilityCostPerFish, 0.25);
	assert.equal(normal.cooldownMs, COOLDOWN.fishMs);
	assert.equal(founder.cooldownMs, 2000);
	const test_ = resolveModifiers({ profile: profile('test'), rod: oldRod });
	assert.equal(test_.cooldownMs, COOLDOWN.minMs, 'never below the floor');
});

test('profiles: FOUNDER_IDS decides Founder, DEVELOPER_IDS does not, dev overrides win', () => {
	const cfg = { users: { founders: ['f'], developers: ['d'] } };
	assert.equal(resolveProfile('f', null, cfg).name, 'founder');
	assert.equal(resolveProfile('d', null, cfg).name, 'normal');
	assert.equal(resolveProfile('d', { devOverrides: { profile: 'founder' } }, cfg).name, 'founder');
	assert.equal(resolveProfile('f', { devOverrides: { profile: 'normal' } }, cfg).name, 'normal');
	assert.equal(resolveProfile('x', { devOverrides: { profile: 'test' } }, cfg).name, 'test');
	assert.equal(resolveProfile('f', null, cfg).competitiveEligible, false);
	assert.equal(resolveProfile('x', null, cfg).competitiveEligible, true);
});

test('events apply only inside their window', () => {
	const events = [{ name: 'W', startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-03T00:00:00Z', stats: {}, multipliers: { xp: 2 } }];
	assert.equal(activeEvent(new Date('2026-09-30T23:59:00Z'), events), null);
	assert.equal(activeEvent(new Date('2026-10-02T12:00:00Z'), events).name, 'W');
	assert.equal(activeEvent(new Date('2026-10-03T00:00:00Z'), events), null);
});

test('pity: no effect before the soft start, then ramps, then guarantees at the hard cap', () => {
	const pity = PROFILES.founder.pity;
	const base = buildTable(FOUNDER_RARITY_TABLE);
	const g = (t) => group(t, ['legendary', 'lucky']);
	const rule = pity.legendaryPlus;

	const quiet = applyPity(base, { castsSinceLegendary: rule.softStart - 1, castsSinceLucky: 0 }, pity);
	assert.equal(quiet.applied.legendaryPlus.bonus, 0);
	assert.ok(Math.abs(g(quiet.table) - g(base)) < 1e-12);
	assert.equal(quiet.guarantee, null);

	let previous = g(base);
	for (let since = rule.softStart; since < rule.hard - 1; since++) {
		const p = applyPity(base, { castsSinceLegendary: since, castsSinceLucky: 0 }, pity);
		assert.ok(g(p.table) > previous, `ramps at ${since}`);
		assert.ok(Math.abs(sum(p.table) - 1) < 1e-9);
		assert.equal(p.guarantee, null);
		previous = g(p.table);
	}
	const hard = applyPity(base, { castsSinceLegendary: rule.hard - 1, castsSinceLucky: 0 }, pity);
	assert.deepEqual(hard.guarantee, rule.tiers);

	const luckyHard = applyPity(base, { castsSinceLegendary: 0, castsSinceLucky: pity.lucky.hard - 1 }, pity);
	assert.deepEqual(luckyHard.guarantee, ['lucky']);
	// Normal players: pity disabled.
	assert.equal(applyPity(base, { castsSinceLegendary: 999 }, PROFILES.normal.pity).guarantee, null);
});

test('a guaranteed roll only ever returns the guaranteed tiers', () => {
	const rng = createRng(3);
	const table = buildTable(FOUNDER_RARITY_TABLE);
	for (let i = 0; i < 2000; i++) assert.ok(['legendary', 'lucky'].includes(roll(table, rng, ['legendary', 'lucky'])));
});
