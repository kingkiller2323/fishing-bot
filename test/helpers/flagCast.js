// Child-process runner for test/balance-5b-flag.test.js: plays a fixed, seeded sequence of casts (a
// normal player and a Founder) against a fresh in-memory DB and prints the results as JSON. The parent
// runs it under different BALANCE_5B values (config reads the flag once, at require time) and compares.
const { startDb, stopDb } = require('./db');
const { quiet } = require('./quiet');
const { seedGame, makeUser } = require('./fixtures');
const { addPoolFish, useTestRod, userDoc } = require('./castFixtures');
const { castLine, applyCastResult } = require('../../src/engine/cast');
const { rng } = require('../../src/engine/rng');
const balance = require('../../src/engine/balance');

// Values that differ between runs by construction (generated ids, wall-clock timestamps).
const VOLATILE = new Set(['_id', '__v', 'castId', 'createdAt', 'updatedAt', 'appliedAt']);
function normalise(v) {
	if (Array.isArray(v)) return v.map(normalise);
	if (v instanceof Date) return v.toISOString();
	if (v && typeof v === 'object' && typeof v.toHexString === 'function') return '<id>';
	if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !VOLATILE.has(k)).map(([k, x]) => [k, normalise(x)]));
	return typeof v === 'string' && /^[0-9a-f]{24}$/.test(v) ? '<id>' : v;
}

async function main() {
	quiet();
	await startDb();
	// The seeded catalog rolls today's weather: seed it too so every run starts from the same world.
	rng.seed(7);
	await seedGame();
	await addPoolFish([{ name: 'Pool Minnow', rarity: 'Common' }, { name: 'Pool Perch', rarity: 'Uncommon' }, { name: 'Pool Pike', rarity: 'Rare' }, { name: 'Pool Legend', rarity: 'Legendary' }]);
	const players = ['flag-normal', process.env.FOUNDER_IDS];
	for (const id of players) {
		await makeUser(id);
		await useTestRod(id, { capabilities: ['weak', '3'] });
	}
	const now = new Date('2026-09-01T12:00:00Z');
	const casts = [];
	for (let seed = 1; seed <= 25; seed++) {
		for (const id of players) {
			rng.seed(seed);
			const r = await castLine({ userId: id, now });
			if (r.ok !== false) await applyCastResult(r);
			casts.push(normalise(r));
		}
	}
	rng.reset();
	const users = [];
	for (const id of players) {
		const u = await userDoc(id);
		users.push(normalise({ xp: u.xp, publicXp: u.publicXp, level: u.level, money: u.money, stats: u.stats, pity: u.pity }));
	}
	await stopDb();
	process.stdout.write(JSON.stringify({ flag: balance.isBalance5b(), casts, users }));
}

main().catch((e) => {
	process.stderr.write(`${e.stack}\n`);
	process.exit(1);
});
