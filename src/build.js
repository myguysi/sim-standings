/**
 * Sim Racing League - Results Processor
 *
 * Processes raw race event results into per-class driver standings for a given season.
 *
 * Pipeline overview:
 *   1. Load event results and driver registry for the season (store)
 *   2. Split results into per-class groups (partitioner)
 *   3. For each class:
 *      a. Assign points to each result (eventProcessor)
 *      b. Group results by driver (partitioner)
 *      c. Apply drop rounds, calculate totals, and rank drivers (standingsBuilder)
 *   4. Save standings for each class (store)
 *
 * Entry point: processSeasonToDate()
 *
 * Key interfaces:
 *
 *   EventResult       — raw input, one record per driver per race
 *                       { driverId, finishPosition, startPosition, fastestLapTime }
 *
 *   ProcessedResult   — EventResult with points assigned
 *                       { ...EventResult, points }
 *
 *   DriverStanding    — a driver with their collection of processed races
 *                       { driverId, results: ProcessedResult[], totalPoints, position }
 *
 *   ClassStandings    — a class name paired with its ranked driver standings
 *                       { className, standings: DriverStanding[] }
 *
 *   Driver            — registry entry, used to resolve class membership
 *                       { id, name, team, class }
 *
 * WIP: Currently a single-file implementation, to be split into modules:
 *   - eventProcessor.js
 *   - standingsBuilder.js
 *   - partitioner.js
 *   - store.js
 *   - coordinator.js
 */

const fs = require('fs');

// eventProcessor.js

const pointsForPosition = [100, 90, 80, 72, 66, 60, 54, 48, 42, 36, 30, 26, 22, 18, 14, 10, 8, 6, 4, 2];
const pointsForPole = 0;
const pointsForFastestLap = 0;
const minLapsCompletedPercentage = 0.75;

function assignFinishPoints(eventResult, eventIndex) {
    const sortedByFinish = [...eventResult].sort((a, b) => a.finishPositionOverall - b.finishPositionOverall);
    const scoringResults = sortedByFinish.filter((r) => {
        return ['Running', 'Disconnected'].includes(r.status) && r.lapsCompletePercentage >= minLapsCompletedPercentage;
    });
    scoringResults.forEach((result, index) => {
        let points = pointsForPosition[index] ?? 0;
        if (eventIndex >= 7) {
            points = points * 1.5; // 1.5x points for final 3 rounds
        }
        result.points += points;
        result.pointsAllocations.push({ reason: `Finish P${index + 1}`, points });
        result.finishPositionClass = index + 1;
    });
    return eventResult;
}

function assignPolePoints(eventResult, eventIndex) {
    const sortedByStart = [...eventResult].sort((a, b) => a.startPositionOverall - b.startPositionOverall);
    sortedByStart[0].points += pointsForPole;
    sortedByStart[0].pointsAllocations.push({ reason: 'Pole Position', points: pointsForPole });
    eventResult.forEach((result, index) => {
        result.startPositionClass = index + 1;
    });
    return eventResult;
}

function assignFastestLapPoints(eventResult, eventIndex) {
    const sortedByFastest = [...eventResult].sort((a, b) => a.fastestLapTime - b.fastestLapTime);
    sortedByFastest[0].points += pointsForFastestLap;
    sortedByFastest[0].pointsAllocations.push({ reason: 'Fastest Lap', points: pointsForFastestLap });
    return eventResult;
}

const eventStages = [assignFinishPoints, assignPolePoints, assignFastestLapPoints];

function processEvent(eventResult, eventIndex) {
    return eventStages.reduce((r, fn) => fn(r, eventIndex), eventResult);
}


// standingsBuilder.js

function calculateTotals(driverStandings) {
    return driverStandings.map((standing) => {
        const totalPoints = standing.results.reduce((sum, result) => sum + result.points, 0);
        return { ...standing, totalPoints };
    });
}

function applyDropRounds(driverStandings) {
    return driverStandings.map((standing) => {
        const eligibleResults = standing.results.slice(0, 7); // Only drop from the first 7 rounds
        const sortedResults = eligibleResults.sort((a, b) => a.points - b.points);
        const droppedResults = sortedResults.slice(0, 1); // Drop the lowest-scoring round
        const droppedPoints = droppedResults.reduce((sum, result) => sum + result.points, 0);
        const totalPoints = standing.totalPoints - droppedPoints;
        return { ...standing, totalPoints, droppedResults };
    });
    return driverStandings;
}

function rankDrivers(driverStandings) {
    return driverStandings.sort((a, b) => b.totalPoints - a.totalPoints);
}

const standingsStages = [calculateTotals, applyDropRounds, rankDrivers];

function buildStandings(driverStandings) {
    return standingsStages.reduce((s, fn) => fn(s), driverStandings);
}


// transformers.js

