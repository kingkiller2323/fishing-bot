// Central protection policy for destructive fish operations (sell, bulk sell, adopt, discard,
// future auto-sell/trade). Every path that removes a fish from a player must go through here;
// only an explicit `{ force: true }` (admin/developer tooling) may bypass it.

class ProtectedFishError extends Error {
	constructor(fish) {
		const list = [].concat(fish);
		super(`Protected fish cannot be removed: ${list.map((f) => f?.name || f?._id).join(', ')}`);
		this.name = 'ProtectedFishError';
		this.code = 'FISH_PROTECTED';
		this.fish = list;
	}
}

/** A fish is protected while the player has it locked. */
function isProtected(fish) {
	return Boolean(fish && fish.locked);
}

/** Splits fish into those that may be destroyed and those that are protected. */
function partitionProtected(fishList, { force = false } = {}) {
	const allowed = [];
	const protectedFish = [];
	for (const fish of fishList) {
		if (!fish) continue;
		if (!force && isProtected(fish)) protectedFish.push(fish);
		else allowed.push(fish);
	}
	return { allowed, protected: protectedFish };
}

/** Throws ProtectedFishError unless the fish may be destroyed. */
function assertRemovable(fish, { force = false } = {}) {
	if (!force && isProtected(fish)) throw new ProtectedFishError(fish);
}

module.exports = { isProtected, partitionProtected, assertRemovable, ProtectedFishError };
