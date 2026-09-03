const admin = require("firebase-admin");
const path = require("path");
require("dotenv").config();

console.log("[startup] firebase.js loaded, checking credentials...");

// On a cloud host there's no file to upload, so the service account JSON is
// passed as a base64-encoded environment variable instead. Locally, it
// falls back to reading the downloaded .json file directly.
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  console.log("[startup] found FIREBASE_SERVICE_ACCOUNT_BASE64, decoding...");
  try {
    const decoded = Buffer.from(
      process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
      "base64"
    ).toString("utf8");
    serviceAccount = JSON.parse(decoded);
    console.log("[startup] decoded and parsed service account JSON OK, project_id:", serviceAccount.project_id);
  } catch (err) {
    console.error(
      "[startup] FIREBASE_SERVICE_ACCOUNT_BASE64 is set but couldn't be decoded/parsed as JSON:", err.message
    );
    throw err;
  }
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
  console.log("[startup] using FIREBASE_SERVICE_ACCOUNT_PATH file instead");
  serviceAccount = require(path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH));
} else {
  console.error(
    "[startup] No Firebase credentials found. Neither FIREBASE_SERVICE_ACCOUNT_BASE64 nor FIREBASE_SERVICE_ACCOUNT_PATH is set."
  );
  process.exit(1);
}

if (!process.env.FIREBASE_DATABASE_URL) {
  console.error("[startup] FIREBASE_DATABASE_URL environment variable is missing.");
  process.exit(1);
}

console.log("[startup] initializing Firebase admin app with database:", process.env.FIREBASE_DATABASE_URL);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

console.log("[startup] Firebase admin app initialized OK");

const db = admin.database();

// Writes/updates one gamemode's tier for a player, keyed by their name.
// Creates the player and region if they don't exist yet.
async function setPlayerTier(playerName, region, gamemode, tier) {
  const ref = db.ref(`players/${playerName}`);
  const snapshot = await ref.once("value");
  const existing = snapshot.val();

  await ref.set({
    name: playerName,
    region: existing?.region || region,
    tiers: {
      ...(existing?.tiers || {}),
      [gamemode]: tier,
    },
  });
}

async function getPlayer(playerName) {
  const snapshot = await db.ref(`players/${playerName}`).once("value");
  return snapshot.val();
}

// Cooldowns are keyed by Discord user id (not Minecraft name), since the
// queue itself is joined/left by Discord account.
async function getCooldownUntil(gamemode, discordUserId) {
  const snapshot = await db
    .ref(`cooldowns/${gamemode}/${discordUserId}`)
    .once("value");
  return snapshot.val(); // ms timestamp, or null if never tested
}

async function setCooldown(gamemode, discordUserId, timestampMs) {
  await db.ref(`cooldowns/${gamemode}/${discordUserId}`).set(timestampMs);
}

async function clearCooldown(gamemode, discordUserId) {
  await db.ref(`cooldowns/${gamemode}/${discordUserId}`).remove();
}

module.exports = {
  db,
  setPlayerTier,
  getPlayer,
  getCooldownUntil,
  setCooldown,
  clearCooldown,
};
