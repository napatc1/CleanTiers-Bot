const { SlashCommandBuilder } = require("discord.js");
const { GAMEMODES } = require("./config");

const commands = [
  new SlashCommandBuilder()
    .setName("postqueue")
    .setDescription(
      "Post the tier-test queue message in this channel (run once per channel)."
    ),

  new SlashCommandBuilder()
    .setName("clearcooldown")
    .setDescription(
      "Clear a player's tier-test cooldown so they can queue again early. Testers/managers/admins only."
    )
    .addUserOption((opt) =>
      opt
        .setName("player")
        .setDescription("The player to clear the cooldown for")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("gamemode")
        .setDescription("Which gamemode's cooldown to clear")
        .setRequired(true)
        .addChoices(...GAMEMODES.map((gm) => ({ name: gm, value: gm })))
    ),
];

module.exports = commands;
