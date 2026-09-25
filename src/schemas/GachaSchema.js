const { Schema } = require('mongoose');
const { Item, ItemData } = require('./ItemSchema');

const gachaSchema = new Schema({
	name: {
		type: String,
		required: true,
	},
	description: {
		type: String,
	},
	rarity: {
		type: String,
		default: 'Common',
	},
	opened: {
		type: Boolean,
		default: false,
	},
	capabilities: {
		type: [String],
	},
	items: {
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
	user: {
		type: String,
	},
	type: {
		type: String,
		default: 'gacha',
	},
}, { timestamps: true });

const Gacha = Item.discriminator('Gacha', gachaSchema);
const GachaData = ItemData.discriminator('GachaData', gachaSchema);
module.exports = { Gacha, GachaData };
