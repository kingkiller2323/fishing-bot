// Phase 5 PROPOSED balance, modelled on the same engine measurements as the current game.
// This file only describes and simulates a proposal; it does not change any live value.
//
//   node scripts/economy/proposal.js > docs/economy/proposal.json
//
// Every number the report proposes is in PROPOSAL below; the simulation applies them to the measured
// per-fish outcomes (rarity mix, base XP, sale value) of the current engine.
const measurements = require(require('node:path').resolve(process.env.MEASUREMENTS || 'docs/economy/measurements.json'));
const { levelForXp } = require('../../src/engine/balance');

const BIOMES = ['ocean', 'river', 'lake', 'pond', 'coast', 'swamp'];
const RARITIES = ['common', 'uncommon', 'rare', 'ultra', 'giant', 'legendary', 'lucky'];

const PROPOSAL = {
	// Levels: identical to today up to Lv 20 (100 x L^2), steeper after; a player's level never drops
	// (level = max(stored level, curve(xp))), so the change is non-destructive.
	curve: { base: 100, extraAfter: 20, extra: 400 },
	// Biome unlock levels unchanged. Optional one-time permits (a money sink with a purpose);
	// players who already qualify are grandfathered by an additive migration.
	biomes: {
		ocean: { level: 0, permit: 0, targetValuePerFish: 25 },
		river: { level: 10, permit: 5000, targetValuePerFish: 40 },
		lake: { level: 20, permit: 25000, targetValuePerFish: 60 },
		pond: { level: 30, permit: 75000, targetValuePerFish: 85 },
		coast: { level: 40, permit: 200000, targetValuePerFish: 115 },
		swamp: { level: 50, permit: 500000, targetValuePerFish: 150 },
	},
	// XP per fish keeps the 10-25 roll; rarer fish are worth more XP (today every fish is equal).
	xpByRarity: { common: 1, uncommon: 1.2, rare: 1.5, ultra: 2, giant: 2.5, legendary: 4, lucky: 6 },
	// Normal multi-catch: expected fish per cast by rod tier (today 1 / 4-6 / 15). Rod tier also
	// raises rare-find (already in PART_RARITY_STATS); modelled here as a rarity-XP uplift.
	rods: {
		old: { label: 'Old Rod (unbreakable)', level: 0, fishPerCast: 1.0, rarityUplift: 1.0, cooldownMs: 5000, repairCost: 0, durability: Infinity, box: null, boxes: 0 },
		t1: { label: 'Tier 1 crafted (Common/Uncommon parts)', level: 20, fishPerCast: 1.15, rarityUplift: 1.03, cooldownMs: 5000, repairCost: 2500, durability: 3000, box: 'Fishing Crate', boxes: 12 },
		t2: { label: 'Tier 2 crafted (Rare parts)', level: 30, fishPerCast: 1.3, rarityUplift: 1.08, cooldownMs: 4750, repairCost: 10000, durability: 5000, box: 'Pro Tackle Crate', boxes: 5 },
		t3: { label: 'Tier 3 crafted (Ultra parts)', level: 40, fishPerCast: 1.45, rarityUplift: 1.12, cooldownMs: 4500, repairCost: 30000, durability: 7500, box: 'Master Tackle Crate', boxes: 4 },
		t4: { label: 'Tier 4 crafted (Legendary+ parts)', level: 50, fishPerCast: 1.6, rarityUplift: 1.18, cooldownMs: 4250, repairCost: 75000, durability: 10000, box: 'Master Tackle Crate', boxes: 10 },
	},
	boxes: {
		'Fishing Crate': { price: 2500, note: 'Common-Rare parts and bait (today $750)' },
		'Pro Tackle Crate': { price: 25000, note: 'NEW: rarity floor Rare, parts only' },
		'Master Tackle Crate': { price: 150000, note: 'NEW: rarity floor Ultra, parts only' },
	},
	// Daily quest rewards scale with level (cash ~ 10-15 minutes of income at the player's stage).
	daily: { cashPerLevel: 200, xpPerLevel: 60, box: 'Daily Box' },
	// Streak Crate replaces the Top.gg Voter's Crate as a daily-login reward (no $10,000 cash).
	streakCrateLiquid: 350,
	licenses: { basic: { price: 150000, level: 15 }, advanced: { price: 750000, level: 30 }, expert: { price: 2500000, level: 45 } },
};

const xpForLevel = (L) => PROPOSAL.curve.base * L * L + (L > PROPOSAL.curve.extraAfter ? PROPOSAL.curve.extra * (L - PROPOSAL.curve.extraAfter) ** 2 : 0);
function levelFor(xp) {
	let L = levelForXp(Math.min(xp, xpForLevel(PROPOSAL.curve.extraAfter)));
	while (xpForLevel(L + 1) <= xp) L++;
	return Math.max(1, L);
}

const M = Object.fromEntries(measurements.results.map((r) => [r.key, r]));

/** Proposed per-cast outcome for a biome and rod tier (normal profile). */
function proposedCast(biome, tier) {
	const rod = PROPOSAL.rods[tier];
	const r = M[`${biome}|Old Rod|-|normal`];
	const rarity = Object.fromEntries(RARITIES.map((k) => [k, (r.rarityUnits[k] || 0) / r.units]));
	const xpMult = RARITIES.reduce((s, k) => s + rarity[k] * PROPOSAL.xpByRarity[k], 0) * rod.rarityUplift;
	const xpPerFish = (r.xpBase / r.units) * xpMult;
	// Biome value normalisation: the measured Old Rod average is scaled to the biome target; better
	// rods catch rarer fish (uplift) and some strong fish from Tier 1 up.
	const valuePerFish = PROPOSAL.biomes[biome].targetValuePerFish * rod.rarityUplift;
	return { fish: rod.fishPerCast, xp: xpPerFish * rod.fishPerCast, value: valuePerFish * rod.fishPerCast, cooldownMs: rod.cooldownMs, durability: rod.fishPerCast };
}

