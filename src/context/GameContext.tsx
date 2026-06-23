import React, { createContext, useContext, useState, useEffect } from 'react';
import { 
  Match, 
  Prediction, 
  UserProfile, 
  MatchStatus, 
  PredictionStatus, 
  MatchStage 
} from '../types';
import { calculatePoints } from '../utils/scoring';
import { safeStorage } from '../utils/storage';
import { INITIAL_MATCHES } from '../data/mockMatches';
import {
  auth,
  isFirebaseSupported
} from '../firebase';
import {
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
  User as FirebaseUser
} from 'firebase/auth';

interface GameContextProps {
  currentUser: UserProfile | null;
  matches: Match[];
  predictions: Prediction[];
  leaderboard: UserProfile[];
  isLoading: boolean;
  isFirebase: boolean;
  login: (email: string, pass: string) => Promise<void>;
  signUp: (email: string, name: string, pass: string) => Promise<void>;
  updateProfileName: (newName: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
  savePrediction: (matchId: string, homePredicted: number, awayPredicted: number, shootoutWinner?: 'home' | 'away' | null) => Promise<void>;
  updateMatchScore: (matchId: string, homeScore: number | null, awayScore: number | null, status: MatchStatus, shootoutWinner?: 'home' | 'away' | null) => Promise<void>;
  clearMatchPoints: (matchId: string) => Promise<void>;
  addMatch: (matchData: {
    homeTeam: string;
    awayTeam: string;
    homeFlag?: string;
    awayFlag?: string;
    stage: MatchStage;
    status: MatchStatus;
    kickoffTime: string;
  }) => Promise<void>;
  clearAllMatches: () => Promise<void>;
  seedInitialData: () => Promise<void>;
  toggleFirebaseMode: (enabled: boolean) => void;
  refreshData: () => Promise<void>;
  cloudQuotaExceeded: boolean;
  resetCloudDatabaseAttempt: () => void;
  activeStage: string;
  setActiveStage: (stage: string) => void;
}

const GameContext = createContext<GameContextProps | undefined>(undefined);

// Admin Email from metadata and request
const ADMIN_EMAIL = 'mm9975775@gmail.com';

// Shadow global localStorage to use sandboxed safeStorage
const localStorage = safeStorage;

export const GameProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [matches, setMatches] = useState<Match[]>([]);
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [leaderboard, setLeaderboard] = useState<UserProfile[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [activeStage, setActiveStage] = useState<string>('Unfinished');
  
  const [isFirebase, setIsFirebase] = useState<boolean>(() => {
    // Clear legacy local mode fallback so we immediately connect to the reset Firebase instance
    localStorage.removeItem('tml_local_mode_fallback');
    return isFirebaseSupported;
  });
  
  const [cloudQuotaExceeded, setCloudQuotaExceeded] = useState<boolean>(false);

  const resetCloudDatabaseAttempt = () => {
    localStorage.removeItem('tml_local_mode_fallback');
    setCloudQuotaExceeded(false);
    setIsFirebase(isFirebaseSupported);
  };

  const checkQuotaError = (error: any): boolean => {
    const errMsg = error?.message || String(error);
    if (
      errMsg.toLowerCase().includes('quota') || 
      errMsg.toLowerCase().includes('exhausted') || 
      error?.code === 'resource-exhausted'
    ) {
      setCloudQuotaExceeded(true);
      localStorage.setItem('tml_local_mode_fallback', 'true');
      setIsFirebase(false);
      return true;
    }
    return false;
  };

  // Default mock users for sandbox/leaderboard initialization
  const defaultMockLeaderboard = [
    { uid: 'user-id-1', email: 'vibe_coder@tml.com', displayName: 'Vibe Coder 🔥', totalPoints: 12, exactScoresCount: 3, correctOutcomesCount: 3, isAdmin: false },
    { uid: 'user-id-2', email: 'brother_tarik@tml.com', displayName: 'Brother Tarik ⚽', totalPoints: 8, exactScoresCount: 1, correctOutcomesCount: 5, isAdmin: false },
    { uid: 'user-id-3', email: 'brother_mo@tml.com', displayName: 'Brother Mo 🌟', totalPoints: 10, exactScoresCount: 2, correctOutcomesCount: 4, isAdmin: false },
    { uid: ADMIN_EMAIL, email: ADMIN_EMAIL, displayName: 'Admin Mo (TML)', totalPoints: 15, exactScoresCount: 4, correctOutcomesCount: 3, isAdmin: true }
  ];

  // Helper to load Leaderboard once
  const loadLeaderboardData = async (customUserArg?: UserProfile | null) => {
    if (!isFirebase) return;
    try {
      const res = await fetch('/api/users');
      if (!res.ok) throw new Error(await res.text());
      const uList: UserProfile[] = await res.json();
      setLeaderboard(uList);
      
      const activeUser = customUserArg !== undefined ? customUserArg : currentUser;
      const currentId = activeUser?.uid || auth?.currentUser?.uid;
      if (currentId) {
        const meRes = await fetch(`/api/users/${currentId}`);
        if (meRes.ok) {
          const me = await meRes.json();
          setCurrentUser(me);
          localStorage.setItem('tml_currentUser', JSON.stringify(me));
        }
      }
    } catch (error) {
      console.error("Error fetching leaderboard:", error);
    }
  };

  // Main API data fetching function for polling/refreshes
  const fetchCloudData = async () => {
    if (!isFirebase) return;
    try {
      const uid = auth?.currentUser?.uid || currentUser?.uid;

      // 1. Fetch matches
      const matchesRes = await fetch('/api/matches');
      if (matchesRes.ok) {
        const allMatches: Match[] = await matchesRes.json();
        let filteredMatches = allMatches;
        
        // Non-admins only view specific stages or unfinished matches
        const isAdmin = currentUser?.isAdmin || (uid && uid === 'admin-mo') || (currentUser?.email === ADMIN_EMAIL);
        if (!isAdmin) {
          if (activeStage === 'Unfinished') {
            filteredMatches = allMatches.filter(m => m.status === MatchStatus.OPEN || m.status === MatchStatus.LOCKED);
          } else {
            filteredMatches = allMatches.filter(m => m.stage === activeStage);
          }
        }
        
        // Sort matches
        filteredMatches.sort((a, b) => {
          if (a.isCustom && !b.isCustom) return -1;
          if (!a.isCustom && b.isCustom) return 1;
          if (a.isCustom && b.isCustom) {
            return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
          }
          return new Date(a.kickoffTime).getTime() - new Date(b.kickoffTime).getTime();
        });
        setMatches(filteredMatches);
      }

      // 2. Fetch predictions
      if (uid) {
        const isAdmin = currentUser?.isAdmin || (currentUser?.email === ADMIN_EMAIL);
        const predsUrl = isAdmin ? '/api/predictions' : `/api/predictions/user/${uid}`;
        const predsRes = await fetch(predsUrl);
        if (predsRes.ok) {
          setPredictions(await predsRes.json());
        }
      }

      // 3. Fetch leaderboard
      const usersRes = await fetch('/api/users');
      if (usersRes.ok) {
        setLeaderboard(await usersRes.json());
      }

      // 4. Sync profile
      if (uid) {
        const userRes = await fetch(`/api/users/${uid}`);
        if (userRes.ok) {
          const up = await userRes.json();
          setCurrentUser(up);
          localStorage.setItem('tml_currentUser', JSON.stringify(up));
        }
      }

      setIsLoading(false);
    } catch (err) {
      console.error("Error polling cloud data:", err);
    }
  };

  // Load and subscribe to database (MongoDB via REST APIs or LocalStorage)
  useEffect(() => {
    let unsubscribeAuth: () => void = () => {};

    if (isFirebase) {
      setIsFirebase(true);

      // Load initial local stored profile if any
      const localUserStr = localStorage.getItem('tml_currentUser');
      let customUser: UserProfile | null = null;
      if (localUserStr) {
        try {
          customUser = JSON.parse(localUserStr);
          setCurrentUser(customUser);
        } catch (e) {
          console.error("Failed to parse local stored custom user:", e);
        }
      }

      // Initial load
      fetchCloudData();

      // Start Polling every 5 seconds for simulated realtime updates
      const pollInterval = setInterval(fetchCloudData, 5000);

      // Google Auth listener
      if (auth) {
        unsubscribeAuth = onAuthStateChanged(auth, async (fbUser: FirebaseUser | null) => {
          if (fbUser) {
            setIsLoading(true);
            try {
              // Sync user profile to backend
              const syncRes = await fetch('/api/users/google-sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  uid: fbUser.uid,
                  email: fbUser.email,
                  displayName: fbUser.displayName
                })
              });

              if (syncRes.ok) {
                const currentProfile = await syncRes.json();
                localStorage.setItem('tml_currentUser', JSON.stringify(currentProfile));
                setCurrentUser(currentProfile);
                
                // Load updated predictions immediately
                const predsRes = await fetch(`/api/predictions/user/${currentProfile.uid}`);
                if (predsRes.ok) {
                  setPredictions(await predsRes.json());
                }
              }
            } catch (err) {
              console.error("Error syncing Google user:", err);
            } finally {
              setIsLoading(false);
            }
          } else {
            // Google auth cleared, check if custom credentials user session is active
            const storedCustomUser = localStorage.getItem('tml_currentUser');
            if (!storedCustomUser) {
              setCurrentUser(null);
              setPredictions([]);
            }
          }
        });
      }

      return () => {
        clearInterval(pollInterval);
        unsubscribeAuth();
      };
    } else {
      // Local Sandbox Mode
      setIsFirebase(false);
      
      const localMatches = localStorage.getItem('tml_matches');
      const localPredictions = localStorage.getItem('tml_predictions');
      const localLeaderboard = localStorage.getItem('tml_leaderboard');
      const localUser = localStorage.getItem('tml_currentUser');

      if (localMatches) {
        setMatches(JSON.parse(localMatches));
      } else {
        localStorage.setItem('tml_matches', JSON.stringify(INITIAL_MATCHES));
        setMatches(INITIAL_MATCHES);
      }

      if (localPredictions) {
        setPredictions(JSON.parse(localPredictions));
      } else {
        const defaultPredictions: Prediction[] = [
          { id: 'user-id-1_wc2026-m01', userId: 'user-id-1', userEmail: 'vibe_coder@tml.com', displayName: 'Vibe Coder 🔥', matchId: 'wc2026-m01', homePredicted: 1, awayPredicted: 2, pointsAwarded: 3, status: PredictionStatus.EXACT_CORRECT, updatedAt: new Date().toISOString() },
          { id: 'user-id-2_wc2026-m01', userId: 'user-id-2', userEmail: 'brother_tarik@tml.com', displayName: 'Brother Tarik ⚽', matchId: 'wc2026-m01', homePredicted: 3, awayPredicted: 0, pointsAwarded: 0, status: PredictionStatus.INCORRECT, updatedAt: new Date().toISOString() },
          { id: 'user-id-3_wc2026-m01', userId: 'user-id-3', userEmail: 'brother_mo@tml.com', displayName: 'Brother Mo 🌟', matchId: 'wc2026-m01', homePredicted: 1, awayPredicted: 1, pointsAwarded: 0, status: PredictionStatus.INCORRECT, updatedAt: new Date().toISOString() },
          { id: 'user-id-1_wc2026-m02', userId: 'user-id-1', userEmail: 'vibe_coder@tml.com', displayName: 'Vibe Coder 🔥', matchId: 'wc2026-m02', homePredicted: 1, awayPredicted: 1, pointsAwarded: 3, status: PredictionStatus.EXACT_CORRECT, updatedAt: new Date().toISOString() },
          { id: 'user-id-2_wc2026-m02', userId: 'user-id-2', userEmail: 'brother_tarik@tml.com', displayName: 'Brother Tarik ⚽', matchId: 'wc2026-m02', homePredicted: 0, awayPredicted: 2, pointsAwarded: 0, status: PredictionStatus.INCORRECT, updatedAt: new Date().toISOString() },
          { id: 'user-id-3_wc2026-m02', userId: 'user-id-3', userEmail: 'brother_mo@tml.com', displayName: 'Brother Mo 🌟', matchId: 'wc2026-m02', homePredicted: 2, awayPredicted: 2, pointsAwarded: 1, status: PredictionStatus.WINNER_CORRECT, updatedAt: new Date().toISOString() }
        ];
        localStorage.setItem('tml_predictions', JSON.stringify(defaultPredictions));
        setPredictions(defaultPredictions);
      }

      if (localLeaderboard) {
        const rawLeaderboard = JSON.parse(localLeaderboard) as UserProfile[];
        const filteredLeaderboard = rawLeaderboard.filter(u => !u.isAdmin);
        filteredLeaderboard.sort((a, b) => b.totalPoints - a.totalPoints || a.displayName.localeCompare(b.displayName));
        setLeaderboard(filteredLeaderboard);
      } else {
        localStorage.setItem('tml_leaderboard', JSON.stringify(defaultMockLeaderboard));
        const filteredLeaderboard = defaultMockLeaderboard.filter(u => !u.isAdmin);
        filteredLeaderboard.sort((a, b) => b.totalPoints - a.totalPoints || a.displayName.localeCompare(b.displayName));
        setLeaderboard(filteredLeaderboard);
      }

      if (localUser) {
        setCurrentUser(JSON.parse(localUser));
      } else {
        const defaultAdmin = defaultMockLeaderboard.find(u => u.uid === ADMIN_EMAIL) || defaultMockLeaderboard[3];
        localStorage.setItem('tml_currentUser', JSON.stringify(defaultAdmin));
        setCurrentUser(defaultAdmin);
      }

      setIsLoading(false);
    }
  }, [isFirebase]);

  // Re-fetch when active stage changes to filter matches properly
  useEffect(() => {
    if (isFirebase) {
      fetchCloudData();
    }
  }, [activeStage]);

  // Login handler
  const login = async (numberInput: string, pass: string) => {
    setIsLoading(true);
    try {
      const cleanNumber = numberInput.trim();
      
      if (isFirebase) {
        const res = await fetch('/api/users/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ number: cleanNumber, password: pass })
        });
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || "Login failed");
        }
        const profile = await res.json();
        localStorage.setItem('tml_currentUser', JSON.stringify(profile));
        setCurrentUser(profile);
        
        // Load predictions immediately
        const predsRes = await fetch(`/api/predictions/user/${profile.uid}`);
        if (predsRes.ok) {
          setPredictions(await predsRes.json());
        }
      } else {
        // Sandbox login
        const existingUsers: UserProfile[] = JSON.parse(localStorage.getItem('tml_leaderboard') || '[]');
        let user = existingUsers.find(u => u.email.toLowerCase() === cleanNumber.toLowerCase());
        
        if (!user) {
          const isUserAdmin = cleanNumber.toLowerCase() === ADMIN_EMAIL.toLowerCase();
          const newUser: UserProfile = {
            uid: 'sb-' + Math.random().toString(36).substr(2, 9),
            email: cleanNumber,
            displayName: cleanNumber === ADMIN_EMAIL ? 'Admin Mo (TML)' : 'Guest Brother',
            totalPoints: 0,
            exactScoresCount: 0,
            correctOutcomesCount: 0,
            isAdmin: isUserAdmin
          };
          existingUsers.push(newUser);
          localStorage.setItem('tml_leaderboard', JSON.stringify(existingUsers));
          user = newUser;
        }
        
        localStorage.setItem('tml_currentUser', JSON.stringify(user));
        setCurrentUser(user);
      }
    } catch (err: any) {
      console.error(err);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  // Sign Up handler
  const signUp = async (numberInput: string, name: string, pass: string) => {
    setIsLoading(true);
    try {
      const cleanNumber = numberInput.trim();
      
      if (isFirebase) {
        const res = await fetch('/api/users/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ number: cleanNumber, name, password: pass })
        });
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || "Sign up failed");
        }
        const newProfile = await res.json();
        localStorage.setItem('tml_currentUser', JSON.stringify(newProfile));
        setCurrentUser(newProfile);
        setPredictions([]);
      } else {
        // Sandbox Sign Up
        const existingUsers: UserProfile[] = JSON.parse(localStorage.getItem('tml_leaderboard') || '[]');
        const isUserAdmin = cleanNumber.toLowerCase() === ADMIN_EMAIL.toLowerCase();
        
        if (existingUsers.some(u => u.email.toLowerCase() === cleanNumber.toLowerCase())) {
          throw new Error("This number is already in use in the sandbox database!");
        }

        const newUser: UserProfile = {
          uid: 'sb-' + Math.random().toString(36).substr(2, 9),
          email: cleanNumber,
          displayName: name,
          totalPoints: 0,
          exactScoresCount: 0,
          correctOutcomesCount: 0,
          isAdmin: isUserAdmin
        };
        
        existingUsers.push(newUser);
        localStorage.setItem('tml_leaderboard', JSON.stringify(existingUsers));
        const filteredAndSorted = existingUsers
          .filter(u => !u.isAdmin)
          .sort((a, b) => b.totalPoints - a.totalPoints || a.displayName.localeCompare(b.displayName));
        setLeaderboard(filteredAndSorted);
        
        localStorage.setItem('tml_currentUser', JSON.stringify(newUser));
        setCurrentUser(newUser);
        setPredictions([]);
      }
    } catch (err: any) {
      console.error(err);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  // Update profile display name/nickname
  const updateProfileName = async (newName: string) => {
    if (!currentUser) throw new Error("Not logged in");
    const cleanName = newName.trim();
    if (!cleanName) throw new Error("Name cannot be empty");

    if (isFirebase) {
      try {
        const res = await fetch('/api/users/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid: currentUser.uid, displayName: cleanName })
        });
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || "Profile update failed");
        }
        await loadLeaderboardData();
      } catch (err) {
        console.error("Failed to update profile name:", err);
        throw err;
      }
    } else {
      // Sandbox mode
      const existingUsers: UserProfile[] = JSON.parse(localStorage.getItem('tml_leaderboard') || '[]');
      const updatedUsers = existingUsers.map(u => {
        if (u.uid === currentUser.uid) {
          return { ...u, displayName: cleanName };
        }
        return u;
      });
      localStorage.setItem('tml_leaderboard', JSON.stringify(updatedUsers));
      const filteredAndSorted = updatedUsers
        .filter(u => !u.isAdmin)
        .sort((a, b) => b.totalPoints - a.totalPoints || a.displayName.localeCompare(b.displayName));
      setLeaderboard(filteredAndSorted);

      const updatedMe = { ...currentUser, displayName: cleanName };
      localStorage.setItem('tml_currentUser', JSON.stringify(updatedMe));
      setCurrentUser(updatedMe);
    }
  };

  // Google Authentication handler
  const loginWithGoogle = async () => {
    setIsLoading(true);
    try {
      if (isFirebase && auth) {
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        await signInWithPopup(auth, provider);
      } else {
        // Mock Google login in sandbox mode
        const email = ADMIN_EMAIL;
        await login(email, 'placeholder');
      }
    } catch (err: any) {
      console.error(err);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  // Sign out
  const logout = async () => {
    setIsLoading(true);
    try {
      localStorage.removeItem('tml_currentUser');
      setCurrentUser(null);
      setPredictions([]);
      if (isFirebase && auth) {
        await signOut(auth);
      }
    } catch (err: any) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  // Save prediction
  const savePrediction = async (matchId: string, homePredicted: number, awayPredicted: number, shootoutWinner?: 'home' | 'away' | null) => {
    if (!currentUser) throw new Error("You must be logged in to make predictions!");

    const match = matches.find(m => m.id === matchId);
    if (!match) throw new Error("Match not found!");

    const isPastLockedTime = new Date().getTime() > new Date(match.kickoffTime).getTime();
    if (match.status !== MatchStatus.OPEN || isPastLockedTime) {
      throw new Error("Predictions are locked. The match has already kicked off!");
    }

    const predictionId = `${currentUser.uid}_${matchId}`;

    if (isFirebase) {
      try {
        const data: Prediction = {
          id: predictionId,
          userId: currentUser.uid,
          userEmail: currentUser.email,
          displayName: currentUser.displayName,
          matchId,
          homePredicted: Number(homePredicted),
          awayPredicted: Number(awayPredicted),
          shootoutWinner: shootoutWinner || null,
          pointsAwarded: null,
          status: PredictionStatus.PENDING,
          updatedAt: new Date().toISOString()
        };

        const res = await fetch('/api/predictions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || "Failed to save prediction");
        }
        
        // Fetch updated predictions list immediately
        const predsRes = await fetch(`/api/predictions/user/${currentUser.uid}`);
        if (predsRes.ok) {
          setPredictions(await predsRes.json());
        }
      } catch (err) {
        console.error("Failed to save prediction to MongoDB:", err);
        throw err;
      }
    } else {
      // Sandbox implementation
      const keys: Prediction[] = JSON.parse(localStorage.getItem('tml_predictions') || '[]');
      const updatedKeys = keys.filter(p => p.id !== predictionId);
      
      const newPred: Prediction = {
        id: predictionId,
        userId: currentUser.uid,
        userEmail: currentUser.email,
        displayName: currentUser.displayName,
        matchId,
        homePredicted: Number(homePredicted),
        awayPredicted: Number(awayPredicted),
        shootoutWinner: shootoutWinner || null,
        pointsAwarded: null,
        status: PredictionStatus.PENDING,
        updatedAt: new Date().toISOString()
      };
      
      updatedKeys.push(newPred);
      localStorage.setItem('tml_predictions', JSON.stringify(updatedKeys));
      setPredictions(updatedKeys);
    }
  };

  // Admin writes official score
  const updateMatchScore = async (
    matchId: string,
    homeScore: number | null,
    awayScore: number | null,
    status: MatchStatus,
    shootoutWinner?: 'home' | 'away' | null
  ) => {
    if (!currentUser?.isAdmin) throw new Error("Unauthorized! Only admins can post core match stats.");

    const matchObj = matches.find(m => m.id === matchId);
    if (!matchObj) throw new Error("Match not found.");

    if (isFirebase) {
      try {
        const res = await fetch(`/api/matches/${matchId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ homeScore, awayScore, status, shootoutWinner })
        });
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || "Failed to update match score");
        }
        await fetchCloudData();
      } catch (err) {
        console.error("Failed to update score on MongoDB backend:", err);
        throw err;
      }
    } else {
      // Local Sandbox scoring logic
      const wasFinalized = matchObj.status === MatchStatus.FINISHED && matchObj.homeScore !== null && matchObj.awayScore !== null;
      const isKnockout = matchObj.stage !== MatchStage.GROUP_STAGE;
      
      let currentMatches: Match[] = JSON.parse(localStorage.getItem('tml_matches') || '[]');
      currentMatches = currentMatches.map(m => {
        if (m.id === matchId) {
          return {
            ...m,
            homeScore: homeScore !== null ? Number(homeScore) : null,
            awayScore: awayScore !== null ? Number(awayScore) : null,
            shootoutWinner: shootoutWinner || null,
            status,
            updatedAt: new Date().toISOString()
          };
        }
        return m;
      });

      let currentPredictions: Prediction[] = JSON.parse(localStorage.getItem('tml_predictions') || '[]');
      let currentProfiles: UserProfile[] = JSON.parse(localStorage.getItem('tml_leaderboard') || '[]');

      currentPredictions = currentPredictions.map(p => {
        if (p.matchId === matchId) {
          const oldPoints = wasFinalized ? (p.pointsAwarded || 0) : 0;
          const wasExact = wasFinalized && p.status === PredictionStatus.EXACT_CORRECT;
          const wasOutcome = wasFinalized && p.status === PredictionStatus.WINNER_CORRECT;

          let newPoints = 0;
          let newStatus = PredictionStatus.PENDING;

          if (status === MatchStatus.FINISHED && homeScore !== null && awayScore !== null) {
            const scoringResult = calculatePoints(
              p.homePredicted,
              p.awayPredicted,
              Number(homeScore),
              Number(awayScore),
              isKnockout,
              p.shootoutWinner,
              shootoutWinner
            );
            newPoints = scoringResult.points;
            newStatus = scoringResult.status;
          }

          const deltaPoints = newPoints - oldPoints;
          const deltaExact = (newStatus === PredictionStatus.EXACT_CORRECT ? 1 : 0) - (wasExact ? 1 : 0);
          const deltaOutcome = (newStatus === PredictionStatus.WINNER_CORRECT ? 1 : 0) - (wasOutcome ? 1 : 0);

          currentProfiles = currentProfiles.map(prof => {
            if (prof.uid === p.userId) {
              return {
                ...prof,
                totalPoints: Math.max(0, prof.totalPoints + deltaPoints),
                exactScoresCount: Math.max(0, prof.exactScoresCount + deltaExact),
                correctOutcomesCount: Math.max(0, prof.correctOutcomesCount + deltaOutcome)
              };
            }
            return prof;
          });

          return {
            ...p,
            pointsAwarded: status === MatchStatus.FINISHED ? newPoints : null,
            status: newStatus,
            updatedAt: new Date().toISOString()
          };
        }
        return p;
      });

      localStorage.setItem('tml_matches', JSON.stringify(currentMatches));
      localStorage.setItem('tml_predictions', JSON.stringify(currentPredictions));
      localStorage.setItem('tml_leaderboard', JSON.stringify(currentProfiles));

      setMatches(currentMatches);
      setPredictions(currentPredictions);
      const filteredProfiles = currentProfiles.filter(u => !u.isAdmin);
      filteredProfiles.sort((a, b) => b.totalPoints - a.totalPoints || a.displayName.localeCompare(b.displayName));
      setLeaderboard(filteredProfiles);

      const updatedMe = currentProfiles.find(u => u.uid === currentUser?.uid);
      if (updatedMe) {
        localStorage.setItem('tml_currentUser', JSON.stringify(updatedMe));
        setCurrentUser(updatedMe);
      }
    }
  };

  const clearMatchPoints = async (matchId: string) => {
    if (!currentUser?.isAdmin) throw new Error("Unauthorized! Only admins can clear match points.");

    const matchObj = matches.find(m => m.id === matchId);
    if (!matchObj) throw new Error("Match not found.");

    if (isFirebase) {
      try {
        const res = await fetch(`/api/matches/clear-points/${matchId}`, {
          method: 'POST'
        });
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || "Failed to clear match points");
        }
        await fetchCloudData();
      } catch (err) {
        console.error("Failed to clear match points on MongoDB backend:", err);
        throw err;
      }
    } else {
      const kickoffMs = new Date(matchObj.kickoffTime).getTime();
      const isPastKickoff = Date.now() > kickoffMs;
      const defaultStatusOnReset = isPastKickoff ? MatchStatus.LOCKED : MatchStatus.OPEN;
      await updateMatchScore(matchId, null, null, defaultStatusOnReset, null);
    }
  };

  // Seeding initial list of matches into MongoDB Atlas
  const seedInitialData = async () => {
    if (!currentUser?.isAdmin) throw new Error("Unauthorized seeder!");

    if (isFirebase) {
      try {
        const defaultPredictions: Prediction[] = [
          { id: 'user-id-1_wc2026-m01', userId: 'user-id-1', userEmail: 'vibe_coder@tml.com', displayName: 'Vibe Coder 🔥', matchId: 'wc2026-m01', homePredicted: 1, awayPredicted: 2, pointsAwarded: 3, status: PredictionStatus.EXACT_CORRECT, updatedAt: new Date().toISOString() },
          { id: 'user-id-2_wc2026-m01', userId: 'user-id-2', userEmail: 'brother_tarik@tml.com', displayName: 'Brother Tarik ⚽', matchId: 'wc2026-m01', homePredicted: 3, awayPredicted: 0, pointsAwarded: 0, status: PredictionStatus.INCORRECT, updatedAt: new Date().toISOString() },
          { id: 'user-id-3_wc2026-m01', userId: 'user-id-3', userEmail: 'brother_mo@tml.com', displayName: 'Brother Mo 🌟', matchId: 'wc2026-m01', homePredicted: 1, awayPredicted: 1, pointsAwarded: 0, status: PredictionStatus.INCORRECT, updatedAt: new Date().toISOString() },
          { id: 'user-id-1_wc2026-m02', userId: 'user-id-1', userEmail: 'vibe_coder@tml.com', displayName: 'Vibe Coder 🔥', matchId: 'wc2026-m02', homePredicted: 1, awayPredicted: 1, pointsAwarded: 3, status: PredictionStatus.EXACT_CORRECT, updatedAt: new Date().toISOString() },
          { id: 'user-id-2_wc2026-m02', userId: 'user-id-2', userEmail: 'brother_tarik@tml.com', displayName: 'Brother Tarik ⚽', matchId: 'wc2026-m02', homePredicted: 0, awayPredicted: 2, pointsAwarded: 0, status: PredictionStatus.INCORRECT, updatedAt: new Date().toISOString() },
          { id: 'user-id-3_wc2026-m02', userId: 'user-id-3', userEmail: 'brother_mo@tml.com', displayName: 'Brother Mo 🌟', matchId: 'wc2026-m02', homePredicted: 2, awayPredicted: 2, pointsAwarded: 1, status: PredictionStatus.WINNER_CORRECT, updatedAt: new Date().toISOString() }
        ];

        const res = await fetch('/api/matches/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            matches: INITIAL_MATCHES,
            users: defaultMockLeaderboard,
            predictions: defaultPredictions
          })
        });

        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || "Failed to seed data");
        }
        
        await fetchCloudData();
        console.log("Seeding in MongoDB complete!");
      } catch (err) {
        console.error("Failed to seed initial data:", err);
      }
    } else {
      localStorage.setItem('tml_matches', JSON.stringify(INITIAL_MATCHES));
      localStorage.setItem('tml_leaderboard', JSON.stringify(defaultMockLeaderboard));
      localStorage.setItem('tml_predictions', JSON.stringify([]));

      setMatches(INITIAL_MATCHES);
      const filteredLeaderboard = defaultMockLeaderboard.filter(u => !u.isAdmin);
      filteredLeaderboard.sort((a, b) => b.totalPoints - a.totalPoints || a.displayName.localeCompare(b.displayName));
      setLeaderboard(filteredLeaderboard);
      setPredictions([]);
      
      const admin = defaultMockLeaderboard.find(u => u.uid === ADMIN_EMAIL);
      if (admin) {
        localStorage.setItem('tml_currentUser', JSON.stringify(admin));
        setCurrentUser(admin);
      }
    }
  };

  // Add match
  const addMatch = async (matchData: {
    homeTeam: string;
    awayTeam: string;
    homeFlag?: string;
    awayFlag?: string;
    stage: MatchStage;
    status: MatchStatus;
    kickoffTime: string;
  }) => {
    if (!currentUser?.isAdmin) throw new Error("Unauthorized! Only admins can add new matches.");

    const matchId = 'm' + Math.random().toString(36).substring(2, 9);
    const newMatch: Match = {
      id: matchId,
      homeTeam: matchData.homeTeam,
      awayTeam: matchData.awayTeam,
      homeFlag: matchData.homeFlag || '⚽',
      awayFlag: matchData.awayFlag || '⚽',
      stage: matchData.stage,
      status: matchData.status,
      kickoffTime: matchData.kickoffTime,
      homeScore: null,
      awayScore: null,
      isCustom: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (isFirebase) {
      try {
        const res = await fetch('/api/matches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newMatch)
        });
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || "Failed to add match");
        }
        await fetchCloudData();
      } catch (err) {
        console.error("Failed to add match on MongoDB backend:", err);
      }
    } else {
      const currentMatches: Match[] = JSON.parse(localStorage.getItem('tml_matches') || '[]');
      currentMatches.push(newMatch);
      currentMatches.sort((a, b) => {
        if (a.isCustom && !b.isCustom) return -1;
        if (!a.isCustom && b.isCustom) return 1;
        if (a.isCustom && b.isCustom) {
          return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
        }
        return new Date(a.kickoffTime).getTime() - new Date(b.kickoffTime).getTime();
      });
      localStorage.setItem('tml_matches', JSON.stringify(currentMatches));
      setMatches(currentMatches);
    }
  };

  // Clear matches & predictions
  const clearAllMatches = async () => {
    if (!currentUser?.isAdmin) throw new Error("Unauthorized! Only admins can clear matches.");

    if (isFirebase) {
      try {
        const res = await fetch('/api/matches', {
          method: 'DELETE'
        });
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || "Failed to clear matches");
        }
        await fetchCloudData();
      } catch (err) {
        console.error("Failed to clear matches on MongoDB backend:", err);
      }
    } else {
      localStorage.setItem('tml_matches', JSON.stringify([]));
      localStorage.setItem('tml_predictions', JSON.stringify([]));
      
      const currentLeaderboard: UserProfile[] = JSON.parse(localStorage.getItem('tml_leaderboard') || '[]');
      const resetLeaderboard = currentLeaderboard.map(u => ({
        ...u,
        totalPoints: 0,
        exactScoresCount: 0,
        correctOutcomesCount: 0
      }));
      localStorage.setItem('tml_leaderboard', JSON.stringify(resetLeaderboard));
      
      setMatches([]);
      setPredictions([]);
      const filteredAndSorted = resetLeaderboard
        .filter(u => !u.isAdmin)
        .sort((a, b) => b.totalPoints - a.totalPoints || a.displayName.localeCompare(b.displayName));
      setLeaderboard(filteredAndSorted);

      const me = resetLeaderboard.find(u => u.uid === currentUser?.uid);
      if (me) {
        localStorage.setItem('tml_currentUser', JSON.stringify(me));
        setCurrentUser(me);
      }
    }
  };

  const toggleFirebaseMode = (enabled: boolean) => {
    setIsFirebase(enabled);
    if (!enabled) {
      setCurrentUser(null);
      setMatches([]);
      setLeaderboard([]);
      setPredictions([]);
    }
  };

  const refreshData = async () => {
    setIsLoading(true);
    if (isFirebase) {
      await fetchCloudData();
      setIsLoading(false);
    } else {
      const localMatches = localStorage.getItem('tml_matches');
      const localPredictions = localStorage.getItem('tml_predictions');
      const localLeaderboard = localStorage.getItem('tml_leaderboard');
      const localUser = localStorage.getItem('tml_currentUser');

      if (localMatches) setMatches(JSON.parse(localMatches));
      if (localPredictions) setPredictions(JSON.parse(localPredictions));
      if (localLeaderboard) {
        const parsed = JSON.parse(localLeaderboard) as UserProfile[];
        const filtered = parsed.filter(u => !u.isAdmin);
        filtered.sort((a, b) => b.totalPoints - a.totalPoints || a.displayName.localeCompare(b.displayName));
        setLeaderboard(filtered);
      }
      if (localUser) setCurrentUser(JSON.parse(localUser));
      setTimeout(() => setIsLoading(false), 300);
    }
  };

  return (
    <GameContext.Provider
      value={{
        currentUser,
        matches,
        predictions,
        leaderboard,
        isLoading,
        isFirebase,
        login,
        signUp,
        updateProfileName,
        loginWithGoogle,
        logout,
        savePrediction,
        updateMatchScore,
        clearMatchPoints,
        addMatch,
        clearAllMatches,
        seedInitialData,
        toggleFirebaseMode,
        refreshData,
        cloudQuotaExceeded,
        resetCloudDatabaseAttempt,
        activeStage,
        setActiveStage
      }}
    >
      {children}
    </GameContext.Provider>
  );
};

export const useGame = () => {
  const context = useContext(GameContext);
  if (context === undefined) {
    throw new Error('useGame must be used within a GameProvider');
  }
  return context;
};
