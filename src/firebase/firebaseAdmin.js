const admin = require('firebase-admin');
const logger = require('../utils/logger');

let db = null;

/**
 * Initializes the Firebase Admin SDK.
 * Uses a service account from environment variables.
 * Safe to call multiple times - only initializes once.
 */
function initializeFirebase() {
  if (admin.apps.length > 0) {
    db = admin.firestore();
    return;
  }

  try {
    const serviceAccount = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    };

    if (!serviceAccount.projectId || !serviceAccount.clientEmail || !serviceAccount.privateKey) {
      throw new Error('Missing Firebase Admin credentials in environment variables');
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    db = admin.firestore();
    logger.info('Firebase Admin SDK initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize Firebase Admin SDK', error);
    throw error;
  }
}

/**
 * Returns the Firestore database instance.
 * @returns {FirebaseFirestore.Firestore}
 */
function getFirestore() {
  if (!db) {
    throw new Error('Firebase not initialized. Call initializeFirebase() first.');
  }
  return db;
}

module.exports = { initializeFirebase, getFirestore };
