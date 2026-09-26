// Phase 5B subsystem: QUESTS (quest type model, catalog, correctness fixes). ANALYSIS ONLY: nothing here
// touches the live game, src/ or production data.
//
// Framework 5b.4. Quests are a SYSTEM on the shared lifecycle core (lifecycle.js, composed by integrate.js):
// this module never steps time. Every lifecycle number it reports (hours and calendar days to each level,
// XP and cash by source, story completion, the R2 adversaries, the guardrails) comes from integrate.run()
// on the reference loop (rods + world + quests + streak + buffs), with the quest system excluded for the
// with/without comparisons. Every other number is a per-band formula of framework values: archetypes,
// target windows, biome levels, gear path (F.gearPath(), the rods path since R3), curve, value model and
// multi-catch all come from F and are never copied here. Only PARAMS is hand-set, and it is expressed as
// formulas: requirements are shares of an archetype's session (F.ARCHETYPES), rewards are multiples of the
// XP/cash the required fishing earns at the band's stage (F.castOutcome / F.hourly).
//
//   node -e "require('./scripts/economy/5b/quests.js').report()"     (returns the report object)
//   node scripts/economy/5b/quests.js                                 (prints it as JSON)
//   node scripts/economy/5b/render-docs.js                            (regenerates docs/economy/5b/quests.md tables)
//
// Exports (pure and synchronous; no database, no randomness):
//   PARAMS                  frozen quest design parameters (kinds, period rules, daily/weekly/repeatable
//                           requirement shares and reward factors, repeatable cooldown and caps, story
//                           quests with pity rules, legacy title map, guardrails)
//   DECISIONS               this design's PROPOSED decisions (decisions.js shape; joined into its registry)
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
//   dailyBoxValue(level, profile, sellMult)
//                           non-buff contents of one Daily Box (streak.boxEV on today's Daily Box pool)
//   RETIRED_LOOP_PARITY     the recorded parity of system() with the retired private loop (commit a83b5f0)
//   --- per band, on the shared gear path F.gearPath() ---
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
//                           expected quest income per day (the system's day-end rule; buffs.js reads its
//                           boxes): { cash, xp, boxes, band, breakdown: { daily, weekly, repeatable } } (story
//                           is one-time: storyEvents()). opts: { daysPerWeek, parts, assumeDailyComplete }
//   catchUp()               per band and archetype: quest XP/cash per day, shares, completion odds
//   repeatability()         today's unlimited repeatables vs the proposed cooldown model
//   currentCatalog()        today's 13 quests evaluated under the framework (feasibility, value, bugs)
//   fixes()                 trout/carp targets, Magikarp and Lucky Fisher (pity, luck bait via bait.js)
//   founder()               Founder quest multipliers on the proposed base rewards (base vs final)
//   --- the quest SYSTEM and the integrated model (integrate.run; nothing here steps time) ---
//   system(opts)            a FRESH lifecycle.js system (per-run state in state.sys.quests only): daily/
//                           weekly/repeatable income at day end, one-time story rewards, Daily Box grants
//                           (non-buff contents as cash 'questBoxes' + a 'box' event for the buffs system);
//                           sessionDone() = today's daily requirement met (the R2 minimum-daily player)
//   lifecycle(archetype, opts)
//                           the integrated lifecycle in this module's view: milestones with XP/cash by source
//                           and Daily Boxes, calendar checkpoints, story completion. archetype = an
//                           F.ARCHETYPES key or entry, F.MINIMUM_DAILY.name or { minimumDaily: true }; opts =
//                           { questModel: 'proposed' | 'none' (reference loop without quests), rewardScale }
//   decomposition()         R2 in the quest view: XP by source (quest kinds split) at the target levels
//   adversarial()           R2: minimum-daily player vs engaged players; no-miss grinder with vs without quests
//   factorSensitivity()     the daily/weekly reward factor (P-DAILY-FACTOR) at 1 / 0.75 / 0.5 (rewardScale)
//   guardrails()            the R2 guardrail checks (pass/fail)
//   report()                every key number of docs/economy/5b/quests.md, computed, with ...F.stamp()
//   markdownTables()        the generated tables of docs/economy/5b/quests.md (render-docs.js)
const F = require('./framework');
const I = require('./integrate');
const { drawDistribution, FISH } = require('../lib/catalog-model');
const LEGACY_QUESTS = require('../../../src/bootstrap/data/quests');
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
		// regular player's (integrated reference loop): at most 1.0 (a casual hour is worth at least a regular
		// hour, despite the slower cadence) and at least 0.7 (dailies never replace fishing).
		casualHoursShareMin: 0.7,
		casualHoursShareMax: 1.0,
		// Stacking every quest type saves a no-miss grinder at most this share of play-hours (integrated
		// reference loop with vs without the quest system).
		grinderHoursSavedMax: 0.08,
	},
	rounding: { sigDigits: 2, fishStep: 5 },
	// R2 horizon: every integrated run lasts this many calendar days (no level stop), as r2.js. The
	// minimum-daily adversary is the shared F.MINIMUM_DAILY (plays each day until every daily system's
	// minimum is met: this system's sessionDone() and the streak's gate).
	minimumDaily: { maxDays: 365 },
	checkpointsDays: [7, 28, 91, 182, 365],
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
/** How a Daily Box's non-buff contents are booked: 'liquid' (fish sale value + part salvage: the design),
 * 'cashEquivalent' (+ usable bait packs at pack price) or 'none' (sensitivity). */
const BOX_VALUES = ['liquid', 'cashEquivalent', 'none'];
// rewardScale: SENSITIVITY ONLY (the P-DAILY-FACTOR alternatives; r2.js guardrailSensitivity); the
// proposed design is 1 for every kind.
const SYSTEM_DEFAULTS = Object.freeze({ boxValue: 'liquid', weekdayOfDay0: 0, rewardScale: Object.freeze({ daily: 1, weekly: 1, repeatable: 1, story: 1 }) });
/** The P-DAILY-FACTOR values factorSensitivity() runs (the proposal and its alternatives, as r2.js). */
const FACTOR_SENSITIVITY = [1, 0.75, 0.5];

// The retired private loop (quests.lifecycle() stepping time itself, with its replicationCheck() against
// curve.json and validateSystem()) is gone. This is the RECORD of system()'s parity with it, the output
// of validateSystem() at framework 5b.4 (digest d9e4938f85074918) on the code of commit a83b5f0 (the
// only later change, e9556b4's rewardScale option, defaults to 1 and leaves it unchanged). Not a live check.
const RETIRED_LOOP_PARITY = deepFreeze({
	source: 'quests.validateSystem() at framework 5b.4, code of commit a83b5f0',
	method: 'system() on the shared core with the old loop\'s gear rule (F.PURCHASE.saveHours of stage income, quest cash counting) and a milestone probe, vs the old loop (questModel \'proposed\'), for casual, regular, active, grinder (to Lv 60) and the minimum-daily player (365 days); hours compared step-exact',
	replay: {
		conventions: 'the old loop\'s: terms at the day\'s last step, weekly smoothed to 1/7 per day, minimum-daily session by clock time, Daily Boxes counted but not valued',
		milestonesCompared: 30, exactMilestones: 30, maxRelativeDifference: 0,
		storyStepsIdentical: true, calendarCheckpointsMatch: true,
		r2: { decompositionMaxAbsDiffPctPoints: 0, calendarLevelsMatch: true, xpPerActiveHourVsRegular: { old: 1.92, core: 1.92 }, grinderMaxHoursSavedPct: { old: 5.6, core: 5.6 } },
	},
	proposedRules: {
		maxRelativeDifference: 0.028571, worst: 'active L20: 5.25 → 5.10 h (9 steps)', largestShiftSteps: 'casual L60: 11 steps',
		attribution: { termsAtIssue: 0.016234, weeklyByPeriod: 0.031746, sessionByFish: 0.001479 },
		why: 'each difference is a deliberate rule of this design: terms fixed at issue (not the band of the day\'s last step), the weekly paid by its period (not smoothed per day), the minimum-daily session ended by fish (not a clock time)',
	},
});