function parseResults(eventResult, driverRegistry) {
    const totalLaps = eventResult[0].laps_complete;

    // Map raw event results to ProcessedResult format
    const results = eventResult.map((r) => ({
        driverId: r.cust_id,
        driverName: r.display_name,
        finishPositionOverall: r.finish_position,
        finishPositionClass: null, // To be calculated later
        startPositionOverall: r.starting_position,
        startPositionClass: null, // To be calculated later
        fastestLapTime: r.best_lap_time > 0 ? r.best_lap_time : Number.POSITIVE_INFINITY,
        status: r.reason_out,
        points: 0,
        pointsAllocations: [],
        lapsComplete: r.laps_complete,
        lapsCompletePercentage: Math.round(r.laps_complete / totalLaps * 100) / 100,
    }));

    // Calculate class start positions
    results
        .sort((a, b) => a.startPositionOverall - b.startPositionOverall)
        .forEach((result, index) => {
            result.startPositionOverall = index + 1;
        });

    // Calculate class finish positions
    results
        .sort((a, b) => a.finishPositionOverall - b.finishPositionOverall)
        .forEach((result, index) => {
            result.finishPositionOverall = index + 1;
        });
    
    // Add DNS entries for any drivers in the registry who are missing from the results
    const participants = results.map((r) => r.driverId);
    const missingDrivers = Array.from(driverRegistry.values()).filter((d) => !participants.includes(d.id));
    missingDrivers.forEach((d) => {
        results.push({
            driverId: d.id,
            driverName: d.name,
            finishPositionOverall: null,
            finishPositionClass: null,
            startPositionOverall: null,
            startPositionClass: null,
            fastestLapTime: null,
            status: 'DNS',
            points: 0,
            pointsAllocations: [],
            lapsComplete: 0,
            lapsCompletePercentage: 0,
        });
    });

    return results;
}

function splitIntoClasses(allEventResults, driverRegistry) {
    const map = new Map();

    allEventResults.forEach((eventResult, eventIndex) => {
        const raceSession = eventResult.data.session_results.find((sr) => sr.simsession_name === 'RACE');
        const results = raceSession.results;

        results.forEach((result) => {
            const driver = driverRegistry.get(result.cust_id);
            if (!driver) {
                throw new Error(`No driver found for ${result.display_name} (${result.cust_id})`);
            }
            const existing = map.get(driver.class) ?? { className: driver.class, eventResults: [] };
            const results = [...existing.eventResults];
            if (!results[eventIndex]) {
                results[eventIndex] = [];
            }
            results[eventIndex].push(result);
            const updated = { ...existing, eventResults: results };
            map.set(driver.class, updated);
        });
    });

    return [...map.values()];
}

function groupByDriver(processedRaces) {
    const map = new Map();

    processedRaces.forEach((race) => {
        race.forEach((result) => {
            const existing = map.get(result.driverId) ?? { driverId: result.driverId, driverName: result.driverName, totalPoints: 0, results: [], droppedResults: [] };
            map.set(result.driverId, { ...existing, results: [...existing.results, result] });
        });
    });

    return [...map.values()];
}


// store.js

function getEventResults() {
    const files = fs.readdirSync(`assets/events`).filter(file => file.endsWith('.json')).sort();
    const dataArr = files.map((file) => fs.readFileSync(`assets/events/${file}`, 'utf-8'));
    return dataArr.map((d) => JSON.parse(d));
}

function getDrivers() {
    const file = fs.readFileSync(`assets/drivers.json`, 'utf-8');
    return JSON.parse(file);
}

function saveStandings(classId, classStandings) {
    fs.writeFileSync(`public/standings/${classId}.json`, JSON.stringify(classStandings, null, 2));
}

function clearStandings() {
    const dir = 'public/standings';
    if (fs.existsSync(dir)) {
        fs.readdirSync(dir).forEach((file) => fs.unlinkSync(`${dir}/${file}`));
    } else {
        fs.mkdirSync(dir, { recursive: true });
    }
}


// coordinator.js

function processClass({ className, eventResults }, driverRegistry) {
    const parsedEvents = eventResults.map((eventResult) => parseResults(eventResult, driverRegistry));
    const processedEvents = parsedEvents.map((event, index) => processEvent(event, index));
    const groupedByDriver = groupByDriver(processedEvents);
    const standings = buildStandings(groupedByDriver);
    return { className, standings };
}

function processSeasonToDate() {
    // Clear previous outputs
    clearStandings();

    // Load inputs
    const allEventResults = getEventResults();
    const drivers = getDrivers();
    const driverRegistry = new Map(drivers.map((d) => [d.id, d])); // Map<driverId, { id, name, team, class }>

    // Process data
    const classes = splitIntoClasses(allEventResults, driverRegistry);
    const classStandings = classes.map((classData) => processClass(classData, driverRegistry));

    // Save outputs
    classStandings.forEach(({ className, standings }) => {
        saveStandings(className, standings);
    });
}


// app.js

processSeasonToDate();
console.log('Build complete!');
