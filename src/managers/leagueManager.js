const fs = require('fs');
const path = require('path');

const { ConfigManager } = require('./configManager');
const { DriverManager } = require('./driverManager');
const { RoundsManager } = require('./roundsManager');
const { StandingsManager } = require('./standingsManager');

const { RoundProcessor } = require('../lib/roundProcessor');

// TODO: Move these paths to a config file or environment variables
const projectRoot = path.resolve(__dirname, '../..');
const assetsDir = path.join(projectRoot, 'assets');
const roundsDir = path.join(assetsDir, 'results');
const driversFilePath = path.join(assetsDir, 'drivers.json');
const configFilePath = path.join(assetsDir, 'config.json');
const outputDir = path.join(projectRoot, 'output');

class LeagueManager {
    constructor() {
        console.log('Creating league manager...');
        console.group();

        this.configManager = new ConfigManager(this);
        this.driverManager = new DriverManager(this);
        this.roundsManager = new RoundsManager(this);
        this.standingsManager = new StandingsManager(this);

        this.init();

        console.groupEnd();
        console.log('League manager ready');
    }

    init () {
        console.log('Initializing...');

        this.setupDirectories();
        this.configManager.loadFromFile(configFilePath);
        this.driverManager.loadFromFile(driversFilePath);
        this.roundsManager.loadFromDirectory(roundsDir);
        this.standingsManager.addDrivers(this.driverManager.all);

        console.log('Initialization complete');
    }

    setupDirectories() {
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        } else {
            fs.readdirSync(outputDir).forEach(file => fs.unlinkSync(path.join(outputDir, file)));
        }
    }

    processRounds() {
        const { rounds } = this.roundsManager;
        console.log(`Processing ${rounds.length} rounds...`);
        console.group();

        const context = {
            config: this.configManager.config,
            driversByClass: this.driverManager.byClass,
            getStandingsByClass: this.standingsManager.getByClass
        };

        const roundProcessor = new RoundProcessor(context);
        rounds.forEach((round, roundIndex) => roundProcessor.processRound(round, roundIndex, context));

        console.groupEnd();
        console.log('Processing complete');
    }
}

module.exports = {
    LeagueManager
};
