class Standing {
    constructor(driver, cls) {
        this.driver = driver;
        this.class = cls;
        this.points = 0;
        this.roundsCounted = 0;
        this.roundResults = []; // To track points from each round for dropped rounds calculation
        this.position = null; // Current position in the standings
        this.lastPosition = null; // To track position from the previous round for position change calculation
    }
}

module.exports = {
    Standing
};
