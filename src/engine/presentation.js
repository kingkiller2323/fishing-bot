// Private reward/odds presentation. Public catch cards never show profile information; these views
// are only ever sent ephemerally to the player themselves (/fishing-stats).
const { RARITIES } = require('./balance');

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const num = (n) => Math.round(n).toLocaleString('en-US');
const pct = (p) => (p >= 1 ? p.toFixed(1) : p >= 0.1 ? p.toFixed(2) : p.toFixed(3));

/** Builds the private stats view (plain data -> embed fields). */
function privateStatsFields({ stats, lastCast }) {
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

	if (lastCast?.rewards) {
		const r = lastCast.rewards;
		const show = (label, x, fmt) => (x.profileBonus
			? `${label} ${fmt(x.final)} (${fmt(x.base)} + ${fmt(x.profileBonus)} bonus)`
			: `${label} ${fmt(x.final)}`);
		const parts = [show('XP', r.xp, num)];
		if (r.catchValue.final) parts.push(show('Catch value', r.catchValue, money));
		if (r.questCash.final) parts.push(show('Quest cash', r.questCash, money));
		fields.push({ name: 'Last cast', value: parts.join('\n') });
	}
	return fields;
}

module.exports = { privateStatsFields };
