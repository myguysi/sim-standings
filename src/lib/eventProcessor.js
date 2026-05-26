const fs = require('fs');
const path = require('path');

class EventProcessor {
    constructor(context) {
        this.context = context;
    }

    processEvent(eventResult, eventIndex, context) {
        const roundId = eventResult.data.subsession_id;
        console.log(`Processing round: ${roundId}`);
        console.group();

        const roundFormat = this.getEventFormat(eventIndex);
        const raceResults = this.getRaceResults(eventResult);

        // Loop through each class and filter the round results for drivers in that class
        this.context.config.classes.forEach(cls => {
            const classDrivers = context.driversByClass[cls];
            const classResults = raceResults.filter(result => {
                return classDrivers.some(driver => driver.id === result.cust_id);
            });

            console.log(`Processing class: ${cls} - ${classDrivers.length} drivers, ${classResults.length} results`);

            const standings = context.getStandingsByClass(cls);
            const standingsArray = Array.from(standings.values());

            // Calculate points for each driver based on their finishing position in class using the league's points system
            classDrivers.forEach((driver) => {
                this.processClassResult(standings, cls, driver, classResults, roundFormat, roundId);
            });

            // Sort the standings table based on total points, and apply tiebreakers if necessary
            const sortedStandings = this.sortStandings(standingsArray, cls, roundFormat);

            // Calculate position changes compared to the previous round
            sortedStandings.forEach(this.calculatePositionChange);

            // Save standings after each round
            context.writeStandings(cls, eventIndex + 1, sortedStandings);
        });

        console.groupEnd();
    }

    getFinishPoints(position, status, pointsSystem) {
        if (!position) {
            return { points: 0, reason: 'DNS' }; // No points if position is not available (e.g. did not attend)
        }
        if (status !== 'Running') {
            return { points: 0, reason: status }; // No points for DNF, DNS, DSQ, etc.
        }
        return {
            points: pointsSystem.finishPosition[position - 1] || pointsSystem.finishPositionDefault,
            reason: `Finished P${position}`,
        };
    }

    // TODO: Split out points allocation into a separate class to support different types of points.
    // For example, we could have FinishPointsCalculator, FastestLapPointsCalculator, PolePositionPointsCalculator, etc.
    // that all implement a common interface for calculating points based on different criteria. This would allow us to
    // easily add new types of points in the future without modifying the core round processing logic.
    processClassResult(standings, cls, driver, results, roundFormat, roundId) {
        const driverStanding = standings.get(driver.id);

        // Find the driver's result in the round results and calculate points based on finishing position
        const resultIndex = results.findIndex(r => r.cust_id === driver.id);
        const { points, reason } = this.getFinishPoints(resultIndex + 1, results[resultIndex]?.reason_out, roundFormat.pointsSystem);

        // Update the standings table with the points from each round
        driverStanding.points += points;
        driverStanding.roundsCounted++;
        driverStanding.roundResults.push({
            roundId,
            points,
            reason,
        });

        // Update dropped rounds if the driver has more rounds than the allowed dropped rounds for the format
        if (driverStanding.roundsCounted > roundFormat.droppedRounds) {
            // Sort the round results to find the lowest points to drop
            const sortedRoundResults = driverStanding.roundResults.slice().sort((a, b) => a.points - b.points);
            const pointsToDrop = sortedRoundResults[0].points; // Drop the lowest points
            driverStanding.points -= pointsToDrop; // Remove the dropped points from total
        }
    }

    sortStandings(standings, cls, roundFormat) {
        const sortedStandings = standings.sort((a, b) => {
            if (b.points !== a.points) {
                return b.points - a.points; // Sort by points descending
            }
            // Tiebreaker: number of wins (assuming we have that data, otherwise skip)
            const aWins = a.roundResults.filter(r => r.points === roundFormat.pointsSystem.finishPosition[0]).length;
            const bWins = b.roundResults.filter(r => r.points === roundFormat.pointsSystem.finishPosition[0]).length;
            if (bWins !== aWins) {
                return bWins - aWins; // Sort by wins descending
            }
            // Additional tiebreakers can be added here (e.g. number of second places, etc.)
            return 0; // If still tied, maintain current order
        });
        return sortedStandings;
    }

    calculatePositionChange(driverStanding, index) {
        driverStanding.lastPosition = driverStanding.position; // Store last position before updating
        const previousPosition = driverStanding.lastPosition;
        const currentPosition = index + 1;
        if (previousPosition === null) {
            driverStanding.positionChange = 0; // No change for the first round
        } else {
            driverStanding.positionChange = previousPosition - currentPosition; // Positive if moved up, negative if moved down
        }
        driverStanding.position = currentPosition; // Update current position
    }

    getEventFormat(eventIndex) {
        const formatId = this.context.config.events[eventIndex].format;
        const roundFormat = this.context.config.formats.find(format => format.id === formatId);
        if (!roundFormat) {
            throw new Error(`Format ${formatId} not found in league configuration`);
        }
        return roundFormat;
    }

    getRaceResults(round) {
        const raceSession = round.data.session_results.find((session) => session.simsession_name === "RACE");
        if (!raceSession) {
            throw new Error(`Race session not found for round ${round.data.subsession_id}`);
        }
        return raceSession.results;
    }
}

module.exports = {
    EventProcessor
};
