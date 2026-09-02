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
const { setPlayerTier, getCooldownUntil, setCooldown, clearCooldown } = require("./firebase");

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

function buildQueueEmbed(channelId, gamemode) {
  return new EmbedBuilder()
    .setTitle(`${gamemode.toUpperCase()} Tier Test Queue`)
    .setDescription(formatQueue(channelId))
    .setColor(0xffd54a);
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

  // ---------- buttons ----------
  if (interaction.isButton()) {
    // Ticket-only buttons (submit / close) work in ticket channels, which
    // aren't in GAMEMODE_CHANNELS, so handle those before the gamemode check.
    if (interaction.customId.startsWith("ticket_submit_")) {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      const [, , gamemode, testeeId] = interaction.customId.split("_");

      const modal = new ModalBuilder()
        .setCustomId(`submit_result_${gamemode}_${testeeId}`)
        .setTitle(`Submit ${gamemode.toUpperCase()} Result`);

      const nameInput = new TextInputBuilder()
        .setCustomId("player_name")
        .setLabel("Player's Minecraft username")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

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
        new ActionRowBuilder().addComponents(nameInput),
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
  }

  // ---------- modal submit ----------
  if (interaction.isModalSubmit() && interaction.customId.startsWith("submit_result_")) {
    const [, , gamemode, testeeId] = interaction.customId.split("_");
    const name = interaction.fields.getTextInputValue("player_name").trim();
    const region = interaction.fields.getTextInputValue("player_region").trim().toUpperCase();
    const tier = interaction.fields.getTextInputValue("player_tier").trim().toUpperCase();

    if (/[.#$\[\]]/.test(name)) {
      return interaction.reply({
        content: `"${name}" isn't a valid Minecraft username \u2014 it can't contain ".", "#", "$", "[", or "]". Double-check the spelling and try again.`,
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
          await resultsChannel.send({
            embeds: [
              new EmbedBuilder()
                .setTitle("Tier test result")
                .setDescription(
                  `**${name}**${testeeId ? ` (<@${testeeId}>)` : ""} is now **${tier}** in **${gamemode.toUpperCase()}**\nRegion: ${region}\nTested by: <@${interaction.user.id}>`
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
  console.error("DISCORD_TOKEN environment variable is missing.");
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
