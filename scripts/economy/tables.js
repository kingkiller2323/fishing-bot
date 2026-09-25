// Renders the Phase 5 simulation output as Markdown tables (pasted into PHASE5_REPORT.md).
//   node scripts/economy/tables.js > /tmp/tables.md
const sim = require('../../docs/economy/simulation.json');
const gacha = require('../../docs/economy/gacha-ev.json');
const combos = require('../../docs/economy/rod-combos.json');

const fmt = (n) => (n === undefined || n === null ? '—' : Math.round(n).toLocaleString('en-US'));
const money = (n) => (n === undefined || n === null ? '—' : `$${fmt(n)}`);
const hrs = (m) => (m ? `${m.hours}h (day ${m.day})` : 'not reached');
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const out = [];

out.push('### Per-cast and per-hour rates (normal profile, 4 s reaction overhead)\n');
const BIOMES = ['ocean', 'river', 'lake', 'pond', 'coast', 'swamp'];
const setups = ['Old Rod|-', 'Custom (Common parts)|-', 'Custom (Uncommon parts)|-', 'Custom (Rare parts)|-', 'Custom (Legendary parts)|-'];
for (const setup of setups) {
	out.push(`**${setup.replace('|-', '')}**\n`);
	out.push(table(['Biome', 'Fish/cast', 'XP/cast', '$/cast', '$/fish', 'Casts/h', 'XP/h', '$/h'],
		BIOMES.map((b) => {
			const r = sim.rates.find((x) => x.key === `${b}|${setup}|normal`);
			return [b, r.fishPerCast, r.xpPerCast, fmt(r.valuePerCast), fmt(r.valuePerFish), r.castsPerHour, fmt(r.xpPerHour), money(r.cashPerHour)];
		})));
	out.push('');
}

out.push('### Rarity mix and sale value per fish by rarity (Old Rod, normal)\n');
const R = ['common', 'uncommon', 'rare', 'ultra', 'giant', 'legendary', 'lucky'];
out.push(table(['Biome', ...R.map((r) => `${r} %`), ...R.map((r) => `${r} $`)],
	BIOMES.map((b) => {
		const r = sim.rates.find((x) => x.key === `${b}|Old Rod|-|normal`);
		return [b, ...R.map((k) => r.rarity[k] ?? 0), ...R.map((k) => fmt(r.valueByRarityPerFish[k]))];
	})));
out.push('');
out.push('### Rarity mix and sale value per fish by rarity (Custom rare-parts rod, normal)\n');
out.push(table(['Biome', ...R.map((r) => `${r} %`), ...R.map((r) => `${r} $`)],
	BIOMES.map((b) => {
		const r = sim.rates.find((x) => x.key === `${b}|Custom (Rare parts)|-|normal`);
		return [b, ...R.map((k) => r.rarity[k] ?? 0), ...R.map((k) => fmt(r.valueByRarityPerFish[k]))];
	})));
out.push('');

out.push('### Bait: value per cast vs cost per cast (Old Rod, normal; bait is consumed per fish)\n');
out.push(table(['Biome', 'Bait', 'Price/unit', 'Fish/cast', '$/cast (no bait)', '$/cast (bait)', 'Cost/cast', 'Net/cast', 'Return per $1', 'Extra XP/cast'],
	sim.bait.map((b) => [b.biome, b.bait, money(b.price), b.fishPerCast, fmt(b.baseValuePerCast), fmt(b.valuePerCast), money(b.costPerCast), fmt(b.netPerCast), b.roi.toFixed(2), b.extraXpPerCast])));
out.push('');

out.push('### Gacha boxes (normal profile, exact from the V2 definitions)\n');
out.push(table(['Box', 'Price', 'Slots', 'Liquid value/open', 'Fish share', 'Bait share', 'Part share', 'Buff share', 'Rod share'],
	Object.entries(gacha).map(([name, b]) => {
		const t = b.typeShare;
		const part = Object.entries(t).filter(([k]) => k.startsWith('part_')).reduce((s, [, v]) => s + v, 0);
		const pct = (v) => `${((v || 0) * 100).toFixed(1)}%`;
		return [name, name === 'Fishing Crate' ? '$750' : 'not sold', b.slots, money(b.expectedLiquidValuePerOpen), pct(t.fish), pct(t.bait), pct(part), pct(t.buff), pct(t.rod)];
	})));
out.push('');

