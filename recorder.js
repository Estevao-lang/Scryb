/**
 * recorder.js — Lightweight Discord voice recorder for scryb
 * Runs as a separate process (utilityProcess.fork from main.js).
 * Exposes a small HTTP server on port 3001 for IPC with server.js.
 */
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const { Client, GatewayIntentBits } = require("discord.js");
const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType
} = require("@discordjs/voice");
const OpusScript = require("opusscript");

const RECORDER_PORT = 3001;
const recordingsDir = path.join(os.tmpdir(), "scryb-recordings");

// ── State ─────────────────────────────────────────────────────

let discordClient = null;
let voiceConnection = null;
let recordingSession = null; // { startedAt, guildId, channelId, participants: Map<userId, {username, wavPath, fileStream, ffmpegProc}> }

// ── Helpers ───────────────────────────────────────────────────

const ensureDir = (dir) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };

const formatDuration = (ms) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
};

// ── Discord bot setup ─────────────────────────────────────────

const createClient = (token) =>
  new Promise((resolve, reject) => {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
      ]
    });

    client.once("ready", () => {
      console.log(`[recorder] Bot online: ${client.user.tag}`);
      resolve(client);
    });

    client.once("error", reject);
    client.login(token).catch(reject);
  });

// ── Per-user audio recording ──────────────────────────────────

const startUserRecording = (userId, username, receiver, participants) => {
  ensureDir(recordingsDir);
  const wavPath = path.join(recordingsDir, `${userId}-${Date.now()}.wav`);

  // Manual end behavior: stream stays open until we destroy it
  const opusStream = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.Manual }
  });

  const ffmpeg = spawn(ffmpegPath, [
    "-f", "s16le", "-ar", "48000", "-ac", "2",
    "-i", "pipe:0",
    "-ar", "16000", "-ac", "1",
    "-f", "wav", wavPath
  ]);

  const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);

  opusStream.on("data", (opusPacket) => {
    try {
      const pcm = decoder.decode(opusPacket);
      if (!ffmpeg.stdin.destroyed) ffmpeg.stdin.write(pcm);
    } catch { /* silent packet */ }
  });

  opusStream.on("end", () => {
    if (!ffmpeg.stdin.destroyed) ffmpeg.stdin.end();
    // Remove from map so the user can be re-subscribed if needed
    participants.delete(userId);
  });

  ffmpeg.on("error", (err) => console.error(`[recorder] ffmpeg error for ${username}:`, err.message));

  return { wavPath, opusStream, ffmpegProc: ffmpeg };
};

// ── Recording session ─────────────────────────────────────────

const startRecording = async ({ guildId, channelId, token }) => {
  if (recordingSession) throw new Error("Already recording.");

  if (!discordClient || discordClient.token !== token) {
    if (discordClient) await discordClient.destroy();
    discordClient = await createClient(token);
  }

  const guild = await discordClient.guilds.fetch(guildId);
  const channel = guild.channels.cache.get(channelId) ||
    (await guild.channels.fetch(channelId));

  if (!channel || !channel.isVoiceBased()) {
    throw new Error("Channel not found or not a voice channel.");
  }

  voiceConnection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true
  });

  await entersState(voiceConnection, VoiceConnectionStatus.Ready, 10_000);
  console.log(`[recorder] Joined: ${channel.name}`);

  const participants = new Map();
  const receiver = voiceConnection.receiver;

  receiver.speaking.on("start", (userId) => {
    if (participants.has(userId)) return; // already subscribed (Manual mode stays open)
    const member = guild.members.cache.get(userId);
    const username = member?.displayName || userId;
    console.log(`[recorder] Recording user: ${username}`);
    const rec = startUserRecording(userId, username, receiver, participants);
    participants.set(userId, { username, ...rec });
  });

  recordingSession = {
    startedAt: Date.now(),
    guildId,
    channelId,
    channelName: channel.name,
    participants
  };

  return { ok: true, channelName: channel.name };
};

const stopRecording = () =>
  new Promise((resolve) => {
    if (!recordingSession) return resolve({ files: [] });

    const { participants, startedAt, channelName } = recordingSession;

    if (voiceConnection) {
      voiceConnection.destroy();
      voiceConnection = null;
    }

    // End all streams and collect wav paths
    const pending = [];
    participants.forEach(({ username, wavPath, opusStream, ffmpegProc }) => {
      pending.push(new Promise((done) => {
        if (!opusStream.destroyed) opusStream.destroy();
        if (!ffmpegProc.stdin.destroyed) ffmpegProc.stdin.end();
        ffmpegProc.on("close", () => done({ username, wavPath }));
        // Fallback timeout
        setTimeout(() => done({ username, wavPath }), 5000);
      }));
    });

    recordingSession = null;

    Promise.all(pending).then((files) => {
      // Filter out empty files
      const validFiles = files.filter(({ wavPath }) => {
        try { return fs.statSync(wavPath).size > 4096; } catch { return false; }
      });
      console.log(`[recorder] Stopped. ${validFiles.length} track(s) recorded.`);
      resolve({ files: validFiles, channelName, duration: Date.now() - startedAt });
    });
  });

const getStatus = () => {
  if (!recordingSession) return { connected: false };
  const { startedAt, channelName, participants } = recordingSession;
  return {
    connected: true,
    channelName,
    duration: Date.now() - startedAt,
    durationLabel: formatDuration(Date.now() - startedAt),
    participantCount: participants.size,
    participants: [...participants.values()].map(({ username }) => ({ username }))
  };
};

// ── HTTP API server (port 3001, internal only) ────────────────

const respond = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${RECORDER_PORT}`);

  if (req.method === "GET" && url.pathname === "/status") {
    return respond(res, 200, getStatus());
  }

  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    await new Promise((r) => req.on("end", r));
    const data = body ? JSON.parse(body) : {};

    if (url.pathname === "/start") {
      try {
        const result = await startRecording(data);
        return respond(res, 200, result);
      } catch (err) {
        console.error("[recorder] start error:", err.message);
        return respond(res, 500, { error: err.message });
      }
    }

    if (url.pathname === "/stop") {
      try {
        const result = await stopRecording();
        return respond(res, 200, result);
      } catch (err) {
        console.error("[recorder] stop error:", err.message);
        return respond(res, 500, { error: err.message });
      }
    }
  }

  respond(res, 404, { error: "Not found" });
});

server.listen(RECORDER_PORT, "127.0.0.1", () => {
  console.log(`[recorder] Internal API ready on port ${RECORDER_PORT}`);
});

process.on("SIGTERM", async () => {
  await stopRecording();
  if (discordClient) await discordClient.destroy();
  process.exit(0);
});
