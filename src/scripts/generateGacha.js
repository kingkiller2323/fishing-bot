// Seed data now lives in src/bootstrap/data and is inserted idempotently on bot startup.
// Kept as a shortcut: inserts only the missing 'gacha' rows, safe to run repeatedly.
require('./seed').run(['gacha']).catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
