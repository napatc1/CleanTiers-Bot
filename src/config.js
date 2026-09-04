// Maps each tiertest channel name to the gamemode it tests.
// The bot only sets up a queue in channels listed here.
const GAMEMODE_CHANNELS = {
  "crystal-tiertest": "vanilla",
  "axe-tiertest": "axe",
  "sword-tiertest": "sword",
  "mace-tiertest": "mace",
  "netherite-pot-tiertest": "nethop",
  "pot-tiertest": "pot",
  "smp-tiertest": "smp",
  "uhc-tiertest": "uhc",
  "cart-tiertest": "cart",
};

// Every gamemode id the bot knows about (should match the values above).
const GAMEMODES = [
  "vanilla", "axe", "sword", "mace", "nethop", "pot", "smp", "uhc", "cart",
];

// Exact name of the Discord role to ping when a queue opens for each
// gamemode. Edit these to match your actual role names exactly.
const ROLE_PING_NAMES = {
  vanilla: "Crystal",
  axe: "Axe",
  sword: "Sword",
  mace: "Mace",
  nethop: "NethOP",
  pot: "Pot",
  smp: "SMP",
  uhc: "UHC",
  cart: "Cart",
};

// Tiers a tester can assign, best to worst. Matches tiers.js on the website.
const TIER_OPTIONS = [
  "HT1", "LT1", "HT2", "LT2", "HT3", "LT3", "HT4", "LT4", "HT5", "LT5",
];

// How long a player must wait after being tested before they can queue
// again for the same gamemode.
const COOLDOWN_DAYS = 3;

module.exports = { GAMEMODE_CHANNELS, GAMEMODES, ROLE_PING_NAMES, TIER_OPTIONS, COOLDOWN_DAYS };
