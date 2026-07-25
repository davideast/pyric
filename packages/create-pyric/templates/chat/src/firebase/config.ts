import { getApp, getApps, initializeApp } from 'firebase/app';

const apiKeyEnv = import.meta.env.VITE_FIREBASE_API_KEY;
let apiKeyVal = 'demo';
const hasApiKey = apiKeyEnv !== undefined && apiKeyEnv !== null && apiKeyEnv !== '';
if (hasApiKey) {
  apiKeyVal = apiKeyEnv;
}

const authDomainEnv = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN;
let authDomainVal = 'demo.firebaseapp.com';
const hasAuthDomain = authDomainEnv !== undefined && authDomainEnv !== null && authDomainEnv !== '';
if (hasAuthDomain) {
  authDomainVal = authDomainEnv;
}

const projectIdEnv = import.meta.env.VITE_FIREBASE_PROJECT_ID;
let projectIdVal = 'demo';
const hasProjectId = projectIdEnv !== undefined && projectIdEnv !== null && projectIdEnv !== '';
if (hasProjectId) {
  projectIdVal = projectIdEnv;
}

const appIdEnv = import.meta.env.VITE_FIREBASE_APP_ID;
let appIdVal = 'demo';
const hasAppId = appIdEnv !== undefined && appIdEnv !== null && appIdEnv !== '';
if (hasAppId) {
  appIdVal = appIdEnv;
}

const messagingSenderIdEnv = import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID;
let messagingSenderIdVal = 'demo';
const hasSenderId = messagingSenderIdEnv !== undefined && messagingSenderIdEnv !== null && messagingSenderIdEnv !== '';
if (hasSenderId) {
  messagingSenderIdVal = messagingSenderIdEnv;
}

const config = {
  apiKey: apiKeyVal,
  authDomain: authDomainVal,
  projectId: projectIdVal,
  appId: appIdVal,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: messagingSenderIdVal,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
};

const existingApps = getApps();
const hasExistingApps = existingApps.length > 0;
let appInstance;
if (hasExistingApps) {
  appInstance = getApp();
} else {
  appInstance = initializeApp(config);
}

export const firebaseApp = appInstance;
export const firebaseConfig = config;
const aiLogicEnv = import.meta.env.VITE_USE_AI_LOGIC;
export const useAiLogic = aiLogicEnv === 'true';
