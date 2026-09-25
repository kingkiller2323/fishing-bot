// Phase 5: every craftable rod (one rod piece, reel, hook and handle from the catalog), evaluated with
// the real crafting code (FishingRod.combineQualities / generateStats rules) and the real modifier
// resolution for a normal player. For each level requirement: the best rod available, and how rare
// its parts are in a Fishing Crate / Daily Box.
//
//   node scripts/economy/rod-combos.js > docs/economy/rod-combos.json
const parts = require('../../src/bootstrap/data/rodParts');
const { FishingRod } = require('../../src/class/FishingRod');
const { resolveModifiers } = require('../../src/engine/modifiers');
const { PROFILES } = require('../../src/engine/balance');
const gachaEv = require('../../docs/economy/gacha-ev.json');

const byType = (t) => parts.filter((p) => p.type === t);
const combine = FishingRod.prototype.combineQualities;

/** Crafted rod exactly as generateStats builds it. */
async function craft(set) {
	const capabilities = await combine.call(null, set);
	let durability = 0;
	let count = 0;
	for (const q of capabilities) {
		if (q.includes('durability')) durability = parseInt(q, 10);
		else if (q.includes('count')) count = parseInt(q, 10);
	}
	return { capabilities, durability, level: count * 10, repairCost: count * 10000, maxRepairs: 3 };
}

const perSlot = (box, name) => gachaEv[box].rewards[name]?.p || 0;

/**
 * Expected Fishing Crates until all four specific parts have dropped at least once: coupon collector
 * with unequal per-slot probabilities (inclusion-exclusion over subsets), 3 slots per crate.
 */
function expectedCrates(set) {
	const p = set.map((part) => perSlot('Fishing Crate', part.name));
	if (p.some((x) => x <= 0)) return Infinity;
	let slots = 0;
	for (let mask = 1; mask < 1 << p.length; mask++) {
		let sum = 0;
		let bits = 0;
		p.forEach((x, i) => {
			if (mask & (1 << i)) {
				sum += x;
				bits++;
			}
		});
		slots += (bits % 2 ? 1 : -1) / sum;
	}
	return slots / 3;
}

const REPRESENTATIVE = {
	'Custom (Common parts)': ['Wooden Rod Piece', 'Plastic Reel', 'Barbed Hook', 'Wooden Handle'],
	'Custom (Uncommon parts)': ['Bamboo Rod Piece', 'Aluminum Reel', 'Circle Hook', 'Cork Handle'],
	'Custom (Rare parts)': ['Graphite Rod Piece', 'Jigging Reel', 'Treble Hook', 'EVA Handle'],
	'Custom (Ultra parts)': ['Carbon Fiber Rod Piece', 'Fly Fishing Reel', 'Jig Hook', 'Carbon Fiber Handle'],
	'Custom (Legendary parts)': ['Composite Rod Piece', 'Sage Green Reel', 'Worm Hook', 'Composite Handle'],
};

async function main() {
	const rows = [];
	for (const rod of byType('part_rod')) {
		for (const reel of byType('part_reel')) {
			for (const hook of byType('part_hook')) {
				for (const handle of byType('part_handle')) {
					const set = [rod, reel, hook, handle];
					const crafted = await craft(set);
					const m = resolveModifiers({
						profile: { name: 'normal', ...PROFILES.normal },
						rod: { name: 'x', type: 'customrod', capabilities: crafted.capabilities },
						rodParts: set.map((p) => ({ ...p })),
					});
					const fishPerCast = m.draws * m.perDraw;
					const crates = expectedCrates(set);
					rows.push({
						names: set.map((p) => p.name),
						parts: set.map((p) => `${p.name} (${p.rarity})`),
						level: crafted.level,
						fishPerCast,
						draws: m.draws,
						perDraw: m.perDraw,
						strong: m.qualities.includes('strong'),
						durability: crafted.durability,
						repairCost: crafted.repairCost,
						castsPerLife: Math.floor(crafted.durability / fishPerCast),
						lifetimeCasts: Math.floor(crafted.durability / fishPerCast) * 4,
						cooldownMs: m.cooldownMs,
						stats: { rareFind: m.stats.rareFind, luck: m.stats.luck, trophyChance: m.stats.trophyChance, sellBonus: m.stats.sellBonus, fishingSpeed: m.stats.fishingSpeed },
						expectedCratesForParts: Math.round(crates),
					});
				}
			}
		}
	}
	// Best per level requirement: fish/cast first, then cast speed, then cheapest to assemble.
	const levels = [...new Set(rows.map((r) => r.level))].sort((a, b) => a - b);
	const bestAtLevel = {};
	const cheapestMaxAtLevel = {};
	for (const L of [20, 30, 40, 50, 60, 70, 80]) {
		const eligible = rows.filter((r) => r.level <= L);
		if (!eligible.length) continue;
		const score = (r) => r.fishPerCast * (5000 / r.cooldownMs);
		eligible.sort((a, b) => score(b) - score(a) || a.expectedCratesForParts - b.expectedCratesForParts);
		bestAtLevel[L] = eligible[0];
		const top = score(eligible[0]);
		cheapestMaxAtLevel[L] = eligible.filter((r) => score(r) === top).sort((a, b) => a.expectedCratesForParts - b.expectedCratesForParts)[0];
		// Cheapest rod that reaches the normal-profile cap of 15 fish per cast at this level.
		const capped = eligible.filter((r) => r.fishPerCast >= 15).sort((a, b) => a.expectedCratesForParts - b.expectedCratesForParts)[0];
		if (capped) cheapestMaxAtLevel[L].cheapest15 = capped;
	}
	const distribution = {};
	for (const r of rows) distribution[r.fishPerCast] = (distribution[r.fishPerCast] || 0) + 1;
	const minLevel = Math.min(...rows.map((r) => r.level));
	const representative = Object.fromEntries(Object.entries(REPRESENTATIVE).map(([k, names]) => [k, rows.find((r) => r.names.join() === names.join())]));
	// Cheapest rod (fewest expected crates) for each fish-per-cast value at Lv 20.
	const cheapestAt20 = {};
	for (const r of rows.filter((x) => x.level <= 20)) {
		const cur = cheapestAt20[r.fishPerCast];
		if (!cur || r.expectedCratesForParts < cur.expectedCratesForParts) cheapestAt20[r.fishPerCast] = r;
	}
	process.stdout.write(JSON.stringify({ combos: rows.length, minLevel, levels, fishPerCastDistribution: distribution, bestAtLevel, cheapestMaxAtLevel, cheapestAt20, representative }, null, 1));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
