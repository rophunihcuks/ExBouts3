// index.js
// =====================================================
//  ExHub Store / Ticket Bot (single file, Railway ready)
// =====================================================

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
  ChannelType,
  AttachmentBuilder,
  Events,
} = require('discord.js');

const crypto = require('crypto');
const os = require('os'); // untuk /runtime spesifikasi VPS

// ---------- ENV & CONFIG ---------------------------------------

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

// Waktu start bot (dipakai /runtime)
const BOT_START_TIME = Date.now();

// OWNER_IDS bisa dari OWNER_IDS atau OWNER_ID (comma / spasi dipisah)
const RAW_OWNER_IDS =
  process.env.OWNER_IDS ||
  process.env.OWNER_ID ||
  '';

const OWNER_IDS = RAW_OWNER_IDS.split(/[,\s]+/).filter(Boolean);

// kategori untuk ticket (opsional, bisa null)
const TICKET_CATEGORY_ID =
  process.env.TICKET_CATEGORY_ID ||
  process.env.CATTEGORY_TICKETCHANNEL_ID ||
  null;

// channel log order (opsional)
const CHANNEL_LOGORDER_ID = process.env.CHANNEL_LOGORDER_ID || null;

// welcome channel (bisa juga diubah via /setwelcomechannel)
let welcomeChannelId = process.env.WELCOME_CHANNEL_ID || null;

// URL dasar validasi key (default ke API kamu)
const PAIDKEY_VALIDATE_BASE =
  process.env.PAIDKEY_VALIDATE_BASE ||
  'https://exc-webs.vercel.app/api/paidkey/isValidate';

// endpoint untuk create/simpan key di API
const PAIDKEY_CREATE_URL =
  process.env.PAIDKEY_CREATE_URL ||
  'https://exc-webs.vercel.app/api/paidkey/createOrUpdate';

// endpoint untuk ambil semua key milik user (dipakai /mykey) – versi PAID+FREE
const EXHUB_USERINFO_URL =
  process.env.EXHUB_USERINFO_URL ||
  'https://exc-webs.vercel.app/api/paidfree/user-info';

// background untuk welcome (gambar 700x250 yang kamu host di mana saja)
const WELCOME_BG_URL = process.env.WELCOME_BG_URL || null;

// QRIS image URL (gambar PNG/JPG QRIS kamu)
const QRIS_IMAGE_URL = process.env.QRIS_IMAGE_URL || null;

// ---------- SERVER STATS CONFIG --------------------------------
// Kategori + 4 channel untuk panel "📊 SERVER STATS 📊"
const SERVER_STATS_CATEGORY_ID = process.env.SERVER_STATS_CATEGORY_ID || null;
const SERVER_STATS_ALL_ID = process.env.SERVER_STATS_ALL_ID || null;
const SERVER_STATS_MEMBERS_ID = process.env.SERVER_STATS_MEMBERS_ID || null;
const SERVER_STATS_BOTS_ID = process.env.SERVER_STATS_BOTS_ID || null;
const SERVER_STATS_BOOSTS_ID = process.env.SERVER_STATS_BOOSTS_ID || null;

// harga default (bisa diubah pakai slash command)
let priceKeyMonth = Number(process.env.PRICE_KEY_MONTH || 15000);
let priceKeyLifetime = Number(process.env.PRICE_KEY_LIFETIME || 25000);
let priceIndoHangout = Number(process.env.PRICE_INDO_HANGOUT || 10000);

// ticketOwners: channelId -> userId
const ticketOwners = new Map();

// reactionRoles: messageId -> [ { emoji, roleId } ]
const reactionRoles = new Map();

// ---------- HELPER UTILS ---------------------------------------

// sekarang support banyak OWNER_ID
function isOwner(userId) {
  return OWNER_IDS.includes(String(userId));
}

function formatRupiah(num) {
  if (!num && num !== 0) return '-';
  return num.toLocaleString('id-ID');
}

function generatePaidKey() {
  const segment = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `EXHUBPAID-${segment}`;
}

