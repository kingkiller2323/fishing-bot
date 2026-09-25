// Phase 5 player-lifecycle simulation. Pure arithmetic on top of the engine measurements
// (measurements.json from measure.js, gacha-ev.json, rod-combos.json) and the catalog/quest data;
// it never touches the database or live balance values.
//
//   node scripts/economy/simulate.js > docs/economy/simulation.json
//
// Player model (documented in docs/economy/PHASE5_REPORT.md):
//   - plays M minutes/day; one cast every (cooldown + reaction overhead) seconds;
//   - fishes the highest biome it has unlocked; sells everything at the end of each session;
//   - takes the daily quest whenever none is running (Quest.generateDailyQuest rules);
//   - repairs its rod when it breaks; the Old Rod is replaced for free once destroyed;
//   - rod path: Old Rod -> at Lv 20 the best cheap crafted rod -> at Lv 30 the cheapest 15-fish rod,
//     buying Fishing Crates for the parts (Daily Box parts count too);
//   - no bait (bait value is reported separately), no Top.gg votes unless `votes` is set,
//     no repeatable-quest farming unless `questFarming` is set.
const path = require('node:path');
const measurements = require(path.resolve(process.argv[2] || 'docs/economy/measurements.json'));
const gachaEv = require('../../docs/economy/gacha-ev.json');
const rodCombos = require('../../docs/economy/rod-combos.json');
const quests = require('../../src/bootstrap/data/quests');
const biomes = require('../../src/bootstrap/data/biomes');
const { levelForXp } = require('../../src/engine/balance');

const BIOME_LEVEL = Object.fromEntries(biomes.map((b) => [b.name.toLowerCase(), parseInt(String(b.requirements[0]).replace(/\D/g, ''), 10) || 0]));
const BIOME_ORDER = biomes.map((b) => b.name.toLowerCase());
const CRATE_PRICE = 750;
const OLD_ROD = { durability: 1000, repairCost: 1000, maxRepairs: 3 };

const M = Object.fromEntries(measurements.results.map((r) => [r.key, r]));
const perCast = (r) => ({
	fish: r.units / r.casts,
	xp: r.xpBase / r.casts,
	xpFinal: r.xpFinal / r.casts,
	value: r.valueBase / r.casts,
	valueFinal: r.valueFinal / r.casts,
	durability: r.durability / r.casts,
	cooldownMs: r.cooldownMs,
	rarity: Object.fromEntries(Object.entries(r.rarityUnits).map(([k, v]) => [k, v / r.units])),
	lucky: (r.rarityUnits.lucky || 0) / r.casts,
});

// Rod stages. Crafted rods use the measured representative with the closest catch profile (same
// weak/strong access, similar rarity stats), scaled to
// the stage's fish per cast (value and XP are per fish).
const cheap20 = rodCombos.cheapestAt20['6'];
const cheap15 = rodCombos.cheapestMaxAtLevel['30'].cheapest15;
const { expectedDrawCount } = require('../../src/engine/modifiers');
const { PROFILES } = require('../../src/engine/balance');
// Founder: same rod, Founder limits (8 draws x 5 per draw) and variable bonus draws.
const founderFish = (r) => expectedDrawCount(r.draws, PROFILES.founder.bonusDraws, PROFILES.founder.limits.maxDraws) * Math.min(PROFILES.founder.limits.maxPerDraw, r.perDraw);
const stageFrom = (label, measured, founderMeasured, r) => ({ label: `${label}: ${r.parts.join(' + ')}`, measured, founderMeasured, fishPerCast: r.fishPerCast, founderFishPerCast: founderFish(r), level: r.level, crates: r.expectedCratesForParts, durability: r.durability, repairCost: r.repairCost, cooldownMs: r.cooldownMs });
const STAGES = {
	old: { label: 'Old Rod', measured: 'Old Rod', fishPerCast: 1, level: 0, crates: 0, durability: OLD_ROD.durability, repairCost: OLD_ROD.repairCost },
	c20: stageFrom('Cheapest 6-fish crafted rod (Lv 20)', 'Custom (Common parts)', 'Custom (Uncommon parts)', cheap20),
	c30: stageFrom('Cheapest 15-fish crafted rod (Lv 30)', 'Custom (Uncommon parts)', 'Custom (Rare parts)', cheap15),
};

