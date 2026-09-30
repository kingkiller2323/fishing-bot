// The 5B /shop (step C.6; P-SHOP-LAYOUT): category tabs (Rods, Bait, Upgrades, Supplies, Aquarium), empty tabs
// hidden, one select per tab, "you are $X away" lines, and the Rod Workshop (tier crates, salvage; crafting is
// /craft). Every reply is ephemeral and every collector answers only the invoker. Purchases go through the 5B
// engine operations (guarded debits under the player's lock).
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, MessageFlags } = require('discord.js');
const mongoose = require('mongoose');
const { User: UserModel } = require('../schemas/UserSchema');
const { ItemData } = require('../schemas/ItemSchema');
const view = require('../engine/b5/shopView');
const rods5b = require('../engine/b5/rods');
const rodOps = require('../engine/b5/rodOps');
const shopOps = require('../engine/b5/shopOps');
const { buyPermit } = require('../engine/b5/permitOps');
const { buyUpgrade } = require('../engine/b5/upgrades');

const money = view.money;

/** What the tabs need about the player: their document, owned rod names and a pending repair. */
async function context(userId) {
	const user = await UserModel.collection.findOne({ userId: String(userId) });
	const owned = await rodOps.ownedRods(user);
	let repair = null;
	const equipped = owned.find((r) => String(r._id) === String(user?.inventory?.equippedRod));
	if (equipped) {
		const profile = await rods5b.resolveRod(equipped);
		if (!profile.unbreakable && rods5b.effectiveState(equipped, profile) === 'broken') repair = { id: String(equipped._id), name: equipped.name, cost: profile.repairCost };
	}
	const aquarium = await require('../engine/b5/aquarium').shopTab(user);
	return { user, tabs: view.shopTabs(user, { ownedRodNames: new Set(owned.map((r) => r.name)), repair, aquarium }), workshop: view.workshop(user) };
}

function describe(tab, cash) {
	const lines = [];
	if (tab.key === 'rods') {
		for (const r of tab.rows) lines.push(`${({ owned: '✅', buyable: '🛒', locked: '🔒' })[r.status]} **${r.name}** ${money(r.price)} · Lv ${r.unlockLevel} · ${r.meanFish.toFixed(2)} fish · RF ${Math.round(r.stats.rareFind * 100)}% · Luck ${Math.round(r.stats.luck * 100)}%`);
		lines.push('', tab.footer);
	}
	else if (tab.key === 'bait') {
		for (const r of tab.rows) lines.push(`**${r.name}** ${money(r.packPrice)} per ${r.packSize} casts · works in ${r.biomes.join(', ')}`);
	}
	else if (tab.key === 'upgrades') {
		for (const r of tab.rows) lines.push(r.max ? `**${r.name}** L${r.current} (max)` : `**${r.name}** L${r.current} → L${r.next} ${money(r.price)} · ${r.effect}/level · ${r.unlocked ? r.away : `unlocks at Lv ${r.unlockLevel}`}`);
	}
	else if (tab.key === 'supplies') {
		for (const p of tab.rows.permits) lines.push(`🎫 **${p.biome} permit** ${money(p.price)} · ${view.away(p.price, cash)}`);
		if (tab.rows.repair) lines.push(`🔧 **Repair ${tab.rows.repair.name}** ${money(tab.rows.repair.cost)}`);
	}
	else if (tab.render) {
		lines.push(...tab.render(cash));
	}
	return lines.join('\n') || 'Nothing here right now.';
}

function render(ctx, active, notice = null) {
	const cash = ctx.user?.inventory?.money || 0;
	const tab = ctx.tabs.find((t) => t.key === active) || ctx.tabs[0];
	const embed = new EmbedBuilder().setTitle(`🎣 Shop · ${tab.title}`).setColor('Green').setDescription(`${notice ? `${notice}\n\n` : ''}${describe(tab, cash)}`).setFooter({ text: `You have ${money(cash)}` });
	const tabs = new ActionRowBuilder().addComponents(ctx.tabs.slice(0, 4).map((t) => new ButtonBuilder().setCustomId(`shop5b-tab:${t.key}`).setLabel(t.title).setStyle(t.key === tab.key ? ButtonStyle.Primary : ButtonStyle.Secondary)));
	const extra = [];
	if (ctx.tabs.length > 4) extra.push(...ctx.tabs.slice(4).map((t) => new ButtonBuilder().setCustomId(`shop5b-tab:${t.key}`).setLabel(t.title).setStyle(t.key === tab.key ? ButtonStyle.Primary : ButtonStyle.Secondary)));
	if (ctx.workshop.open) extra.push(new ButtonBuilder().setCustomId('shop5b-workshop').setLabel('🔧 Rod Workshop').setStyle(ButtonStyle.Success));
	const rows = [tabs];
	if (extra.length) rows.push(new ActionRowBuilder().addComponents(extra));
	if (tab.buyable?.length) {
		rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`shop5b-buy:${tab.key}`).setPlaceholder('Select something to buy…').addOptions(tab.buyable.slice(0, 25).map((b) => new StringSelectMenuOptionBuilder().setLabel(b.label.slice(0, 100)).setValue(b.id)))));
	}
	return { embeds: [embed], components: rows };
}

