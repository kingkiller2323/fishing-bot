// Phase 5B subsystem: QUESTS (quest type model, catalog, correctness fixes). ANALYSIS ONLY: nothing here
// touches the live game, src/ or production data.
//
// Every economic number is computed at runtime from the shared framework (./framework.js, which
// re-exports assumptions.js): archetypes, target windows, lifecycle settings, biome levels, gear path,
// curve, value model and multi-catch all come from F and are never copied here. Only the quest design
// parameters in PARAMS are hand-set, and they are expressed as formulas of framework values:
// requirements are shares of an archetype's session (F.ARCHETYPES), rewards are multiples of the XP/cash
// the required fishing earns at the band's stage (F.castOutcome / F.hourly). A framework version bump
// therefore regenerates every figure below without manual scaling.
//
//   node -e "require('./scripts/economy/5b/quests.js').report()"     (returns the report object)
//   node scripts/economy/5b/quests.js                                 (prints it as JSON)
//
// Exports (pure and synchronous; no database, no randomness):
//   PARAMS                  frozen quest design parameters (kinds, period rules, daily/weekly/repeatable
//                           requirement shares and reward factors, repeatable cooldown and caps, story
//                           quests with pity rules, legacy title map, guardrails)
//   KINDS                   ['story', 'daily', 'weekly', 'repeatable']
//   SCHEMA                  the additive QuestSchema / UserSchema fields the implementation adds (data)
//   kindOf(questDoc)        kind of a template or instance; pre-5B documents (no `kind`) are 'legacy'
//   periodKey(kind, ms)     UTC period key: daily 'D2026-09-25', weekly ISO 'W2026-39', else null
//   expiresAt(kind, ms)     end of the instance's period (ms), or null for story/repeatable
//   canStart(template, state, ms)
//                           the start rule for story/repeatable templates: { ok, reason }. state =
//                           { level, questLog: { [key]: { completions, lastCompletedAt } }, active: [keys],
//                           repeatableCompletionsToday }
//   resolveLegacy(doc)      read-time mapping of a pre-5B QuestData document (no write): the template it
//                           maps to, effective progressType/progressMax, reward rule; never blocks /daily
//   ruleExamples()          worked examples of periodKey/expiresAt/canStart/resolveLegacy (test cases)
//   speciesFamily(biome, suffix)
//                           catalog species of a biome whose name ends with `suffix` (e.g. River 'Trout')
//   catalogIntegrity(quests)
//                           quest fish targets and reward items that do not exist in the seeded catalog
//   binomialAtLeast(n, p, k), fishForQuantile(p, k, q)
//                           completion odds of rarity/species targets without pity
//   pityStats(p, rule, count, weight)
//                           exact distribution of fish needed for `count` catches under an applyPity-style
//                           rule { softStart, rampPerPoint, maxBonus, hard } on a meter that each fish
//                           advances by `weight` (1 + Luck): mean / P50 / P90 / max fish
//   --- bound to the shared gear path F.gearPath() ---
//   bands(), bandFor(level) level bands (one per live biome stage + the post-50 band keyed to Mountain
//                           Stream's level) with their typical gear
//   stageRates(band, archetype)
//                           F.hourly(F.castOutcome(...)) for a band's biome and gear at an archetype's cadence
//   perFish(band, predicate, key)
//                           probability that one caught fish matches predicate(template, rarity)
//   stageFish(biome)        fish a player catches in a biome's stage by fishing alone (stage XP / XP per fish)
//   pityRule(pity, count)   a story quest's pity thresholds in meter points (shares of stageFish)
//   templateTerms(kind, def, band)
//                           computed terms of a template at a band: progressMax, target, cash, xp, boxes,
//                           expected / P50 / P90 fish, minutes at casual and regular cadence, pity
//   catalog()               the proposed catalog (seed-data shape + per-band terms)
//   storyEvents()           one-time story rewards: level, prerequisites, scope, expected fish, rewards
//   questIncome(level, fishPerDay, hoursPerDay, opts)
//                           expected quest income per day for the integrator: { cash, xp, boxes, band,
//                           breakdown: { daily, weekly, repeatable } } (story is one-time: storyEvents()).
//                           opts: { daysPerWeek, parts: { daily, weekly, repeatable }, assumeDailyComplete }
//   lifecycle(archetype, opts)
//                           curve.js-style lifecycle with the quest system (questModel 'proposed'), the
//                           provisional daily (F.DAILY, 'provisional') or no quests ('none'); XP and cash by
//                           source, milestones, calendar checkpoints. archetype = F.ARCHETYPES entry or
//                           { minimumDaily: true, overheadS }
//   replicationCheck()      lifecycle(questModel 'provisional') reproduces docs/economy/5b/curve.json
//   decomposition()         requirement R2: XP by source at the target-window levels, every archetype
//   adversarial()           requirement R2: minimum-daily player and no-miss grinder, with verdicts
//   catchUp()               per band and archetype: quest XP/cash per day, shares, completion odds
//   repeatability()         today's unlimited repeatables vs the proposed cooldown model
//   currentCatalog()        today's 13 quests evaluated under the framework (feasibility, value, bugs)
//   fixes()                 trout/carp targets, Magikarp and Lucky Fisher (pity, luck bait via bait.js)
//   founder()               Founder quest multipliers on the proposed base rewards (base vs final)
//   guardrails()            the R2 guardrail checks (pass/fail)
//   report()                every key number of docs/economy/5b/quests.md, computed, with ...F.stamp()
//   --- framework 5b.3: the quest SYSTEM on the shared lifecycle core (lifecycle.js) ---
//   system(opts)            a FRESH lifecycle.js system (per-run state in state.sys.quests only): daily/
//                           weekly/repeatable income at day end, one-time story rewards, Daily Box grants
//                           (non-buff contents as cash 'questBoxes' + a 'box' event for the buffs system);
//                           sessionDone() = today's daily requirement met (the R2 minimum-daily player)
//   validateSystem()        system() on the core vs lifecycle() (questModel 'proposed') and its R2
//                           decomposition()/adversarial(), every archetype + the minimum-daily player
//   dailyBoxValue(level, profile, sellMult)
//                           non-buff contents of one Daily Box (streak.boxEV on today's Daily Box pool)
//   withGear(gearPath)      the same bound API rebuilt on another path, for sensitivity checks only. The
//                           authoritative path is always F.gearPath() (R3: at the cutover it becomes the
//                           rods path and every figure regenerates; this module never reads rods.js)
const F = require('./framework');
const LC = require('./lifecycle');
const { drawDistribution, FISH } = require('../lib/catalog-model');
const LEGACY_QUESTS = require('../../../src/bootstrap/data/quests');
const CURVE_JSON = require('../../../docs/economy/5b/curve.json');
const { PROFILES } = require('../../../src/engine/balance');
const { BOXES } = require('../../../src/engine/gachaBoxes');
const BAIT = require('./bait');

const ITEM_CATALOG = ['rods', 'rodParts', 'bait', 'buffs', 'licenses', 'gacha']
	.flatMap((f) => require(`../../../src/bootstrap/data/${f}`))
	.map((i) => i.name);

const deepFreeze = (o) => {
	for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
	return Object.freeze(o);
};

// Framework rarity order: common .. lucky.
const RARITY_ORDER = Object.keys(F.RARITY_VALUE);
const rarityAtLeast = (min) => RARITY_ORDER.slice(RARITY_ORDER.indexOf(min));
const REF = F.REFERENCE_ARCHETYPE;
const MOUNTAIN_STREAM = 'Mountain Stream';

// ---------------------------------------------------------------------------------------------
// PARAMS: the quest design. Everything else is computed.
const PARAMS = deepFreeze({
	version: 'quests-5b.2',
	kinds: {
		story: 'one-time: a permanent per-user completion; may have a level, prerequisites and a quest pity',
		daily: 'one per DCC day (UTC), issued by /daily or lazily on the first successful cast of the day; expires at the end of its day; never blocks the next day',
		weekly: 'one per ISO week, issued with the week\'s first daily; expires at the end of the week',
		repeatable: 'player-started, repeatable forever: per-title cooldown after completion, a daily completion cap across all repeatables, one active at a time',
	},
	// The DCC day is shared with the streak (5b.3: F.DAY; never a local copy).
	period: { dayBoundaryUtcHour: F.DAY.startUtcHour, weekStart: 'ISO week (Monday 00:00 UTC)' },
	// Daily: sized to fit inside the casual archetype's session and ramped by band (later stages ask for
	// a longer share of it). Reward = factor x what the required fish earn at the band (XP and cash), so a
	// daily at most doubles the XP of the fishing it requires (R2 guardrail, by construction).
	daily: {
		requirement: { archetype: 'casual', sessionShare: { base: 0.28, perBand: 0.08 } },
		reward: { xpK: 1.0, cashK: 1.0 },
		boxes: 1, boxName: 'Daily Box',
		templates: [
			{ key: 'daily.catch', title: 'Daily Catch', description: 'Catch {n} fish today.', target: { any: true } },
			{ key: 'daily.rare', title: 'Daily Rare Hunt', description: 'Catch {n} Rare-or-better fish today.', target: { minRarity: 'rare' } },
		],
	},
	// Weekly: `dailyMultiple` days' worth of the band's daily requirement, spread over the week, same reward
	// rule (so it ramps with the daily). Rarity templates are offered in a band only when their expected
	// effort stays within maxEffortRatio x the requirement.
	weekly: {
		requirement: { dailyMultiple: 4 },
		reward: { xpK: 1.0, cashK: 1.0 },
		boxes: 2, boxName: 'Daily Box',
		maxEffortRatio: 1.5,
		unlockBiome: 'River',
		templates: [
			{ key: 'weekly.haul', title: 'Weekly Haul', description: 'Catch {n} fish this week.', target: { any: true } },
			{ key: 'weekly.bigGame', title: 'Weekly Big Game', description: 'Catch {n} Ultra-or-better fish this week.', target: { minRarity: 'ultra' } },
			{ key: 'weekly.legend', title: 'Weekly Legend Hunt', description: 'Catch {n} Legendary or Lucky fish this week.', target: { minRarity: 'legendary' } },
		],
	},
	// Repeatable: a bounded bonus on fishing the player does anyway, never a replacement for it.
	// Requirement = a third of the reference archetype's session at its cadence; reward = a share of the
	// XP/cash that fishing earns. Cooldown per title after completion, a daily cap across all titles.
	repeatable: {
		requirement: { archetype: REF, sessionShare: 1 / 3 },
		reward: { xpShare: 0.05, cashShare: 0.15 },
		boxes: 0,
		cooldownHours: 12, dailyCap: 2, maxActive: 1,
		templates: [
			{ key: 'repeatable.village', title: 'Help the Village!', description: 'Assist the local village by catching {n} fish for them.', target: { any: true } },
			{ key: 'repeatable.fishmonger', title: 'Fishmonger\'s Order', description: 'The fishmonger wants {n} Uncommon-or-better fish.', target: { minRarity: 'uncommon' } },
		],
	},
	// Story: one-time chapters. Rewards are minutes of the band's income at the reference cadence.
	// Pity rules follow engine/rarity.js applyPity semantics on a LUCK-WEIGHTED meter: each fish in scope
	// adds 1 + Luck (the cast's resolved Luck stat: rod + bait + buffs) to the quest's counter, so luck gear
	// and luck bait (bait.js Magnet / Strong Magnet) shorten the chase. Thresholds are meter points, sized
	// as shares of the fish a player catches in the quest's stage by fishing alone (computed: stageFish()).
	story: [
		{
			key: 'story.magikarp', title: 'Find the Lucky Magikarp', legacyTitle: 'Find the Lucky Magikarp', levelBiome: 'Ocean', prerequisites: [],
			description: 'Embark on a journey to find and catch the lucky Magikarp in the Ocean.',
			target: { species: ['Magikarp'], biome: 'Ocean' }, count: 1,
			pity: { stageBiome: 'Ocean', softShare: 0.1, hardShare: 0.35, rampPerPoint: 0.0005, maxBonus: 0.05, forces: 'the Magikarp template (species), never an item', scope: 'Ocean fish caught while the quest is active' },
			reward: { xpMinutes: 10, cashMinutes: 10, boxes: 1 },
		},
		{
			key: 'story.river-carp', title: 'Catch 15 Carp', legacyTitle: 'Catch 15 Carp', levelBiome: 'River', prerequisites: [],
			description: 'Catch 15 carp from the river.', target: { family: { biome: 'River', suffix: 'Carp' } }, count: 15,
			reward: { xpMinutes: 5, cashMinutes: 5, boxes: 0 },
		},
		{
			key: 'story.river-trout', title: 'Catch 15 Trout', legacyTitle: 'Catch 15 Trout', levelBiome: 'River', prerequisites: [],
			description: 'Catch 15 trout from the river.', target: { family: { biome: 'River', suffix: 'Trout' } }, count: 15,
			reward: { xpMinutes: 5, cashMinutes: 5, boxes: 0 },
		},
		{ key: 'story.lake', title: 'Lake Explorer', levelBiome: 'Lake', prerequisites: [], description: 'Catch {n} fish in the Lake.', target: { biome: 'Lake' }, requirement: { archetype: REF, sessionShare: 0.5 }, reward: { xpMinutes: 8, cashMinutes: 8, boxes: 1 } },
		{ key: 'story.pond', title: 'Pond Explorer', levelBiome: 'Pond', prerequisites: [], description: 'Catch {n} fish in the Pond.', target: { biome: 'Pond' }, requirement: { archetype: REF, sessionShare: 0.5 }, reward: { xpMinutes: 8, cashMinutes: 8, boxes: 1 } },
		{
			key: 'story.lucky-fisher', title: 'Lucky Fisher', legacyTitle: 'Lucky Fisher', levelBiome: 'Pond', prerequisites: ['story.magikarp'],
			description: 'Catch {n} Lucky fish (any biome).', target: { rarity: ['lucky'] }, count: 5,
			pity: { stageBiome: 'Pond', softShare: 0.15, hardShare: 0.6, rampPerPoint: 0.0001, maxBonus: 0.01, forces: 'a Lucky FISH of the current biome (never a Lucky item)', scope: 'fish caught in any biome since the last Lucky fish, while the quest is active' },
			reward: { xpMinutes: 30, cashMinutes: 30, boxes: 2 },
		},
		{ key: 'story.coast', title: 'Coast Explorer', levelBiome: 'Coast', prerequisites: [], description: 'Catch {n} fish on the Coast.', target: { biome: 'Coast' }, requirement: { archetype: REF, sessionShare: 0.5 }, reward: { xpMinutes: 8, cashMinutes: 8, boxes: 1 } },
		{ key: 'story.swamp', title: 'Professional Fisher', legacyTitle: 'Professional Fisher', levelBiome: 'Swamp', prerequisites: [], description: 'Prove your dedication: catch {n} fish in the Swamp.', target: { biome: 'Swamp' }, requirement: { archetype: REF, sessionShare: 1 }, reward: { xpMinutes: 10, cashMinutes: 10, boxes: 1 } },
	],
	// Reserved for the Mountain Stream expansion (not in the catalog, not modelled): a weather chapter for
	// its three salmon, priced by the same functions once the biome has a species ladder.
	reserved: [{ key: 'story.mountain-stream', levelBiome: MOUNTAIN_STREAM, note: 'Catch the Flashfin, Shrouded and Zephyr Salmon (one per weather); designed with the expansion' }],
	// Pre-5B catalog titles: where each one goes. Retired daily templates stay in the catalog with
	// `retired: true` (never reissued); their in-progress instances are honoured (resolveLegacy()).
	legacyMap: {
		'Catch 15 Trout': 'story.river-trout',
		'Catch 15 Carp': 'story.river-carp',
		'Find the Lucky Magikarp': 'story.magikarp',
		'Help the Village!': 'repeatable.village',
		'Lucky Fisher': 'story.lucky-fisher',
		'Catch 100 Fish': 'daily.catch',
		'Catch 250 Fish': 'daily.catch',
		'Catch 500 Fish': 'daily.catch',
		'Catch 750 Fish': 'daily.catch',
		'Professional Fisher': 'story.swamp',
		'Catch 1 Legendary Fish': 'weekly.legend',
		'Catch 5 Ultra Fish': 'weekly.bigGame',
		'Catch 15 Rare Fish': 'daily.rare',
	},
	retiredDailyTitles: ['Catch 100 Fish', 'Catch 250 Fish', 'Catch 500 Fish', 'Catch 750 Fish', 'Catch 1 Legendary Fish', 'Catch 5 Ultra Fish', 'Catch 15 Rare Fish'],
	// R2 guardrails (checked by guardrails()).
	guardrail: {
		// Daily/weekly XP never exceeds this multiple of the XP of the fishing it requires (+ rounding).
		dailyXpRatioMax: 1.05,
		// Deliberate casual catch-up, as the casual player's play-hours to each target-window level over the
		// regular player's (quests alone; streak XP is extra): at most 1.0 (a casual hour is worth at least a
		// regular hour, despite the slower cadence) and at least 0.7 (dailies never replace fishing).
		casualHoursShareMin: 0.7,
		casualHoursShareMax: 1.0,
		// Stacking every quest type saves a no-miss grinder at most this share of play-hours.
		grinderHoursSavedMax: 0.08,
	},
	rounding: { sigDigits: 2, fishStep: 5 },
	// Minimum-daily adversary (R2): fishes only what the daily requires, at the reference cadence.
	minimumDaily: { archetype: REF, maxDays: 365 },
	checkpointsDays: [7, 28, 91, 182, 365],
	loopGuardHours: 3000,
});
const KINDS = Object.keys(PARAMS.kinds);