// Format detik -> HH:MM:SS (untuk /runtime)
function formatSecondsToHMS(sec) {
  const s = sec % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// Normalisasi tipe key yang tersimpan di API
function normalizeKeyType(raw) {
  if (!raw) return '';
  const t = String(raw).trim().toLowerCase();

  if (['month', 'monthly', 'sebulan', '1bulan', '30d', '30days'].includes(t)) {
    return 'month';
  }

  if (['lifetime', 'life', 'selamanya', 'permanent', 'permanentkey'].includes(t)) {
    return 'lifetime';
  }

  // kalau tipe lain / custom, kembalikan apa adanya (lowercase)
  return t;
}

function getTicketOwnerId(channel) {
  if (!channel) return null;

  if (ticketOwners.has(channel.id)) {
    return ticketOwners.get(channel.id);
  }

  const topic = channel.topic || '';
  const match = topic.match(/OwnerID:(\d{5,})/);
  return match ? match[1] : null;
}

// Tentukan pemilik key (Discord ID) untuk generate key
function resolveKeyOwnerDiscordId(interaction, targetUser) {
  if (targetUser) {
    return String(targetUser.id);
  }

  const ch = interaction.channel;
  if (ch && ch.type === ChannelType.GuildText) {
    const ticketOwnerId = getTicketOwnerId(ch);
    if (ticketOwnerId) return String(ticketOwnerId);
  }

  return String(interaction.user.id);
}

// Call API untuk cek key
async function validatePaidKey(key) {
  const base = PAIDKEY_VALIDATE_BASE.replace(/\/$/, '');
  const url = `${base}/${encodeURIComponent(key)}`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Validate key HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Call API untuk create/update key di server ExHub
 */
async function createPaidKeyOnAPI(key, type, expiresDurationMs, override = {}) {
  if (!PAIDKEY_CREATE_URL) {
    console.warn(
      '[WARN] PAIDKEY_CREATE_URL belum diisi, key tidak dikirim ke API.'
    );
    return;
  }

  const now = Date.now();
  const createdAt = override.createdAt ?? now;

  const normalizedType = normalizeKeyType(type || '') || (type || null);

  let expiresAfter = override.expiresAfter;
  if (!expiresAfter) {
    if (expiresDurationMs && expiresDurationMs > 0) {
      expiresAfter = createdAt + expiresDurationMs;
    } else {
      expiresAfter = createdAt;
    }
  }

  const info = {
    token: key,
    createdAt,
    byIp: override.byIp || 'discord-bot',
    expiresAfter,
    type: normalizedType,
  };

  // Bind pemilik key (Discord ID) jika ada
  if (override.ownerDiscordId) {
    info.ownerDiscordId = String(override.ownerDiscordId);
  }

  const payload = {
    valid: override.valid ?? false,
    deleted: override.deleted ?? false,
    expired: false,
    info,
  };

  const res = await fetch(PAIDKEY_CREATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Create/Update key API error ${res.status}: ${text.slice(0, 200)}`
    );
  }
}

// helper konversi ke ms (aman untuk number/string/null)
function toMs(value) {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

// Ambil semua PAID key milik user dari API /api/paidfree/user-info (dipakai /mykey)
async function fetchUserPaidKeys(discordUser) {
  if (!EXHUB_USERINFO_URL) {
    throw new Error('EXHUB_USERINFO_URL belum dikonfigurasi.');
  }

  try {
    const res = await fetch(EXHUB_USERINFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        discordId: discordUser.id,
        discordTag: discordUser.username,
      }),
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.log(
        '[DEBUG /mykey] Gagal parse JSON dari user-info:',
        e,
        text.slice(0, 200)
      );
      return [];
    }

    if (!data || !Array.isArray(data.keys)) {
      console.log(
        '[DEBUG /mykey] Tidak menemukan array key di response user-info. URL =',
        EXHUB_USERINFO_URL
      );
      return [];
    }

    const now = Date.now();
    const rawKeys = data.keys;

    // Deduplicate berdasarkan token
    const byToken = new Map();
    for (const k of rawKeys) {
      if (!k || typeof k !== 'object') continue;

      let token =
        k.token ||
        k.key ||
        k.keyToken ||
        (k.info && (k.info.token || k.info.key)) ||
        null;

      if (!token) continue;
      token = String(token);

      if (!byToken.has(token)) {
        byToken.set(token, k);
      }
    }

    const uniqKeys = Array.from(byToken.values());
    const paidKeys = [];

    for (const k of uniqKeys) {
      if (!k) continue;

      const providerRaw = String(k.provider || k.source || '').toLowerCase();
      const tierRaw =
        k.tier ||
        k.type ||
        (k.info && (k.info.tier || k.info.type)) ||
        '';
      const typeNorm = normalizeKeyType(tierRaw);

      // filter free key
      const isFree =
        typeNorm === 'free' ||
        providerRaw === 'work.ink' ||
        providerRaw === 'workink' ||
        providerRaw.includes('linkvertise') ||
        k.free === true;

      if (isFree) continue;

      let token =
        k.token ||
        k.key ||
        k.keyToken ||
        (k.info && (k.info.token || k.info.key)) ||
        null;

      if (!token) continue;
      token = String(token);

      const ownerDiscordId =
        k.ownerDiscordId ||
        (k.info && k.info.ownerDiscordId) ||
        null;

      // Kalau backend sudah filter per-discordId, ini boleh kosong.
      // Kalau ada dan beda user, skip.
      if (
        ownerDiscordId &&
        String(ownerDiscordId) !== String(discordUser.id)
      ) {
        continue;
      }

      const createdAtMs =
        toMs(k.createdAt) ||
        (k.info ? toMs(k.info.createdAt) : null);

      const expiresAfterMs =
        toMs(k.expiresAfter) ||
        toMs(k.expiresAtMs) ||
        toMs(k.expiresAt) ||
        (k.info ? toMs(k.info.expiresAfter) : null);

      const deleted = !!(k.deleted || (k.info && k.info.deleted));
      const valid =
        typeof k.valid === 'boolean'
          ? k.valid
          : k.info && typeof k.info.valid === 'boolean'
          ? k.info.valid
          : true;

      const expired =
        expiresAfterMs && typeof expiresAfterMs === 'number'
          ? now > expiresAfterMs
          : !!k.expired;

      let status;
      if (deleted) status = 'Deleted';
      else if (expired) status = 'Expired';
      else if (!valid) status = 'Not Redeemed';
      else status = 'Active';

      paidKeys.push({
        token,
        type: typeNorm || 'paid',
        createdAtMs,
        expiresAfterMs,
        status,
      });
    }

    paidKeys.sort((a, b) => {
      const ca = a.createdAtMs || 0;
      const cb = b.createdAtMs || 0;
      return ca - cb;
    });

    console.log(
      `[DEBUG /mykey] Discord ${discordUser.id} - total paidKeys = ${paidKeys.length}`
    );

    return paidKeys;
  } catch (err) {
    console.log('[DEBUG /mykey] Error call user-info:', err);
    return [];
  }
}

// lookup username Roblox -> { id, name, displayName }
async function lookupRobloxUser(username) {
  const res = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      usernames: [username],
      excludeBannedUsers: true,
    }),
  });

  if (!res.ok) {
    throw new Error(`Roblox API error ${res.status}`);
  }

  const json = await res.json();
  if (!json || !Array.isArray(json.data) || json.data.length === 0) {
    return null;
  }

  const u = json.data[0];
  return {
    id: u.id,
    name: u.name,
    displayName: u.displayName,
  };
}

function robloxAvatarUrl(userId) {
  return `https://www.roblox.com/headshot-thumbnail/image?userId=${userId}&width=150&height=150&format=png`;
}

async function logOrder(guild, embed) {
  if (!CHANNEL_LOGORDER_ID) return;
  try {
    const ch = guild.channels.cache.get(CHANNEL_LOGORDER_ID);
    if (!ch) return;
    await ch.send({ embeds: [embed] });
  } catch (err) {
    console.error('Failed to send log order:', err);
  }
}

// ---------- REACTION ROLE PARSER --------------------------------

function resolveRoleFromText(guild, text) {
  if (!guild || !text) return null;
  const raw = text.trim();

  // Mention <@&id>
  const m = raw.match(/<@&(\d+)>/);
  if (m) {
    const role = guild.roles.cache.get(m[1]);
    if (role) return role;
  }

  // Pure ID
  if (/^\d{17,20}$/.test(raw)) {
    const role = guild.roles.cache.get(raw);
    if (role) return role;
  }

  // By name (case-insensitive)
  const lower = raw.toLowerCase();
  const roleByName = guild.roles.cache.find(
    (r) => r.name.toLowerCase() === lower
  );
  if (roleByName) return roleByName;

  return null;
}

/**
 * Parse config multi-line:
 *  "✅ ; @Member"
 *  "🎮 @Gamer"
 *  "⭐ | VIP"
 * return { pairs: [{emoji, role}], errors: [string] }
 */
function parseReactionRoleConfig(guild, raw) {
  const pairs = [];
  const errors = [];
  if (!raw) return { pairs, errors };

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  let lineNo = 0;
  for (const line of lines) {
    lineNo += 1;

    // Pisahkan emoji & role
    let emojiPart;
    let rolePart;

    const sepMatch = line.match(/^(\S+)\s*(?:[,;|]\s*|\s+)(.+)$/);
    if (sepMatch) {
      emojiPart = sepMatch[1];
      rolePart = sepMatch[2];
    } else {
      errors.push(`Baris ${lineNo}: format tidak dikenali ("${line}"). Gunakan "emoji ; role".`);
      continue;
    }

    const role = resolveRoleFromText(guild, rolePart);
    if (!role) {
      errors.push(`Baris ${lineNo}: role "${rolePart}" tidak ditemukan di server.`);
      continue;
    }

    pairs.push({ emoji: emojiPart, role });
  }

  return { pairs, errors };
}

/**
 * Parse channels string: "#chan1 #chan2" atau "id1, id2"
 * return array of Text/Announcement channels
 */
function parseReactionTargetChannels(guild, raw, fallbackChannel) {
  const results = [];
  const idSet = new Set();

  if (raw) {
    let m;
    const mentionRegex = /<#(\d+)>/g;
    while ((m = mentionRegex.exec(raw)) !== null) {
      idSet.add(m[1]);
    }

    const tokens = raw.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
    for (const t of tokens) {
      if (/^\d{17,20}$/.test(t)) {
        idSet.add(t);
      }
    }
  }

  for (const id of idSet) {
    const ch = guild.channels.cache.get(id);
    if (!ch) continue;
    if (
      ch.type === ChannelType.GuildText ||
      ch.type === ChannelType.GuildAnnouncement
    ) {
      results.push(ch);
    }
  }

  if (
    !results.length &&
    fallbackChannel &&
    fallbackChannel.guild &&
    fallbackChannel.guild.id === guild.id &&
    (fallbackChannel.type === ChannelType.GuildText ||
      fallbackChannel.type === ChannelType.GuildAnnouncement)
  ) {
    results.push(fallbackChannel);
  }

  return results;
}

// ---------- SERVER STATS HELPER --------------------------------

async function updateServerStats(guild) {
  try {
    if (!guild) return;

    if (
      !SERVER_STATS_ALL_ID &&
      !SERVER_STATS_MEMBERS_ID &&
      !SERVER_STATS_BOTS_ID &&
      !SERVER_STATS_BOOSTS_ID
    ) {
      return;
    }

    try {
      await guild.members.fetch();
    } catch (err) {
      console.warn(
        '[SERVER STATS] guild.members.fetch() error (boleh diabaikan kalau tidak punya Server Members Intent):',
        err.message
      );
    }

    const totalMembers =
      typeof guild.memberCount === 'number'
        ? guild.memberCount
        : guild.members.cache.size;

    const bots = guild.members.cache.filter((m) => m.user.bot).size;
    const humans = totalMembers - bots;
    const boosts = guild.premiumSubscriptionCount ?? 0;

    const targets = [
      {
        id: SERVER_STATS_ALL_ID,
        name: `🔒 🌍 • All Members: ${totalMembers}`,
      },
      {
        id: SERVER_STATS_MEMBERS_ID,
        name: `🔒 📈 • Members: ${humans}`,
      },
      {
        id: SERVER_STATS_BOTS_ID,
        name: `🔒 🤖 • Bots: ${bots}`,
      },
      {
        id: SERVER_STATS_BOOSTS_ID,
        name: `🔒 🚀 • Boosts: ${boosts}`,
      },
    ];

    for (const t of targets) {
      if (!t.id) continue;
      const ch = guild.channels.cache.get(t.id);
      if (!ch) {
        console.warn(
          `[SERVER STATS] Channel dengan ID ${t.id} tidak ditemukan di guild ${guild.id}.`
        );
        continue;
      }
      if (ch.name !== t.name) {
        await ch.setName(t.name).catch((err) => {
          console.error(
            `[SERVER STATS] Gagal update nama channel ${t.id} di guild ${guild.id}`,
            err
          );
        });
      }
    }

    if (SERVER_STATS_CATEGORY_ID) {
      const category = guild.channels.cache.get(SERVER_STATS_CATEGORY_ID);
      if (category && category.type === ChannelType.GuildCategory) {
        for (const t of targets) {
          if (!t.id) continue;
          const ch = guild.channels.cache.get(t.id);
          if (!ch) continue;
          if (ch.parentId !== category.id) {
            await ch.setParent(category.id).catch(() => {});
          }
        }
      }
    }
  } catch (err) {
    console.error('[SERVER STATS] updateServerStats error:', err);
  }
}

// ---------- DISCORD CLIENT -------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.Reaction,
    Partials.User,
    Partials.GuildMember,
  ],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);

  for (const [, guild] of c.guilds.cache) {
    await updateServerStats(guild);
  }
});

