// Phase 5: exact per-open contents of every gacha box for a normal player, from the real Gacha V2
// definitions and pools (buildPools/baseTable). Rewards within a rarity are picked uniformly.
//
//   node scripts/economy/gacha-ev.js > docs/economy/gacha-ev.json
const { startDb, stopDb } = require('../../test/helpers/db');
const { quiet, restore } = require('../../test/helpers/quiet');
const { bootstrap } = require('../../src/bootstrap');
const { buildPools, baseTable } = require('../../src/engine/gacha');
const { BOXES, boxDefinition } = require('../../src/engine/gachaBoxes');
const { RARITIES } = require('../../src/engine/balance');

const RARITY_FACTOR = { common: 1, uncommon: 1.35, rare: 1.65, ultra: 2.2, giant: 3.0, legendary: 3.5, lucky: 4.0 };
/** Expected sale value of a fish template (Fish.calculateSellValue is linear in size and weight). */
const fishValue = (t) => ((t.minSize + t.maxSize) / 2) * t.baseValue * 0.05 + ((t.minWeight + t.maxWeight) / 2) * 1.005 * (RARITY_FACTOR[String(t.rarity).toLowerCase()] || 1);

async function main() {
	quiet();
	await startDb();
	await bootstrap();
	const out = {};
	for (const name of Object.keys(BOXES)) {
		const def = boxDefinition(name);
		const pools = await buildPools(def);
		const table = baseTable(def, pools);
		const perSlot = {};
		let cashValuePerSlot = 0;
		const byType = {};
		for (const r of RARITIES) {
			const pool = pools[r];
			if (!table[r] || !pool.length) continue;
			const totalW = pool.reduce((s, e) => s + e.weight, 0);
			for (const e of pool) {
				const p = table[r] * (e.weight / totalW);
				const t = e.template;
				const type = e.kind === 'fish' ? 'fish' : t.type;
				perSlot[t.name] = { p, rarity: r, type, price: t.price ?? null };
				byType[type] = (byType[type] || 0) + p;
				// Liquid value: fish sell, bait is worth its shop price (replacement cost); parts/buffs/rods have no price.
				if (type === 'fish') cashValuePerSlot += p * fishValue(t);
				else if (type === 'bait' && t.price) cashValuePerSlot += p * t.price;
			}
		}
		out[name] = {
			slots: def.slots,
			rarityTable: table,
			typeShare: byType,
			expectedLiquidValuePerOpen: cashValuePerSlot * def.slots,
			rewards: Object.fromEntries(Object.entries(perSlot).sort((a, b) => b[1].p - a[1].p)),
		};
	}
	await stopDb();
	restore();
	process.stdout.write(JSON.stringify(out, null, 1));
}

main().catch((e) => {
	restore();
	console.error(e);
	process.exit(1);
});
