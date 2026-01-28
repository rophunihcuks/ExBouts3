require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');

const fs = require('fs');
const path = require('path');

// ENV ========================================================================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const RAW_OWNER_IDS =
  process.env.OWNER_IDS ||
  process.env.OWNER_ID ||
  '';

const OWNER_IDS = RAW_OWNER_IDS.split(/[,\s]+/).filter(Boolean);
const SUMMARY_BASE_URL =
  process.env.SUMMARY_BASE_URL || 'https://your-domain.com/summary';

const DATA_FILE = path.join(__dirname, 'giveaways-data.json');

// STATE ======================================================================
/**
 * giveaways: Map<messageId, Giveaway>
 * Giveaway shape:
 * {
 *   guildId, channelId, messageId,
 *   prize, description,
 *   winnersCount,
 *   hostId, hostTag,
 *   createdAt, endAt,
 *   ended, endedAt, endedBy,
 *   entrants: string[],                 // user IDs
 *   winners: { id, tag }[],             // filled on end
 *   entrantsDetail: { id, tag }[]
 * }
 */
const giveaways = new Map();
const timeouts = new Map();

// UTILS ======================================================================

function isOwner(userId) {
  return OWNER_IDS.includes(String(userId));
}

function loadGiveawaysFromFile() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    if (!raw.trim()) return;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return;

    for (const [messageId, data] of Object.entries(obj)) {
      giveaways.set(messageId, data);
    }
    console.log(`[GA] Loaded ${giveaways.size} giveaways from file.`);
  } catch (err) {
    console.error('[GA] Failed to load giveaways-data.json:', err);
  }
}

