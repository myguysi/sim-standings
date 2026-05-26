const fs = require('fs');
const path = require('path');

class ResultsManager {
    constructor(appContext) {
        this.appContext = appContext;
        this.events = [];
    }

    init () {
        this.events = this.appContext.assetsManager.loadEvents();
    }
}

module.exports = {
    ResultsManager
};
