const { FishData } = require('../schemas/FishSchema');
const { Habitat } = require('../schemas/HabitatSchema');
const { PetFish } = require('../schemas/PetSchema');
const { User } = require('../schemas/UserSchema');
const { Utils } = require('../class/Utils');
const { rng } = require('../engine/rng');

class Pet {
	constructor(data) {
		this.pet = new PetFish(data);
	}

	save() {
		return PetFish.findOneAndUpdate({ _id: this.pet._id }, this.pet, { upsert: true });
	}

	async getId() {
		return this.pet._id;
	}

	async getFishData() {
		return await FishData.findById(this.pet.fish);
	}

	async getBiome() {
		const fish = await this.getFishData();
		return fish.biome;
	}

	async getName() {
		return this.pet.name;
	}

	async getSpecies() {
		return this.pet.species;
	}

	async getAdoptionDate() {
		return this.pet.adoptTime;
	}

	async getAge() {
		return this.pet.age;
	}

	async getOwner() {
		return this.pet.owner;
	}

	async getHunger() {
		return this.pet.hunger;
	}

	async getMood() {
		return this.pet.mood;
	}

	async getStress() {
		return this.pet.stress;
	}

	async getHealth() {
		return this.pet.health;
	}

	async getXP() {
		return this.pet.xp;
	}

	async getTraits() {
		return this.pet.traits;
	}

	async getTraitNames() {
		const traits = await this.getTraits();
		return Object.keys(traits).map(trait => traits[trait].trait);
	}

	async getUnlockedTraits() {
		const traits = await this.getTraits();
		return Object.keys(traits).filter(trait => traits[trait].unlocked);
	}

	async getUnlockedTraitNames() {
		const traits = await this.getTraits();
		const unlockedTraitNames = Object.keys(traits).filter(trait => traits[trait].unlocked).map(trait => traits[trait].trait);
		return unlockedTraitNames.length !== 0 ? unlockedTraitNames : ['Still developing..'];
	}

	async getHabitat() {
		return await Habitat.findById(this.pet.aquarium);
	}

	async getLastFed() {
		return this.pet.lastFed;
	}

	async getLastPlayed() {
		return this.pet.lastPlayed;
	}

	async getLastBred() {
		return this.pet.lastBred;
	}

	async getLastUpdated() {
		return this.pet.lastUpdated;
	}

	async updateName(name) {
		this.pet.name = name;
		return this.save();
	}

	async updateStatus(aquarium) {
		if ((await this.getTraits()).length <= 1) {
			await this.generateTraits();
		}

		const cleanliness = await aquarium.getCleanliness();
		const temperature = await aquarium.getTemperature();

		const now = Date.now();
		const elapsedTimeSinceAdoption = (now - await this.getAdoptionDate()) / 86_400_000;
		const elapsedTimeSinceFed = (now - await this.getLastFed()) / 60_000;
		const elapsedTimeSincePlayed = (now - await this.getLastPlayed()) / 60_000;
		const elapsedTimeSinceSeen = (now - await this.getLastUpdated()) / (60_000 * 120);

		await this.tryUnlockTraits();

		const newAge = 1 + Math.floor(elapsedTimeSinceAdoption);
		const newHunger = await this.calculateHunger(elapsedTimeSinceFed, cleanliness, temperature);
		const newMood = await this.calculateMood(elapsedTimeSincePlayed, cleanliness, temperature);
		const newStress = await this.calculateStress(elapsedTimeSinceSeen, elapsedTimeSincePlayed, elapsedTimeSinceFed, cleanliness, temperature);
		const newHealth = await this.updateHealth(cleanliness, temperature);
		const multiplier = await this.calculateMultiplier();
		const attraction = await this.calculateAttraction();

		const traits = await this.getTraits();

		if (newAge > this.pet.age && traits.geneticDrift.trait === 'Unstable' && traits.geneticDrift.unlocked) {
			await this.regenerateTrait();
		}

		this.pet.age = newAge;
		this.pet.hunger = newHunger;
		this.pet.mood = newMood;
		this.pet.stress = newStress;
		this.pet.multiplier = multiplier;
		this.pet.health = newHealth;
		this.pet.attraction = attraction;
		this.pet.lastUpdated = now;
		return this.save();
	}

