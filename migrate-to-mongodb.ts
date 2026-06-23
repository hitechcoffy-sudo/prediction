import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/tml-prediction-game";

// Reuse models for migration
const MatchSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  homeTeam: { type: String, required: true },
  awayTeam: { type: String, required: true },
  homeFlag: { type: String, default: '⚽' },
  awayFlag: { type: String, default: '⚽' },
  stage: { type: String, required: true },
  status: { type: String, enum: ['Open', 'Locked', 'Finished', 'Cancelled'], required: true },
  kickoffTime: { type: String, required: true },
  homeScore: { type: Number, default: null },
  awayScore: { type: Number, default: null },
  shootoutWinner: { type: String, default: null },
  isCustom: { type: Boolean, default: false },
  createdAt: { type: String },
  updatedAt: { type: String }
}, { _id: false });

const PredictionSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  userId: { type: String, required: true },
  userEmail: { type: String, required: true },
  displayName: { type: String, required: true },
  matchId: { type: String, required: true },
  homePredicted: { type: Number, required: true },
  awayPredicted: { type: Number, required: true },
  shootoutWinner: { type: String, default: null },
  pointsAwarded: { type: Number, default: null },
  status: { type: String, enum: ['Pending', 'ExactCorrect', 'WinnerCorrect', 'Incorrect'], default: 'Pending' },
  updatedAt: { type: String }
}, { _id: false });

const MatchModel = mongoose.model('Match', MatchSchema);
const PredictionModel = mongoose.model('Prediction', PredictionSchema);

async function runMigration() {
  console.log("Connecting to MongoDB Atlas...");
  await mongoose.connect(mongoUri);
  console.log("Connected successfully to MongoDB database.");

  const __dirname = path.resolve();

  // 1. Migrate Matches
  const matchesPath = path.join(__dirname, 'matches.json');
  if (fs.existsSync(matchesPath)) {
    console.log("Loading matches.json...");
    const matchesRaw = fs.readFileSync(matchesPath, 'utf-8');
    let matchesData = JSON.parse(matchesRaw);

    // If matchesData is a Firestore export object, convert it to an array
    let matchesArray: any[] = [];
    if (Array.isArray(matchesData)) {
      matchesArray = matchesData;
    } else if (typeof matchesData === 'object') {
      matchesArray = Object.entries(matchesData).map(([key, val]: [string, any]) => {
        return { id: key, ...val };
      });
    }

    console.log(`Found ${matchesArray.length} matches to migrate. Upserting into MongoDB...`);
    let migratedCount = 0;
    for (const match of matchesArray) {
      const matchId = match.id || match.matchId || match._id;
      if (!matchId) continue;
      
      const cleanMatch = {
        _id: matchId,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        homeFlag: match.homeFlag || '⚽',
        awayFlag: match.awayFlag || '⚽',
        stage: match.stage,
        status: match.status,
        kickoffTime: match.kickoffTime,
        homeScore: match.homeScore !== undefined ? match.homeScore : null,
        awayScore: match.awayScore !== undefined ? match.awayScore : null,
        shootoutWinner: match.shootoutWinner || null,
        isCustom: match.isCustom || false,
        createdAt: match.createdAt || new Date().toISOString(),
        updatedAt: match.updatedAt || new Date().toISOString()
      };

      await MatchModel.updateOne({ _id: matchId }, { $set: cleanMatch }, { upsert: true });
      migratedCount++;
    }
    console.log(`✅ Successfully migrated/updated ${migratedCount} matches.`);
  } else {
    console.log("ℹ️ matches.json not found in the root directory. Skipping matches migration.");
  }

  // 2. Migrate Predictions
  const predictionsPath = path.join(__dirname, 'predictions.json');
  if (fs.existsSync(predictionsPath)) {
    console.log("Loading predictions.json...");
    const predictionsRaw = fs.readFileSync(predictionsPath, 'utf-8');
    let predictionsData = JSON.parse(predictionsRaw);

    let predictionsArray: any[] = [];
    if (Array.isArray(predictionsData)) {
      predictionsArray = predictionsData;
    } else if (typeof predictionsData === 'object') {
      predictionsArray = Object.entries(predictionsData).map(([key, val]: [string, any]) => {
        return { id: key, ...val };
      });
    }

    console.log(`Found ${predictionsArray.length} predictions to migrate. Upserting into MongoDB...`);
    let migratedCount = 0;
    for (const pred of predictionsArray) {
      const predId = pred.id || pred.predictionId || pred._id;
      if (!predId) continue;

      const cleanPred = {
        _id: predId,
        userId: pred.userId,
        userEmail: pred.userEmail || '',
        displayName: pred.displayName || 'TML Brother',
        matchId: pred.matchId,
        homePredicted: Number(pred.homePredicted),
        awayPredicted: Number(pred.awayPredicted),
        shootoutWinner: pred.shootoutWinner || null,
        pointsAwarded: pred.pointsAwarded !== undefined ? pred.pointsAwarded : null,
        status: pred.status || 'Pending',
        updatedAt: pred.updatedAt || new Date().toISOString()
      };

      await PredictionModel.updateOne({ _id: predId }, { $set: cleanPred }, { upsert: true });
      migratedCount++;
    }
    console.log(`✅ Successfully migrated/updated ${migratedCount} predictions.`);
  } else {
    console.log("ℹ️ predictions.json not found in the root directory. Skipping predictions migration.");
  }

  console.log("Data migration process complete.");
  await mongoose.disconnect();
  console.log("Disconnected from MongoDB.");
}

runMigration().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
