// Engine vs model parity for the 5B cast (Step D). For every rod of the standard ladder (and the Old Rod) in
// its home biome, samples real engine casts (castLine: decided, never written) with the weather and season
// drawn from the model's steady-state environment mix, and compares the per-cast means with the model's exact
// expectations: fish per cast, value per cast, XP per cast, durability per cast; the cooldown exactly.
// The 5B flag must be on and the caller's database seeded; uses its own player ids (stepd-parity-*).
const { castLine } = require('../../../src/engine/cast');
const { WeatherPattern } = require('../../../src/class/WeatherPattern');
const { Season } = require('../../../src/class/Season');
const { User: UserModel } = require('../../../src/schemas/UserSchema');
const rodOps = require('../../../src/engine/b5/rodOps');
const levels = require('../../../src/engine/levels');
const { need5b } = require('../../../src/engine/balance');
const { ENV } = require('../../economy/lib/catalog-model');
const R = require('../../economy/5b/rods');
const W = require('../../economy/5b/world');

/** Deterministic PRNG for the environment draw only (the engine keeps its own rng). */
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pickEnv(u) {
	let acc = 0;
	for (const e of ENV) {
		acc += e.p;
		if (u < acc) return e;
	}
	return ENV[ENV.length - 1];
}

/** The configurations compared: the Old Rod and each standard rod in its home biome, the Summit Rod also in the Mountain Stream. */
function configs() {
	// The Old Rod is unbreakable under 5B: it is never charged durability.
	const out = [{ key: 'old@Ocean', rod: null, biome: 'Ocean', model: { ...R.rodOutcome(R.oldRod(), 'Ocean'), durabilityPerCast: 0 } }];
	for (const t of [1, 2, 3, 4, 5, 6]) {
		const m = R.standardRod(t);
		out.push({ key: `t${t}@${m.homeBiome}`, rod: m.name, biome: m.homeBiome, model: R.rodOutcome(m, m.homeBiome) });
	}
	const summit = R.standardRod(6);
	out.push({ key: 't6@Mountain Stream', rod: summit.name, biome: 'Mountain Stream', model: { ...W.ladderOutcome(W.ladderSpecies(), { qualities: summit.qualities, stats: summit.stats, multiChance: summit.multiChance }), cooldownMs: R.rodOutcome(summit, 'Ocean').cooldownMs, durabilityPerCast: R.rodOutcome(summit, 'Ocean').durabilityPerCast } });
	return out;
}

const stat = () => ({ n: 0, sum: 0, sq: 0 });
const add = (s, x) => {
	s.n++;
	s.sum += x;
	s.sq += x * x;
};
const mean = (s) => s.sum / s.n;
const se = (s) => Math.sqrt(Math.max(0, s.sq / s.n - mean(s) ** 2) / s.n);

/**
 * @param {{ casts?: number, seed?: number, zMax?: number, onProgress?: (msg: string) => void }} opts
 * @returns {Promise<Array<{ key, casts, metrics: { [name]: { engine, model, se, z, pass } }, cooldown: { engine, model, pass }, pass }>>}
 */
async function runParity({ casts = 3000, seed = 5, zMax = 4.5, onProgress = () => undefined } = {}) {
	const userId = 'stepd-parity';
	const { makeUser } = require('../../../test/helpers/fixtures');
	await makeUser(userId);
	const top = 70;
	const xp = levels.CURVES['5b'].xpForLevel(top);
	const allPermits = Object.keys(need5b().permits.prices).map((biome) => ({ biome, source: 'purchased', acquiredAt: new Date(0), pricePaid: 0 }));
	await UserModel.updateOne({ userId }, { $set: { xp, publicXp: xp, level: top, levelFloor: top, publicLevelFloor: top, permits: allPermits, 'inventory.money': 1e9 } });

	const savedWeather = WeatherPattern.getCurrentWeather;
	const savedSeason = Season.getCurrentSeason;
	let env = ENV[0];
	WeatherPattern.getCurrentWeather = async () => ({ getWeather: async () => env.weather });
	Season.getCurrentSeason = async () => ({ season: env.season });
	const rand = mulberry32(seed);
	const out = [];
	try {
		const oldRodId = (await UserModel.collection.findOne({ userId })).inventory.equippedRod;
		for (const c of configs()) {
			let rodId = oldRodId;
			if (c.rod) {
				const bought = await rodOps.buyStandardRod(userId, c.rod, { equip: true });
				rodId = bought.ok ? bought.rodId : (await rodOps.ownedRods(await UserModel.collection.findOne({ userId }))).find((r) => r.name === c.rod)?._id;
				if (!rodId) throw new Error(`parity: cannot obtain ${c.rod}: ${bought.code}`);
			}
			await UserModel.collection.updateOne({ userId }, { $set: { 'inventory.equippedRod': typeof rodId === 'string' ? new (require('mongoose').Types.ObjectId)(rodId) : rodId, currentBiome: c.biome.toLowerCase() } });
			const s = { fishPerCast: stat(), valuePerCast: stat(), xpPerCast: stat(), durabilityPerCast: stat() };
			const cooldowns = new Set();
			const statuses = {};
			for (let i = 0; i < casts; i++) {
				env = pickEnv(rand());
				const r = await castLine({ userId, now: new Date('2026-10-01T12:00:00Z') });
				statuses[r.status] = (statuses[r.status] || 0) + 1;
				if (r.status !== 'ok') continue;
				add(s.fishPerCast, r.draws.draws);
				// value is per unit: a stack of n of one species sells for value x n.
				add(s.valuePerCast, r.catches.filter((x) => x.kind === 'fish').reduce((t, x) => t + (x.value || 0) * (x.count || 1), 0));
				add(s.xpPerCast, r.xp.catch);
				add(s.durabilityPerCast, r.rod.durabilityCost || 0);
				cooldowns.add(r.cooldownMs);
			}
			const metrics = {};
			for (const [k, st] of Object.entries(s)) {
				const model = c.model[k];
				const e = mean(st);
				const err = se(st);
				// A zero-variance metric (e.g. the Old Rod's one fish, no durability) must match exactly.
				const z = err > 0 ? (e - model) / err : (Math.abs(e - model) < 1e-9 ? 0 : Infinity);
				metrics[k] = { engine: +e.toFixed(4), model: +model.toFixed(4), se: +err.toFixed(4), z: +z.toFixed(2), pass: Math.abs(z) <= zMax };
			}
			const cooldown = { engine: [...cooldowns], model: c.model.cooldownMs, pass: cooldowns.size === 1 && cooldowns.has(c.model.cooldownMs) };
			const pass = statuses.ok === casts && cooldown.pass && Object.values(metrics).every((m) => m.pass);
			out.push({ key: c.key, casts, statuses, metrics, cooldown, pass });
			onProgress(`parity ${c.key}: ${pass ? 'ok' : 'MISMATCH'}`);
		}
	}
	finally {
		WeatherPattern.getCurrentWeather = savedWeather;
		Season.getCurrentSeason = savedSeason;
	}
	return out;
}

module.exports = { runParity, configs, mulberry32, pickEnv };
