// Static seed data. Moved from src/scripts/generateLicenses.js; consumed by src/bootstrap/seed.js.
module.exports = [
	{
		name: 'Basic Freshwater Aquarium License',
		description: 'A basic license to own a freshwater aquarium.',
		prerequisites: [],
		qualities: ['basic'],
		capabilities: [],
		biomes: [],
		requirements: {
			level: 0,
		},
		icon: {
			animated: false,
			data: 'License',
		},
		aquarium: {
			waterType: ['freshwater'],
			size: 1,
		},
		shopItem: true,
		price: 1_000_000,
		rarity: 'Common',

	},
	{
		name: 'Basic Saltwater Aquarium License',
		description: 'A basic license to own a saltwater aquarium.',
		prerequisites: [],
		qualities: ['basic'],
		capabilities: [],
		biomes: [],
		requirements: {
			level: 0,
		},
		icon: {
			animated: false,
			data: 'License',
		},
		aquarium: {
			waterType: ['saltwater'],
			size: 1,
		},
		shopItem: true,
		price: 1_000_000,
		rarity: 'Common',
	},
	{
		name: 'Advanced Freshwater Aquarium License',
		description: 'An advanced license to own a freshwater aquarium.',
		prerequisites: ['Basic Freshwater Aquarium License'],
		qualities: ['advanced'],
		capabilities: [],
		biomes: [],
		requirements: {
			level: 10,
		},
		icon: {
			animated: false,
			data: 'License',
		},
		aquarium: {
			waterType: ['freshwater'],
			size: 2,
		},
		shopItem: true,
		price: 5_000_000,
		rarity: 'Uncommon',
	},
	{
		name: 'Advanced Saltwater Aquarium License',
		description: 'An advanced license to own a saltwater aquarium.',
		prerequisites: ['Basic Saltwater Aquarium License'],
		qualities: ['advanced'],
		capabilities: [],
		biomes: [],
		requirements: {
			level: 10,
		},
		icon: {
			animated: false,
			data: 'License',
		},
		aquarium: {
			waterType: ['saltwater'],
			size: 2,
		},
		shopItem: true,
		price: 5_000_000,
		rarity: 'Uncommon',
	},
	{
		name: 'Expert Freshwater Aquarium License',
		description: 'An expert license to own a freshwater aquarium.',
		prerequisites: ['Advanced Freshwater Aquarium License'],
		qualities: ['expert'],
		capabilities: [],
		biomes: [],
		requirements: {
			level: 20,
		},
		icon: {
			animated: false,
			data: 'License',
		},
		aquarium: {
			waterType: ['freshwater'],
			size: 3,
		},
		shopItem: true,
		price: 10_000_000,
		rarity: 'Rare',
	},
	{
		name: 'Expert Saltwater Aquarium License',
		description: 'An expert license to own a saltwater aquarium.',
		prerequisites: ['Advanced Saltwater Aquarium License'],
		qualities: ['expert'],
		capabilities: [],
		biomes: [],
		requirements: {
			level: 20,
		},
		icon: {
			animated: false,
			data: 'License',
		},
		aquarium: {
			waterType: ['saltwater'],
			size: 3,
		},
		shopItem: true,
		price: 10_000_000,
		rarity: 'Rare',
	},
];
