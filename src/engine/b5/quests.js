// Typed quests (step C.7; P-QUESTS-*). The 5B quest catalog lives in the generated data (never in today's
// catalog rows). Per-player instances are QuestData documents created from it, carrying their kind, key,
// period, expiry, band and terms (fixed at issue).
//
//   story       started with /start-quest; once per player (questLog); level + EVERY prerequisite
//   daily       one per DCC day (b5/day.js), issued by /daily or the first cast of the day; expires; never blocks
//   weekly      one per ISO week, issued with the week's first daily from its unlock level; expires
//   repeatable  started with /start-quest; per-title cooldown, a daily cap across titles, one active at a time
//
// Pre-5B instances (no kind) are mapped at READ time (resolveLegacy): they never expire or block, items never
// progress them, the trout/carp/Magikarp/Lucky Fisher targets follow the new chapter (count never higher than
// stored), a legacy story completion pays the greater of stored and current rewards, and every completion is
// logged under its mapped key. Nothing stored is rewritten.
const { ObjectId } = require('mongoose').Types;
const { need5b } = require('../balance');
const { User: UserModel } = require('../../schemas/UserSchema');
const { QuestData } = require('../../schemas/QuestSchema');
const { Item } = require('../../schemas/ItemSchema');
const { withUserLock } = require('../userLock');
const { gateLevelOf } = require('../levelGate');
const { rng } = require('../rng');
const day = require('./day');

const Q = () => need5b().quests;
const KINDS = ['story', 'daily', 'weekly', 'repeatable'];
const kindOfKey = (key) => (key ? String(key).split('.')[0] : null);
const template = (key) => Q().templates.find((t) => t.key === key) || null;
/** questLog field name of a key (Mongo paths cannot hold dots). */
const logField = (key) => String(key).replace(/\./g, ':');

/** The player's completion log as { key: { completions, firstCompletedAt, lastCompletedAt } }. */
function questLogOf(user) {
	const raw = user?.questLog instanceof Map ? Object.fromEntries(user.questLog) : (user?.questLog || {});
	return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.replace(/:/g, '.'), v]));
}

/** The band (terms) of a daily/weekly/repeatable template for a level: the highest band starting at or below it. */
function bandFor(t, level) {
	const bands = [...t.bands].sort((a, b) => a.minLevel - b.minLevel);
	return bands.filter((b) => b.minLevel <= level).at(-1) || bands[0];
}

/** Start rule for story and repeatable templates (the model's canStart). */
function canStart(t, state, ms) {
	const kind = t.kind;
	const log = state.questLog || {};
	const active = state.active || [];
	if (active.includes(t.key)) return { ok: false, reason: 'already in progress' };
	if (kind === 'story') {
		if (state.level < t.requirements.level) return { ok: false, reason: `needs level ${t.requirements.level}` };
		if ((log[t.key]?.completions || 0) > 0) return { ok: false, reason: 'already completed (story quests are one-time)' };
		const missing = (t.requirements.previous || []).filter((k) => !(log[k]?.completions > 0));
		if (missing.length) return { ok: false, reason: `needs ${missing.join(', ')} first (every prerequisite)` };
		return { ok: true };
	}
	if (kind === 'repeatable') {
		const cfg = Q().repeatable;
		if (active.filter((k) => kindOfKey(k) === 'repeatable').length >= cfg.maxActive) return { ok: false, reason: `only ${cfg.maxActive} repeatable at a time` };
		if ((state.repeatableCompletionsToday || 0) >= cfg.dailyCap) return { ok: false, reason: `daily cap of ${cfg.dailyCap} repeatable completions reached` };
		const last = log[t.key]?.lastCompletedAt;
		if (last && ms - last < cfg.cooldownHours * 3600e3) return { ok: false, reason: `on cooldown for ${((cfg.cooldownHours * 3600e3 - (ms - last)) / 3600e3).toFixed(1)} h` };
		return { ok: true };
	}
	return { ok: false, reason: `${kind} quests are issued by /daily, not started` };
}

