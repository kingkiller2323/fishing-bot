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
	// Cast journal guard: ids of casts already applied to this document (last few only).
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
