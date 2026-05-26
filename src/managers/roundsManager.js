const fs = require('fs');
const path = require('path');

class RoundsManager {
    constructor(leagueManager) {
        this.leagueManager = leagueManager;
        this.rounds = [];
    }

    loadFromDirectory(roundsDir) {
        fs.readdirSync(roundsDir)
          .filter(file => file.endsWith('.json'))
          .sort()
          .map(file => path.join(roundsDir, file))
          .map(this.loadFromFile.bind(this));
    }

    loadFromFile(filePath) {
        const roundData = fs.readFileSync(filePath, 'utf-8');
        const round = JSON.parse(roundData);
        this.rounds.push(round);
    }
}

module.exports = {
    RoundsManager
};
