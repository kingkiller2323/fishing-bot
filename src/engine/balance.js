// Versioned balance definitions and player profiles.
//
// Every cast records BALANCE_VERSION and the profile it ran under, so historical catches always
// say which rule set produced them. Change BALANCE_VERSION whenever odds, rewards or modifiers
// change. Profile multipliers live here, never in engine code.
const config = require('../config');

const BALANCE_VERSION = '2.0.0';

// Phase 2: normal-player numbers are the legacy ones (odds come from rod/bait weights).
const BASE = {
	xpPerFish: { min: 10, max: 25 },
};

const PROFILES = {
	normal: {
		competitiveEligible: true,
		multipliers: { xp: 1, cash: 1, questXp: 1, questCash: 1 },
	},
	// Founder identity exists now so catches are stamped non-competitive from day one.
	// Founder tuning (odds, multipliers, pity) is Phase 3; until then it plays like normal.
	founder: {
		competitiveEligible: false,
		multipliers: { xp: 1, cash: 1, questXp: 1, questCash: 1 },
	},
};

/** Level curve: floor(0.1 * sqrt(xp)), minimum 1. */
function levelForXp(xp) {
	return Math.max(Math.floor(0.1 * Math.sqrt(Math.max(0, xp || 0))), 1);
}

/** The profile a player casts under. FOUNDER_IDS decides Founder; DEVELOPER_IDS does not. */
function resolveProfile(userId, cfg = config) {
	const founders = cfg.users?.founders || [];
	const name = founders.includes(String(userId)) ? 'founder' : 'normal';
	return { name, ...PROFILES[name] };
}

module.exports = { BALANCE_VERSION, BASE, PROFILES, resolveProfile, levelForXp };
