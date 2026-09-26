// Private reward/odds presentation. Public catch cards never show profile information; these views
// are only ever sent ephemerally to the player themselves (/fishing-stats).
const { RARITIES } = require('./balance');

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const num = (n) => Math.round(n).toLocaleString('en-US');
const pct = (p) => (p >= 1 ? p.toFixed(1) : p >= 0.1 ? p.toFixed(2) : p.toFixed(3));

/** "Base 60 · Founder +240 · Final 300" (just the final amount when there is no profile bonus). */
function breakdown(line, format, label) {
	if (!line.profileBonus) return format(line.final);
	return `Base ${format(line.base)} · ${label} +${format(line.profileBonus)} · Final ${format(line.final)}`;
}

/** Builds the private stats view (plain data -> embed fields). */
function privateStatsFields({ stats, lastCast, lastSale = null, gachaPity = null }) {
	const fields = [];
	if (stats.status !== 'ok') {
		fields.push({ name: 'Fishing', value: stats.failure?.message || 'Unavailable right now.' });
		return fields;
	}
	const m = stats.modifiers;
	const profileLine = stats.profile === 'founder'
		? '👑 **Founder** · non-competitive'
		: stats.profile === 'test' ? '🧪 **Test** · non-competitive' : 'Standard · competitive';
	fields.push({ name: 'Profile', value: `${profileLine}\n-# Balance ${stats.balanceVersion}` });

	// Real level vs the public level other players see (they differ only with private profile bonuses).
	if (stats.level) {
		const lv = stats.level;
		fields.push({ name: 'Level', value: lv.real === lv.public ? `Level ${lv.real}` : `Real level ${lv.real} · Public level ${lv.public} (others see ${lv.public})` });
	}

	fields.push({
		name: 'Odds per fish',
		value: RARITIES.map((r) => `${r.charAt(0).toUpperCase()}${r.slice(1)} ${pct(stats.odds[r])}%`).join(' · '),
	});

	const fishPerCast = (m.expectedDraws * m.perDraw);
	fields.push({
		name: 'Your multipliers',
		value: [
			`XP ×${+m.xp.multiplier.toFixed(2)} · Sale value ×${+m.sell.multiplier.toFixed(2)} · Quest ×${+m.quest.xp.toFixed(2)}`,
			`~${+fishPerCast.toFixed(1)} fish per cast · cooldown ${(stats.cooldownMs / 1000).toFixed(1)}s · durability ×${+m.durabilityCostPerFish.toFixed(2)} per fish`,
		].join('\n'),
	});

	const label = stats.profile === 'founder' ? 'Founder' : 'Bonus';
	if (lastCast?.rewards) {
		const r = lastCast.rewards;
		const parts = [`**XP:** ${breakdown(r.xp, num, label)}`];
		if (r.catchValue.final) parts.push(`**Catch value:** ${breakdown(r.catchValue, money, label)}`);
		if (r.questXp.final) parts.push(`**Quest XP:** ${breakdown(r.questXp, num, label)}`);
		if (r.questCash.final) parts.push(`**Quest cash:** ${breakdown(r.questCash, money, label)}`);
		fields.push({ name: 'Last cast (you earned)', value: parts.join('\n') });
	}

	if (lastSale && Number.isFinite(lastSale.final)) {
		const sale = { base: lastSale.base ?? lastSale.final, final: lastSale.final };
		sale.profileBonus = sale.final - sale.base;
		fields.push({ name: 'Last sale (you received)', value: breakdown(sale, money, label) });
	}

	// Gacha luck (private; box reveals never show it).
	const gacha = stats.modifiers.gacha?.stats || {};
	const gachaParts = [['rareFind', 'Rare Find'], ['luck', 'Luck'], ['trophyChance', 'Trophy']]
		.filter(([k]) => gacha[k]).map(([k, n]) => `${n} +${Math.round(gacha[k] * 100)}%`);
	if (gachaParts.length) fields.push({ name: 'Box luck', value: gachaParts.join(' · ') });

	// Pity is never shown during play; only here, privately, when it is active for the profile.
	const pity = stats.pity?.config;
	if (pity) {
		const c = stats.pity.counters || {};
		const lines = Object.entries(pity).map(([name, rule]) => `${name === 'lucky' ? 'Lucky' : 'Legendary+'}: ${c[rule.counter] || 0} casts since last · boost from ${rule.softStart} · guaranteed at ${rule.hard}`);
		const boxes = Object.entries(gachaPity || {}).filter(([, v]) => Number.isFinite(v));
		if (boxes.length) lines.push(`Boxes: ${boxes.map(([k, v]) => `${k.split(':')[0]} ${v}`).join(' · ')} opens since Legendary+`);
		fields.push({ name: 'Pity', value: lines.join('\n') });
	}
	return fields;
}

/** Size/weight display used by every public card (1 decimal, 2 below 10). */
const formatMeasure = (n) => n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 2 : 1 });

module.exports = { privateStatsFields, formatMeasure };
