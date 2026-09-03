console.log("[startup] index.js starting...");
require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
  ChannelType,
} = require("discord.js");
const { GAMEMODE_CHANNELS, TIER_OPTIONS, COOLDOWN_DAYS } = require("./config");
const { joinQueue, leaveQueue, popNext, formatQueue } = require("./queue");
const { setPlayerTier, getPlayer, getCooldownUntil, setCooldown, clearCooldown, setVerifiedUsername, getVerifiedUsername } = require("./firebase");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});

// ---------- helpers ----------

const testerRoleNames = (process.env.TESTER_ROLE_NAMES || "Tester")
  .split(",")
  .map((r) => r.trim().toLowerCase());

const managerRoleNames = (process.env.MANAGER_ROLE_NAMES || "Manager")
  .split(",")
  .map((r) => r.trim().toLowerCase());

function isTester(member) {
  return member.roles.cache.some((r) =>
    testerRoleNames.includes(r.name.toLowerCase())
  );
}

// Testers, managers, and anyone with real admin/manage-server power can
// clear cooldowns. This is deliberately broader than isTester().
function canManageCooldowns(member) {
  return (
    isTester(member) ||
    member.roles.cache.some((r) => managerRoleNames.includes(r.name.toLowerCase())) ||
    member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    member.permissions.has(PermissionsBitField.Flags.ManageGuild)
  );
}

const COOLDOWN_MS = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

function formatRemaining(ms) {
  const hours = Math.ceil(ms / (60 * 60 * 1000));
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.ceil(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function getTesterRoles(guild) {
  return guild.roles.cache.filter((r) =>
    testerRoleNames.includes(r.name.toLowerCase())
  );
}

// A player must already be tiered LT3 or better (index <= this) in the
// gamemode to join its high queue. Untested players, or anyone HT4 or
// worse, can't join.
const HIGH_QUEUE_MAX_INDEX = TIER_OPTIONS.indexOf("LT3");

function buildQueueEmbed(channelId, gamemode) {
  return new EmbedBuilder()
    .setTitle(`${gamemode.toUpperCase()} Tier Test Queue`)
    .setDescription(formatQueue(channelId))
    .setColor(0xffd54a);
}

function buildHighQueueEmbed(highKey, gamemode) {
  return new EmbedBuilder()
    .setTitle(`${gamemode.toUpperCase()} HIGH Tier Test Queue`)
    .setDescription(
      `Only players already tiered **LT3 or better** in ${gamemode.toUpperCase()} can join.\n\n${formatQueue(highKey)}`
    )
    .setColor(0xff8a3d);
}

// Main queue message: anyone can Join/Leave, testers can pull Next.
// Submitting a result now happens inside the private ticket, not here.
function buildQueueButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("queue_join")
      .setLabel("Join Queue")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("queue_leave")
      .setLabel("Leave Queue")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("queue_next")
      .setLabel("Next (Tester)")
      .setStyle(ButtonStyle.Primary)
  );
}

function buildHighQueueButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("highqueue_join")
      .setLabel("Join High Queue")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("highqueue_leave")
      .setLabel("Leave Queue")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("highqueue_next")
      .setLabel("Next (Tester)")
      .setStyle(ButtonStyle.Primary)
  );
}