const ARCHETYPES = {
	casual: { minutesPerDay: 12.5, overheadS: 7 },
	regular: { minutesPerDay: 45, overheadS: 4 },
	active: { minutesPerDay: 120, overheadS: 3 },
	grinder: { minutesPerDay: 300, overheadS: 2 },
};

function simulate(name, arch, days = 90) {
	const st = { xp: 0, money: 0, tier: 'old', life: Infinity, biome: 'ocean', permits: new Set(['ocean']) };
	const sources = { fishSales: 0, dailyQuests: 0, streak: 0 };
	const sinks = { permits: 0, crates: 0, repairs: 0, licenses: 0 };
	const licenses = [];
	const milestones = {};
	const timeline = [];
	let minutes = 0;
	const order = ['old', 't1', 't2', 't3', 't4'];
	for (let day = 1; day <= days; day++) {
		// Daily quest (level-scaled) and streak crate; completed within the day's session.
		const L0 = levelFor(st.xp);
		const dcash = PROPOSAL.daily.cashPerLevel * Math.max(1, L0);
		st.money += dcash + PROPOSAL.streakCrateLiquid;
		sources.dailyQuests += dcash;
		sources.streak += PROPOSAL.streakCrateLiquid;
		st.xp += PROPOSAL.daily.xpPerLevel * Math.max(1, L0);
		let seconds = arch.minutesPerDay * 60;
		while (seconds > 0) {
			const L = levelFor(st.xp);
			// Buy the next rod tier when affordable (keeping a repair reserve), then the best permit.
			const next = order[order.indexOf(st.tier) + 1];
			if (next) {
				const rod = PROPOSAL.rods[next];
				const cost = rod.boxes * PROPOSAL.boxes[rod.box].price;
				if (L >= rod.level && st.money >= cost + rod.repairCost) {
					st.money -= cost;
					sinks.crates += cost;
					st.tier = next;
					st.life = rod.durability * 4;
					milestones[`rod:${next}`] = { day, hours: +(minutes / 60).toFixed(2), level: L };
				}
			}
			for (const b of BIOMES) {
				const def = PROPOSAL.biomes[b];
				if (!st.permits.has(b) && L >= def.level && st.money >= def.permit) {
					st.money -= def.permit;
					sinks.permits += def.permit;
					st.permits.add(b);
					milestones[`biome:${b}`] = { day, hours: +(minutes / 60).toFixed(2), level: L };
				}
			}
			// Aquarium licenses (lowest priority): bought once the rod path for the level is done.
			const rodDone = !next || L < PROPOSAL.rods[next].level;
			for (const [licName, lic] of Object.entries(PROPOSAL.licenses)) {
				if (rodDone && !licenses.includes(licName) && L >= lic.level && st.money >= lic.price * 1.2) {
					st.money -= lic.price;
					sinks.licenses += lic.price;
					licenses.push(licName);
					milestones[`license:${licName}`] = { day, hours: +(minutes / 60).toFixed(2), level: L };
				}
			}
			st.biome = [...BIOMES].reverse().find((b) => st.permits.has(b));
			const c = proposedCast(st.biome, st.tier);
			const chunk = Math.min(60, seconds);
			const casts = chunk / (c.cooldownMs / 1000 + arch.overheadS);
			seconds -= chunk;
			minutes += chunk / 60;
			st.xp += casts * c.xp;
			st.money += casts * c.value;
			sources.fishSales += casts * c.value;
			// Repairs: crafted rods need a repair every `durability` fish.
			const rod = PROPOSAL.rods[st.tier];
			if (Number.isFinite(rod.durability)) {
				const repairs = (casts * c.durability) / rod.durability;
				st.money -= repairs * rod.repairCost;
				sinks.repairs += repairs * rod.repairCost;
			}
			const lv = levelFor(st.xp);
			for (const T of [10, 20, 30, 40, 50]) if (lv >= T && !milestones[`level${T}`]) milestones[`level${T}`] = { day, hours: +(minutes / 60).toFixed(2) };
		}
		if ([1, 7, 14, 30, 60, 90].includes(day)) timeline.push({ day, hoursPlayed: +(minutes / 60).toFixed(1), level: levelFor(st.xp), money: Math.round(st.money), tier: st.tier, biome: st.biome });
	}
	const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));
	return { name, arch, milestones, timeline, sources: round(sources), sinks: round(sinks) };
}

function rates(overheadS = 4) {
	const rows = [];
	for (const b of BIOMES) {
		for (const tier of Object.keys(PROPOSAL.rods)) {
			const c = proposedCast(b, tier);
			const cph = 3600 / (c.cooldownMs / 1000 + overheadS);
			rows.push({ biome: b, tier, fishPerCast: c.fish, xpPerCast: +c.xp.toFixed(1), valuePerCast: +c.value.toFixed(1), xpPerHour: Math.round(c.xp * cph), cashPerHour: Math.round(c.value * cph) });
		}
	}
	return rows;
}

const curve = Object.fromEntries([10, 20, 30, 40, 50, 60, 70, 80].map((L) => [L, { current: 100 * L * L, proposed: xpForLevel(L) }]));
const players = Object.fromEntries(Object.entries(ARCHETYPES).map(([n, a]) => [n, simulate(n, a)]));
process.stdout.write(JSON.stringify({ proposal: PROPOSAL, curve, rates: rates(), players }, (k, v) => (v === Infinity ? 'unbreakable' : v), 1));
