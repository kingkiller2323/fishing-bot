// Silences the bot's console logging during tests; restore() re-enables it.
const original = { log: console.log, warn: console.warn, error: console.error };
const noop = () => undefined;
function quiet() {
	console.log = noop;
	console.warn = noop;
	console.error = noop;
}
function restore() {
	Object.assign(console, original);
}
module.exports = { quiet, restore };
