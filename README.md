# CleanTiers Bot

Discord bot for running tier tests. Anyone can join/leave a gamemode's queue;
testers (people with the "Tester" role) pull the next player and submit a
result, which gets written straight to Firebase — the same database your
website reads from.

## Setup

1. Install [Node.js](https://nodejs.org) if you don't have it.
2. In this folder, run:
   ```
   npm install
   ```
3. Copy `.env.example` to a new file named `.env`, and fill in:
   - `DISCORD_TOKEN` — from the Discord Developer Portal, Bot tab
   - `DISCORD_CLIENT_ID` — from General Information, "Application ID"
   - `DISCORD_GUILD_ID` — your server's ID (enable Developer Mode in Discord
     settings, then right-click your server icon → Copy Server ID)
   - `FIREBASE_DATABASE_URL` — from the Firebase console, Realtime Database
   - `TESTER_ROLE_NAME` — the exact name of your tester role (default: `Tester`)
4. Put the service account JSON file you downloaded from Firebase in this
   folder, named `serviceAccountKey.json` (or update the path in `.env`).
5. Register the slash command:
   ```
   npm run deploy-commands
   ```
6. Start the bot:
   ```
   npm start
   ```
7. In each tiertest channel (see `src/config.js` for the full list), run
   `/postqueue` once. This posts the queue message with Join/Leave/Next/Submit
   buttons for that channel's gamemode.

## How it works

- **Join Queue / Leave Queue** — anyone can click these.
- **Next (Tester)** — only people with the Tester role can use this; it pulls
  the next person off the queue and announces them.
- **Submit Result (Tester)** — tester-only; opens a form asking for the
  player's Minecraft username, region, and tier. Saves it to Firebase.
- The queue itself lives in memory and resets if the bot restarts — that's
  intentional, a live queue shouldn't persist across restarts.

## Adding or renaming gamemode channels

Edit `src/config.js` — the `GAMEMODE_CHANNELS` object maps a Discord channel
name to a gamemode id. Add a new line for any new channel, then run
`/postqueue` in it.

## Never commit

`.env` and `serviceAccountKey.json` contain secrets. Both are already listed
in `.gitignore` so `git add .` won't pick them up — but always run `git
status` before committing to double check.
