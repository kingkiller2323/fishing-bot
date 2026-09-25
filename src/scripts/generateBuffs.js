// Seed data now lives in src/bootstrap/data and is inserted idempotently on bot startup.
// Kept as a shortcut: inserts only the missing 'buffs' rows, safe to run repeatedly.
require('./seed').run(['buffs']).catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