// Additive schema (what the implementation adds; nothing is renamed or removed).
const SCHEMA = deepFreeze({
	QuestSchema: {
		key: 'String: stable template key (e.g. story.magikarp). Absent on pre-5B documents (resolveLegacy maps them by title).',
		kind: 'String enum story|daily|weekly|repeatable. Absent on pre-5B documents.',
		status: 'enum gains \'expired\' (daily/weekly past their period). Existing values unchanged.',
		period: 'String on daily/weekly instances: D2026-09-25 / W2026-39 (periodKey).',
		expiresAt: 'Number (ms) on daily/weekly instances: end of the period.',
		band: 'String: level band the instance terms were computed for (ocean..endgame).',
		cooldownHours: 'Number on repeatable templates.',
		retired: 'Boolean on catalog templates that are never issued again (legacy dailies).',
		pity: '{ softStart, rampPerPoint, maxBonus, hard, scopeBiome, forces } on story templates with a quest pity (meter points).',
		pityCount: 'Number (default 0) on instances: luck-weighted meter since the last success (each fish in scope adds 1 + Luck).',
		'progressType.biome': 'String (default any): only fish caught in this biome progress.',
		'progressType.kind': 'String (default fish): Lucky ITEM catches never progress a quest.',
		rulesVersion: 'String quests-5b on documents created by the new rules.',
	},
	UserSchema: {
		questLog: 'Map<templateKey, { completions: Number, firstCompletedAt: Number, lastCompletedAt: Number }>: per-title completion history (story once-only, repeatable cooldowns).',
		'stats.questDay': '{ period: String, repeatableCompletions: Number }: the daily repeatable cap.',
		'stats.lastDailyQuest': 'kept (legacy); still written for compatibility, no longer used for gating.',
	},
});

// ---------------------------------------------------------------------------------------------
// Rule helpers (the representation the implementation would use; pure).
const kindOfKey = (key) => (key ? key.split('.')[0] : null);

/** Kind of a template or instance; pre-5B documents (no `kind`) are 'legacy' (see resolveLegacy()). */
function kindOf(q) {
	return q && KINDS.includes(q.kind) ? q.kind : 'legacy';
}

/** UTC period key of a kind at time `ms`: one daily per UTC day, one weekly per ISO week. */
function periodKey(kind, ms) {
	const d = new Date(ms - PARAMS.period.dayBoundaryUtcHour * 3600e3);
	if (kind === 'daily') return `D${d.toISOString().slice(0, 10)}`;
	if (kind === 'weekly') {
		const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
		const dow = t.getUTCDay() || 7;
		t.setUTCDate(t.getUTCDate() + 4 - dow);
		const y = t.getUTCFullYear();
		const week = Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
		return `W${y}-${String(week).padStart(2, '0')}`;
	}
	return null;
}

/** End of the instance's period (ms). Story and repeatable instances do not expire. */
function expiresAt(kind, ms) {
	const shift = PARAMS.period.dayBoundaryUtcHour * 3600e3;
	const d = new Date(ms - shift);
	const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + shift;
	if (kind === 'daily') return dayStart + 864e5;
	if (kind === 'weekly') {
		const dow = d.getUTCDay() || 7;
		return dayStart + (8 - dow) * 864e5;
	}
	return null;
}

const storyByKey = Object.fromEntries(PARAMS.story.map((s) => [s.key, s]));
const levelOfStory = (s) => F.BIOME_LEVEL[s.levelBiome];

/**
 * Start rule for story and repeatable templates (daily/weekly are issued, not started).
 * @param {object} template a PARAMS.story entry or PARAMS.repeatable template
 * @param {object} state { level, questLog: { [key]: { completions, lastCompletedAt } }, active: [keys],
 *   repeatableCompletionsToday }
 */
function canStart(template, state, ms) {
	const kind = kindOfKey(template.key);
	const log = state.questLog || {};
	const active = state.active || [];
	if (active.includes(template.key)) return { ok: false, reason: 'already in progress' };
	if (kind === 'story') {
		if (state.level < levelOfStory(template)) return { ok: false, reason: `needs level ${levelOfStory(template)}` };
		if ((log[template.key]?.completions || 0) > 0) return { ok: false, reason: 'already completed (story quests are one-time)' };
		const missing = template.prerequisites.filter((k) => !(log[k]?.completions > 0));
		if (missing.length) return { ok: false, reason: `needs ${missing.join(', ')} first (every prerequisite)` };
		return { ok: true };
	}
	if (kind === 'repeatable') {
		const cfg = PARAMS.repeatable;
		if (active.filter((k) => kindOfKey(k) === 'repeatable').length >= cfg.maxActive) return { ok: false, reason: `only ${cfg.maxActive} repeatable at a time` };
		if ((state.repeatableCompletionsToday || 0) >= cfg.dailyCap) return { ok: false, reason: `daily cap of ${cfg.dailyCap} repeatable completions reached` };
		const last = log[template.key]?.lastCompletedAt;
		if (last && ms - last < cfg.cooldownHours * 3600e3) return { ok: false, reason: `on cooldown for ${((cfg.cooldownHours * 3600e3 - (ms - last)) / 3600e3).toFixed(1)} h` };
		return { ok: true };
	}
	return { ok: false, reason: `${kind} quests are issued by /daily, not started` };
}

const lower = (s) => String(s).toLowerCase();
/** Catalog species of a biome whose name ends with `suffix` (word boundary), e.g. River 'Trout'. */
function speciesFamily(biome, suffix) {
	const re = new RegExp(`(^|\\s)${suffix}$`, 'i');
	return [...new Set(FISH.filter((f) => f.biome === biome && re.test(f.name)).map((f) => f.name))].sort();
}

/** progressType the engine would store for a target (today's questMatches + additive biome/kind). */
function progressTypeFor(target) {
	const base = { rarity: ['any'], rod: 'any', qualities: ['any'], fish: ['any'], biome: 'any', kind: 'fish' };
	if (target.species) return { ...base, fish: target.species.map(lower), biome: target.biome || 'any' };
	if (target.family) return { ...base, fish: speciesFamily(target.family.biome, target.family.suffix).map(lower), biome: target.family.biome };
	if (target.minRarity) return { ...base, rarity: rarityAtLeast(target.minRarity) };
	if (Array.isArray(target.rarity)) return { ...base, rarity: target.rarity };
	if (target.biome) return { ...base, biome: target.biome };
	return base;
}

/**
 * Read-time mapping of a pre-5B QuestData document. Nothing is written: the engine applies these
 * effective terms when it matches progress; stored fields stay as they are.
 */
function resolveLegacy(doc) {
	if (KINDS.includes(doc.kind)) return { legacy: false, key: doc.key, kind: doc.kind };
	const key = PARAMS.legacyMap[doc.title] || null;
	const mapsToKind = kindOfKey(key);
	const out = {
		legacy: true, kind: 'legacy', mapsTo: key, mapsToKind, wasDaily: Boolean(doc.daily),
		// Legacy instances never block /daily and never expire; they complete once on their stored terms.
		blocksDaily: false, expires: false,
		progressType: doc.progressType, progressMax: doc.progressMax,
		reward: 'stored terms (cash, xp, reward items), once; completion is logged in questLog under mapsTo',
	};
	const story = storyByKey[key];
	if (story) {
		// Count-based stories (the fixed trout/carp targets, Magikarp, Lucky Fisher): the new target and a
		// count never higher than stored. Requirement-based stories keep their stored target and count.
		if (story.count) {
			out.progressType = { ...(doc.progressType || {}), ...progressTypeFor(story.target) };
			out.progressMax = Math.min(doc.progressMax ?? story.count, story.count);
		}
		if (story.pity) out.pity = 'the story pity applies from deploy (pityCount starts at 0)';
		out.reward = 'per component, the greater of the stored and the current template reward (cash, XP, boxes), once; logged in questLog so the story cannot be started again';
	}
	if (mapsToKind === 'repeatable') out.reward = 'stored terms, once; the completion starts the new cooldown and counts toward the daily cap';
	// Items never progress quests (Lucky Fisher counted Booster Packs / Gold Rod Pieces before).
	out.progressType = { ...(out.progressType || {}), kind: 'fish' };
	return out;
}

/** Quest fish targets / reward items that do not exist in the seeded catalog. */
function catalogIntegrity(quests = LEGACY_QUESTS) {
	const species = new Set(FISH.map((f) => lower(f.name)));
	const items = new Set(ITEM_CATALOG.map(lower));
	const missing = [];
	for (const q of quests) {
		for (const n of q.progressType?.fish || []) if (n !== 'any' && !species.has(lower(n))) missing.push({ title: q.title, field: 'progressType.fish', value: n });
		for (const n of q.rewardItems || []) if (!items.has(lower(n))) missing.push({ title: q.title, field: 'rewardItems', value: n });
	}
	return missing;
}

// ---------------------------------------------------------------------------------------------
const sig = (x, digits = PARAMS.rounding.sigDigits) => {
	if (!(x > 0)) return 0;
	const m = 10 ** (Math.floor(Math.log10(x)) - digits + 1);
	return Math.round(Math.round(x / m) * m);
};
const fishRound = (x) => Math.max(PARAMS.rounding.fishStep, Math.round(x / PARAMS.rounding.fishStep) * PARAMS.rounding.fishStep);
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const pct = (x) => Math.round(x * 1000) / 10;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** P(X >= k) for X ~ Binomial(n, p). */
function binomialAtLeast(n, p, k) {
	n = Math.floor(n);
	if (k <= 0) return 1;
	if (n < k || p <= 0) return 0;
	if (p >= 1) return 1;
	let pmf = (1 - p) ** n;
	let below = 0;
	for (let i = 0; i < k; i++) {
		below += pmf;
		pmf *= ((n - i) / (i + 1)) * (p / (1 - p));
	}
	return Math.max(0, Math.min(1, 1 - below));
}
/** Smallest number of fish n with P(at least k matches in n) >= q. */
function fishForQuantile(p, k, q) {
	let lo = k;
	let hi = Math.max(k, Math.ceil((k / p) * 4));
	while (binomialAtLeast(hi, p, k) < q) hi *= 2;
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2);
		if (binomialAtLeast(mid, p, k) >= q) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

/**
 * Fish needed for `count` catches under a quest pity (engine/rarity.js applyPity semantics on a meter):
 * each fish in scope adds `weight` (= 1 + Luck) points; with `since` points and no success, the next fish
 * succeeds with p + min(maxBonus, rampPerPoint x (since - softStart + weight)) once since >= softStart,
 * and surely once since + weight >= hard. The meter resets on each success. Exact (convolution of the
 * single-catch distribution). Returns fish (not points).
 */
function pityStats(p, rule, count = 1, weight = 1) {
	const T = Math.max(1, Math.ceil(rule.hard / weight));
	const single = new Float64Array(T + 1);
	let survive = 1;
	for (let n = 1; n <= T; n++) {
		const since = (n - 1) * weight;
		let q = p;
		if (since >= rule.softStart) q = Math.min(1, p + Math.min(rule.maxBonus, rule.rampPerPoint * (since - rule.softStart + weight)));
		if (since + weight >= rule.hard) q = 1;
		single[n] = survive * q;
		survive *= 1 - q;
	}
	let dist = single;
	for (let c = 1; c < count; c++) {
		const next = new Float64Array(dist.length + T);
		for (let a = 1; a < dist.length; a++) {
			if (!dist[a]) continue;
			for (let b = 1; b <= T; b++) next[a + b] += dist[a] * single[b];
		}
		dist = next;
	}
	let mean = 0;
	let cum = 0;
	let p50 = null;
	let p90 = null;
	for (let n = 1; n < dist.length; n++) {
		mean += n * dist[n];
		cum += dist[n];
		if (p50 === null && cum >= 0.5) p50 = n;
		if (p90 === null && cum >= 0.9) p90 = n;
	}
	// Chance that the natural rate alone lands a catch before the hard guarantee (per catch).
	const natural = 1 - (1 - p) ** T;
	return { weight, meanFish: Math.round(mean), p50Fish: p50, p90Fish: p90, maxFish: T * count, withoutPityMeanFish: Math.round(count / p), naturalWithinHardShare: r3(natural) };
}

// ---------------------------------------------------------------------------------------------
// Gear normalisation: F.gearPath() entries ({tier, key, level, meanFish, qualities, stats}, plus
// multiChance once the shared path is the rods path); keyed objects are accepted too.
function normalizePath(gearPath) {
	const list = Array.isArray(gearPath) ? gearPath : Object.entries(gearPath).map(([key, g]) => ({ key, ...g }));
	return list.map((g, i) => {
		const meanFish = g.meanFish ?? g.mean ?? (g.multiChance !== undefined ? F.fishDistribution(g.multiChance).mean : 1);
		const tier = typeof g.tier === 'number' ? g.tier : i;
		return {
			tier,
			key: g.key ?? (tier === 0 ? 'old' : `t${tier}`),
			level: g.level ?? 0,
			qualities: g.qualities || (tier === 0 ? ['weak'] : ['weak', 'strong']),
			stats: { ...(g.stats || {}) },
			meanFish,
			multiChance: g.multiChance ?? F.chanceForMean(meanFish),
		};
	}).sort((a, b) => a.level - b.level);
}