function saveGiveawaysToFile() {
  try {
    const obj = {};
    for (const [messageId, data] of giveaways.entries()) {
      obj[messageId] = data;
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.error('[GA] Failed to save giveaways-data.json:', err);
  }
}

// parse string duration -> milliseconds
function parseDurationToMs(input) {
  if (!input) return null;
  const str = String(input).trim().toLowerCase();

  const m = str.match(/^(\d+)\s*([a-z]+)?/i);
  if (!m) return null;

  const value = parseInt(m[1], 10);
  if (!Number.isFinite(value) || value <= 0) return null;

  let unit = m[2] || 'm';

  const minuteUnits = ['m', 'min', 'mins', 'minute', 'minutes', 'menit'];
  const hourUnits = ['h', 'hr', 'hrs', 'hour', 'hours', 'jam'];
  const dayUnits = ['d', 'day', 'days', 'hari'];
  const monthUnits = ['mo', 'mos', 'month', 'months', 'bulan'];

  if (minuteUnits.includes(unit)) {
    return value * 60 * 1000;
  }
  if (hourUnits.includes(unit)) {
    return value * 60 * 60 * 1000;
  }
  if (dayUnits.includes(unit)) {
    return value * 24 * 60 * 60 * 1000;
  }
  if (monthUnits.includes(unit)) {
    // simple 30 days per month
    return value * 30 * 24 * 60 * 60 * 1000;
  }

  // jika cuma angka tanpa unit atau unit tidak dikenal -> menit
  return value * 60 * 1000;
}

// format tanggal di WIB
function formatDateTimeWIB(dateMs) {
  const date = new Date(dateMs);
  const dtf = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = dtf.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';

  const weekday = get('weekday');
  const day = get('day');
  const month = get('month');
  const year = get('year');
  const hour = get('hour');
  const minute = get('minute');

  return `${weekday}, ${day} ${month} ${year}, Jam ${hour}:${minute} WIB`;
}

function formatRelative(msDiff) {
  if (msDiff <= 0) return 'soon';

  const sec = Math.floor(msDiff / 1000);
  if (sec < 60) return `in ${sec} seconds`;

  const min = Math.floor(sec / 60);
  if (min < 60) return `in ${min} minutes`;

  const hours = Math.floor(min / 60);
  if (hours < 24) return `in ${hours} hours`;

  const days = Math.floor(hours / 24);
  return `in ${days} days`;
}

function formatUserTag(user) {
  if (!user) return '';
  // handle new username system
  if (user.discriminator === '0') return `${user.username}`;
  return `${user.username}#${user.discriminator}`;
}

// schedule auto end
function scheduleGiveaway(giveaway, client) {
  if (giveaway.ended) return;
  const now = Date.now();
  const delay = giveaway.endAt - now;
  if (delay <= 0) {
    setTimeout(() => {
      endGiveaway(giveaway.messageId, client, null).catch(console.error);
    }, 5000);
    return;
  }

  const t = setTimeout(() => {
    endGiveaway(giveaway.messageId, client, null).catch(console.error);
  }, delay);
  timeouts.set(giveaway.messageId, t);
}

// core end logic
async function endGiveaway(messageId, client, endedByUserId) {
  const ga = giveaways.get(messageId);
  if (!ga || ga.ended) return;

  ga.ended = true;
  ga.endedAt = Date.now();
  if (endedByUserId) ga.endedBy = String(endedByUserId);

  if (timeouts.has(messageId)) {
    clearTimeout(timeouts.get(messageId));
    timeouts.delete(messageId);
  }

  const channel = await client.channels.fetch(ga.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    saveGiveawaysToFile();
    return;
  }

  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) {
    saveGiveawaysToFile();
    return;
  }

  const uniqueEntrants = Array.from(new Set(ga.entrants || []));
  let winnersIds = [];

  if (uniqueEntrants.length) {
    const maxWinners = Math.min(ga.winnersCount, uniqueEntrants.length);
    const shuffled = [...uniqueEntrants];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    winnersIds = shuffled.slice(0, maxWinners);
  }

  const winnerInfos = [];
  for (const id of winnersIds) {
    const user = await client.users.fetch(id).catch(() => null);
    winnerInfos.push({
      id,
      tag: user ? formatUserTag(user) : id,
    });
  }

  const entrantInfos = [];
  for (const id of uniqueEntrants) {
    const user = await client.users.fetch(id).catch(() => null);
    entrantInfos.push({
      id,
      tag: user ? formatUserTag(user) : id,
    });
  }

  ga.winners = winnerInfos;
  ga.entrantsDetail = entrantInfos;

  const endText = `${formatRelative(ga.endedAt - ga.endAt)} (${formatDateTimeWIB(
    ga.endAt
  )})`;

  const winnersFieldValue =
    winnerInfos.length > 0
      ? winnerInfos.map((w) => `<@${w.id}>`).join(', ')
      : 'None';

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle(ga.prize)
    .setDescription(ga.description || '-')
    .addFields(
      { name: 'Ended', value: endText, inline: false },
      { name: 'Hosted by', value: `<@${ga.hostId}>`, inline: true },
      { name: 'Entries', value: String(uniqueEntrants.length), inline: true },
      { name: 'Winners', value: winnersFieldValue, inline: true }
    )
    .setTimestamp(ga.endedAt);

  await message.edit({ embeds: [embed] });

  if (winnerInfos.length > 0) {
    const mentions = winnerInfos.map((w) => `<@${w.id}>`).join(' ');
    await channel.send({
      content: `🎉 Congratulations ${mentions}! You won the **${ga.prize}**!`,
    });
  } else {
    await channel.send({
      content: 'No one joined this giveaway. There is no winner.',
    });
  }

  // summary button
  const summaryUrl = `${SUMMARY_BASE_URL}?giveaway=${ga.guildId}/${ga.messageId}`;
  const btn = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel('Giveaway Summary')
    .setURL(summaryUrl);

  const row = new ActionRowBuilder().addComponents(btn);
  await channel.send({ components: [row] });

  saveGiveawaysToFile();
}

// DISCORD CLIENT =============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once('ready', async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);

  loadGiveawaysFromFile();
  for (const [, ga] of giveaways.entries()) {
    if (!ga.ended && ga.endAt) {
      scheduleGiveaway(ga, client);
    }
  }
});

// REACTIONS ==================================================================

