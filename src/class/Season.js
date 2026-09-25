const { WeatherType } = require("../schemas/WeatherTypeSchema");
const { Season: SeasonSchema } = require("../schemas/SeasonSchema");
const { rng } = require('../engine/rng');

class Season {
	static async getCurrentSeason() {
		const currentSeason = await SeasonSchema.findOne({ active: true });
		return currentSeason;
	}

	static async getSeasonalWeather(season) {
		// Fetch all available weather types
		const weatherTypes = await WeatherType.find({ type: 'weather' });
	
		// Separate weather types associated with the season and those that aren't
		const seasonWeatherTypes = season.commonWeatherTypes;
		const associatedWeatherTypes = weatherTypes.filter(weatherType =>
			seasonWeatherTypes.includes(weatherType.weather)
		);
		const otherWeatherTypes = weatherTypes.filter(weatherType =>
			!seasonWeatherTypes.includes(weatherType.weather)
		);
	
		// Create a weighted list to increase the probability of seasonal weather types
		const weightedWeather = [];
	
		// Increase the weight of seasonal weather types
		for (let weather of associatedWeatherTypes) {
			weightedWeather.push(weather, weather, weather, weather, weather);
		}
	
		// Add non-seasonal weather types with lower weight
		for (let weather of otherWeatherTypes) {
			weightedWeather.push(weather);
		}
	
		// Randomly select a weather type from the weighted list
		const randomWeather = weightedWeather[Math.floor(rng.random() * weightedWeather.length)];
	
		return randomWeather;
	}

	static async updateCurrentSeason() {
		const today = new Date();
		const currentYear = today.getFullYear();
		const currentMonth = today.getMonth();
		const currentDay = today.getDate();
	
		const getAdjustedDate = (month, day, adjustYear = 0) => {
			const date = new Date(`${month} ${day}, ${currentYear + adjustYear}`);
			return date;
		};
	
		const isDateInSeason = (season) => {
			let startDate = getAdjustedDate(season.startMonth, season.startDay);
			let endDate = getAdjustedDate(season.endMonth, season.endDay);
	
			// Handle Winter's year transition
			if (season.season === 'Winter') {
				if (currentMonth < 2) { // Jan-Feb
					startDate = getAdjustedDate(season.startMonth, season.startDay, -1);
					endDate = getAdjustedDate(season.endMonth, season.endDay, 0);
				} else if (currentMonth === 11) { // December
					startDate = getAdjustedDate(season.startMonth, season.startDay, 0);
					endDate = getAdjustedDate(season.endMonth, season.endDay, 1);
				}
			}
	
			return today >= startDate && today < endDate;
		};
	
		const seasons = await SeasonSchema.find();
		const currentSeason = seasons.find(isDateInSeason);
	
		if (!currentSeason) return;
	
		const activeSeason = await SeasonSchema.findOne({ active: true });
	
		if (!activeSeason || activeSeason.season !== currentSeason.season) {
			if (activeSeason) {
				activeSeason.active = false;
				await activeSeason.save();
			}
	
			let newSeason = await SeasonSchema.findOne({ season: currentSeason.season });
			if (!newSeason) {
				newSeason = new SeasonSchema({ ...currentSeason, active: true });
			} else {
				newSeason.active = true;
			}
			await newSeason.save();
			console.log(`Season updated to ${newSeason.season}`);
		}
	}
}

module.exports = { Season };