function castProfile(biome, stage, profile = 'normal') {
	const s = STAGES[stage];
	const founder = profile === 'founder';
	const measured = founder && stage !== 'old' ? s.founderMeasured : s.measured;
	const r = M[`${biome}|${measured}|-|${profile}`];
	if (!r) throw new Error(`No measurement for ${biome}|${measured}|${profile}`);
	const p = perCast(r);
	const target = founder ? s.founderFishPerCast : s.fishPerCast;
	const scale = stage === 'old' ? 1 : target / p.fish;
	return { ...p, fish: p.fish * scale, xp: p.xp * scale, xpFinal: p.xpFinal * scale, value: p.value * scale, valueFinal: p.valueFinal * scale, durability: p.durability * scale, lucky: p.lucky * scale, cooldownMs: founder ? p.cooldownMs : (s.cooldownMs || p.cooldownMs) };
}

/** Expected fish needed to finish a daily quest, given per-fish rarity rates. */
function dailyFishNeeded(q, rarityRates) {
	const want = q.progressType.rarity[0];
	if (want === 'any') return q.progressMax;
	const rate = rarityRates[want] || 1e-9;
	return q.progressMax / rate;
}

const ARCHETYPES = {
	casual: { minutesPerDay: 12.5, overheadS: 7, votes: 1 },
	regular: { minutesPerDay: 45, overheadS: 4, votes: 1 },
	active: { minutesPerDay: 120, overheadS: 3, votes: 2 },
	grinder: { minutesPerDay: 300, overheadS: 2, votes: 2 },
};