function build(gearPathInput) {
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
	/** Expected fish of the day's daily at a level (templates uniform): the minimum-daily requirement. */
	const dailyFishNeeded = (L) => {
		const band = bandFor(L);
		return sum(PARAMS.daily.templates.map((def) => termsOf('daily', def, band).expectedFish)) / PARAMS.daily.templates.length;
	};

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
				// The alternative (D5): a plain count pity (every fish adds 1 point, whatever its Luck).
				const countNoBait = pityStats(base, rule, def.count, 1).meanFish;
				const countBait = pityStats(wb.perFish, rule, def.count, 1).meanFish;
				row.bait.countPity = { withoutBaitMean: countNoBait, withBaitMean: countBait, shortenedPct: pct(1 - countBait / countNoBait) };
				row.bait.shortenedPct = pct(1 - ps.meanFish / noBait.meanFish);
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
		// Today's profile. The Founder design keeps these quest multipliers (founder.js founderProfile() copies
		// them), and the system reads them from there in Founder runs; reading them here avoids its solve.
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
			return row;
		});
	}

	// -----------------------------------------------------------------------------------------
	// SYSTEM: the quest system on the shared lifecycle core (lifecycle.js). The core steps time and accrues
	// base fishing ('fishing'); this system only credits quest income, grants Daily Boxes and tells the
	// minimum-daily player when the day's minimum is met. It writes ONLY its own ledger sources
	// (QUEST_SOURCES + 'questBoxes') and has no sinks.
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
	 *   on          'levelUp' (real level): records the Daily Boxes granted so far at each milestone level
	 *               (state.sys.quests.boxesAtLevel; the ledgers hold cash and XP only)
	 *   boxes       every Daily Box grant (daily 1, weekly 2, story chapters): its non-buff contents
	 *               (dailyBoxValue: fish sale value + part salvage) as cash 'questBoxes', then
	 *               emit('box', { name: 'Daily Box', count, level }) so the buffs system values the buffs
	 * Profile: state.profile 'founder' (set by the founder system's init) takes questXp/questCash from
	 * founder.founderProfile(): addXp(kind, base x questXp, base) and cash base x questCash; Daily Box fish
	 * sell at that profile's sell multiplier.
	 * @param {object} opts {
	 *   boxValue       'liquid' (default) | 'cashEquivalent' (+ usable bait packs) | 'none' (sensitivity)
	 *   parts          { daily, weekly, repeatable, story } toggles (default all true)
	 *   rewardScale    { daily, weekly, repeatable, story } reward multipliers: SENSITIVITY ONLY (default 1)
	 *   weekdayOfDay0  ISO weekday of calendar day 0, 0 = Monday (default 0) }
	 */
	function system(opts = {}) {
		const cfg = { ...SYSTEM_DEFAULTS, ...opts, parts: { daily: true, weekly: true, repeatable: true, story: true, ...(opts.parts || {}) }, rewardScale: { ...SYSTEM_DEFAULTS.rewardScale, ...(opts.rewardScale || {}) } };
		if (!BOX_VALUES.includes(cfg.boxValue)) throw new Error(`Unknown boxValue ${cfg.boxValue}`);
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
			const k = cfg.rewardScale[kind] ?? 1;
			if (reward.xp) ctx.addXp(kind, reward.xp * k * m.questXp, reward.xp * k);
			if (reward.cash) ctx.addCash(kind, reward.cash * k * m.questCash);
			grantBoxes(state, ctx, kind, reward.boxes);
		}
		return {
			name: SYSTEM_NAME,
			init(state) {
				state.sys[SYSTEM_NAME] = {
					options: { boxValue: cfg.boxValue, parts: { ...cfg.parts }, rewardScale: { ...cfg.rewardScale } },
					profile: null, mult: null, today: null, week: null,
					weeks: { issued: 0, completions: 0 },
					story: cfg.parts.story ? storyEvents().map((e) => ({ key: e.key, level: e.level, prerequisites: [...e.prerequisites], scopeBiome: e.scopeBiome, expectedFish: e.expectedFish, xp: e.xp, cash: e.cash, boxes: e.boxes, fish: 0, done: false, doneAt: null })) : [],
					boxes: Object.fromEntries(QUEST_SOURCES.map((k) => [k, 0])),
					boxesAtLevel: {},
				};
			},
			onDayStart(state, ctx) {
				const s = own(state);
				const level = ctx.gateLevel();
				const band = bandFor(level);
				s.today = { level, band: band.id, need: cfg.parts.daily ? dailyFishNeeded(level) : 0 };
				if (!cfg.parts.weekly) return;
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
				return state.fishToday + 1e-9 >= s.today.need;
			},
			onDayEnd(state, ctx) {
				const s = own(state);
				const q = questIncome(s.today.level, state.fishToday, state.minutesToday / 60, {
					parts: { daily: cfg.parts.daily, weekly: false, repeatable: cfg.parts.repeatable },
					assumeDailyComplete: ctx.arch.session === 'minimumDaily',
					daysPerWeek: ctx.arch.daysPerWeek ?? 7,
				});
				credit(state, ctx, 'daily', q.breakdown.daily);
				if (s.week) {
					s.week.fish += state.fishToday;
					const e = weeklyExpectation(bandById(s.week.band), s.week.fish);
					const c = s.week.credited;
					credit(state, ctx, 'weekly', { xp: Math.max(0, e.xp - c.xp), cash: Math.max(0, e.cash - c.cash), boxes: Math.max(0, e.boxes - c.boxes) });
					s.week.credited = e;
				}
				credit(state, ctx, 'repeatable', q.breakdown.repeatable);
			},
			on(event, payload, state) {
				if (event !== 'levelUp' || payload.kind !== 'real') return;
				const s = own(state);
				for (const T of F.LIFECYCLE.milestones) if (payload.to >= T && !(T in s.boxesAtLevel)) s.boxesAtLevel[T] = { ...s.boxes };
			},
		};
	}

	// -----------------------------------------------------------------------------------------
	// INTEGRATED MODEL (framework 5b.4). Every lifecycle number below comes from integrate.run() on the
	// shared core: the reference loop (rods + world + quests + streak + buffs), and the same loop without the
	// quest system for the with/without comparisons. This module never steps time.
	const TARGET_LEVELS = Object.keys(F.TARGET_WINDOWS).map(Number);
	const MILESTONES = F.LIFECYCLE.milestones;
	const TOP_LEVEL = MILESTONES[MILESTONES.length - 1];
	const ENGAGED = Object.keys(F.ARCHETYPES);
	const MD = F.MINIMUM_DAILY.name;
	const PATTERNS = [MD, ...ENGAGED];
	/** XP ledger sources by column of the quest view (quest kinds split); anything unlisted is 'other'. */
	const XP_GROUPS = { fishing: ['fishing'], daily: ['daily'], weekly: ['weekly'], repeatable: ['repeatable'], story: ['story'], buffs: ['buff'] };
	const groupOf = (source) => Object.keys(XP_GROUPS).find((g) => XP_GROUPS[g].includes(source)) || 'other';
	const questXpOf = (xp) => sum(QUEST_SOURCES.map((k) => xp[k] || 0));
	const questCashOf = (cash) => sum([...QUEST_SOURCES, BOX_SOURCE].map((k) => cash[k] || 0));
	const totalOf = (o) => sum(Object.values(o));
	const levelOnDay = (run, d) => run.timeline.find((t) => t.day === d) || null;
	const inWindow = (run) => Object.fromEntries(TARGET_LEVELS.map((L) => {
		const [lo, hi] = F.TARGET_WINDOWS[L];
		const h = run.milestones[L]?.hours ?? null;
		return [L, { hours: h === null ? null : r2(h), window: [lo, hi], ok: h !== null && h >= lo && h <= hi }];
	}));

	const runCache = new Map();
	/**
	 * One integrated run of `archetype` (an F.ARCHETYPES key or F.MINIMUM_DAILY.name) over the R2 horizon
	 * (PARAMS.minimumDaily.maxDays calendar days, no level stop, exactly as r2.js), so milestones, calendar
	 * checkpoints and ledgers come from one run. o.quests === false excludes the quest system;
	 * o.rewardScale is system()'s sensitivity option.
	 */
	function integratedRun(archetype, o = {}) {
		const quests = o.quests !== false;
		const key = JSON.stringify([archetype, quests, o.rewardScale || null]);
		if (!runCache.has(key)) {
			runCache.set(key, I.run({
				archetype,
				exclude: quests ? [] : [SYSTEM_NAME],
				systemOpts: o.rewardScale ? { [SYSTEM_NAME]: { rewardScale: o.rewardScale } } : {},
				stopAtLevel: null,
				days: PARAMS.minimumDaily.maxDays,
				checkpoints: PARAMS.checkpointsDays,
			}));
		}
		return runCache.get(key);
	}
	const nameOf = (a) => {
		if (typeof a === 'string') return a;
		if (a && a.minimumDaily) return MD;
		const k = ENGAGED.find((n) => F.ARCHETYPES[n] === a);
		if (!k) throw new Error('lifecycle(): pass an F.ARCHETYPES key or entry, F.MINIMUM_DAILY.name or { minimumDaily: true }');
		return k;
	};

	/** The integrated lifecycle in this module's view (see the header). */
	function lifecycle(archetype, opts = {}) {
		const name = nameOf(archetype);
		const questModel = opts.questModel || 'proposed';
		if (!['proposed', 'none'].includes(questModel)) throw new Error(`Unknown questModel ${questModel}: 'proposed' or 'none' (the provisional daily is retired; curve.js 'provisional' keeps its provenance)`);
		const run = integratedRun(name, { quests: questModel === 'proposed', rewardScale: opts.rewardScale });
		const q = run.sys[SYSTEM_NAME];
		const reached = Object.fromEntries(Object.entries(run.milestones).filter(([L]) => /^\d+$/.test(L)).map(([L, m]) => [L, {
			hours: m.hours, day: m.day, xpBy: { ...m.ledger.xp }, cashBy: { ...m.ledger.cash }, boxesBy: q ? { ...(q.boxesAtLevel[L] || {}) } : {},
		}]));
		return {
			...F.stamp(), model: I.REFERENCE_NOTE, archetype: name, questModel, reached,
			atDay: Object.fromEntries(run.timeline.map((t) => [t.day, { level: t.level, hours: t.hours }])),
			final: { days: run.days, hours: run.hours, level: run.final.level, xpBy: { ...run.ledger.xp }, cashBy: { ...run.ledger.cash }, boxesBy: q ? { ...q.boxes } : {} },
			story: q ? q.story.map((s) => ({ key: s.key, done: s.done, doneAt: s.doneAt, fishInScope: Math.round(s.fish), expectedFish: s.expectedFish })) : [],
		};
	}

	/** R2 in the quest view: XP by source (quest kinds split) at the target-window levels, every engaged archetype. */
	function decomposition() {
		const out = {};
		for (const name of ENGAGED) {
			const run = integratedRun(name);
			out[name] = {};
			for (const L of TARGET_LEVELS) {
				const m = run.milestones[L];
				if (!m) {
					out[name][L] = null;
					continue;
				}
				const xp = Object.fromEntries([...Object.keys(XP_GROUPS), 'other'].map((g) => [g, 0]));
				for (const [source, v] of Object.entries(m.ledger.xp)) xp[groupOf(source)] += v;
				const total = totalOf(xp);
				out[name][L] = {
					day: m.day, playHours: r2(m.hours), totalXp: Math.round(total),
					xp: Object.fromEntries(Object.entries(xp).map(([k, v]) => [k, Math.round(v)])),
					share: Object.fromEntries(Object.entries(xp).map(([k, v]) => [k, pct(v / total)])),
					questSharePct: pct(questXpOf(m.ledger.xp) / total),
				};
			}
		}
		return out;
	}

	/** Pace of a run at a level: play-hours, calendar day, XP per active hour and calendar day, levels per week. */
	function paceOf(run, L) {
		const m = run.milestones[L];
		if (!m) return null;
		const x = totalOf(m.ledger.xp);
		return { level: L, playHours: r2(m.hours), calendarDays: m.day, xpPerActiveHour: Math.round(x / m.hours), xpPerCalendarDay: Math.round(x / m.day), levelsPerCalendarWeek: r2((7 * L) / m.day), questShareOfXp: pct(questXpOf(m.ledger.xp) / x) };
	}

	/** R2 adversaries on the integrated model: the minimum-daily player, and the no-miss grinder with vs without quests. */
	function adversarial() {
		const runs = Object.fromEntries(PATTERNS.map((n) => [n, integratedRun(n)]));
		const pace = Object.fromEntries(PATTERNS.map((n) => [n, Object.fromEntries(TARGET_LEVELS.map((L) => [`L${L}`, paceOf(runs[n], L)]))]));
		const calendar = PARAMS.checkpointsDays.map((d) => ({ day: d, ...Object.fromEntries(PATTERNS.map((n) => [n, levelOnDay(runs[n], d)?.level ?? null])), minimumDailyHours: levelOnDay(runs[MD], d)?.hours ?? null }));
		const leads = calendar.filter((row) => row[MD] !== null && ENGAGED.some((k) => row[k] !== null && row[MD] > row[k])).map((row) => row.day);
		const vsRegular = Object.fromEntries(TARGET_LEVELS.map((L) => {
			const a = pace[MD][`L${L}`];
			const b = pace[REF][`L${L}`];
			return [`L${L}`, a && b ? r2(a.xpPerActiveHour / b.xpPerActiveHour) : null];
		}));
		const md = runs[MD];
		const minimumDaily = {
			description: 'F.MINIMUM_DAILY: logs in every day and fishes only until every daily system\'s minimum is met (this system\'s daily requirement and the streak\'s play gate), at the reference cadence; takes every other reward that fishing completes; never fishes more.',
			archetype: { ...F.MINIMUM_DAILY },
			dailyRequirementMinutesByBand: Object.fromEntries(BANDS.map((b) => [b.id, r1((dailyFishNeeded(b.minLevel) / ratesFor(b.biome, b.gear, F.MINIMUM_DAILY.overheadS).fish) * 60)])),
			averageMinutesPerDay: r2((md.hours * 60) / md.days),
			pace: pace[MD],
			levelsAtCalendarDays: calendar,
			xpPerActiveHourVsRegular: vsRegular,
			leadsAnEngagedArchetypeOnDays: leads,
			leadsAnEngagedArchetypeInCalendarPace: leads.length > 0,
			verdict: leads.length
				? `FAIL: the minimum-daily pattern out-levels an engaged archetype on days ${leads.join(', ')}.`
				: 'PASS: the highest XP per active hour of every pattern (the daily roughly doubles the XP of the few minutes it requires), but it trails every engaged archetype, including the casual player, in level at every calendar checkpoint.',
		};
		const without = integratedRun('grinder', { quests: false });
		const shift = Object.fromEntries(TARGET_LEVELS.map((L) => {
			const w = runs.grinder.milestones[L];
			const n = without.milestones[L];
			return [L, { withoutQuests: r2(n.hours), withAllQuests: r2(w.hours), hoursSavedPct: pct(1 - w.hours / n.hours) }];
		}));
		const maxSaved = Math.max(...Object.values(shift).map((x) => x.hoursSavedPct));
		const topWindow = TARGET_LEVELS[TARGET_LEVELS.length - 1];
		const noMissGrinder = {
			description: 'Grinder (F.ARCHETYPES.grinder) who never misses a day and takes every daily, weekly, repeatable (up to the daily cap) and story reward: the reference loop with vs without the quest system (streak and buffs in both).',
			hoursToLevel: shift,
			maxHoursSavedPct: maxSaved,
			questShareOfXpAtTopWindow: pace.grinder[`L${topWindow}`]?.questShareOfXp ?? null,
			verdict: maxSaved <= 100 * PARAMS.guardrail.grinderHoursSavedMax
				? `PASS: every quest type together saves the grinder at most ${maxSaved}% of play-hours (limit ${pct(PARAMS.guardrail.grinderHoursSavedMax)}%). Daily and weekly rewards are fixed per period and repeatables are capped per day, so their share falls as playtime rises.`
				: `REVIEW: quests save the grinder up to ${maxSaved}% of play-hours (limit ${pct(PARAMS.guardrail.grinderHoursSavedMax)}%).`,
		};
		return { minimumDaily, noMissGrinder, pace };
	}

	/** Casual play-hours to each target level over the regular player's (integrated, with or without quests). */
	const casualShare = (quests) => {
		const cas = integratedRun('casual', { quests });
		const reg = integratedRun(REF, { quests });
		return Object.fromEntries(TARGET_LEVELS.map((L) => [L, cas.milestones[L] && reg.milestones[L] ? r3(cas.milestones[L].hours / reg.milestones[L].hours) : null]));
	};

	/** R2 guardrail checks (the daily ratio per band; the rest on the integrated model). */
	function guardrails() {
		const g = PARAMS.guardrail;
		const ratios = [];
		for (const b of BANDS) {
			for (const kind of ['daily', 'weekly']) {
				for (const def of PARAMS[kind].templates) ratios.push({ band: b.id, key: def.key, ratio: termsOf(kind, def, b).xpVsRequiredFishing });
			}
		}
		const worst = ratios.reduce((a, b) => (b.ratio > a.ratio ? b : a));
		const least = ratios.reduce((a, b) => (b.ratio < a.ratio ? b : a));
		const share = casualShare(true);
		const values = Object.values(share).filter((x) => x !== null);
		const minCasual = Math.min(...values);
		const maxCasual = Math.max(...values);
		const adv = adversarial();
		return {
			dailyXpRatio: { max: worst, min: least, limit: g.dailyXpRatioMax, pass: worst.ratio <= g.dailyXpRatioMax },
			casualHoursShareOfRegular: { byLevel: share, withoutQuests: casualShare(false), min: minCasual, max: maxCasual, band: [g.casualHoursShareMin, g.casualHoursShareMax], pass: minCasual >= g.casualHoursShareMin && maxCasual <= g.casualHoursShareMax },
			minimumDailyNeverLeads: { leadsOnDays: adv.minimumDaily.leadsAnEngagedArchetypeOnDays, pass: !adv.minimumDaily.leadsAnEngagedArchetypeInCalendarPace },
			grinderHoursSaved: { max: adv.noMissGrinder.maxHoursSavedPct, limitPct: pct(g.grinderHoursSavedMax), pass: adv.noMissGrinder.maxHoursSavedPct <= 100 * g.grinderHoursSavedMax },
		};
	}

	/**
	 * P-DAILY-FACTOR alternatives (decisions.js): daily and weekly rewards (XP and cash) scaled by k through
	 * system()'s rewardScale, the same sensitivity as r2.js guardrailSensitivity. Analysis only.
	 */
	function factorSensitivity() {
		return Object.fromEntries(FACTOR_SENSITIVITY.map((k) => {
			const scale = k === 1 ? undefined : { daily: k, weekly: k };
			const reg = integratedRun(REF, { rewardScale: scale });
			const cas = integratedRun('casual', { rewardScale: scale });
			const md = integratedRun(MD, { rewardScale: scale });
			const questCashShare = (run) => {
				const m = run.milestones[TOP_LEVEL];
				return m ? pct(questCashOf(m.ledger.cash) / totalOf(m.ledger.cash)) : null;
			};
			return [k, {
				regularHours: Object.fromEntries(TARGET_LEVELS.map((L) => [L, reg.milestones[L] ? r2(reg.milestones[L].hours) : null])),
				regularInWindows: Object.values(inWindow(reg)).every((w) => w.ok),
				casualCatchUp: Object.fromEntries(TARGET_LEVELS.map((L) => [L, cas.milestones[L] && reg.milestones[L] ? r3(cas.milestones[L].hours / reg.milestones[L].hours) : null])),
				minimumDailyVsCasualLevel: Object.fromEntries(PARAMS.checkpointsDays.map((d) => [d, { minimumDaily: levelOnDay(md, d)?.level ?? null, casual: levelOnDay(cas, d)?.level ?? null }])),
				questCashSharePctToTopLevel: { casual: questCashShare(cas), regular: questCashShare(reg) },
			}];
		}));
	}

	/** Lifetime income to the top milestone level of an integrated run (quest cash by kind, Daily Boxes). */
	function incomeAtMaxLevel(run) {
		const m = run.milestones[TOP_LEVEL];
		if (!m) return null;
		const cash = m.ledger.cash;
		const gross = totalOf(cash);
		const quest = questCashOf(cash);
		const boxes = run.sys[SYSTEM_NAME]?.boxesAtLevel[TOP_LEVEL] || {};
		return {
			level: TOP_LEVEL, hours: r2(m.hours), day: m.day,
			grossIncome: Math.round(gross), fishingCash: Math.round(cash.fishing || 0), questCash: Math.round(quest), otherCash: Math.round(gross - quest - (cash.fishing || 0)),
			questCashBy: Object.fromEntries([...QUEST_SOURCES, BOX_SOURCE].map((k) => [k, Math.round(cash[k] || 0)])),
			questCashSharePct: pct(quest / gross),
			boxes: r1(totalOf(boxes)), boxesBy: Object.fromEntries(Object.entries(boxes).map(([k, v]) => [k, r1(v)])),
		};
	}

	const hoursDay = (m) => (m ? { hours: r2(m.hours), day: m.day } : null);
	let cached = null;
	function report() {
		if (cached) return cached;
		const lifecycles = {};
		for (const name of ENGAGED) {
			const withQ = integratedRun(name);
			const none = integratedRun(name, { quests: false });
			lifecycles[name] = {
				milestones: Object.fromEntries(MILESTONES.map((L) => [L, { withQuests: hoursDay(withQ.milestones[L]), withoutQuests: hoursDay(none.milestones[L]) }])),
				story: withQ.sys[SYSTEM_NAME].story.map((s) => ({ key: s.key, done: s.done, doneAt: s.doneAt })),
				incomeAtMaxLevel: incomeAtMaxLevel(withQ),
			};
		}
		const cat = catalog();
		const storyTotals = storyEvents().reduce((s, e) => ({ xp: s.xp + e.xp, cash: s.cash + e.cash, boxes: s.boxes + e.boxes }), { xp: 0, cash: 0, boxes: 0 });
		const regularWindows = inWindow(integratedRun(REF));
		cached = {
			...F.stamp(),
			model: I.REFERENCE_NOTE,
			gearPathSource: F.GEAR_PATH_SOURCE,
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
			catchUp: catchUp(),
			repeatability: repeatability(),
			lifecycles,
			regularWindows,
			regularWindowsOk: Object.values(regularWindows).every((w) => w.ok),
			regularWindowsWithoutQuests: inWindow(integratedRun(REF, { quests: false })),
			decomposition: decomposition(),
			adversarial: adversarial(),
			guardrails: guardrails(),
			factorSensitivity: factorSensitivity(),
			integration: {
				system: SYSTEM_NAME,
				model: I.REFERENCE_NOTE,
				hooks: ['init', 'onDayStart', 'onCasts', 'sessionDone', 'onDayEnd', 'on'],
				events: { emits: ['box'], listens: ['levelUp'] },
				ledgerSources: { xp: [...QUEST_SOURCES], cash: [...QUEST_SOURCES, BOX_SOURCE] },
				spendItems: [],
				defaults: { ...SYSTEM_DEFAULTS },
				dailyBoxByBand: BANDS.map((b) => (({ fishValue, salvage, liquid, baitUsable, buffs }) => ({ band: b.id, level: b.minLevel, fishValue: r1(fishValue), salvage: r1(salvage), liquid: r1(liquid), baitUsable: r1(baitUsable), buffs: Object.fromEntries(Object.entries(buffs).map(([k, v]) => [k, r3(v)])) }))(dailyBoxValue(b.minLevel))),
				retiredLoopParity: RETIRED_LOOP_PARITY,
			},
			founder: founder(),
			ruleExamples: ruleExamples(),
		};
		return cached;
	}

	return {
		bands, bandFor, stageRates, perFish, templateTerms: (kind, def, band) => termsOf(kind, def, band),
		catalog, storyEvents, questIncome, catchUp, repeatability, currentCatalog, fixes, founder, report,
		system, lifecycle, decomposition, adversarial, factorSensitivity, guardrails,
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

const DEFAULT = build(F.gearPath());

// ---------------------------------------------------------------------------------------------
// Proposed design decisions (joined into decisions.js's registry; decisions.verify() checks each `get`
// against `expected`). Status is only ever 'proposed': only the user approves. The framework-level entries
// P-DAY (the DCC day) and P-DAILY-FACTOR (the daily/weekly reward factor) live in decisions.js.
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const templateTargets = (list) => list.map((t) => ({ key: t.key, target: t.target }));
const VILLAGE_TODAY = LEGACY_QUESTS.find((q) => q.title === 'Help the Village!');
const LUCKY_TODAY = LEGACY_QUESTS.find((q) => q.title === 'Lucky Fisher');
const DECISIONS = [
	{
		id: 'P-QUESTS-KINDS', status: 'proposed',
		title: 'Four explicit quest kinds: story (one-time), daily (one per DCC day, expires, never blocks), weekly (one per ISO week), repeatable (cooldown and daily cap)',
		modelled: `kinds ${KINDS.join(', ')}; weekly period: ${PARAMS.period.weekStart}; terms fixed at issue; additive schema only (SCHEMA)`,
		alternatives: ['today: a `daily` flag only (an unfinished daily blocks /daily forever; every non-daily quest repeats without limit)'],
		source: 'quests design', why: 'replaces accidental rules (Q2, Q4, Q5) with explicit, testable ones; nothing is renamed or removed',
		get: () => ({ kinds: KINDS, weekStart: PARAMS.period.weekStart }),
		expected: { kinds: ['story', 'daily', 'weekly', 'repeatable'], weekStart: 'ISO week (Monday 00:00 UTC)' },
	},
	{
		id: 'P-QUESTS-ISSUE', status: 'proposed',
		title: 'The day\'s daily (and the week\'s weekly) is issued lazily on the first successful cast of the DCC day, or by /daily',
		modelled: PARAMS.kinds.daily,
		alternatives: ['/daily only (a player who never types /daily gets no daily)'],
		source: 'quests design', why: 'the same hook as the streak gate; the daily follows play, not a command',
		get: () => PARAMS.kinds.daily,
		expected: 'one per DCC day (UTC), issued by /daily or lazily on the first successful cast of the day; expires at the end of its day; never blocks the next day',
	},
	{
		id: 'P-QUESTS-BANDS', status: 'proposed',
		title: 'Quest terms by level band: one band per live biome stage plus an endgame band from Mountain Stream\'s level, each at the tier held at its first level; an instance keeps the terms of the band it was issued at',
		modelled: 'bands ocean..swamp + endgame (the last live biome until Mountain Stream ships); terms fixed at issue',
		alternatives: ['per-level scaling (a new daily size every level)', 'terms at the current level (a mid-day level-up changes an in-progress daily)'],
		source: 'quests design', why: 'the new band\'s fish are worth more, so rewards step with the stage; the expansion slots in without a new rule',
		get: () => DEFAULT.bands().map((b) => ({ id: b.id, biome: b.biome })),
		expected: [{ id: 'ocean', biome: 'Ocean' }, { id: 'river', biome: 'River' }, { id: 'lake', biome: 'Lake' }, { id: 'pond', biome: 'Pond' }, { id: 'coast', biome: 'Coast' }, { id: 'swamp', biome: 'Swamp' }, { id: 'endgame', biome: 'Swamp' }],
	},
	{
		id: 'P-QUESTS-DAILY', status: 'proposed',
		title: `Daily: sized to the ${PARAMS.daily.requirement.archetype} session and ramped by band; two templates (any fish, Rare or better); ${PARAMS.daily.boxes} ${PARAMS.daily.boxName}`,
		modelled: `requirement: ${PARAMS.daily.requirement.archetype} session x (${PARAMS.daily.requirement.sessionShare.base} + ${PARAMS.daily.requirement.sessionShare.perBand} x band index); templates ${PARAMS.daily.templates.map((t) => t.key).join(', ')}; ${PARAMS.daily.boxes} x ${PARAMS.daily.boxName} (reward factor: P-DAILY-FACTOR)`,
		alternatives: ['a flat fish count (today: Catch 100 Fish, longer than a casual session: fixes table Q5)', 'another base or per-band ramp (swept at design time)'],
		source: 'quests design', why: 'every daily fits inside a casual session at every band; later stages ask for a longer share of it',
		get: () => ({ requirement: PARAMS.daily.requirement, templates: templateTargets(PARAMS.daily.templates), boxes: PARAMS.daily.boxes, boxName: PARAMS.daily.boxName }),
		expected: { requirement: { archetype: 'casual', sessionShare: { base: 0.28, perBand: 0.08 } }, templates: [{ key: 'daily.catch', target: { any: true } }, { key: 'daily.rare', target: { minRarity: 'rare' } }], boxes: 1, boxName: 'Daily Box' },
	},
	{
		id: 'P-QUESTS-WEEKLY', status: 'proposed',
		title: `Weekly: ${PARAMS.weekly.requirement.dailyMultiple} x the daily requirement, from ${PARAMS.weekly.unlockBiome}; rarity weeklies only where their expected effort is at most ${PARAMS.weekly.maxEffortRatio} x the requirement; ${PARAMS.weekly.boxes} Daily Boxes`,
		modelled: `${PARAMS.weekly.requirement.dailyMultiple} x daily; unlock ${PARAMS.weekly.unlockBiome}; maxEffortRatio ${PARAMS.weekly.maxEffortRatio}; templates ${PARAMS.weekly.templates.map((t) => t.key).join(', ')}; ${PARAMS.weekly.boxes} x ${PARAMS.weekly.boxName}`,
		alternatives: ['no weekly (the daily alone carries the daily budget)', 'another multiple of the daily (swept at design time)'],
		source: 'quests design', why: 'a second, longer goal that an engaged player completes in a day or two and a casual player in a week',
		get: () => ({ requirement: PARAMS.weekly.requirement, templates: templateTargets(PARAMS.weekly.templates), boxes: PARAMS.weekly.boxes, maxEffortRatio: PARAMS.weekly.maxEffortRatio, unlockBiome: PARAMS.weekly.unlockBiome }),
		expected: { requirement: { dailyMultiple: 4 }, templates: [{ key: 'weekly.haul', target: { any: true } }, { key: 'weekly.bigGame', target: { minRarity: 'ultra' } }, { key: 'weekly.legend', target: { minRarity: 'legendary' } }], boxes: 2, maxEffortRatio: 1.5, unlockBiome: 'River' },
	},
	{
		id: 'P-QUESTS-REPEATABLE', status: 'proposed',
		title: `Repeatables are a bounded bonus: ${r3(PARAMS.repeatable.requirement.sessionShare)} of the ${PARAMS.repeatable.requirement.archetype} session, +${pct(PARAMS.repeatable.reward.xpShare)}% XP / +${pct(PARAMS.repeatable.reward.cashShare)}% cash of that fishing, ${PARAMS.repeatable.boxes} boxes; ${PARAMS.repeatable.cooldownHours} h cooldown per title, ${PARAMS.repeatable.dailyCap} completions per DCC day, ${PARAMS.repeatable.maxActive} active`,
		modelled: `requirement ${r3(PARAMS.repeatable.requirement.sessionShare)} x ${PARAMS.repeatable.requirement.archetype} session; reward ${pct(PARAMS.repeatable.reward.xpShare)}% XP / ${pct(PARAMS.repeatable.reward.cashShare)}% cash; cooldown ${PARAMS.repeatable.cooldownHours} h; cap ${PARAMS.repeatable.dailyCap}/day; ${PARAMS.repeatable.maxActive} active`,
		alternatives: [`today: unlimited ("Help the Village!" pays $${VILLAGE_TODAY.cash / VILLAGE_TODAY.progressMax} and ${VILLAGE_TODAY.xp / VILLAGE_TODAY.progressMax} XP per fish)`, 'a weekly cap instead of a daily cap'],
		source: 'quests design', why: 'content taken while fishing anyway; closes the Help the Village! exploit without a new income source',
		get: () => ({ ...pick(PARAMS.repeatable, ['requirement', 'reward', 'boxes', 'cooldownHours', 'dailyCap', 'maxActive']), templates: templateTargets(PARAMS.repeatable.templates) }),
		expected: { requirement: { archetype: 'regular', sessionShare: 1 / 3 }, reward: { xpShare: 0.05, cashShare: 0.15 }, boxes: 0, cooldownHours: 12, dailyCap: 2, maxActive: 1, templates: [{ key: 'repeatable.village', target: { any: true } }, { key: 'repeatable.fishmonger', target: { minRarity: 'uncommon' } }] },
	},
	{
		id: 'P-QUESTS-STORY', status: 'proposed',
		title: `Story line: ${PARAMS.story.length} one-time chapters at their target biome's level; rewards are minutes of the band's regular income plus Daily Boxes`,
		modelled: PARAMS.story.map((s) => `${s.key} (${s.levelBiome}${s.prerequisites.length ? `, after ${s.prerequisites.join(', ')}` : ''}): ${s.reward.xpMinutes}/${s.reward.cashMinutes} min, ${s.reward.boxes} box`).join('; '),
		alternatives: ['today: every non-daily quest repeats without limit and is offered at Lv 0'],
		source: 'quests design', why: 'one-time goals that walk the player through each biome; River quests no longer open at Lv 0 (Q8)',
		get: () => PARAMS.story.map((s) => ({ key: s.key, levelBiome: s.levelBiome, prerequisites: s.prerequisites, reward: s.reward })),
		expected: [
			{ key: 'story.magikarp', levelBiome: 'Ocean', prerequisites: [], reward: { xpMinutes: 10, cashMinutes: 10, boxes: 1 } },
			{ key: 'story.river-carp', levelBiome: 'River', prerequisites: [], reward: { xpMinutes: 5, cashMinutes: 5, boxes: 0 } },
			{ key: 'story.river-trout', levelBiome: 'River', prerequisites: [], reward: { xpMinutes: 5, cashMinutes: 5, boxes: 0 } },
			{ key: 'story.lake', levelBiome: 'Lake', prerequisites: [], reward: { xpMinutes: 8, cashMinutes: 8, boxes: 1 } },
			{ key: 'story.pond', levelBiome: 'Pond', prerequisites: [], reward: { xpMinutes: 8, cashMinutes: 8, boxes: 1 } },
			{ key: 'story.lucky-fisher', levelBiome: 'Pond', prerequisites: ['story.magikarp'], reward: { xpMinutes: 30, cashMinutes: 30, boxes: 2 } },
			{ key: 'story.coast', levelBiome: 'Coast', prerequisites: [], reward: { xpMinutes: 8, cashMinutes: 8, boxes: 1 } },
			{ key: 'story.swamp', levelBiome: 'Swamp', prerequisites: [], reward: { xpMinutes: 10, cashMinutes: 10, boxes: 1 } },
		],
	},
	{
		id: 'P-QUESTS-TARGETS', status: 'proposed',
		title: 'Trout and carp chapters target the River species family (every River species whose name ends in Trout / Carp); explorer chapters count fish caught in their biome',
		modelled: `trout: ${speciesFamily('River', 'Trout').length} River species; carp: ${speciesFamily('River', 'Carp').length}`,
		alternatives: ['today: rainbow + golden trout (golden trout does not exist: Q1)', 'every trout of any biome'],
		source: 'quests design', why: 'fixes the non-existent target and matches the quest text ("from the river")',
		get: () => PARAMS.story.filter((s) => s.target.family || (s.target.biome && !s.target.species)).map((s) => ({ key: s.key, target: s.target })),
		expected: [
			{ key: 'story.river-carp', target: { family: { biome: 'River', suffix: 'Carp' } } },
			{ key: 'story.river-trout', target: { family: { biome: 'River', suffix: 'Trout' } } },
			{ key: 'story.lake', target: { biome: 'Lake' } },
			{ key: 'story.pond', target: { biome: 'Pond' } },
			{ key: 'story.coast', target: { biome: 'Coast' } },
			{ key: 'story.swamp', target: { biome: 'Swamp' } },
		],
	},
	{
		id: 'P-QUESTS-PITY', status: 'proposed',
		title: 'Magikarp and Lucky Fisher get a quest pity on a luck-weighted meter (each fish in scope adds 1 + Luck); thresholds are shares of the stage\'s fish; it forces the target fish, never an item',
		modelled: PARAMS.story.filter((s) => s.pity).map((s) => `${s.key}: soft ${s.pity.softShare} / hard ${s.pity.hardShare} of ${s.pity.stageBiome} stage fish, ramp ${s.pity.rampPerPoint}/pt, max +${pct(s.pity.maxBonus)}%`).join('; '),
		alternatives: ['a plain count pity (every fish adds 1 point: luck bait barely matters; pity table)', 'no pity (today: fixes table Q7)'],
		source: 'quests design (D5)', why: 'bounded chases; luck gear and luck bait (bait.js Magnet / Strong Magnet) get a real role; Booster Packs stay an Easter egg',
		get: () => Object.fromEntries(PARAMS.story.filter((s) => s.pity).map((s) => [s.key, pick(s.pity, ['stageBiome', 'softShare', 'hardShare', 'rampPerPoint', 'maxBonus'])])),
		expected: {
			'story.magikarp': { stageBiome: 'Ocean', softShare: 0.1, hardShare: 0.35, rampPerPoint: 0.0005, maxBonus: 0.05 },
			'story.lucky-fisher': { stageBiome: 'Pond', softShare: 0.15, hardShare: 0.6, rampPerPoint: 0.0001, maxBonus: 0.01 },
		},
	},
	{
		id: 'P-QUESTS-LUCKY-FISHER', status: 'proposed',
		title: `Lucky Fisher: ${storyByKey['story.lucky-fisher'].count} Lucky FISH (Lucky items never progress any quest), after Magikarp, from ${storyByKey['story.lucky-fisher'].levelBiome}'s level; reward cash + XP + ${storyByKey['story.lucky-fisher'].reward.boxes} Daily Boxes instead of the non-existent ${LUCKY_TODAY.rewardItems.join(', ')}`,
		modelled: (({ count, target, levelBiome, prerequisites, reward }) => `${count} x ${target.rarity.join('/')} fish; level of ${levelBiome}; after ${prerequisites.join(', ')}; ${reward.boxes} x ${PARAMS.daily.boxName}`)(storyByKey['story.lucky-fisher']),
		alternatives: [`today: ${LUCKY_TODAY.progressMax} Lucky catches, items count, reward ${LUCKY_TODAY.rewardItems.join(', ')} (not in the catalog: pays no item)`],
		source: 'quests design (Q6)', why: 'today it is out of reach (fixes table Q6) and pays an item that does not exist',
		get: () => (({ count, target, levelBiome, prerequisites }) => ({ count, target, levelBiome, prerequisites }))(storyByKey['story.lucky-fisher']),
		expected: { count: 5, target: { rarity: ['lucky'] }, levelBiome: 'Pond', prerequisites: ['story.magikarp'] },
	},
	{
		id: 'P-QUESTS-LEGACY', status: 'proposed',
		title: 'Legacy quests are mapped by title at read time (no rewrite); in-progress instances are honoured once on their stored terms (story mappings: the better of stored and current, per component); completions are backfilled into questLog',
		modelled: `${Object.keys(PARAMS.legacyMap).length} legacy titles mapped (legacyMap; resolveLegacy())`,
		alternatives: ['expire or delete legacy instances (a wipe: not allowed)', 'rewrite stored documents to the new terms'],
		source: 'quests design (D6)', why: 'additive and idempotent migration: nobody loses progress or a reward they were promised',
		get: () => PARAMS.legacyMap,
		expected: {
			'Catch 15 Trout': 'story.river-trout', 'Catch 15 Carp': 'story.river-carp', 'Find the Lucky Magikarp': 'story.magikarp', 'Help the Village!': 'repeatable.village', 'Lucky Fisher': 'story.lucky-fisher',
			'Catch 100 Fish': 'daily.catch', 'Catch 250 Fish': 'daily.catch', 'Catch 500 Fish': 'daily.catch', 'Catch 750 Fish': 'daily.catch', 'Professional Fisher': 'story.swamp',
			'Catch 1 Legendary Fish': 'weekly.legend', 'Catch 5 Ultra Fish': 'weekly.bigGame', 'Catch 15 Rare Fish': 'daily.rare',
		},
	},
	{
		id: 'P-QUESTS-RETIRE', status: 'proposed',
		title: `Retire the ${PARAMS.retiredDailyTitles.length} legacy daily templates: they stay in the catalog with retired: true and are never issued again`,
		modelled: PARAMS.retiredDailyTitles.join(', '),
		alternatives: ['keep them in the daily pool with fixed sizes', 'delete them (not allowed: no wipes)'],
		source: 'quests design', why: 'fixed-size dailies cannot fit every band; the band-scaled templates replace them',
		get: () => PARAMS.retiredDailyTitles,
		expected: ['Catch 100 Fish', 'Catch 250 Fish', 'Catch 500 Fish', 'Catch 750 Fish', 'Catch 1 Legendary Fish', 'Catch 5 Ultra Fish', 'Catch 15 Rare Fish'],
	},
	{
		id: 'P-QUESTS-GUARDRAILS', status: 'proposed',
		title: `Quest guardrails: casual play-hours to each target level stay within ${PARAMS.guardrail.casualHoursShareMin}-${PARAMS.guardrail.casualHoursShareMax} of the regular player's (deliberate catch-up); daily/weekly XP at most ${PARAMS.guardrail.dailyXpRatioMax} x the XP of the fishing it requires; quests save a no-miss grinder at most ${pct(PARAMS.guardrail.grinderHoursSavedMax)}% of play-hours`,
		modelled: `casual share [${PARAMS.guardrail.casualHoursShareMin}, ${PARAMS.guardrail.casualHoursShareMax}]; daily XP ratio <= ${PARAMS.guardrail.dailyXpRatioMax}; grinder hours saved <= ${pct(PARAMS.guardrail.grinderHoursSavedMax)}%`,
		alternatives: ['no catch-up (the casual cadence handicap: catch-up table, without quests)', 'a tighter band'],
		source: 'quests design (D2); R2', why: 'a casual hour is worth at least a regular hour despite the slower cadence, and dailies never replace fishing',
		get: () => PARAMS.guardrail,
		expected: { dailyXpRatioMax: 1.05, casualHoursShareMin: 0.7, casualHoursShareMax: 1.0, grinderHoursSavedMax: 0.08 },
	},
];

// ---------------------------------------------------------------------------------------------
// Generated doc tables: docs/economy/5b/quests.md blocks (render-docs.js). Every number in them comes
// from report() at the current framework version; nothing is typed by hand.
const mdCell = (c) => (c === null || c === undefined ? '—' : String(c).replace(/\|/g, '\\|'));
const mdTable = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`)].join('\n');
const fmtN = (x) => (x === null || x === undefined ? '—' : Math.round(x).toLocaleString('en-US'));
const fmtUsd = (x) => `$${fmtN(x)}`;
const fmtUsdShort = (x) => (x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e4 ? `$${Math.round(x / 1e3)}k` : fmtUsd(x));
const fmtH = (x) => (x === null || x === undefined ? '—' : x.toFixed(2));
const fmtPct = (x, d = 1) => (x === null || x === undefined ? '—' : `${x.toFixed(d)}%`);
const fmtShare = (x, d = 1) => fmtPct(x * 100, d);
const fmtRange = (values, f) => {
	const lo = Math.min(...values);
	const hi = Math.max(...values);
	return f(lo) === f(hi) ? f(lo) : `${f(lo)}–${f(hi)}`;
};
const capName = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const gearName = (key) => (key === 'old' ? 'Old Rod' : key.toUpperCase());
const hDay = (x) => (x ? `${fmtH(x.hours)} (d${x.day})` : '—');
const fmtMin = (x) => (x >= 100 ? fmtN(x) : x.toFixed(1));
const fmtPrice = (x) => `$${x.toFixed(2)}`;

function markdownTables() {
	const R = DEFAULT.report();
	const T = {};
	const ENG = Object.keys(F.ARCHETYPES);
	const MDN = F.MINIMUM_DAILY.name;
	const TL = Object.keys(F.TARGET_WINDOWS).map(Number);
	const LEVELS = F.LIFECYCLE.milestones;
	const TOP = LEVELS[LEVELS.length - 1];
	const windowText = (L) => `${F.TARGET_WINDOWS[L][0]}–${F.TARGET_WINDOWS[L][1]} h`;
	const G = R.guardrails;
	const ADV = R.adversarial;
	const BANDS = DEFAULT.bands();
	const cc = Object.fromEntries(R.currentCatalog.map((c) => [c.title, c]));
	const casualSession = F.ARCHETYPES.casual.minutesPerDay;

	// ----- Headline -----
	const md = ADV.minimumDaily;
	const withoutOk = Object.values(R.regularWindowsWithoutQuests).filter((w) => w.ok).length;
	T['quests-headline'] = mdTable(['Figure (integrated reference loop)', 'Value', 'Table'], [
		['Regular player, hours to L20 / L30 / L40 / L50', `${TL.map((L) => fmtH(R.regularWindows[L].hours)).join(' / ')} (windows ${TL.map(windowText).join(', ')}): ${R.regularWindowsOk ? 'all in window' : '**a window is missed**'}`, '§6.4'],
		['Same loop without the quest system', `${TL.map((L) => fmtH(R.regularWindowsWithoutQuests[L].hours)).join(' / ')}: ${withoutOk} of ${TL.length} in window`, '§6.4'],
		['Minimum-daily player (R2)', `XP per active hour ${fmtRange(Object.values(md.xpPerActiveHourVsRegular).filter((x) => x !== null), (x) => x.toFixed(2))}× the regular player's; leads an engaged archetype at a calendar checkpoint: ${md.leadsAnEngagedArchetypeOnDays.length ? `days ${md.leadsAnEngagedArchetypeOnDays.join(', ')}` : 'never'}`, '§7.2'],
		['No-miss grinder: play-hours saved by every quest type', `at most ${fmtPct(ADV.noMissGrinder.maxHoursSavedPct)} (limit ${fmtPct(G.grinderHoursSaved.limitPct, 0)})`, '§7.3'],
		['Casual play-hours ÷ regular, L20–L50', `${fmtRange(Object.values(G.casualHoursShareOfRegular.byLevel), (x) => x.toFixed(3))} with quests (policy ${G.casualHoursShareOfRegular.band.join('–')}); ${fmtRange(Object.values(G.casualHoursShareOfRegular.withoutQuests), (x) => x.toFixed(3))} without`, '§7.1'],
		['Daily/weekly XP ÷ XP of the fishing they require', `${G.dailyXpRatio.min.ratio.toFixed(3)}–${G.dailyXpRatio.max.ratio.toFixed(3)} (limit ${G.dailyXpRatio.limit})`, '§4'],
		[`Quest cash share of all income to L${TOP}`, ENG.map((a) => `${capName(a)} ${fmtPct(R.lifecycles[a].incomeAtMaxLevel.questCashSharePct)}`).join(', '), '§6.3'],
		['Whole story line', `${fmtN(R.storyTotals.xp)} XP, ${fmtUsd(R.storyTotals.cash)}, ${R.storyTotals.boxes} Daily Boxes`, '§5.1'],
		['Every guardrail', Object.values(G).every((g) => g.pass) ? 'pass' : '**a guardrail fails**', '§7.4'],
	]);

	// ----- §1 Correctness fixes -----
	const tr = R.fixes.trout;
	const vil = cc['Help the Village!'];
	const vilBand = R.repeatability.perBand[0];
	const neverIssued = R.currentCatalog.filter((c) => c.issues.some((i) => i.startsWith('never issued'))).map((c) => c.title);
	const slowDailies = R.currentCatalog.filter((c) => c.daily && c.minutes.casual > casualSession && !neverIssued.includes(c.title));
	const lf = cc['Lucky Fisher'];
	const mk = cc['Find the Lucky Magikarp'];
	const lfx = R.fixes.luckyFisher;
	const mkx = R.fixes.magikarp;
	T['quests-fixes'] = mdTable(['#', 'Bug', 'Evidence', 'Fix'], [
		['Q1', `**"Catch 15 Trout" targets ${tr.missingFromCatalog.map((n) => `\`${n}\``).join(', ')}, which does not exist.**`, `\`catalogIntegrity().today\`; ${fmtShare(tr.perFishToday)} of River fish match, so ${fmtN(tr.fishFor15Today)} fish for 15`, `the **River trout family** (${tr.proposedTargets.length} species, trout table): ${fmtShare(tr.perFishProposed)} match, ${fmtN(tr.fishFor15Proposed)} fish`],
		['Q2', '**Non-daily quests repeat without limit.** `/start-quest` only blocks the same title *while it is in progress* (`startQuest.js:110`).', `"Help the Village!" pays ${fmtUsd(vil.cash)} + ${fmtN(vil.xp)} XP for ${vil.target.split(' x ')[0]} fish: +${fmtPct(vilBand.today.cashBonusPct, 0)} of Ocean fishing cash and +${fmtPct(vilBand.today.xpBonusPct, 0)} XP (repeatability table)`, 'the kind model (§2): story quests once-only (`questLog`); repeatables with a cooldown and a daily cap'],
		['Q3', '**`/start-quest` never enforces prerequisites.** `if (prereq > 0)` (`startQuest.js:91`) compares the prerequisite *array* with a number (always false), and uses `some` instead of `every`.', 'latent today (no non-daily quest has prerequisites); the proposed Lucky Fisher requires Magikarp', '`canStart()`: `prerequisites.every(k => questLog[k].completions > 0)`'],
		['Q4', '**`/daily` looks for completed prerequisites in the catalog collection** (`Quest.js:130` queries `quests`; per-user copies live in `questdatas`).', `${neverIssued.join(', ')} are **never issued**; every ineligible random pick recurses (\`Quest.js:111/126/133\`)`, 'the eligible pool is filtered up front (kind `daily`, not retired, level) with no recursion; prerequisites come from `questLog`'],
		['Q5', '**An unfinished daily never expires and blocks `/daily`** (`daily.js:23`, `Quest.js:119`).', slowDailies.map((c) => `"${c.title}": ${fmtN(c.fishNeeded)} fish, ${fmtN(c.minutes.casual)} casual min (${(c.minutes.casual / casualSession).toFixed(1)} casual sessions)`).join('; '), 'dailies expire at the end of their DCC day (`status: \'expired\'`, document kept) and never block; requirements sized to the casual session (§4)'],
		['Q6', '**Lucky Fisher is out of reach, counts items, and rewards an item that does not exist.**', `${lfx.today.count} Lucky catches, and Lucky ITEM catches progress it: ${fmtN(lf.fishNeeded)} fish at its Lv ${lf.level} gear, ${fmtN(lfx.today.fishNeededAtPond)} at Pond; reward ${lf.rewardItems.join(', ')} is not in the catalog (the quest pays no item)`, `${lfx.proposed.count} Lucky **fish**, items never progress a quest, a luck-weighted pity (§5.2); reward cash, XP and ${storyByKey['story.lucky-fisher'].reward.boxes} Daily Boxes`],
		['Q7', '**Magikarp has no pity.**', `1 per ${fmtN(mkx.oldRod.withoutPity)} Ocean fish on the Old Rod: ${fmtN(mk.minutes.regular)} minutes of regular play`, `a quest pity on a luck-weighted meter: expected ${fmtN(mkx.expectedFish.mean)} fish, sure at ${fmtN(mkx.pity.hard)} points (pity table)`],
		['Q8', '**River quests are offered at Lv 0.**', `trout and carp target River fish; River unlocks at Lv ${F.BIOME_LEVEL.River}`, 'story level = the target biome\'s level (`F.BIOME_LEVEL`)'],
	]);
	const carp = R.fixes.carp;
	T['quests-trout'] = mdTable(['Target', 'Species that count', 'Not counted', 'Share of River fish', 'Expected fish for 15'], [
		['"Catch 15 Trout" today', tr.todayTargets.join(', '), `${tr.missingFromCatalog.join(', ')} (not in the catalog)`, fmtShare(tr.perFishToday), fmtN(tr.fishFor15Today)],
		['River trout family (proposed)', tr.proposedTargets.join(', '), `${tr.excluded.join(', ')}: the quest says "from the river"`, fmtShare(tr.perFishProposed), fmtN(tr.fishFor15Proposed)],
		['River carp family (proposed)', carp.proposedTargets.join(', '), '—', fmtShare(carp.perFishProposed), fmtN(carp.fishFor15Proposed)],
	]);

	// ----- §2 Kinds and rule examples -----
	const P = PARAMS;
	const ex = R.ruleExamples;
	T['quests-kinds'] = mdTable(['Kind', 'Issued / started by', 'Instances', 'Expiry', 'Repeat rule', 'Reward rule'], [
		['`story`', '`/start-quest`', 'one per player, ever', 'none', 'once: `questLog[key].completions > 0` blocks a restart; every prerequisite must be complete', 'minutes of the band\'s regular income + Daily Boxes (story table)'],
		['`daily`', '`/daily`, or lazily on the first successful cast of the DCC day', `one per DCC day (\`${ex.period.daily}\`)`, 'end of the DCC day', 'a new one each day; an unfinished one never blocks', `${P.daily.reward.xpK} × the XP and ${P.daily.reward.cashK} × the cash of its expected fish (P-DAILY-FACTOR) + ${P.daily.boxes} ${P.daily.boxName}`],
		['`weekly`', `issued with the week's first daily, from ${P.weekly.unlockBiome} (Lv ${F.BIOME_LEVEL[P.weekly.unlockBiome]})`, `one per ISO week (\`${ex.period.weekly}\`)`, 'end of the ISO week', 'a new one each week', `${P.weekly.reward.xpK} × the XP and ${P.weekly.reward.cashK} × the cash of its expected fish + ${P.weekly.boxes} ${P.weekly.boxName}es`],
		['`repeatable`', '`/start-quest`', 'any number over time', 'none', `${P.repeatable.cooldownHours} h cooldown per title after completion; at most ${P.repeatable.dailyCap} completions per DCC day across all titles; ${P.repeatable.maxActive} active at a time`, `${pct(P.repeatable.reward.xpShare)}% of the XP and ${pct(P.repeatable.reward.cashShare)}% of the cash its fishing earns; ${P.repeatable.boxes} boxes`],
	]);
	const CASES = [
		['storyLevelTooLow', 'Lucky Fisher, level below Pond\'s'],
		['storyMissingPrerequisite', 'Lucky Fisher at Pond\'s level, without Magikarp'],
		['storyOk', 'Lucky Fisher at Pond\'s level, with Magikarp'],
		['storyAlreadyDone', 'Trout again after completing it'],
		['repeatableCooldown', 'Village again shortly after completing it'],
		['repeatableOtherTitle', 'Fishmonger while Village is on cooldown, one completion today'],
		['repeatableDailyCap', 'Fishmonger at the daily cap'],
		['repeatableOneActive', 'Fishmonger while Village is active'],
		['dailyIsIssued', 'Starting a daily'],
	];
	T['quests-rule-examples'] = mdTable(['Case (`ruleExamples()`)', 'Result'], [
		[`Periods at ${ex.period.at}`, `daily \`${ex.period.daily}\`, expires ${ex.period.dailyExpires}; weekly \`${ex.period.weekly}\`, expires ${ex.period.weeklyExpires}`],
		...CASES.map(([k, label]) => [label, ex.canStart[k].ok ? 'OK' : `"${ex.canStart[k].reason}"`]),
	]);

	// ----- §3 Today's catalog -----
	const legacyIssue = (c) => {
		const q = LEGACY_QUESTS.find((x) => x.title === c.title);
		const codes = [];
		if (c.issues.some((i) => i.startsWith('progressType.fish'))) codes.push('Q1');
		if (!c.daily) codes.push('Q2');
		if (c.issues.some((i) => i.startsWith('never issued'))) codes.push('Q4');
		else if (c.daily && c.minutes.casual > casualSession) codes.push('Q5');
		if (q.progressType.rarity.includes('lucky') || c.issues.some((i) => i.startsWith('rewardItems'))) codes.push('Q6');
		if (c.mapsTo === 'story.magikarp') codes.push('Q7');
		if (c.issues.some((i) => i.startsWith('targets '))) codes.push('Q8');
		return codes.join(', ');
	};
	const proposedFor = (c) => {
		const key = c.mapsTo;
		if (P.retiredDailyTitles.includes(c.title)) return `**retired** → \`${key}\``;
		const kind = key.split('.')[0];
		const story = storyByKey[key];
		const extra = story ? `, Lv ${F.BIOME_LEVEL[story.levelBiome]}${story.pity ? ', quest pity' : ''}${story.prerequisites.length ? `, after ${story.prerequisites.join(', ')}` : ''}` : ', stage-scaled';
		return `**${kind}** \`${key}\`${extra}`;
	};
	T['quests-catalog-today'] = mdTable(['Today\'s quest', 'Type today', 'Target; reward today', 'Fish needed (casual min)', 'Reward in stage minutes (cash / XP)', 'Problems', 'Proposed'], R.currentCatalog.map((c) => [
		c.title, `${c.daily ? 'daily' : 'non-daily'}, Lv ${c.level}`, `${c.target}; ${fmtUsd(c.cash)}, ${fmtN(c.xp)} XP${c.rewardItems.length ? ` + ${c.rewardItems.join(', ')}` : ''}`,
		`${fmtN(c.fishNeeded)} (${fmtMin(c.minutes.casual)})`, `${c.rewardInStageMinutes.cash.toFixed(1)} / ${c.rewardInStageMinutes.xp.toFixed(1)}`, legacyIssue(c), proposedFor(c),
	]));

	// ----- §4 Bands -----
	const reqMin = R.bands.map((b) => b.dailyRequirementMinutesCasual);
	const endgame = BANDS[BANDS.length - 1];
	T['quests-band-rules'] = mdTable(['Rule (`PARAMS`)', 'Value'], [
		['Bands', `${BANDS.map((b) => `${capName(b.id)} ${b.minLevel}${b.maxLevel === null ? '+' : `–${b.maxLevel}`}`).join(', ')}; each band fishes its biome with the tier held at its first level (\`F.tierAt\` on \`F.gearPath()\`); ${capName(endgame.id)} fishes ${endgame.biome} on ${gearName(endgame.gear.key)} until Mountain Stream ships`],
		['Daily requirement', `${P.daily.requirement.archetype} session (${casualSession} min) × (${P.daily.requirement.sessionShare.base} + ${P.daily.requirement.sessionShare.perBand} × band index) at the casual cadence: ${fmtRange(reqMin, (x) => x.toFixed(1))} min`],
		['Rarity templates', 'the same expected fish as the any-fish template: count = round(N × P(match))'],
		['Weekly requirement', `${P.weekly.requirement.dailyMultiple} × the daily requirement; offered from ${P.weekly.unlockBiome}; a rarity weekly only where its expected fish ≤ ${P.weekly.maxEffortRatio} × the requirement`],
		['Repeatable requirement', `${r3(P.repeatable.requirement.sessionShare)} of the ${P.repeatable.requirement.archetype} session (${fmtN(F.ARCHETYPES[P.repeatable.requirement.archetype].minutesPerDay * P.repeatable.requirement.sessionShare)} min) at its cadence`],
		['Rewards', `daily/weekly: XP = ${P.daily.reward.xpK} × expected fish × XP per fish, cash = ${P.daily.reward.cashK} × expected fish × $ per fish, at the band's stage; repeatable: ${pct(P.repeatable.reward.xpShare)}% and ${pct(P.repeatable.reward.cashShare)}% of the same; rounded to ${P.rounding.sigDigits} significant digits`],
	]);
	const termCell = (x, unit) => `${fmtN(x.progressMax)}${unit}: ${fmtN(x.xp)} XP, ${fmtUsd(x.cash)}`;
	const weeklyUnlock = F.BIOME_LEVEL[P.weekly.unlockBiome];
	T['quests-bands'] = mdTable(['Band (levels)', 'Stage', 'Daily req. (casual min)', 'Daily Catch', 'Daily Rare Hunt', 'Weekly Haul', 'Weekly Big Game', 'Weekly Legend Hunt', 'Village / Fishmonger (each)'], R.bands.map((b) => {
		const w = (i, unit) => (b.minLevel < weeklyUnlock ? `— (from Lv ${weeklyUnlock})` : b.weekly[i].offered ? termCell(b.weekly[i], unit) : 'not offered');
		const [v, fm] = b.repeatable;
		const cash = v.cash === fm.cash ? fmtUsd(v.cash) : `${fmtUsd(v.cash)} / ${fmtUsd(fm.cash)}`;
		return [
			`${capName(b.band)} (${b.minLevel}${b.maxLevel === null ? '+' : `–${b.maxLevel}`})`, `${b.biome}${b.note ? '*' : ''}, ${gearName(b.gear)}`, b.dailyRequirementMinutesCasual.toFixed(1),
			termCell(b.daily[0], ' fish'), termCell(b.daily[1], ' Rare+'), w(0, ' fish'), w(1, ' Ultra+'), w(2, ' Legendary+'),
			`${fmtN(v.progressMax)} fish / ${fmtN(fm.progressMax)} Uncommon+: ${fmtN(v.xp)} XP, ${cash}`,
		];
	})) + `\n\n\\*${endgame.note}. Daily and weekly quests also give ${P.daily.boxes} and ${P.weekly.boxes} Daily Boxes; repeatables give ${P.repeatable.boxes}.`;
	const allDaily = R.bands.flatMap((b) => b.daily);
	const weeklyBands = R.bands.filter((b) => b.minLevel >= weeklyUnlock).map((b) => b.band);
	const legendBands = R.bands.filter((b) => b.minLevel >= weeklyUnlock && b.weekly[2].offered);
	T['quests-effort'] = mdTable(['Check (`templateTerms()`, `report().catchUp`)', 'Value'], [
		['Casual minutes for a daily (mean, every band and template)', `${fmtRange(allDaily.map((x) => x.minutesCasual), (x) => x.toFixed(1))} min, inside the ${casualSession}-minute casual session`],
		['Daily Rare Hunt, fish at P90 (Ocean → endgame)', `${fmtN(R.bands[0].daily[1].p90Fish)} → ${fmtN(R.bands[R.bands.length - 1].daily[1].p90Fish)}`],
		['Casual player: days the daily completes', fmtRange(Object.values(R.catchUp).map((row) => row.casual.dailyCompletion * 100), (x) => fmtPct(x))],
		['Casual player: weeks the weekly completes (from River)', fmtRange(weeklyBands.map((id) => R.catchUp[id].casual.weeklyCompletion * 100), (x) => fmtPct(x))],
		['Weekly Legend Hunt where offered: expected fish, mean and P90', legendBands.map((b) => `${capName(b.band)} ${fmtN(b.weekly[2].expectedFish)} / ${fmtN(b.weekly[2].p90Fish)}`).join('; ')],
		['Reward XP ÷ XP of the required fishing, every daily and weekly', `${G.dailyXpRatio.min.ratio.toFixed(3)} (${G.dailyXpRatio.min.band} ${G.dailyXpRatio.min.key}) – ${G.dailyXpRatio.max.ratio.toFixed(3)} (${G.dailyXpRatio.max.band} ${G.dailyXpRatio.max.key}); limit ${G.dailyXpRatio.limit}`],
	]);

	// ----- §5 Story and pity -----
	const stories = R.catalog.filter((c) => c.kind === 'story');
	const targetText = (def, c) => {
		if (def.target.species) return `${def.target.species.join(', ')} (${def.target.biome})`;
		if (def.target.family) return `${def.count} ${def.target.family.biome} ${lower(def.target.family.suffix)}`;
		if (def.target.rarity) return `${def.count} ${def.target.rarity.join('/')} fish, any biome`;
		return `${fmtN(c.progressMax)} fish in the ${def.target.biome}`;
	};
	T['quests-story'] = mdTable(['Key', 'Title', 'Level', 'Prerequisite', 'Target', 'Expected fish (P90)', 'Regular min', 'Reward (XP / cash / boxes)'], [
		...stories.map((c) => {
			const def = storyByKey[c.key];
			return [`\`${c.key}\``, c.title, c.requirements.level, c.requirements.previous.join(', ') || '—', `${targetText(def, c)}${def.pity ? ', pity' : ''}`,
				`${fmtN(c.expectedFish.mean)} (${fmtN(c.expectedFish.p90)}${c.pity ? `; sure at ${fmtN(c.pity.hard)} points` : ''})`, c.minutes.regular.toFixed(1), `${fmtN(c.xp)} / ${fmtUsd(c.cash)} / ${c.boxes}`];
		}),
		['**Whole story line**', '', '', '', '', '', '', `**${fmtN(R.storyTotals.xp)} / ${fmtUsd(R.storyTotals.cash)} / ${R.storyTotals.boxes}**`],
	]);
	T['quests-story-completion'] = mdTable(['Chapter (level, calendar day completed)', ...ENG.map(capName)], stories.map((c) => [
		`\`${c.key}\``, ...ENG.map((a) => {
			const s = R.lifecycles[a].story.find((x) => x.key === c.key);
			return s && s.done ? `Lv ${s.doneAt.level} (d${s.doneAt.day})` : 'not completed';
		}),
	]));
	const ruleText = (p) => `soft ${fmtN(p.softStart)}, ramp ${p.rampPerPoint}/pt, max +${pct(p.maxBonus)}%, sure at ${fmtN(p.hard)} (stage: ${fmtN(p.stageFish)} ${p.stageBiome} fish)`;
	const chase = (row) => `${fmtN(row.withPity.mean)} / ${fmtN(row.withPity.p50)} / ${fmtN(row.withPity.p90)} / ${fmtN(row.withPity.max)} (meter ${row.meterWeight.toFixed(1)}/fish)`;
	const baitCell = (row) => {
		const b = row.bait;
		if (!b) return `no luck bait in the Ocean below Lv ${F.BIOME_LEVEL[BAIT.PARAMS.baits['Strong Magnet'].levelFromBiome]}`;
		return `${b.name} (Luck +${pct(BAIT.PARAMS.baits[b.name].stats.luck)}%, ${fmtPrice(b.pricePerCast)}/cast): **${fmtN(b.withPity.mean)} fish**, ${fmtUsd(b.baitCostForTheChase)} of bait; regular hours ${b.regularHours.without.toFixed(2)} → ${b.regularHours.with.toFixed(2)}`;
	};
	const shortened = (row) => (row.bait ? `${fmtPct(row.bait.shortenedPct)} / ${fmtPct(row.bait.countPity.shortenedPct)}` : '—');
	const natural = (row, what) => `1 per ${fmtN(row.withoutPity)} ${what}`;
	T['quests-pity'] = mdTable(['Chase', 'Rule (meter points)', 'Natural odds', 'With pity: mean / P50 / P90 / max fish', 'With luck bait (bait.js stats and price)', 'Bait shortens the chase: luck-weighted / plain count pity'], [
		['Magikarp, Old Rod', ruleText(mkx.pity), natural(mkx.oldRod, 'Ocean fish'), chase(mkx.oldRod), baitCell(mkx.oldRod), shortened(mkx.oldRod)],
		[`Magikarp, a returning ${gearName(mkx.returningT3StrongMagnet.gear)} player`, 'same', natural(mkx.returningT3StrongMagnet, 'Ocean fish'), chase(mkx.returningT3StrongMagnet), baitCell(mkx.returningT3StrongMagnet), shortened(mkx.returningT3StrongMagnet)],
		[`Lucky Fisher, Pond ${gearName(lfx.atPondT2.gear)}`, `per catch: ${ruleText(lfx.proposed.pity)}`, `${fmtN(lfx.atPondT2.withoutPity)} fish for ${lfx.proposed.count}`, chase(lfx.atPondT2), baitCell(lfx.atPondT2), shortened(lfx.atPondT2)],
		[`Lucky Fisher, Swamp ${gearName(lfx.atSwampT4.gear)}`, 'same', `${fmtN(lfx.atSwampT4.withoutPity)} fish for ${lfx.proposed.count}`, chase(lfx.atSwampT4), baitCell(lfx.atSwampT4), shortened(lfx.atSwampT4)],
	]);

	// ----- §6 Income, lifecycle and windows (integrated) -----
	T['quests-catchup'] = mdTable(['Band', ...ENG.map((a) => `${capName(a)} (${F.ARCHETYPES[a].minutesPerDay} min)`), 'Casual XP per played minute vs regular'], Object.entries(R.catchUp).map(([id, row]) => [
		capName(id), ...ENG.map((a) => `${fmtN(row[a].questXpPerDay)} XP (${fmtPct(row[a].questXpSharePct)}); cash ${fmtPct(row[a].questCashSharePct, 0)}`), `${row.casual.xpPerMinuteVsReference.toFixed(2)}×`,
	]));
	T['quests-income'] = mdTable([`Player (to L${TOP})`, 'Hours (day)', 'All income', 'Fishing cash', 'Quest cash (daily / weekly / repeatable / story / box contents)', 'Quest share of income', 'Daily Boxes'], ENG.map((a) => {
		const x = R.lifecycles[a].incomeAtMaxLevel;
		const q = x.questCashBy;
		return [capName(a), `${fmtH(x.hours)} (d${x.day})`, fmtUsdShort(x.grossIncome), fmtUsdShort(x.fishingCash), `${fmtUsdShort(x.questCash)} (${[...QUEST_SOURCES, BOX_SOURCE].map((k) => fmtUsdShort(q[k])).join(' / ')})`, fmtPct(x.questCashSharePct), x.boxes.toFixed(1)];
	}));
	T['quests-lifecycle'] = mdTable(['Player', 'Model', ...LEVELS.map((L) => `L${L}`)], ENG.flatMap((a) => [
		[capName(a), '**with quests**', ...LEVELS.map((L) => hDay(R.lifecycles[a].milestones[L].withQuests))],
		['', 'without quests', ...LEVELS.map((L) => hDay(R.lifecycles[a].milestones[L].withoutQuests))],
	]));
	T['quests-windows'] = mdTable(['Level', 'Approved window', 'Regular, with quests', 'Regular, without quests'], TL.map((L) => [
		`L${L}`, windowText(L), `${fmtH(R.regularWindows[L].hours)} ${R.regularWindows[L].ok ? '(in)' : '(**out**)'}`, `${fmtH(R.regularWindowsWithoutQuests[L].hours)} ${R.regularWindowsWithoutQuests[L].ok ? '(in)' : '(**out**)'}`,
	]));

	// ----- §7 R2 -----
	const D = R.decomposition;
	const xs = (x, key) => `${fmtN(x.xp[key])} (${fmtPct(x.share[key])})`;
	T['quests-decomposition'] = mdTable(['Player', 'Level', 'Day', 'Play-hours', 'Fishing', 'Daily', 'Weekly', 'Repeatable', 'Story', 'Buffs', 'Other', 'Quests (all kinds)'], ENG.flatMap((a) => TL.map((L, i) => {
		const x = D[a][L];
		return [i === 0 ? capName(a) : '', `L${L}`, x.day, fmtH(x.playHours), xs(x, 'fishing'), xs(x, 'daily'), xs(x, 'weekly'), xs(x, 'repeatable'), xs(x, 'story'), xs(x, 'buffs'), fmtN(x.xp.other), fmtPct(x.questSharePct)];
	})));
	const cs = G.casualHoursShareOfRegular;
	T['quests-catchup-hours'] = mdTable(['Casual play-hours ÷ regular', ...TL.map((L) => `L${L}`), 'Policy'], [
		['With quests (reference loop)', ...TL.map((L) => cs.byLevel[L].toFixed(3)), `${cs.band.join('–')}: ${cs.pass ? 'pass' : '**fail**'}`],
		['Without the quest system', ...TL.map((L) => cs.withoutQuests[L].toFixed(3)), '—'],
	]);
	const paceCells = (p) => (p ? [`${fmtH(p.playHours)} / d${p.calendarDays}`, fmtN(p.xpPerActiveHour), fmtN(p.xpPerCalendarDay), p.levelsPerCalendarWeek.toFixed(2), fmtPct(p.questShareOfXp)] : ['—', '—', '—', '—', '—']);
	const [LA, LB] = [TL[0], TL[TL.length - 1]];
	T['quests-min-daily'] = mdTable(['Pattern', `L${LA}: play-hours / day`, 'XP per active hour', 'XP per calendar day', 'Levels per week', 'Quest share of XP', `L${LB}: play-hours / day`, 'XP per active hour', 'XP per calendar day', 'Levels per week', 'Quest share of XP'], [MDN, ...ENG].map((n) => [
		n === MDN ? '**Minimum-daily**' : capName(n), ...paceCells(ADV.pace[n][`L${LA}`]), ...paceCells(ADV.pace[n][`L${LB}`]),
	])) + `\n\nMinimum-daily XP per active hour ÷ the regular player's: ${Object.entries(md.xpPerActiveHourVsRegular).map(([k, v]) => `${k} ${v === null ? '—' : `${v.toFixed(2)}×`}`).join(', ')}.`;
	T['quests-min-daily-minutes'] = mdTable(['Band', ...BANDS.map((b) => capName(b.id)), 'Average over the run'], [
		['Minutes a day: the daily requirement at the reference cadence; average: what the integrated run played', ...BANDS.map((b) => md.dailyRequirementMinutesByBand[b.id].toFixed(1)), `${md.averageMinutesPerDay.toFixed(2)} (daily requirement and streak gate, ${PARAMS.minimumDaily.maxDays} days)`],
	]);
	T['quests-calendar'] = mdTable(['Day', 'Minimum-daily (hours played)', ...ENG.map(capName)], md.levelsAtCalendarDays.map((row) => [
		row.day, `${row[MDN]} (${fmtH(row.minimumDailyHours)} h)`, ...ENG.map((a) => row[a]),
	]));
	const gr = ADV.noMissGrinder;
	T['quests-grinder'] = mdTable(['Level', 'Without quests', 'With every quest', 'Hours saved'], [
		...TL.map((L) => [`L${L}`, fmtH(gr.hoursToLevel[L].withoutQuests), fmtH(gr.hoursToLevel[L].withAllQuests), fmtPct(gr.hoursToLevel[L].hoursSavedPct)]),
		[`Quest share of the grinder's XP at L${LB}`, '', '', fmtPct(gr.questShareOfXpAtTopWindow)],
	]);
	const yes = (b) => (b ? 'yes' : '**no**');
	T['quests-guardrails'] = mdTable(['Check (`guardrails()`)', 'Value', 'Limit', 'Pass'], [
		['Daily/weekly XP ÷ XP of the required fishing', `max ${G.dailyXpRatio.max.ratio.toFixed(3)} (${G.dailyXpRatio.max.band} \`${G.dailyXpRatio.max.key}\`)`, `≤ ${G.dailyXpRatio.limit}`, yes(G.dailyXpRatio.pass)],
		['Casual play-hours ÷ regular\'s (L20–L50)', `${cs.min.toFixed(3)}–${cs.max.toFixed(3)}`, cs.band.join('–'), yes(cs.pass)],
		['Minimum-daily leads an engaged archetype at a calendar checkpoint', G.minimumDailyNeverLeads.leadsOnDays.length ? `days ${G.minimumDailyNeverLeads.leadsOnDays.join(', ')}` : 'never', 'never', yes(G.minimumDailyNeverLeads.pass)],
		['No-miss grinder: play-hours saved by quests', fmtPct(G.grinderHoursSaved.max), `≤ ${fmtPct(G.grinderHoursSaved.limitPct, 0)}`, yes(G.grinderHoursSaved.pass)],
	]);
	const FS = R.factorSensitivity;
	const days = PARAMS.checkpointsDays.slice(-3);
	T['quests-factor'] = mdTable(['Daily/weekly factor k (`rewardScale`)', `Regular L${TL.join('/L')} (h)`, 'Regular in every window', `Casual ÷ regular hours (L${LA}–L${LB})`, `Minimum-daily vs casual level (d${days.join('/d')})`, `Quest cash share to L${TOP}: casual / regular`], Object.entries(FS).sort((a, b) => b[0] - a[0]).map(([k, x]) => [
		Number(k) === P.daily.reward.xpK ? `**${k} (proposed)**` : k, TL.map((L) => fmtH(x.regularHours[L])).join(' / '), yes(x.regularInWindows),
		fmtRange(Object.values(x.casualCatchUp).filter((v) => v !== null), (v) => v.toFixed(3)), days.map((d) => `${x.minimumDailyVsCasualLevel[d].minimumDaily} vs ${x.minimumDailyVsCasualLevel[d].casual}`).join(', '),
		`${x.questCashSharePctToTopLevel.casual === null ? `not L${TOP} in ${PARAMS.minimumDaily.maxDays} days` : fmtPct(x.questCashSharePctToTopLevel.casual)} / ${x.questCashSharePctToTopLevel.regular === null ? '—' : fmtPct(x.questCashSharePctToTopLevel.regular)}`,
	]));

	// ----- §8 Repeatability -----
	const RP = R.repeatability;
	T['quests-repeat-band'] = mdTable(['Band', 'Today: cash bonus / XP bonus', 'Proposed: size, reward', 'Proposed: cash bonus / XP bonus'], RP.perBand.map((b) => [
		capName(b.band), `+${fmtPct(b.today.cashBonusPct, 0)} / +${fmtPct(b.today.xpBonusPct, 0)}`, `${fmtN(b.proposed.progressMax)} fish, ${fmtUsd(b.proposed.cash)} + ${fmtN(b.proposed.xp)} XP`, `+${fmtPct(b.proposed.cashBonusPct, 0)} / +${fmtPct(b.proposed.xpBonusPct, 0)}`,
	]));
	T['quests-repeat-day'] = mdTable(['Player (Ocean band)', 'Completions per day: today → proposed', 'Cash per day', 'Share of fishing cash'], ENG.map((a) => {
		const x = RP.perArchetype[a][0];
		return [capName(a), `${x.today.completionsPerDay.toFixed(1)} → ${x.proposed.completionsPerDay.toFixed(2)} (${x.proposed.limitedBy === 'dailyCap' ? 'daily cap' : `limited by ${x.proposed.limitedBy}`})`, `${fmtUsd(x.today.cashPerDay)} → ${fmtUsd(x.proposed.cashPerDay)}`, `${fmtPct(x.today.cashVsFishingPct, 0)} → ${fmtPct(x.proposed.cashVsFishingPct)}`];
	}));
	T['quests-repeat-bot'] = mdTable(['Band (24 h/day at the fastest cadence)', 'Repeatable cash per day', 'Fishing cash per day', 'Repeatable share', 'All quests\' share'], RP.worstCase24h.map((b) => [
		capName(b.band), fmtUsd(b.repeatableCashPerDay), fmtUsd(b.fishingCashPerDay), fmtPct(b.sharePct), fmtPct(b.allQuestCashSharePct),
	]));

	// ----- §9 Founder -----
	const FO = R.founder;
	T['quests-founder'] = mdTable([`Band (Daily Catch; Founder quest multipliers ×${FO.questXpMult} XP / ×${FO.questCashMult} cash)`, 'Shown publicly (base): XP / cash', 'Received (final): XP / cash'], FO.dailyByBand.map((b) => [
		capName(b.band), `${fmtN(b.base.xp)} / ${fmtUsd(b.base.cash)}`, `${fmtN(b.final.xp)} / ${fmtUsd(b.final.cash)}`,
	]));

	// ----- §10 Integration -----
	T['quests-daily-box'] = mdTable(['Band (level)', 'Fish sale value', 'Rod-part salvage', 'Booked as cash (`questBoxes`)', 'Usable bait (not booked)', 'Buff chance per box: Double XP / Double Cash / Lucky Draw'], R.integration.dailyBoxByBand.map((b) => [
		`${capName(b.band)} (${b.level})`, fmtUsd(b.fishValue), fmtUsd(b.salvage), `**${fmtUsd(b.liquid)}**`, fmtUsd(b.baitUsable), ['Double XP', 'Double Cash', 'Lucky Draw'].map((k) => fmtShare(b.buffs[k] || 0, 2)).join(' / '),
	]));
	const PR = RETIRED_LOOP_PARITY;
	T['quests-parity'] = mdTable(['Check (recorded, not live)', 'Result'], [
		['Source', PR.source],
		['Replay with the old loop\'s conventions', `${PR.replay.exactMilestones} of ${PR.replay.milestonesCompared} milestones step-exact; max relative difference ${PR.replay.maxRelativeDifference}; story steps identical: ${PR.replay.storyStepsIdentical ? 'yes' : 'no'}; calendar checkpoints match: ${PR.replay.calendarCheckpointsMatch ? 'yes' : 'no'}`],
		['R2 on the replay', `decomposition shares differ by ${PR.replay.r2.decompositionMaxAbsDiffPctPoints} pp; calendar levels match: ${PR.replay.r2.calendarLevelsMatch ? 'yes' : 'no'}; minimum-daily XP per active hour vs regular ${PR.replay.r2.xpPerActiveHourVsRegular.old} (old) vs ${PR.replay.r2.xpPerActiveHourVsRegular.core} (core); grinder max hours saved ${PR.replay.r2.grinderMaxHoursSavedPct.old}% vs ${PR.replay.r2.grinderMaxHoursSavedPct.core}%`],
		['This design\'s rules vs the old loop', `max ${fmtShare(PR.proposedRules.maxRelativeDifference, 2)} (${PR.proposedRules.worst}); largest shift ${PR.proposedRules.largestShiftSteps}`],
		['Attribution (each rule alone)', `terms at issue ${fmtShare(PR.proposedRules.attribution.termsAtIssue, 2)}, weekly by period ${fmtShare(PR.proposedRules.attribution.weeklyByPeriod, 2)}, session by fish ${fmtShare(PR.proposedRules.attribution.sessionByFish, 2)}`],
	]);

	// ----- Decisions -----
	T['quests-decisions'] = mdTable(['ID', 'Proposed decision', 'Modelled', 'Alternatives', 'Why', 'Record = model'], DECISIONS.map((d) => [
		`\`${d.id}\``, d.title, typeof d.modelled === 'string' ? d.modelled : `\`${JSON.stringify(d.modelled)}\``, d.alternatives.join('; '), d.why,
		d.get ? (JSON.stringify(d.get()) === JSON.stringify(d.expected) ? 'yes' : '**NO**') : 'n/a',
	])) + `\n\nStatus of every entry: \`${[...new Set(DECISIONS.map((d) => d.status))].join(', ')}\`. Only the user approves. \`decisions.js\` joins these to the Phase 5B registry (with the framework entries P-DAY and P-DAILY-FACTOR), and \`check-shared.js\` verifies each record against the model.`;

	return T;
}

module.exports = {
	PARAMS, DECISIONS, KINDS, SCHEMA, kindOf, periodKey, expiresAt, canStart, resolveLegacy, ruleExamples, speciesFamily, catalogIntegrity, binomialAtLeast, fishForQuantile, pityStats,
	dailyBoxValue, SYSTEM_NAME, QUEST_SOURCES, BOX_SOURCE, BOX_VALUES, SYSTEM_DEFAULTS, RETIRED_LOOP_PARITY,
	...DEFAULT,
	markdownTables,
};

if (require.main === module) process.stdout.write(`${JSON.stringify(module.exports.report(), null, 1)}\n`);
