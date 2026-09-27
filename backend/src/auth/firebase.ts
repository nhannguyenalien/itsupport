import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId) throw new Error("FIREBASE_PROJECT_ID is not set");

const app = getApps()[0] ?? initializeApp({
  projectId,
  ...(process.env.GOOGLE_APPLICATION_CREDENTIALS ? { credential: applicationDefault() } : {}),
});

export const firebaseAuth = getAuth(app);
