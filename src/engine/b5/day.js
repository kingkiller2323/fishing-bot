// The DCC day (P-DAY): ONE boundary, 00:00 UTC by the 5B data, shared by daily quests and the streak. Nothing
// else computes a day or a week: every 5B period key and expiry comes from here.
const { need5b } = require('../balance');

const DAY_MS = 864e5;
const shift = () => need5b().day.startUtcHour * 3600e3;

/** Start (ms) of the DCC day containing `ms`. */
function dayStart(ms) {
	const s = shift();
	const d = new Date(ms - s);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + s;
}

/** Day index (days since the epoch, on the DCC boundary). */
const dayIndex = (ms) => Math.floor((ms - shift()) / DAY_MS);

/** "D2026-09-25": the DCC day of `ms`. */
const dayKey = (ms) => `D${new Date(ms - shift()).toISOString().slice(0, 10)}`;

/** "W2026-39": the ISO week (Monday start, on the DCC boundary) of `ms`. */
function weekKey(ms) {
	const d = new Date(ms - shift());
	const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
	const dow = t.getUTCDay() || 7;
	t.setUTCDate(t.getUTCDate() + 4 - dow);
	const y = t.getUTCFullYear();
	const week = Math.ceil(((t - Date.UTC(y, 0, 1)) / DAY_MS + 1) / 7);
	return `W${y}-${String(week).padStart(2, '0')}`;
}

/** End (ms, exclusive) of the DCC day / ISO week containing `ms`. */
const dayEnd = (ms) => dayStart(ms) + DAY_MS;
function weekEnd(ms) {
	const dow = new Date(ms - shift()).getUTCDay() || 7;
	return dayStart(ms) + (8 - dow) * DAY_MS;
}

module.exports = { DAY_MS, dayStart, dayIndex, dayKey, weekKey, dayEnd, weekEnd };