/**
 * The terms a quest instance runs on: a 5B instance's own; a legacy one's mapped at read time.
 * Returns { key, kind, legacy, progressType, progressMax, xp, cash, boxes, pity }.
 */
function effectiveTerms(doc) {
	if (KINDS.includes(doc.kind)) {
		const t = template(doc.key);
		return { key: doc.key, kind: doc.kind, legacy: false, progressType: doc.progressType, progressMax: doc.progressMax, xp: doc.xp || 0, cash: doc.cash || 0, pity: t?.pity || null, pityForces: t?.pityForces || null, target: t };
	}
	const key = Q().legacyMap[doc.title] || null;
	const t = template(key);
	const out = { key, kind: 'legacy', mapsToKind: kindOfKey(key), legacy: true, progressType: { ...(doc.progressType || {}) }, progressMax: doc.progressMax, xp: doc.xp || 0, cash: doc.cash || 0, pity: null, pityForces: null, target: t };
	if (t?.kind === 'story') {
		// Count-based chapters (trout, carp, Magikarp, Lucky Fisher): the new target, a count never higher than stored.
		if (['story.river-trout', 'story.river-carp', 'story.magikarp', 'story.lucky-fisher'].includes(key)) {
			out.progressType = { ...out.progressType, ...t.progressType };
			out.progressMax = Math.min(doc.progressMax ?? t.progressMax, t.progressMax);
			out.pity = t.pity;
			out.pityForces = t.pityForces;
		}
		out.xp = Math.max(out.xp, t.xp);
		out.cash = Math.max(out.cash, t.cash);
		out.storyBoxes = t.boxes;
	}
	out.progressType = { ...out.progressType, kind: 'fish' };
	return out;
}

/** True when a 5B daily/weekly instance is past its period (legacy instances never expire). */
const isExpired = (doc, now) => ['daily', 'weekly'].includes(doc.kind) && Number.isFinite(doc.expiresAt) && now >= doc.expiresAt;

/** Does a catch entry progress these terms? (today's questMatches + the 5B biome/kind rules). */
function progresses(terms, entry, rodName) {
	const t = terms.progressType || {};
	if ((t.kind || 'fish') === 'fish' && entry.kind !== 'fish') return false;
	if (t.biome && t.biome !== 'any' && entry.biome !== t.biome) return false;
	const fish = t.fish || ['any'];
	const rarity = t.rarity || ['any'];
	const qualities = t.qualities || ['any'];
	const name = entry.name.toLowerCase();
	const entryQualities = (entry.qualities || []).map((q) => q.toLowerCase());
	const sizeOk = t.size === undefined || t.size === 'any' || (Number.isFinite(entry.size) && entry.size >= Number(t.size));
	const weightOk = t.weight === undefined || t.weight === 'any' || (Number.isFinite(entry.weight) && entry.weight >= Number(t.weight));
	return (fish.includes('any') || fish.includes(name))
		&& (rarity.includes('any') || rarity.includes(entry.rarity.toLowerCase()))
		&& (t.rod === 'any' || t.rod === rodName || t.rod === undefined)
		&& (qualities.includes('any') || qualities.some((q) => entryQualities.includes(q)))
		&& sizeOk && weightOk;
}

/** A story pity's chance bonus at `points` (engine/rarity applyPity semantics) and whether it is guaranteed. */
function pityBonus(pity, points) {
	if (!pity) return { bonus: 0, hard: false };
	if (points + 1e-9 >= pity.hard) return { bonus: 1, hard: true };
	return { bonus: Math.min(pity.maxBonus, Math.max(0, points - pity.softStart) * pity.rampPerPoint), hard: false };
}

/** Is a fish in a story pity's meter scope? Magikarp: Ocean fish; Lucky Fisher: any fish. */
const inPityScope = (terms, entry) => entry.kind === 'fish' && (!terms.progressType?.biome || terms.progressType.biome === 'any' || entry.biome === terms.progressType.biome);

