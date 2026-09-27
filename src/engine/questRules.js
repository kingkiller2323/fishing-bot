// Quest correctness rules on TODAY's quest model (Phase 5B step B: quests). Per-user quests are the
// QuestData documents; nothing here uses the step C typed model (questLog, kinds, DCC-day periods).
//
// Prerequisites: every title in requirements.previous must have a completed QuestData of the player
// (none = eligible). /daily draws uniformly from the eligible pool, computed once (level through the
// identity-keyed gate level, then prerequisites), never by recursive retries. A daily left unfinished for
// 24 hours is marked failed (today's status enum; the document is kept) so it no longer blocks /daily or
// progresses; stats.lastDailyQuest stays the rolling 24-hour issuance gate.
const { QuestData } = require('../schemas/QuestSchema');

const DAILY_MS = 24 * 60 * 60 * 1000;

/** A quest's prerequisite titles; a missing or malformed list (or blank entries) counts as none. */
function prerequisitesOf(quest) {
	const previous = quest?.requirements?.previous;
	return Array.isArray(previous) ? previous.filter((t) => typeof t === 'string' && t.trim() !== '') : [];
}

/** True when every prerequisite title is in `completedTitles` (a Set). No prerequisites: true. */
function meetsPrerequisites(quest, completedTitles) {
	return prerequisitesOf(quest).every((title) => completedTitles.has(title));
}

/** Titles of the player's completed quests (their QuestData documents). */
async function completedQuestTitles(userId) {
	const rows = await QuestData.find({ user: String(userId), status: 'completed' }).select('title').lean();
	return new Set(rows.map((r) => r.title));
}

/** The daily templates a player may be given: level within the gate level, and every prerequisite completed. */
function eligibleDailies(templates, { gateLevel, completed }) {
	return templates.filter((t) => (Number(t?.requirements?.level) || 0) <= gateLevel && meetsPrerequisites(t, completed));
}

/** When a daily was issued: its startDate, else its creation time (legacy documents). */
function dailyStartedAt(quest) {
	if (Number.isFinite(quest?.startDate)) return quest.startDate;
	const created = quest?.createdAt ? new Date(quest.createdAt).getTime() : NaN;
	return Number.isFinite(created) ? created : null;
}

/** True when an in-progress daily was issued at least 24 hours before `now`. */
function isStaleDaily(quest, now = Date.now()) {
	const started = dailyStartedAt(quest);
	return Boolean(quest?.daily) && quest?.status === 'in_progress' && started !== null && now - started >= DAILY_MS;
}

/**
 * Marks the player's stale dailies failed (guarded on in_progress, so a daily completed in the meantime
 * is never touched). The documents are kept. Returns how many were expired.
 */
async function expireStaleDailies(userId, now = Date.now()) {
	const open = await QuestData.find({ user: String(userId), daily: true, status: 'in_progress' }).lean();
	let expired = 0;
	for (const q of open.filter((d) => isStaleDaily(d, now))) {
		const res = await QuestData.updateOne({ _id: q._id, status: 'in_progress' }, { $set: { status: 'failed', endDate: now } });
		expired += res.modifiedCount;
	}
	return expired;
}

module.exports = { DAILY_MS, prerequisitesOf, meetsPrerequisites, completedQuestTitles, eligibleDailies, dailyStartedAt, isStaleDaily, expireStaleDailies };