async function renderWorkshop(userId, notice = null) {
	const user = await UserModel.collection.findOne({ userId: String(userId) });
	const w = view.workshop(user);
	const parts = (await ItemData.collection.find({ _id: { $in: (user.inventory?.items || []).map((id) => new mongoose.Types.ObjectId(String(id))) }, type: { $in: Object.keys(rods5b.SLOT_OF_TYPE) }, count: { $gte: 1 } }).toArray());
	const lines = [
		...(notice ? [notice, ''] : []),
		'**Crates** (open with /open):',
		...w.crates.map((c) => `T${c.tier} **${c.name}** ${money(c.price)}`),
		'',
		'**Craft** with /craft: the preview shows the required level (the highest part\'s) before you confirm.',
		`**Salvage**: ${Object.entries(w.salvage).map(([r, v]) => `${r} ${money(v)}`).join(' · ')}`,
	];
	const rows = [];
	if (w.crates.length) rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('shop5b-crate').setPlaceholder('Buy a crate…').addOptions(w.crates.map((c) => new StringSelectMenuOptionBuilder().setLabel(`${c.name} · ${money(c.price)}`).setValue(c.name)))));
	if (parts.length) rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('shop5b-salvage').setPlaceholder('Salvage one spare part…').addOptions(parts.slice(0, 25).map((p) => new StringSelectMenuOptionBuilder().setLabel(`${p.name} ×${p.count} · ${money(w.salvage[rods5b.canon(p.rarity)] || 0)}`.slice(0, 100)).setValue(String(p._id))))));
	rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('shop5b-tab:rods').setLabel('Back to the shop').setStyle(ButtonStyle.Secondary)));
	return { embeds: [new EmbedBuilder().setTitle(`🔧 Rod Workshop · you are Lv ${w.level}`).setColor('Green').setDescription(lines.join('\n')).setFooter({ text: `You have ${money(user.inventory?.money || 0)}` })], components: rows };
}

/** Runs one purchase from a tab's select. Returns the notice to show. */
async function buy(userId, tabKey, id) {
	let r;
	if (tabKey === 'rods') {r = await rodOps.buyStandardRod(userId, id);}
	else if (tabKey === 'bait') {r = await shopOps.buyBaitPacks(userId, id, 1);}
	else if (tabKey === 'upgrades') {r = await buyUpgrade(userId, id);}
	else if (tabKey === 'supplies' && id.startsWith('permit:')) {r = await buyPermit(userId, id.slice('permit:'.length));}
	else if (tabKey === 'supplies' && id === 'repair') {
		const user = await UserModel.collection.findOne({ userId: String(userId) });
		r = await rodOps.repairRod(userId, user.inventory.equippedRod);
	}
	else if (tabKey === 'aquarium') {r = await require('../engine/b5/aquarium').buyFromShop(userId, id);}
	else {r = { ok: false, message: 'Unknown item.' };}
	return r.ok ? `✅ Bought${r.price || r.cost ? ` for ${money(r.price || r.cost)}` : ''}.` : `❌ ${r.message}`;
}

/** Opens the 5B shop for the invoker (ephemeral) and serves its tabs until the collector times out. */
async function openShop(interaction) {
	const userId = interaction.user.id;
	let ctx = await context(userId);
	let active = ctx.tabs[0].key;
	const message = await interaction.reply({ ...render(ctx, active), flags: MessageFlags.Ephemeral, fetchReply: true });
	const collector = message.createMessageComponentCollector({ filter: (i) => i.user.id === userId, time: 180_000 });
	collector.on('collect', async (i) => {
		try {
			if (i.customId.startsWith('shop5b-tab:')) {
				active = i.customId.split(':')[1];
				ctx = await context(userId);
				return i.update(render(ctx, active));
			}
			if (i.customId === 'shop5b-workshop') return i.update(await renderWorkshop(userId));
			if (i.customId === 'shop5b-crate') {
				const r = await shopOps.buyCrate(userId, i.values[0]);
				return i.update(await renderWorkshop(userId, r.ok ? `✅ Bought a ${i.values[0]} for ${money(r.price)}. Open it with /open.` : `❌ ${r.message}`));
			}
			if (i.customId === 'shop5b-salvage') {
				const r = await rodOps.salvagePart(userId, i.values[0]);
				return i.update(await renderWorkshop(userId, r.ok ? `♻️ Salvaged for ${money(r.value)}.` : `❌ ${r.message}`));
			}
			if (i.customId.startsWith('shop5b-buy:')) {
				const tabKey = i.customId.split(':')[1];
				const notice = await buy(userId, tabKey, i.values[0]);
				ctx = await context(userId);
				active = ctx.tabs.some((t) => t.key === tabKey) ? tabKey : ctx.tabs[0].key;
				return i.update(render(ctx, active, notice));
			}
		}
		catch (error) {
			console.error(error);
			await i.reply({ content: 'Something went wrong. You were not charged for anything that did not complete.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
		}
	});
	collector.on('end', () => interaction.editReply({ components: [] }).catch(() => undefined));
}

module.exports = { openShop, context, render, renderWorkshop, buy };
