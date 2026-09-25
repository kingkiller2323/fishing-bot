// Static seed data. Moved from src/events/Client/ready.js; consumed by src/bootstrap/seed.js.
// `active` is not seeded here: the bootstrap marks exactly one season active based on today's date.
module.exports = [
	{
		season: 'Spring',
		icon: {
			animated: false,
			data: 'Spring:1304870493882548304',
		},
		startMonth: 'March',
		startDay: '20',
		endMonth: 'June',
		endDay: '21',
		commonWeatherTypes: ['Rainy', 'Cloudy'],
	},
	{
		season: 'Summer',
		icon: {
			animated: false,
			data: 'Summer:1304870481987637402',
		},
		startMonth: 'June',
		startDay: '21',
		endMonth: 'September',
		endDay: '22',
		commonWeatherTypes: ['Sunny', 'Windy'],
	},
	{
		season: 'Fall',
		icon: {
			animated: false,
			data: 'Fall:1304870471430570174',
		},
		startMonth: 'September',
		startDay: '22',
		endMonth: 'December',
		endDay: '1',
		commonWeatherTypes: ['Rainy', 'Cloudy'],
	},
	{
		season: 'Winter',
		icon: {
			animated: false,
			data: 'Winter:1304870462441918504',
		},
		startMonth: 'December',
		startDay: '1',
		endMonth: 'March',
		endDay: '20',
		commonWeatherTypes: ['Snowy', 'Cloudy'],
	},
];