// Welcome message + refresh stats
client.on('guildMemberAdd', async (member) => {
  try {
    const channelId = welcomeChannelId;
    if (channelId) {
      const ch = member.guild.channels.cache.get(channelId);
      if (ch) {
        const emb = new EmbedBuilder()
          .setTitle('👋 Selamat Datang!')
          .setDescription(
            `Halo ${member}, selamat datang di **${member.guild.name}**!\n\n` +
              'Pastikan baca rules & pilih role yang sesuai sebelum mulai chat.'
          )
          .setThumbnail(
            member.user.displayAvatarURL({ extension: 'png', size: 256 })
          )
          .setColor(0x5865f2);

        if (WELCOME_BG_URL) emb.setImage(WELCOME_BG_URL);

        await ch.send({ content: `<@${member.id}>`, embeds: [emb] });
      }
    }

    await updateServerStats(member.guild);
  } catch (err) {
    console.error('Error on guildMemberAdd:', err);
  }
});

client.on('guildMemberRemove', async (member) => {
  try {
    await updateServerStats(member.guild);
  } catch (err) {
    console.error('Error on guildMemberRemove:', err);
  }
});

client.on('guildUpdate', async (oldGuild, newGuild) => {
  try {
    await updateServerStats(newGuild);
  } catch (err) {
    console.error('Error on guildUpdate:', err);
  }
});

// Reaction role multi
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();

    const conf = reactionRoles.get(reaction.message.id);
    if (!conf || !Array.isArray(conf) || !conf.length) return;

    const emojiStr = reaction.emoji.toString();
    const pair = conf.find((p) => p.emoji === emojiStr);
    if (!pair) return;

    const guild = reaction.message.guild;
    if (!guild) return;
    const member = await guild.members.fetch(user.id);
    await member.roles.add(pair.roleId).catch(() => {});
  } catch (err) {
    console.error('messageReactionAdd error:', err);
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();

    const conf = reactionRoles.get(reaction.message.id);
    if (!conf || !Array.isArray(conf) || !conf.length) return;

    const emojiStr = reaction.emoji.toString();
    const pair = conf.find((p) => p.emoji === emojiStr);
    if (!pair) return;

    const guild = reaction.message.guild;
    if (!guild) return;
    const member = await guild.members.fetch(user.id);
    await member.roles.remove(pair.roleId).catch(() => {});
  } catch (err) {
    console.error('messageReactionRemove error:', err);
  }
});

// ---------- PANEL & TICKET HELPERS -----------------------------

async function sendStorePanel(channel) {
  const embed = new EmbedBuilder()
    .setTitle('🎮 EXHUB STORE - Premium Scripts')
    .setDescription(
      'Halo! Selamat datang di **EXHUB STORE** 👋\n\n' +
        'Kamu lagi cari script Roblox premium? Kamu datang ke tempat yang tepat!\n\n' +
        '✨ Script oke\n' +
        '💰 Harga bersahabat di kantong\n' +
        '⚡ Respon cepat dari admin\n\n' +
        'Klik tombol **📩 Buat Ticket** di bawah untuk mulai order ya!\n' +
        'Kami siap bantu kamu 24/7 🙂'
    )
    .setColor(0x2b2d31);

  const btn = new ButtonBuilder()
    .setCustomId('store_create_ticket')
    .setEmoji('📩')
    .setLabel('Buat Ticket')
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder().addComponents(btn);

  await channel.send({ embeds: [embed], components: [row] });
}

