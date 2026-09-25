// Static seed data. Moved from src/scripts/generateWeatherTypes.js; consumed by src/bootstrap/seed.js.
// Weather names are canonical Capitalized strings ("Sunny"), matching Season.commonWeatherTypes and Fish.weather.
module.exports = [
	{
		weather: 'Sunny',
		icon: {
			animated: true,
			data: 'SunAnimated',
		},
	},
	{
		weather: 'Rainy',
		icon: {
			animated: true,
			data: 'RainAnimated',
		},
	},
	{
		weather: 'Cloudy',
		icon: {
			animated: true,
			data: 'StormAnimated',
		},
	},
	{
		weather: 'Snowy',
		icon: {
			animated: true,
			data: 'SnowAnimated',
		},
	},
	{
		weather: 'Windy',
		icon: {
			animated: true,
			data: 'FallWindAnimated',
		},
	},
];
