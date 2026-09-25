// Central emoji configuration for DCC Fishing.
//
// Game data stores an icon *key* in `icon.data` (e.g. 'Sardine'). Older rows may still hold the
// original FishingRPG form 'Sardine:1244064605622501467'; only the part before ':' is used as the key.
// The original bot's custom emojis live on servers DCC is not in, so they are never rendered directly.
//
// Resolution order (see src/class/Icons.js):
//   1. An application emoji uploaded to this bot with the same name as the key
//      (Discord Developer Portal > your app > Emojis). Upload art named e.g. `Sardine` and it is
//      used everywhere automatically after the next restart - no code or data change needed.
//   2. The original custom emoji, only if the bot can actually see it (it shares that server).
//   3. The Unicode emoji below.
//   4. The fallback for the object's type (`types`), then `types.default`.
//
// Original artwork IDs for keys that came from FishingRPG are listed in src/scripts/emojis.txt;
// src/scripts/downloadEmojiImages.js downloads them so they can be re-uploaded as application emojis.

// Icon key -> Unicode emoji.
const icons = {
	// Fish
	Albacore: '🐟',
	Anchovy: '🐟',
	Angler: '🐟',
	Blue_Discus: '🐠',
	Bullhead: '🐟',
	Carp: '🐟',
	Catfish: '🐟',
	Chub: '🐟',
	Clam: '🦪',
	Crab: '🦀',
	Dorado: '🐠',
	Dried_Starfish: '⭐',
	Eel: '🐍',
	Flounder: '🐟',
	Frog: '🐸',
	Ghostfish: '👻',
	Glacierfish: '🧊',
	Herring: '🐟',
	Ice_Pip: '🧊',
	Jellyfish: '🪼',
	Largemouth_Bass: '🐟',
	Lingcod: '🐟',
	Lobster: '🦞',
	magikarp: '🎏',
	Mutant_Carp: '🐟',
	Octopus: '🐙',
	Oyster: '🦪',
	Pearl: '🫧',
	Perch: '🐟',
	Pike: '🐟',
	Pufferfish: '🐡',
	Radioactive_Carp: '☢️',
	Rainbow_Trout: '🐠',
	// Generic placeholder, see `placeholders`.
	rawfish: '🐟',
	Red_Snapper: '🐠',
	Salmon: '🐟',
	Sardine: '🐟',
	Scorpion_Carp: '🐟',
	Shad: '🐟',
	Shrimp: '🦐',
	Smallmouth_Bass: '🐟',
	Son_of_Crimsonfish: '🐠',
	Starfish: '⭐',
	Stonefish: '🐡',
	Sturgeon: '🐟',
	Sunfish: '🐠',
	Super_Cucumber: '🥒',
	Tiger_Trout: '🐠',
	Tilapia: '🐟',
	Treasure_Chest: '🎁',
	Tuna: '🐟',
	Void_Salmon: '🌌',
	Walleye: '🐟',
	Woodskip: '🐟',

	// Rods, rod parts and bait
	// Generic placeholder, see `placeholders`.
	old_rod: '🎣',
	Stick: '🪵',
	Lead_Bobber: '🧵',
	Barbed_Hook: '🪝',
	Wild_Bait: '🪱',
	Bait: '🪱',
	Spinner: '🌀',
	Magnet: '🧲',

	// Buffs and licenses (no original artwork)
	Double_XP: '✨',
	Double_Cash: '💰',
	Lucky_Draw: '🍀',
	License: '📜',

	// Biomes (originally all used the `rawfish` placeholder)
	Ocean: '🌊',
	River: '🏞️',
	Lake: '🛶',
	Pond: '🪷',
	Coast: '🏖️',
	Swamp: '🐊',

	// Weather
	SunAnimated: '☀️',
	RainAnimated: '🌧️',
	StormAnimated: '☁️',
	SnowAnimated: '❄️',
	FallWindAnimated: '💨',

	// Seasons
	Spring: '🌸',
	Summer: '🌞',
	Fall: '🍂',
	Winter: '☃️',
};

// Object `type` -> fallback when the key is missing or unknown.
const types = {
	fish: '🐟',
	rod: '🎣',
	customrod: '🎣',
	bait: '🪱',
	part_rod: '🪵',
	part_reel: '🧵',
	part_hook: '🪝',
	part_handle: '🪵',
	buff: '✨',
	gacha: '🎁',
	license: '📜',
	quest: '📜',
	biome: '🗺️',
	weather: '🌤️',
	season: '🗓️',
	pet: '🐟',
	aquarium: '🐠',
	item: '📦',
	default: '🔹',
};

// Keys that were used as generic placeholders (old schema defaults). They are only shown for the listed
// types; anything else carrying them gets its type fallback instead (e.g. a bait never shows a rod).
const placeholders = {
	old_rod: ['rod', 'customrod'],
	rawfish: ['fish', 'pet'],
};

module.exports = { icons, types, placeholders };
