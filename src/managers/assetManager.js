const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '../..');

const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
const EVENTS_DIR = path.join(ASSETS_DIR, 'events');
const DRIVERS_FILE = path.join(ASSETS_DIR, 'drivers.json');
const CONFIG_FILE = path.join(ASSETS_DIR, 'config.json');

const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

class AssetManager {
    constructor(appContext) {
        this.appContext = appContext;

        this.writeStandings = this.writeStandings.bind(this);
    }

    init() {
        if (!fs.existsSync(CONFIG_FILE)) {
            throw new Error(`Config file not found at ${CONFIG_FILE}`);
        }

        if (!fs.existsSync(DRIVERS_FILE)) {
            throw new Error(`Drivers file not found at ${DRIVERS_FILE}`);
        }

        if (!fs.existsSync(EVENTS_DIR)) {
            throw new Error(`Events directory not found at ${EVENTS_DIR}`);
        }

        if (!fs.existsSync(PUBLIC_DIR)) {
            fs.mkdirSync(PUBLIC_DIR);
        } else {
            fs.readdirSync(PUBLIC_DIR).forEach(file => fs.unlinkSync(path.join(PUBLIC_DIR, file)));
        }
    }

    loadConfig() {
        return this.loadJsonFile(CONFIG_FILE);
    }

    loadDrivers() {
        return this.loadJsonFile(DRIVERS_FILE);
    }

    loadEvents() {
        const filePaths = this.readDirectoryFiles(EVENTS_DIR)
                              .filter(file => file.endsWith('.json'))
                              .sort();
        return filePaths.map(filePath => this.loadJsonFile(filePath));
    }

    writeStandings(cls, roundNumber, standings) {
        const roundPath = path.join(PUBLIC_DIR, `${cls}_round_${roundNumber}.json`);
        this.writeJsonFile(roundPath, standings);

        const latestPath = path.join(PUBLIC_DIR, `${cls}_latest.json`);
        this.writeJsonFile(latestPath, standings);
    }

    loadJsonFile(filePath) {
        try {
            const data = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            console.error(`Error reading file ${filePath}:`, error);
            return null;
        }
    }

    writeJsonFile(filePath, data) {
        try {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error(`Error writing file ${filePath}:`, error);
        }
    }

    readDirectoryFiles(dirPath) {
        try {
            const files = fs.readdirSync(dirPath);
            return files.map(file => path.join(dirPath, file));
        } catch (error) {
            console.error(`Error reading directory ${dirPath}:`, error);
            return [];
        }
    }
}

module.exports = {
    AssetManager
};
