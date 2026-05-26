const { Standing } = require('../models/standing');

class StandingsManager {
    constructor(appContext) {
        this.appContext = appContext;
        this._byClass = {};

        this.getByClass = this.getByClass.bind(this);
    }

    init() {
        const drivers = this.appContext.driverManager.all;
        drivers.forEach(driver => this.addDriver(driver));
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

    addClass(cls) {
        this._byClass[cls] = new Map();
    }

    addDriver(driver) {
        if (!this._byClass[driver.class]) {
            this.addClass(driver.class);
        }
        const standing = new Standing(driver, driver.class);
        this._byClass[driver.class].set(driver.id, standing);
    }
}

module.exports = {
    StandingsManager
};
