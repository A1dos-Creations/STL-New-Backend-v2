const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");
const cors = require("cors")({
  origin: [
    "https://a1dos-creations.com",
    "http://localhost:5173",
  ],
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
});
const functions = require("firebase-functions");

initializeApp();
const db = getFirestore();

exports.createCustomAuthToken = functions.https.onRequest((req, res) => {
  // Handle CORS + Preflight
  cors(req, res, async () => {
    if (req.method === "OPTIONS") {
      return res.status(204).send("");
    }

    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    const {email, password, name, isRegistering} = req.body.data;

    if (!email || !password) {
      logger.error("Auth attempt missing email or password.");
      return res.status(400).json({
        error: {
          message: "Email and password are required.",
        },
      });
    }

    try {
      let userRecord;
      if (isRegistering) {
        if (!name) {
          return res.status(400).json({error: {message: "Name is required."}});
        }

        userRecord = await admin.auth().createUser({
          email,
          password,
          displayName: name,
        });

        await db.collection("users").doc(userRecord.uid).set({
          email: userRecord.email,
          displayName: name,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          is_premium: false,
          messageCount: 0,
        });

        logger.info(`New user registered: ${userRecord.uid}`);
      } else {
        // --- Login Flow ---
        userRecord = await admin.auth().getUserByEmail(email);
      }

      const customToken = await admin.auth().createCustomToken(userRecord.uid);
      return res.status(200).json({data: {token: customToken}});
    } catch (error) {
      logger.error("Auth Token Error:", error.code, error.message);
      const publicError = {
        code: error.code || "unknown",
        message:
          error.code === "auth/email-already-exists" ? "This email address is already in use." : "Invalid credentials or user does not exist.",
      };

      return res.status(401).json({error: publicError});
    }
  });
});
