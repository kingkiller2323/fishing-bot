const { model, Schema } = require('mongoose');

const questSchema = new Schema({
	title: {
		type: String,
		required: true,
	},
	description: {
		type: String,
		required: true,
	},
	reward: {
		type: [{
			type: Schema.Types.ObjectId,
		}],
	},
	cash: {
		type: Number,
		required: true,
		default: 0,
	},
	xp: {
		type: Number,
		required: true,
		default: 0,
	},
	requirements: {
		level: {
			type: Number,
			default: 0,
		},
		previous: [{
			type: String,
			default: '',
		}],
	},
	startDate: {
		type: Number,
	},
	endDate: {
		type: Number,
	},
	user: {
		type: String,
	},
	progress: {
		type: Number,
		default: 0,
	},
	progressMax: {
		type: Number,
		default: 1,
	},
	status: {
		type: String,
		enum: ['pending', 'in_progress', 'completed', 'failed'],
		default: 'pending',
	},
	daily: {
		type: Boolean,
		default: false,
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
	progressType: {
		fish: [{
			type: String,
			default: 'any',
		}],
		rarity: [{
			type: String,
			default: 'any',
		}],
		rod: {
			type: String,
			default: 'any',
		},
		qualities: [{
			type: String,
			default: 'any',
		}],
		size: {
			type: String,
			default: 'any',
		},
		weight: {
			type: String,
			default: 'any',
		},
	},
	type: {
		type: String,
		default: 'quest',
	},
}, { timestamps: true });

const Quest = model('Quest', questSchema);
const QuestData = model('QuestData', questSchema);
module.exports = { Quest, QuestData };
