// Bait under the 5B rules (step C.4; P-BAIT-*): behaviour is read BY NAME from the 5B roster, never from the
// owned copy's cloned fields (P-BAIT-LEGACY-STACKS). A bait applies only in its biomes and only at or above
// its shop level (read by name: a legacy stack held below the level waits), and then gives its stats, its
// strong access (Shrimp and Worm only) and its extra-fish chance; otherwise it gives nothing, XP included,
// and is not consumed (P-BAIT-WHERE-IT-WORKS). One unit per cast, whatever the catch (P-BAIT-PER-CAST).
// A bait outside the roster keeps today's converter, with the same where-it-works rule.
const { need5b } = require('../balance');
const { baitStats } = require('../modifiers');

const roster = () => need5b().bait.roster;
const baitDef = (name) => roster()[name] || null;

/**
 * The bait as a 5B modifier source for a cast in `biome` (canonical name) by a player of `gateLevel`.
 * Returns null without a bait; `applied` false (with the reason) when it does not work here.
 */
function baitSource(bait, biome, gateLevel) {
	if (!bait) return null;
	const def = baitDef(bait.name);
	if (def) {
		const inBiome = def.biomes.includes(biome);
		const levelOk = gateLevel >= def.levelRequirement;
		const applied = inBiome && levelOk;
		return {
			id: String(bait._id), name: bait.name, known: true, applied,
			reason: applied ? null : (levelOk ? 'biome' : 'level'), requiredLevel: def.levelRequirement, biomes: [...def.biomes],
			stats: applied ? { ...def.stats, multiChance: def.multiChance || 0 } : {},
			qualities: applied && def.grantsStrong ? ['strong'] : [],
		};
	}
	const legacy = baitStats(bait);
	const applied = (bait.biomes || []).map((b) => String(b).toLowerCase()).includes(String(biome).toLowerCase());
	const stats = Object.fromEntries(Object.entries(legacy.stats).filter(([k]) => k !== 'perDraw' && k !== 'multiCatch'));
	return { id: String(bait._id), name: bait.name, known: false, applied, reason: applied ? null : 'biome', biomes: bait.biomes || [], stats: applied ? stats : {}, qualities: applied ? legacy.qualities : [] };
}

/** Units a cast uses: one when the bait worked, else none. */
const unitsUsed = (source) => (source?.applied ? need5b().bait.consumption.perCast : 0);

module.exports = { baitDef, baitSource, unitsUsed };
