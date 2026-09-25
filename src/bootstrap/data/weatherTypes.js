// Static seed data. Moved from src/scripts/generateWeatherTypes.js; consumed by src/bootstrap/seed.js.
// Weather names are canonical Capitalized strings ("Sunny"), matching Season.commonWeatherTypes and Fish.weather.
module.exports = [
	{
		weather: 'Sunny',
		icon: {
			animated: true,
			data: 'SunAnimated:1304870451885117553',
		},
	},
	{
		weather: 'Rainy',
		icon: {
			animated: true,
			data: 'RainAnimated:1304870440010907648',
		},
	},
	{
		weather: 'Cloudy',
		icon: {
			animated: true,
			data: 'StormAnimated:1304870401033371722',
		},
	},
	{
		weather: 'Snowy',
		icon: {
			animated: true,
			data: 'SnowAnimated:1304870416443113572',
		},
	},
	{
		weather: 'Windy',
		icon: {
			animated: true,
			data: 'FallWindAnimated:1304870425645551746',
		},
	},
];
