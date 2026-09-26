// Shop purchases: one guarded atomic debit under the player's lock, then the grant.
// The balance check is the debit itself (`inventory.money >= cost` in the same write), so a stale
// User snapshot (e.g. one loaded when a select menu fired) can never pay for items it can't afford.
const { User: UserSchema } = require('../schemas/UserSchema');
const { User } = require('../class/User');
const { withUserLock } = require('./userLock');

/** Debits `cost` only if the player has at least that much. Returns true when the debit happened. */
async function debitMoney(userId, cost) {
	const res = await UserSchema.updateOne(
		{ userId: String(userId), 'inventory.money': { $gte: cost } },
		{ $inc: { 'inventory.money': -cost } },
	);
	return res.matchedCount === 1;
}

/**
 * Pays `cost` and then runs `grant(userData)` with a User freshly loaded after the debit (so any
 * whole-document save inside the grant keeps the debited balance). The grant never runs if the
 * debit did not happen; if the grant throws, the money is refunded and the error rethrown.
 * Resolves { ok, userData, balance } — on ok:false, userData is a fresh load showing the real balance.
 */
async function purchase(userId, cost, grant) {
	if (!Number.isFinite(cost) || cost < 0) throw new Error(`Invalid purchase cost: ${cost}`);
	return withUserLock(userId, async () => {
		if (!await debitMoney(userId, cost)) {
			const userData = new User(await User.get(userId));
			return { ok: false, userData, balance: await userData.getMoney() };
		}
		const userData = new User(await User.get(userId));
		try {
			if (grant) await grant(userData);
		}
		catch (err) {
			await UserSchema.updateOne({ userId: String(userId) }, { $inc: { 'inventory.money': cost } });
			throw err;
		}
		return { ok: true, userData, balance: await userData.getMoney() };
	});
}

// One live collector per (kind, message, player): a new one stops the previous, so a reopened
// menu on the same message can't leave several collectors all answering the same button click.
const liveCollectors = new Map();

function replaceCollector(kind, messageId, userId, collector) {
	const key = `${kind}:${messageId}:${userId}`;
	const previous = liveCollectors.get(key);
	if (previous && previous !== collector && !previous.ended) previous.stop('replaced');
	liveCollectors.set(key, collector);
	collector.on('end', () => {
		if (liveCollectors.get(key) === collector) liveCollectors.delete(key);
	});
	return collector;
}

module.exports = { purchase, debitMoney, replaceCollector };
