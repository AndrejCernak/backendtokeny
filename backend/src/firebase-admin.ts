// firebase-admin.ts
import admin from "firebase-admin";
import "dotenv/config";

const privateKey = process.env.FIREBASE_PRIVATE_KEY
  ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
  : undefined;

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
    privateKey,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  } as admin.ServiceAccount),
});

export default admin;