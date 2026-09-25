const { model, Schema } = require('mongoose');

// Journal of every cast: the authoritative CastResult plus its persistence state.
// A cast is inserted as 'pending' before any game state changes and marked 'applied' once every
// write has landed; pending casts are rolled forward by recoverPendingCasts().
const CastSchema = new Schema({
	_id: {
		type: String,
	},
	userId: {
		type: String,
		required: true,
		index: true,
	},
	guildId: {
		type: String,
	},
	status: {
		type: String,
		enum: ['pending', 'applied'],
		default: 'pending',
		index: true,
	},
	result: {
		type: Schema.Types.Mixed,
		required: true,
	},
	attempts: {
		type: Number,
		default: 0,
	},
	lastError: {
		type: String,
	},
	appliedAt: {
		type: Date,
	},
}, { timestamps: true, minimize: false });

const Cast = model('Cast', CastSchema);
module.exports = { Cast };
