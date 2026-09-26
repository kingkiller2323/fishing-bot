// Read-time buff expiry. The sweep that flips `active` off (events/Guild/interactionCreate.js) only
// runs for slash commands, so button paths (Fish again, Sell, Open again) could keep using a buff
// after its endTime. Every consumer queries through this filter instead of `{ active: true }` alone.
// It mirrors the sweep exactly: a buff ends when it has an endTime and endTime <= now, so a buff with
// no endTime (missing, null or 0) is still treated as unexpired.

/**
 * Mongo filter for a player's buffs that are active and not yet expired at `now`.
 * @param {string} userId
 * @param {Date|number} [now] the caller's clock (a Date or epoch ms); defaults to Date.now()
 */
function activeBuffFilter(userId, now = Date.now()) {
	const ms = now instanceof Date ? now.getTime() : Number(now);
	return {
		user: String(userId),
		active: true,
		$or: [{ endTime: { $gt: ms } }, { endTime: null }, { endTime: 0 }],
	};
}

module.exports = { activeBuffFilter };
