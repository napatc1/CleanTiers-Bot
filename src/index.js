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
const { GAMEMODE_CHANNELS, TIER_OPTIONS, COOLDOWN_DAYS, ROLE_PING_IDS } = require("./config");
const {
  joinQueue,
  leaveQueue,
  popNext,
  formatQueue,
  getQueue,
  isQueueClosed,
  setQueueClosed,
  setActiveTesting,
  getActiveTesting,
  clearActiveTestingByTicket,
  getActiveTestingByTicket,
  addQueueTester,
  removeQueueTester,
  getQueueTesters,
  setQueueMessage,
  getQueueMessage,
} = require("./queue");
const { db, setPlayerTier, getPlayer, getCooldownUntil, setCooldown, clearCooldown, setVerifiedUsername, getVerifiedUsername, setLiveTest, clearLiveTest, logTestResult } = require("./firebase");

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

// Finds the configured role for a gamemode by ID and returns a pingable
// mention string, or empty string if not configured/found.
function getRolePing(guild, gamemode) {
  const roleId = ROLE_PING_IDS[gamemode];
  if (!roleId) return "";
  const role = guild.roles.cache.get(roleId);
  return role ? `<@&${role.id}> ` : "";
}

function activeTestersBlock(queueKey) {
  const testers = getQueueTesters(queueKey);
  const active = getActiveTesting(queueKey);

  let block = "";
  if (active) {
    block += `**Testing:** <@${active.testeeId}>\n`;
  }
  if (testers.length > 0) {
    block += `**Active Testers:**\n${testers.map((id, i) => `${i + 1}. <@${id}>`).join("\n")}\n`;
  }
  return block ? block + "\n" : "";
}

function buildQueueEmbed(channelId, gamemode) {
  const closed = isQueueClosed(channelId);
  const count = getQueue(channelId).length;
  return new EmbedBuilder()
    .setTitle(`${gamemode.toUpperCase()} Queue (${count})${closed ? " \u2014 CLOSED" : ""}`)
    .setDescription(
      (closed ? "_Queue is closed. No new joins right now._\n\n" : "") +
        activeTestersBlock(channelId) +
        formatQueue(channelId)
    )
    .setColor(closed ? 0x555555 : 0xffd54a);
}

function buildHighQueueEmbed(highKey, gamemode) {
  const closed = isQueueClosed(highKey);
  const count = getQueue(highKey).length;
  return new EmbedBuilder()
    .setTitle(`${gamemode.toUpperCase()} HIGH Queue (${count})${closed ? " \u2014 CLOSED" : ""}`)
    .setDescription(
      (closed ? "_Queue is closed. No new joins right now._\n\n" : "") +
        activeTestersBlock(highKey) +
        `Only players already tiered **LT3 or better** in ${gamemode.toUpperCase()} can join.\n\n${formatQueue(highKey)}`
    )
    .setColor(closed ? 0x555555 : 0xff8a3d);
}

// Main queue message: anyone can Join/Leave, testers can pull Next or
// close/reopen the queue to new joins.
function buildQueueButtons(channelId) {
  const closed = isQueueClosed(channelId);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("queue_join")
      .setLabel("Join Queue")
      .setStyle(ButtonStyle.Success)
      .setDisabled(closed),
    new ButtonBuilder()
      .setCustomId("queue_leave")
      .setLabel("Leave Queue")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("queue_next")
      .setLabel("Next (Tester)")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("queue_toggle_close")
      .setLabel(closed ? "Unlock Queue" : "Lock Queue")
      .setStyle(closed ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("queue_delete")
      .setLabel("Close Queue")
      .setStyle(ButtonStyle.Danger)
  );
}

function buildHighQueueButtons(highKey) {
  const closed = isQueueClosed(highKey);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("highqueue_join")
      .setLabel("Join High Queue")
      .setStyle(ButtonStyle.Success)
      .setDisabled(closed),
    new ButtonBuilder()
      .setCustomId("highqueue_leave")
      .setLabel("Leave Queue")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("highqueue_next")
      .setLabel("Next (Tester)")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("highqueue_toggle_close")
      .setLabel(closed ? "Unlock Queue" : "Lock Queue")
      .setStyle(closed ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("highqueue_delete")
      .setLabel("Close Queue")
      .setStyle(ButtonStyle.Danger)
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
    components: [buildQueueButtons(interaction.channelId)],
  });
}