out.push('### Crafted rods\n');
out.push(`${combos.combos} possible part combinations; minimum level requirement Lv ${combos.minLevel}. Fish per cast across all combinations: ${Object.entries(combos.fishPerCastDistribution).map(([k, v]) => `${k} fish: ${v}`).join(', ')}.\n`);
out.push(table(['Level', 'Best rod (fish/cast, cooldown)', 'Parts', 'Durability', 'Casts per life', 'Repair', 'Cheapest 15-fish rod (crates)'],
	Object.entries(combos.cheapestMaxAtLevel).map(([L, r]) => [L, `${r.fishPerCast} fish, ${r.cooldownMs / 1000}s`, r.parts.join(' + '), fmt(r.durability), fmt(r.castsPerLife), money(r.repairCost), r.cheapest15 ? `${r.cheapest15.parts.join(' + ')} (Lv ${r.cheapest15.level}, ~${r.cheapest15.expectedCratesForParts} crates ≈ ${money(r.cheapest15.expectedCratesForParts * 750)})` : '—'])));
out.push('');

for (const variant of ['core', 'withVotes', 'questFarming', 'founder']) {
	out.push(`### Player simulation: ${variant}\n`);
	out.push(table(['Player', 'Lv10', 'Lv20', 'Lv30', 'Lv40', 'Lv50', 'Crafted Lv20 rod', '15-fish rod'],
		Object.entries(sim.players).map(([name, v]) => {
			const s = v[variant];
			return [`${name} (${s.arch.minutesPerDay} min/day)`, hrs(s.milestones.level10), hrs(s.milestones.level20), hrs(s.milestones.level30), hrs(s.milestones.level40), hrs(s.milestones.level50), hrs(s.milestones['rod:c20']), hrs(s.milestones['rod:c30'])];
		})));
	out.push('');
	out.push(table(['Player', 'Day 1 (Lv / $)', 'Day 7 (Lv / $)', 'Day 30 (Lv / $)', 'Fish sales', 'Daily quests', 'Quest farming', 'Votes', 'Box liquid', 'Repairs', 'Crates'],
		Object.entries(sim.players).map(([name, v]) => {
			const s = v[variant];
			const d = (day) => {
				const t = s.timeline.find((x) => x.day === day);
				return t ? `Lv ${t.level} / ${money(t.money)}` : '—';
			};
			const src = s.sources;
			return [name, d(1), d(7), d(30), money(src.fishSales), money(src.dailyQuests), money(src.farmQuests), money(src.votes), money(src.voterCrateLiquid + src.dailyBoxLiquid), money(s.sinks.repairs), money(s.sinks.crates)];
		})));
	out.push('');
}
process.stdout.write(out.join('\n'));

// ---- Proposal (docs/economy/proposal.json) ----
const prop = require('../../docs/economy/proposal.json');
const p = [];
p.push('### Proposed: XP required per level (no demotions: level = max(stored, curve))\n');
p.push(table(['Level', 'Current XP', 'Proposed XP'], Object.entries(prop.curve).map(([L, c]) => [L, fmt(c.current), fmt(c.proposed)])));
p.push('');
p.push('### Proposed: hourly rates by biome and rod tier (normal, 4 s overhead)\n');
const tiers = Object.keys(prop.proposal.rods);
p.push(table(['Biome', ...tiers.map((t) => `${t} XP/h`), ...tiers.map((t) => `${t} $/h`)],
	['ocean', 'river', 'lake', 'pond', 'coast', 'swamp'].map((b) => [b, ...tiers.map((t) => fmt(prop.rates.find((r) => r.biome === b && r.tier === t).xpPerHour)), ...tiers.map((t) => money(prop.rates.find((r) => r.biome === b && r.tier === t).cashPerHour))])));
p.push('');
p.push('### Proposed: player simulation (90 days, dailies + streak crate, no votes, no exploits)\n');
p.push(table(['Player', 'Lv10', 'Lv20', 'Lv30', 'Lv40', 'Lv50', 'Tier 2 rod', 'Tier 4 rod'],
	Object.entries(prop.players).map(([n, s]) => [`${n} (${s.arch.minutesPerDay} min/day)`, hrs(s.milestones.level10), hrs(s.milestones.level20), hrs(s.milestones.level30), hrs(s.milestones.level40), hrs(s.milestones.level50), hrs(s.milestones['rod:t2']), hrs(s.milestones['rod:t4'])])));
p.push('');
p.push(table(['Player', 'Day 1', 'Day 7', 'Day 30', 'Day 90', 'Fish sales', 'Dailies', 'Permits', 'Crates', 'Repairs', 'Licenses'],
	Object.entries(prop.players).map(([n, s]) => {
		const d = (day) => {
			const t = s.timeline.find((x) => x.day === day);
			return t ? `Lv ${t.level} / ${money(t.money)}` : '—';
		};
		return [n, d(1), d(7), d(30), d(90), money(s.sources.fishSales), money(s.sources.dailyQuests), money(s.sinks.permits), money(s.sinks.crates), money(s.sinks.repairs), money(s.sinks.licenses)];
	})));
p.push('');
process.stdout.write(`\n${p.join('\n')}`);