async function sendTicketIntroMessage(channel, user) {
  const desc = [
    `Halo ${user}, terima kasih telah membuat ticket order VIP.`,
    '',
    '**Paket Tersedia**',
    `⚡ Key Sebulan – Rp ${formatRupiah(
      priceKeyMonth
    )} (Akses 5 Script • 30 hari)`,
    `🔥 Key Lifetime – Rp ${formatRupiah(
      priceKeyLifetime
    )} (Akses 5 Script • 1 tahun)`,
    `🇮🇩 Indo Hangout Premium – Rp ${formatRupiah(
      priceIndoHangout
    )} (1 Username • Permanent)`,
    '',
    '**Langkah Selanjutnya**',
    '1. Pilih paket dari dropdown menu di bawah.',
    '2. Ikuti instruksi yang muncul.',
    '3. Upload bukti bayar (screenshot QRIS) di channel ini.',
    '4. Tunggu admin konfirmasi ✅',
    '',
    '⚠️ Jika button tidak muncul, kirim pesan apa saja di channel ini untuk refresh.',
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle('✨ Ticket VIP Order')
    .setDescription(desc)
    .setColor(0xfee75c);

  const select = new StringSelectMenuBuilder()
    .setCustomId('ticket_select_package')
    .setPlaceholder('📦 Pilih paket yang Anda inginkan...')
    .addOptions(
      {
        label: 'Key Sebulan',
        description: `Rp ${formatRupiah(
          priceKeyMonth
        )} • 5 Script Premium (30 hari)`,
        value: 'KEY_MONTH',
        emoji: '⚡',
      },
      {
        label: 'Key Lifetime',
        description: `Rp ${formatRupiah(
          priceKeyLifetime
        )} • 5 Script Premium (1 tahun)`,
        value: 'KEY_LIFE',
        emoji: '🔥',
      },
      {
        label: 'Indo Hangout Premium',
        description: `Rp ${formatRupiah(
          priceIndoHangout
        )} • 1 Username (Permanent)`,
        value: 'INDO_VIP',
        emoji: '🇮🇩',
      }
    );

  const rowSelect = new ActionRowBuilder().addComponents(select);

  const btnCancel = new ButtonBuilder()
    .setCustomId('ticket_cancel')
    .setLabel('Cancel Order')
    .setEmoji('❌')
    .setStyle(ButtonStyle.Secondary);

  const btnClose = new ButtonBuilder()
    .setCustomId('ticket_close')
    .setLabel('Close Ticket')
    .setEmoji('🔒')
    .setStyle(ButtonStyle.Danger);

  const rowButtons = new ActionRowBuilder().addComponents(btnCancel, btnClose);

  await channel.send({
    content: `<@${user.id}>`,
    embeds: [embed],
    components: [rowSelect, rowButtons],
  });
}

// ---------- INTERACTION HANDLER --------------------------------

client.on('interactionCreate', async (interaction) => {
  try {
    // ===================== SLASH COMMAND =======================
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      const ensureOwner = async () => {
        if (!isOwner(interaction.user.id)) {
          await interaction.reply({
            content: 'Perintah ini hanya bisa digunakan oleh OWNER bot.',
            ephemeral: true,
          });
          return false;
        }
        return true;
      };

      // /sendticketpanel
      if (commandName === 'sendticketpanel') {
        if (!(await ensureOwner())) return;
        await sendStorePanel(interaction.channel);
        await interaction.reply({
          content: 'Panel ticket store sudah dikirim di channel ini.',
          ephemeral: true,
        });
      }

      // /setharga_sebulan
      else if (commandName === 'setharga_sebulan') {
        if (!(await ensureOwner())) return;
        const harga = interaction.options.getInteger('harga', true);
        priceKeyMonth = harga;
        await interaction.reply({
          content: `Harga **Key Sebulan** di-set ke Rp ${formatRupiah(harga)}.`,
          ephemeral: true,
        });
      }

      // /setharga_lifetime
      else if (commandName === 'setharga_lifetime') {
        if (!(await ensureOwner())) return;
        const harga = interaction.options.getInteger('harga', true);
        priceKeyLifetime = harga;
        await interaction.reply({
          content: `Harga **Key Lifetime** di-set ke Rp ${formatRupiah(
            harga
          )}.`,
          ephemeral: true,
        });
      }

      // /setharga_indohangout
      else if (commandName === 'setharga_indohangout') {
        if (!(await ensureOwner())) return;
        const harga = interaction.options.getInteger('harga', true);
        priceIndoHangout = harga;
        await interaction.reply({
          content: `Harga **Indo Hangout Premium** di-set ke Rp ${formatRupiah(
            harga
          )}.`,
          ephemeral: true,
        });
      }

      // /generatekeysebulan
      else if (commandName === 'generatekeysebulan') {
        if (!(await ensureOwner())) return;
        const target = interaction.options.getUser('member', false);
        const key = generatePaidKey();
        const days = 30;
        const ms = days * 24 * 60 * 60 * 1000;

        const ownerDiscordId = resolveKeyOwnerDiscordId(interaction, target);

        const channelMention =
          interaction.channel &&
          interaction.channel.type === ChannelType.GuildText
            ? `<#${interaction.channel.id}>`
            : 'channel ticket kamu di server';

        try {
          await createPaidKeyOnAPI(key, 'month', ms, {
            valid: false,
            byIp: 'discord-bot-generate-month',
            ownerDiscordId,
          });
        } catch (err) {
          console.error('createPaidKeyOnAPI (month) error:', err);
        }

        const expiresTs = Math.floor((Date.now() + ms) / 1000);
        const msg =
          `🎟️ Key Sebulan:\n\`${key}\`\n` +
          `Expired: <t:${expiresTs}:R> • <t:${expiresTs}:f>\n` +
          `Silakan redeem key ini menggunakan perintah \`/redeemkeysebulan\` di ${channelMention}.`;

        if (target) {
          await target
            .send({ content: msg })
            .catch(() => console.warn('Failed to DM user key.'));
          await interaction.reply({
            content: `Key sebulan dikirim ke DM ${target}.`,
            ephemeral: true,
          });

          if (
            interaction.channel &&
            interaction.channel.type === ChannelType.GuildText
          ) {
            await interaction.channel.send({
              content: `✅ Silakan cek DM ${target}, key sudah saya kirim. Balik ke ${channelMention} untuk redeem dengan \`/redeemkeysebulan\`.`,
            });
          }
        } else {
          await interaction.reply({ content: msg, ephemeral: true });
        }
      }

      // /generatekeylifetime
      else if (commandName === 'generatekeylifetime') {
        if (!(await ensureOwner())) return;
        const target = interaction.options.getUser('member', false);
        const key = generatePaidKey();
        const days = 365;
        const ms = days * 24 * 60 * 60 * 1000;

        const ownerDiscordId = resolveKeyOwnerDiscordId(interaction, target);

        const channelMention =
          interaction.channel &&
          interaction.channel.type === ChannelType.GuildText
            ? `<#${interaction.channel.id}>`
            : 'channel ticket kamu di server';

        try {
          await createPaidKeyOnAPI(key, 'lifetime', ms, {
            valid: false,
            byIp: 'discord-bot-generate-lifetime',
            ownerDiscordId,
          });
        } catch (err) {
          console.error('createPaidKeyOnAPI (lifetime) error:', err);
        }

        const expiresTs = Math.floor((Date.now() + ms) / 1000);
        const msg =
          `🎟️ Key Lifetime:\n\`${key}\`\n` +
          `Expired: <t:${expiresTs}:R> • <t:${expiresTs}:f>\n` +
          `Silakan redeem key ini menggunakan perintah \`/redeemkeylifetime\` di ${channelMention}.`;

        if (target) {
          await target
            .send({ content: msg })
            .catch(() => console.warn('Failed to DM user key.'));
          await interaction.reply({
            content: `Key lifetime dikirim ke DM ${target}.`,
            ephemeral: true,
          });

          if (
            interaction.channel &&
            interaction.channel.type === ChannelType.GuildText
          ) {
            await interaction.channel.send({
              content: `✅ Silakan cek DM ${target}, key sudah saya kirim. Balik ke ${channelMention} untuk redeem dengan \`/redeemkeylifetime\`.`,
            });
          }
        } else {
          await interaction.reply({ content: msg, ephemeral: true });
        }
      }

      // /redeemkeysebulan
      else if (commandName === 'redeemkeysebulan') {
        const modal = new ModalBuilder()
          .setCustomId('modal_redeem_key_month')
          .setTitle('Redeem Key Sebulan');

        const input = new TextInputBuilder()
          .setCustomId('field_key_month')
          .setLabel('Masukkan Key Sebulan')
          .setPlaceholder('EXHUBPAID-XXXX')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
      }

      // /redeemkeylifetime
      else if (commandName === 'redeemkeylifetime') {
        const modal = new ModalBuilder()
          .setCustomId('modal_redeem_key_life')
          .setTitle('Redeem Key Lifetime');

        const input = new TextInputBuilder()
          .setCustomId('field_key_life')
          .setLabel('Masukkan Key Lifetime')
          .setPlaceholder('EXHUBPAID-XXXX')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
      }

      // /setwelcomechannel
      else if (commandName === 'setwelcomechannel') {
        if (!(await ensureOwner())) return;
        const ch = interaction.options.getChannel('channel', true);
        welcomeChannelId = ch.id;
        await interaction.reply({
          content: `Welcome channel di-set ke ${ch}.`,
          ephemeral: true,
        });
      }

      // /refreshserverstats
      else if (commandName === 'refreshserverstats') {
        if (!(await ensureOwner())) return;
        if (!interaction.guild) {
          await interaction.reply({
            content: 'Perintah ini hanya bisa digunakan di dalam server.',
            ephemeral: true,
          });
          return;
        }

        await interaction.deferReply({ ephemeral: true });
        await updateServerStats(interaction.guild);
        await interaction.editReply({
          content:
            'SERVER STATS berhasil di-refresh. Jika nama channel belum berubah, cek kembali ID channel di `.env`.',
        });
      }

      // /sendreactionrole (multi-role, multi-emoji, multi-channel)
      else if (commandName === 'sendreactionrole') {
        if (!(await ensureOwner())) return;

        if (!interaction.guild) {
          await interaction.reply({
            content: 'Perintah ini hanya bisa digunakan di dalam server.',
            ephemeral: true,
          });
          return;
        }

        const title = interaction.options.getString('title', true);
        const configRaw = interaction.options.getString('config', true);
        const channelsRaw = interaction.options.getString('channels', false) || '';

        const guild = interaction.guild;

        const { pairs, errors } = parseReactionRoleConfig(guild, configRaw);

        if (!pairs.length) {
          await interaction.reply({
            content:
              'Config reaction-role kosong / tidak valid. Pastikan format satu baris: `emoji ; @Role`.',
            ephemeral: true,
          });
          return;
        }

        const targetChannels = parseReactionTargetChannels(
          guild,
          channelsRaw,
          interaction.channel
        );

        if (!targetChannels.length) {
          await interaction.reply({
            content:
              'Tidak ada channel teks valid yang ditemukan. Pastikan menyebut channel dengan mention atau ID.',
            ephemeral: true,
          });
          return;
        }

        await interaction.deferReply({ ephemeral: true });

        const results = [];

        for (const ch of targetChannels) {
          try {
            const listText = pairs
              .map((p) => `${p.emoji} → ${p.role}`)
              .join('\n');

            const embed = new EmbedBuilder()
              .setTitle(title)
              .setDescription(
                'React dengan emoji berikut untuk mendapatkan / melepas role:\n\n' +
                  listText
              )
              .setColor(0x5865f2);

            const msg = await ch.send({ embeds: [embed] });

            for (const p of pairs) {
              try {
                await msg.react(p.emoji);
              } catch (errReact) {
                console.error(
                  `Gagal react ${p.emoji} di channel ${ch.id}:`,
                  errReact
                );
              }
            }

            const storedPairs = pairs.map((p) => ({
              emoji: p.emoji,
              roleId: p.role.id,
            }));
            reactionRoles.set(msg.id, storedPairs);

            results.push(`✅ Berhasil kirim reaction-role di ${ch}`);
          } catch (errCh) {
            console.error('Gagal kirim reaction-role di channel:', ch.id, errCh);
            results.push(
              `❌ Gagal kirim reaction-role di ${ch} (${errCh.message || 'unknown error'})`
            );
          }
        }

        let msgResult = results.join('\n');
        if (errors.length) {
          msgResult +=
            '\n\n⚠️ Beberapa baris config di-skip karena error:\n- ' +
            errors.join('\n- ');
        }

        await interaction.editReply({
          content: msgResult,
        });
      }

      // /runtime
      else if (commandName === 'runtime') {
        const uptimeSec = Math.floor(process.uptime());
        const startTimestampSec = Math.floor(BOT_START_TIME / 1000);
        const nowSec = Math.floor(Date.now() / 1000);

        const mem = process.memoryUsage();
        const toMB = (bytes) => (bytes / 1024 / 1024).toFixed(2);
        const toGB = (bytes) => (bytes / 1024 / 1024 / 1024).toFixed(2);

        const guildCount = client.guilds.cache.size;

        // Info OS / CPU / RAM dari VPS
        const osType = os.type();
        const osRelease = os.release();
        const osPlatform = os.platform();
        const osArch = os.arch();

        const cpus = os.cpus() || [];
        const coreCount = cpus.length;
        const cpuModel = coreCount ? cpus[0].model : 'Unknown';
        const cpuSpeed = coreCount ? cpus[0].speed : 0;

        const totalMemBytes = os.totalmem();
        const freeMemBytes = os.freemem();

        const cpuLines = coreCount
          ? `• CPU           : \`${cpuModel}\`\n` +
            `• CPU Cores     : \`${coreCount} cores @ ${cpuSpeed} MHz\`\n`
          : '• CPU           : `Unknown`\n';

        const msg =
          `⏱️ **Runtime Bot**\n` +
          `• Uptime        : \`${formatSecondsToHMS(
            uptimeSec
          )}\` (sejak <t:${nowSec - uptimeSec}:R>)\n` +
          `• Start Time    : <t:${startTimestampSec}:F>\n` +
          `• Guilds        : \`${guildCount}\`\n` +
          `• Node.js       : \`${process.version}\`\n` +
          `• Memory (RSS)  : \`${toMB(mem.rss)} MB\`\n` +
          `• Heap Used     : \`${toMB(mem.heapUsed)} MB\`` +
          `\n\n🖥️ **Spesifikasi Core VPS**\n` +
          `• OS            : \`${osType} ${osRelease} (${osPlatform}/${osArch})\`\n` +
          cpuLines +
          `• RAM (Total)   : \`${toGB(totalMemBytes)} GB\`\n` +
          `• RAM (Free)    : \`${toGB(freeMemBytes)} GB\``;

        await interaction.reply({ content: msg, ephemeral: true });
      }

      // /mykey dan /checkmykey
      else if (commandName === 'mykey' || commandName === 'checkmykey') {
        await interaction.deferReply({ ephemeral: true });

        try {
          const keys = await fetchUserPaidKeys(interaction.user);

          if (!keys || keys.length === 0) {
            await interaction.editReply({
              content:
                'Saat ini tidak ada paid key yang tercatat atas akun Discord kamu. Jika merasa sudah pernah order, hubungi admin dengan menyertakan bukti pembayaran.',
            });
            return;
          }

          const embed = new EmbedBuilder()
            .setTitle('🔑 Key Information — Akun Kamu')
            .setDescription(
              'Berikut seluruh **paid key** yang terikat ke akun Discord kamu berdasarkan data di API ExHub.'
            )
            .setColor(0x5865f2);

          const maxShow = 10;
          const slice = keys.slice(0, maxShow);

          slice.forEach((k, idx) => {
            const createdTs = k.createdAtMs
              ? Math.floor(k.createdAtMs / 1000)
              : null;
            const expireTs = k.expiresAfterMs
              ? Math.floor(k.expiresAfterMs / 1000)
              : null;

            let paidLabel;
            if (k.type === 'month') paidLabel = 'Month (Sebulan)';
            else if (k.type === 'lifetime') paidLabel = 'Lifetime';
            else if (k.type) paidLabel = k.type;
            else paidLabel = 'Paid';

            const lines = [];
            lines.push(`**Your Key:** \`${k.token}\``);

            if (createdTs) {
              lines.push(
                `**Order Key:** <t:${createdTs}:f> • <t:${createdTs}:R>`
              );
            } else {
              lines.push('**Order Key:** -');
            }

            if (expireTs) {
              lines.push(
                `**Expired Date:** <t:${expireTs}:f> • <t:${expireTs}:R>`
              );
            } else {
              lines.push('**Expired Date:** -');
            }

            lines.push(`**Paid Plan:** ${paidLabel}`);
            lines.push(`**Status:** ${k.status}`);

            embed.addFields({
              name: `Key #${idx + 1}`,
              value: lines.join('\n'),
              inline: false,
            });
          });

          if (keys.length > maxShow) {
            embed.setFooter({
              text: `Menampilkan ${maxShow} dari ${keys.length} key. Gunakan dashboard web untuk detail lengkap.`,
            });
          }

          await interaction.editReply({ embeds: [embed] });
        } catch (err) {
          console.error('/mykey error:', err);
          await interaction.editReply({
            content:
              'Terjadi kesalahan saat mengambil data key dari API. Coba lagi beberapa saat lagi atau hubungi admin.',
          });
        }
      }

      return;
    }

    // ===================== BUTTONS ==============================
    if (interaction.isButton()) {
      const { customId } = interaction;

      // create ticket
      if (customId === 'store_create_ticket') {
        if (!interaction.guild) {
          await interaction.reply({
            content: 'Perintah ini hanya dapat digunakan di server.',
            ephemeral: true,
          });
          return;
        }

        await interaction.deferReply({ ephemeral: true });

        const guild = interaction.guild;
        const cleanName =
          interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '') ||
          'user';
        const shortId = Math.floor(Math.random() * 9000) + 1000;
        const channelName = `ticket-${cleanName}-${shortId}`;

        const everyone = guild.roles.everyone;

        const permissionOverwrites = [
          {
            id: everyone.id,
            deny: [PermissionsBitField.Flags.ViewChannel],
          },
          {
            id: interaction.user.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.AttachFiles,
            ],
          },
          {
            id: guild.members.me.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.ManageChannels,
            ],
          },
        ];

        for (const ownerIdRaw of OWNER_IDS) {
          const id = String(ownerIdRaw).trim();
          if (!id || id === interaction.user.id) continue;

          const ownerMember = guild.members.cache.get(id);
          const ownerRole = guild.roles.cache.get(id);

          if (!ownerMember && !ownerRole) continue;

          permissionOverwrites.push({
            id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.ManageChannels,
            ],
          });
        }

        const channel = await guild.channels.create({
          name: channelName.slice(0, 90),
          type: ChannelType.GuildText,
          parent: TICKET_CATEGORY_ID || undefined,
          topic: `Ticket order by ${interaction.user.tag} | OwnerID:${interaction.user.id}`,
          permissionOverwrites,
        });

        ticketOwners.set(channel.id, interaction.user.id);

        await interaction.editReply({
          content: `Ticket kamu sudah dibuat: ${channel}`,
        });

        await sendTicketIntroMessage(channel, interaction.user);

        const logEmbed = new EmbedBuilder()
          .setTitle('🎫 Ticket Baru Dibuat')
          .addFields(
            {
              name: 'User',
              value: `${interaction.user} (${interaction.user.id})`,
            },
            { name: 'Channel', value: `${channel}` }
          )
          .setTimestamp()
          .setColor(0x5865f2);

        await logOrder(guild, logEmbed);
        return;
      }

      // cancel order
      if (customId === 'ticket_cancel') {
        const ownerId = getTicketOwnerId(interaction.channel);
        if (
          interaction.user.id !== ownerId &&
          !isOwner(interaction.user.id)
        ) {
          await interaction.reply({
            content: 'Hanya pembuat ticket yang bisa membatalkan order ini.',
            ephemeral: true,
          });
          return;
        }

        await interaction.reply({
          content: 'Ticket akan dihapus dalam 3 detik...',
          ephemeral: true,
        });

        setTimeout(() => {
          interaction.channel
            .delete('Ticket dibatalkan oleh user')
            .catch(() => {});
        }, 3000);
        return;
      }

      // close ticket
      if (customId === 'ticket_close') {
        const member = await interaction.guild.members.fetch(
          interaction.user.id
        );
        if (
          !member.permissions.has(PermissionsBitField.Flags.ManageChannels) &&
          !isOwner(interaction.user.id)
        ) {
          await interaction.reply({
            content:
              'Hanya admin / owner yang dapat menutup ticket ini (Close Ticket).',
            ephemeral: true,
          });
          return;
        }

        await interaction.reply({
          content: 'Ticket akan ditutup (channel dihapus) dalam 3 detik...',
          ephemeral: true,
        });

        setTimeout(() => {
          interaction.channel
            .delete('Ticket closed by staff')
            .catch(() => {});
        }, 3000);
        return;
      }

      // tombol "Input Username Lagi"
      if (customId === 'roblox_reinput' || customId === 'roblox_wrong') {
        const ownerId = getTicketOwnerId(interaction.channel);
        if (
          interaction.user.id !== ownerId &&
          !isOwner(interaction.user.id)
        ) {
          await interaction.reply({
            content:
              'Hanya pembuat ticket yang dapat menginput ulang username Roblox.',
            ephemeral: true,
          });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId('modal_roblox_username')
          .setTitle('Masukkan Username Roblox');

        const input = new TextInputBuilder()
          .setCustomId('field_roblox_username')
          .setLabel('Username Roblox')
          .setPlaceholder('Contoh: BloxGuy123')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
        return;
      }

      // tombol "Ya, Benar!"
      if (customId.startsWith('roblox_confirm_')) {
        const ownerId = getTicketOwnerId(interaction.channel);
        if (
          interaction.user.id !== ownerId &&
          !isOwner(interaction.user.id)
        ) {
          await interaction.reply({
            content:
              'Hanya pembuat ticket yang dapat mengkonfirmasi username ini.',
            ephemeral: true,
          });
          return;
        }

        const embed = interaction.message.embeds[0];
        let usernameText = '-';
        let displayNameText = '-';
        let userIdText = '-';

        if (embed && Array.isArray(embed.fields)) {
          for (const f of embed.fields) {
            if (f.name === 'Username') usernameText = f.value;
            if (f.name === 'Display Name') displayNameText = f.value;
            if (f.name === 'User ID') userIdText = f.value;
          }
        }

        const rowOld = interaction.message.components[0];
        const btn1 = ButtonBuilder.from(rowOld.components[0]).setDisabled(true);
        const btn2 = ButtonBuilder.from(rowOld.components[1]).setDisabled(true);
        const newRow = new ActionRowBuilder().addComponents(btn1, btn2);

        await interaction.update({ components: [newRow] });

        const harga = priceIndoHangout;

        const instruksi = new EmbedBuilder()
          .setTitle('✨ Instruksi Pembayaran')
          .setDescription('Scan QRIS di bawah untuk membayar')
          .addFields(
            {
              name: 'Detail Pesanan',
              value:
                `Paket   : Indo Hangout Premium\n` +
                `Username: ${usernameText}\n` +
                `User ID : ${userIdText}\n` +
                `Nominal : Rp ${formatRupiah(harga)}`,
            },
            {
              name: 'Langkah Pembayaran',
              value:
                '1. Scan QRIS di bawah dengan aplikasi pembayaran.\n' +
                '2. Bayar sesuai nominal.\n' +
                '3. Screenshot bukti bayar dan upload di channel ini.\n' +
                '4. Tunggu konfirmasi admin (maksimal 10 menit).',
            },
            {
              name: 'Jam Operasional',
              value: '08:00 - 23:00 WIB',
            }
          )
          .setColor(0xfee75c);

        if (QRIS_IMAGE_URL) {
          instruksi.setImage(QRIS_IMAGE_URL);
        }

        await interaction.followUp({ embeds: [instruksi] });

        const logEmb = new EmbedBuilder()
          .setTitle('🧾 Order Indo Hangout Premium')
          .addFields(
            {
              name: 'Discord User',
              value: `${interaction.user} (${interaction.user.id})`,
            },
            { name: 'Roblox Username', value: usernameText },
            { name: 'Roblox User ID', value: userIdText },
            { name: 'Nominal', value: `Rp ${formatRupiah(harga)}` },
            { name: 'Channel Ticket', value: `${interaction.channel}` }
          )
          .setTimestamp()
          .setColor(0x57f287);

        await logOrder(interaction.guild, logEmb);
        return;
      }

      return;
    }

    // ===================== SELECT MENU ==========================
    if (interaction.isStringSelectMenu()) {
      const { customId } = interaction;
      if (customId === 'ticket_select_package') {
        const [value] = interaction.values;
        const ownerId = getTicketOwnerId(interaction.channel);

        if (
          interaction.user.id !== ownerId &&
          !isOwner(interaction.user.id)
        ) {
          await interaction.reply({
            content:
              'Hanya pembuat ticket yang dapat memilih paket order di ticket ini.',
            ephemeral: true,
          });
          return;
        }

        if (value === 'KEY_MONTH') {
          const harga = priceKeyMonth;
          const instruksi = new EmbedBuilder()
            .setTitle('✨ Instruksi Pembayaran — Key Sebulan')
            .setDescription('Scan QRIS di bawah untuk membayar')
            .addFields(
              {
                name: 'Detail Pesanan',
                value:
                  `Paket   : Key Sebulan\n` +
                  `Nominal : Rp ${formatRupiah(harga)}`,
              },
              {
                name: 'Langkah Pembayaran',
                value:
                  '1. Scan QRIS di bawah dengan aplikasi pembayaran.\n' +
                  '2. Bayar sesuai nominal.\n' +
                  '3. Screenshot bukti bayar dan upload di channel ini.\n' +
                  '4. Tunggu konfirmasi admin (maksimal 10 menit).',
              },
              {
                name: 'Jam Operasional',
                value: '08:00 - 23:00 WIB',
              }
            )
            .setColor(0xfee75c);

          if (QRIS_IMAGE_URL) {
            instruksi.setImage(QRIS_IMAGE_URL);
          }

          await interaction.reply({
            content: `✅ Silahkan mengirim bukti pembayaran anda disini ${interaction.user}`,
            embeds: [instruksi],
          });
        } else if (value === 'KEY_LIFE') {
          const harga = priceKeyLifetime;
          const instruksi = new EmbedBuilder()
            .setTitle('✨ Instruksi Pembayaran — Key Lifetime')
            .setDescription('Scan QRIS di bawah untuk membayar')
            .addFields(
              {
                name: 'Detail Pesanan',
                value:
                  `Paket   : Key Lifetime\n` +
                  `Nominal : Rp ${formatRupiah(harga)}`,
              },
              {
                name: 'Langkah Pembayaran',
                value:
                  '1. Scan QRIS di bawah dengan aplikasi pembayaran.\n' +
                  '2. Bayar sesuai nominal.\n' +
                  '3. Screenshot bukti bayar dan upload di channel ini.\n' +
                  '4. Tunggu konfirmasi admin (maksimal 10 menit).',
              },
              {
                name: 'Jam Operasional',
                value: '08:00 - 23:00 WIB',
              }
            )
            .setColor(0xfee75c);

          if (QRIS_IMAGE_URL) {
            instruksi.setImage(QRIS_IMAGE_URL);
          }

          await interaction.reply({
            content: `✅ Silahkan mengirim bukti pembayaran anda disini ${interaction.user}`,
            embeds: [instruksi],
          });
        } else if (value === 'INDO_VIP') {
          const modal = new ModalBuilder()
            .setCustomId('modal_roblox_username')
            .setTitle('Masukkan Username Roblox');

          const input = new TextInputBuilder()
            .setCustomId('field_roblox_username')
            .setLabel('Username Roblox')
            .setPlaceholder('Contoh: BloxGuy123')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

          const row = new ActionRowBuilder().addComponents(input);
          modal.addComponents(row);
          await interaction.showModal(modal);
        }

        return;
      }

      return;
    }

    // ===================== MODAL SUBMIT =========================
    if (interaction.isModalSubmit()) {
      const { customId } = interaction;

      // modal input username Roblox
      if (customId === 'modal_roblox_username') {
        await interaction.deferReply({ ephemeral: true });

        const ownerId = getTicketOwnerId(interaction.channel);
        if (
          interaction.user.id !== ownerId &&
          !isOwner(interaction.user.id)
        ) {
          await interaction.editReply({
            content:
              'Hanya pembuat ticket yang dapat menginput username Roblox.',
          });
          return;
        }

        const username = interaction.fields
          .getTextInputValue('field_roblox_username')
          .trim();

        if (!username) {
          await interaction.editReply({
            content: 'Username tidak boleh kosong.',
          });
          return;
        }

        try {
          const roblox = await lookupRobloxUser(username);

          if (!roblox) {
            await interaction.editReply({
              content:
                '❌ Username tidak ditemukan. Lihat panel di bawah untuk panduan dan input ulang.',
            });

            const embed = new EmbedBuilder()
              .setTitle('✨ Username Tidak Ditemukan')
              .setDescription(
                `Username \`${username}\` tidak ditemukan di Roblox.`
              )
              .addFields(
                {
                  name: 'Kemungkinan Penyebab',
                  value:
                    '• Username salah ketik\n' +
                    '• Menggunakan Display Name (bukan Username)\n' +
                    '• Akun Roblox tidak ada\n' +
                    '• Ada spasi atau karakter khusus',
                },
                {
                  name: 'Cara Cek Username Roblox',
                  value:
                    '1. Buka profil Roblox Anda.\n' +
                    '2. Username ada di `@username` (bukan Display Name).\n' +
                    '3. Contoh: Display `John` → Username `@john123`.',
                }
              )
              .setColor(0xed4245);

            const btn = new ButtonBuilder()
              .setCustomId('roblox_reinput')
              .setLabel('Input Username Lagi')
              .setEmoji('🔁')
              .setStyle(ButtonStyle.Primary);

            const row = new ActionRowBuilder().addComponents(btn);

            await interaction.channel.send({
              embeds: [embed],
              components: [row],
            });
          } else {
            await interaction.editReply({
              content:
                '✅ Username terverifikasi! Lihat panel di bawah untuk konfirmasi.',
            });

            const embed = new EmbedBuilder()
              .setTitle('✨ Username Ditemukan')
              .setDescription(`${roblox.name} (@${username})`)
              .addFields(
                { name: 'Username', value: roblox.name, inline: true },
                {
                  name: 'Display Name',
                  value: roblox.displayName || '-',
                  inline: true,
                },
                {
                  name: 'User ID',
                  value: String(roblox.id),
                  inline: true,
                }
              )
              .setThumbnail(robloxAvatarUrl(roblox.id))
              .setColor(0x57f287);

            const btnYes = new ButtonBuilder()
              .setCustomId(`roblox_confirm_${roblox.id}`)
              .setLabel('Ya, Benar!')
              .setEmoji('✅')
              .setStyle(ButtonStyle.Success);

            const btnNo = new ButtonBuilder()
              .setCustomId('roblox_wrong')
              .setLabel('Salah, Input Ulang')
              .setEmoji('❌')
              .setStyle(ButtonStyle.Danger);

            const row = new ActionRowBuilder().addComponents(btnYes, btnNo);

            await interaction.channel.send({
              embeds: [embed],
              components: [row],
            });
          }
        } catch (err) {
          console.error('lookupRobloxUser error:', err);
          await interaction.editReply({
            content:
              'Terjadi kesalahan saat menghubungi API Roblox. Coba lagi beberapa saat lagi.',
          });
        }

        return;
      }

      // modal redeem key sebulan
      if (customId === 'modal_redeem_key_month') {
        await interaction.deferReply({ ephemeral: true });

        const rawKey = interaction.fields
          .getTextInputValue('field_key_month')
          .trim();
        const key = rawKey.toUpperCase();

        if (!key) {
          await interaction.editReply({ content: 'Key tidak boleh kosong.' });
          return;
        }

        try {
          const data = await validatePaidKey(key);
          const info = data.info || null;

          if (!info) {
            await interaction.editReply({
              content: '❌ Key tidak ditemukan di database.',
            });
            return;
          }

          if (data.deleted) {
            await interaction.editReply({
              content: '❌ Key ini sudah diblokir / dihapus.',
            });
            return;
          }

          if (data.expired) {
            await interaction.editReply({
              content: '❌ Key ini sudah kadaluarsa.',
            });
            return;
          }

          if (data.valid) {
            await interaction.editReply({
              content:
                '⚠️ Key ini sudah pernah diredeem sebelumnya (sudah aktif).',
            });
            return;
          }

          const keyType = normalizeKeyType(info.type || '');
          if (!keyType) {
            await interaction.editReply({
              content:
                '⚠️ Key ini tidak memiliki tipe paket yang jelas di database. Hubungi admin untuk pengecekan manual.',
            });
            return;
          }

          if (keyType !== 'month') {
            await interaction.editReply({
              content:
                '❌ Key ini **bukan** tipe **Key Sebulan**.\n' +
                'Jika ini key lifetime, gunakan perintah `/redeemkeylifetime`.\n' +
                'Jika merasa ada kesalahan, silakan hubungi admin.',
            });
            return;
          }

          if (
            info.ownerDiscordId &&
            String(info.ownerDiscordId) !== interaction.user.id
          ) {
            await interaction.editReply({
              content:
                '❌ Key ini terikat ke akun Discord lain.\n' +
                'Gunakan akun Discord yang sama dengan yang melakukan order.',
            });
            return;
          }

          const ownerDiscordId = info.ownerDiscordId
            ? String(info.ownerDiscordId)
            : interaction.user.id;

          try {
            await createPaidKeyOnAPI(key, keyType, null, {
              valid: true,
              deleted: false,
              createdAt: info.createdAt,
              expiresAfter: info.expiresAfter,
              byIp: 'discord-bot-redeem-month',
              ownerDiscordId,
            });
          } catch (err) {
            console.error(
              'createPaidKeyOnAPI (redeem month) error:',
              err
            );
            await interaction.editReply({
              content:
                'Key ditemukan, tapi gagal mengupdate status di API. Coba lagi beberapa saat lagi.',
            });
            return;
          }

          await interaction.editReply({
            content:
              `✅ Key sebulan berhasil digunakan!\n` +
              `Key: \`${key}\`\n` +
              'Terima kasih sudah menggunakan ExHub.',
          });
        } catch (err) {
          console.error('validatePaidKey (month) error:', err);
          await interaction.editReply({
            content:
              'Terjadi kesalahan saat menghubungi API validasi key. Coba lagi beberapa saat lagi.',
          });
        }

        return;
      }

      // modal redeem key lifetime
      if (customId === 'modal_redeem_key_life') {
        await interaction.deferReply({ ephemeral: true });

        const rawKey = interaction.fields
          .getTextInputValue('field_key_life')
          .trim();
        const key = rawKey.toUpperCase();

        if (!key) {
          await interaction.editReply({ content: 'Key tidak boleh kosong.' });
          return;
        }

        try {
          const data = await validatePaidKey(key);
          const info = data.info || null;

          if (!info) {
            await interaction.editReply({
              content: '❌ Key tidak ditemukan di database.',
            });
            return;
          }

          if (data.deleted) {
            await interaction.editReply({
              content: '❌ Key ini sudah diblokir / dihapus.',
            });
            return;
          }

          if (data.expired) {
            await interaction.editReply({
              content: '❌ Key ini sudah kadaluarsa.',
            });
            return;
          }

          if (data.valid) {
            await interaction.editReply({
              content:
                '⚠️ Key ini sudah pernah diredeem sebelumnya (sudah aktif).',
            });
            return;
          }

          const keyType = normalizeKeyType(info.type || '');
          if (!keyType) {
            await interaction.editReply({
              content:
                '⚠️ Key ini tidak memiliki tipe paket yang jelas di database. Hubungi admin untuk pengecekan manual.',
            });
            return;
          }

          if (keyType !== 'lifetime') {
            await interaction.editReply({
              content:
                '❌ Key ini **bukan** tipe **Key Lifetime**.\n' +
                'Jika ini key sebulan, gunakan perintah `/redeemkeysebulan`.\n' +
                'Jika merasa ada kesalahan, silakan hubungi admin.',
            });
            return;
          }

          if (
            info.ownerDiscordId &&
            String(info.ownerDiscordId) !== interaction.user.id
          ) {
            await interaction.editReply({
              content:
                '❌ Key ini terikat ke akun Discord lain.\n' +
                'Gunakan akun Discord yang sama dengan yang melakukan order.',
            });
            return;
          }

          const ownerDiscordId = info.ownerDiscordId
            ? String(info.ownerDiscordId)
            : interaction.user.id;

          try {
            await createPaidKeyOnAPI(key, keyType, null, {
              valid: true,
              deleted: false,
              createdAt: info.createdAt,
              expiresAfter: info.expiresAfter,
              byIp: 'discord-bot-redeem-lifetime',
              ownerDiscordId,
            });
          } catch (err) {
            console.error(
              'createPaidKeyOnAPI (redeem lifetime) error:',
              err
            );
            await interaction.editReply({
              content:
                'Key ditemukan, tapi gagal mengupdate status di API. Coba lagi beberapa saat lagi.',
            });
            return;
          }

          await interaction.editReply({
            content:
              `✅ Key lifetime berhasil di redeem, silahkan digunakan!\n` +
              `Key: \`${key}\`\n` +
              'Terima kasih sudah menggunakan ExHub.',
          });
        } catch (err) {
          console.error('validatePaidKey (life) error:', err);
          await interaction.editReply({
            content:
              'Terjadi kesalahan saat menghubungi API validasi key. Coba lagi beberapa saat lagi.',
          });
        }

        return;
      }

      return;
    }
  } catch (err) {
    console.error('interactionCreate error:', err);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: 'Terjadi error internal saat memproses perintah.',
          ephemeral: true,
        });
      }
    } catch (_) {}
  }
});

