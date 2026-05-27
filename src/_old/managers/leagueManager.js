const fs = require('fs');
const path = require('path');

const { AssetManager } = require('./assetManager');
const { ConfigManager } = require('./configManager');
const { DriverManager } = require('./driverManager');
const { ResultsManager } = require('./resultsManager');
const { StandingsManager } = require('./standingsManager');

const { EventProcessor } = require('../lib/eventProcessor');

class LeagueManager {
    constructor() {
        console.log('Creating league manager...');
        console.group();

        this.assetsManager = new AssetManager(this);
        this.configManager = new ConfigManager(this);
        this.driverManager = new DriverManager(this);
        this.resultsManager = new ResultsManager(this);
        this.standingsManager = new StandingsManager(this);

        this.init();

        console.log('Ready');
        console.groupEnd();
    }

    init () {
        console.log('Initializing...');

        this.assetsManager.init();
        this.configManager.init();
        this.driverManager.init();
        this.resultsManager.init();
        this.standingsManager.init();

        console.log('Initialization complete');
    }

    processRounds() {
        const context = {
            config: this.configManager.config,
            driversByClass: this.driverManager.byClass,
            getStandingsByClass: this.standingsManager.getByClass,
            events: this.resultsManager.events,
            writeStandings: this.assetsManager.writeStandings
        };

        console.log(`Processing ${context.config.events.length} events...`);
        console.group();

        const eventProcessor = new EventProcessor(context);
        context.events.forEach((eventResult, index) => eventProcessor.processEvent(eventResult, index, context));

        console.groupEnd();
        console.log('Processing complete');
    }
}

module.exports = {
    LeagueManager
};
