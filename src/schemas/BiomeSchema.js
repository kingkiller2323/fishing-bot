const { model, Schema } = require('mongoose');

const biomeSchema = new Schema({
	name: {
		type: String,
		required: true,
	},
	requirements: {
		type: [String],
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
	type: {
		type: String,
		default: 'biome',
	},
}, { timestamps: true });

const Biome = model('Biome', biomeSchema);
module.exports = { Biome };
