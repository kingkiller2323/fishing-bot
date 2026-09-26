// Phase 5B INTEGRATION (framework 5b.3; 5b.5: standard rods + upgrades): composes every subsystem's `system()` on the shared lifecycle
// core (lifecycle.js) into one economy. Every Phase 5B progression/economy table comes from run().
//
//   const I = require('./integrate');
//   I.run({ archetype: 'regular', variant: { bait: 'none', aquarium: false, founder: false } })
//
// System contract (each subsystem module exports `system(opts)` returning a lifecycle.js system):
//   rods      gear purchases (5b.5: standard shop rods on the reference ladder; tier assemblies on the custom
//             path, variant.rods 'custom'), equip at the step's level, repair upkeep, salvage refunds
//   upgrades  (5b.5) permanent cash upgrades ('optional' sink) under a purchase policy (variant.upgrades:
//             F.UPGRADE_POLICY in the reference loop, 'none', 'greedy'); stat bonuses on every cast; always
//             composed LAST so its Bait Conservation sees the bait system's per-cast cost
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
	upgrades: () => require('./upgrades'),
};
/**
 * The reference core loop every player runs: gear (standard rods), permits, quests, streak, buffs and the
 * permanent upgrades under the reference purchase policy (5b.5; P-UPGRADES-REFERENCE-POLICY). 'upgrades' is
 * listed last on purpose (see the contract above).
 */
const REFERENCE = ['rods', 'world', 'quests', 'streak', 'buffs', 'upgrades'];
const REFERENCE_NOTE = `integrated core loop: rods (standard shop ladder, repairs) + world (permits) + quests + streak + buffs + upgrades (policy '${F.UPGRADE_POLICY}'), no bait, no aquarium`;
/** Gear path of each rods variant (variant.rods). */
const RODS_LADDERS = { standard: () => F.gearPath(), custom: () => require('./rods').customPath() };
/** Which level gates content for the Founder variant: PROPOSED 'public' (decisions.js P-FOUNDER-GATE). */
const DEFAULT_FOUNDER_GATE = 'public';

function systemOf(name, opts = {}) {
	const mod = REGISTRY[name]();
	if (typeof mod.system !== 'function') throw new Error(`${name}.js does not export system() yet`);
	return mod.system(opts);
}

/** The reference systems (fresh instances: systems keep per-run state in state.sys only). */
function referenceSystems(opts = {}) {
	return REFERENCE.map((n) => systemOf(n, { ...(n === 'upgrades' ? { policy: F.UPGRADE_POLICY } : {}), ...(opts[n] || {}) }));
}

/**
 * One integrated lifecycle.
 * @param {object} o { archetype, variant: { bait: 'none'|'cash'|'xp', aquarium: bool, founder: bool,
 *   gate: 'public'|'real', rods: 'standard'|'custom' (5b.5), upgrades: an upgrades.js policy name (5b.5;
 *   default F.UPGRADE_POLICY; 'none' leaves the system out) }, exclude: [system names],
 *   systemOpts: { [name]: opts }, ...simulate opts }
 */
function run(o = {}) {
	const variant = { bait: 'none', aquarium: false, founder: false, rods: 'standard', upgrades: F.UPGRADE_POLICY, ...(o.variant || {}) };
	variant.gate = variant.gate || (variant.founder ? DEFAULT_FOUNDER_GATE : 'real');
	if (!RODS_LADDERS[variant.rods]) throw new Error(`Unknown rods variant ${variant.rods}`);
	const names = REFERENCE.filter((n) => n !== 'upgrades' && !(o.exclude || []).includes(n));
	if (variant.bait !== 'none') names.push('bait');
	if (variant.aquarium) names.push('aquarium');
	if (variant.founder) names.push('founder');
	if (variant.upgrades !== 'none' && !(o.exclude || []).includes('upgrades')) names.push('upgrades');
	const opts = o.systemOpts || {};
	const systems = names.map((n) => systemOf(n, {
		...(opts[n] || {}), ...(n === 'bait' ? { policy: variant.bait } : {}), ...(n === 'founder' ? { gate: variant.gate } : {}), ...(n === 'upgrades' ? { policy: variant.upgrades } : {}),
	}));
	// Founder runs continue until the PUBLIC level reaches the stop level (the real level races ahead).
	const stopOn = o.stopOn || (variant.founder ? 'public' : 'gate');
	const gearPath = o.gearPath || (variant.rods === 'standard' ? undefined : RODS_LADDERS[variant.rods]());
	const result = LC.simulate({ ...o, stopOn, systems, gate: variant.founder ? variant.gate : 'real', ...(gearPath ? { gearPath } : {}) });
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

module.exports = { REGISTRY, REFERENCE, REFERENCE_NOTE, RODS_LADDERS, DEFAULT_FOUNDER_GATE, systemOf, referenceSystems, run, xpDecomposition, sinkSummary };