const addStats = (a = {}, b = {}) => {
	const o = { ...a };
	for (const [k, v] of Object.entries(b)) o[k] = (o[k] || 0) + v;
	return o;
};

// ---------------------------------------------------------------------------------------------
// Daily Box contents (5b.3 counting rule): quests grant Daily Boxes (today's pool, unchanged), so the
// quest system values their NON-BUFF contents once; their buffs are valued by the buffs system from the
// 'box' events. Exact expectations from streak.boxEV (loaded lazily: streak.js is a sibling design).
const DAILY_BOX = BOXES[PARAMS.daily.boxName];
const boxValueCache = new Map();
/**
 * Non-buff contents of one Daily Box opened at `level` by `profile` ('normal' | 'founder').
 * liquid = fish sale value + salvage of rod parts (the cash a box yields); cashEquivalent adds the bait
 * packs usable at `level` at their pack price. `sellMult` (Founder: the proposed profile's sell
 * multiplier) rescales the box fish from today's profile sell multiplier, which boxEV applies.
 */
function dailyBoxValue(level, profile = 'normal', sellMult = null) {
	const key = `${level}|${profile}|${sellMult}`;
	if (!boxValueCache.has(key)) {
		const ev = require('./streak').boxEV(DAILY_BOX, { level, profile });
		const fishValue = ev.fishValue * (sellMult == null ? 1 : sellMult / PROFILES[profile].multipliers.sell);
		boxValueCache.set(key, Object.freeze({
			level, profile, fish: ev.fish, fishValue, parts: ev.parts, salvage: ev.salvage, baitUsable: ev.baitUsable, baitDeferred: ev.baitDeferred,
			liquid: fishValue + ev.salvage, cashEquivalent: fishValue + ev.salvage + ev.baitUsable, buffs: Object.freeze({ ...ev.buffs }),
		}));
	}
	return boxValueCache.get(key);
}

const SYSTEM_NAME = 'quests';
/** Ledger sources the quest system writes (XP and cash), plus the Daily Box contents (cash only). */
const QUEST_SOURCES = ['daily', 'weekly', 'repeatable', 'story'];
const BOX_SOURCE = 'questBoxes';
const SYSTEM_DEFAULTS = Object.freeze({ terms: 'issue', weekly: 'period', session: 'fish', boxValue: 'liquid', weekdayOfDay0: 0 });
/** lifecycle()'s conventions, for the exact replay in validateSystem(). */
const LIFECYCLE_CONVENTIONS = Object.freeze({ terms: 'lastStep', weekly: 'smoothed', session: 'time', boxValue: 'none' });

