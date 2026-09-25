// Static seed data. Moved from src/scripts/generateBiomes.js; consumed by src/bootstrap/seed.js.
module.exports = [
	{
		name: 'Ocean',
		requirements: ['Level 0'],
		icon: {
			animated: false,
			data: 'Ocean',
		},
	},
	{
		name: 'River',
		requirements: ['Level 10'],
		icon: {
			animated: false,
			data: 'River',
		},
	},
	{
		name: 'Lake',
		requirements: ['Level 20'],
		icon: {
			animated: false,
			data: 'Lake',
		},
	},
	{
		name: 'Pond',
		requirements: ['Level 30'],
		icon: {
			animated: false,
			data: 'Pond',
		},
	},
	{
		name: 'Coast',
		requirements: ['Level 40'],
		icon: {
			animated: false,
			data: 'Coast',
		},
	},
	{
		name: 'Swamp',
		requirements: ['Level 50'],
		icon: {
			animated: false,
			data: 'Swamp',
		},
	},
];
