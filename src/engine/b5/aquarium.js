// The 5B aquarium (step C.10). Until it lands, the shop's Aquarium tab is empty (hidden).
async function shopTab() {
	return null;
}

async function buyFromShop() {
	return { ok: false, code: 'UNAVAILABLE', message: 'Nothing to buy here yet.' };
}

module.exports = { shopTab, buyFromShop };