	async calculateHunger(elapsedTimeSinceFed, cleanliness, temperature) {
		// Hunger should be at 100% after 12 hours (720 minutes)
		const baseHungerIncreasePerMinute = 100 / 720;

		// Calculate the total base hunger increase over the elapsed time
		const baseHungerIncrease = elapsedTimeSinceFed * baseHungerIncreasePerMinute;

		// Calculate the cleanliness factor (low cleanliness increases hunger)
		const cleanlinessFactor = 1 + ((100 - cleanliness) / 100);

		// Calculate the temperature factor (deviation from 25°C increases hunger)
		const temperatureFactor = 1 + (Math.abs(temperature - 25) / 25);

		// Retrieve traits
		const traits = await this.getTraits();

		// Define trait multipliers
		const hungerTraits = ['Big Eater', 'Light Eater', 'Normal Eater'];
		const hungerTraitFactors = [1.5, 0.5, 1];
		const sizeTraits = ['Extra Small', 'Small', 'Medium', 'Large', 'Extra Large'];
		const sizeTraitFactors = [0.5, 0.75, 1, 1.25, 1.5];

		let hungerIncrease = baseHungerIncrease;

		// Apply hunger trait factor
		const hungerTraitIndex = hungerTraits.indexOf(traits.hunger.trait);
		if (hungerTraitIndex !== -1 && traits.hunger.unlocked) {
			hungerIncrease *= hungerTraitFactors[hungerTraitIndex];
		}

		// Apply size trait factor
		const sizeTraitIndex = sizeTraits.indexOf(traits.size.trait);
		if (sizeTraitIndex !== -1 && traits.size.unlocked) {
			hungerIncrease *= sizeTraitFactors[sizeTraitIndex];
		}

		// Apply cleanliness and temperature factors
		if (!traits.geneticDrift.trait === 'Adaptive' && traits.geneticDrift.unlocked) {
			hungerIncrease *= cleanlinessFactor * temperatureFactor;
		}

		// Ensure the final hunger increase is within the range 0 to 100
		return Math.floor(Math.min(Math.max(hungerIncrease, 0), 100));
	}

	async calculateMood(elapsedTimeSincePlayed, cleanliness, temperature) {
		// Mood decreases and should be at 0 after 6 hours (360 minutes).
		const baseMoodDecreasePerMinute = 100 / 360;
		const baseMoodDecrease = elapsedTimeSincePlayed * baseMoodDecreasePerMinute;

		const cleanlinessFactor = cleanliness / 100;

		// Calculate the temperature factor (deviation from 0 negatively impacts mood)
		const temperatureDeviation = Math.abs(temperature);
		const temperatureFactor = 1 - (temperatureDeviation / 100);

		const traits = await this.getTraits();
		const moodTraits = ['Aggressive', 'Calm', 'Friendly', 'Timid', 'Curious'];
		const moodTraitFactors = [0.7, 1, 1.3, 0.9, 1.1];

		let moodDecrease = baseMoodDecrease;

		// Apply cleanliness and temperature factors
		if (!traits.geneticDrift.trait === 'Adaptive' && traits.geneticDrift.unlocked) {
			moodDecrease *= cleanlinessFactor * temperatureFactor;
		}

		// Adjust mood based on self-traits
		if (moodTraits.includes(traits.mood.trait) && traits.mood.unlocked) {
			const traitIndex = moodTraits.indexOf(traits.mood.trait);
			moodDecrease *= moodTraitFactors[traitIndex];
		}

		// Adjust mood based on other fish in the same habitat
		// Aggressive fish should negatively impact the mood of other fish
		// Friendly fish should positively impact the mood of other fish
		const aquarium = await this.getHabitat();
		let otherFish = aquarium.fish.filter(fish => fish.id !== this.pet.id);
		otherFish = await Promise.all(otherFish.map(async (fishId) => await PetFish.findById(fishId)));

		// Adjust mood based on other fish
		for (const fish of otherFish) {
			if (fish.traits.mood.unlocked) {
				if (fish.traits.mood.trait === 'Aggressive') {
					moodDecrease *= 1.1;
				}
				else if (fish.traits.mood.trait === 'Friendly') {
					moodDecrease *= 0.9;
				}
			}
		}

		return Math.floor(Math.max(Math.min(100 - moodDecrease, 100), 0));
	}