async function refreshHighQueueMessage(interaction, gamemode) {
  const highKey = `${interaction.channelId}:high`;
  await interaction.message.edit({
    embeds: [buildHighQueueEmbed(highKey, gamemode)],
    components: [buildHighQueueButtons(highKey)],
  });
}

// Called when a ticket closes (result submitted or cancelled). Clears the
// "currently testing" state and refreshes the original queue message so it
// stops showing this session. Returns the removed info (or null) in case
// the caller needs it, e.g. to log a completed result.
async function clearActiveTestingAndRefresh(guild, ticketChannelId) {
  const info = clearActiveTestingByTicket(ticketChannelId);
  await clearLiveTest(ticketChannelId);
  if (!info) return null;
  try {
    const queueChannel = await guild.channels.fetch(info.queueChannelId);
    const queueMessage = await queueChannel.messages.fetch(info.queueMessageId);
    if (info.isHigh) {
      const highKey = `${info.queueChannelId}:high`;
      await queueMessage.edit({
        embeds: [buildHighQueueEmbed(highKey, info.gamemode)],
        components: [buildHighQueueButtons(highKey)],
      });
    } else {
      await queueMessage.edit({
        embeds: [buildQueueEmbed(info.queueChannelId, info.gamemode)],
        components: [buildQueueButtons(info.queueChannelId)],
      });
    }
  } catch (err) {
    console.error("Couldn't refresh queue message after ticket closed:", err.message);
  }
  return info;
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

// For the website's live/recent test displays: prefer the verified
// Minecraft username (so mc-heads.net shows a real head), falling back to
// their Discord username if they haven't run /verify.
async function resolveDisplayName(guild, discordUserId) {
  const verified = await getVerifiedUsername(discordUserId);
  if (verified) return verified;
  const member = await guild.members.fetch(discordUserId).catch(() => null);
  return member ? member.user.username : discordUserId;
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
    addQueueTester(interaction.channelId, interaction.user.id);
    await interaction.reply({ content: "Queue posted below.", ephemeral: true });
    const queueMsg = await interaction.channel.send({
      content: `${getRolePing(interaction.guild, gamemode)}Queue is open!`,
      embeds: [buildQueueEmbed(interaction.channelId, gamemode)],
      components: [buildQueueButtons(interaction.channelId)],
    });
    setQueueMessage(interaction.channelId, interaction.channelId, queueMsg.id);
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

  // /jointesting
  if (interaction.isChatInputCommand() && interaction.commandName === "jointesting") {
    if (!isTester(interaction.member)) {
      return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
    }
    const gamemode = GAMEMODE_CHANNELS[interaction.channel.name];
    if (!gamemode) {
      return interaction.reply({
        content: "Run this in a tiertest queue channel, not here.",
        ephemeral: true,
      });
    }

    const added = addQueueTester(interaction.channelId, interaction.user.id);
    if (!added) {
      return interaction.reply({
        content: `You're already testing **${gamemode}**.`,
        ephemeral: true,
      });
    }

    // If a test is already in progress, add this tester to that ticket too
    // so they don't have to wait for the next pull.
    const active = getActiveTesting(interaction.channelId);
    if (active && !active.testerIds.includes(interaction.user.id)) {
      try {
        const ticketChannel = await interaction.guild.channels.fetch(active.ticketChannelId);
        await ticketChannel.permissionOverwrites.edit(interaction.user.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        });
        active.testerIds.push(interaction.user.id);
        await ticketChannel.send({
          content: `<@${interaction.user.id}> joined this test as a second tester.`,
        });
      } catch (err) {
        console.error("Couldn't add jointesting tester to active ticket:", err.message);
      }
    }

    // Refresh the queue message so the Active Testers list shows the new tester.
    try {
      const stored = getQueueMessage(interaction.channelId);
      if (stored) {
        const queueChannel = await interaction.guild.channels.fetch(stored.channelId);
        const queueMessage = await queueChannel.messages.fetch(stored.messageId);
        await queueMessage.edit({
          embeds: [buildQueueEmbed(interaction.channelId, gamemode)],
          components: [buildQueueButtons(interaction.channelId)],
        });
      }
    } catch (err) {
      console.error("Couldn't refresh queue message after jointesting:", err.message);
    }

    return interaction.reply({
      content: `You're now testing **${gamemode}** alongside the other tester(s).`,
      ephemeral: true,
    });
  }

  // /leavetesting
  if (interaction.isChatInputCommand() && interaction.commandName === "leavetesting") {
    const gamemode = GAMEMODE_CHANNELS[interaction.channel.name];
    if (!gamemode) {
      return interaction.reply({
        content: "Run this in a tiertest queue channel, not here.",
        ephemeral: true,
      });
    }

    const removed = removeQueueTester(interaction.channelId, interaction.user.id);
    if (!removed) {
      return interaction.reply({
        content: `You're not currently testing **${gamemode}**.`,
        ephemeral: true,
      });
    }

    // If a test is in progress and this tester was part of it, drop them
    // from that ticket's tester list and revoke their personal access.
    const active = getActiveTesting(interaction.channelId);
    if (active) {
      const idx = active.testerIds.indexOf(interaction.user.id);
      if (idx !== -1) {
        active.testerIds.splice(idx, 1);
        try {
          const ticketChannel = await interaction.guild.channels.fetch(active.ticketChannelId);
          await ticketChannel.permissionOverwrites.delete(interaction.user.id).catch(() => {});
          await ticketChannel.send({
            content: `<@${interaction.user.id}> stopped testing this one.`,
          });
        } catch (err) {
          console.error("Couldn't remove leavetesting tester from active ticket:", err.message);
        }
      }
    }

    // Refresh the queue message so the Active Testers list drops this tester.
    try {
      const stored = getQueueMessage(interaction.channelId);
      if (stored) {
        const queueChannel = await interaction.guild.channels.fetch(stored.channelId);
        const queueMessage = await queueChannel.messages.fetch(stored.messageId);
        await queueMessage.edit({
          embeds: [buildQueueEmbed(interaction.channelId, gamemode)],
          components: [buildQueueButtons(interaction.channelId)],
        });
      }
    } catch (err) {
      console.error("Couldn't refresh queue message after leavetesting:", err.message);
    }

    return interaction.reply({
      content: `You've stopped testing **${gamemode}**.`,
      ephemeral: true,
    });
  }

  // /backfilllogs
  if (interaction.isChatInputCommand() && interaction.commandName === "backfilllogs") {
    if (!canManageCooldowns(interaction.member)) {
      return interaction.reply({
        content: "Only testers, managers, or admins can do that.",
        ephemeral: true,
      });
    }
    if (!process.env.RESULTS_CHANNEL_ID) {
      return interaction.reply({
        content: "RESULTS_CHANNEL_ID isn't set, so there's no channel to read history from.",
        ephemeral: true,
      });
    }

    await interaction.reply({ content: "Reading results channel history, this may take a moment...", ephemeral: true });

    try {
      const resultsChannel = await interaction.guild.channels.fetch(process.env.RESULTS_CHANNEL_ID);
      let before = undefined;
      let imported = 0;
      let scanned = 0;
      const testerNameCache = new Map();

      for (let page = 0; page < 20; page++) {
        const batch = await resultsChannel.messages.fetch({ limit: 100, before });
        if (batch.size === 0) break;

        for (const message of batch.values()) {
          scanned++;
          if (message.author.id !== client.user.id) continue;
          const embed = message.embeds[0];
          if (!embed || !embed.description) continue;
          if (embed.title !== "Tier test result" && embed.title !== "Manual tier change") continue;

          const desc = embed.description;
          const nameMatch = desc.match(/^\*\*(.+?)\*\*/);
          const gamemodeMatch = desc.match(/in \*\*(.+?)\*\*:/);
          const firstLine = desc.split("\n")[0];
          const changeText = firstLine.split(": ").slice(1).join(": ");
          const tierMatch = changeText.split("\u2192");
          const tier = tierMatch.length > 1 ? tierMatch[tierMatch.length - 1].trim() : null;
          const regionMatch = desc.match(/Region: (\w+)/);
          const testerIdMatches = [...desc.matchAll(/<@(\d+)>/g)];
          const testerId = testerIdMatches.length ? testerIdMatches[testerIdMatches.length - 1][1] : null;

          if (!nameMatch || !gamemodeMatch || !tier || !testerId) continue;

          const testeeName = nameMatch[1];
          const gamemode = gamemodeMatch[1].toLowerCase();

          if (!testerNameCache.has(testerId)) {
            testerNameCache.set(testerId, await resolveDisplayName(interaction.guild, testerId));
          }
          const testerName = testerNameCache.get(testerId);

          await db.ref(`resultsLog/backfill-${message.id}`).set({
            testeeName,
            testerNames: [testerName],
            gamemode,
            tier,
            region: regionMatch ? regionMatch[1] : null,
            timestamp: message.createdTimestamp,
          });
          imported++;
        }

        before = batch.last().id;
        if (batch.size < 100) break;
      }

      return interaction.followUp({
        content: `Done. Scanned ${scanned} messages, imported ${imported} results into the log.`,
        ephemeral: true,
      });
    } catch (err) {
      console.error(err);
      return interaction.followUp({
        content: "Something went wrong reading the channel history. Check the bot console for details.",
        ephemeral: true,
      });
    }
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
    addQueueTester(highKey, interaction.user.id);
    await interaction.reply({ content: "High queue posted below.", ephemeral: true });
    const highQueueMsg = await interaction.channel.send({
      content: `${getRolePing(interaction.guild, gamemode)}High queue is open!`,
      embeds: [buildHighQueueEmbed(highKey, gamemode)],
      components: [buildHighQueueButtons(highKey)],
    });
    setQueueMessage(highKey, interaction.channelId, highQueueMsg.id);
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

    const typedUsername = interaction.options.getString("username");
    const pingedPlayer = interaction.options.getUser("player");
    const gamemode = interaction.options.getString("gamemode", true);
    const tier = interaction.options.getString("tier", true);
    const region = interaction.options.getString("region");

    if (!typedUsername && !pingedPlayer) {
      return interaction.reply({
        content: "Give either a \"username\" or a \"player\" ping.",
        ephemeral: true,
      });
    }

    let username;
    if (typedUsername) {
      username = typedUsername.trim();
    } else {
      username = await getVerifiedUsername(pingedPlayer.id);
      if (!username) {
        return interaction.reply({
          content: `<@${pingedPlayer.id}> hasn't linked a Minecraft username yet \u2014 have them run \`/verify\` first, or type the "username" option manually instead.`,
          ephemeral: true,
        });
      }
    }

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
      await clearActiveTestingAndRefresh(interaction.guild, interaction.channelId);
      setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
      return;
    }

    // Everything below only applies inside actual gamemode queue channels.
    const gamemode = GAMEMODE_CHANNELS[interaction.channel.name];
    if (!gamemode) return;

    if (interaction.customId === "queue_join") {
      if (isQueueClosed(interaction.channelId)) {
        return interaction.reply({ content: "This queue is closed right now.", ephemeral: true });
      }
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

    if (interaction.customId === "queue_toggle_close") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      const nowClosed = !isQueueClosed(interaction.channelId);
      setQueueClosed(interaction.channelId, nowClosed);
      await refreshQueueMessage(interaction, gamemode);
      if (!nowClosed) {
        // Unlocking: ping publicly since the confirmation below is ephemeral.
        await interaction.channel.send({
          content: `${getRolePing(interaction.guild, gamemode)}Queue is open again!`,
        });
      }
      return interaction.reply({
        content: nowClosed ? "Queue locked to new joins." : "Queue unlocked.",
        ephemeral: true,
      });
    }

    if (interaction.customId === "queue_delete") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      await interaction.reply({ content: "Closing this queue.", ephemeral: true });
      await interaction.message.delete().catch(() => {});
      return;
    }

    if (interaction.customId === "queue_next") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      addQueueTester(interaction.channelId, interaction.member.id);
      const nextUserId = popNext(interaction.channelId);

      if (!nextUserId) {
        await refreshQueueMessage(interaction, gamemode);
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
        setActiveTesting(interaction.channelId, {
          ticketChannelId: ticketChannel.id,
          testerIds: getQueueTesters(interaction.channelId),
          testeeId: nextUserId,
          queueChannelId: interaction.channelId,
          queueMessageId: interaction.message.id,
          gamemode,
          isHigh: false,
        });

        const testeeName = await resolveDisplayName(interaction.guild, nextUserId);
        const testerNames = await Promise.all(
          getQueueTesters(interaction.channelId).map((id) => resolveDisplayName(interaction.guild, id))
        );
        await setLiveTest(ticketChannel.id, {
          testeeName,
          testerNames,
          gamemode,
          startedAt: Date.now(),
        });

        await refreshQueueMessage(interaction, gamemode);
        return interaction.reply({
          content: `Created a private ticket for <@${nextUserId}>: ${ticketChannel}`,
          ephemeral: true,
        });
      } catch (err) {
        console.error(err);
        await refreshQueueMessage(interaction, gamemode);
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

      if (isQueueClosed(highKey)) {
        return interaction.reply({ content: "This queue is closed right now.", ephemeral: true });
      }

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

    if (interaction.customId === "highqueue_toggle_close") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      const highKey = `${interaction.channelId}:high`;
      const nowClosed = !isQueueClosed(highKey);
      setQueueClosed(highKey, nowClosed);
      await refreshHighQueueMessage(interaction, gamemode);
      if (!nowClosed) {
        await interaction.channel.send({
          content: `${getRolePing(interaction.guild, gamemode)}High queue is open again!`,
        });
      }
      return interaction.reply({
        content: nowClosed ? "High queue locked to new joins." : "High queue unlocked.",
        ephemeral: true,
      });
    }

    if (interaction.customId === "highqueue_delete") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      await interaction.reply({ content: "Closing this high queue.", ephemeral: true });
      await interaction.message.delete().catch(() => {});
      return;
    }

    if (interaction.customId === "highqueue_next") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      const highKey = `${interaction.channelId}:high`;
      addQueueTester(highKey, interaction.member.id);
      const nextUserId = popNext(highKey);

      if (!nextUserId) {
        await refreshHighQueueMessage(interaction, gamemode);
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
        setActiveTesting(highKey, {
          ticketChannelId: ticketChannel.id,
          testerIds: getQueueTesters(highKey),
          testeeId: nextUserId,
          queueChannelId: interaction.channelId,
          queueMessageId: interaction.message.id,
          gamemode,
          isHigh: true,
        });

        const highTesteeName = await resolveDisplayName(interaction.guild, nextUserId);
        const highTesterNames = await Promise.all(
          getQueueTesters(highKey).map((id) => resolveDisplayName(interaction.guild, id))
        );
        await setLiveTest(ticketChannel.id, {
          testeeName: highTesteeName,
          testerNames: highTesterNames,
          gamemode: `${gamemode} (high)`,
          startedAt: Date.now(),
        });

        await refreshHighQueueMessage(interaction, gamemode);
        return interaction.reply({
          content: `Created a private ticket for <@${nextUserId}>: ${ticketChannel}`,
          ephemeral: true,
        });
      } catch (err) {
        console.error(err);
        await refreshHighQueueMessage(interaction, gamemode);
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

      const closedInfo = await clearActiveTestingAndRefresh(interaction.guild, interaction.channelId);
      const testerNames = await Promise.all(
        (closedInfo?.testerIds || [interaction.user.id]).map((id) =>
          resolveDisplayName(interaction.guild, id)
        )
      );
      await logTestResult({
        testeeName: name,
        testerNames,
        gamemode,
        tier,
        region,
        timestamp: Date.now(),
      });
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
