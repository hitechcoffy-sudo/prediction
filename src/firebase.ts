/**
 * Firebase Client Setup - Kept for Firebase Authentication
 */

import { initializeApp, getApp, getApps } from 'firebase/app';
import { getAuth, Auth } from 'firebase/auth';
import firebaseConfig from '../firebase-applet-config.json';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

// Check if we are running with placeholder mock configurations
const isPlaceholderKey = !firebaseConfig.apiKey || firebaseConfig.apiKey.includes('MOCK_API_KEY_PLACEHOLDER');

let firebaseApp;
let auth: Auth | null = null;
let isFirebaseSupported = false;

if (!isPlaceholderKey) {
  try {
    if (getApps().length === 0) {
      firebaseApp = initializeApp(firebaseConfig);
    } else {
      firebaseApp = getApp();
    }
    // Set up standard Auth service
    auth = getAuth(firebaseApp);
    isFirebaseSupported = true;
  } catch (error) {
    console.error("Firebase Auth failed to initialize:", error);
    isFirebaseSupported = false;
    auth = null;
  }
} else {
  console.log("Using local sandbox mode. Setup Firebase via the AI Studio UI to sync to the cloud.");
}

// Export db as null since Firestore is migrated to MongoDB
const db = null;

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth?.currentUser?.uid || null,
      email: auth?.currentUser?.email || null,
      emailVerified: auth?.currentUser?.emailVerified || null,
      isAnonymous: auth?.currentUser?.isAnonymous || null,
      tenantId: auth?.currentUser?.tenantId || null,
      providerInfo: auth?.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  
  console.error('Firestore Hardened Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export { db, auth, isFirebaseSupported };
