const fs = require('fs');
const { Driver } = require('../models/driver');

class DriverManager {
    constructor(leagueManager) {
        this.leagueManager = leagueManager;
        this._drivers = [];
    }

    get all() {
        return this._drivers;
    }

    get byClass() {
        return this._drivers.reduce((acc, driver) => {
            if (!acc[driver.class]) {
                acc[driver.class] = [];
            }
            acc[driver.class].push(driver);
            return acc;
        }, {});
    }

    find(driverId) {
        return this._drivers.find(driver => driver.id === driverId);
    }

    add(driverData) {
        const driver = new Driver(driverData);
        this._drivers.push(driver);
    }

    loadFromFile(filePath) {
        const driversData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        driversData.forEach(driverData => this.add(driverData));
    }
}

module.exports = { DriverManager };
