const { default: mongoose } = require('mongoose');
const { Habitat } = require('../schemas/HabitatSchema');
const { PetFish } = require('../schemas/PetSchema');

const HOUR_MS = 3_600_000;
let transactionSupport = null;

class Aquarium {
	constructor(data) {
		this.aquarium = new Habitat(data);
	}

	save() {
		return Habitat.findOneAndUpdate({ _id: this.aquarium._id }, this.aquarium, { upsert: true });
	}

	async getId() {
		return this.aquarium._id;
	}

	async getName() {
		return this.aquarium.name;
	}

	async getWaterType() {
		return this.aquarium.waterType;
	}

	async getTemperature() {
		return this.aquarium.temperature;
	}

	async getCleanliness() {
		return Math.max(0, Math.min(100, this.aquarium.cleanliness));
	}

	async getInhabitants() {
		return this.aquarium.fish;
	}

	async getSize() {
		return this.aquarium.size;
	}

	async getOwner() {
		return this.aquarium.owner;
	}

	async getFish() {
		return this.aquarium.fish;
	}

	async getLastCleaned() {
		return this.aquarium.lastCleaned;
	}

	async getLastAdjusted() {
		return this.aquarium.lastAdjusted;
	}

	async isFull() {
		return this.aquarium.fish.length >= this.aquarium.size;
	}

	/** Applies targeted $set updates (never overwrites the fish list) and mirrors them locally. */
	async update(fields) {
		Object.assign(this.aquarium, fields);
		await Habitat.updateOne({ _id: this.aquarium._id }, { $set: fields });
		return this.aquarium;
	}

	/**
	 * Applies hourly decay since the last time it was applied: cleanliness -1/hour (floor 0),
	 * temperature +1/hour. The decay clocks advance by the whole hours consumed, so calling this
	 * repeatedly never re-applies the same elapsed time.
	 */
	async updateStatus(now = new Date()) {
		const cleanFrom = new Date(this.aquarium.cleanlinessUpdatedAt || this.aquarium.lastCleaned || now);
		const tempFrom = new Date(this.aquarium.temperatureUpdatedAt || this.aquarium.lastAdjusted || now);
		const cleanHours = Math.max(0, Math.floor((now - cleanFrom) / HOUR_MS));
		const tempHours = Math.max(0, Math.floor((now - tempFrom) / HOUR_MS));

		const fields = {};
		if (cleanHours > 0 || !this.aquarium.cleanlinessUpdatedAt) {
			fields.cleanliness = Math.max(0, this.aquarium.cleanliness - cleanHours);
			fields.cleanlinessUpdatedAt = new Date(cleanFrom.getTime() + cleanHours * HOUR_MS);
		}
		if (tempHours > 0 || !this.aquarium.temperatureUpdatedAt) {
			fields.temperature = this.aquarium.temperature + tempHours;
			fields.temperatureUpdatedAt = new Date(tempFrom.getTime() + tempHours * HOUR_MS);
		}
		if (Object.keys(fields).length > 0) await this.update(fields);
		return this.aquarium;
	}

	async addFish(fishId) {
		await Habitat.updateOne({ _id: this.aquarium._id }, { $addToSet: { fish: fishId } });
		if (!this.aquarium.fish.some((f) => String(f) === String(fishId))) this.aquarium.fish.push(fishId);
		return this.aquarium;
	}

	async removeFish(fishId) {
		await Habitat.updateOne({ _id: this.aquarium._id }, { $pull: { fish: fishId } });
		this.aquarium.fish = this.aquarium.fish.filter((f) => String(f) !== String(fishId));
		return this.aquarium;
	}

	async hasFish(fishId) {
		return this.aquarium.fish.some((f) => String(f) === String(fishId));
	}

	/**
	 * Moves a pet into this aquarium. The pet's `aquarium` field is the source of truth for where it
	 * lives; the aquariums' `fish` lists are kept consistent with it.
	 *
	 * With a transaction-capable MongoDB (replica set / sharded) all three writes commit atomically.
	 * Standalone MongoDB (Railway's default) cannot run transactions, so the writes are ordered and
	 * idempotent instead: the pet is re-pointed first, then Aquarium.reconcilePet() adds it here and
	 * pulls it from any other aquarium. If the process dies part-way, running reconcilePet again
	 * (it runs on every /aquarium view) finishes the move.
	 */
	async moveFish(pet, newAquarium = this) {
		const petId = await pet.getId();
		const targetId = await newAquarium.getId();

		if (await Aquarium.supportsTransactions()) {
			const session = await mongoose.startSession();
			try {
				await session.withTransaction(async () => {
					await PetFish.updateOne({ _id: petId }, { $set: { aquarium: targetId } }, { session });
					await Habitat.updateMany({ _id: { $ne: targetId }, fish: petId }, { $pull: { fish: petId } }, { session });
					await Habitat.updateOne({ _id: targetId }, { $addToSet: { fish: petId } }, { session });
				});
			}
			finally {
				await session.endSession();
			}
		}
		else {
			await PetFish.updateOne({ _id: petId }, { $set: { aquarium: targetId } });
			await Aquarium.reconcilePet(petId);
		}

		pet.pet.aquarium = targetId;
		if (!newAquarium.aquarium.fish.some((f) => String(f) === String(petId))) newAquarium.aquarium.fish.push(petId);
	}

	/** Makes aquarium membership match the pet's `aquarium` field. Idempotent. */
	static async reconcilePet(petId) {
		const pet = await PetFish.findById(petId).select('aquarium').lean();
		if (!pet) return;
		if (pet.aquarium) {
			await Habitat.updateOne({ _id: pet.aquarium }, { $addToSet: { fish: petId } });
			await Habitat.updateMany({ _id: { $ne: pet.aquarium }, fish: petId }, { $pull: { fish: petId } });
		}
		else {
			await Habitat.updateMany({ fish: petId }, { $pull: { fish: petId } });
		}
	}

	/** Repairs membership for every pet an owner has (recovers interrupted moves). */
	static async reconcileOwner(owner) {
		const pets = await PetFish.find({ owner }).select('_id').lean();
		for (const pet of pets) await Aquarium.reconcilePet(pet._id);
	}

	/** True when the connected MongoDB can run multi-document transactions. Cached per process. */
	static async supportsTransactions() {
		if (transactionSupport === null) {
			try {
				const hello = await mongoose.connection.db.admin().command({ hello: 1 });
				transactionSupport = Boolean(hello.setName) || hello.msg === 'isdbgrid';
			}
			catch {
				transactionSupport = false;
			}
		}
		return transactionSupport;
	}

	async upgrade(size) {
		return this.update({ size });
	}

	async clean(now = new Date()) {
		return this.update({ cleanliness: 100, lastCleaned: now, cleanlinessUpdatedAt: now });
	}

	async adjustTemperature(newTemperature, now = new Date()) {
		return this.update({ temperature: newTemperature, lastAdjusted: now, temperatureUpdatedAt: now });
	}

	async compareBiome(biome) {
		const biomeWaterType = {
			'Ocean': 'Saltwater',
			'Coast': 'Saltwater',
			'River': 'Freshwater',
			'Lake': 'Freshwater',
			'Pond': 'Freshwater',
			'Swamp': 'Freshwater',
		};

		const biomeType = biomeWaterType[biome];
		if (!biomeType) return false;
		const waterType = await this.getWaterType();

		return biomeType === waterType;
	}
}

module.exports = { Aquarium };