	async calculateStress(elapsedTimeSinceSeen, elapsedTimeSincePlayed, elapsedTimeSinceFed, cleanliness, temperature) {
		// Stress increases and should be at 100 after 24 hours.
		const baseStressIncreasePerMinute = 100 / 1440;

		const stressOverTime = (elapsedTimeSinceSeen + elapsedTimeSincePlayed + elapsedTimeSinceFed) / 3;

		const baseStressIncrease = stressOverTime * baseStressIncreasePerMinute;

		const cleanlinessFactor = cleanliness / 100;

		const temperatureDeviation = Math.abs(temperature);
		const temperatureFactor = 1 + (temperatureDeviation / 100);

		const traits = await this.getTraits();
		const stressTraits = ['Aggressive', 'Timid'];
		const stressTraitFactors = [1.3, 1.1];

		let stressIncrease = baseStressIncrease;

		// Apply cleanliness and temperature factors
		if (!traits.geneticDrift.trait === 'Adaptive' && traits.geneticDrift.unlocked) {
			stressIncrease *= cleanlinessFactor * temperatureFactor;
		}

		// Adjust mood based on self-traits
		if (stressTraits.includes(traits.mood.trait) && traits.mood.unlocked) {
			const traitIndex = stressTraits.indexOf(traits.mood.trait);
			stressIncrease *= stressTraitFactors[traitIndex];
		}

		// Adjust mood based on other fish in the same habitat
		// Aggressive fish should negatively impact the mood of other fish
		// Friendly fish should positively impact the mood of other fish
		const aquarium = await this.getHabitat();
		let otherFish = aquarium.fish.filter(fish => fish.id !== this.pet.id);
		otherFish = await Promise.all(otherFish.map(async (fishId) => await PetFish.findById(fishId)));

		// Adjust mood based on other fish
		for (const fish of otherFish) {
			if (fish.traits.mood.unlocked) {
				if (fish.traits.mood.trait === 'Aggressive') {
					stressIncrease *= 1.3;
				}
				else if (fish.traits.mood.trait === 'Timid') {
					stressIncrease *= 1.1;
				}
			}
		}

		return Math.floor(Math.max(Math.min(0 + stressIncrease, 100), 0));
	}

	async calculateMultiplier() {
		const traits = await this.getTraits();
		const finSize = traits.finSize.trait;
		const finShape = traits.finShape.trait;
		const color = traits.color.trait;

		let multiplier = 1;

		// Fin Size Traits:
		// Long Fins: Greatly improves XP gain.
		// Short Fins: Normal XP gain.
		if (finSize === 'Long Fins') {
			multiplier += 0.2;
		}

		// Fin Shape Traits
		// Rounded Fins: Normal XP gain.
		// Pointed Fins: Increases XP gain slightly.
		// Frilly Fins: Increases XP gain slightly.
		if (finShape === 'Pointed Fins') {
			multiplier += 0.1;
		}
		else if (finShape === 'Frilly Fins') {
			multiplier += 0.1;
		}

		// Color Traits:
		// Normal: No effect on XP.
		// Golden: Increases XP slightly.
		// Platinum: Increases XP moderately.
		// Diamond: Increases XP significantly.
		// Rainbow: Increases XP greatly.
		// Striped: No effect on XP.
		// Spotted: No effect on XP.
		if (color === 'Golden') {
			multiplier += 0.1;
		}
		else if (color === 'Platinum') {
			multiplier += 0.2;
		}
		else if (color === 'Diamond') {
			multiplier += 0.3;
		}
		else if (color === 'Rainbow') {
			multiplier += 0.4;
		}

		return multiplier;
	}

	async calculateAttraction() {
		const traits = await this.getTraits();
		const color = traits.color.unlocked ? traits.color.trait : 'Locked';
		const finShape = traits.finShape.unlocked ? traits.finShape.trait : 'Locked';

		let attraction = 0;

		// Fin Shape Traits
		// Rounded Fins: Normal XP gain.
		// Pointed Fins: Increases XP gain slightly.
		// Frilly Fins: Increases attraction slightly.
		if (finShape === 'Frilly Fins') {
			attraction += 5;
		}

		// Color Traits:
		// Normal: No effect on attraction.
		// Golden: Increases attraction slightly.
		// Platinum: Increases attraction moderately.
		// Diamond: Increases attraction significantly.
		// Rainbow: Increases attraction greatly.
		// Striped: Increases attraction slightly.
		// Spotted: Increases attraction slightly.
		if (color === 'Golden') {
			attraction += 5;
		}
		else if (color === 'Platinum') {
			attraction += 10;
		}
		else if (color === 'Diamond') {
			attraction += 15;
		}
		else if (color === 'Rainbow') {
			attraction += 20;
		}
		else if (color === 'Striped') {
			attraction += 5;
		}
		else if (color === 'Spotted') {
			attraction += 5;
		}

		return attraction;
	}

