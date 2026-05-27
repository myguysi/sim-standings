const fs = require('fs');

class ConfigManager {
    constructor(appContext) {
        this.appContext = appContext;
        this.config = null;
    }

    init() {
        this.config = this.appContext.assetsManager.loadConfig();
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
