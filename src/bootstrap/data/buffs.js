// Static seed data. Moved from src/scripts/generateBuffs.js; consumed by src/bootstrap/seed.js.
module.exports = [
	{
		name: 'Double XP',
		description: 'Doubles the experience points earned from all activities.',
		rarity: 'Rare',
		active: false,
		capabilities: ['xp', '2.0'],
		length: 3600,
		icon: {
			animated: false,
			data: '',
		},
	},

	{
		name: 'Double Cash',
		description: 'Doubles your income earned from all activities.',
		rarity: 'Rare',
		active: false,
		capabilities: ['cash', '2.0'],
		length: 3600,
		icon: {
			animated: false,
			data: '',
		},
	},

	{
		name: 'Lucky Draw',
		description: 'Increases the chances of obtaining rare items from gacha draws.',
		rarity: 'Rare',
		active: false,
		capabilities: ['gacha', '1.5'],
		length: 3600,
		icon: {
			animated: false,
			data: '',
		},
	},
];
