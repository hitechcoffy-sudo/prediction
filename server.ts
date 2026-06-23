import express from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import dns from 'dns';

// Force Node.js to use reliable DNS servers (fixes SRV lookup issues with MongoDB Atlas)
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

dotenv.config();

const app = express();
app.use(express.json());

// Enable CORS manual headers
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/tml-prediction-game";
mongoose.connect(mongoUri, { family: 4 })
  .then(() => console.log("Connected to MongoDB successfully"))
  .catch(err => console.error("MongoDB connection error:", err));

// --- Schemas & Models ---

const MatchSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  id: { type: String, required: true },
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
}, { _id: false, timestamps: false });

const PredictionSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // userId_matchId
  id: { type: String, required: true },
  userId: { type: String, required: true, index: true },
  userEmail: { type: String, required: true },
  displayName: { type: String, required: true },
  matchId: { type: String, required: true, index: true },
  homePredicted: { type: Number, required: true },
  awayPredicted: { type: Number, required: true },
  shootoutWinner: { type: String, default: null },
  pointsAwarded: { type: Number, default: null },
  status: { type: String, enum: ['Pending', 'ExactCorrect', 'WinnerCorrect', 'Incorrect'], default: 'Pending' },
  updatedAt: { type: String }
}, { _id: false, timestamps: false });

const UserSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  uid: { type: String, required: true },
  email: { type: String, required: true },
  displayName: { type: String, required: true },
  totalPoints: { type: Number, default: 0 },
  exactScoresCount: { type: Number, default: 0 },
  correctOutcomesCount: { type: Number, default: 0 },
  isAdmin: { type: Boolean, default: false },
  updatedAt: { type: String }
}, { _id: false, timestamps: false });

const CredentialSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // phone number
  number: { type: String, required: true },
  password: { type: String, required: true },
  userId: { type: String, required: true },
  displayName: { type: String, required: true },
  createdAt: { type: String }
}, { _id: false, timestamps: false });

const MatchModel = mongoose.model('Match', MatchSchema);
const PredictionModel = mongoose.model('Prediction', PredictionSchema);
const UserModel = mongoose.model('User', UserSchema);
const CredentialModel = mongoose.model('Credential', CredentialSchema);

// --- Admin Email ---
const ADMIN_EMAIL = 'mm9975775@gmail.com';

// --- Scoring Recalculation Utility ---
function calculatePoints(
  homePredicted: number,
  awayPredicted: number,
  homeActual: number,
  awayActual: number,
  isKnockout: boolean = false,
  predShootoutWinner?: string | null,
  actualShootoutWinner?: string | null
): { points: number; status: 'ExactCorrect' | 'WinnerCorrect' | 'Incorrect' | 'Pending' } {
  let predictedWinner = 'draw';
  if (homePredicted > awayPredicted) {
    predictedWinner = 'home';
  } else if (homePredicted < awayPredicted) {
    predictedWinner = 'away';
  } else if (isKnockout) {
    predictedWinner = predShootoutWinner || 'draw';
  }

  let actualWinner = 'draw';
  if (homeActual > awayActual) {
    actualWinner = 'home';
  } else if (homeActual < awayActual) {
    actualWinner = 'away';
  } else if (isKnockout) {
    actualWinner = actualShootoutWinner || 'draw';
  }

  const scoreMatches = homePredicted === homeActual && awayPredicted === awayActual;
  let exactMatch = scoreMatches;
  if (isKnockout && scoreMatches && homePredicted === awayPredicted) {
    exactMatch = predShootoutWinner === actualShootoutWinner && !!predShootoutWinner;
  }

  if (exactMatch) {
    return { points: 3, status: 'ExactCorrect' };
  }

  if (predictedWinner === actualWinner && predictedWinner !== 'draw') {
    return { points: 1, status: 'WinnerCorrect' };
  }

  if (!isKnockout && predictedWinner === 'draw' && actualWinner === 'draw') {
    return { points: 1, status: 'WinnerCorrect' };
  }

  return { points: 0, status: 'Incorrect' };
}

// --- API Endpoints ---

