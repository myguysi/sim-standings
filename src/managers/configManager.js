const fs = require('fs');

class ConfigManager {
    constructor(leagueManager) {
        this.leagueManager = leagueManager;
        this.config = null;
    }

    loadFromFile(configFilePath) {
        try {
            const configData = fs.readFileSync(configFilePath, 'utf-8');
            this.config = JSON.parse(configData);
            console.log('Configuration loaded successfully');
        } catch (error) {
            console.error('Error loading configuration:', error);
            throw error;
        }
    }
}

module.exports = {
    ConfigManager
};