function buildTicketButtons(gamemode, testeeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_submit_${gamemode}_${testeeId}`)
      .setLabel("Submit Result")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("ticket_close")
      .setLabel("Close Without Saving")
      .setStyle(ButtonStyle.Secondary)
  );
}

async function refreshQueueMessage(interaction, gamemode) {
  await interaction.message.edit({
    embeds: [buildQueueEmbed(interaction.channelId, gamemode)],
    components: [buildQueueButtons()],
  });
}

async function refreshHighQueueMessage(interaction, gamemode) {
  const highKey = `${interaction.channelId}:high`;
  await interaction.message.edit({
    embeds: [buildHighQueueEmbed(highKey, gamemode)],
    components: [buildHighQueueButtons()],
  });
}

// Sanitizes a name into something valid for a Discord channel name.
function slugify(str) {
  return (
    str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "player"
  );
}

// Creates a private channel visible only to the claiming tester(s) with the
// Tester role, the testee, and the tester who claimed them. Server owners
// and anyone with Administrator automatically bypass overwrites, so they
// always have access without needing an explicit entry.
async function createTicketChannel(guild, sourceChannel, gamemode, testerMember, testeeId) {
  const testeeMember = await guild.members.fetch(testeeId).catch(() => null);
  const testerRoles = getTesterRoles(guild);

  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionsBitField.Flags.ViewChannel],
    },
    {
      id: testerMember.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    },
    ...testerRoles.map((role) => ({
      id: role.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    })),
  ];

  if (testeeMember) {
    overwrites.push({
      id: testeeMember.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    });
  }

  const channel = await guild.channels.create({
    name: `ticket-${gamemode}-${slugify(testeeMember ? testeeMember.user.username : testeeId)}`,
    type: ChannelType.GuildText,
    parent: sourceChannel.parentId || null,
    permissionOverwrites: overwrites,
  });

  await channel.send({
    content: `<@${testeeId}> <@${testerMember.id}>`,
    embeds: [
      new EmbedBuilder()
        .setTitle(`${gamemode.toUpperCase()} test in progress`)
        .setDescription(
          `Tester: <@${testerMember.id}>\nTestee: <@${testeeId}>\n\nWhen the test is done, click **Submit Result** to save the tier and close this ticket. Only testers and the testee can see this channel.`
        )
        .setColor(0xffd54a),
    ],
    components: [buildTicketButtons(gamemode, testeeId)],
  });

  return channel;
}

// ---------- interactions ----------

client.on("interactionCreate", async (interaction) => {
 try {
  // /postqueue
  if (interaction.isChatInputCommand() && interaction.commandName === "postqueue") {
    const gamemode = GAMEMODE_CHANNELS[interaction.channel.name];
    if (!gamemode) {
      return interaction.reply({
        content: "This channel isn't set up as a tiertest channel in config.js.",
        ephemeral: true,
      });
    }
    await interaction.reply({
      embeds: [buildQueueEmbed(interaction.channelId, gamemode)],
      components: [buildQueueButtons()],
    });
    return;
  }

  // /verify
  if (interaction.isChatInputCommand() && interaction.commandName === "verify") {
    const username = interaction.options.getString("username", true).trim();
    if (/[.#$\[\]]/.test(username)) {
      return interaction.reply({
        content: `"${username}" isn't a valid Minecraft username \u2014 it can't contain ".", "#", "$", "[", or "]".`,
        ephemeral: true,
      });
    }
    await setVerifiedUsername(interaction.user.id, username);
    return interaction.reply({
      content: `Linked your Discord account to Minecraft username **${username}**.`,
      ephemeral: true,
    });
  }

  // /posthighqueue
  if (interaction.isChatInputCommand() && interaction.commandName === "posthighqueue") {
    const gamemode = GAMEMODE_CHANNELS[interaction.channel.name];
    if (!gamemode) {
      return interaction.reply({
        content: "This channel isn't set up as a tiertest channel in config.js.",
        ephemeral: true,
      });
    }
    const highKey = `${interaction.channelId}:high`;
    await interaction.reply({
      embeds: [buildHighQueueEmbed(highKey, gamemode)],
      components: [buildHighQueueButtons()],
    });
    return;
  }

  // /clearcooldown
  if (interaction.isChatInputCommand() && interaction.commandName === "clearcooldown") {
    if (!canManageCooldowns(interaction.member)) {
      return interaction.reply({
        content: "Only testers, managers, or admins can do that.",
        ephemeral: true,
      });
    }
    const targetUser = interaction.options.getUser("player", true);
    const gamemode = interaction.options.getString("gamemode", true);
    await clearCooldown(gamemode, targetUser.id);
    return interaction.reply({
      content: `Cleared <@${targetUser.id}>'s **${gamemode}** cooldown. They can queue again now.`,
    });
  }

  // /settier
  if (interaction.isChatInputCommand() && interaction.commandName === "settier") {
    if (!canManageCooldowns(interaction.member)) {
      return interaction.reply({
        content: "Only testers, managers, or admins can do that.",
        ephemeral: true,
      });
    }

    const username = interaction.options.getString("username", true).trim();
    const gamemode = interaction.options.getString("gamemode", true);
    const tier = interaction.options.getString("tier", true);
    const region = interaction.options.getString("region");

    if (/[.#$\[\]]/.test(username)) {
      return interaction.reply({
        content: `"${username}" isn't a valid Minecraft username \u2014 it can't contain ".", "#", "$", "[", or "]".`,
        ephemeral: true,
      });
    }

    const existing = await getPlayer(username);
    if (!existing && !region) {
      return interaction.reply({
        content: `**${username}** isn't on the site yet, so you need to also set the "region" option to add them.`,
        ephemeral: true,
      });
    }

    try {
      const previousTier = existing?.tiers?.[gamemode];
      await setPlayerTier(username, region, gamemode, tier);
      await interaction.reply({
        content: `Set **${username}** to **${tier}** in **${gamemode}**. The website will update automatically.`,
      });

      if (process.env.RESULTS_CHANNEL_ID) {
        const resultsChannel = await interaction.guild.channels
          .fetch(process.env.RESULTS_CHANNEL_ID)
          .catch(() => null);
        if (resultsChannel) {
          const changeText = previousTier ? `${previousTier} \u2192 ${tier}` : `Untested \u2192 ${tier}`;
          await resultsChannel.send({
            embeds: [
              new EmbedBuilder()
                .setTitle("Manual tier change")
                .setDescription(
                  `**${username}** in **${gamemode.toUpperCase()}**: ${changeText}\nChanged by: <@${interaction.user.id}>`
                )
                .setColor(0xffd54a),
            ],
          });
        }
      }
    } catch (err) {
      console.error(err);
      return interaction.reply({
        content: "Something went wrong saving that to the database.",
        ephemeral: true,
      });
    }
    return;
  }

  // ---------- buttons ----------
  if (interaction.isButton()) {
    // Ticket-only buttons (submit / close) work in ticket channels, which
    // aren't in GAMEMODE_CHANNELS, so handle those before the gamemode check.
    if (interaction.customId.startsWith("ticket_submit_")) {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      const [, , gamemode, testeeId] = interaction.customId.split("_");

      const verifiedUsername = await getVerifiedUsername(testeeId);
      if (!verifiedUsername) {
        return interaction.reply({
          content: `<@${testeeId}> hasn't linked a Minecraft username yet. They need to run \`/verify username:<their IGN>\` before a result can be submitted.`,
          ephemeral: true,
        });
      }

      const modal = new ModalBuilder()
        .setCustomId(`submit_result_${gamemode}_${testeeId}`)
        .setTitle(`Submit ${gamemode.toUpperCase()} Result`);

      const regionInput = new TextInputBuilder()
        .setCustomId("player_region")
        .setLabel("Region (NA, EU, AS, ME, or AU)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const tierInput = new TextInputBuilder()
        .setCustomId("player_tier")
        .setLabel("Tier")
        .setPlaceholder(TIER_OPTIONS.join(", "))
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(regionInput),
        new ActionRowBuilder().addComponents(tierInput)
      );

      return interaction.showModal(modal);
    }

    if (interaction.customId === "ticket_close") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      await interaction.reply({ content: "Closing ticket without saving a result..." });
      setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
      return;
    }

    // Everything below only applies inside actual gamemode queue channels.
    const gamemode = GAMEMODE_CHANNELS[interaction.channel.name];
    if (!gamemode) return;

    if (interaction.customId === "queue_join") {
      const cooldownUntil = await getCooldownUntil(gamemode, interaction.user.id);
      if (cooldownUntil && cooldownUntil > Date.now()) {
        return interaction.reply({
          content: `You were tested in **${gamemode}** recently. You can queue again in ${formatRemaining(cooldownUntil - Date.now())}.`,
          ephemeral: true,
        });
      }
      const joined = joinQueue(interaction.channelId, interaction.user.id);
      await refreshQueueMessage(interaction, gamemode);
      return interaction.reply({
        content: joined ? "You joined the queue." : "You're already in the queue.",
        ephemeral: true,
      });
    }

    if (interaction.customId === "queue_leave") {
      const left = leaveQueue(interaction.channelId, interaction.user.id);
      await refreshQueueMessage(interaction, gamemode);
      return interaction.reply({
        content: left ? "You left the queue." : "You weren't in the queue.",
        ephemeral: true,
      });
    }

    if (interaction.customId === "queue_next") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      const nextUserId = popNext(interaction.channelId);
      await refreshQueueMessage(interaction, gamemode);

      if (!nextUserId) {
        return interaction.reply({ content: "Queue is empty.", ephemeral: true });
      }

      try {
        const ticketChannel = await createTicketChannel(
          interaction.guild,
          interaction.channel,
          gamemode,
          interaction.member,
          nextUserId
        );
        return interaction.reply({
          content: `Created a private ticket for <@${nextUserId}>: ${ticketChannel}`,
          ephemeral: true,
        });
      } catch (err) {
        console.error(err);
        return interaction.reply({
          content:
            "Couldn't create the ticket channel. Make sure the bot has the \"Manage Channels\" permission.",
          ephemeral: true,
        });
      }
    }

    // ---------- high queue ----------
    if (interaction.customId === "highqueue_join") {
      const highKey = `${interaction.channelId}:high`;

      const username = await getVerifiedUsername(interaction.user.id);
      if (!username) {
        return interaction.reply({
          content: `You need to link your Minecraft account first \u2014 run \`/verify username:<your IGN>\`, then try joining again.`,
          ephemeral: true,
        });
      }

      const player = await getPlayer(username);
      const currentTier = player?.tiers?.[gamemode];
      const tierIndex = currentTier ? TIER_OPTIONS.indexOf(currentTier) : -1;

      if (tierIndex === -1 || tierIndex > HIGH_QUEUE_MAX_INDEX) {
        return interaction.reply({
          content: `The high queue for **${gamemode}** is only open to players already tiered **LT3 or better**. Your current tier: **${currentTier || "Untested"}**.`,
          ephemeral: true,
        });
      }

      const joined = joinQueue(highKey, interaction.user.id);
      await refreshHighQueueMessage(interaction, gamemode);
      return interaction.reply({
        content: joined ? "You joined the high queue." : "You're already in the high queue.",
        ephemeral: true,
      });
    }

    if (interaction.customId === "highqueue_leave") {
      const highKey = `${interaction.channelId}:high`;
      const left = leaveQueue(highKey, interaction.user.id);
      await refreshHighQueueMessage(interaction, gamemode);
      return interaction.reply({
        content: left ? "You left the high queue." : "You weren't in the high queue.",
        ephemeral: true,
      });
    }

    if (interaction.customId === "highqueue_next") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      const highKey = `${interaction.channelId}:high`;
      const nextUserId = popNext(highKey);
      await refreshHighQueueMessage(interaction, gamemode);

      if (!nextUserId) {
        return interaction.reply({ content: "High queue is empty.", ephemeral: true });
      }

      try {
        const ticketChannel = await createTicketChannel(
          interaction.guild,
          interaction.channel,
          gamemode,
          interaction.member,
          nextUserId
        );
        return interaction.reply({
          content: `Created a private ticket for <@${nextUserId}>: ${ticketChannel}`,
          ephemeral: true,
        });
      } catch (err) {
        console.error(err);
        return interaction.reply({
          content:
            "Couldn't create the ticket channel. Make sure the bot has the \"Manage Channels\" permission.",
          ephemeral: true,
        });
      }
    }
  }

  // ---------- modal submit ----------
  if (interaction.isModalSubmit() && interaction.customId.startsWith("submit_result_")) {
    const [, , gamemode, testeeId] = interaction.customId.split("_");
    const region = interaction.fields.getTextInputValue("player_region").trim().toUpperCase();
    const tier = interaction.fields.getTextInputValue("player_tier").trim().toUpperCase();

    const name = await getVerifiedUsername(testeeId);
    if (!name) {
      return interaction.reply({
        content: `<@${testeeId}> isn't verified anymore \u2014 they need to run \`/verify\` again before this can be saved.`,
        ephemeral: true,
      });
    }

    if (!TIER_OPTIONS.includes(tier)) {
      return interaction.reply({
        content: `"${tier}" isn't a valid tier. Use one of: ${TIER_OPTIONS.join(", ")}`,
        ephemeral: true,
      });
    }
    if (!["NA", "EU", "AS", "ME", "AU"].includes(region)) {
      return interaction.reply({
        content: `"${region}" isn't a valid region. Use NA, EU, AS, ME, or AU.`,
        ephemeral: true,
      });
    }

    try {
      const existingPlayer = await getPlayer(name);
      const previousTier = existingPlayer?.tiers?.[gamemode];

      await setPlayerTier(name, region, gamemode, tier);
      if (testeeId) {
        await setCooldown(gamemode, testeeId, Date.now() + COOLDOWN_MS);
      }
      await interaction.reply({
        content: `Saved: **${name}** is now **${tier}** in **${gamemode}**. The website will update automatically. They're on a ${COOLDOWN_DAYS}-day cooldown for this gamemode. Closing this ticket in 5 seconds...`,
      });

      if (process.env.RESULTS_CHANNEL_ID) {
        const resultsChannel = await interaction.guild.channels
          .fetch(process.env.RESULTS_CHANNEL_ID)
          .catch(() => null);
        if (resultsChannel) {
          const changeText = previousTier ? `${previousTier} \u2192 ${tier}` : `Untested \u2192 ${tier}`;
          await resultsChannel.send({
            embeds: [
              new EmbedBuilder()
                .setTitle("Tier test result")
                .setDescription(
                  `**${name}**${testeeId ? ` (<@${testeeId}>)` : ""} in **${gamemode.toUpperCase()}**: ${changeText}\nRegion: ${region}\nTested by: <@${interaction.user.id}>`
                )
                .setColor(0xffd54a),
            ],
          });
        }
      }

      setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
    } catch (err) {
      console.error(err);
      return interaction.reply({
        content: "Something went wrong saving that to the database.",
        ephemeral: true,
      });
    }
  }
 } catch (err) {
   console.error("Interaction handler error:", err);
   try {
     if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
       await interaction.reply({ content: "Something went wrong handling that. Check the bot console for details.", ephemeral: true });
     }
   } catch (_) {}
 }
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// Catch anything that slips through interaction handling so a single bad
// click can't take the whole bot process down.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

// Render's free tier is built for web apps, not background workers. This
// tiny server does nothing except answer "OK" so Render (and an uptime
// pinger, if you set one up) sees the app as alive. It has no effect on
// the actual Discord bot logic above.
const http = require("http");
http
  .createServer((req, res) => res.end("CleanTiers bot is running."))
  .listen(process.env.PORT || 3000);

if (!process.env.DISCORD_TOKEN) {
  console.error("[startup] DISCORD_TOKEN environment variable is missing.");
  process.exit(1);
}

console.log("[startup] health server listening, attempting Discord login...");

client
  .login(process.env.DISCORD_TOKEN)
  .then(() => console.log("[startup] client.login() promise resolved"))
  .catch((err) => {
    console.error("[startup] client.login() rejected:", err.message);
  });
