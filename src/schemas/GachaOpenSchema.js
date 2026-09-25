const { model, Schema } = require('mongoose');

// Journal of every box opening: the authoritative GachaResult plus its persistence state.
// Inserted as 'pending' before anything changes, marked 'applied' when every write has landed;
// pending opens are rolled forward by recoverPendingOpens().
const GachaOpenSchema = new Schema({
	_id: { type: String },
	userId: { type: String, required: true, index: true },
	guildId: { type: String },
	status: { type: String, enum: ['pending', 'applied'], default: 'pending', index: true },
	result: { type: Schema.Types.Mixed, required: true },
	attempts: { type: Number, default: 0 },
	lastError: { type: String },
	appliedAt: { type: Date },
}, { timestamps: true, minimize: false });

const GachaOpen = model('GachaOpen', GachaOpenSchema);
module.exports = { GachaOpen };
