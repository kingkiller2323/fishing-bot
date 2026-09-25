const { Schema } = require('mongoose');
const { Item, ItemData } = require('./ItemSchema');

const rodSchema = new Schema({
	capabilities: {
		type: [String],
	},
	requirements: {
		level: {
			type: Number,
			default: 0,
		},
	},
	obtained: {
		type: Number,
	},
	fishCaught: {
		type: Number,
		default: 0,
	},
	state: {
		type: String,
		enum: ['mint', 'repaired', 'broken', 'destroyed'],
		default: 'mint',
	},
	durability: {
		type: Number,
		default: 1000,
	},
	maxDurability: {
		type: Number,
		default: 1000,
	},
	repairs: {
		type: Number,
		default: 0,
	},
	maxRepairs: {
		type: Number,
		default: 3,
	},
	repairCost: {
		type: Number,
		default: 1000,
	},
	icon: {
		animated: {
			type: Boolean,
			default: false,
		},
		data: {
			type: String,
			default: 'old_rod',
		},
	},
	weights: {
		common: {
			type: Number,
			default: 7000,
		},
		uncommon: {
			type: Number,
			default: 2500,
		},
		rare: {
			type: Number,
			default: 500,
		},
		ultra: {
			type: Number,
			default: 100,
		},
		giant: {
			type: Number,
			default: 50,
		},
		legendary: {
			type: Number,
			default: 20,
		},
		lucky: {
			type: Number,
			default: 1,
		},
	},
	type: {
		type: String,
		default: 'rod',
	},
}, { timestamps: true });

const Rod = Item.discriminator('Rod', rodSchema);
const RodData = ItemData.discriminator('RodData', rodSchema);
module.exports = { Rod, RodData };
