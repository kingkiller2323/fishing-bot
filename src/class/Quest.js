const mongoose = require('mongoose');
const { Utils } = require('../class/Utils');
const { User } = require('../class/User');
const { Quest: QuestSchema, QuestData } = require('../schemas/QuestSchema');
const { Gacha } = require('../schemas/GachaSchema');
const { rng } = require('../engine/rng');
const { DAILY_MS, eligibleDailies, completedQuestTitles, expireStaleDailies } = require('../engine/questRules');

class Quest {
	constructor(data) {
		this.quest = new QuestData(data);
	}

	save() {
		return QuestData.findOneAndUpdate({ _id: this.quest._id }, this.quest, { upsert: true });
	}

	async getId() {
		return this.quest._id;
	}

	async getTitle() {
		return this.quest.title;
	}

	async getLevelRequirement() {
		return this.quest.requirements.level;
	}

	async getPrerequesites() {
		return this.quest.requirements.previous;
	}

	async clone(userId) {
		if (!userId) return null;
		try {
			const clonedObject = new Quest({
				...this.quest.toObject(),
				_id: new mongoose.Types.ObjectId(),
				user: userId,
				startDate: Date.now(),
				status: 'in_progress',
				__t: 'QuestData',
			});

			await clonedObject.save();
			return clonedObject;
		}
		catch (error) {
			Utils.log('Error cloning object: ' + error, 'err');
			throw error;
		}
	};

	async getProgressType() {
		return this.quest.progressType;
	}

	async getProgress() {
		return this.quest.progress;
	}

	async getMaxProgress() {
		return this.quest.progressMax;
	}

	async setProgress(progress) {
		this.quest.progress = progress;
		return this.save();
	}

	async getStatus() {
		return this.quest.status;
	}

	async setStatus(status) {
		this.quest.status = status;
		return this.save();
	}

	async getReward() {
		return this.quest.reward;
	}

	async getXP() {
		return this.quest.xp;
	}

	async getCash() {
		return this.quest.cash;
	}

	async end() {
		this.quest.status = 'completed';
		this.quest.endDate = Date.now();
		return this.save();
	}

	/**
	 * Issues a daily quest (step B: quests, today's model). Returns the new quest, `false` when the player
	 * already has a daily in progress or was given one less than 24 hours ago (stats.lastDailyQuest), or
	 * `null` when no daily is eligible. A daily left unfinished for 24 hours is expired first (failed, kept).
	 * The pool is computed once: daily templates within the gate level whose prerequisites are all completed;
	 * the pick is uniform over it (no recursive retries).
	 */
	static async generateDailyQuest(userId, now = Date.now()) {
		const user = new User(await User.get(userId));
		if (!user) throw new Error('User not found');
		await expireStaleDailies(userId, now);
		const stats = await user.getStats();

		const hasDailyQuest = (await user.getQuests()).some((q) => q.daily && q.status === 'in_progress');
		if (hasDailyQuest || now - (stats.lastDailyQuest || 0) < DAILY_MS) return false;

		const templates = await QuestSchema.find({ daily: true });
		const pool = eligibleDailies(templates, { gateLevel: await user.getGateLevel(), completed: await completedQuestTitles(userId) });
		if (pool.length === 0) return null;
		const originalQuest = pool[Math.floor(rng.random() * pool.length)];

		const quest = await Utils.clone(originalQuest);
		quest.status = 'in_progress';
		quest.user = userId;
		quest.startDate = now;
		quest.reward = [];
		quest.reward.push(await Gacha.findOne({ name: 'Daily Box' }));
		await quest.save();
		await user.addQuest(quest._id);

		stats.lastDailyQuest = now;
		await user.setStats(stats);
		return quest;
	};

	static async get(questId) {
		const quest = await QuestSchema.findById(questId);
		return quest;
	}
}

module.exports = { Quest };