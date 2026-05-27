class PointsAllocation {
    constructor(data) {
        this.driverId = data.driverId;
        this.eventId = data.eventId;
        this.points = data.points;
        this.reason = data.reason;
    }
}

module.exports = {
    PointsAllocation
};