client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();

    const message = reaction.message;
    const ga = giveaways.get(message.id);
    if (!ga) return;

    const emojiStr = reaction.emoji.name || reaction.emoji.toString();
    if (emojiStr !== '🎉') return;

    if (!ga.entrants) ga.entrants = [];
    if (!ga.entrants.includes(user.id)) {
      ga.entrants.push(user.id);
      saveGiveawaysToFile();

      // update embed entries field
      if (message.embeds.length) {
        const base = EmbedBuilder.from(message.embeds[0]);
        const fields = base.data.fields || [];
        const newFields = fields.map((f) =>
          f.name === 'Entries'
            ? { ...f, value: String(ga.entrants.length) }
            : f
        );
        if (!fields.find((f) => f.name === 'Entries')) {
          newFields.push({
            name: 'Entries',
            value: String(ga.entrants.length),
            inline: true,
          });
        }
        const newEmbed = new EmbedBuilder(base).setFields(newFields);
        await message.edit({ embeds: [newEmbed] });
      }
    }
  } catch (err) {
    console.error('messageReactionAdd error:', err);
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();

    const message = reaction.message;
    const ga = giveaways.get(message.id);
    if (!ga) return;

    const emojiStr = reaction.emoji.name || reaction.emoji.toString();
    if (emojiStr !== '🎉') return;

    if (!ga.entrants) ga.entrants = [];
    const before = ga.entrants.length;
    ga.entrants = ga.entrants.filter((id) => id !== user.id);

    if (ga.entrants.length !== before) {
      saveGiveawaysToFile();

      if (message.embeds.length) {
        const base = EmbedBuilder.from(message.embeds[0]);
        const fields = base.data.fields || [];
        const newFields = fields.map((f) =>
          f.name === 'Entries'
            ? { ...f, value: String(ga.entrants.length) }
            : f
        );
        const newEmbed = new EmbedBuilder(base).setFields(newFields);
        await message.edit({ embeds: [newEmbed] });
      }
    }
  } catch (err) {
    console.error('messageReactionRemove error:', err);
  }
});

// SLASH COMMANDS + MODAL =====================================================

