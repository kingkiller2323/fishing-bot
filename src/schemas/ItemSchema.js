const { model, Schema } = require('mongoose');

const itemSchema = new Schema({
	name: {
		type: String,
		required: true,
	},
	description: {
		type: String,
		required: true,
	},
	prerequisites: {
		type: [String],
	},
	rarity: {
		type: String,
		required: true,
	},
	price: {
		type: Number,
		required: true,
		default: 0,
	},
	count: {
		type: Number,
		default: 1,
	},
	type: {
		type: String,
		default: 'item',
	},
	user: {
		type: String,
	},
	shopItem: {
		type: Boolean,
		default: false,
	},
	qualities: {
		type: [String],
		default: ['weak'],
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
	icon: {
		animated: {
			type: Boolean,
			default: false,
		},
		data: {
			type: String,
			default: '',
		},
	},
}, { timestamps: true });

const Item = model('Item', itemSchema);
const ItemData = model('ItemData', itemSchema);
module.exports = { Item, ItemData };