function simulate(name, arch, { days = 30, votes = false, questFarming = false, profile = 'normal' } = {}) {
	const st = { xp: 0, money: 0, stage: 'old', rodLife: STAGES.old.durability, repairs: 0, crates: 0, day: 0 };
	const sources = { fishSales: 0, dailyQuests: 0, farmQuests: 0, votes: 0, voterCrateLiquid: 0, dailyBoxLiquid: 0 };
	const sinks = { repairs: 0, crates: 0 };
	const xpSources = { fish: 0, dailyQuests: 0, farmQuests: 0 };
	const milestones = {};
	const unlocks = {};
	const timeline = [];
	let minutesPlayed = 0;
	let daily = null;
	let dailyReadyAt = 0;
	const farm = { fish: 0 };

	for (let day = 1; day <= days; day++) {
		let seconds = arch.minutesPerDay * 60;
		if (votes && arch.votes) {
			sources.votes += 10000 * arch.votes;
			st.money += 10000 * arch.votes;
			sources.voterCrateLiquid += gachaEv['Voter\'s Crate'].expectedLiquidValuePerOpen * arch.votes;
			st.money += gachaEv['Voter\'s Crate'].expectedLiquidValuePerOpen * arch.votes;
		}
		// Daily quest: one at a time, a new one at most every 24h after the previous was accepted.
		const level0 = levelForXp(st.xp);
		if (!daily && day >= dailyReadyAt) {
			const eligible = quests.filter((q) => q.daily && q.requirements.level <= level0);
			daily = { eligible, progressFish: 0 };
			dailyReadyAt = day + 1;
		}
		while (seconds > 0) {
			const level = levelForXp(st.xp);
			const biome = [...BIOME_ORDER].reverse().find((b) => level >= BIOME_LEVEL[b]);
			// Rod upgrades.
			for (const stage of ['c20', 'c30']) {
				const s = STAGES[stage];
				const order = ['old', 'c20', 'c30'];
				if (order.indexOf(stage) > order.indexOf(st.stage) && level >= s.level) {
					const cost = Math.max(0, s.crates - st.crates) * CRATE_PRICE;
					if (st.money >= cost + 2000) {
						st.money -= cost;
						sinks.crates += cost;
						st.crates = 0;
						st.stage = stage;
						st.rodLife = s.durability;
						st.repairs = 0;
						milestones[`rod:${stage}`] = milestones[`rod:${stage}`] || { day, hours: +(minutesPlayed / 60).toFixed(2), level };
					}
				}
			}
			const cp = castProfile(biome, st.stage, profile);
			const interval = cp.cooldownMs / 1000 + arch.overheadS;
			// Simulate in chunks of one minute of play.
			const chunk = Math.min(60, seconds);
			const casts = chunk / interval;
			seconds -= chunk;
			minutesPlayed += chunk / 60;

			const xp = casts * (profile === 'normal' ? cp.xp : cp.xpFinal);
			const value = casts * (profile === 'normal' ? cp.value : cp.valueFinal);
			const fish = casts * cp.fish;
			st.xp += xp;
			xpSources.fish += xp;
			st.money += value;
			sources.fishSales += value;

			// Durability and repairs.
			st.rodLife -= casts * cp.durability;
			while (st.rodLife <= 0) {
				const s = STAGES[st.stage];
				if (st.repairs < 3) {
					st.money -= s.repairCost;
					sinks.repairs += s.repairCost;
					st.repairs++;
					st.rodLife += s.durability;
				}
				else if (st.stage === 'old') {
					st.repairs = 0;
					st.rodLife += s.durability;
				}
				else {
					// Destroyed crafted rod: parts must be re-collected.
					const cost = s.crates * CRATE_PRICE;
					st.money -= cost;
					sinks.crates += cost;
					st.repairs = 0;
					st.rodLife += s.durability;
				}
			}

			// Daily quest progress (expected value over the eligible quest pool).
			if (daily) {
				daily.progressFish += fish;
				const need = daily.eligible.reduce((s, q) => s + dailyFishNeeded(q, cp.rarity), 0) / daily.eligible.length;
				if (daily.progressFish >= need) {
					const cash = daily.eligible.reduce((s, q) => s + q.cash, 0) / daily.eligible.length;
					const qxp = daily.eligible.reduce((s, q) => s + q.xp, 0) / daily.eligible.length;
					const mult = profile === 'founder' ? 5 : 1;
					st.money += cash * mult;
					sources.dailyQuests += cash * mult;
					st.xp += qxp * mult;
					xpSources.dailyQuests += qxp * mult;
					st.money += gachaEv['Daily Box'].expectedLiquidValuePerOpen;
					sources.dailyBoxLiquid += gachaEv['Daily Box'].expectedLiquidValuePerOpen;
					// Daily Box parts count toward the next crafted rod.
					st.crates += 0.18;
					daily = null;
				}
			}
			// Repeatable "Help the Village!" farming: $3000 + 300 XP per 30 fish.
			if (questFarming) {
				farm.fish += fish;
				const done = Math.floor(farm.fish / 30);
				if (done > 0) {
					farm.fish -= done * 30;
					const mult = profile === 'founder' ? 5 : 1;
					st.money += done * 3000 * mult;
					sources.farmQuests += done * 3000 * mult;
					st.xp += done * 300 * mult;
					xpSources.farmQuests += done * 300 * mult;
				}
			}

			const lv = levelForXp(st.xp);
			for (const L of [10, 20, 30, 40, 50, 60, 70]) {
				if (lv >= L && !milestones[`level${L}`]) milestones[`level${L}`] = { day, hours: +(minutesPlayed / 60).toFixed(2) };
			}
			for (const b of BIOME_ORDER) {
				if (lv >= BIOME_LEVEL[b] && !unlocks[b]) unlocks[b] = { day, hours: +(minutesPlayed / 60).toFixed(2) };
			}
		}
		if ([1, 7, 14, 30, 60, 90].includes(day)) {
			timeline.push({ day, hoursPlayed: +(minutesPlayed / 60).toFixed(1), level: levelForXp(st.xp), xp: Math.round(st.xp), money: Math.round(st.money), stage: st.stage });
		}
	}
	const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));
	return { name, profile, days, votes, questFarming, arch, milestones, unlocks, timeline, sources: round(sources), sinks: round(sinks), xpSources: round(xpSources) };
}

