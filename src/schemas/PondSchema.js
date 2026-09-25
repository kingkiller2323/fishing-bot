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
	// Cast journal guard: ids of casts already applied to this document (last few only).
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