/**
 * The quest pity for the first draw of a cast: among active story chases, the one whose meter triggers
 * (rolled once). Returns null or { docId, forces: 'species' | 'lucky-fish', species }.
 */
function questPityForce(states, biome) {
	for (const s of states) {
		const { terms } = s;
		if (!terms.pity || s.completed) continue;
		if (terms.progressType.biome && terms.progressType.biome !== 'any' && terms.progressType.biome !== biome) continue;
		const { bonus } = pityBonus(terms.pity, s.pityBefore);
		if (bonus > 0 && rng.random() < bonus) return { docId: String(s.doc._id), forces: terms.pityForces, species: terms.pityForces === 'species' ? terms.progressType.fish[0] : null };
	}
	return null;
}

/** The Daily Box catalog id (quest box reward). */
async function boxId() {
	const box = await Item.findOne({ name: Q().boxName, user: null }).select('_id').lean();
	return box ? box._id : null;
}

/** A new QuestData instance (raw document) from a template's terms. */
function instanceDoc({ userId, t, terms, band = null, now, period = null, expiresAt = null, box = null }) {
	const boxes = terms.boxes || 0;
	return {
		_id: new ObjectId(), title: t.title, description: String(t.description).replace('{n}', terms.progressMax), reward: box ? Array(boxes).fill(box) : [],
		cash: terms.cash, xp: terms.xp, requirements: { level: t.requirements?.level || 0, previous: [...(t.requirements?.previous || [])] },
		user: String(userId), progress: 0, progressMax: terms.progressMax, status: 'in_progress', daily: t.kind === 'daily',
		progressType: { size: 'any', weight: 'any', ...terms.progressType }, type: 'quest',
		key: t.key, kind: t.kind, ...(period ? { period, expiresAt } : {}), ...(band ? { band } : {}), ...(t.pity ? { pityCount: 0 } : {}),
		rulesVersion: Q().rulesVersion, startDate: now, createdAt: new Date(now), updatedAt: new Date(now),
	};
}

async function insertInstance(doc) {
	await QuestData.collection.insertOne(doc);
	await UserModel.collection.updateOne({ userId: doc.user }, { $push: { 'inventory.quests': doc._id } });
	return doc;
}

/**
 * Issues today's daily (and the week's weekly with it) if they do not exist yet; returns them. One pass, no
 * recursion, never blocked by an unfinished quest. Terms are the band's at issue time.
 */
async function issueDaily(userId, now = Date.now()) {
	return withUserLock(userId, async () => {
		const user = await UserModel.collection.findOne({ userId: String(userId) });
		if (!user) return null;
		const level = gateLevelOf(user);
		const box = await boxId();
		const out = { daily: null, weekly: null, created: [] };
		for (const kind of ['daily', 'weekly']) {
			const period = kind === 'daily' ? day.dayKey(now) : day.weekKey(now);
			const existing = await QuestData.collection.findOne({ user: String(userId), kind, period });
			if (existing) {
				out[kind] = existing;
				continue;
			}
			if (kind === 'weekly' && level < Q().weeklyUnlockLevel) continue;
			const pool = Q().templates.filter((t) => t.kind === kind).map((t) => ({ t, b: bandFor(t, level) })).filter((x) => x.b.offered);
			if (!pool.length) continue;
			const pick = pool[Math.floor(rng.random() * pool.length)];
			const doc = instanceDoc({ userId, t: pick.t, terms: pick.b, band: pick.b.band, now, period, expiresAt: kind === 'daily' ? day.dayEnd(now) : day.weekEnd(now), box });
			out[kind] = await insertInstance(doc);
			out.created.push(doc);
		}
		if (out.created.some((d) => d.kind === 'daily')) await UserModel.collection.updateOne({ userId: String(userId) }, { $set: { 'stats.lastDailyQuest': now } });
		return out;
	});
}

