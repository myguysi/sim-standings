const { StandingEvent } = require('./standingEvent');

class Standing {
    constructor(driver, cls) {
        this.driver = driver;
        this.class = cls;
        this.points = 0;
        this.roundsCounted = 0;
        this.roundResults = []; // To track points from each round for dropped rounds calculation
        this.position = null; // Current position in the standings
        this.lastPosition = null; // To track position from the previous round for position change calculation

        this.events = []; // List of StandingEvent instances for this driver
    }

    addEvent(eventData) {
        const standingEvent = new StandingEvent(eventData);
        this.events.push(standingEvent);
        return standingEvent;
    }
}

module.exports = {
    Standing
};