client.on('interactionCreate', async (interaction) => {
  try {
    // slash commands
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      const ensureOwner = async () => {
        if (!isOwner(interaction.user.id)) {
          await interaction.reply({
            content: 'Only bot owner can use this command.',
            flags: MessageFlags.Ephemeral,
          });
          return false;
        }
        return true;
      };

      if (commandName === 'gacreate') {
        if (!(await ensureOwner())) return;

        const modal = new ModalBuilder()
          .setCustomId('ga_create_modal')
          .setTitle('Create a Giveaway');

        const durationInput = new TextInputBuilder()
          .setCustomId('ga_duration')
          .setLabel('Duration')
          .setPlaceholder('50 minutes / 2 days / 1 bulan')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const winnersInput = new TextInputBuilder()
          .setCustomId('ga_winners')
          .setLabel('Number of winners')
          .setPlaceholder('2')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const prizeInput = new TextInputBuilder()
          .setCustomId('ga_prize')
          .setLabel('Prize')
          .setPlaceholder('50000')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const descInput = new TextInputBuilder()
          .setCustomId('ga_description')
          .setLabel('Description')
          .setPlaceholder('Giveaway 1 month paid key, only two persons')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true);

        const row1 = new ActionRowBuilder().addComponents(durationInput);
        const row2 = new ActionRowBuilder().addComponents(winnersInput);
        const row3 = new ActionRowBuilder().addComponents(prizeInput);
        const row4 = new ActionRowBuilder().addComponents(descInput);

        modal.addComponents(row1, row2, row3, row4);
        await interaction.showModal(modal);
      } else if (commandName === 'gaend') {
        if (!(await ensureOwner())) return;

        const idStr = interaction.options.getString('message_id', true).trim();

        const messageIdMatch = idStr.match(/(\d{8,})$/);
        const messageId = messageIdMatch ? messageIdMatch[1] : null;

        if (!messageId) {
          await interaction.reply({
            content: 'Invalid message id or link.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const ga = giveaways.get(messageId);
        if (!ga) {
          await interaction.reply({
            content: 'Giveaway not found for that message id.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.deferReply({ ephemeral: true });
        await endGiveaway(messageId, client, interaction.user.id);
        await interaction.editReply({
          content: `Giveaway **${ga.prize}** has been ended.`,
        });
      }

      return;
    }

    // modal submit
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'ga_create_modal') {
        const durationText = interaction.fields
          .getTextInputValue('ga_duration')
          .trim();
        const winnersText = interaction.fields
          .getTextInputValue('ga_winners')
          .trim();
        const prizeText = interaction.fields
          .getTextInputValue('ga_prize')
          .trim();
        const descText = interaction.fields
          .getTextInputValue('ga_description')
          .trim();

        const durationMs = parseDurationToMs(durationText);
        if (!durationMs || durationMs < 60 * 1000) {
          await interaction.reply({
            content:
              'Invalid duration. Use format like `50 minutes`, `2 days`, or `1 bulan` (minimum 1 minute).',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const winnersCount = parseInt(winnersText, 10);
        if (!Number.isFinite(winnersCount) || winnersCount <= 0) {
          await interaction.reply({
            content: 'Number of winners must be a positive number.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (!interaction.channel || !interaction.channel.isTextBased()) {
          await interaction.reply({
            content: 'This command can only be used in a text channel.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const now = Date.now();
        const endAt = now + durationMs;
        const relative = formatRelative(durationMs);
        const endText = `${relative} (${formatDateTimeWIB(endAt)})`;

        const embed = new EmbedBuilder()
          .setColor(0xfee75c)
          .setTitle(prizeText)
          .setDescription(descText)
          .addFields(
            { name: 'Ends', value: endText, inline: false },
            {
              name: 'Hosted by',
              value: `<@${interaction.user.id}>`,
              inline: true,
            },
            { name: 'Entries', value: '0', inline: true },
            { name: 'Winners', value: String(winnersCount), inline: true }
          )
          .setTimestamp(now);

        const msg = await interaction.channel.send({ embeds: [embed] });
        await msg.react('🎉');

        const hostTag = formatUserTag(interaction.user);

        const ga = {
          guildId: interaction.guildId,
          channelId: interaction.channel.id,
          messageId: msg.id,
          prize: prizeText,
          description: descText,
          winnersCount,
          hostId: interaction.user.id,
          hostTag,
          createdAt: now,
          endAt,
          ended: false,
          entrants: [],
          winners: [],
          entrantsDetail: [],
        };

        giveaways.set(msg.id, ga);
        saveGiveawaysToFile();
        scheduleGiveaway(ga, client);

        await interaction.reply({
          content: `Giveaway created in ${interaction.channel} with prize **${prizeText}**.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }
  } catch (err) {
    console.error('interactionCreate error:', err);
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({
          content: 'Internal error while handling this interaction.',
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (e) {}
  }
});

// SLASH COMMAND REGISTRATION =================================================

const commands = [
  new SlashCommandBuilder()
    .setName('gacreate')
    .setDescription('Starts a giveaway (interactive).'),
  new SlashCommandBuilder()
    .setName('gaend')
    .setDescription('Ends a giveaway by its message id.')
    .addStringOption((opt) =>
      opt
        .setName('message_id')
        .setDescription('Giveaway message id or link.')
        .setRequired(true)
    ),
].map((c) => c.setDMPermission(false).toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    if (!DISCORD_TOKEN || !CLIENT_ID) {
      console.error('DISCORD_TOKEN or CLIENT_ID is missing in .env.');
      return;
    }

    console.log('Registering slash commands...');
    const guildId = process.env.GUILD_ID;

    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), {
        body: commands,
      });
      console.log('Slash commands registered (guild).');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), {
        body: commands,
      });
      console.log('Slash commands registered (global).');
    }

    await client.login(DISCORD_TOKEN);
  } catch (err) {
    console.error('Failed to start bot:', err);
  }
})();
