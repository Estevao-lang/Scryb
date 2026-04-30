/**
 * auth.js — Discord OAuth2 + session + database
 * Used by server.js for both web and Electron desktop flows.
 */
const passport      = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const session       = require("express-session");
const PgSession     = require("connect-pg-simple")(session);
const { Pool }      = require("pg");
const crypto        = require("crypto");
const path          = require("path");

// ── Database pool ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 5,
});

// ── Encryption (AES-256-GCM) ──────────────────────────────────
const ENC_KEY_HEX = process.env.ENCRYPTION_KEY;

const getEncKey = () => {
  if (!ENC_KEY_HEX) throw new Error("ENCRYPTION_KEY env var not set");
  return Buffer.from(ENC_KEY_HEX, "hex");
};

const encrypt = (text) => {
  const key = getEncKey();
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
};

const decrypt = (stored) => {
  const [ivHex, tagHex, dataHex] = stored.split(":");
  const key    = getEncKey();
  const iv     = Buffer.from(ivHex,  "hex");
  const tag    = Buffer.from(tagHex, "hex");
  const data   = Buffer.from(dataHex,"hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
};

// ── DB helpers ────────────────────────────────────────────────
const upsertUser = async ({ discord_id, username, discriminator, avatar }) => {
  const { rows } = await pool.query(
    `INSERT INTO users (discord_id, username, discriminator, avatar, last_seen_at)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (discord_id) DO UPDATE
       SET username=$2, discriminator=$3, avatar=$4, last_seen_at=NOW()
     RETURNING *`,
    [discord_id, username, discriminator || "0", avatar || null]
  );
  return rows[0];
};

const saveTranscription = async (userId, text, language, durationSec) => {
  const enc = encrypt(text);
  const { rows } = await pool.query(
    `INSERT INTO transcriptions (user_id, encrypted_text, language, duration_sec)
     VALUES ($1,$2,$3,$4) RETURNING id, created_at, expires_at`,
    [userId, enc, language, durationSec || null]
  );
  return rows[0];
};

const getUserTranscriptions = async (userId) => {
  const { rows } = await pool.query(
    `SELECT id, language, duration_sec, created_at, expires_at, encrypted_text
     FROM transcriptions
     WHERE user_id=$1 AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 50`,
    [userId]
  );
  return rows.map(r => ({
    ...r,
    text: decrypt(r.encrypted_text),
    encrypted_text: undefined,
  }));
};

const saveUserSettings = async (userId, { groqApiKey }) => {
  const encryptedGroqKey = groqApiKey ? encrypt(groqApiKey) : null;
  const { rows } = await pool.query(
    `INSERT INTO user_settings (user_id, encrypted_groq_api_key, updated_at)
     VALUES ($1,$2,NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET encrypted_groq_api_key = COALESCE($2, user_settings.encrypted_groq_api_key),
           updated_at = NOW()
     RETURNING user_id, encrypted_groq_api_key, created_at, updated_at`,
    [userId, encryptedGroqKey]
  );
  return rows[0];
};

const getUserSettings = async (userId) => {
  const { rows } = await pool.query(
    `SELECT encrypted_groq_api_key, created_at, updated_at
     FROM user_settings
     WHERE user_id=$1`,
    [userId]
  );
  const row = rows[0];
  if (!row) return { groqApiKey: "" };

  return {
    groqApiKey: row.encrypted_groq_api_key ? decrypt(row.encrypted_groq_api_key) : "",
    created_at: row.created_at,
    updated_at: row.updated_at
  };
};

const deleteExpired = async () => {
  const { rows } = await pool.query("SELECT delete_expired_transcriptions()");
  const n = rows[0]?.delete_expired_transcriptions || 0;
  if (n > 0) console.log(`[db] deleted ${n} expired transcription(s)`);
};

// ── Passport ──────────────────────────────────────────────────
const configurePassport = () => {
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
    console.warn("[auth] DISCORD_CLIENT_ID/SECRET not set — OAuth login disabled");
    return;
  }

  const isDesktop  = process.env.ELECTRON_APP === "1";
  const callbackURL = isDesktop
    ? `http://localhost:${process.env.PORT || 3000}/auth/discord/callback`
    : (process.env.DISCORD_REDIRECT_URI || "https://scryb.onrender.com/auth/discord/callback");

  passport.use(new DiscordStrategy(
    {
      clientID:     process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
      callbackURL,
      scope: ["identify", "guilds"],
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const user = await upsertUser({
          discord_id:    profile.id,
          username:      profile.username,
          discriminator: profile.discriminator,
          avatar:        profile.avatar,
        });
        done(null, user);
      } catch (err) {
        done(err);
      }
    }
  ));

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id, done) => {
    try {
      const { rows } = await pool.query("SELECT * FROM users WHERE id=$1", [id]);
      done(null, rows[0] || null);
    } catch (err) {
      done(err);
    }
  });
};

// ── Session middleware ─────────────────────────────────────────
const buildSessionMiddleware = (dbAvailable) => {
  const store = dbAvailable
    ? new PgSession({ pool, tableName: "sessions", createTableIfMissing: false })
    : undefined;

  return session({
    store,
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure:   process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
    },
  });
};

// ── Auth route middleware ─────────────────────────────────────
const requireAuth = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  // Desktop: redirect to login; API: return 401
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Unauthorized" });
  res.redirect("/");
};

// ── Check if DB is available ──────────────────────────────────
const checkDb = async () => {
  if (!process.env.DATABASE_URL) return false;
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    console.warn("[db] DATABASE_URL set but connection failed — running without DB");
    return false;
  }
};

module.exports = {
  pool,
  encrypt,
  decrypt,
  upsertUser,
  saveTranscription,
  getUserTranscriptions,
  saveUserSettings,
  getUserSettings,
  deleteExpired,
  configurePassport,
  buildSessionMiddleware,
  requireAuth,
  checkDb,
};