function build(gearPathInput, gearSource) {
	const PATH = normalizePath(gearPathInput);
	const tierAt = (L) => F.tierAt(L, PATH) || PATH[0];

	// Bands: one per live biome stage, plus the post-50 band that opens at Mountain Stream's level. Until
	// the expansion ships that band fishes the last live biome with the tier held at that level.
	const BANDS = (() => {
		const starts = F.LIVE_BIOMES.map((b) => ({ id: lower(b), biome: b, minLevel: F.BIOME_LEVEL[b] }));
		starts.push({ id: 'endgame', biome: F.biomeAt(F.BIOME_LEVEL[MOUNTAIN_STREAM]), minLevel: F.BIOME_LEVEL[MOUNTAIN_STREAM], note: `${F.biomeAt(F.BIOME_LEVEL[MOUNTAIN_STREAM])} until ${MOUNTAIN_STREAM} ships` });
		return starts.map((s, i) => ({ ...s, index: i, maxLevel: starts[i + 1] ? starts[i + 1].minLevel - 1 : null, gear: tierAt(s.minLevel) }));
	})();
	const bands = () => BANDS;
	const bandFor = (L) => [...BANDS].reverse().find((b) => L >= b.minLevel) || BANDS[0];
	const bandOfBiome = (biome) => BANDS.find((b) => b.biome === biome && b.id !== 'endgame');

	const outCache = new Map();
	function outcome(biome, gear, extraStats = null) {
		const key = `${biome}|${gear.key}|${JSON.stringify(extraStats || {})}`;
		if (!outCache.has(key)) outCache.set(key, F.castOutcome({ biome, qualities: gear.qualities, stats: addStats(gear.stats, extraStats || {}), multiChance: gear.multiChance }));
		return outCache.get(key);
	}
	const rateCache = new Map();
	function ratesFor(biome, gear, overheadS) {
		const key = `${biome}|${gear.key}|${overheadS}`;
		if (!rateCache.has(key)) rateCache.set(key, F.hourly(outcome(biome, gear), overheadS));
		return rateCache.get(key);
	}
	const stageRates = (band, archetype = REF) => ratesFor(band.biome, band.gear, F.ARCHETYPES[archetype].overheadS);
	const xpPerFish = (biome, gear) => outcome(biome, gear).xpPerCast / outcome(biome, gear).fishPerCast;
	const valuePerFish = (biome, gear) => outcome(biome, gear).valuePerFish;

	const fishCache = new Map();
	/** Probability that one caught FISH matches predicate(template, rarity). Lucky items never match. */
	function perFishAt(biome, gear, predicate, key, extraStats = null) {
		const k = `${biome}|${gear.key}|${key}|${JSON.stringify(extraStats || {})}`;
		if (!fishCache.has(k)) {
			const o = outcome(biome, gear, extraStats);
			const quals = gear.qualities;
			const dist = drawDistribution(biome, quals, o.table);
			const fish = dist.filter((d) => d.kind === 'fish');
			fishCache.set(k, sum(fish.filter((d) => predicate(d.template, d.rarity)).map((d) => d.p)) / sum(fish.map((d) => d.p)));
		}
		return fishCache.get(k);
	}
	const perFish = (band, predicate, key = predicate.toString()) => perFishAt(band.biome, band.gear, predicate, key);

	function targetPredicate(target) {
		if (target.species) {
			const names = new Set(target.species.map(lower));
			return { key: `species:${[...names].join(',')}`, fn: (t) => names.has(lower(t.name)), biome: target.biome || null };
		}
		if (target.family) {
			const names = new Set(speciesFamily(target.family.biome, target.family.suffix).map(lower));
			return { key: `family:${target.family.biome}:${target.family.suffix}`, fn: (t) => names.has(lower(t.name)), biome: target.family.biome };
		}
		if (target.minRarity) {
			const set = new Set(rarityAtLeast(target.minRarity));
			return { key: `min:${target.minRarity}`, fn: (t, r) => set.has(r), biome: null };
		}
		if (Array.isArray(target.rarity)) {
			const set = new Set(target.rarity);
			return { key: `rar:${target.rarity.join(',')}`, fn: (t, r) => set.has(r), biome: null };
		}
		return { key: 'any', fn: () => true, biome: target.biome || null, any: true };
	}

	/** Fish an archetype catches in `minutes` at a biome and gear, at its cadence. */
	const fishIn = (biome, gear, minutes, archetype) => (ratesFor(biome, gear, F.ARCHETYPES[archetype].overheadS).fish * minutes) / 60;

	// Requirement minutes per kind at a band (formulas of F.ARCHETYPES).
	const dailyMinutes = (band) => F.ARCHETYPES[PARAMS.daily.requirement.archetype].minutesPerDay * (PARAMS.daily.requirement.sessionShare.base + PARAMS.daily.requirement.sessionShare.perBand * band.index);
	const weeklyMinutes = (band) => PARAMS.weekly.requirement.dailyMultiple * dailyMinutes(band);
	const repeatableMinutes = () => F.ARCHETYPES[PARAMS.repeatable.requirement.archetype].minutesPerDay * PARAMS.repeatable.requirement.sessionShare;

	/** Fish a player catches in a stage by fishing alone (stage XP / XP per fish at the stage's gear). */
	function stageFish(biome) {
		const i = F.LIVE_BIOMES.indexOf(biome);
		const from = F.BIOME_LEVEL[biome];
		const to = F.BIOME_LEVEL[F.BIOME_ORDER[F.BIOME_ORDER.indexOf(biome) + 1]] ?? from + (from - (F.BIOME_LEVEL[F.LIVE_BIOMES[i - 1]] ?? 0));
		const b = bandOfBiome(biome);
		return (F.xpForLevel(to) - F.xpForLevel(from)) / xpPerFish(b.biome, b.gear);
	}
	const roundTo = (x, step) => Math.max(step, Math.round(x / step) * step);
	/** Engine pity rule (meter points per catch) of a story quest, from shares of its stage's fish. */
	function pityRule(pity, count = 1) {
		const sf = stageFish(pity.stageBiome);
		return { softStart: roundTo((pity.softShare * sf) / count, 10), rampPerPoint: pity.rampPerPoint, maxBonus: pity.maxBonus, hard: roundTo((pity.hardShare * sf) / count, 10), stageFish: Math.round(sf) };
	}
	/** Meter weight of a fish: 1 + the cast's Luck stat (gear + extra, e.g. bait). */
	const meterWeight = (gear, extra = {}) => 1 + (gear.stats.luck || 0) + (extra.luck || 0);

	/** Computed terms of one template at one band. */
	function templateTerms(kind, def, band) {
		const t = targetPredicate(def.target);
		const fishBiome = t.biome || band.biome;
		const fishGear = band.gear;
		const p = t.any || (def.target.biome && !def.target.species) ? 1 : perFishAt(fishBiome, fishGear, t.fn, t.key);
		// Fish the requirement is sized to (any-fish equivalent).
		let requirementFish = null;
		let progressMax;
		let expectedFish;
		let pity = null;
		let fish;
		if (kind === 'daily' || kind === 'weekly' || kind === 'repeatable') {
			const minutes = kind === 'daily' ? dailyMinutes(band) : kind === 'weekly' ? weeklyMinutes(band) : repeatableMinutes();
			const arch = kind === 'weekly' ? PARAMS.daily.requirement.archetype : PARAMS[kind].requirement.archetype;
			requirementFish = fishRound(fishIn(fishBiome, fishGear, minutes, arch));
			progressMax = t.any ? requirementFish : Math.max(1, Math.round(requirementFish * p));
			expectedFish = progressMax / p;
			fish = t.any ? { mean: progressMax, p50: progressMax, p90: progressMax } : { mean: Math.round(expectedFish), p50: fishForQuantile(p, progressMax, 0.5), p90: fishForQuantile(p, progressMax, 0.9) };
		}
		else if (def.count) {
			progressMax = def.count;
			if (def.pity) {
				const rule = pityRule(def.pity, def.count);
				const ps = pityStats(p, rule, def.count, meterWeight(fishGear));
				pity = { ...def.pity, ...rule, meterWeightAtBandGear: meterWeight(fishGear) };
				expectedFish = ps.meanFish;
				fish = { mean: ps.meanFish, p50: ps.p50Fish, p90: ps.p90Fish, max: ps.maxFish, withoutPityMean: ps.withoutPityMeanFish, naturalWithinHardShare: ps.naturalWithinHardShare };
			}
			else {
				expectedFish = def.count / p;
				fish = { mean: Math.round(expectedFish), p50: fishForQuantile(p, def.count, 0.5), p90: fishForQuantile(p, def.count, 0.9) };
			}
		}
		else {
			const minutes = F.ARCHETYPES[def.requirement.archetype].minutesPerDay * def.requirement.sessionShare;
			requirementFish = fishRound(fishIn(fishBiome, fishGear, minutes, def.requirement.archetype));
			progressMax = requirementFish;
			expectedFish = progressMax;
			fish = { mean: progressMax, p50: progressMax, p90: progressMax };
		}
		// Rewards.
		const xpf = xpPerFish(fishBiome, fishGear);
		const vpf = valuePerFish(fishBiome, fishGear);
		let xp;
		let cash;
		let boxes;
		if (kind === 'daily' || kind === 'weekly') {
			xp = sig(PARAMS[kind].reward.xpK * expectedFish * xpf);
			cash = sig(PARAMS[kind].reward.cashK * expectedFish * vpf);
			boxes = PARAMS[kind].boxes;
		}
		else if (kind === 'repeatable') {
			xp = sig(PARAMS.repeatable.reward.xpShare * expectedFish * xpf);
			cash = sig(PARAMS.repeatable.reward.cashShare * expectedFish * vpf);
			boxes = PARAMS.repeatable.boxes;
		}
		else {
			const r = stageRates(band, REF);
			xp = sig((r.xp * def.reward.xpMinutes) / 60);
			cash = sig((r.cash * def.reward.cashMinutes) / 60);
			boxes = def.reward.boxes;
		}
		const perMin = (arch) => ratesFor(fishBiome, fishGear, F.ARCHETYPES[arch].overheadS).fish / 60;
		return {
			kind, key: def.key, band: band.id, minLevel: band.minLevel, biome: fishBiome, gear: fishGear.key,
			requirementFish, progressMax, progressType: progressTypeFor(def.target), matchPerFish: p,
			expectedFish, fish, cash, xp, boxes,
			// R2 guardrail metric: reward XP / XP of the fishing the quest requires (expected).
			xpVsRequiredFishing: r3(xp / (expectedFish * xpf)),
			cashVsRequiredFishing: r3(cash / (expectedFish * vpf)),
			minutes: { casual: r1(fish.mean / perMin('casual')), regular: r1(fish.mean / perMin(REF)), casualP90: r1(fish.p90 / perMin('casual')), regularP90: r1(fish.p90 / perMin(REF)) },
			pity,
		};
	}

	const termsCache = new Map();
	const termsOf = (kind, def, band) => {
		const k = `${kind}|${def.key}|${band.id}`;
		if (!termsCache.has(k)) termsCache.set(k, templateTerms(kind, def, band));
		return termsCache.get(k);
	};
	const storyBand = (def) => bandOfBiome(def.levelBiome);
	/** Weekly templates offered in a band (rarity templates only when their effort is reasonable). */
	const weeklyPool = (band) => (band.minLevel < F.BIOME_LEVEL[PARAMS.weekly.unlockBiome] ? [] : PARAMS.weekly.templates.filter((def) => {
		const x = termsOf('weekly', def, band);
		return x.expectedFish <= PARAMS.weekly.maxEffortRatio * termsOf('weekly', PARAMS.weekly.templates[0], band).requirementFish;
	}));

	/** The proposed catalog: seed-data shape plus computed per-band terms. */
	function catalog() {
		const out = [];
		for (const kind of ['daily', 'weekly', 'repeatable']) {
			for (const def of PARAMS[kind].templates) {
				const legacy = Object.entries(PARAMS.legacyMap).filter(([, k]) => k === def.key).map(([title]) => title);
				out.push({
					key: def.key, title: def.title, kind, description: def.description, replacesLegacy: legacy,
					requirements: { level: 0, previous: [] },
					cooldownHours: kind === 'repeatable' ? PARAMS.repeatable.cooldownHours : null,
					rewardItems: PARAMS[kind].boxes ? `${PARAMS[kind].boxes} x ${PARAMS[kind].boxName}` : null,
					bands: BANDS.map((b) => {
						const x = termsOf(kind, def, b);
						const offered = kind !== 'weekly' || weeklyPool(b).includes(def);
						return { band: b.id, minLevel: b.minLevel, offered, progressMax: x.progressMax, cash: x.cash, xp: x.xp, boxes: x.boxes, expectedFish: x.fish.mean, p90Fish: x.fish.p90, minutesCasual: x.minutes.casual, minutesRegular: x.minutes.regular, xpVsRequiredFishing: x.xpVsRequiredFishing, progressType: x.progressType };
					}),
				});
			}
		}
		for (const def of PARAMS.story) {
			const x = termsOf('story', def, storyBand(def));
			out.push({
				key: def.key, title: def.title, kind: 'story', legacyTitle: def.legacyTitle || null, description: def.description.replace('{n}', x.progressMax),
				requirements: { level: levelOfStory(def), previous: def.prerequisites },
				progressMax: x.progressMax, progressType: x.progressType, cash: x.cash, xp: x.xp, boxes: x.boxes,
				matchPerFish: x.matchPerFish, pity: x.pity, expectedFish: x.fish, minutes: x.minutes, band: x.band,
			});
		}
		return out;
	}

	/** One-time story rewards (the lifecycle adds each once, when its expected fish in scope are caught). */
	function storyEvents() {
		return PARAMS.story.map((def) => {
			const x = termsOf('story', def, storyBand(def));
			const scope = def.target.biome || def.target.family?.biome || null;
			return { key: def.key, title: def.title, level: levelOfStory(def), prerequisites: def.prerequisites, scopeBiome: scope, expectedFish: x.fish.mean, cash: x.cash, xp: x.xp, boxes: x.boxes };
		});
	}

	/** P(a daily/weekly instance with terms `x` is complete after `fish` fish): any-fish exact, else binomial. */
	const completionP = (x, fish) => (x.progressType.fish[0] === 'any' && x.progressType.rarity[0] === 'any'
		? (fish + 1e-9 >= x.progressMax ? 1 : 0)
		: binomialAtLeast(fish, x.matchPerFish, x.progressMax));

	/**
	 * Expected quest income per day (daily + weekly + repeatable) for a player of `level` who catches
	 * `fishPerDay` fish in a session of `hoursPerDay` hours. Story rewards are one-time (storyEvents()).
	 * opts.daysPerWeek (7): days played per week (weekly progress); opts.parts toggles;
	 * opts.assumeDailyComplete: the player fishes until the daily is done (minimum-daily model).
	 */
	function questIncome(level, fishPerDay, hoursPerDay, opts = {}) {
		const band = bandFor(level);
		const parts = { daily: true, weekly: true, repeatable: true, ...(opts.parts || {}) };
		const daysPerWeek = opts.daysPerWeek ?? 7;
		const res = { daily: { cash: 0, xp: 0, boxes: 0, pComplete: 0 }, weekly: { cash: 0, xp: 0, boxes: 0, pComplete: 0 }, repeatable: { cash: 0, xp: 0, boxes: 0, completions: 0, limitedBy: null } };
		for (const kind of ['daily', 'weekly']) {
			if (!parts[kind]) continue;
			const defs = kind === 'daily' ? PARAMS.daily.templates : weeklyPool(band);
			if (!defs.length) continue;
			const fish = kind === 'daily' ? fishPerDay : fishPerDay * daysPerWeek;
			const perDay = kind === 'daily' ? 1 : 1 / 7;
			for (const def of defs) {
				const x = termsOf(kind, def, band);
				const pc = (kind === 'daily' && opts.assumeDailyComplete ? 1 : completionP(x, fish)) / defs.length;
				res[kind].pComplete += pc;
				res[kind].cash += pc * x.cash * perDay;
				res[kind].xp += pc * x.xp * perDay;
				res[kind].boxes += pc * x.boxes * perDay;
			}
		}
		if (parts.repeatable) {
			const cfg = PARAMS.repeatable;
			const terms = cfg.templates.map((def) => termsOf('repeatable', def, band));
			const fishPer = sum(terms.map((x) => x.expectedFish)) / terms.length;
			const byFish = fishPerDay / fishPer;
			const byCooldown = cfg.templates.length * (1 + Math.floor(hoursPerDay / cfg.cooldownHours));
			const completions = Math.min(cfg.dailyCap, byFish, byCooldown);
			res.repeatable = {
				cash: completions * (sum(terms.map((x) => x.cash)) / terms.length),
				xp: completions * (sum(terms.map((x) => x.xp)) / terms.length),
				boxes: completions * cfg.boxes,
				completions,
				limitedBy: completions === cfg.dailyCap ? 'dailyCap' : completions === byFish ? 'fish' : 'cooldown',
			};
		}
		const total = (k) => res.daily[k] + res.weekly[k] + res.repeatable[k];
		return { level, band: band.id, cash: total('cash'), xp: total('xp'), boxes: total('boxes'), breakdown: res };
	}

	// -----------------------------------------------------------------------------------------
	// Lifecycle: curve.js's model (same step, gear purchase rule, biome choice and day boundary), with the
	// quest system in place of the provisional daily.
	const dailyFishNeeded = (L) => {
		const band = bandFor(L);
		return sum(PARAMS.daily.templates.map((def) => termsOf('daily', def, band).expectedFish)) / PARAMS.daily.templates.length;
	};
	/**
	 * @param {object} arch F.ARCHETYPES entry, or { minimumDaily: true, overheadS }
	 * @param {object} opts questModel 'proposed' | 'provisional' | 'none'; parts toggles (daily, weekly,
	 *   repeatable, story); maxLevel; maxDays; purchaseHours; questCashSaves (quest cash counts toward the
	 *   next rod, default true)
	 */
	function lifecycle(arch, opts = {}) {
		const questModel = opts.questModel || 'proposed';
		const parts = { daily: true, weekly: true, repeatable: true, story: true, ...(opts.parts || {}) };
		const purchaseHours = opts.purchaseHours ?? F.PURCHASE.saveHours;
		const maxLevel = opts.maxLevel ?? F.LIFECYCLE.maxLevel;
		const maxDays = opts.maxDays ?? Infinity;
		const questCashSaves = opts.questCashSaves ?? true;
		const STEP = F.LIFECYCLE.stepH;
		const minimumDaily = Boolean(arch.minimumDaily);
		const dayH = minimumDaily ? null : arch.minutesPerDay / 60;
		let xp = 0;
		let h = 0;
		let tierIdx = 0;
		let saving = 0;
		let fishToday = 0;
		let fishTotal = 0;
		let dayIndex = 0;
		let dayStartH = 0;
		const xpBy = { fishing: 0, daily: 0, weekly: 0, repeatable: 0, story: 0, provisionalDaily: 0 };
		const cashBy = { fishing: 0, daily: 0, weekly: 0, repeatable: 0, story: 0 };
		const boxesBy = { daily: 0, weekly: 0, repeatable: 0, story: 0 };
		const fishByBiome = {};
		const story = parts.story && questModel === 'proposed' ? storyEvents().map((s) => ({ ...s, fish: 0, done: false, doneAt: null })) : [];
		const reached = {};
		const atDay = {};
		const snapshot = () => ({ hours: +h.toFixed(2), day: minimumDaily ? dayIndex + 1 : Math.ceil(h / dayH), xpBy: { ...xpBy }, cashBy: { ...cashBy }, boxesBy: { ...boxesBy }, tier: PATH[tierIdx].key, fish: Math.round(fishTotal) });
		const addQuestCash = (k, c, L) => {
			cashBy[k] += c;
			if (questCashSaves && PATH[tierIdx + 1] && L >= PATH[tierIdx + 1].level) saving += c;
		};
		let dayEndH = minimumDaily ? dailyFishNeeded(1) / ratesFor(F.biomeAt(1), PATH[0], arch.overheadS).fish : null;
		while (h < PARAMS.loopGuardHours) {
			const L = F.levelForXp(xp);
			const next = PATH[tierIdx + 1];
			const cur = PATH[tierIdx];
			const biome = F.biomeAt(L);
			const r = ratesFor(biome, cur, arch.overheadS);
			if (next && L >= next.level) {
				saving += r.cash * STEP;
				if (saving >= r.cash * purchaseHours) {
					tierIdx++;
					saving = 0;
				}
			}
			xp += r.xp * STEP;
			xpBy.fishing += r.xp * STEP;
			cashBy.fishing += r.cash * STEP;
			fishToday += r.fish * STEP;
			fishTotal += r.fish * STEP;
			fishByBiome[biome] = (fishByBiome[biome] || 0) + r.fish * STEP;
			for (const s of story) {
				if (s.done || L < s.level || (s.scopeBiome && s.scopeBiome !== biome)) continue;
				if (!s.prerequisites.every((k) => story.find((x) => x.key === k)?.done)) continue;
				s.fish += r.fish * STEP;
				if (s.fish >= s.expectedFish) {
					s.done = true;
					s.doneAt = { hours: +(h + STEP).toFixed(2), level: L };
					xp += s.xp;
					xpBy.story += s.xp;
					addQuestCash('story', s.cash, L);
					boxesBy.story += s.boxes;
				}
			}
			const before = h;
			h += STEP;
			const dayEnded = minimumDaily ? h >= dayEndH - 1e-9 : Math.floor(h / dayH) !== Math.floor(before / dayH);
			if (dayEnded) {
				if (questModel === 'provisional') {
					xp += F.DAILY.xpPerLevel * L;
					xpBy.provisionalDaily += F.DAILY.xpPerLevel * L;
				}
				else if (questModel === 'proposed') {
					const q = questIncome(L, fishToday, minimumDaily ? h - dayStartH : dayH, { parts, assumeDailyComplete: minimumDaily });
					for (const k of ['daily', 'weekly', 'repeatable']) {
						xp += q.breakdown[k].xp;
						xpBy[k] += q.breakdown[k].xp;
						addQuestCash(k, q.breakdown[k].cash, L);
						boxesBy[k] += q.breakdown[k].boxes;
					}
				}
				fishToday = 0;
				dayIndex++;
				dayStartH = h;
				for (const d of PARAMS.checkpointsDays) if (dayIndex === d) atDay[d] = { level: F.levelForXp(xp), hours: +h.toFixed(2) };
				if (minimumDaily) {
					const L3 = F.levelForXp(xp);
					dayEndH = h + dailyFishNeeded(L3) / ratesFor(F.biomeAt(L3), PATH[tierIdx], arch.overheadS).fish;
				}
			}
			const L2 = F.levelForXp(xp);
			for (const T of F.LIFECYCLE.milestones) if (!reached[T] && L2 >= T) reached[T] = snapshot();
			if (L2 >= maxLevel || dayIndex >= maxDays) break;
		}
		return { questModel, gearSource, reached, atDay, final: snapshot(), story: story.map((s) => ({ key: s.key, done: s.done, doneAt: s.doneAt, fishInScope: Math.round(s.fish), expectedFish: s.expectedFish })), fishByBiome: Object.fromEntries(Object.entries(fishByBiome).map(([k, v]) => [k, Math.round(v)])) };
	}

	/** lifecycle(questModel 'provisional') vs docs/economy/5b/curve.json (valid when the curve is the same). */
	function replicationCheck() {
		const sameCurve = CURVE_JSON.chosen === F.CURVE.quartic && CURVE_JSON.sharedDigest === F.sharedDigest();
		let maxAbsDiffH = 0;
		let rows = 0;
		for (const [name, arch] of Object.entries(F.ARCHETYPES)) {
			const mine = lifecycle(arch, { questModel: 'provisional' }).reached;
			for (const T of F.LIFECYCLE.milestones) {
				const theirs = CURVE_JSON.archetypes?.[name]?.[T]?.hours;
				if (theirs === undefined || !mine[T]) continue;
				maxAbsDiffH = Math.max(maxAbsDiffH, Math.abs(mine[T].hours - theirs));
				rows++;
			}
		}
		return { sameCurve, gearSource, curveJsonQuartic: CURVE_JSON.chosen, frameworkQuartic: F.CURVE.quartic, rows, maxAbsDiffH: r2(maxAbsDiffH), exact: gearSource === 'shared' && sameCurve && maxAbsDiffH === 0 };
	}

	const TARGET_LEVELS = Object.keys(F.TARGET_WINDOWS).map(Number);
	const inWindow = (reached) => Object.fromEntries(Object.entries(F.TARGET_WINDOWS).map(([L, [lo, hi]]) => [L, { hours: reached[L]?.hours ?? null, window: [lo, hi], ok: reached[L] ? reached[L].hours >= lo && reached[L].hours <= hi : false }]));

	const lcCache = new Map();
	const cachedLifecycle = (name, arch, opts = {}) => {
		const k = `${name}|${JSON.stringify(opts)}`;
		if (!lcCache.has(k)) lcCache.set(k, lifecycle(arch, opts));
		return lcCache.get(k);
	};
	const minimumDailyArch = () => ({ minimumDaily: true, overheadS: F.ARCHETYPES[PARAMS.minimumDaily.archetype].overheadS });

	/** Requirement R2: XP by source at the target-window levels for every archetype (proposed quests). */
	function decomposition() {
		const out = {};
		for (const [name, arch] of Object.entries(F.ARCHETYPES)) {
			const lc = cachedLifecycle(name, arch);
			out[name] = {};
			for (const L of TARGET_LEVELS) {
				const s = lc.reached[L];
				if (!s) {
					out[name][L] = null;
					continue;
				}
				const fishing = s.xpBy.fishing;
				const questNonDaily = s.xpBy.weekly + s.xpBy.repeatable + s.xpBy.story;
				const daily = s.xpBy.daily;
				// Streak/login XP belongs to the streak subsystem (added by the integrator).
				const other = 0;
				const total = fishing + questNonDaily + daily + other;
				out[name][L] = {
					fishingXp: Math.round(fishing), questXpNonDaily: Math.round(questNonDaily), dailyXp: Math.round(daily), otherXp: other,
					share: { fishing: pct(fishing / total), questNonDaily: pct(questNonDaily / total), daily: pct(daily / total), other: pct(other / total) },
					nonDailySplit: { weekly: Math.round(s.xpBy.weekly), repeatable: Math.round(s.xpBy.repeatable), story: Math.round(s.xpBy.story) },
					calendarDays: s.day, playHours: s.hours,
				};
			}
		}
		return out;
	}

	const totalXp = (s) => sum(Object.values(s.xpBy));
	function paceOf(lc, L) {
		const s = lc.reached[L];
		if (!s) return null;
		const x = totalXp(s);
		return { level: L, playHours: s.hours, calendarDays: s.day, xpPerActiveHour: Math.round(x / s.hours), xpPerCalendarDay: Math.round(x / s.day), levelsPerCalendarWeek: r2((7 * L) / s.day), questShareOfXp: pct((x - s.xpBy.fishing) / x) };
	}

	/** Requirement R2 adversarial scenarios. */
	function adversarial() {
		const A = F.ARCHETYPES;
		const md = PARAMS.minimumDaily;
		const engaged = Object.keys(A);
		const runs = { minimumDaily: cachedLifecycle('minimumDaily', minimumDailyArch(), { maxDays: md.maxDays }) };
		for (const k of engaged) runs[k] = cachedLifecycle(k, A[k]);
		const pace = Object.fromEntries(Object.entries(runs).map(([k, lc]) => [k, Object.fromEntries(TARGET_LEVELS.map((L) => [`L${L}`, paceOf(lc, L)]))]));
		// A run that reached the lifecycle's max level before a checkpoint is at least that level there.
		const levelAt = (k, d) => runs[k].atDay[d]?.level ?? (runs[k].final.day <= d ? `>=${F.LIFECYCLE.maxLevel}` : null);
		const num = (v) => (typeof v === 'string' ? Number(v.slice(2)) : v);
		const calendar = PARAMS.checkpointsDays.map((d) => ({ day: d, minimumDaily: levelAt('minimumDaily', d), ...Object.fromEntries(engaged.map((k) => [k, levelAt(k, d)])) }));
		const leads = calendar.filter((row) => row.minimumDaily !== null && engaged.some((k) => row[k] !== null && num(row.minimumDaily) > num(row[k])));
		const firstReached = TARGET_LEVELS.find((L) => pace.minimumDaily[`L${L}`]);
		const mdL20 = pace.minimumDaily[`L${firstReached}`];
		const mdFinal = runs.minimumDaily.final;
		const mdDays = Math.max(1, mdFinal.day - 1);
		const minutesPerDayByBand = Object.fromEntries(BANDS.map((b) => [b.id, r1((dailyFishNeeded(b.minLevel) / ratesFor(b.biome, b.gear, minimumDailyArch().overheadS).fish) * 60)]));
		const minDaily = {
			description: 'Logs in every day and fishes only until the daily quest is complete (expected fish of the day\'s template, reference cadence); takes every other quest reward that fishing completes; never fishes more.',
			cadenceArchetype: md.archetype,
			minutesPerDayByBand,
			pace: pace.minimumDaily,
			atDay365: { level: F.levelForXp(totalXp(mdFinal)), playHours: mdFinal.hours, xpPerActiveHour: Math.round(totalXp(mdFinal) / mdFinal.hours), xpPerCalendarDay: Math.round(totalXp(mdFinal) / mdDays), questShareOfXp: pct((totalXp(mdFinal) - mdFinal.xpBy.fishing) / totalXp(mdFinal)) },
			levelsAtCalendarDays: calendar,
			leadsAnEngagedArchetypeInCalendarPace: leads.length > 0,
			xpPerActiveHourVsRegular: mdL20 && pace.regular[`L${firstReached}`] ? r2(mdL20.xpPerActiveHour / pace.regular[`L${firstReached}`].xpPerActiveHour) : null,
			verdict: leads.length
				? 'FAIL: the minimum-daily pattern out-levels an engaged archetype at a calendar checkpoint; tighten the guardrail.'
				: 'PASS: XP per active hour is the highest of all patterns (expected: the daily roughly doubles the XP of the few minutes it requires), but it trails every engaged archetype, including the casual player, in level at every calendar checkpoint. The guardrail is structural: every quest reward needs fish caught that period, and daily/weekly XP is at most the XP of the fishing they require.',
		};
		const grinderNo = cachedLifecycle('grinder', A.grinder, { questModel: 'none' });
		const grinderYes = runs.grinder;
		const shift = Object.fromEntries(TARGET_LEVELS.map((L) => [L, { withoutQuests: grinderNo.reached[L]?.hours, withAllQuests: grinderYes.reached[L]?.hours, hoursSavedPct: pct(1 - grinderYes.reached[L].hours / grinderNo.reached[L].hours) }]));
		const maxSaved = Math.max(...Object.values(shift).map((x) => x.hoursSavedPct));
		const regularNo = cachedLifecycle('regular', A.regular, { questModel: 'none' });
		const noMissGrinder = {
			description: 'Grinder (F.ARCHETYPES.grinder) who never misses a day and takes every daily, weekly, repeatable (up to the daily cap) and story quest.',
			hoursToLevel: shift,
			maxHoursSavedPct: maxSaved,
			questShareOfXpAtTopWindow: pace.grinder[`L${TARGET_LEVELS[TARGET_LEVELS.length - 1]}`]?.questShareOfXp,
			regularWindowsWithQuests: inWindow(runs.regular.reached),
			regularWindowsWithoutQuests: inWindow(regularNo.reached),
			verdict: maxSaved <= 100 * PARAMS.guardrail.grinderHoursSavedMax
				? `PASS: stacking every quest type saves the grinder at most ${maxSaved}% of play-hours (limit ${pct(PARAMS.guardrail.grinderHoursSavedMax)}%). Daily and weekly rewards are fixed per period and repeatables are capped per day, so their share falls as playtime rises; the targets (set for the regular player) are unaffected by grinding.`
				: `REVIEW: quests save the grinder up to ${maxSaved}% of play-hours (limit ${pct(PARAMS.guardrail.grinderHoursSavedMax)}%).`,
		};
		return { minimumDaily: minDaily, noMissGrinder, pace };
	}

	/** Per band and archetype: quest XP/cash per day and their share (casual catch-up). */
	function catchUp() {
		const out = {};
		for (const b of BANDS) {
			const row = {};
			for (const [name, arch] of Object.entries(F.ARCHETYPES)) {
				const rates = ratesFor(b.biome, b.gear, arch.overheadS);
				const fishPerDay = (rates.fish * arch.minutesPerDay) / 60;
				const fishingXp = (rates.xp * arch.minutesPerDay) / 60;
				const fishingCash = (rates.cash * arch.minutesPerDay) / 60;
				const q = questIncome(b.minLevel, fishPerDay, arch.minutesPerDay / 60);
				row[name] = {
					fishPerDay: Math.round(fishPerDay), fishingXpPerDay: Math.round(fishingXp), questXpPerDay: Math.round(q.xp),
					questXpByKind: { daily: Math.round(q.breakdown.daily.xp), weekly: Math.round(q.breakdown.weekly.xp), repeatable: Math.round(q.breakdown.repeatable.xp) },
					questXpSharePct: pct(q.xp / (q.xp + fishingXp)),
					fishingCashPerDay: Math.round(fishingCash), questCashPerDay: Math.round(q.cash), questCashSharePct: pct(q.cash / (q.cash + fishingCash)), boxesPerDay: r2(q.boxes),
					xpPerPlayedMinute: Math.round((fishingXp + q.xp) / arch.minutesPerDay),
					dailyCompletion: r3(q.breakdown.daily.pComplete), weeklyCompletion: r3(q.breakdown.weekly.pComplete), repeatablesPerDay: r2(q.breakdown.repeatable.completions),
				};
			}
			for (const name of Object.keys(F.ARCHETYPES)) row[name].xpPerMinuteVsReference = r2(row[name].xpPerPlayedMinute / row[REF].xpPerPlayedMinute);
			out[b.id] = row;
		}
		return out;
	}

	/** Today's unlimited repeatable ('Help the Village!') vs the proposed cooldown model. */
	function repeatability() {
		const legacyVillage = LEGACY_QUESTS.find((q) => q.title === 'Help the Village!');
		const def = PARAMS.repeatable.templates[0];
		const perBand = BANDS.map((b) => {
			const vpf = valuePerFish(b.biome, b.gear);
			const xpf = xpPerFish(b.biome, b.gear);
			const t = termsOf('repeatable', def, b);
			return {
				band: b.id, stageValuePerFish: r1(vpf), stageXpPerFish: r1(xpf),
				today: { progressMax: legacyVillage.progressMax, cashPerFish: legacyVillage.cash / legacyVillage.progressMax, xpPerFish: legacyVillage.xp / legacyVillage.progressMax, cashBonusPct: pct(legacyVillage.cash / legacyVillage.progressMax / vpf), xpBonusPct: pct(legacyVillage.xp / legacyVillage.progressMax / xpf) },
				proposed: { progressMax: t.progressMax, cash: t.cash, xp: t.xp, cashPerFish: r2(t.cash / t.progressMax), xpPerFish: r2(t.xp / t.progressMax), cashBonusPct: pct(t.cash / t.progressMax / vpf), xpBonusPct: pct(t.xp / t.progressMax / xpf) },
			};
		});
		const perArchetype = {};
		for (const [name, arch] of Object.entries(F.ARCHETYPES)) {
			perArchetype[name] = BANDS.map((b) => {
				const rates = ratesFor(b.biome, b.gear, arch.overheadS);
				const fishPerDay = (rates.fish * arch.minutesPerDay) / 60;
				const todayDone = fishPerDay / legacyVillage.progressMax;
				const q = questIncome(b.minLevel, fishPerDay, arch.minutesPerDay / 60);
				const fishingCash = (rates.cash * arch.minutesPerDay) / 60;
				const fishingXp = (rates.xp * arch.minutesPerDay) / 60;
				return {
					band: b.id,
					today: { completionsPerDay: r1(todayDone), cashPerDay: Math.round(todayDone * legacyVillage.cash), cashVsFishingPct: pct((todayDone * legacyVillage.cash) / fishingCash), xpVsFishingPct: pct((todayDone * legacyVillage.xp) / fishingXp) },
					proposed: { completionsPerDay: r2(q.breakdown.repeatable.completions), cashPerDay: Math.round(q.breakdown.repeatable.cash), cashVsFishingPct: pct(q.breakdown.repeatable.cash / fishingCash), xpVsFishingPct: pct(q.breakdown.repeatable.xp / fishingXp), limitedBy: q.breakdown.repeatable.limitedBy },
				};
			});
		}
		// Worst case: a player (or bot) fishing 24 h/day at the fastest archetype cadence.
		const fastest = Object.values(F.ARCHETYPES).reduce((a, b) => (b.overheadS < a.overheadS ? b : a));
		const worst = BANDS.map((b) => {
			const rates = ratesFor(b.biome, b.gear, fastest.overheadS);
			const q = questIncome(b.minLevel, rates.fish * 24, 24);
			return { band: b.id, repeatableCashPerDay: Math.round(q.breakdown.repeatable.cash), fishingCashPerDay: Math.round(rates.cash * 24), sharePct: pct(q.breakdown.repeatable.cash / (rates.cash * 24)), allQuestCashSharePct: pct(q.cash / (q.cash + rates.cash * 24)) };
		});
		return { rule: { cooldownHours: PARAMS.repeatable.cooldownHours, dailyCap: PARAMS.repeatable.dailyCap, maxActive: PARAMS.repeatable.maxActive, ...PARAMS.repeatable.reward }, perBand, perArchetype, worstCase24h: worst };
	}

	/** Today's 13 quests under the framework model: feasibility, reward in minutes of stage income, bugs. */
	function currentCatalog() {
		const integrity = catalogIntegrity(LEGACY_QUESTS);
		return LEGACY_QUESTS.map((q) => {
			const band = bandFor(q.requirements.level);
			const riverFish = q.progressType.fish.some((n) => FISH.some((f) => f.biome === 'River' && lower(f.name) === n));
			const biome = riverFish ? 'River' : q.progressType.fish.includes('magikarp') ? 'Ocean' : band.biome;
			const gear = tierAt(F.BIOME_LEVEL[biome]);
			const fishSet = new Set(q.progressType.fish.map(lower));
			const rar = q.progressType.rarity;
			const o = outcome(biome, gear);
			const dist = drawDistribution(biome, gear.qualities, o.table);
			// Today every catch entry (fish AND Lucky items) with a matching rarity progresses.
			const pred = (t, r) => (fishSet.has('any') || fishSet.has(lower(t.name))) && (rar.includes('any') || rar.includes(r));
			const pMatchPerDraw = sum(dist.filter((d) => (d.kind === 'fish' ? pred(d.template, d.rarity) : rar.includes(d.rarity) && fishSet.has('any'))).map((d) => d.p));
			const fishNeeded = pMatchPerDraw > 0 ? q.progressMax / pMatchPerDraw : Infinity;
			const reg = ratesFor(biome, gear, F.ARCHETYPES[REF].overheadS);
			const cas = ratesFor(biome, gear, F.ARCHETYPES.casual.overheadS);
			const casualMin = fishNeeded / (cas.fish / 60);
			const issues = [];
			for (const m of integrity.filter((x) => x.title === q.title)) issues.push(`${m.field} '${m.value}' is not in the catalog`);
			if (q.daily && q.requirements.previous.length) issues.push('never issued: generateDailyQuest looks for completed prerequisites in the catalog collection (quests), not in questdatas');
			if (!q.daily) issues.push('repeatable without limit (/start-quest only blocks the same title while it is in progress)');
			if (q.daily && casualMin > F.ARCHETYPES.casual.minutesPerDay) issues.push(`needs ${Math.round(fishNeeded)} fish: ${Math.round(casualMin)} min for a casual player (${r1(casualMin / F.ARCHETYPES.casual.minutesPerDay)} days of play), and an unfinished daily blocks the next one`);
			if (q.requirements.level < F.BIOME_LEVEL[biome]) issues.push(`targets ${biome} fish but is available from Lv ${q.requirements.level} (${biome} unlocks at Lv ${F.BIOME_LEVEL[biome]})`);
			if (rar.includes('lucky')) issues.push('Lucky ITEM catches (Booster Pack, Gold Rod Piece) also progress it');
			return {
				title: q.title, daily: q.daily, level: q.requirements.level, target: `${q.progressMax} x ${q.progressType.fish.join('/')} (${rar.join('/')})`,
				cash: q.cash, xp: q.xp, rewardItems: q.rewardItems || [], mapsTo: PARAMS.legacyMap[q.title],
				evaluatedAt: `${biome} (${gear.key})`, matchPerDraw: pMatchPerDraw, fishNeeded: Number.isFinite(fishNeeded) ? Math.round(fishNeeded) : null,
				minutes: { regular: r1(fishNeeded / (reg.fish / 60)), casual: r1(casualMin) },
				rewardInStageMinutes: { cash: r1(q.cash / (reg.cash / 60)), xp: r1(q.xp / (reg.xp / 60)) },
				issues,
			};
		});
	}

	/** Trout/carp targets, Magikarp and Lucky Fisher: pity and luck bait (bait.js stats and prices). */
	function fixes() {
		const trout = speciesFamily('River', 'Trout');
		const carp = speciesFamily('River', 'Carp');
		const river = bandOfBiome('River');
		const pOf = (names) => {
			const s = new Set(names.map(lower));
			return perFish(river, (t) => s.has(lower(t.name)), `names:${[...s].join(',')}`);
		};
		const today = LEGACY_QUESTS.find((q) => q.title === 'Catch 15 Trout').progressType.fish;
		const pToday = pOf(today);
		const pNew = pOf(trout);
		const cat = Object.fromEntries(catalog().filter((c) => c.kind === 'story').map((c) => [c.key, c]));
		const baitPrices = BAIT.prices();
		/** Per-fish chance of a target with a bait's stats (bait.js PARAMS), and the bait cost per fish. */
		const withBait = (biome, gear, baitName, predicate, key) => {
			const b = BAIT.PARAMS.baits[baitName];
			const applies = b.biomes.includes(biome);
			const p = perFishAt(biome, gear, predicate, key, applies ? b.stats : null);
			const o = outcome(biome, gear, applies ? b.stats : null);
			return { bait: baitName, applies, perFish: p, costPerFish: applies ? baitPrices[baitName].price / o.fishPerCast : 0, pricePerCast: baitPrices[baitName].price };
		};
		const chase = (def, biome, gear, baitName) => {
			const t = targetPredicate(def.target);
			const base = perFishAt(biome, gear, t.fn, t.key);
			const rule = pityRule(def.pity, def.count);
			const noBait = pityStats(base, rule, def.count, meterWeight(gear));
			const row = { biome, gear: gear.key, meterWeight: meterWeight(gear), perFish: base, withoutPity: Math.round(def.count / base), withPity: { mean: noBait.meanFish, p50: noBait.p50Fish, p90: noBait.p90Fish, max: noBait.maxFish } };
			if (baitName) {
				const wb = withBait(biome, gear, baitName, t.fn, t.key);
				const w = meterWeight(gear, wb.applies ? BAIT.PARAMS.baits[baitName].stats : {});
				const ps = pityStats(wb.perFish, rule, def.count, w);
				const hrs = (fish) => r2(fish / ratesFor(biome, gear, F.ARCHETYPES[REF].overheadS).fish);
				row.bait = { name: baitName, applies: wb.applies, meterWeight: w, perFish: wb.perFish, withoutPity: Math.round(def.count / wb.perFish), withPity: { mean: ps.meanFish, p50: ps.p50Fish, p90: ps.p90Fish }, pricePerCast: wb.pricePerCast, baitCostForTheChase: Math.round(ps.meanFish * wb.costPerFish), regularHours: { without: hrs(noBait.meanFish), with: hrs(ps.meanFish) } };
			}
			return row;
		};
		const magikarp = storyByKey['story.magikarp'];
		const lucky = storyByKey['story.lucky-fisher'];
		const ocean = bandOfBiome('Ocean');
		const pond = bandOfBiome('Pond');
		const luckyToday = LEGACY_QUESTS.find((q) => q.title === 'Lucky Fisher');
		const luckyPerDraw = (b) => {
			const o = outcome(b.biome, b.gear);
			const dist = drawDistribution(b.biome, b.gear.qualities, o.table);
			return { fish: sum(dist.filter((d) => d.kind === 'fish' && d.rarity === 'lucky').map((d) => d.p)), item: sum(dist.filter((d) => d.kind === 'item').map((d) => d.p)) };
		};
		return {
			trout: {
				todayTargets: today, missingFromCatalog: today.filter((n) => !FISH.some((f) => lower(f.name) === n)),
				proposedTargets: trout, rule: 'every River species whose name ends in "Trout" (weather and seasonal species included; strong ones need a strong-capable rod or Worm)',
				excluded: FISH.filter((f) => /(^|\s)Trout$/i.test(f.name) && f.biome !== 'River').map((f) => `${f.name} (${f.biome})`),
				perFishToday: r3(pToday), perFishProposed: r3(pNew),
				fishFor15Today: Math.round(15 / pToday), fishFor15Proposed: Math.round(15 / pNew),
				minutesProposed: cat['story.river-trout'].minutes,
			},
			carp: { todayTargets: LEGACY_QUESTS.find((q) => q.title === 'Catch 15 Carp').progressType.fish, proposedTargets: carp, perFishProposed: r3(pOf(carp)), fishFor15Proposed: cat['story.river-carp'].expectedFish.mean, minutesProposed: cat['story.river-carp'].minutes },
			magikarp: {
				pity: cat['story.magikarp'].pity, expectedFish: cat['story.magikarp'].expectedFish, minutes: cat['story.magikarp'].minutes,
				oldRod: chase(magikarp, 'Ocean', ocean.gear, null),
				// An endgame player (Tier 3+) back in the Ocean with the universal luck bait.
				returningT3StrongMagnet: chase(magikarp, 'Ocean', tierAt(F.BIOME_LEVEL.Coast), 'Strong Magnet'),
			},
			luckyFisher: {
				today: { count: luckyToday.progressMax, fishNeededAtPond: Math.round(luckyToday.progressMax / (luckyPerDraw(pond).fish + luckyPerDraw(pond).item)), rewardItem: `${luckyToday.rewardItems.join(', ')} (not in the catalog: the seed logs a warning and the quest pays no item)`, itemsCount: 'Lucky ITEM catches (Booster Pack, Gold Rod Piece) progress it today' },
				proposed: { count: lucky.count, pity: cat['story.lucky-fisher'].pity, expectedFish: cat['story.lucky-fisher'].expectedFish, minutes: cat['story.lucky-fisher'].minutes, reward: { cash: cat['story.lucky-fisher'].cash, xp: cat['story.lucky-fisher'].xp, boxes: `${lucky.reward.boxes} x Daily Box (replaces the non-existent Lucky Rod)` } },
				atPondT2: chase(lucky, pond.biome, pond.gear, 'Magnet'),
				atSwampT4: chase(lucky, bandOfBiome('Swamp').biome, bandOfBiome('Swamp').gear, 'Strong Magnet'),
				luckyPerDrawByBand: Object.fromEntries(BANDS.map((b) => [b.id, luckyPerDraw(b)])),
				boosterPackNote: 'Quest pity forces a Lucky FISH (or the Magikarp template), never the Lucky item branch; item catches never progress quests. Booster Packs stay an Easter egg outside every income model.',
			},
		};
	}

	/** Founder: the profile's quest multipliers (unchanged) applied to the proposed base rewards. */
	function founder() {
		const m = PROFILES.founder.multipliers;
		return {
			questXpMult: m.questXp, questCashMult: m.questCash,
			rule: 'Public output shows the base quest reward; the account receives base x profile multiplier (cast.js rewardBreakdown already splits base / profileBonus / final). The base quest XP feeds the public/competitive XP counter (decision 6).',
			dailyByBand: BANDS.map((b) => {
				const x = termsOf('daily', PARAMS.daily.templates[0], b);
				return { band: b.id, base: { cash: x.cash, xp: x.xp }, final: { cash: x.cash * m.questCash, xp: x.xp * m.questXp } };
			}),
		};
	}

	/** R2 guardrail checks. */
	function guardrails() {
		const g = PARAMS.guardrail;
		const ratios = [];
		for (const b of BANDS) {
			for (const kind of ['daily', 'weekly']) {
				for (const def of PARAMS[kind].templates) ratios.push({ band: b.id, key: def.key, ratio: termsOf(kind, def, b).xpVsRequiredFishing });
			}
		}
		const worst = ratios.reduce((a, b) => (b.ratio > a.ratio ? b : a));
		const cas = cachedLifecycle('casual', F.ARCHETYPES.casual);
		const reg = cachedLifecycle(REF, F.ARCHETYPES[REF]);
		const casualShare = Object.fromEntries(TARGET_LEVELS.map((L) => [L, cas.reached[L] && reg.reached[L] ? r3(cas.reached[L].hours / reg.reached[L].hours) : null]));
		const minCasual = Math.min(...Object.values(casualShare).filter((x) => x !== null));
		const maxCasual = Math.max(...Object.values(casualShare).filter((x) => x !== null));
		const adv = adversarial();
		return {
			dailyXpRatio: { max: worst, limit: g.dailyXpRatioMax, pass: worst.ratio <= g.dailyXpRatioMax },
			casualHoursShareOfRegular: { byLevel: casualShare, min: minCasual, max: maxCasual, band: [g.casualHoursShareMin, g.casualHoursShareMax], pass: minCasual >= g.casualHoursShareMin && maxCasual <= g.casualHoursShareMax },
			minimumDailyNeverLeads: { pass: !adv.minimumDaily.leadsAnEngagedArchetypeInCalendarPace },
			grinderHoursSaved: { max: adv.noMissGrinder.maxHoursSavedPct, limitPct: pct(g.grinderHoursSavedMax), pass: adv.noMissGrinder.maxHoursSavedPct <= 100 * g.grinderHoursSavedMax },
		};
	}

	/** The key per-band terms (daily/weekly/repeatable) in one table. */
	function bandTable() {
		return BANDS.map((b) => {
			const reg = stageRates(b, REF);
			const cas = stageRates(b, 'casual');
			const row = { band: b.id, minLevel: b.minLevel, maxLevel: b.maxLevel, biome: b.biome, gear: b.gear.key, note: b.note || null, regularPerHour: { xp: Math.round(reg.xp), cash: Math.round(reg.cash), fish: Math.round(reg.fish) }, casualPerHour: { xp: Math.round(cas.xp), cash: Math.round(cas.cash), fish: Math.round(cas.fish) } };
			row.dailyRequirementMinutesCasual = r2(dailyMinutes(b));
			for (const kind of ['daily', 'weekly', 'repeatable']) {
				row[kind] = PARAMS[kind].templates.map((def) => {
					const x = termsOf(kind, def, b);
					return { key: def.key, offered: kind !== 'weekly' || weeklyPool(b).includes(def), progressMax: x.progressMax, xp: x.xp, cash: x.cash, boxes: x.boxes, expectedFish: x.fish.mean, p90Fish: x.fish.p90, minutesCasual: x.minutes.casual, minutesRegular: x.minutes.regular, xpVsRequiredFishing: x.xpVsRequiredFishing };
				});
			}
			// XP the provisional daily (F.DAILY) gave at the band's first level, for comparison.
			row.provisionalDailyXpAtMinLevel = F.DAILY.xpPerLevel * Math.max(1, b.minLevel);
			return row;
		});
	}

	// -----------------------------------------------------------------------------------------
	// SYSTEM (framework 5b.3): the quest system on the shared lifecycle core (lifecycle.js). The core
	// steps time and accrues base fishing ('fishing'); this system only credits quest income, grants
	// Daily Boxes and tells the minimum-daily player when the day's minimum is met. It writes ONLY its
	// own ledger sources (QUEST_SOURCES + 'questBoxes') and has no sinks.
	const bandById = (id) => BANDS.find((b) => b.id === id);

	/** Expected reward of a weekly issued at `band` after `fish` fish in its period (templates uniform). */
	function weeklyExpectation(band, fish) {
		const defs = weeklyPool(band);
		const out = { xp: 0, cash: 0, boxes: 0, pComplete: 0 };
		for (const def of defs) {
			const x = termsOf('weekly', def, band);
			const pc = completionP(x, fish) / defs.length;
			out.pComplete += pc;
			out.xp += pc * x.xp;
			out.cash += pc * x.cash;
			out.boxes += pc * x.boxes;
		}
		return out;
	}

	/**
	 * The quest SYSTEM (lifecycle.js hooks). A fresh object per call; per-run state in state.sys.quests.
	 *   init        story chapters (storyEvents()) and box counters
	 *   onDayStart  issues the day's daily at the band of the gate level (terms fixed at issue, §2.1).
	 *               Weekly (period rules): one per 7 calendar days (ISO week), issued with the first daily
	 *               of the week at or after the weekly unlock (get-or-create) and expiring with its week,
	 *               so a day not played (daysPerWeek < 7) simply adds no progress
	 *   onCasts     story progress: fish caught while a chapter is available (gate level at the step's
	 *               start, every prerequisite done, its biome scope); pays once when its expected fish are
	 *               caught: source 'story'
	 *   sessionDone today's fish >= the daily's expected fish at issue (dailyFishNeeded): the minimum-daily
	 *               player (F.MINIMUM_DAILY) stops there (fixed sessions ignore it)
	 *   onDayEnd    daily + repeatable from questIncome(issue level, state.fishToday, state.minutesToday/60)
	 *               (the minimum-daily player completes its daily by construction); the weekly's expected
	 *               reward so far on the week's fish (period): sources 'daily', 'weekly', 'repeatable'
	 *   boxes       every Daily Box grant (daily 1, weekly 2, story chapters): its non-buff contents
	 *               (dailyBoxValue: fish sale value + part salvage) as cash 'questBoxes', then
	 *               emit('box', { name: 'Daily Box', count, level }) so the buffs system values the buffs
	 * Profile: state.profile 'founder' (set by the founder system's init) takes questXp/questCash from
	 * founder.founderProfile(): addXp(kind, base x questXp, base) and cash base x questCash; Daily Box fish
	 * sell at that profile's sell multiplier.
	 * @param {object} opts {
	 *   terms          'issue' (default) | 'lastStep' (lifecycle(): the band of the day's last step)
	 *   weekly         'period' (default) | 'smoothed' (lifecycle(): questIncome's 1/7 of the expected
	 *                  weekly each played day, x 7/daysPerWeek)
	 *   session        'fish' (default) | 'time' (lifecycle(): the minimum-daily session lasts need / fish
	 *                  rate at the day's start, on the highest biome of the level and the equipped tier)
	 *   boxValue       'liquid' (default) | 'cashEquivalent' (+ usable bait packs) | 'none' (lifecycle())
	 *   parts          { daily, weekly, repeatable, story } toggles (default all true)
	 *   weekdayOfDay0  ISO weekday of calendar day 0, 0 = Monday (default 0) }
	 */
	function system(opts = {}) {
		const cfg = { ...SYSTEM_DEFAULTS, ...opts, parts: { daily: true, weekly: true, repeatable: true, story: true, ...(opts.parts || {}) } };
		if (!['issue', 'lastStep'].includes(cfg.terms)) throw new Error(`Unknown quest terms rule ${cfg.terms}`);
		if (!['period', 'smoothed'].includes(cfg.weekly)) throw new Error(`Unknown weekly rule ${cfg.weekly}`);
		if (!['fish', 'time'].includes(cfg.session)) throw new Error(`Unknown session rule ${cfg.session}`);
		if (!['liquid', 'cashEquivalent', 'none'].includes(cfg.boxValue)) throw new Error(`Unknown boxValue ${cfg.boxValue}`);
		const own = (state) => state.sys[SYSTEM_NAME];
		/** Quest multipliers of the run's profile (read lazily: the founder system may init after this one). */
		function multipliers(state) {
			const s = own(state);
			const profile = state.profile === 'founder' ? 'founder' : 'normal';
			if (s.profile !== profile) {
				const m = profile === 'founder' ? require('./founder').founderProfile().multipliers : PROFILES.normal.multipliers;
				s.profile = profile;
				s.mult = { questXp: m.questXp, questCash: m.questCash, sell: profile === 'founder' ? m.sell : null };
			}
			return s.mult;
		}
		function grantBoxes(state, ctx, kind, count) {
			// Expected counts: a period weekly's late binomial tail can add ~1e-12 of a box; not a grant.
			if (!(count > 1e-9)) return;
			const s = own(state);
			const m = multipliers(state);
			const level = ctx.gateLevel();
			s.boxes[kind] += count;
			if (cfg.boxValue !== 'none') ctx.addCash(BOX_SOURCE, count * dailyBoxValue(level, s.profile, m.sell)[cfg.boxValue]);
			ctx.emit('box', { name: PARAMS.daily.boxName, count, level, source: SYSTEM_NAME, kind });
		}
		function credit(state, ctx, kind, reward) {
			const m = multipliers(state);
			if (reward.xp) ctx.addXp(kind, reward.xp * m.questXp, reward.xp);
			if (reward.cash) ctx.addCash(kind, reward.cash * m.questCash);
			grantBoxes(state, ctx, kind, reward.boxes);
		}
		return {
			name: SYSTEM_NAME,
			init(state) {
				state.sys[SYSTEM_NAME] = {
					options: { terms: cfg.terms, weekly: cfg.weekly, session: cfg.session, boxValue: cfg.boxValue, parts: { ...cfg.parts } },
					profile: null, mult: null, today: null, week: null,
					weeks: { issued: 0, completions: 0 },
					story: cfg.parts.story ? storyEvents().map((e) => ({ key: e.key, level: e.level, prerequisites: [...e.prerequisites], scopeBiome: e.scopeBiome, expectedFish: e.expectedFish, xp: e.xp, cash: e.cash, boxes: e.boxes, fish: 0, done: false, doneAt: null })) : [],
					boxes: Object.fromEntries(QUEST_SOURCES.map((k) => [k, 0])),
				};
			},
			onDayStart(state, ctx) {
				const s = own(state);
				const level = ctx.gateLevel();
				const band = bandFor(level);
				const need = cfg.parts.daily ? dailyFishNeeded(level) : 0;
				// 'time' (replay): lifecycle() ended the session at a clock time fixed at the day's start.
				const endH = cfg.session === 'time' && need > 0 ? state.h + need / ratesFor(F.biomeAt(level), PATH[state.equippedTier], ctx.arch.overheadS).fish : null;
				s.today = { level, band: band.id, need, endH };
				if (cfg.weekly !== 'period' || !cfg.parts.weekly) return;
				const index = Math.floor((state.day + cfg.weekdayOfDay0) / 7);
				if (s.week && s.week.index !== index) {
					s.weeks.completions += s.week.credited.pComplete;
					s.week = null;
				}
				if (!s.week && weeklyPool(band).length) {
					s.week = { index, level, band: band.id, fish: 0, credited: { xp: 0, cash: 0, boxes: 0, pComplete: 0 } };
					s.weeks.issued++;
				}
			},
			onCasts(state, ctx, { fish }) {
				const s = own(state);
				if (!s.story.length || !(fish > 0)) return;
				const L = state.stepStartLevel;
				for (const st of s.story) {
					if (st.done || L < st.level || (st.scopeBiome && st.scopeBiome !== state.biome)) continue;
					if (!st.prerequisites.every((k) => s.story.find((x) => x.key === k)?.done)) continue;
					st.fish += fish;
					if (st.fish >= st.expectedFish) {
						st.done = true;
						// The core advances the clock after onCasts: the chapter completes at this step's end.
						st.doneAt = { hours: +(state.h + ctx.stepH).toFixed(4), day: state.day + 1, level: L };
						credit(state, ctx, 'story', st);
					}
				}
			},
			sessionDone(state) {
				const s = own(state);
				if (!s.today) return true;
				if (s.today.endH !== null) return state.h >= s.today.endH - 1e-9;
				return state.fishToday + 1e-9 >= s.today.need;
			},
			onDayEnd(state, ctx) {
				const s = own(state);
				const level = cfg.terms === 'lastStep' ? state.stepStartLevel : s.today.level;
				const smoothed = cfg.weekly === 'smoothed';
				const daysPerWeek = ctx.arch.daysPerWeek ?? 7;
				const q = questIncome(level, state.fishToday, state.minutesToday / 60, {
					parts: { daily: cfg.parts.daily, weekly: cfg.parts.weekly && smoothed, repeatable: cfg.parts.repeatable },
					assumeDailyComplete: ctx.arch.session === 'minimumDaily',
					daysPerWeek,
				});
				credit(state, ctx, 'daily', q.breakdown.daily);
				if (smoothed) {
					// questIncome prices 1/7 of the weekly per CALENDAR day; only played days are credited.
					const k = daysPerWeek >= 7 ? 1 : 7 / daysPerWeek;
					const w = q.breakdown.weekly;
					credit(state, ctx, 'weekly', { xp: w.xp * k, cash: w.cash * k, boxes: w.boxes * k });
				}
				else if (s.week) {
					s.week.fish += state.fishToday;
					const e = weeklyExpectation(bandById(s.week.band), s.week.fish);
					const c = s.week.credited;
					credit(state, ctx, 'weekly', { xp: Math.max(0, e.xp - c.xp), cash: Math.max(0, e.cash - c.cash), boxes: Math.max(0, e.boxes - c.boxes) });
					s.week.credited = e;
				}
				credit(state, ctx, 'repeatable', q.breakdown.repeatable);
			},
		};
	}

	// -----------------------------------------------------------------------------------------
	// Validation (5b.3): system() on the shared core against lifecycle() and its R2 tables.
	/**
	 * lifecycle()'s gear rule as a system (the assumption its quest lifecycle made): the next tier after
	 * saving F.PURCHASE.saveHours of stage income once its level is reached (LC.provisionalRods), with
	 * quest cash (the four quest sources, not box contents: lifecycle() does not value boxes) counting
	 * toward it once the next tier's level is reached (lifecycle() questCashSaves). Runs after the quests.
	 */
	function lifecycleRods({ saveHours = F.PURCHASE.saveHours, questCashSaves = true } = {}) {
		const name = 'questsLifecycleRods';
		const questCash = (state) => QUEST_SOURCES.reduce((a, k) => a + (state.ledger.cash[k] || 0), 0);
		const absorb = (state, ctx) => {
			const s = state.sys[name];
			const total = questCash(state);
			const next = ctx.path[state.equippedTier + 1];
			if (questCashSaves && next && state.stepStartLevel >= next.level) s.saving += total - s.seen;
			s.seen = total;
		};
		return {
			name,
			init(state) {
				state.sys[name] = { saving: 0, seen: 0 };
			},
			beforeStep(state, ctx, rates) {
				const next = ctx.path[state.equippedTier + 1];
				if (!next || state.stepStartLevel < next.level) return;
				const s = state.sys[name];
				s.saving += rates.cash;
				if (s.saving >= rates.perHour.cash * saveHours) {
					state.equippedTier++;
					s.saving = 0;
				}
			},
			onCasts: absorb,
			onDayEnd: absorb,
		};
	}

	/**
	 * Milestone ledgers and box counts on lifecycle()'s basis. lifecycle() credits the day's quests inside
	 * the day's last step, before it checks levels; the core records a level reached by that step's
	 * fishing before onDayEnd. For such milestones this re-records the ledgers after the quest credit.
	 * Hours are identical either way. Runs after the quest system.
	 */
	function milestoneProbe() {
		const name = 'questsMilestoneProbe';
		const snap = (state) => ({ xp: { ...state.ledger.xp }, cash: { ...state.ledger.cash }, boxes: { ...(state.sys[SYSTEM_NAME]?.boxes || {}) } });
		return {
			name,
			init(state) {
				state.sys[name] = {};
			},
			on(event, payload, state) {
				if (event !== 'levelUp' || payload.kind !== 'real') return;
				for (const T of Object.keys(state.milestones)) if (!(T in state.sys[name])) state.sys[name][T] = snap(state);
			},
			onDayEnd(state, ctx) {
				// A fixed session cut short by the stop level has no day end in lifecycle().
				if (ctx.arch.session !== 'minimumDaily' && Math.floor(state.h / (ctx.arch.minutesPerDay / 60)) === state.playDay) return;
				const h = +state.h.toFixed(4);
				for (const [T, m] of Object.entries(state.milestones)) if (m.hours === h) state.sys[name][T] = snap(state);
			},
		};
	}

	const VALIDATION_ARCHETYPES = [...Object.keys(F.ARCHETYPES), F.MINIMUM_DAILY.name];
	const isMinimumDaily = (name) => name === F.MINIMUM_DAILY.name;
	/** One core run: the quest system (or none), lifecycle()'s gear rule and the probe. */
	function coreRun(name, systemOpts = {}, { quests = true } = {}) {
		return LC.simulate({
			archetype: isMinimumDaily(name) ? F.MINIMUM_DAILY : name,
			systems: [quests ? system(systemOpts) : null, lifecycleRods(), milestoneProbe()],
			gearPath: PATH,
			days: isMinimumDaily(name) ? PARAMS.minimumDaily.maxDays : undefined,
			checkpoints: PARAMS.checkpointsDays,
		});
	}
	const oldRun = (name, opts = {}) => (isMinimumDaily(name)
		? cachedLifecycle('minimumDaily', minimumDailyArch(), { maxDays: PARAMS.minimumDaily.maxDays, ...opts })
		: cachedLifecycle(name, F.ARCHETYPES[name], opts));
	const stepOf = (hours) => Math.round(hours / F.LIFECYCLE.stepH);
	const h4 = (k) => +(k * F.LIFECYCLE.stepH).toFixed(4);
	/** Symmetric relative difference; float noise (< 1e-9, different summation order) counts as equal. */
	const relDiff = (a, b) => {
		const d = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-12);
		return d < 1e-9 ? 0 : d;
	};
	const coreLevelAt = (core, d) => core.timeline.find((t) => t.day === d)?.level ?? (core.stopped && core.days <= d ? `>=${F.LIFECYCLE.maxLevel}` : null);

	/**
	 * Milestone hours (step-exact: lifecycle() reports hours rounded to 0.01 h, under a step, from which
	 * its step index is recovered), XP/cash by source and Daily Boxes by kind at each milestone, story
	 * completion steps and calendar checkpoints of one archetype.
	 */
	function compareWithLifecycle(name, core, { ledgers = true } = {}) {
		const old = oldRun(name);
		const probe = core.sys.questsMilestoneProbe || {};
		const out = { maxRel: 0, worst: null, milestonesCompared: 0, exactMilestones: 0, maxStepDiff: 0, missing: [] };
		const note = (key, d) => {
			if (d > out.maxRel) {
				out.maxRel = d;
				out.worst = key;
			}
			return +d.toFixed(6);
		};
		const milestones = {};
		for (const T of F.LIFECYCLE.milestones) {
			const o = old.reached[T];
			const c = core.milestones[T];
			if (!o || !c) {
				if (Boolean(o) !== Boolean(c)) out.missing.push(T);
				milestones[T] = { old: o ? h4(stepOf(o.hours)) : null, core: c ? c.hours : null };
				continue;
			}
			const [ko, kc] = [stepOf(o.hours), stepOf(c.hours)];
			out.milestonesCompared++;
			if (ko === kc) out.exactMilestones++;
			out.maxStepDiff = Math.max(out.maxStepDiff, Math.abs(kc - ko));
			const row = { old: h4(ko), core: h4(kc), steps: kc - ko, rel: note(`L${T} hours`, Math.abs(kc - ko) / ko), day: { old: o.day, core: c.day } };
			if (ledgers) {
				const p = probe[T] || { xp: c.ledger.xp, cash: c.ledger.cash, boxes: {} };
				let worst = 0;
				for (const k of ['fishing', ...QUEST_SOURCES]) {
					worst = Math.max(worst, note(`L${T} xp.${k}`, relDiff(p.xp[k] || 0, o.xpBy[k])));
					worst = Math.max(worst, note(`L${T} cash.${k}`, relDiff(p.cash[k] || 0, o.cashBy[k])));
					if (k !== 'fishing') worst = Math.max(worst, note(`L${T} boxes.${k}`, relDiff(p.boxes[k] || 0, o.boxesBy[k])));
				}
				row.questXp = { old: Math.round(o.xpBy.daily + o.xpBy.weekly + o.xpBy.repeatable + o.xpBy.story), core: Math.round(QUEST_SOURCES.reduce((a, k) => a + (p.xp[k] || 0), 0)) };
				row.ledgerRel = worst;
			}
			milestones[T] = row;
		}
		const story = ledgers ? old.story.map((st) => {
			const c = core.sys[SYSTEM_NAME].story.find((x) => x.key === st.key);
			const steps = st.doneAt && c?.doneAt ? stepOf(c.doneAt.hours) - stepOf(st.doneAt.hours) : null;
			if (steps !== null) note(`story ${st.key}`, Math.abs(steps) / stepOf(st.doneAt.hours));
			return { key: st.key, old: st.doneAt?.hours ?? null, core: c?.doneAt?.hours ?? null, steps };
		}) : undefined;
		const checkpoints = PARAMS.checkpointsDays.map((d) => {
			const o = old.atDay[d]?.level ?? (old.final.day <= d ? `>=${F.LIFECYCLE.maxLevel}` : null);
			return { day: d, old: o, core: coreLevelAt(core, d) };
		});
		out.maxRel = +out.maxRel.toFixed(6);
		return { ...out, checkpointsMatch: checkpoints.every((c) => c.old === c.core), milestones, story, checkpoints };
	}

	/** XP shares (decomposition()'s definition) at a milestone of a core run, on lifecycle()'s basis. */
	function coreShares(core, T) {
		const p = core.sys.questsMilestoneProbe?.[T] || { xp: core.milestones[T].ledger.xp };
		const x = (k) => p.xp[k] || 0;
		const total = x('fishing') + QUEST_SOURCES.reduce((a, k) => a + x(k), 0);
		return { total, fishing: pct(x('fishing') / total), questNonDaily: pct((x('weekly') + x('repeatable') + x('story')) / total), daily: pct(x('daily') / total) };
	}

	let validation = null;
	/**
	 * validateSystem(): system() on the shared core vs this module's lifecycle() (questModel 'proposed').
	 *   replay         system(LIFECYCLE_CONVENTIONS) + lifecycle()'s gear rule: must reproduce lifecycle()
	 *                  (milestone hours step-exact, XP/cash/boxes by source, story steps, checkpoints) for
	 *                  every archetype and the minimum-daily player, and its R2 decomposition()/adversarial()
	 *   proposedRules  system() with its defaults (terms at issue, weekly by period, boxes valued): the
	 *                  same comparison of milestone hours, with each rule's share of the difference
	 */
	function validateSystem() {
		if (validation) return validation;
		const replay = {};
		const replayRuns = {};
		for (const name of VALIDATION_ARCHETYPES) {
			replayRuns[name] = coreRun(name, LIFECYCLE_CONVENTIONS);
			replay[name] = compareWithLifecycle(name, replayRuns[name]);
		}
		const replayMax = Math.max(...Object.values(replay).map((r) => r.maxRel));

		// R2 decomposition(): shares at the target-window levels, every archetype.
		const decomp = decomposition();
		let decompMax = 0;
		const decompRows = {};
		for (const name of Object.keys(F.ARCHETYPES)) {
			decompRows[name] = {};
			for (const L of TARGET_LEVELS) {
				const o = decomp[name][L];
				if (!o || !replayRuns[name].milestones[L]) continue;
				const c = coreShares(replayRuns[name], L);
				const d = Math.max(...['fishing', 'questNonDaily', 'daily'].map((k) => Math.abs(c[k] - o.share[k])));
				decompMax = Math.max(decompMax, d);
				decompRows[name][L] = { old: o.share, core: { fishing: c.fishing, questNonDaily: c.questNonDaily, daily: c.daily }, maxAbsDiffPctPoints: r2(d) };
			}
		}
		// R2 adversarial(): minimum-daily levels at the calendar checkpoints (every archetype), its XP per
		// active hour vs the regular player, and the no-miss grinder's hours saved by quests.
		const adv = adversarial();
		const calendar = adv.minimumDaily.levelsAtCalendarDays.map((row) => ({ day: row.day, ...Object.fromEntries(VALIDATION_ARCHETYPES.map((n) => [n, { old: row[n], core: coreLevelAt(replayRuns[n], row.day) }])) }));
		const calendarMatch = calendar.every((row) => VALIDATION_ARCHETYPES.every((n) => row[n].old === row[n].core));
		const firstL = TARGET_LEVELS.find((L) => replayRuns[F.MINIMUM_DAILY.name].milestones[L]);
		const perActiveHour = (run, L) => coreShares(run, L).total / run.milestones[L].hours;
		const xpPerActiveHourVsRegular = { old: adv.minimumDaily.xpPerActiveHourVsRegular, core: firstL ? r2(perActiveHour(replayRuns[F.MINIMUM_DAILY.name], firstL) / perActiveHour(replayRuns[REF], firstL)) : null };
		const grinderNone = coreRun('grinder', {}, { quests: false });
		const grinderSaved = Object.fromEntries(TARGET_LEVELS.map((L) => [L, {
			old: adv.noMissGrinder.hoursToLevel[L].hoursSavedPct,
			core: pct(1 - replayRuns.grinder.milestones[L].hours / grinderNone.milestones[L].hours),
		}]));
		const grinderMax = { old: adv.noMissGrinder.maxHoursSavedPct, core: Math.max(...Object.values(grinderSaved).map((x) => x.core)) };
		const r2Match = decompMax <= 0.1 && calendarMatch && Math.abs(xpPerActiveHourVsRegular.old - xpPerActiveHourVsRegular.core) <= 0.01 && Math.abs(grinderMax.old - grinderMax.core) <= 0.1;

		// The proposed rules (system() defaults) vs lifecycle(): hours only (the rules move quest income in
		// time by design), and each rule alone to attribute the difference.
		const hoursOnly = (opts) => Object.fromEntries(VALIDATION_ARCHETYPES.map((name) => [name, compareWithLifecycle(name, coreRun(name, opts), { ledgers: false })]));
		const proposed = hoursOnly({});
		const termsOnly = hoursOnly({ ...LIFECYCLE_CONVENTIONS, terms: SYSTEM_DEFAULTS.terms });
		const weeklyOnly = hoursOnly({ ...LIFECYCLE_CONVENTIONS, weekly: SYSTEM_DEFAULTS.weekly });
		const sessionOnly = Object.fromEntries([F.MINIMUM_DAILY.name].map((name) => [name, compareWithLifecycle(name, coreRun(name, { ...LIFECYCLE_CONVENTIONS, session: SYSTEM_DEFAULTS.session }), { ledgers: false })]));
		const maxOf = (runs) => Math.max(...Object.values(runs).map((r) => r.maxRel));
		const worstOf = (runs) => Object.entries(runs).reduce((a, [n, r]) => (r.maxRel > a.maxRel ? { archetype: n, maxRel: r.maxRel, at: r.worst } : a), { archetype: null, maxRel: 0, at: null });
		const proposedMax = maxOf(proposed);
		const hoursTable = (runs) => Object.fromEntries(Object.entries(runs).map(([n, r]) => [n, Object.fromEntries(Object.entries(r.milestones).map(([T, m]) => [T, { old: m.old, core: m.core, steps: m.steps ?? null }]))]));
		const tol = 0.005;

		validation = {
			method: 'LC.simulate with system() + lifecycle()\'s gear rule (lifecycleRods: F.PURCHASE.saveHours of stage income, quest cash counting toward the next rod) + a milestone probe, per archetype (F.ARCHETYPES) and F.MINIMUM_DAILY (365 days), vs lifecycle(questModel \'proposed\'). Hours are compared step-exact (lifecycle() rounds to 0.01 h). Calendar days differ by convention (the core counts a level reached on a day\'s final step in that day; lifecycle() used ceil(h / dayH), the next day), so days are reported, not compared.',
			replay: {
				options: { ...LIFECYCLE_CONVENTIONS },
				maxRelativeDifference: replayMax,
				exact: replayMax === 0 && Object.values(replay).every((r) => !r.missing.length && r.checkpointsMatch),
				milestonesCompared: sum(Object.values(replay).map((r) => r.milestonesCompared)),
				exactMilestones: sum(Object.values(replay).map((r) => r.exactMilestones)),
				byArchetype: replay,
				r2: {
					match: r2Match,
					decomposition: { maxAbsDiffPctPoints: r2(decompMax), rows: decompRows },
					adversarial: { calendarLevelsMatch: calendarMatch, calendar, xpPerActiveHourVsRegular, grinderHoursSavedPct: grinderSaved, grinderMaxHoursSavedPct: grinderMax },
				},
			},
			proposedRules: {
				options: { ...SYSTEM_DEFAULTS },
				maxRelativeDifference: proposedMax,
				worst: worstOf(proposed),
				withinTolerance: proposedMax <= tol,
				attribution: {
					termsAtIssueOnly: { maxRel: maxOf(termsOnly), worst: worstOf(termsOnly) },
					weeklyPeriodOnly: { maxRel: maxOf(weeklyOnly), worst: worstOf(weeklyOnly) },
					sessionByFishOnly: { maxRel: maxOf(sessionOnly), worst: worstOf(sessionOnly) },
				},
				hours: hoursTable(proposed),
				rules: {
					terms: 'A daily/weekly keeps the terms of the band it was issued at (quests.md §2.1: "Levelling mid-day doesn\'t change them"). lifecycle() priced the whole day at the band of its LAST step, so on the day a player crosses a biome level it paid the next band\'s (larger) daily early. The design rule is right; it differs only on band-crossing days.',
					weekly: 'One weekly per 7 calendar days (period rules, §2.1): issued with the week\'s first daily at or after the weekly unlock, progress = the fish caught that week, the expected reward credited as it completes (exact for any-fish templates, binomial for rarity templates). lifecycle() smoothed it to 1/7 of the expected weekly per day, priced on 7 x that day\'s fish at that day\'s band. Same expected income per week; the period rule front-loads it inside each week (an engaged player completes the Haul in a day or two) and is daysPerWeek-aware by construction (days not played add no fish). The period rule is right.',
					session: 'Minimum-daily session: the core stops when today\'s fish reach the daily\'s expected fish; lifecycle() stopped after the precomputed time need / rate at the day\'s start. Identical unless the rate changes mid-session (a rod bought mid-session); fish is the requirement, so the fish rule is right.',
					boxes: 'Daily Boxes: non-buff contents valued as cash (\'questBoxes\', fish sale value + part salvage); lifecycle() only counted boxes. No XP effect, so hours are unaffected here (lifecycleRods counts only the four quest sources, as lifecycle() did).',
				},
			},
			matches: replayMax <= tol && Object.values(replay).every((r) => !r.missing.length) && r2Match,
			maxRelativeDifference: replayMax,
		};
		return validation;
	}

	const totalXpOf = (s) => sum(Object.values(s.xpBy));
	let cached = null;
	function report() {
		if (cached) return cached;
		const lifecycles = {};
		for (const [name, arch] of Object.entries(F.ARCHETYPES)) {
			const withQ = cachedLifecycle(name, arch);
			const prov = cachedLifecycle(name, arch, { questModel: 'provisional' });
			const none = cachedLifecycle(name, arch, { questModel: 'none' });
			lifecycles[name] = Object.fromEntries(F.LIFECYCLE.milestones.map((L) => [L, {
				proposed: withQ.reached[L] ? { hours: withQ.reached[L].hours, day: withQ.reached[L].day } : null,
				provisionalDaily: prov.reached[L] ? { hours: prov.reached[L].hours, day: prov.reached[L].day } : null,
				noQuests: none.reached[L] ? { hours: none.reached[L].hours, day: none.reached[L].day } : null,
			}]));
			lifecycles[name].story = withQ.story;
			lifecycles[name].fishByBiome = withQ.fishByBiome;
			const f = withQ.final;
			const gross = sum(Object.values(f.cashBy));
			// Quest cash share if daily/weekly cash used another factor (daily/weekly cash is linear in it;
			// the small effect on rod-purchase timing is ignored).
			const dw = f.cashBy.daily + f.cashBy.weekly;
			const cashFactorSensitivity = Object.fromEntries([0.5, 0.75, 1].map((k) => {
				const qc = (k / PARAMS.daily.reward.cashK) * dw + f.cashBy.repeatable + f.cashBy.story;
				return [k, pct(qc / (qc + f.cashBy.fishing))];
			}));
			lifecycles[name].incomeAtMaxLevel = { level: F.levelForXp(totalXpOf(f)), fishingCash: Math.round(f.cashBy.fishing), questCash: Math.round(gross - f.cashBy.fishing), questCashSharePct: pct((gross - f.cashBy.fishing) / gross), cashBy: Object.fromEntries(Object.entries(f.cashBy).map(([k, v]) => [k, Math.round(v)])), questCashSharePctByCashFactor: cashFactorSensitivity, boxes: r1(sum(Object.values(f.boxesBy))), boxesBy: Object.fromEntries(Object.entries(f.boxesBy).map(([k, v]) => [k, r1(v)])) };
		}
		const regular = cachedLifecycle(REF, F.ARCHETYPES[REF]);
		const cat = catalog();
		const storyTotals = storyEvents().reduce((s, e) => ({ xp: s.xp + e.xp, cash: s.cash + e.cash, boxes: s.boxes + e.boxes }), { xp: 0, cash: 0, boxes: 0 });
		cached = {
			...F.stamp(),
			gearPathSource: gearSource === 'shared' ? F.GEAR_PATH_SOURCE : gearSource,
			curve: { ...F.CURVE },
			paramsVersion: PARAMS.version,
			gear: PATH.map((g) => ({ key: g.key, level: g.level, meanFish: r3(g.meanFish) })),
			bands: bandTable(),
			catalog: cat,
			retired: PARAMS.retiredDailyTitles,
			storyTotals,
			fixes: fixes(),
			currentCatalog: currentCatalog(),
			catalogIntegrity: { today: catalogIntegrity(LEGACY_QUESTS), proposed: catalogIntegrity(cat.map((c) => ({ title: c.title, progressType: c.progressType || c.bands?.[0]?.progressType, rewardItems: [] }))) },
			questIncomeByBand: Object.fromEntries(BANDS.map((b) => [b.id, Object.fromEntries(Object.entries(F.ARCHETYPES).map(([name, arch]) => {
				const rates = ratesFor(b.biome, b.gear, arch.overheadS);
				const q = questIncome(b.minLevel, (rates.fish * arch.minutesPerDay) / 60, arch.minutesPerDay / 60);
				return [name, { cash: Math.round(q.cash), xp: Math.round(q.xp), boxes: r2(q.boxes), xpByKind: { daily: Math.round(q.breakdown.daily.xp), weekly: Math.round(q.breakdown.weekly.xp), repeatable: Math.round(q.breakdown.repeatable.xp) } }];
			}))])),
			catchUp: catchUp(),
			repeatability: repeatability(),
			lifecycles,
			regularWindows: inWindow(regular.reached),
			regularWindowsOk: Object.values(inWindow(regular.reached)).every((w) => w.ok),
			decomposition: decomposition(),
			adversarial: adversarial(),
			guardrails: guardrails(),
			replication: replicationCheck(),
			integration: {
				system: SYSTEM_NAME,
				hooks: ['init', 'onDayStart', 'onCasts', 'sessionDone', 'onDayEnd'],
				events: { emits: ['box'] },
				ledgerSources: { xp: [...QUEST_SOURCES], cash: [...QUEST_SOURCES, BOX_SOURCE] },
				spendItems: [],
				defaults: { ...SYSTEM_DEFAULTS },
				dailyBoxByBand: BANDS.map((b) => (({ fishValue, salvage, liquid, baitUsable, buffs }) => ({ band: b.id, level: b.minLevel, fishValue: r1(fishValue), salvage: r1(salvage), liquid: r1(liquid), baitUsable: r1(baitUsable), buffs: Object.fromEntries(Object.entries(buffs).map(([k, v]) => [k, r3(v)])) }))(dailyBoxValue(b.minLevel))),
				validation: validateSystem(),
			},
			founder: founder(),
			ruleExamples: ruleExamples(),
		};
		return cached;
	}

	return {
		bands, bandFor, stageRates, perFish, templateTerms: (kind, def, band) => termsOf(kind, def, band),
		catalog, storyEvents, questIncome, lifecycle, replicationCheck, decomposition, adversarial, catchUp, repeatability, currentCatalog, fixes, founder, guardrails, report,
		system, validateSystem,
		pityRule, stageFish,
	};
}