/** The player's start state: level, questLog, active keys, repeatable completions today. */
async function startState(user, now) {
	const active = (await QuestData.collection.find({ user: String(user.userId), status: 'in_progress' }).toArray()).map((d) => effectiveTerms(d).key).filter(Boolean);
	const qd = user.stats?.questDay;
	return { level: gateLevelOf(user), questLog: questLogOf(user), active, repeatableCompletionsToday: qd?.period === day.dayKey(now) ? qd.repeatableCompletions || 0 : 0 };
}

/** Starts a story or repeatable quest by key (under the lock, so a double click starts one). */
async function startQuest(userId, key, now = Date.now()) {
	const t = template(key);
	if (!t) return { ok: false, reason: 'unknown quest' };
	return withUserLock(userId, async () => {
		const user = await UserModel.collection.findOne({ userId: String(userId) });
		if (!user) return { ok: false, reason: 'player not found' };
		const state = await startState(user, now);
		const check = canStart(t, state, now);
		if (!check.ok) return check;
		const terms = t.kind === 'story' ? t : bandFor(t, state.level);
		const doc = instanceDoc({ userId, t, terms, band: t.kind === 'story' ? null : terms.band, now, box: await boxId() });
		await insertInstance(doc);
		return { ok: true, quest: doc };
	});
}

/** Templates the player may start now (story and repeatable), with the refusal reason for the rest. */
async function startable(userId, now = Date.now()) {
	const user = await UserModel.collection.findOne({ userId: String(userId) });
	const state = await startState(user, now);
	return Q().templates.filter((t) => t.kind === 'story' || t.kind === 'repeatable').map((t) => ({ t, check: canStart(t, state, now), terms: t.kind === 'story' ? t : bandFor(t, state.level) }));
}

/**
 * Quest progress for a cast (pure; the cast engine persists the result). `docs`: the player's in_progress
 * QuestData; returns { states, expired } where each state carries the doc, its terms, pity and progress.
 */
function prepare(docs, now) {
	const expired = [];
	const states = [];
	for (const doc of docs) {
		if (isExpired(doc, now)) {
			expired.push(String(doc._id));
			continue;
		}
		const terms = effectiveTerms(doc);
		states.push({ doc, terms, progress: doc.progress || 0, completed: false, touched: false, pityBefore: Number(doc.pityCount) || 0, pityAfter: Number(doc.pityCount) || 0 });
	}
	return { states, expired };
}

/** Advances the states with the cast's catches; `luck` is the cast's resolved Luck stat (pity meter weight). */
function advance(states, catches, { rodName, luck }) {
	for (const entry of catches) {
		for (const s of states) {
			if (s.completed) continue;
			const hit = progresses(s.terms, entry, rodName);
			if (s.terms.pity && inPityScope(s.terms, entry)) {
				s.touched = true;
				s.pityAfter = hit ? 0 : s.pityAfter + entry.count * (1 + Math.max(0, luck || 0));
			}
			if (!hit) continue;
			s.touched = true;
			s.progress += entry.count;
			if (s.progress >= (s.terms.progressMax || 1)) s.completed = true;
		}
	}
	return states;
}

/** Per completion: the questLog update and whether it counts toward the repeatable daily cap. */
function completionLog(states, user, now) {
	const done = states.filter((s) => s.completed && s.terms.key);
	const repeatables = done.filter((s) => (s.terms.kind === 'repeatable' || s.terms.mapsToKind === 'repeatable')).length;
	const qd = user.stats?.questDay;
	const today = day.dayKey(now);
	const before = qd?.period === today ? qd.repeatableCompletions || 0 : 0;
	return {
		keys: done.map((s) => logField(s.terms.key)),
		at: now,
		questDay: repeatables > 0 ? { period: today, repeatableCompletions: before + repeatables } : null,
	};
}

module.exports = {
	KINDS, kindOfKey, template, logField, questLogOf, bandFor, canStart, effectiveTerms, isExpired, progresses, pityBonus, inPityScope,
	questPityForce, instanceDoc, issueDaily, startQuest, startable, startState, prepare, advance, completionLog, boxId,
};
