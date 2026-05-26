const fs = require('fs');
const { Driver } = require('../models/driver');

class DriverManager {
    constructor(leagueManager) {
        this.leagueManager = leagueManager;
        this._drivers = [];
    }

    init() {
        const driversData = this.leagueManager.assetsManager.loadDrivers();
        driversData.forEach(driverData => this.add(driverData));
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
}

module.exports = { DriverManager };
