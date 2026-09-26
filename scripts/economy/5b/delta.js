// Phase 5B DELTA proposal tables (docs/economy/PHASE5B_DELTA.md): the rod/upgrade/shop redesign and the
// approved follow-up changes at the current framework version. Every table is re-emitted verbatim from
// the report generator (summary.js) or from a module's markdownTables(), so it can never disagree with them.
//
//   node scripts/economy/5b/render-docs.js
const F = require('./framework');

const FROM = {
	summary: ['summary-stamp', 'summary-headline', 'summary-progression', 'summary-r1', 'summary-sinks', 'summary-open-checks'],
	rods: ['rods-hybrid', 'rods-delta', 'rods-standard', 'rods-custom-relation', 'rods-lv10-sidegrade', 'rods-ladder-checks', 'rods-custom-builds', 'rods-level-rule', 'rods-lifecycle', 'rods-shop-mock', 'rods-legacy-crate'],
	upgrades: ['upgrades-table', 'upgrades-value', 'upgrades-windows', 'upgrades-timing', 'upgrades-sinks', 'upgrades-affordability'],
	world: ['world-time-to-afford'],
	streak: ['streak-lifecycle'],
	buffs: ['buffs-cash-share-checks'],
	bait: ['bait-volume', 'bait-xp-guard'],
	founder: ['founder-hybrid-compare', 'founder-hybrid-design', 'founder-hybrid-solved', 'founder-hybrid-production', 'founder-hybrid-time', 'founder-hybrid-afford', 'founder-hybrid-durability', 'founder-hybrid-detection', 'founder-hybrid-tells', 'founder-hybrid-tradeoff'],
};

function markdownTables() {
	const out = {};
	for (const [m, ids] of Object.entries(FROM)) {
		const tables = require(`./${m}`).markdownTables();
		for (const id of ids) {
			if (!(id in tables)) throw new Error(`${m}.js markdownTables() has no block ${id}`);
			out[id] = m === 'summary' ? tables[id].trim() : `${tables[id].trim()}\n\n*(From \`docs/economy/5b/${m}.md\`.)*`;
		}
	}
	return out;
}

function report() {
	return { ...F.stamp(), blocks: Object.keys(FROM).flatMap((m) => FROM[m]) };
}

module.exports = { markdownTables, report, FROM };
