const { model, Schema } = require('mongoose');

const UserSchema = new Schema ({
	userId: {
		type: String,
		required: true,
	},
	level: {
		type: Number,
		default: 1,
	},
	xp: {
		type: Number,
		default: 0,
	},
	commands: {
		type: Number,
		default: 0,
	},
	type: {
		type: String,
		default: 'user',
	},
	currentBiome: {
		type: String,
		default: 'ocean',
	},
	stats: {
		fishCaught: {
			type: Number,
			default: 0,
		},
		latestFish: [{
			type: Schema.Types.ObjectId,
			ref: 'Fish',
		}],
		soldLatestFish: {
			type: Boolean,
			default: false,
		},
		lastDailyQuest: {
			type: Number,
		},
		gachaBoxesOpened: {
			type: Number,
			default: 0,
		},
		lastVoted: {
			type: Date,
		},
		totalVotes: {
			type: Number,
			default: 0,
		},
		// Most recent sale, for the private /fishing-stats view (public output shows `base`).
		lastSale: {
			base: { type: Number },
			final: { type: Number },
			at: { type: Date },
		},
		fishStats: {
			type: Map,
			of: Number,
			default: {},
		},
	},
	inventory: {
		money: {
			type: Number,
			default: 0,
		},
		equippedRod: {
			type: Schema.Types.ObjectId,
			ref: 'Rod',
		},
		equippedBait: {
			type: Schema.Types.ObjectId,
			ref: 'Bait',
		},
		items: [{
			type: Schema.Types.ObjectId,
			ref: 'Item',
		}],
		baits: [{
			type: Schema.Types.ObjectId,
			ref: 'Bait',
		}],
		fish: [{
			type: Schema.Types.ObjectId,
			ref: 'Fish',
		}],
		rods: [{
			type: Schema.Types.ObjectId,
			ref: 'Rod',
		}],
		quests: [{
			type: Schema.Types.ObjectId,
			ref: 'Quest',
		}],
		buffs: [{
			type: Schema.Types.ObjectId,
			ref: 'Buff',
		}],
		gacha: [{
			type: Schema.Types.ObjectId,
			ref: 'Gacha',
		}],
		aquariums: [{
			type: Schema.Types.ObjectId,
			ref: 'Aquarium',
		}],
		codes: [{
			type: Schema.Types.ObjectId,
			ref: 'Code',
		}],
	},
	// Explicit pity counters, reset atomically when the qualifying result happens.
	pity: {
		castsSinceLegendary: { type: Number, default: 0 },
		castsSinceLucky: { type: Number, default: 0 },
		gachaSinceHighTier: { type: Number, default: 0 },
	},
	// Automatic protection of future catches. Individual protection is FishData.locked.
	// `species` is undefined on accounts created before this existed (see bootstrap migration).
	autoLock: {
		species: { type: [String], default: undefined },
		rules: { type: [Schema.Types.Mixed], default: undefined },
	},
	// Developer overrides (set only through /dev). `profile`: 'founder' | 'normal' | 'test' overrides
	// FOUNDER_IDS; `luck`: temporary extra Luck. Any active luck override makes catches non-competitive.
	devOverrides: {
		profile: { type: String, enum: ['founder', 'normal', 'test', null], default: undefined },
		luck: {
			value: { type: Number },
			expiresAt: { type: Date },
		},
	},
	// Cast journal guard: ids of casts already applied to this document (last few only).
	appliedCasts: {
		type: [String],
		default: undefined,
	},
	isAdmin: {
		type: Boolean,
		default: false,
	}
}, { timestamps: true });

const User = model('User', UserSchema, 'users');
module.exports = { User };