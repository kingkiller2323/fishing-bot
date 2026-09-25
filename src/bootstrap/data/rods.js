// Static seed data consumed by src/bootstrap/seed.js.
// The starter rod: User.create(), User.getEquippedRod() and interactionCreate all look up
// the catalog item named 'Old Rod', so it must exist before any user can be created.
// No generator for it existed in the repo; stats mirror the weakest rod part and the RodSchema defaults.
module.exports = [
	{
		name: 'Old Rod',
		description: 'A worn but trusty fishing rod. Every angler starts somewhere.',
		rarity: 'Common',
		price: 0,
		shopItem: false,
		type: 'rod',
		capabilities: ['weak', '1'],
		requirements: {
			level: 0,
		},
		durability: 1000,
		maxDurability: 1000,
		maxRepairs: 3,
		repairCost: 1000,
		icon: {
			animated: false,
			data: 'old_rod:1210508306662301706',
		},
	},
];
