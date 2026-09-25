// Static seed data. Moved from src/scripts/generateFish.js; consumed by src/bootstrap/seed.js.
// Builds the base fish catalog: one fish for every rarity x biome x quality combination.
// Fish.generateFish() relies on this grid being complete (it retries until a matching fish exists).

function buildBaseFish() {
	// There are 7 unique rarities (Common, Uncommon, Rare, Ultra, Giant, Legendary, Lucky), 6 unique biomes (Ocean, River, Lake, Pond, Swamp, Coast) and 2 unique qualities (strong, weak). Generate enough fish to populate every combination possible.
	const rarities = ['Common', 'Uncommon', 'Rare', 'Ultra', 'Giant', 'Legendary', 'Lucky'];
	const biomes = ['Ocean', 'River', 'Lake', 'Pond', 'Swamp', 'Coast'];
	const qualities = ['strong', 'weak'];

	const fishes = [];

	for (const rarity of rarities) {
		for (const biome of biomes) {
			for (const quality of qualities) {
				const fish = {
					'name': `${rarity} ${biome} ${quality} Fish`,
					'rarity': rarity,
					'value': calculateFishValue(rarity, quality),
					'icon': generateFishIcon(),
					'qualities': [quality],
					'type': 'fish',
					'biome': biome,
				};

				switch (fish.name) {
				case 'Common Ocean strong Fish': {
					fish.name = 'Seabass';
					fish.description = 'Seabass is a type of fish commonly found in the ocean. It is known for its strong and flavorful taste. Seabass is often sought after by anglers and is considered a prized catch in many fishing communities.';
					fish.icon.data = 'Largemouth_Bass:1244065155361407111';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Common Ocean weak Fish': {
					fish.name = 'Sardine';
					fish.description = 'Sardine is a type of fish commonly found in the ocean. It is known for its small size and silvery appearance. Sardines are often used in cooking and can be found in a variety of dishes.';
					fish.icon.data = 'Sardine:1244064605622501467';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Uncommon Ocean strong Fish': {
					fish.name = 'Tuna';
					fish.description = 'Tuna is a type of fish found in the ocean. It is known for its large size and powerful swimming ability. Tuna are popular game fish and are often sought after by anglers for their fighting spirit.';
					fish.icon.data = 'Tuna:1244065971543609394';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Uncommon Ocean weak Fish': {
					fish.name = 'Anchovy';
					fish.description = 'Anchovy is a type of fish found in the ocean. It is known for its small size and strong flavor. Anchovies are often used as a topping on pizzas and in salads.';
					fish.icon.data = 'Anchovy:1244064518590697497';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Rare Ocean strong Fish': {
					fish.name = 'Swordfish';
					fish.description = 'Swordfish is a type of fish found in the ocean. It is known for its large size and distinctive appearance. Like its name suggests, swordfish have a long, sword-like bill that they use to catch prey.';
					fish.icon.data = 'Sturgeon:1244066061964283934';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Rare Ocean weak Fish': {
					fish.name = 'Pufferfish';
					fish.description = 'Pufferfish is a type of fish found in the ocean. It is known for its unique appearance and ability to inflate its body. Although pufferfish are considered a delicacy in some cultures, they can be toxic if not prepared properly.';
					fish.icon.data = 'Pufferfish:1244064592229961748';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Ultra Ocean strong Fish': {
					fish.name = 'Azure Marlin';
					fish.description = 'Azure Marlin is a type of fish found in the ocean. Marlin are known for their large size and impressive fighting ability. They are popular game fish and are often sought after by anglers for their challenging nature.';
					fish.icon.data = 'Ice_Pip:1244064559942205472';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Ultra Ocean weak Fish': {
					fish.name = 'Giant Shrimp';
					fish.description = 'Giant Shrimp is a type of crustacean found in the ocean. It is known for its large size and sweet flavor. Giant Shrimp are popular seafood items and are often used in a variety of dishes.';
					fish.icon.data = 'Shrimp:1244065947585871872';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Giant Ocean strong Fish': {
					fish.name = 'Albacore';
					fish.description = 'Albacore is a type of fish found in the ocean. It is known for its large size and powerful swimming ability. Albacore are popular game fish and are often sought after by anglers for their fighting spirit.';
					fish.icon.data = 'Albacore:1244064517332271187';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Giant Ocean weak Fish': {
					fish.name = 'Super Cucumber';
					fish.description = 'Super Cucumber is a type of fish found in the ocean. It is known for its large size and distinctive appearance. Many anglers consider Super Cucumber to be a prized catch.';
					fish.icon.data = 'Super_Cucumber:1244066062744420383';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Legendary Ocean strong Fish': {
					fish.name = 'Kraken';
					fish.description = 'Kraken is a legendary sea monster said to dwell off the coast of Norway and Greenland. It is known for its massive size and fearsome appearance. The Kraken is said to be capable of dragging entire ships beneath the waves.';
					fish.icon.data = 'Octopus:1244065311859282030';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Legendary Ocean weak Fish': {
					fish.name = 'Anglerfish';
					fish.description = 'Anglerfish is a type of fish found in the ocean. It is known for its unique appearance and bioluminescent lure. Anglerfish are skilled hunters and use their glowing lure to attract prey.';
					fish.icon.data = 'Angler:1244064520213762188';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Lucky Ocean strong Fish': {
					fish.name = 'Pearl';
					fish.description = 'Pearl is a rare and valuable gemstone found in the ocean. It is known for its lustrous appearance and iridescent colors. Pearls are often used in jewelry and are considered a symbol of beauty and elegance.';
					fish.icon.data = 'Pearl:1244065167004667964';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Lucky Ocean weak Fish': {
					fish.name = 'Magikarp';
					fish.description = 'Magikarp is a type of fish found in the ocean. It is known for its small size and weak swimming ability. Magikarp are often considered a nuisance by anglers, but they can evolve into a powerful and majestic creature.';
					fish.icon.animated = true;
					fish.icon.data = 'magikarp:1209358098976874538';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Common River strong Fish': {
					fish.name = 'Salmon';
					fish.description = 'Salmon is a type of fish found in rivers and streams. It is known for its distinctive pink flesh and rich flavor. Salmon are popular food fish and are often sought after by anglers for their fighting spirit.';
					fish.icon.data = 'Salmon:1244064602682036234';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Common River weak Fish': {
					fish.name = 'Carp';
					fish.description = 'Carp is a type of fish found in rivers and lakes. It is known for its large size and hardy nature. Although carp are often considered a nuisance by anglers, they can be a challenging and rewarding catch.';
					fish.icon.data = 'Carp:1244064525859422228';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Uncommon River strong Fish': {
					fish.name = 'Catfish';
					fish.description = 'Catfish is a type of fish found in rivers and lakes. It is known for its whisker-like barbels and bottom-feeding behavior. Catfish are popular food fish and are often sought after by anglers for their unique taste.';
					fish.icon.data = 'Catfish:1244065147769851904';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Uncommon River weak Fish': {
					fish.name = 'Rainbow Trout';
					fish.description = 'Rainbow Trout is a type of fish found in rivers and streams. It is known for its colorful appearance and delicate flavor. Rainbow Trout can be found in a variety of habitats and are popular game fish.';
					fish.icon.data = 'Rainbow_Trout:1244064595681869834';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Rare River strong Fish': {
					fish.name = 'Sturgeon';
					fish.description = 'Sturgeon is a type of fish found in rivers and lakes. It is known for its large size and prehistoric appearance. Sturgeon will often migrate between freshwater and saltwater habitats.';
					fish.icon.data = 'Sturgeon:1244066061964283934';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Rare River weak Fish': {
					fish.name = 'Shad';
					fish.description = 'Shad is a type of fish found in rivers and lakes. It is known for its silvery appearance and strong flavor. Shad play an important role in the ecosystem as a food source for other species of fish.';
					fish.icon.data = 'Shad:1244065946457473044';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Ultra River strong Fish': {
					fish.name = 'Dorado';
					fish.description = 'Dorado is a type of fish found in rivers and streams. It is known for its vibrant golden color and delicate flavor. Dorado are popular game fish and are often sought after by anglers for their beauty.';
					fish.icon.data = 'Dorado:1244064546608386239';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Ultra River weak Fish': {
					fish.name = 'Scorpion Carp';
					fish.description = 'Scorpion Carp is a rare and mystical creature found in rivers and streams. It is known for its scorpion-like tail and venomous spines. Scorpion Carp are said to bring good luck and prosperity to those who encounter them.';
					fish.icon.data = 'Scorpion_Carp:1244065942909096038';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Giant River strong Fish': {
					fish.name = 'Queen Salmon';
					fish.description = 'Queen Salmon is a type of fish found in rivers and streams. It is known for its large size and powerful swimming ability. Queen Salmon lay their eggs in freshwater and migrate to the ocean to feed.';
					fish.icon.data = 'Salmon:1244064602682036234';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Giant River weak Fish': {
					fish.name = 'King Salmon';
					fish.description = 'King Salmon is a type of fish found in rivers and streams. It is known for its large size and distinctive flavor. King Salmon are popular food fish and are often sought after by anglers for their rich taste.';
					fish.icon.data = 'Salmon:1244064602682036234';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Legendary River strong Fish': {
					fish.name = 'Void Salmon';
					fish.description = 'Void Salmon is a legendary fish said to dwell in the depths of rivers and streams. It is known for its dark color and mysterious nature. Void Salmon are said to possess mystical powers and are said to bring misfortune to those who catch them.';
					fish.icon.data = 'Void_Salmon:1244066120542064731';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Legendary River weak Fish': {
					fish.name = 'Woodskip';
					fish.description = 'Woodskip is a legendary fish said to dwell in the depths of rivers and streams. It is known for its wooden appearance and elusive nature. Woodskip are said to bring good luck and prosperity to those who catch them.';
					fish.icon.data = 'Woodskip:1244066122727428146';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Lucky River strong Fish': {
					fish.name = 'Noxclate Fish';
					fish.description = 'Noxclate Fish is a rare and mysterious creature said to dwell in the dark depths of rivers and lakes. It is known for its elusive nature and otherworldly appearance. Noxclate Fish are said to bring good fortune to those who encounter them.';
					fish.icon.data = 'Son_of_Crimsonfish:1244065950915891242';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Lucky River weak Fish': {
					fish.name = 'Lunafin Fish';
					fish.description = 'Lunafin Fish is a rare and magical creature said to dwell in the moonlit waters of rivers and streams. It is known for its shimmering scales and ethereal beauty. Lunafin Fish are said to bring luck and prosperity to those who catch them.';
					fish.icon.data = 'Ghostfish:1244064550471598213';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Common Lake strong Fish': {
					fish.name = 'Bass';
					fish.description = 'Bass is a type of fish found in lakes and rivers. It is known for its large size and powerful swimming ability. Bass fishing is a popular sport in many parts of the world.';
					fish.icon.data = 'Smallmouth_Bass:1244065949930487889';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Common Lake weak Fish': {
					fish.name = 'Bluegill';
					fish.description = 'Bluegill is a type of fish found in lakes and ponds. It is known for its small size and colorful appearance. Bluegill are popularly caught by anglers and are often used as bait for larger fish.';
					fish.icon.data = 'Blue_Discus:1244064522566762596';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Uncommon Lake strong Fish': {
					fish.name = 'Walleye';
					fish.description = 'Walleye is a type of fish found in lakes and rivers. It is known for its large size and distinctive appearance. Walleye are popular game fish and are often sought after by anglers for their delicate flavor.';
					fish.icon.data = 'Walleye:1244066121552756816';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Uncommon Lake weak Fish': {
					fish.name = 'Perch';
					fish.description = 'Perch is a type of fish found in lakes and rivers. It is known for its small size and striped appearance. Perch are popular food fish and are often caught by anglers for their mild flavor.';
					fish.icon.data = 'Perch:1244064588530581544';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Rare Lake strong Fish': {
					fish.name = 'Pike';
					fish.description = 'Pike is a type of fish found in lakes and rivers. It is known for its large size and aggressive nature. Pike are apex predators of the water and are often sought after by anglers for their challenging nature.';
					fish.icon.data = 'Pike:1244065312924504094';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Rare Lake weak Fish': {
					fish.name = 'Loach';
					fish.description = 'Loach is a type of fish found in lakes and rivers. It is known for its small size and bottom-feeding behavior. Loach are often used as bait for other species of fish.';
					fish.icon.data = 'Eel:1244064547313291285';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Ultra Lake strong Fish': {
					fish.name = 'Steelhead';
					fish.description = 'Steelhead is a type of fish found in lakes and rivers. It is known for its large size and powerful swimming ability. Steelhead are zealous fighters and are popular game fish among anglers.';
					fish.icon.data = 'Bullhead:1244064524798267433';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Ultra Lake weak Fish': {
					fish.name = 'Golden Bass';
					fish.description = 'Golden Bass is a type of fish found in lakes and rivers. It is known for its golden scales and peaceful nature. Golden Bass are often kept as ornamental fish in ponds and aquariums.';
					fish.icon.data = 'Dorado:1244064546608386239';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Giant Lake strong Fish': {
					fish.name = 'Loch Ness Monster';
					fish.description = 'Loch Ness Monster is a legendary creature said to dwell in the depths of Loch Ness in Scotland. It is known for its long neck and humped back. The Loch Ness Monster is a popular figure in Scottish folklore and has captured the imagination of people around the world.';
					fish.icon.data = 'Mutant_Carp:1244064581484023819';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Giant Lake weak Fish': {
					fish.name = 'Ogopogo';
					fish.description = 'Ogopogo is a legendary creature said to dwell in the depths of Okanagan Lake in British Columbia, Canada. It is known for its long neck and serpentine body. Ogopogo is a popular figure in Canadian folklore and has become a symbol of the region.';
					fish.icon.data = 'Mutant_Carp:1244064581484023819';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Legendary Lake strong Fish': {
					fish.name = 'Golden Pike';
					fish.description = 'Golden Pike is a legendary fish said to dwell in the depths of lakes and rivers. It is known for its massive size and golden scales. Golden Pike possess mystical powers and are said to bring good fortune to those who catch them.';
					fish.icon.data = 'Dorado:1244064546608386239';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Legendary Lake weak Fish': {
					fish.name = 'Golden Loach';
					fish.description = 'Golden Loach is a legendary fish said to dwell in the depths of lakes and rivers. It is known for its shimmering scales and elusive nature. Golden Loach are said to bring prosperity and abundance to those who catch them.';
					fish.icon.data = 'Dorado:1244064546608386239';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Lucky Lake strong Fish': {
					fish.name = 'Lost Ring';
					fish.description = 'Lost Ring is a rare and valuable item said to be hidden in the depths of lakes and rivers. It is known for its intricate design and sparkling gemstones.';
					fish.icon.data = 'Treasure_Chest:1244066065751867423';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Lucky Lake weak Fish': {
					fish.name = 'Lost Necklace';
					fish.description = 'Lost Necklace is a rare and precious item said to be hidden in the depths of lakes and rivers. It is known for its elegant design and shimmering gemstones.';
					fish.icon.data = 'Treasure_Chest:1244066065751867423';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Common Pond strong Fish': {
					fish.name = 'Guppy';
					fish.description = 'Guppy is a type of fish commonly found in ponds and aquariums. It is known for its small size and colorful appearance. Guppies are popular ornamental fish and are often kept in home aquariums.';
					fish.icon.data = 'Red_Snapper:1244064598722875392';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Common Pond weak Fish': {
					fish.name = 'Frog';
					fish.description = 'Frog is a type of amphibian commonly found in ponds and wetlands. It is known for its long legs and distinctive croaking sound. Frogs play an important role in the ecosystem as both predator and prey.';
					fish.icon.data = 'Frog:1254439000803119227';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Uncommon Pond strong Fish': {
					fish.name = 'Betta';
					fish.description = 'Betta is a type of fish commonly found in ponds and aquariums. It is known for its vibrant colors and aggressive nature. Betta fish are popular ornamental fish and are often kept in home aquariums.';
					fish.icon.data = 'Blue_Discus:1244064522566762596';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Uncommon Pond weak Fish': {
					fish.name = 'Koi';
					fish.description = 'Koi is a type of fish commonly found in ponds and water gardens. It is known for its large size and colorful appearance. Koi are popular ornamental fish and are often kept in decorative ponds.';
					fish.icon.data = 'Dorado:1244064546608386239';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Rare Pond strong Fish': {
					fish.name = 'Chub';
					fish.description = 'Chub is a type of fish commonly found in ponds and lakes. It is known for its large size and powerful swimming ability. Chub are popular game fish and sport a distinctive appearance.';
					fish.icon.data = 'Chub:1244064529009086465';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Rare Pond weak Fish': {
					fish.name = 'Giant Frog';
					fish.description = 'Giant Frog is a type of amphibian commonly found in ponds and wetlands. It is known for its massive size and deep croaking sound. Giant Frogs are often associated with myths and legends.';
					fish.icon.data = 'Frog:1254439000803119227';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Ultra Pond strong Fish': {
					fish.name = 'Golden Guppy';
					fish.description = 'Golden Guppy is a rare and valuable fish found in ponds and aquariums. It is known for its shimmering scales and peaceful nature. Golden Guppy are often kept as ornamental fish in home aquariums.';
					fish.icon.data = 'Dorado:1244064546608386239';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Ultra Pond weak Fish': {
					fish.name = 'Golden Frog';
					fish.description = 'Golden Frog is a rare and mystical creature found in ponds and wetlands. It is known for its golden color and magical properties. Golden Frogs are said to bring good luck and prosperity to those who encounter them.';
					fish.icon.data = 'Frog:1254439000803119227';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Giant Pond strong Fish': {
					fish.name = 'Jumbo Koi';
					fish.description = 'Jumbo Koi is a massive and majestic fish found in ponds and water gardens. It is known for its enormous size and vibrant colors. Jumbo Koi are prized for their beauty and are often kept in decorative ponds.';
					fish.icon.data = 'Dorado:1244064546608386239';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Giant Pond weak Fish': {
					fish.name = 'Zombie Fish';
					fish.description = 'Zombie Fish is a rare and mysterious creature found in the depths of ponds and lakes. It is known for its undead appearance and eerie behavior. Zombie Fish are said to bring bad luck and misfortune to those who encounter them.';
					fish.icon.data = 'Mutant_Carp:1244064581484023819';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Legendary Pond strong Fish': {
					fish.name = 'Golden Chub';
					fish.description = 'Golden Chub is a legendary fish said to dwell in the depths of ponds and lakes. It is known for its massive size and golden scales. Golden Chub are said to bring good fortune and prosperity to those who catch them.';
					fish.icon.data = 'Dorado:1244064546608386239';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Legendary Pond weak Fish': {
					fish.name = 'Platinum Frog';
					fish.description = 'Platinum Frog is a legendary creature said to dwell in the depths of ponds and wetlands. It is known for its shimmering platinum color and mystical properties. Platinum Frog are said to bring youth and vitality to those who encounter them.';
					fish.icon.data = 'Frog:1254439000803119227';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Lucky Pond strong Fish': {
					fish.name = 'Lost Wallet';
					fish.description = 'Lost Wallet is a rare and valuable item said to be hidden in the depths of ponds and lakes. It is known for its leather exterior and hidden treasures.';
					fish.icon.data = 'Treasure_Chest:1244066065751867423';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Lucky Pond weak Fish': {
					fish.name = 'Lost Phone';
					fish.description = 'Lost Phone is a rare and precious item said to be hidden in the depths of ponds and lakes. It is known for its sleek design and advanced technology.';
					fish.icon.data = 'Treasure_Chest:1244066065751867423';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Common Swamp strong Fish': {
					fish.name = 'Swamp Eel';
					fish.description = 'Swamp Eel is a type of fish found in swamps and wetlands. It is known for its long, snake-like body and slippery skin. Swamp Eel are often used in cooking and can be found in a variety of dishes.';
					fish.icon.data = 'Eel:1244064547313291285';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Common Swamp weak Fish': {
					fish.name = 'Mud Fish';
					fish.description = 'Mud Fish is a type of fish found in swamps and wetlands. It is known for its small size and muddy appearance. Mud Fish are often found in shallow waters and feed on insects and small crustaceans.';
					fish.icon.data = 'Stonefish:1244065957706465282';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Uncommon Swamp strong Fish': {
					fish.name = 'Water Snake';
					fish.description = 'Water Snake is a type of fish found in swamps and wetlands. It is known for its long, slender body and sharp teeth. Water Snake are often feared by anglers and are considered a nuisance in many fishing communities.';
					fish.icon.data = 'Eel:1244064547313291285';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Uncommon Swamp weak Fish': {
					fish.name = 'Bullfrog';
					fish.description = 'Bullfrog is a type of amphibian found in swamps and wetlands. It is known for its large size and deep croaking sound. Bullfrog are often associated with myths and legends.';
					fish.icon.data = 'Frog:1254439000803119227';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Rare Swamp strong Fish': {
					fish.name = 'Viperfish';
					fish.description = 'Viperfish is a type of fish found in swamps and wetlands. It is known for its sharp teeth and bioluminescent appearance. Viperfish are often found in deep waters and are rarely seen by humans.';
					fish.icon.data = 'Tiger_Trout:1244065964501368872';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Rare Swamp weak Fish': {
					fish.name = 'Bogfish';
					fish.description = 'Bogfish is a type of fish found in swamps and wetlands. It is known for its slimy skin and foul odor. Bogfish are often considered a nuisance by anglers and are rarely eaten.';
					fish.icon.data = 'Lingcod:1244065304716513392';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Ultra Swamp strong Fish': {
					fish.name = 'Golden Eel';
					fish.description = 'Golden Eel is a rare and valuable fish found in swamps and wetlands. It is known for its shimmering scales and peaceful nature. Golden Eel are often kept as ornamental fish in home aquariums.';
					fish.icon.data = 'Eel:1244064547313291285';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Ultra Swamp weak Fish': {
					fish.name = 'Golden Mudfish';
					fish.description = 'Golden Mudfish is a rare and mystical creature found in swamps and wetlands. It is known for its golden color and magical properties. Golden Mudfish are said to bring good luck and prosperity to those who encounter them.';
					fish.icon.data = 'Stonefish:1244065957706465282';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Giant Swamp strong Fish': {
					fish.name = 'Crocodile';
					fish.description = 'Crocodile is a type of reptile found in swamps and wetlands. It is known for its large size and powerful jaws. Crocodiles are apex predators of the water and are often feared by humans.';
					fish.icon.data = 'Mutant_Carp:1244064581484023819';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Giant Swamp weak Fish': {
					fish.name = 'Alligator';
					fish.description = 'Alligator is a type of reptile found in swamps and wetlands. It is known for its large size and armored body. Alligators will often bask in the sun to regulate their body temperature.';
					fish.icon.data = 'Mutant_Carp:1244064581484023819';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Legendary Swamp strong Fish': {
					fish.name = 'Golden Viperfish';
					fish.description = 'Golden Viperfish is a legendary fish said to dwell in the depths of swamps and wetlands. It is known for its massive size and golden scales. Golden Viperfish are said to bring good fortune and prosperity to those who catch them.';
					fish.icon.data = 'Tiger_Trout:1244065964501368872';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Legendary Swamp weak Fish': {
					fish.name = 'Golden Bogfish';
					fish.description = 'Golden Bogfish is a legendary fish said to dwell in the depths of swamps and wetlands. It is known for its shimmering scales and elusive nature. Golden Bogfish are said to bring youth and vitality to those who encounter them.';
					fish.icon.data = 'Lingcod:1244065304716513392';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Lucky Swamp strong Fish': {
					fish.name = 'Lost Boot';
					fish.description = 'Lost Boot is a rare item hidden in the depths of swamps and wetlands.';
					fish.value = 0;
					fish.icon.data = 'Treasure_Chest:1244066065751867423';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Lucky Swamp weak Fish': {
					fish.name = 'Lost Hat';
					fish.description = 'Lost Hat is a rare item hidden in the depths of swamps and wetlands.';
					fish.value = 0;
					fish.icon.data = 'Treasure_Chest:1244066065751867423';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Common Coast strong Fish': {
					fish.name = 'Crab';
					fish.description = 'Crab is a type of crustacean found in coastal waters. It is known for its hard shell and delicious meat. Crabs are popular seafood items and are often used in a variety of dishes.';
					fish.icon.data = 'Crab:1244064534826717287';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Common Coast weak Fish': {
					fish.name = 'Clam';
					fish.description = 'Clam is a type of mollusk found in coastal waters. It is known for its hard shell and tender meat. Clams are popular seafood items and are often used in soups and stews.';
					fish.icon.data = 'Clam:1244064531387514890';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Uncommon Coast strong Fish': {
					fish.name = 'Lobster';
					fish.description = 'Lobster is a type of crustacean found in coastal waters. It is known for its large size and sweet flavor. Lobsters are popular seafood items and are often served as a delicacy.';
					fish.icon.data = 'Lobster:1244065160096907264';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Uncommon Coast weak Fish': {
					fish.name = 'Oyster';
					fish.description = 'Oyster is a type of mollusk found in coastal waters. It is known for its hard shell and briny flavor. Oysters are popular seafood items and are often served raw or cooked.';
					fish.icon.data = 'Oyster:1244064585309491215';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Rare Coast strong Fish': {
					fish.name = 'Octopus';
					fish.description = 'Octopus is a type of cephalopod found in coastal waters. It is known for its eight arms and intelligent behavior. Octopus are skilled hunters and can change color to blend in with their surroundings.';
					fish.icon.data = 'Octopus:1244065311859282030';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Rare Coast weak Fish': {
					fish.name = 'Starfish';
					fish.description = 'Starfish is a type of echinoderm found in coastal waters. It is known for its five arms and distinctive shape. Starfish play an important role in the ecosystem as scavengers and predators.';
					fish.icon.data = 'Starfish:1254439001872535653';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Ultra Coast strong Fish': {
					fish.name = 'Golden Crab';
					fish.description = 'Golden Crab is a rare and valuable crustacean found in coastal waters. It is known for its golden shell and delicate meat. Golden Crab are often considered a delicacy and are highly prized by seafood enthusiasts.';
					fish.icon.data = 'Crab:1244064534826717287';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Ultra Coast weak Fish': {
					fish.name = 'Golden Clam';
					fish.description = 'Golden Clam is a rare and precious mollusk found in coastal waters. It is known for its golden shell and lustrous pearls. Golden Clam are often sought after by collectors and are said to bring good luck and prosperity.';
					fish.icon.data = 'Clam:1244064531387514890';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Giant Coast strong Fish': {
					fish.name = 'Jellyfish';
					fish.description = 'Jellyfish is a type of gelatinous creature found in coastal waters. It is known for its translucent body and stinging tentacles. Jellyfish are often found in large swarms and can be dangerous to humans.';
					fish.icon.data = 'Jellyfish:1254441082347978763';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Giant Coast weak Fish': {
					fish.name = 'Sea Serpent';
					fish.description = 'Sea Serpent is a legendary creature said to dwell in the depths of coastal waters. It is known for its long, serpentine body and fearsome appearance. Sea Serpent are often associated with myths and legends.';
					fish.icon.data = 'Glacierfish:1244064552341999726';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Legendary Coast strong Fish': {
					fish.name = 'Golden Octopus';
					fish.description = 'Golden Octopus is a legendary creature said to dwell in the depths of coastal waters. It is known for its massive size and golden color. Golden Octopus are said to possess mystical powers and are said to bring good fortune to those who encounter them.';
					fish.icon.data = 'Octopus:1244065311859282030';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Legendary Coast weak Fish': {
					fish.name = 'Golden Starfish';
					fish.description = 'Golden Starfish is a legendary creature said to dwell in the depths of coastal waters. It is known for its shimmering golden color and magical properties. Golden Starfish are said to bring luck and prosperity to those who encounter them.';
					fish.icon.data = 'Dried_Starfish:1254439003038548041';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Lucky Coast strong Fish': {
					fish.name = 'Lost Boot';
					fish.description = 'Lost Boot is a rare item hidden in the depths of coastal waters.';
					fish.value = 0;
					fish.icon.data = 'Treasure_Chest:1244066065751867423';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				case 'Lucky Coast weak Fish': {
					fish.name = 'Lost Hat';
					fish.description = 'Lost Hat is a rare item hidden in the depths of coastal waters.';
					fish.value = 0;
					fish.icon.data = 'Treasure_Chest:1244066065751867423';
					Object.assign(fish, getFishStats(fish.name));
					break;
				}
				default: {
					break;
				}
				}

				fishes.push(fish);
			}
		}
	}

	return fishes;
}

function calculateFishValue(rarity) {
	// Based on rarity, randomly calculate the value of the fish
	const baseValue = 5;
	let value = baseValue;
	let startRange = 2;
	let endRange = 10;

	switch (rarity) {
	case 'Common':
		startRange = 2;
		endRange = 10;
		value = Math.floor(Math.random() * ((endRange - startRange) / 5 + 1)) * 5 + startRange;
		break;
	case 'Uncommon':
		startRange = 20;
		endRange = 50;
		value = Math.floor(Math.random() * ((endRange - startRange) / 5 + 1)) * 5 + startRange;
		break;
	case 'Rare':
		startRange = 50;
		endRange = 200;
		value = Math.floor(Math.random() * ((endRange - startRange) / 5 + 1)) * 5 + startRange;
		break;
	case 'Ultra':
		startRange = 500;
		endRange = 750;
		value = Math.floor(Math.random() * ((endRange - startRange) / 5 + 1)) * 5 + startRange;
		break;
	case 'Giant':
		startRange = 1000;
		endRange = 2500;
		value = Math.floor(Math.random() * ((endRange - startRange) / 5 + 1)) * 5 + startRange;
		break;
	case 'Legendary':
		startRange = 3000;
		endRange = 5500;
		value = Math.floor(Math.random() * ((endRange - startRange) / 5 + 1)) * 5 + startRange;
		break;
	case 'Lucky':
		startRange = 10000;
		endRange = 20000;
		value = Math.floor(Math.random() * ((endRange - startRange) / 5 + 1)) * 5 + startRange;
		break;
	default:
		value = Math.floor(Math.random() * ((endRange - startRange) / 5 + 1)) * 5 + startRange;
	}
	return value;
}

function generateFishIcon() {
	return {
		'animated': false,
		'data': 'rawfish:1209352519726276648',
	};
}

// size in cm, weight in kg
function getFishStats(name) {
	const stats = {
		'Seabass': { minSize: 30, maxSize: 70, minWeight: 1, maxWeight: 5, baseValue: 5 },
		'Sardine': { minSize: 10, maxSize: 20, minWeight: 0.02, maxWeight: 0.1, baseValue: 5 },
		'Tuna': { minSize: 100, maxSize: 200, minWeight: 30, maxWeight: 100, baseValue: 50 },
		'Anchovy': { minSize: 10, maxSize: 20, minWeight: 0.02, maxWeight: 0.1, baseValue: 10 },
		'Swordfish': { minSize: 150, maxSize: 300, minWeight: 50, maxWeight: 200, baseValue: 35 },
		'Pufferfish': { minSize: 20, maxSize: 50, minWeight: 0.5, maxWeight: 2, baseValue: 30 },
		'Azure Marlin': { minSize: 200, maxSize: 400, minWeight: 100, maxWeight: 300, baseValue: 30 },
		'Giant Shrimp': { minSize: 20, maxSize: 30, minWeight: 0.1, maxWeight: 0.3, baseValue: 200 },
		'Albacore': { minSize: 50, maxSize: 100, minWeight: 5, maxWeight: 20, baseValue: 300 },
		'Super Cucumber': { minSize: 30, maxSize: 60, minWeight: 1, maxWeight: 3, baseValue: 450 },
		'Kraken': { minSize: 500, maxSize: 1000, minWeight: 500, maxWeight: 1000, baseValue: 100 },
		'Anglerfish': { minSize: 20, maxSize: 40, minWeight: 1, maxWeight: 3, baseValue: 75 },
		'Pearl': { minSize: 1, maxSize: 2, minWeight: 0.01, maxWeight: 0.05, baseValue: 1000 },
		'Magikarp': { minSize: 10, maxSize: 30, minWeight: 0.1, maxWeight: 1, baseValue: 3500 },
		'Salmon': { minSize: 50, maxSize: 100, minWeight: 3, maxWeight: 10, baseValue: 10 },
		'Carp': { minSize: 30, maxSize: 60, minWeight: 2, maxWeight: 5, baseValue: 35 },
		'Catfish': { minSize: 50, maxSize: 150, minWeight: 5, maxWeight: 50, baseValue: 30 },
		'Rainbow Trout': { minSize: 30, maxSize: 60, minWeight: 1, maxWeight: 3, baseValue: 15 },
		'Sturgeon': { minSize: 100, maxSize: 200, minWeight: 20, maxWeight: 100, baseValue: 50 },
		'Shad': { minSize: 20, maxSize: 40, minWeight: 0.5, maxWeight: 2, baseValue: 20 },
		'Dorado': { minSize: 50, maxSize: 100, minWeight: 5, maxWeight: 20, baseValue: 40 },
		'Scorpion Carp': { minSize: 30, maxSize: 60, minWeight: 2, maxWeight: 5, baseValue: 25 },
		'Queen Salmon': { minSize: 70, maxSize: 120, minWeight: 5, maxWeight: 15, baseValue: 350 },
		'King Salmon': { minSize: 70, maxSize: 120, minWeight: 5, maxWeight: 15, baseValue: 350 },
		'Void Salmon': { minSize: 50, maxSize: 100, minWeight: 3, maxWeight: 10, baseValue: 600 },
		'Woodskip': { minSize: 20, maxSize: 40, minWeight: 0.5, maxWeight: 2, baseValue: 20 },
		'Noxclate Fish': { minSize: 30, maxSize: 60, minWeight: 2, maxWeight: 5, baseValue: 700 },
		'Lunafin Fish': { minSize: 20, maxSize: 40, minWeight: 0.5, maxWeight: 2, baseValue: 500 },
		'Bass': { minSize: 30, maxSize: 60, minWeight: 2, maxWeight: 5, baseValue: 20 },
		'Bluegill': { minSize: 10, maxSize: 20, minWeight: 0.1, maxWeight: 0.5, baseValue: 5 },
		'Walleye': { minSize: 40, maxSize: 80, minWeight: 2, maxWeight: 5, baseValue: 25 },
		'Perch': { minSize: 20, maxSize: 40, minWeight: 0.5, maxWeight: 2, baseValue: 10 },
		'Pike': { minSize: 50, maxSize: 100, minWeight: 5, maxWeight: 20, baseValue: 30 },
		'Loach': { minSize: 10, maxSize: 20, minWeight: 0.1, maxWeight: 0.5, baseValue: 5 },
		'Steelhead': { minSize: 50, maxSize: 100, minWeight: 5, maxWeight: 20, baseValue: 40 },
		'Golden Bass': { minSize: 30, maxSize: 60, minWeight: 2, maxWeight: 5, baseValue: 500 },
		'Loch Ness Monster': { minSize: 500, maxSize: 1000, minWeight: 500, maxWeight: 1000, baseValue: 100 },
		'Ogopogo': { minSize: 500, maxSize: 1000, minWeight: 500, maxWeight: 1000, baseValue: 70 },
		'Golden Pike': { minSize: 50, maxSize: 100, minWeight: 5, maxWeight: 20, baseValue: 450 },
		'Golden Loach': { minSize: 10, maxSize: 20, minWeight: 0.1, maxWeight: 0.5, baseValue: 500 },
		'Lost Ring': { minSize: 1, maxSize: 2, minWeight: 0.01, maxWeight: 0.05, baseValue: 1000 },
		'Lost Necklace': { minSize: 1, maxSize: 2, minWeight: 0.01, maxWeight: 0.05, baseValue: 1000 },
		'Guppy': { minSize: 2, maxSize: 5, minWeight: 0.01, maxWeight: 0.05, baseValue: 5 },
		'Frog': { minSize: 5, maxSize: 10, minWeight: 0.1, maxWeight: 0.5, baseValue: 5 },
		'Betta': { minSize: 5, maxSize: 10, minWeight: 0.1, maxWeight: 0.5, baseValue: 10 },
		'Koi': { minSize: 30, maxSize: 60, minWeight: 2, maxWeight: 5, baseValue: 10 },
		'Chub': { minSize: 20, maxSize: 40, minWeight: 0.5, maxWeight: 2, baseValue: 15 },
		'Giant Frog': { minSize: 10, maxSize: 20, minWeight: 0.5, maxWeight: 2, baseValue: 50 },
		'Golden Guppy': { minSize: 2, maxSize: 5, minWeight: 0.01, maxWeight: 0.05, baseValue: 500 },
		'Golden Frog': { minSize: 5, maxSize: 10, minWeight: 0.1, maxWeight: 0.5, baseValue: 500 },
		'Jumbo Koi': { minSize: 50, maxSize: 100, minWeight: 5, maxWeight: 20, baseValue: 400 },
		'Zombie Fish': { minSize: 30, maxSize: 60, minWeight: 2, maxWeight: 5, baseValue: 250 },
		'Golden Chub': { minSize: 20, maxSize: 40, minWeight: 0.5, maxWeight: 2, baseValue: 500 },
		'Platinum Frog': { minSize: 5, maxSize: 10, minWeight: 0.1, maxWeight: 0.5, baseValue: 750 },
		'Lost Wallet': { minSize: 5, maxSize: 10, minWeight: 0.1, maxWeight: 0.5, baseValue: 100 },
		'Lost Phone': { minSize: 5, maxSize: 10, minWeight: 0.1, maxWeight: 0.5, baseValue: 1000 },
		'Swamp Eel': { minSize: 50, maxSize: 100, minWeight: 2, maxWeight: 5, baseValue: 70 },
		'Mud Fish': { minSize: 10, maxSize: 20, minWeight: 0.1, maxWeight: 0.5, baseValue: 30 },
		'Water Snake': { minSize: 50, maxSize: 100, minWeight: 2, maxWeight: 5, baseValue: 60 },
		'Bullfrog': { minSize: 10, maxSize: 20, minWeight: 0.5, maxWeight: 2, baseValue: 30 },
		'Viperfish': { minSize: 20, maxSize: 40, minWeight: 0.5, maxWeight: 2, baseValue: 75 },
		'Bogfish': { minSize: 10, maxSize: 20, minWeight: 0.1, maxWeight: 0.5, baseValue: 20 },
		'Golden Eel': { minSize: 50, maxSize: 100, minWeight: 2, maxWeight: 5, baseValue: 500 },
		'Golden Mudfish': { minSize: 10, maxSize: 20, minWeight: 0.1, maxWeight: 0.5, baseValue: 500 },
		'Crocodile': { minSize: 300, maxSize: 600, minWeight: 200, maxWeight: 500, baseValue: 50 },
		'Alligator': { minSize: 300, maxSize: 600, minWeight: 200, maxWeight: 500, baseValue: 50 },
		'Golden Viperfish': { minSize: 20, maxSize: 40, minWeight: 0.5, maxWeight: 2, baseValue: 500 },
		'Golden Bogfish': { minSize: 10, maxSize: 20, minWeight: 0.1, maxWeight: 0.5, baseValue: 500 },
		'Lost Boot': { minSize: 20, maxSize: 30, minWeight: 0.5, maxWeight: 1, baseValue: 0 },
		'Lost Hat': { minSize: 10, maxSize: 20, minWeight: 0.1, maxWeight: 0.5, baseValue: 0 },
		'Crab': { minSize: 10, maxSize: 20, minWeight: 0.1, maxWeight: 0.5, baseValue: 10 },
		'Clam': { minSize: 5, maxSize: 10, minWeight: 0.05, maxWeight: 0.2, baseValue: 5 },
		'Lobster': { minSize: 20, maxSize: 40, minWeight: 0.5, maxWeight: 2, baseValue: 30 },
		'Oyster': { minSize: 5, maxSize: 10, minWeight: 0.05, maxWeight: 0.2, baseValue: 10 },
		'Octopus': { minSize: 50, maxSize: 100, minWeight: 2, maxWeight: 5, baseValue: 40 },
		'Starfish': { minSize: 10, maxSize: 20, minWeight: 0.1, maxWeight: 0.5, baseValue: 20 },
		'Golden Crab': { minSize: 10, maxSize: 20, minWeight: 0.1, maxWeight: 0.5, baseValue: 500 },
		'Golden Clam': { minSize: 5, maxSize: 10, minWeight: 0.05, maxWeight: 0.2, baseValue: 500 },
		'Jellyfish': { minSize: 20, maxSize: 40, minWeight: 0.5, maxWeight: 2, baseValue: 75 },
		'Sea Serpent': { minSize: 100, maxSize: 200, minWeight: 50, maxWeight: 100, baseValue: 100 },
		'Golden Octopus': { minSize: 50, maxSize: 100, minWeight: 2, maxWeight: 5, baseValue: 600 },
		'Golden Starfish': { minSize: 10, maxSize: 20, minWeight: 0.1, maxWeight: 0.5, baseValue: 500 },
	};

	return stats[name] || { minSize: 10, maxSize: 20, minWeight: 0.1, maxWeight: 0.5, baseValue: 10 };
}

module.exports = buildBaseFish;
