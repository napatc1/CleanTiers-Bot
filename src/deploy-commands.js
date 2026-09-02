require("dotenv").config();
const { REST, Routes } = require("discord.js");
const commands = require("./commands");

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("Registering slash commands...");
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.DISCORD_CLIENT_ID,
        process.env.DISCORD_GUILD_ID
      ),
      { body: commands.map((c) => c.toJSON()) }
    );
    console.log("Commands registered.");
  } catch (err) {
    console.error(err);
  }
})();