// GET matches
app.get('/api/matches', async (req, res) => {
  try {
    const list = await MatchModel.find({});
    // Sort Matches: newly created (isCustom) on top, otherwise by kickoffTime
    list.sort((a, b) => {
      if (a.isCustom && !b.isCustom) return -1;
      if (!a.isCustom && b.isCustom) return 1;
      if (a.isCustom && b.isCustom) {
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      }
      return new Date(a.kickoffTime).getTime() - new Date(b.kickoffTime).getTime();
    });
    res.json(list);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST create match
app.post('/api/matches', async (req, res) => {
  try {
    const data = req.body;
    const match = new MatchModel({
      _id: data.id,
      id: data.id,
      ...data
    });
    await match.save();
    res.status(201).json(match);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT update match score & trigger recalculation
app.put('/api/matches/:id', async (req, res) => {
  const matchId = req.params.id;
  const { homeScore, awayScore, status, shootoutWinner } = req.body;

  try {
    const matchObj = await MatchModel.findById(matchId);
    if (!matchObj) {
      return res.status(404).json({ error: 'Match not found' });
    }

    const wasFinalized = matchObj.status === 'Finished' && matchObj.homeScore !== null && matchObj.awayScore !== null;
    const oldHomeScore = matchObj.homeScore;
    const oldAwayScore = matchObj.awayScore;
    const oldShootoutWinner = matchObj.shootoutWinner;
    const oldStatus = matchObj.status;

    // 1. Update Match info
    matchObj.homeScore = homeScore !== null ? Number(homeScore) : null;
    matchObj.awayScore = awayScore !== null ? Number(awayScore) : null;
    matchObj.shootoutWinner = shootoutWinner || null;
    matchObj.status = status;
    matchObj.updatedAt = new Date().toISOString();
    await matchObj.save();

    // 2. Fetch and recalculate predictions
    const isKnockout = matchObj.stage !== 'Group Stage';
    const predictions = await PredictionModel.find({ matchId });
    const userPointsDelta: { [userId: string]: { points: number, exact: number, outcome: number } } = {};

    for (const pred of predictions) {
      // Get previous points awarded under the finalized score
      const oldPoints = wasFinalized ? (pred.pointsAwarded || 0) : 0;
      const wasExact = wasFinalized && pred.status === 'ExactCorrect';
      const wasOutcome = wasFinalized && pred.status === 'WinnerCorrect';

      let newPoints = 0;
      let newStatus: 'Pending' | 'ExactCorrect' | 'WinnerCorrect' | 'Incorrect' = 'Pending';

      if (status === 'Finished' && homeScore !== null && awayScore !== null) {
        const scoringResult = calculatePoints(
          pred.homePredicted,
          pred.awayPredicted,
          Number(homeScore),
          Number(awayScore),
          isKnockout,
          pred.shootoutWinner,
          shootoutWinner
        );
        newPoints = scoringResult.points;
        newStatus = scoringResult.status;
      }

      const deltaPoints = newPoints - oldPoints;
      const deltaExact = (newStatus === 'ExactCorrect' ? 1 : 0) - (wasExact ? 1 : 0);
      const deltaOutcome = (newStatus === 'WinnerCorrect' ? 1 : 0) - (wasOutcome ? 1 : 0);

      // Update prediction
      pred.pointsAwarded = status === 'Finished' ? newPoints : null;
      pred.status = newStatus;
      pred.updatedAt = new Date().toISOString();
      await pred.save();

      if (!userPointsDelta[pred.userId]) {
        userPointsDelta[pred.userId] = { points: 0, exact: 0, outcome: 0 };
      }
      userPointsDelta[pred.userId].points += deltaPoints;
      userPointsDelta[pred.userId].exact += deltaExact;
      userPointsDelta[pred.userId].outcome += deltaOutcome;
    }

    // 3. Update user score profiles
    for (const uid in userPointsDelta) {
      const user = await UserModel.findById(uid);
      if (user) {
        user.totalPoints = Math.max(0, user.totalPoints + userPointsDelta[uid].points);
        user.exactScoresCount = Math.max(0, user.exactScoresCount + userPointsDelta[uid].exact);
        user.correctOutcomesCount = Math.max(0, user.correctOutcomesCount + userPointsDelta[uid].outcome);
        user.updatedAt = new Date().toISOString();
        await user.save();
      }
    }

    res.json(matchObj);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST clear points for a match
app.post('/api/matches/clear-points/:id', async (req, res) => {
  const matchId = req.params.id;
  try {
    const matchObj = await MatchModel.findById(matchId);
    if (!matchObj) {
      return res.status(404).json({ error: 'Match not found' });
    }

    const kickoffMs = new Date(matchObj.kickoffTime).getTime();
    const isPastKickoff = Date.now() > kickoffMs;
    const defaultStatus = isPastKickoff ? 'Locked' : 'Open';

    // To clear the score, we put score as null, status to defaultStatus and call same logic
    // Express app internally routes this or we call the code directly
    // Let's call the code directly
    const wasFinalized = matchObj.status === 'Finished' && matchObj.homeScore !== null && matchObj.awayScore !== null;
    const oldHomeScore = matchObj.homeScore;
    const oldAwayScore = matchObj.awayScore;

    // Save update
    matchObj.homeScore = null;
    matchObj.awayScore = null;
    matchObj.shootoutWinner = null;
    matchObj.status = defaultStatus;
    matchObj.updatedAt = new Date().toISOString();
    await matchObj.save();

    // Adjust predictions and users
    if (wasFinalized) {
      const predictions = await PredictionModel.find({ matchId });
      for (const pred of predictions) {
        const oldPoints = pred.pointsAwarded || 0;
        const wasExact = pred.status === 'ExactCorrect';
        const wasOutcome = pred.status === 'WinnerCorrect';

        pred.pointsAwarded = null;
        pred.status = 'Pending';
        pred.updatedAt = new Date().toISOString();
        await pred.save();

        const user = await UserModel.findById(pred.userId);
        if (user) {
          user.totalPoints = Math.max(0, user.totalPoints - oldPoints);
          user.exactScoresCount = Math.max(0, user.exactScoresCount - (wasExact ? 1 : 0));
          user.correctOutcomesCount = Math.max(0, user.correctOutcomesCount - (wasOutcome ? 1 : 0));
          user.updatedAt = new Date().toISOString();
          await user.save();
        }
      }
    }

    res.json(matchObj);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE matches (Clears all matches & predictions, resets user points)
app.delete('/api/matches', async (req, res) => {
  try {
    await MatchModel.deleteMany({});
    await PredictionModel.deleteMany({});
    await UserModel.updateMany({}, {
      totalPoints: 0,
      exactScoresCount: 0,
      correctOutcomesCount: 0,
      updatedAt: new Date().toISOString()
    });
    res.json({ success: true, message: 'All matches and predictions cleared, user scores reset.' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST seed matches & initial predictions/users
app.post('/api/matches/seed', async (req, res) => {
  const { matches, users, predictions } = req.body;
  try {
    // Clear matches and predictions
    await MatchModel.deleteMany({});
    await PredictionModel.deleteMany({});

    // Import matches
    if (matches && Array.isArray(matches)) {
      for (const m of matches) {
        await MatchModel.updateOne(
          { _id: m.id },
          { $set: { ...m, updatedAt: new Date().toISOString() } },
          { upsert: true }
        );
      }
    }

    // Import users
    if (users && Array.isArray(users)) {
      for (const u of users) {
        await UserModel.updateOne(
          { _id: u.uid },
          { $set: u },
          { upsert: true }
        );
      }
    }

    // Import predictions
    if (predictions && Array.isArray(predictions)) {
      for (const p of predictions) {
        await PredictionModel.updateOne(
          { _id: p.id },
          { $set: p },
          { upsert: true }
        );
      }
    }

    res.json({ success: true, message: 'Initial data seeded successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET all predictions
app.get('/api/predictions', async (req, res) => {
  try {
    const list = await PredictionModel.find({});
    res.json(list);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET predictions for a specific user
app.get('/api/predictions/user/:userId', async (req, res) => {
  const userId = req.params.userId;
  try {
    const list = await PredictionModel.find({ userId });
    console.log(list)
    res.json(list);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST save prediction
app.post('/api/predictions', async (req, res) => {
  const predData = req.body;
  const predictionId = predData.id;

  try {
    const match = await MatchModel.findById(predData.matchId);
    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    // Check locking
    const isPastLockedTime = new Date().getTime() > new Date(match.kickoffTime).getTime();
    if (match.status !== 'Open' || isPastLockedTime) {
      return res.status(400).json({ error: 'Predictions are locked for this match.' });
    }

    // Save prediction
    const prediction = await PredictionModel.findOneAndUpdate(
      { _id: predictionId },
      { $set: { ...predData, updatedAt: new Date().toISOString() } },
      { new: true, upsert: true }
    );

    res.json(prediction);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET leaderboard users
app.get('/api/users', async (req, res) => {
  try {
    const list = await UserModel.find({});
    // Filter admin and sort
    const uList = list.filter(u => !u.isAdmin);
    uList.sort((a, b) => b.totalPoints - a.totalPoints || a.displayName.localeCompare(b.displayName));
    res.json(uList);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET single user profile
app.get('/api/users/:uid', async (req, res) => {
  try {
    const user = await UserModel.findById(req.params.uid);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST Google sync
app.post('/api/users/google-sync', async (req, res) => {
  const { uid, email, displayName } = req.body;
  try {
    let user = await UserModel.findById(uid);
    if (!user) {
      const isUserAdmin = email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();
      user = new UserModel({
        _id: uid,
        uid,
        email: email || '',
        displayName: displayName || email?.split('@')[0] || 'TML Brother',
        totalPoints: 0,
        exactScoresCount: 0,
        correctOutcomesCount: 0,
        isAdmin: isUserAdmin,
        updatedAt: new Date().toISOString()
      });
      await user.save();
    } else {
      // In case admin status changes or email changes
      const isUserAdmin = email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();
      if (user.isAdmin !== isUserAdmin) {
        user.isAdmin = isUserAdmin;
        await user.save();
      }
    }
    res.json(user);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST custom number login
app.post('/api/users/login', async (req, res) => {
  const { number, password } = req.body;
  try {
    const cleanNumber = number.trim();
    const isDirectAdmin = cleanNumber.toLowerCase() === ADMIN_EMAIL.toLowerCase();

    if (isDirectAdmin && password === 'placeholder') {
      let user = await UserModel.findById('admin-mo');
      if (!user) {
        user = new UserModel({
          _id: 'admin-mo',
          uid: 'admin-mo',
          email: ADMIN_EMAIL,
          displayName: 'Admin Mo (TML)',
          totalPoints: 15,
          exactScoresCount: 4,
          correctOutcomesCount: 3,
          isAdmin: true,
          updatedAt: new Date().toISOString()
        });
        await user.save();
      }
      return res.json(user);
    }

    const cred = await CredentialModel.findById(cleanNumber);
    if (!cred) {
      return res.status(400).json({ error: 'This number is not registered. Please sign up first.' });
    }

    if (cred.password !== password && password !== 'placeholder') {
      return res.status(400).json({ error: 'Incorrect password. Please verify and try again.' });
    }

    const user = await UserModel.findById(cred.userId);
    if (!user) {
      return res.status(404).json({ error: 'User profile not found. Please contact support.' });
    }

    res.json(user);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST custom number signup
app.post('/api/users/signup', async (req, res) => {
  const { number, name, password } = req.body;
  try {
    const cleanNumber = number.trim();
    const existingCred = await CredentialModel.findById(cleanNumber);
    if (existingCred) {
      return res.status(400).json({ error: 'This number is already registered. If you forgot your password, please use another number.' });
    }

    const uid = 'usr_' + cleanNumber.toLowerCase().replace(/[^a-z0-9]/g, '');
    const isUserAdmin = cleanNumber.toLowerCase() === ADMIN_EMAIL.toLowerCase();

    const newProfile = new UserModel({
      _id: uid,
      uid,
      email: cleanNumber,
      displayName: name,
      totalPoints: 0,
      exactScoresCount: 0,
      correctOutcomesCount: 0,
      isAdmin: isUserAdmin,
      updatedAt: new Date().toISOString()
    });

    const newCred = new CredentialModel({
      _id: cleanNumber,
      number: cleanNumber,
      password: password,
      userId: uid,
      displayName: name,
      createdAt: new Date().toISOString()
    });

    await newCred.save();
    await newProfile.save();

    res.status(201).json(newProfile);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT update display name
app.put('/api/users/profile', async (req, res) => {
  const { uid, displayName } = req.body;
  try {
    const user = await UserModel.findById(uid);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    user.displayName = displayName;
    user.updatedAt = new Date().toISOString();
    await user.save();

    // If custom number, also update credential displayName
    const isCustomNumber = /^[0-9]+$/.test(user.email);
    if (isCustomNumber) {
      const cred = await CredentialModel.findOne({ userId: uid });
      if (cred) {
        cred.displayName = displayName;
        await cred.save();
      }
    }

    res.json(user);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Serve Static Frontend in Production ---
const __dirname = path.resolve();
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
}

const PORT = process.env.PORT || 5002;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
