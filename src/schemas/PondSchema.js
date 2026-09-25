const { model, Schema } = require('mongoose');

const PondSchema = new Schema({
	id: {
		type: String,
		required: true,
		unique: true,
	},
	count: {
		type: Number,
		default: 2000,
	},
	maximum: {
		type: Number,
		default: 2000,
	},
	lastFished: {
		type: Number,
		default: 0,
	},
	// Idempotency guard: keys of operations (casts, gacha opens, grants) already applied to this
	// document (last few only). See engine/rewards.js notApplied/appliedTo.
	appliedOps: {
		type: [String],
		default: undefined,
	},
	// Legacy name of appliedOps (Phase 2-4). Read by the guards, never written; ages out naturally.
	appliedCasts: {
		type: [String],
		default: undefined,
	},
	warning: {
		type: Boolean,
		default: false,
	},
}, { timestamps: true });

const Pond = model('Pond', PondSchema);
module.exports = { Pond };