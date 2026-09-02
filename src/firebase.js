const admin = require("firebase-admin");
const path = require("path");
require("dotenv").config();

const serviceAccount = require(
  path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH)
);

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
