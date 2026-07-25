import { getApp, getApps, initializeApp } from 'firebase/app';

const config = {
  apiKey: "AIzaSyBlUIy20Mg26q_MZm9qkT1jHAGhmxaeszs",
  authDomain: "pyric-site.firebaseapp.com",
  projectId: "pyric-site",
  storageBucket: "pyric-site.firebasestorage.app",
  messagingSenderId: "157619808114",
  appId: "1:157619808114:web:e86807e086001aaf269feb",
  measurementId: "G-GZTGQE1M30",
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
