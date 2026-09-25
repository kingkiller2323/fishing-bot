const { model, Schema } = require('mongoose');

const weatherSchema = new Schema({
	weather: {
		type: String,
		required: true,
	},
	dateStart: {
		type: Date,
		required: true,
	},
	dateEnd: {
		type: Date,
		required: true,
	},
	active: {
		type: Boolean,
		default: false,
	},
	nextWeatherPattern: {
		type: Schema.Types.ObjectId,
		ref: 'WeatherPattern',
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

const WeatherPattern = model('WeatherPattern', weatherSchema);
module.exports = { WeatherPattern };
