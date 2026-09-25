const { model, Schema } = require('mongoose');

const weatherSchema = new Schema({
	weather: {
		type: String,
		required: true,
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
		default: 'weather',
	},
}, { timestamps: true });

const WeatherType = model('WeatherType', weatherSchema);
module.exports = { WeatherType };
