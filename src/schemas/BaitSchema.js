const { Schema } = require('mongoose');
const { Item, ItemData } = require('./ItemSchema');

const baitSchema = new Schema({
	capabilities: {
		type: [String],
	},
	biomes: {
		type: [String],
	},
	multiplier: {
		type: Number,
		default: 1,
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
	count: {
		type: Number,
		default: 1,
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
		default: 'bait',
	},
}, { timestamps: true });

const Bait = Item.discriminator('Bait', baitSchema);
const BaitData = ItemData.discriminator('BaitData', baitSchema);
module.exports = { Bait, BaitData };