	async updateHabitat(habitatId) {
		this.pet.habitat = habitatId;
		return this.save();
	}

	async updateHealth(cleanliness, temperature) {
		const cleanlinessFactor = cleanliness / 100;
		const temperatureDeviation = Math.abs(temperature);
		const temperatureFactor = temperatureDeviation > 0 ? 1 - (temperatureDeviation / 100) : 1;

		// Health Traits:
		// Sickly: Health decreases faster.
		// Healthy: No effect.
		// Robust: Health decreases slower.
		// max 100, min 0

		const traits = await this.getTraits();
		const healthTraits = ['Sickly', 'Healthy', 'Robust'];
		const healthTraitFactors = [0.8, 1, 1.2];
		let health = 100;

		for (let i = 0; i < healthTraits.length; i++) {
			if (traits.health.trait === healthTraits[i] && traits.health.unlocked) {
				health *= healthTraitFactors[i];
			}
		}

		let finalHealth = health;

		if (cleanlinessFactor < 1) {
			finalHealth *= cleanlinessFactor;
		}

		if (temperatureDeviation > 0) {
			finalHealth *= temperatureFactor;
		}

		return Math.floor(Math.max(Math.min(finalHealth, 100), 0));
	}


	async feed() {
		const currentTime = Date.now();
		this.pet.lastFed = currentTime;

		// Retrieve traits
		const traits = await this.getTraits();

		// Define trait multipliers
		const hungerTraits = ['Big Eater', 'Light Eater', 'Normal Eater'];
		const hungerTraitFactors = [0.75, 1.5, 1];

		// Determine the hunger reduction factor based on the trait
		const hungerTraitIndex = hungerTraits.indexOf(traits.hunger.trait);
		let hungerReduction = 50;

		if (hungerTraitIndex !== -1) {
			hungerReduction *= hungerTraitFactors[hungerTraitIndex];
		}

		// Update hunger, max 100, min 0
		this.pet.hunger = Math.floor(Math.max(Math.min(this.pet.hunger - hungerReduction, 100), 0));

		// Calculate XP increase based on pet multiplier
		const xpIncrease = 50 * (this.pet.multiplier || 1);
		this.pet.xp += xpIncrease;

		return this.save();
	}


	async play() {
		const currentTime = Date.now();
		this.pet.lastPlayed = currentTime;

		this.pet.mood = Math.max(Math.min(this.pet.mood + 30, 100), 0);

		const xpIncrease = 50 * (this.pet.multiplier || 1);
		this.pet.xp += xpIncrease;
		return this.save();
	}

	async disown() {
		this.pet.owner = '';
		return this.save();
	}

	async removeFromHabitat() {
		this.pet.aquarium = null;
		return this.save();
	}

	async sell(aquarium) {
		const user = await User.findOne({ userId: await this.getOwner() });
		const amount = await this.getXP() * this.pet.attraction;
		user.inventory.money += amount;
		await user.save();

		await this.removeFromHabitat();
		await aquarium.removeFish(await this.getId());
		await this.disown();
		return amount;
	}

	async updateBreeding(success) {
		let xp = 250;
		if (!success) xp = 25;
		const currentTime = Date.now();
		this.pet.lastBred = currentTime;
		this.pet.xp += (xp * (this.pet.multiplier || 1));
		return this.save();
	}

	async tryUnlockTraits() {
		const traits = await this.getTraits();
		const age = await this.getAge();

		if (age >= 3) {
			traits.mood.unlocked = true;
			traits.hunger.unlocked = true;
			traits.health.unlocked = true;
		}
		if (age >= 7) {
			traits.size.unlocked = true;
			traits.finSize.unlocked = true;
			traits.finShape.unlocked = true;
		}
		if (age >= 14) {
			traits.color.unlocked = true;
		}
		if (age >= 20) {
			traits.geneticDrift.unlocked = true;
		}

		return this.save();
	}

	async regenerateTrait() {
		const traits = await this.getTraits();
		const traitKeys = Object.keys(traits);
		const trait = traitKeys[Math.floor(rng.random() * traitKeys.length)];
		await this.generateTraits(trait);
		return;
	}