/** Per-biome, per-setup hourly rates at a fixed human cadence (4 s overhead). */
function rateTable(overheadS = 4) {
	const rows = [];
	for (const r of measurements.results) {
		const p = perCast(r);
		const castsPerHour = 3600 / (p.cooldownMs / 1000 + overheadS);
		rows.push({
			key: r.key,
			fishPerCast: +p.fish.toFixed(2),
			xpPerCast: +p.xp.toFixed(1),
			xpFinalPerCast: +p.xpFinal.toFixed(1),
			valuePerCast: +p.value.toFixed(1),
			valueFinalPerCast: +p.valueFinal.toFixed(1),
			valuePerFish: +(p.value / p.fish).toFixed(1),
			castsPerHour: Math.round(castsPerHour),
			xpPerHour: Math.round(p.xp * castsPerHour),
			xpFinalPerHour: Math.round(p.xpFinal * castsPerHour),
			cashPerHour: Math.round(p.value * castsPerHour),
			cashFinalPerHour: Math.round(p.valueFinal * castsPerHour),
			durabilityPerCast: +p.durability.toFixed(2),
			rarity: Object.fromEntries(Object.entries(p.rarity).map(([k, v]) => [k, +(v * 100).toFixed(3)])),
			valueByRarityPerFish: Object.fromEntries(Object.entries(r.rarityValueBase).map(([k, v]) => [k, +(v / (r.rarityUnits[k] - 0 || 1)).toFixed(1)])),
			itemsPerCast: +(r.itemUnits / r.casts).toFixed(4),
			failures: r.failures,
		});
	}
	return rows;
}

/** Bait economics per biome: extra sale value and XP per unit of bait vs its price. */
function baitTable() {
	const prices = Object.fromEntries(require('../../src/bootstrap/data/bait').map((b) => [b.name, b.price]));
	const rows = [];
	for (const biome of BIOME_ORDER) {
		const base = perCast(M[`${biome}|Old Rod|-|normal`]);
		for (const [name, price] of Object.entries(prices)) {
			const r = M[`${biome}|Old Rod|${name}|normal`];
			if (!r) continue;
			const p = perCast(r);
			// Bait is consumed per fish caught.
			const unitsPerCast = p.fish;
			const costPerCast = unitsPerCast * price;
			rows.push({
				biome, bait: name, price, fishPerCast: +p.fish.toFixed(2),
				valuePerCast: +p.value.toFixed(1), baseValuePerCast: +base.value.toFixed(1),
				extraValuePerCast: +(p.value - base.value).toFixed(1), costPerCast,
				netPerCast: +(p.value - base.value - costPerCast).toFixed(1),
				roi: +((p.value - base.value) / costPerCast).toFixed(3),
				extraXpPerCast: +(p.xp - base.xp).toFixed(1),
				costPerExtraXp: p.xp > base.xp ? +(costPerCast / (p.xp - base.xp)).toFixed(1) : null,
			});
		}
	}
	return rows;
}

const out = {
	generatedFrom: { measurements: measurements.generatedAt, castsPerScenario: measurements.castsPerScenario, balanceVersion: measurements.balanceVersion },
	stages: STAGES,
	rates: rateTable(),
	bait: baitTable(),
	players: {},
};
for (const [name, arch] of Object.entries(ARCHETYPES)) {
	out.players[name] = {
		core: simulate(name, arch, { days: 30 }),
		withVotes: simulate(name, arch, { days: 30, votes: true }),
		questFarming: simulate(name, arch, { days: 30, questFarming: true }),
		founder: simulate(name, arch, { days: 30, profile: 'founder' }),
	};
}
process.stdout.write(JSON.stringify(out, null, 1));
