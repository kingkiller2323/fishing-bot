const { Schema } = require('mongoose');
const { Item, ItemData } = require('./ItemSchema');

const CustomRodSchema = new Schema({
	type: {
		type: String,
		default: 'customrod',
	},
	rod: {
		type: Schema.Types.ObjectId,
		ref: 'ItemData',
		required: true,
	},
	reel: {
		type: Schema.Types.ObjectId,
		ref: 'ItemData',
		required: true,
	},
	hook: {
		type: Schema.Types.ObjectId,
		ref: 'ItemData',
		required: true,
	},
	handle: {
		type: Schema.Types.ObjectId,
		ref: 'ItemData',
		required: true,
	},
	capabilities: {
		type: [String],
		default: [],
	},
	requirements: {
		level: {
			type: Number,
			default: 0,
		},
	},
	obtained: {
		type: Date,
		default: Date.now,
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
}, { timestamps: true });

const CustomRod = Item.discriminator('CustomRod', CustomRodSchema);
const CustomRodData = ItemData.discriminator('CustomRodData', CustomRodSchema);
module.exports = { CustomRod, CustomRodData };