/** Worked examples of the pure rule helpers (the cases the tests should pin). */
function ruleExamples() {
	// Friday 21:30 UTC.
	const t0 = Date.UTC(2026, 8, 25, 21, 30);
	const h = 3600e3;
	const village = PARAMS.repeatable.templates[0];
	const fishmonger = PARAMS.repeatable.templates[1];
	const iso = (ms) => new Date(ms).toISOString();
	return {
		period: { at: iso(t0), daily: periodKey('daily', t0), dailyExpires: iso(expiresAt('daily', t0)), weekly: periodKey('weekly', t0), weeklyExpires: iso(expiresAt('weekly', t0)) },
		canStart: {
			storyLevelTooLow: canStart(storyByKey['story.lucky-fisher'], { level: 25, questLog: {} }, t0),
			storyMissingPrerequisite: canStart(storyByKey['story.lucky-fisher'], { level: 31, questLog: {} }, t0),
			storyOk: canStart(storyByKey['story.lucky-fisher'], { level: 31, questLog: { 'story.magikarp': { completions: 1 } } }, t0),
			storyAlreadyDone: canStart(storyByKey['story.river-trout'], { level: 12, questLog: { 'story.river-trout': { completions: 1 } } }, t0),
			repeatableCooldown: canStart(village, { level: 12, questLog: { [village.key]: { completions: 3, lastCompletedAt: t0 - 5 * h } } }, t0),
			repeatableOtherTitle: canStart(fishmonger, { level: 12, questLog: { [village.key]: { completions: 3, lastCompletedAt: t0 - 5 * h } }, repeatableCompletionsToday: 1 }, t0),
			repeatableDailyCap: canStart(fishmonger, { level: 12, questLog: {}, repeatableCompletionsToday: PARAMS.repeatable.dailyCap }, t0),
			repeatableOneActive: canStart(fishmonger, { level: 12, questLog: {}, active: [village.key] }, t0),
			dailyIsIssued: canStart(PARAMS.daily.templates[0], { level: 12 }, t0),
		},
		legacy: Object.fromEntries(LEGACY_QUESTS.map((q) => [q.title, (({ mapsTo, mapsToKind, progressMax, progressType, reward, pity }) => ({ mapsTo, mapsToKind, progressMax, fish: progressType.fish, rarity: progressType.rarity, kind: progressType.kind, reward, pity }))(resolveLegacy({ ...q, status: 'in_progress', progress: 0 }))])),
	};
}

const DEFAULT = build(F.gearPath(), 'shared');

module.exports = {
	PARAMS, KINDS, SCHEMA, kindOf, periodKey, expiresAt, canStart, resolveLegacy, ruleExamples, speciesFamily, catalogIntegrity, binomialAtLeast, fishForQuantile, pityStats,
	dailyBoxValue, SYSTEM_NAME, QUEST_SOURCES, BOX_SOURCE, SYSTEM_DEFAULTS, LIFECYCLE_CONVENTIONS,
	...DEFAULT,
	// Sensitivity only: the authoritative path is F.gearPath() (R3); at the cutover it becomes the rods path
	// and every figure above regenerates without calling this.
	withGear: (gearPath) => build(gearPath, 'custom'),
};

if (require.main === module) process.stdout.write(`${JSON.stringify(module.exports.report(), null, 1)}\n`);
