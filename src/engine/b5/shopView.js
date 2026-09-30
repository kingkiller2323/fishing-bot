// The 5B shop as data (step C.6; P-SHOP-LAYOUT): one entry per tab, each built only when it has something
// valid for the player, so no empty tab is ever rendered. Pure: it reads the player's document, the rods
// they own and the 5B data. The UI (src/components/shop5b.js) renders it.
const { need5b } = require('../balance');
const { gateLevelOf } = require('../levelGate');
const world = require('./world');
const upgrades = require('./upgrades');

const money = (n) => `$${Math.round(n).toLocaleString()}`;
const pct = (x) => `${Math.round(x * 100)}%`;
const away = (price, cash) => (cash >= price ? 'affordable now' : `you are ${money(price - cash)} away`);

/** Rods tab: owned ✅, buyable 🛒, the next one previewed one stage early 🔒, later ones hidden. */
function rodsTab(level, cash, ownedNames) {
	const rows = [];
	let next = null;
	for (const r of need5b().rods.standard) {
		const owned = ownedNames.has(r.name);
		const preview = level >= r.unlockLevel - 10;
		if (!owned && !preview) continue;
		const status = owned ? 'owned' : (level >= r.unlockLevel ? 'buyable' : 'locked');
		rows.push({ name: r.name, price: r.price, unlockLevel: r.unlockLevel, meanFish: r.meanFish, stats: r.stats, status });
		if (!owned && !next) next = r;
	}
	const line = next ? `Next: ${next.name} at Lv ${next.unlockLevel} · ${away(next.price, cash)}` : 'You own every shop rod.';
	return { key: 'rods', title: 'Rods', rows, footer: line, buyable: rows.filter((r) => r.status === 'buyable').map((r) => ({ id: r.name, label: `${r.name} · ${money(r.price)}` })) };
}

/** Bait tab: packs valid at the player's level. */
function baitTab(level) {
	const { roster, packSize } = need5b().bait;
	const rows = Object.entries(roster).filter(([, b]) => level >= b.levelRequirement).map(([name, b]) => ({ name, packPrice: b.packPrice, packSize, biomes: b.biomes }));
	return rows.length ? { key: 'bait', title: 'Bait', rows, buyable: rows.map((r) => ({ id: r.name, label: `${r.name} · ${money(r.packPrice)} / ${packSize} casts` })) } : null;
}

/** Upgrades tab: from the first unlock level. */
function upgradesTab(level, cash, user) {
	if (level < need5b().upgrades.unlockLevels[0]) return null;
	const rows = Object.keys(need5b().upgrades.categories).map((key) => {
		const n = upgrades.nextLevel(user, key);
		const c = need5b().upgrades.categories[key];
		if (!n) return { key, name: c.name, current: need5b().upgrades.levels, max: true };
		return { key, name: c.name, current: n.current, next: n.next, price: n.price, unlockLevel: n.unlockLevel, effect: `+${pct(c.perLevel)} ${c.stat}`, unlocked: level >= n.unlockLevel, away: away(n.price, cash) };
	});
	const buyable = rows.filter((r) => !r.max && r.unlocked).map((r) => ({ id: r.key, label: `${r.name} L${r.current} → L${r.next} · ${money(r.price)}` }));
	return { key: 'upgrades', title: 'Upgrades', rows, buyable };
}

/** Supplies tab: permits due (level reached, not held) and the repair of a broken equipped rod. */
function suppliesTab(level, user, repair) {
	const permits = need5b().world.biomeOrder.filter((b) => world.biomeStatus(level, user.permits, b) === 'permit').map((b) => ({ biome: b, price: world.permitPrice(b) }));
	if (!permits.length && !repair) return null;
	const buyable = [...permits.map((p) => ({ id: `permit:${p.biome}`, label: `${p.biome} permit · ${money(p.price)}` })), ...(repair ? [{ id: 'repair', label: `Repair ${repair.name} · ${money(repair.cost)}` }] : [])];
	return { key: 'supplies', title: 'Supplies', rows: { permits, repair }, buyable };
}

/**
 * Every non-empty tab for a player. `ownedRodNames`: names of the rods they own; `repair`: { name, cost } when
 * the equipped rod is broken; `aquarium`: the aquarium tab (step C.10) or null.
 */
function shopTabs(user, { ownedRodNames = new Set(), repair = null, aquarium = null } = {}) {
	const level = gateLevelOf(user);
	const cash = user?.inventory?.money || 0;
	return [rodsTab(level, cash, ownedRodNames), baitTab(level), upgradesTab(level, cash, user), suppliesTab(level, user, repair), aquarium].filter(Boolean);
}

/** The Rod Workshop: tier crates from their unlock level, and whether crafting is open. */
function workshop(user) {
	const level = gateLevelOf(user);
	const { minLevel } = need5b().rods.custom;
	const crates = need5b().rods.crates.filter((c) => level >= c.shop.unlockLevel).map((c) => ({ name: c.name, tier: c.tier, price: c.price }));
	return { open: level >= minLevel, minLevel, level, crates, salvage: need5b().rods.salvage };
}

module.exports = { rodsTab, baitTab, upgradesTab, suppliesTab, shopTabs, workshop, money, away };
