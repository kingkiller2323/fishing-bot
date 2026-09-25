const { model, Schema } = require('mongoose');

const seasonSchema = new Schema({
	season: {
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
		default: 'season',
	},
	active: {
		type: Boolean,
		default: false,
	},
	startMonth: {
		type: String,
		required: true,
	},
	startDay: {
		type: String,
		required: true,
	},
	endMonth: {
		type: String,
		required: true,
	},
	endDay: {
		type: String,
		required: true,
	},
	commonWeatherTypes: {
		type: Array,
		default: [],
	}
}, { timestamps: true });

const Season = model('Season', seasonSchema);
module.exports = { Season };
