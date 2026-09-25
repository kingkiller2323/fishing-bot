// Sale bookkeeping for the private reward view. Sales pay the true value; public messages show the
// base value; the last sale's base and final amounts are kept for /fishing-stats.
const { User: UserModel } = require('../schemas/UserSchema');

async function recordSale(userId, base, final) {
	await UserModel.updateOne({ userId: String(userId) }, { $set: { 'stats.lastSale': { base: Math.round(base), final: Math.round(final), at: new Date() } } });
}

module.exports = { recordSale };
