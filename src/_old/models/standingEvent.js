const { PointsAllocation } = require('./pointsAllocation');

class StandingEvent {
    constructor(data) {
        this.eventId = data.eventId;
        this.pointsAllocations = [];
    }

    get totalPoints() {
        return this.pointsAllocations.reduce((total, allocation) => total + allocation.points, 0);
    }

    addPoints(allocationData) {
        const allocation = new PointsAllocation(allocationData);
        this.pointsAllocations.push(allocation);
        return allocation;
    }
}

module.exports = {
    StandingEvent
};
