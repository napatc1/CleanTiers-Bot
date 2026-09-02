const admin = require("firebase-admin");
const path = require("path");
require("dotenv").config();

// On a cloud host there's no file to upload, so the service account JSON is
// passed as a base64-encoded environment variable instead. Locally, it
// falls back to reading the downloaded .json file directly.
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  try {
    const decoded = Buffer.from(
      process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
      "base64"
    ).toString("utf8");
    serviceAccount = JSON.parse(decoded);
  } catch (err) {
    console.error(
      "FIREBASE_SERVICE_ACCOUNT_BASE64 is set but couldn't be decoded/parsed as JSON. Double-check you copied the FULL base64 output with nothing missing or added."
    );
    throw err;
  }
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
  serviceAccount = require(path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH));
} else {
  console.error(
    "No Firebase credentials found. Set either FIREBASE_SERVICE_ACCOUNT_BASE64 (cloud hosting) or FIREBASE_SERVICE_ACCOUNT_PATH (local) as an environment variable."
  );
  process.exit(1);
}

if (!process.env.FIREBASE_DATABASE_URL) {
  console.error("FIREBASE_DATABASE_URL environment variable is missing.");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

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
