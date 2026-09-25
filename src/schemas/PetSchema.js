const { model, Schema } = require('mongoose');

const PetSchema = new Schema({
	fish: {
		type: Schema.Types.ObjectId,
		ref: 'Fish',
		required: true,
	},
	aquarium: {
		type: Schema.Types.ObjectId,
		ref: 'Aquarium',
	},
	adoptTime: {
		type: Date,
		default: Date.now,
	},
	name: {
		type: String,
		required: true,
	},
	age: {
		type: Number,
		required: true,
	},
	owner: {
		type: String,
	},
	traits: {
		type: Object,
	},
	health: {
		type: Number,
		required: true,
	},
	mood: {
		type: Number,
		required: true,
	},
	hunger: {
		type: Number,
		required: true,
	},
	stress: {
		type: Number,
		required: true,
	},
	xp: {
		type: Number,
		required: true,
	},
	lastFed: {
		type: Date,
		required: true,
		default: Date.now,
	},
	lastPlayed: {
		type: Date,
		required: true,
		default: Date.now,
	},
	lastBred: {
		type: Date,
		required: true,
		default: Date.now,
	},
	lastUpdated: {
		type: Date,
		required: true,
		default: Date.now,
	},
	species: {
		type: String,
		required: true,
	},
	multiplier: {
		type: Number,
		required: true,
		default: 1.0,
	},
	attraction: {
		type: Number,
		required: true,
		default: 0,
	},
	type: {
		type: String,
		default: 'pet',
	},
}, { timestamps: true });


const PetFish = model('Pet', PetSchema);
module.exports = { PetFish };