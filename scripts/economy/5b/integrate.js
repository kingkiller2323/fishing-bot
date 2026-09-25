// Phase 5B INTEGRATION (framework 5b.3): composes every subsystem's `system()` on the shared lifecycle
// core (lifecycle.js) into one economy. Every Phase 5B progression/economy table comes from run().
//
//   const I = require('./integrate');
//   I.run({ archetype: 'regular', variant: { bait: 'none', aquarium: false, founder: false } })
//
// System contract (each subsystem module exports `system(opts)` returning a lifecycle.js system):
//   rods      gear purchases (tier assemblies, equip at tier level), repair upkeep, salvage refunds
//   world     biome access (canFish: permit held) and permit purchases
//   quests    daily/weekly/repeatable/story income (XP and cash by kind), Daily Box grants; the daily
//             requirement is its sessionDone() for the minimum-daily player
//   streak    streak credit from the day's casts, Streak Crate/Chest grants; its play gate is its
//             sessionDone()
//   buffs     buff arrivals from granted boxes ('box' events) and the event budget; Double XP / Double
//             Cash applied to casts in their window (catch-time); Lucky Draw value
//   bait      (variant) bait stats and per-cast cost ('optional' sink)
//   aquarium  (variant) licenses/display tanks ('optional' / 'aspirational'), companion sell bonus
//   founder   (variant) the Founder profile: cast outcome override with base (public) and final (account)
//             XP/value; run with gate 'public' or 'real'
// Counting rule: a box's non-buff contents are valued ONCE, by the system that grants it; buff effects
// are valued once, by the buffs system, from the 'box' events. Each system writes only its own ledger
// sources and spend items.
const F = require('./framework');
const LC = require('./lifecycle');

const REGISTRY = {
	rods: () => require('./rods'),
	world: () => require('./world'),
	quests: () => require('./quests'),
	streak: () => require('./streak'),
	buffs: () => require('./buffs'),
	bait: () => require('./bait'),
	aquarium: () => require('./aquarium'),
	founder: () => require('./founder'),
};
/** The approved core loop every player runs: gear, permits, quests, streak and buffs. */
const REFERENCE = ['rods', 'world', 'quests', 'streak', 'buffs'];
const REFERENCE_NOTE = 'integrated core loop: rods (gear purchases, repairs) + world (permits) + quests + streak + buffs, no bait, no aquarium';

function systemOf(name, opts = {}) {
	const mod = REGISTRY[name]();
	if (typeof mod.system !== 'function') throw new Error(`${name}.js does not export system() yet`);
	return mod.system(opts);
}

/** The reference systems (fresh instances: systems keep per-run state in state.sys only). */
function referenceSystems(opts = {}) {
	return REFERENCE.map((n) => systemOf(n, opts[n] || {}));
}

/**
 * One integrated lifecycle.
 * @param {object} o { archetype, variant: { bait: 'none'|'cash'|'xp', aquarium: bool, founder: bool,
 *   gate: 'public'|'real' }, exclude: [system names], systemOpts: { [name]: opts }, ...simulate opts }
 */
function run(o = {}) {
	const variant = { bait: 'none', aquarium: false, founder: false, gate: 'real', ...(o.variant || {}) };
	const names = REFERENCE.filter((n) => !(o.exclude || []).includes(n));
	if (variant.bait !== 'none') names.push('bait');
	if (variant.aquarium) names.push('aquarium');
	if (variant.founder) names.push('founder');
	const opts = o.systemOpts || {};
	const systems = names.map((n) => systemOf(n, { ...(opts[n] || {}), ...(n === 'bait' ? { policy: variant.bait } : {}), ...(n === 'founder' ? { gate: variant.gate } : {}) }));
	const result = LC.simulate({ ...o, systems, gate: variant.founder ? variant.gate : 'real' });
	return { ...result, variant, systems: names, ...F.stamp() };
}

/** XP by source (account and public) and each source's share, at each recorded milestone. */
function xpDecomposition(result, which = 'milestones') {
	const out = {};
	for (const [L, m] of Object.entries(result[which])) {
		if (!/^\d+$/.test(L) || !m.ledger) continue;
		const xp = m.ledger.xp;
		const total = Object.values(xp).reduce((a, b) => a + b, 0);
		out[L] = {
			hours: m.hours, day: m.day, totalXp: Math.round(total),
			bySource: Object.fromEntries(Object.entries(xp).map(([k, v]) => [k, Math.round(v)])),
			share: Object.fromEntries(Object.entries(xp).map(([k, v]) => [k, +(v / total).toFixed(4)])),
		};
	}
	return out;
}

/** Money sources and sinks by category over a run, with shares of gross income. */
function sinkSummary(result) {
	const income = Object.values(result.ledger.cash).reduce((a, b) => a + b, 0);
	const byCategory = Object.fromEntries(Object.entries(result.ledger.spend).map(([c, items]) => {
		const total = Object.values(items).reduce((a, b) => a + b, 0);
		return [c, { total: Math.round(total), share: +(total / income).toFixed(4), items: Object.fromEntries(Object.entries(items).map(([k, v]) => [k, Math.round(v)])) }];
	}));
	return { income: Math.round(income), sources: Object.fromEntries(Object.entries(result.ledger.cash).map(([k, v]) => [k, Math.round(v)])), byCategory, saved: Math.round(result.final.money), savedShare: +(result.final.money / income).toFixed(4) };
}

module.exports = { REGISTRY, REFERENCE, REFERENCE_NOTE, systemOf, referenceSystems, run, xpDecomposition, sinkSummary };
