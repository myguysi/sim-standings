# Sim Standings

A Node.js application for processing and calculating racing league standings from race event results. This tool takes raw race data and generates standings for different driver classes (club, intermediate, and pro) across multiple racing formats.

## Features

- **Multi-Format Support**: Handle multiple round formats (e.g., Sprint, Showdown) with different points systems
- **Multiple Driver Classes**: Separate standings for different driver classes (e.g. Club, Inter and Pro)
- **Flexible Points Systems**: Configure custom points for finishing positions, fastest lap, and pole position
- **Dropped Rounds**: Support for dropping worst-performing rounds from final calculations
- **JSON-Based Configuration**: Easy-to-read JSON configuration for leagues and drivers
- **Round-by-Round Standings**: Generate standings after each race round

## Prerequisites

- Node.js (v12 or higher)
- npm or yarn

## Installation

1. Clone or download the project
2. Navigate to the project directory:
   ```bash
   cd sim-standings
   ```
3. Install dependencies (if any are added):
   ```bash
   npm install
   ```

## Usage

### Running the Application

```bash
npm start
```

This will:
1. Load the league configuration from `assets/config.json`
2. Load driver information from `assets/drivers.json`
3. Process all race results from `assets/results/` directory
4. Generate standings files in the `output/` directory

### Input Files

#### `assets/config.json`
Defines the league structure, formats, and scoring rules:
- **leagueName**: Name of the racing league
- **formats**: Array of format definitions with:
  - `id`: Unique format identifier
  - `name`: Display name
  - `droppedRounds`: Number of worst rounds to drop from final standings
  - `pointsSystem`: Scoring rules for finish positions, fastest lap, and pole position
- **rounds**: Array of round definitions specifying which format each round uses

**Example**:
```json
{
  "leagueName": "Example League",
  "formats": [
    {
      "id": "sprint",
      "name": "Sprint",
      "droppedRounds": 1,
      "pointsSystem": {
        "finishPosition": [100, 90, 80, 72, ...],
        "fastestLap": 5,
        "polePosition": 5
      }
    }
  ],
  "rounds": [
    { "format": "sprint" },
    { "format": "sprint" }
  ]
}
```

#### `assets/drivers.json`
List of all drivers participating in the league:
- `id`: Unique driver identifier
- `name`: Driver name
- `team`: Team affiliation
- `class`: Driver class (club, inter, or pro)

**Example**:
```json
[
  {
    "id": 1088529,
    "name": "Driver Name",
    "team": "Team Name",
    "class": "club"
  }
]
```

#### `assets/results/`
JSON files containing race results for each event. Files should be named `eventresult-{eventId}.json`.

### Output Files

The application generates standings files in the `output/` directory in the format:
`{class}_round_{roundNumber}.json`

**Example files**:
- `club_round_1.json`
- `inter_round_1.json`
- `pro_round_1.json`
- etc.

**Output format**:
```json
[
  {
    "driver": {
      "id": 467678,
      "name": "Driver Name",
      "class": "club"
    },
    "class": "club",
    "points": 100,
    "roundsCounted": 1,
    "roundResults": [
      {
        "roundId": 84770853,
        "points": 100,
        "reason": "Finished P1"
      }
    ],
    "position": 1,
    "lastPosition": null,
    "positionChange": 0
  }
]
```

## Project Structure

```
sim-standings/
├── src/
│   ├── main.js                 # Entry point
│   └── models/
│       ├── configManager.js    # Handles league configuration
│       ├── driver.js           # Driver model
│       ├── driverManager.js    # Manages driver data
│       ├── leagueManager.js    # Main league orchestrator
│       ├── roundProcessor.js   # Processes individual race rounds
│       ├── roundsManager.js    # Manages round data
│       ├── standing.js         # Standing model
│       └── standingsManager.js # Calculates and manages standings
├── assets/
│   ├── config.json             # League configuration
│   ├── drivers.json            # Driver roster
│   └── results/                # Race event result files
├── output/                     # Generated standings files
├── package.json
└── README.md
```

## Model Classes

- **ConfigManager**: Loads and manages league configuration
- **DriverManager**: Manages driver data and lookups
- **RoundsManager**: Loads and organizes race rounds
- **StandingsManager**: Calculates standings based on race results
- **RoundProcessor**: Processes individual race results and awards points
- **Driver**: Represents a driver with profile information
- **Standing**: Represents a driver's current standing in the league

## Configuration Tips

- **Points Systems**: Adjust the `finishPosition` array to match your desired points distribution
- **Dropped Rounds**: Set `droppedRounds` to allow drivers to drop their worst performances
- **Multiple Formats**: Create different formats for different racing series or championship phases
- **Driver Classes**: Use `class` field to separate drivers into different standings

## Notes

- The application processes results in chronological order based on round definitions
- Standings include position changes from the previous round
- Each standing entry tracks which rounds contributed to the final point total

## License

ISC