// ---------- REGISTER SLASH COMMANDS & LOGIN -------------------

const commands = [
  new SlashCommandBuilder()
    .setName('sendticketpanel')
    .setDescription('Kirim panel store / ticket di channel ini'),
  new SlashCommandBuilder()
    .setName('setharga_sebulan')
    .setDescription('Ubah harga paket Key Sebulan')
    .addIntegerOption((opt) =>
      opt
        .setName('harga')
        .setDescription('Harga dalam Rupiah (misal: 15000)')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('setharga_lifetime')
    .setDescription('Ubah harga paket Key Lifetime')
    .addIntegerOption((opt) =>
      opt
        .setName('harga')
        .setDescription('Harga dalam Rupiah (misal: 25000)')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('setharga_indohangout')
    .setDescription('Ubah harga paket Indo Hangout Premium')
    .addIntegerOption((opt) =>
      opt
        .setName('harga')
        .setDescription('Harga dalam Rupiah (misal: 10000)')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('generatekeysebulan')
    .setDescription('Generate key sebulan untuk member')
    .addUserOption((opt) =>
      opt
        .setName('member')
        .setDescription(
          'Member yang akan menerima key (jika kosong, tampil di reply)'
        )
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('generatekeylifetime')
    .setDescription('Generate key lifetime untuk member')
    .addUserOption((opt) =>
      opt
        .setName('member')
        .setDescription(
          'Member yang akan menerima key (jika kosong, tampil di reply)'
        )
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('redeemkeysebulan')
    .setDescription('Redeem key sebulan (muncul modal input key)'),
  new SlashCommandBuilder()
    .setName('redeemkeylifetime')
    .setDescription('Redeem key lifetime (muncul modal input key)'),
  new SlashCommandBuilder()
    .setName('setwelcomechannel')
    .setDescription('Set channel untuk welcome message')
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Channel tujuan welcome')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('refreshserverstats')
    .setDescription(
      'Refresh nama channel SERVER STATS (All Members, Members, Bots, Boosts)'
    ),
  new SlashCommandBuilder()
    .setName('sendreactionrole')
    .setDescription('Kirim pesan reaction role (multi role, multi emoji, multi channel)')
    .addStringOption((opt) =>
      opt
        .setName('title')
        .setDescription('Judul / teks utama pesan reaction role')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('config')
        .setDescription('Daftar emoji & role per baris. Contoh: "✅ ; @Member"')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('channels')
        .setDescription(
          'Channel tujuan (mention/ID, pisah spasi/koma). Kosongkan untuk pakai channel ini.'
        )
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('runtime')
    .setDescription('Lihat runtime & spesifikasi core VPS untuk bot ini'),
  new SlashCommandBuilder()
    .setName('mykey')
    .setDescription('Lihat semua paid key yang terikat ke akun Discord kamu'),
  new SlashCommandBuilder()
    .setName('checkmykey')
    .setDescription('Alias dari /mykey untuk cek semua paid key kamu'),
].map((c) => c.setDMPermission(false).toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    if (!DISCORD_TOKEN || !CLIENT_ID) {
      console.error(
        'DISCORD_TOKEN atau CLIENT_ID belum di-set. Cek .env di Railway.'
      );
      return;
    }

    console.log('DEBUG CLIENT_ID:', CLIENT_ID);
    console.log('DEBUG GUILD_ID:', process.env.GUILD_ID);
    console.log(
      'DEBUG TOKEN LENGTH:',
      DISCORD_TOKEN ? DISCORD_TOKEN.length : 'NO TOKEN'
    );

    console.log('⏳ Registering slash commands...');
    const guildId = process.env.GUILD_ID;

    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), {
        body: commands,
      });
      console.log('✅ Slash commands registered (guild specific).');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), {
        body: commands,
      });
      console.log('✅ Slash commands registered (global).');
    }

    await client.login(DISCORD_TOKEN);
  } catch (err) {
    console.error('Failed to start bot:', err);
  }
})();
