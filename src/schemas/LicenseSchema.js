const { Schema } = require('mongoose');
const { Item, ItemData } = require('./ItemSchema');

const LicenseSchema = new Schema({
	capabilities: {
		type: [String],
	},
	biomes: {
		type: [String],
	},
	requirements: {
		level: {
			type: Number,
			default: 0,
		},
	},
	obtained: {
		type: Date,
		default: Date.now(),
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
	aquarium: {
		waterType: {
			type: [String],
			default: ['freshwater'],
		},
		size: {
			type: Number,
			default: 1,
		},
	},
	type: {
		type: String,
		default: 'license',
	},
}, { timestamps: true });

const License = Item.discriminator('License', LicenseSchema);
const LicenseData = ItemData.discriminator('LicenseData', LicenseSchema);
module.exports = { License, LicenseData };
