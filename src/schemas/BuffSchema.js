const { Schema } = require('mongoose');
const { Item, ItemData } = require('./ItemSchema');

const buffSchema = new Schema({
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
	active: {
		type: Boolean,
		default: false,
	},
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
	length: {
		type: Number,
	},
	endTime: {
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
	user: {
		type: String,
	},
	type: {
		type: String,
		default: 'buff',
	},
}, { timestamps: true });

const Buff = Item.discriminator('Buff', buffSchema);
const BuffData = ItemData.discriminator('BuffData', buffSchema);
module.exports = { Buff, BuffData };
