// The daily streak (step C.8; P-STREAK-*). Pure rules mirroring scripts/economy/5b/streak.js exactly; the cast
// engine applies them and persists the state in its atomic commit. A streak day is earned by real play: the
// gate's number of successful casts in the DCC day (b5/day.js), credited on the qualifying cast. Every streak
// day grants a Streak Crate; every cycle-th one the Streak Chest and a grace token. Grace tokens cover missed
// days; an uncovered miss costs a cycle of streak days; a long gap resets the streak (tokens kept).
const { need5b } = require('../balance');

const S = () => need5b().streak;

/** Read-time default for a player without streak fields (nothing is written until the first credit). */
const defaultState = () => ({ count: 0, best: 0, total: 0, lastDay: null, grace: S().grace.start, castsDay: null, castsToday: 0 });

/** The player's streak state (missing fields read as the defaults). */
function readState(user) {
	const st = user?.streak || {};
	const out = defaultState();
	for (const k of Object.keys(out)) if (st[k] !== undefined && st[k] !== null) out[k] = st[k];
	return out;
}

const boxForDay = (streakDay) => (streakDay > 0 && streakDay % S().ladder.cycle === 0 ? S().ladder.milestoneBox : S().ladder.dailyBox);

function applyGap(state, missedDays) {
	const s = { ...state };
	const out = { graceUsed: 0, decayedBy: 0, reset: false };
	if (missedDays <= 0 || s.count <= 0) return { state: s, ...out };
	if (missedDays >= S().decay.resetAfterMissedDays) {
		out.decayedBy = s.count;
		s.count = 0;
		out.reset = true;
		return { state: s, ...out };
	}
	out.graceUsed = Math.min(missedDays, s.grace);
	s.grace -= out.graceUsed;
	const uncovered = missedDays - out.graceUsed;
	const before = s.count;
	s.count = Math.max(0, s.count - S().decay.perUncoveredMiss * uncovered);
	out.decayedBy = before - s.count;
	return { state: s, ...out };
}

/** Credits streak day `day` (a second credit on the same day is a no-op). */
function advanceStreak(state, day) {
	const s0 = { ...defaultState(), ...state };
	if (s0.lastDay !== null && day <= s0.lastDay) return { state: s0, credited: false, box: null };
	const missed = s0.lastDay === null ? 0 : day - s0.lastDay - 1;
	const gap = applyGap(s0, missed);
	const s = gap.state;
	s.count += 1;
	s.total += 1;
	s.lastDay = day;
	const box = boxForDay(s.count);
	if (box === S().ladder.milestoneBox) s.grace = Math.min(S().grace.max, s.grace + S().grace.perCycle);
	const badges = S().badges.filter((b) => s.count >= b && s0.best < b);
	s.best = Math.max(s0.best, s.count);
	return { state: s, credited: true, box, streakDay: s.count, graceUsed: gap.graceUsed, decayedBy: gap.decayedBy, reset: gap.reset, badges };
}

/** One successful cast on DCC day `day`: counts it and credits the streak when the gate is reached. */
function onSuccessfulCast(state, day) {
	const s0 = { ...defaultState(), ...state };
	const castsToday = (s0.castsDay === day ? s0.castsToday : 0) + 1;
	const counted = { ...s0, castsDay: day, castsToday };
	if (castsToday < S().gate.successfulCasts || (s0.lastDay !== null && s0.lastDay >= day)) return { state: counted, credit: null };
	const credit = advanceStreak(counted, day);
	return { state: credit.state, credit };
}

/** Days until the next chest from a streak count. */
const daysToChest = (count) => S().ladder.cycle - (count % S().ladder.cycle);

module.exports = { defaultState, readState, boxForDay, applyGap, advanceStreak, onSuccessfulCast, daysToChest };
