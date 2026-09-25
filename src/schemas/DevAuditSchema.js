const { model, Schema } = require('mongoose');

// Audit trail of every developer mutation (/dev commands).
const DevAuditSchema = new Schema({
	actor: { type: String, required: true },
	target: { type: String, required: true },
	operation: { type: String, required: true },
	details: { type: Schema.Types.Mixed },
	before: { type: Schema.Types.Mixed },
	after: { type: Schema.Types.Mixed },
	timestamp: { type: Date, default: Date.now, index: true },
}, { minimize: false });

const DevAudit = model('DevAudit', DevAuditSchema);
module.exports = { DevAudit };