	async generateTraits(t = null) {
		// Mood Traits:
		// Aggressive: Negatively impacts stress of other fish in the same habitat.
		// Calm: No effect.
		// Friendly: Positively impacts mood of other fish in the same habitat.
		// Timid: Negatively impacts stress of self.
		// Curious: Positively impacts mood of self.
		const moodTraits = ['Aggressive', 'Calm', 'Friendly', 'Timid', 'Curious', 'Playful'];
		const moodWeights = [10, 10, 10, 10, 10, 10];

		// Hunger Traits:
		// Big Eater: Hunger increases faster.
		// Light Eater: Hunger increases slower.
		// Normal Eater: No effect.
		const hungerTraits = ['Big Eater', 'Light Eater', 'Normal Eater'];
		const hungerWeights = [10, 10, 10];

		// Size Traits:
		// Extra Small: Hunger increases much slower.
		// Small: Hunger increases slightly slower.
		// Medium: No effect.
		// Large: Hunger increases slightly faster.
		// Extra Large: Hunger increases much faster.
		const sizeTraits = ['Extra Small', 'Small', 'Medium', 'Large', 'Extra Large'];
		const sizeWeights = [5, 7, 10, 7, 5];

		// Health Traits:
		// Sickly: Health decreases faster.
		// Healthy: No effect.
		// Robust: Health decreases slower.
		const healthTraits = ['Sickly', 'Healthy', 'Robust'];
		const healthWeights = [3, 10, 3];

		// Fin Size Traits:
		// Long Fins: Greatly improves XP gain.
		// Short Fins: Normal XP gain.
		const finSizeTraits = ['Long Fins', 'Short Fins'];
		const finSizeWeights = [10, 10];

		// Fin Shape Traits
		// Rounded Fins: Normal XP gain.
		// Pointed Fins: Increases XP gain slightly.
		// Frilly Fins: Increases attraction slightly.
		const finShapeTraits = ['Rounded Fins', 'Pointed Fins', 'Frilly Fins'];
		const finShapeWeights = [10, 5, 5];

		// Color Traits:
		// Normal: No effect on attraction or XP.
		// Golden: Increases attraction slightly, increases XP slightly.
		// Platinum: Increases attraction moderately, increases XP moderately.
		// Diamond: Increases attraction significantly, increases XP significantly.
		// Rainbow: Increases attraction greatly, increases XP greatly.
		// Striped: Increases attraction slightly.
		// Spotted: Increases attraction slightly.
		const colorTraits = ['Normal', 'Golden', 'Platinum', 'Diamond', 'Rainbow', 'Striped', 'Spotted'];
		const colorWeights = [10000, 5000, 2000, 1000, 50, 7500, 7500];

		// Genetic Drift Traits:
		// Stable: No effect.
		// Unstable: Traits may change over time.
		// Adaptive: Traits may change over time, but will adapt to the environment.
		const geneticDriftTraits = ['Stable', 'Unstable', 'Adaptive'];
		const geneticDriftWeights = [1000, 300, 300];

		const moodTrait = await Utils.getWeightedChoice(moodTraits, moodWeights);
		const hungerTrait = await Utils.getWeightedChoice(hungerTraits, hungerWeights);
		const sizeTrait = await Utils.getWeightedChoice(sizeTraits, sizeWeights);
		const healthTrait = await Utils.getWeightedChoice(healthTraits, healthWeights);
		const finSizeTrait = await Utils.getWeightedChoice(finSizeTraits, finSizeWeights);
		const finShapeTrait = await Utils.getWeightedChoice(finShapeTraits, finShapeWeights);
		const colorTrait = await Utils.getWeightedChoice(colorTraits, colorWeights);
		const geneticDriftTrait = await Utils.getWeightedChoice(geneticDriftTraits, geneticDriftWeights);

		const generatedTraits = {
			mood: { trait: moodTrait, unlocked: false },
			hunger: { trait: hungerTrait, unlocked: false },
			size: { trait: sizeTrait, unlocked: false },
			health: { trait: healthTrait, unlocked: false },
			finSize: { trait: finSizeTrait, unlocked: false },
			finShape: { trait: finShapeTrait, unlocked: false },
			color: { trait: colorTrait, unlocked: false },
			geneticDrift: { trait: geneticDriftTrait, unlocked: false },
		};

		let finalTraits = {};
		if (t !== null) {
			finalTraits = await this.getTraits();
			finalTraits[t] = generatedTraits[t];
		}
		else {
			finalTraits = generatedTraits;
		}

		this.pet.traits = finalTraits;
		return this.save();
	}

