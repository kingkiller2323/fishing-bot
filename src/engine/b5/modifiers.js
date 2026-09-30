// The 5B modifier snapshot for one cast (step C). Same stacking rule as today's resolveModifiers
// (stats add, then clamp; reward multipliers per category), with 5B sources:
//   - rod: the 5B rod profile (b5/rods.js) instead of legacy capabilities;
//   - fish per cast: the multi-catch chain from the rod's chance plus multiChance stats, capped at the
//     ceiling mean (b5/multicatch.js); no draws/perDraw;
//   - the public cast uses the Normal profile for everyone (the Founder's extra power is private, step C.11);
//     only the developer 'test' profile keeps its own table and stats.
// Later step C systems add their sources here (bait, upgrades, buffs).
const { RARITIES, NORMAL_RARITY_TABLE, COOLDOWN, STAT_CAPS, PROFILES, BALANCE_VERSION_5B } = require('../balance');
const { buildTable } = require('../rarity');
const { cappedChance } = require('./multicatch');

const STAT_KEYS = [...Object.keys(STAT_CAPS), 'multiChance'];
const emptyStats = () => Object.fromEntries(STAT_KEYS.map((k) => [k, 0]));

function addStats(target, stats = {}) {
	for (const key of STAT_KEYS) {
		const v = Number(stats[key]);
		if (Number.isFinite(v)) target[key] += v;
	}
	return target;
}

function clampStats(stats) {
	const out = Object.fromEntries(Object.keys(STAT_CAPS).map((k) => [k, Math.min(STAT_CAPS[k].max, Math.max(STAT_CAPS[k].min, stats[k] || 0))]));
	out.multiChance = Math.min(1, Math.max(0, stats.multiChance || 0));
	return out;
}

/** The profile whose mechanics the public cast uses: Normal for everyone except the developer test profile. */
const publicProfileOf = (profile) => (profile?.name === 'test' ? profile : { name: 'normal', ...PROFILES.normal });

/**
 * @param {object} input { profile, rod (the 5B rod profile), bait: { stats, qualities, applied, name, id } | null,
 *   buffs: { xp } (bonus), event, user, now, extraSources: [{ source, stats }] }
 */
function resolveModifiers5b({ profile, rod, bait = null, buffs = { xp: 0, list: [] }, event = null, user = null, now = new Date(), extraSources = [] }) {
	const pub = publicProfileOf(profile);
	const sources = [{ source: 'base', stats: {}, note: `balance ${BALANCE_VERSION_5B}` }];
	const total = emptyStats();

	addStats(total, pub.stats);
	sources.push({ source: 'profile', name: pub.name, stats: { ...(pub.stats || {}) } });

	addStats(total, rod.stats);
	total.multiChance += rod.multiChance || 0;
	sources.push({ source: 'rod', name: rod.name, kind: rod.kind, method: rod.method || null, stats: { ...rod.stats }, multiChance: rod.multiChance || 0 });

	if (bait) {
		const applied = bait.applied ? bait.stats : {};
		addStats(total, applied);
		sources.push({ source: 'bait', id: bait.id, name: bait.name, applied: bait.applied, stats: { ...applied } });
	}

	for (const extra of extraSources) {
		addStats(total, extra.stats);
		sources.push({ ...extra });
	}

	if (buffs.list?.length) sources.push({ source: 'buff', buffs: buffs.list });

	const devLuck = user?.devOverrides?.luck;
	const devLuckActive = Boolean(devLuck && Number.isFinite(devLuck.value) && (!devLuck.expiresAt || new Date(devLuck.expiresAt) > now));
	if (devLuckActive) {
		addStats(total, { luck: devLuck.value });
		sources.push({ source: 'dev', stats: { luck: devLuck.value }, expiresAt: devLuck.expiresAt || null });
	}

	if (event) {
		addStats(total, event.stats);
		sources.push({ source: 'event', name: event.name, stats: { ...event.stats }, multipliers: { ...event.multipliers } });
	}

	const stats = clampStats(total);
	const eventMult = event?.multipliers || {};
	const xp = (1 + stats.xpBonus) * (1 + (buffs.xp || 0)) * (eventMult.xp || 1);
	const sell = (1 + stats.sellBonus) * (eventMult.sell || 1);
	const multi = cappedChance(stats.multiChance);
	const qualities = [...new Set([...rod.qualities, ...(bait?.applied ? bait.qualities || [] : [])])];
	const rarityBase = pub.rarityTable || NORMAL_RARITY_TABLE;

	return {
		balanceVersion: BALANCE_VERSION_5B,
		profile: profile?.name,
		competitiveEligible: Boolean(profile?.competitiveEligible) && !devLuckActive,
		sources,
		stats,
		qualities,
		multi: { chance: multi.chance, capped: multi.capped, raw: stats.multiChance },
		// Every public multiplier is the Normal player's: the profile adds nothing to the public cast.
		xp: { gear: stats.xpBonus, buff: buffs.xp || 0, event: eventMult.xp || 1, withoutProfile: xp, multiplier: xp },
		sell: { gear: stats.sellBonus, event: eventMult.sell || 1, withoutProfile: sell, multiplier: sell },
		quest: { xp: eventMult.questXp || 1, cash: eventMult.questCash || 1, xpWithoutProfile: eventMult.questXp || 1, cashWithoutProfile: eventMult.questCash || 1 },
		durabilityEfficiency: stats.durabilityEfficiency,
		cooldownMs: Math.max(COOLDOWN.minMs, Math.round(COOLDOWN.fishMs * (1 - stats.fishingSpeed))),
		rarity: { base: buildTable(rarityBase), table: buildTable(rarityBase, stats) },
	};
}

module.exports = { resolveModifiers5b, publicProfileOf, clampStats, RARITIES };
