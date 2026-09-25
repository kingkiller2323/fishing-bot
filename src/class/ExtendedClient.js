const { Client, Collection, GatewayIntentBits } = require("discord.js");
const config = require('../config');
const commands = require("../handlers/commands");
const events = require("../handlers/events");
const deploy = require("../handlers/deploy");
const mongoose = require("../handlers/mongoose");
const components = require("../handlers/components");
const { bootstrap } = require("../bootstrap");
const { Utils } = require("./Utils");

module.exports = class extends Client {
    collection = {
        interactioncommands: new Collection(),
        prefixcommands: new Collection(),
        aliases: new Collection(),
        components: {
            buttons: new Collection(),
            selects: new Collection(),
            modals: new Collection(),
            autocomplete: new Collection()
        }
    };
    applicationcommandsArray = [];

    constructor() {
        super({
            // Slash commands, buttons, select menus, modals and autocomplete arrive as interactions,
            // which only need the Guilds intent (guild/channel cache). No privileged intents.
            intents: [GatewayIntentBits.Guilds],
            presence: {
                activities: [{
                    name: 'fishing',
                    type: 4,
                    state: 'fishing'
                }]
            }
        });
    };

    start = async () => {
        commands(this);
        events(this);
        components(this);

        if (config.handler.mongodb.enabled) {
            // Connect and seed/validate static game data before accepting any interactions.
            try {
                await mongoose();
                await bootstrap();
            }
            catch (error) {
                Utils.log(`Startup aborted: ${error.stack || error}`, 'err');
                process.exit(1);
            }
        }

        await this.login(process.env.CLIENT_TOKEN || config.client.token);

        if (config.handler.deploy) deploy(this, config);
    };
};