	static async breed(firstPet, secondPet, babyName, aquariumId) {
		if (await firstPet.getAge() < 20) return { success: false, child: null, reason: `${await firstPet.getName()} is underaged. The minimum requirement is 20 days.` };
		if (await secondPet.getAge() < 20) return { success: false, child: null, reason: `${await firstPet.getName()} is underaged. The minimum requirement is 20 days.` };
		if (await firstPet.getHealth() < 50) return { success: false, child: null, reason: `${await firstPet.getName()} is unhealthy. Health must be greater than 50%.` };
		if (await secondPet.getHealth() < 50) return { success: false, child: null, reason: `${await secondPet.getName()} is unhealthy. Health must be greater than 50%.` };
	
		let success = false;
	
		// Determine success of breeding
		const stress = (await firstPet.getStress() + await secondPet.getStress()) / 2;
		const health = (await firstPet.getHealth() + await secondPet.getHealth()) / 2;
	
		// Add a random factor to the success rate
		const successRate = Math.max(Math.min(0.65, (50 - stress) / 50), Math.max(Math.min(0.6, health / 100 - 0.5), 0.1));
		const randomFactor = rng.random() * 100;
		if (randomFactor < successRate) success = true;
		if (!success) return { success, reason: 'Unlucky. You can try improving the health of your pets and reducing their stress.' };
	
		// Generate a new pet with the same species as the parents
		const speciesOptions = [await firstPet.getFishData(), await secondPet.getFishData()];
		const species = speciesOptions[Math.floor(rng.random() * speciesOptions.length)];
	
		// Randomize traits
		const firstPetTraits = await firstPet.getTraits();
		const secondPetTraits = await secondPet.getTraits();
		const traitWeights = [1000, 1000, 300];
		const traitOptions = {
			mood: [firstPetTraits.mood.trait, secondPetTraits.mood.trait, 'Random'],
			hunger: [firstPetTraits.hunger.trait, secondPetTraits.hunger.trait, 'Random'],
			size: [firstPetTraits.size.trait, secondPetTraits.size.trait, 'Random'],
			health: [firstPetTraits.health.trait, secondPetTraits.health.trait, 'Random'],
			finSize: [firstPetTraits.finSize.trait, secondPetTraits.finSize.trait, 'Random'],
			finShape: [firstPetTraits.finShape.trait, secondPetTraits.finShape.trait, 'Random'],
			color: [firstPetTraits.color.trait, secondPetTraits.color.trait, 'Random'],
			geneticDrift: [firstPetTraits.geneticDrift.trait, secondPetTraits.geneticDrift.trait, 'Random'],
		};
	
		const newTraits = {
			mood: { trait: await Utils.getWeightedChoice(traitOptions.mood, traitWeights), unlocked: false },
			hunger: { trait: await Utils.getWeightedChoice(traitOptions.hunger, traitWeights), unlocked: false },
			size: { trait: await Utils.getWeightedChoice(traitOptions.size, traitWeights), unlocked: false },
			health: { trait: await Utils.getWeightedChoice(traitOptions.health, traitWeights), unlocked: false },
			finSize: { trait: await Utils.getWeightedChoice(traitOptions.finSize, traitWeights), unlocked: false },
			finShape: { trait: await Utils.getWeightedChoice(traitOptions.finShape, traitWeights), unlocked: false },
			color: { trait: await Utils.getWeightedChoice(traitOptions.color, traitWeights), unlocked: false },
			geneticDrift: { trait: await Utils.getWeightedChoice(traitOptions.geneticDrift, traitWeights), unlocked: false },
		};
	
		const newPet = new PetFish({
			name: babyName,
			fish: species.id,
			age: 1,
			owner: await firstPet.getOwner(),
			traits: newTraits,
			health: 100,
			mood: 100,
			hunger: 0,
			stress: 0,
			xp: 0,
			lastFed: Date.now(),
			lastPlayed: Date.now(),
			lastBred: Date.now(),
			lastUpdated: Date.now(),
			multiplier: 1.0,
			attraction: 0,
			aquarium: aquariumId,
			species: species.name,
		});
	
		await firstPet.updateBreeding();
		await secondPet.updateBreeding();
		await newPet.save();
		return { success: success, child: newPet, reason: '' };
	};
}

module.exports = { Pet };