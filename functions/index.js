const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const fetch = require("node-fetch");
const AbortController = require("abort-controller");
const logger = require("firebase-functions/logger");

initializeApp();
const db = getFirestore();

const requiredSecrets = ["AI_KEY", "AI_ENDPOINT"];

// The httpsToGsUri function is no longer needed and has been removed.

exports.chatWithAI = onCall({secrets: requiredSecrets, timeoutSeconds: 60}, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in.");
  }

  const uid = request.auth.uid;
  const {conversationId, newMessageText, imageUrl} = request.data;
  const AI_API_KEY = process.env.AI_KEY;
  const AI_API_ENDPOINT = process.env.AI_ENDPOINT;

  const SYSTEM_INSTRUCTION = "You are an expert academic tutor AI named Gemini. You were created by Devin S. as a part of his Google Chrome extension 'School Tools'. Your sole purpose is to help students learn by guiding them to solve problems themselves. Your tone must always be encouraging and supportive. Core Rules: 1. NEVER provide direct answers or solutions to homework or what seems like schoolwork (answers to random questions not related to school curricula is ok). 2. DO NOT give hints. 3. Instead of hints, ask probing, Socratic-style questions that force the student to think critically about the problem. 4. Guide the student step-by-step, focusing on one part of the problem at a time. 5. If a student is stuck, ask them to explain what they've tried so far and where they are getting confused.";


  if (!conversationId) {
    throw new HttpsError("invalid-argument", "Missing conversationId.");
  }
  if (!AI_API_KEY || !AI_API_ENDPOINT) {
    logger.error("AI secrets are not configured in the environment.");
    throw new HttpsError("internal", "AI service is not configured correctly.");
  }

  const userRef = db.collection("users").doc(uid);
  const conversationRef = userRef.collection("conversations").doc(conversationId);

  try {
    const userDoc = await userRef.get();
    const isPremium = userDoc.data()?.is_premium === true;
    const messageCount = userDoc.data()?.messageCount || 0;

    if (!isPremium && messageCount >= 5) {
      throw new HttpsError("permission-denied", "Daily message limit reached. Go Premium for unlimited messages!");
    }

    // --- START: NEW INLINE IMAGE LOGIC ---
    // Prepare the current user's message for the AI using inlineData
    const currentUserParts = [];
    if (imageUrl) {
      const imageResponse = await fetch(imageUrl);
      const imageBuffer = await imageResponse.buffer();
      const base64Data = imageBuffer.toString("base64");
      currentUserParts.push({
        inlineData: {
          mimeType: "image/jpeg",
          data: base64Data,
        },
      });
    }
    if (newMessageText) {
      currentUserParts.push({text: newMessageText});
    }
    if (currentUserParts.length === 0) {
      throw new HttpsError("invalid-argument", "Message cannot be empty.");
    }
    const newUserTurnForAI = {role: "user", parts: currentUserParts};
    // --- END: NEW INLINE IMAGE LOGIC ---

    // Prepare the user's message to be saved in our database (this doesn't change)
    const userTurnForDb = {
      role: "user",
      parts: [{text: newMessageText || ""}, {imageUrl: imageUrl || null}],
    };

    const conversationDoc = await conversationRef.get();
    const historyFromDb = conversationDoc.data()?.history || [];

    // --- START: NEW HISTORY FORMATTING LOGIC ---
    // Re-format the history to use inlineData for any past images
    const historyForAI = await Promise.all(historyFromDb.map(async (turn) => {
      if (turn.role === "user") {
        const validPartsForAI = [];
        const imagePartUrl = turn.parts.find((p) => p.imageUrl)?.imageUrl;
        const textPart = turn.parts.find((p) => p.text)?.text;

        if (imagePartUrl) {
          const imageResponse = await fetch(imagePartUrl);
          const imageBuffer = await imageResponse.buffer();
          const base64Data = imageBuffer.toString("base64");
          validPartsForAI.push({inlineData: {mimeType: "image/jpeg", data: base64Data}});
        }
        if (textPart) {
          validPartsForAI.push({text: textPart});
        }
        return {role: "user", parts: validPartsForAI};
      }
      return turn;
    }));

    const fullPrompt = [...historyForAI, newUserTurnForAI];
    const fullUrl = `${AI_API_ENDPOINT}?key=${AI_API_KEY}`;

    const requestBody = {
      contents: fullPrompt,
      systemInstruction: {
        parts: [{text: SYSTEM_INSTRUCTION}],
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);

    const response = await fetch(fullUrl, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      // Use the new requestBody object here
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error("AI API request failed:", {status: response.status, body: errorBody});
      throw new HttpsError("internal", "The AI service failed to respond.");
    }

    const responseData = await response.json();
    const aiMessage = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!aiMessage) {
      logger.error("Failed to parse AI response:", responseData);
      throw new HttpsError("internal", "Could not understand the AI response.");
    }

    const newModelTurn = {role: "model", parts: [{text: aiMessage}]};

    await conversationRef.update({
      history: FieldValue.arrayUnion(userTurnForDb, newModelTurn),
      updatedAt: new Date(),
    });

    if (!isPremium) {
      await userRef.update({messageCount: FieldValue.increment(1)});
    }

    return {reply: aiMessage};
  } catch (error) {
    logger.error("Error in chatWithAI:", error);
    if (error.name === "AbortError") {
      throw new HttpsError("deadline-exceeded", "The AI took too long to respond. Please try again.");
    }
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "An unexpected error occurred.");
  }
});
