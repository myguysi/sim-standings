const { Standing } = require('../models/standing');

class StandingsManager {
    constructor(leagueManager) {
        this.leagueManager = leagueManager;
        this._byClass = {};

        this.getByClass = this.getByClass.bind(this);
    }

    initClass(cls) {
        this._byClass[cls] = new Map();
    }

    getByClass(cls) {
        return this._byClass[cls];
    }

    getByDriver(driver) {
        const classStandings = this._byClass[driver.class];
        if (!classStandings) {
            throw new Error(`Class ${driver.class} not found in standings manager`);
        }
        return classStandings.get(driver.id);
    }

    addDrivers(drivers) {
        drivers.forEach(driver => this.addDriver(driver));
    }

    addDriver(driver) {
        if (!this._byClass[driver.class]) {
            this.initClass(driver.class);
        }
        const standing = new Standing(driver, driver.class);
        this._byClass[driver.class].set(driver.id, standing);
    }
}

module.exports = {
    StandingsManager
};
