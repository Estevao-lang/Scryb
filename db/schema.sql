-- scryb database schema
-- Run once on Neon PostgreSQL to initialize

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  discord_id    TEXT NOT NULL UNIQUE,
  username      TEXT NOT NULL,
  discriminator TEXT NOT NULL DEFAULT '0',
  avatar        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  sid    TEXT PRIMARY KEY,
  sess   JSONB NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions (expire);

CREATE TABLE IF NOT EXISTS transcriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- text is AES-256-GCM encrypted; stored as hex: iv:authTag:ciphertext
  encrypted_text TEXT NOT NULL,
  language     TEXT NOT NULL DEFAULT 'portuguese',
  duration_sec INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);
CREATE INDEX IF NOT EXISTS transcriptions_user_idx  ON transcriptions (user_id);
CREATE INDEX IF NOT EXISTS transcriptions_expire_idx ON transcriptions (expires_at);

-- Auto-delete expired transcriptions (called by cleanup job in server.js)
-- SELECT delete_expired_transcriptions();
CREATE OR REPLACE FUNCTION delete_expired_transcriptions()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE deleted INTEGER;
BEGIN
  DELETE FROM transcriptions WHERE expires_at < NOW();
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;
