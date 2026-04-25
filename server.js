// Write startup log so we can diagnose failures in the packaged app
try {
  const _fs = require("fs");
  const _logPath = require("path").join(process.env.USER_DATA_PATH || __dirname, "server-startup.log");
  const _log = (m) => _fs.appendFileSync(_logPath, `[${new Date().toISOString()}] ${m}\n`);
  _log(`server.js starting, __dirname=${__dirname}`);
  process.on("uncaughtException", (e) => { _log(`UNCAUGHT: ${e.stack}`); process.exit(1); });
  process.on("unhandledRejection", (e) => { _log(`UNHANDLED: ${e}`); });
} catch {}

require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express  = require("express");
const passport = require("passport");
const multer   = require("multer");
const ffmpegPath = require("ffmpeg-static");
const path     = require("path");
const os       = require("os");
const fs       = require("fs/promises");
const crypto   = require("crypto");
const { spawn } = require("child_process");
const auth     = require("./auth");

const app  = express();
const port = process.env.PORT || 3000;
app.use(express.json());

// In Electron, USER_DATA_PATH is set to app.getPath("userData") — writable by the user.
// Fall back to a local "storage" folder when running standalone (dev / Render).
const userDataDir = process.env.USER_DATA_PATH || path.join(__dirname, "storage");
const storageDir = userDataDir;
const uploadDir = path.join(storageDir, "uploads");
const jobsFile = path.join(storageDir, "jobs.json");
const settingsFile = path.join(userDataDir, "settings.json");
// Use os.tmpdir() to guarantee a path without special characters for whisper-cli
const audioDir = path.join(os.tmpdir(), "whisper-transcricao");
const whisperDir = path.join(__dirname, "vendor", "whispercpp");
const whisperBinDir = path.join(whisperDir, "bin", "Release");
const whisperCliPath = path.join(whisperBinDir, "whisper-cli.exe");
const whisperModelsDir = path.join(whisperDir, "models");

const MAX_SAVED_JOBS = 100;

// ── Settings ──────────────────────────────────────────────────

const loadSettings = async () => {
  try {
    const raw = await fs.readFile(settingsFile, "utf8");
    const settings = JSON.parse(raw);
    if (settings.groqApiKey) process.env.GROQ_API_KEY = settings.groqApiKey;
    if (settings.discordBotToken) process.env.DISCORD_BOT_TOKEN = settings.discordBotToken;
  } catch {
    // File doesn't exist yet — that's fine
  }
};

const saveSettings = async (settings) => {
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2), "utf8");
};

const allowedMimeTypes = new Set([
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav",
  "audio/flac", "audio/x-flac", "audio/mp4", "audio/x-m4a",
  "audio/webm", "audio/ogg", "video/mp4", "video/webm",
  "video/quicktime", "video/x-m4v"
]);

const allowedExtensions = new Set([
  ".mp3", ".wav", ".flac", ".m4a", ".mp4", ".webm", ".ogg", ".mov", ".m4v"
]);

const modelLabels = {
  "ggml-tiny.bin": "Tiny (75 MB) — fastest",
  "ggml-base.bin": "Base (142 MB) — recommended",
  "ggml-small.bin": "Small (466 MB) — better quality",
  "ggml-medium.bin": "Medium (1.5 GB) — high accuracy"
};

const jobs = new Map();

// ── Persistence ──────────────────────────────────────────────

const persistJobs = async () => {
  try {
    // Only save terminal jobs (completed/failed) — processing can't be resumed
    const toSave = [...jobs.values()]
      .filter((j) => j.status === "completed" || j.status === "failed")
      .slice(-MAX_SAVED_JOBS)
      .map((j) => ({
        id: j.id,
        status: j.status,
        totalFiles: j.totalFiles,
        completedFiles: j.completedFiles,
        startedAt: j.startedAt,
        savedAt: Date.now(),
        error: j.error || null,
        resultText: j.resultText || "",
        results: j.results || []
      }));
    await fs.writeFile(jobsFile, JSON.stringify(toSave, null, 2), "utf8");
  } catch (err) {
    console.error("[jobs] error saving:", err.message);
  }
};

const loadJobs = async () => {
  try {
    const raw = await fs.readFile(jobsFile, "utf8");
    const saved = JSON.parse(raw);
    for (const j of saved) {
      jobs.set(j.id, { ...j, currentFile: null });
    }
    console.log(`[jobs] ${saved.length} job(s) restored from disk.`);
  } catch {
    // File doesn't exist yet — that's fine
  }
};

// ── Helpers ───────────────────────────────────────────────────

const normalizeToArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === "undefined") return [];
  return [value];
};

const formatResultsAsText = (results) =>
  results
    .map((item) => `${item.sourcePath || item.fileName}\n${item.text}`.trim())
    .join("\n\n");

const estimateRemainingSeconds = (job) => {
  if (!job.startedAt) return null;
  const processedCount = job.completedFiles + (job.currentFile ? 1 : 0);
  if (processedCount <= 0) return null;
  const elapsedSeconds = (Date.now() - job.startedAt) / 1000;
  const averageSecondsPerFile = elapsedSeconds / processedCount;
  const remainingFiles = Math.max(0, job.totalFiles - job.completedFiles);
  return Math.ceil(averageSecondsPerFile * remainingFiles);
};

const serializeJob = (job) => ({
  id: job.id,
  status: job.status,
  totalFiles: job.totalFiles,
  completedFiles: job.completedFiles,
  currentFile: job.currentFile,
  progressPercent: job.totalFiles
    ? Math.round((job.completedFiles / job.totalFiles) * 100)
    : 0,
  remainingSeconds: estimateRemainingSeconds(job),
  error: job.error,
  resultText: job.resultText,
  results: job.results,
  savedAt: job.savedAt || null
});

// ── Transcription cleanup ─────────────────────────────────────

const cleanTranscription = (text) => {
  if (!text) return text;

  // Patterns to remove entirely
  const noiseOnly = /^(\s*[\[(]?(música de fundo|música|music|risos|laughter|applause|palmas|legenda\s+\w+(\s+\w+)?)[\])]?\s*[,.]?\s*)+$/i;
  // Subtitle hallucination pattern: "Legenda Nome Sobrenome" repeated
  const subtitleHallucination = /^legenda\s+[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÀÇ][a-záéíóúâêîôûãõàç]+(\s+[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÀÇ][a-záéíóúâêîôûãõàç]+)*$/;
  // Single short words/filler repeated (E aí E aí E aí)
  const shortFiller = /^(e\s+aí|e\s+a\s+|aí|é+|sim+|não+)(\s+(e\s+aí|e\s+a\s+|aí|é+|sim+|não+)){2,}$/i;

  const lines = text.split("\n");
  const cleaned = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (noiseOnly.test(trimmed)) continue;
    if (subtitleHallucination.test(trimmed)) continue;
    if (shortFiller.test(trimmed)) continue;

    // Remove lines where a short phrase repeats 4+ times
    const loopPattern = /^(.{2,40}?)(\s+\1){3,}$/i;
    if (loopPattern.test(trimmed)) continue;

    // Collapse inline "E aí E aí E aí" into single occurrence
    const collapsed = trimmed.replace(/(\bE\s+aí\b\s*){3,}/gi, "E aí... ");

    cleaned.push(collapsed);
  }

  // Remove consecutive duplicate lines
  return cleaned.filter((line, i) => i === 0 || line !== cleaned[i - 1]).join("\n");
};

const refineWithGroq = async (text, language) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || !text.trim()) return text;

  const languageNames = { portuguese: "português", english: "English", spanish: "español" };
  const langName = languageNames[language] || "português";

  const prompt = `You are an expert transcription editor. You received an automatic audio transcription in ${langName} produced by Whisper AI. Your task is to produce a clean, professional version suitable for reports and documentation.

Rules:
- Fix speech recognition errors (wrong words, homophones, invented words)
- Remove filler words (uh, um, like, you know, né, então, tipo) and false starts
- Fix punctuation, capitalization and paragraph breaks
- Preserve technical terms, proper names and numbers exactly as spoken
- Keep the original speaker's meaning — do not add, remove or change facts
- Output ONLY the corrected text, no explanations, no headers

Transcription to fix:
${text}`;

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 4096
      })
    });

    if (!response.ok) {
      console.error("[groq] error:", response.status, await response.text());
      return text;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || text;
  } catch (err) {
    console.error("[groq] request failed:", err.message);
    return text;
  }
};

// ── Groq Whisper transcription ────────────────────────────────

const GROQ_MAX_BYTES = 24 * 1024 * 1024; // 24 MB (Groq limit is 25 MB)

const convertToOgg = (inputPath, outputPath) =>
  new Promise((resolve, reject) => {
    const args = [
      "-i", inputPath, "-vn",
      "-c:a", "libvorbis", "-qscale:a", "2",
      "-ar", "16000", "-ac", "1",
      "-y", outputPath
    ];
    const proc = spawn(ffmpegPath, args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) { resolve(); return; }
      reject(new Error(stderr || "Failed to convert to OGG."));
    });
  });

const transcribeWithGroqWhisper = async (inputPath, language, context) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  // Convert to small OGG to stay under Groq's 25 MB limit
  const oggPath = inputPath.replace(/\.\w+$/, ".ogg");
  try {
    await convertToOgg(inputPath, oggPath);
    const stat = await fs.stat(oggPath);
    if (stat.size > GROQ_MAX_BYTES) {
      console.warn("[groq-whisper] file too large, falling back to local whisper.");
      return null;
    }

    const fileBuffer = await fs.readFile(oggPath);
    const { FormData, Blob } = await import("node:buffer").then(() => ({
      FormData: globalThis.FormData,
      Blob: globalThis.Blob
    }));

    // Build prompt hint: always include base language context + user-supplied context
    const languageHints = {
      portuguese: "Reunião em português brasileiro.",
      english: "Meeting in English.",
      spanish: "Reunión en español."
    };
    const baseHint = languageHints[language] || languageHints.portuguese;
    const promptText = context ? `${baseHint} ${context}` : baseHint;

    const form = new FormData();
    form.append("file", new Blob([fileBuffer], { type: "audio/ogg" }), "audio.ogg");
    form.append("model", "whisper-large-v3-turbo");
    form.append("response_format", "text");
    form.append("prompt", promptText);
    if (language && whisperLanguageMap[language]) {
      form.append("language", whisperLanguageMap[language]);
    }

    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}` },
      body: form
    });

    if (!response.ok) {
      console.error("[groq-whisper] error:", response.status, await response.text());
      return null;
    }

    return (await response.text()).trim();
  } catch (err) {
    console.error("[groq-whisper] failed:", err.message);
    return null;
  } finally {
    await removeFile(oggPath);
  }
};

// ── Job processing ────────────────────────────────────────────

const processJob = async (job, uploadedFiles, relativePaths, language, includeTimestamps, modelFile, speedMode, context) => {
  const convertedPaths = [];

  try {
    job.status = "processing";
    job.startedAt = Date.now();

    for (const [index, file] of uploadedFiles.entries()) {
      job.currentFile = relativePaths[index] || file.originalname;
      const wavPath = path.join(audioDir, `${crypto.randomUUID()}.wav`);
      convertedPaths.push(wavPath);
      await convertToWav(file.path, wavPath);

      // Try Groq Whisper Large first; fall back to local whisper.cpp
      let rawText = await transcribeWithGroqWhisper(wavPath, language, context);
      let usedGroqWhisper = rawText !== null;

      if (!usedGroqWhisper) {
        console.log("[transcription] using local whisper as fallback.");
        rawText = await transcribeWithWhisperCli(wavPath, language, includeTimestamps, modelFile, speedMode);
      }

      const cleanedText = cleanTranscription(rawText);
      // Always refine with LLM for report-quality output
      const resultText = await refineWithGroq(cleanedText, language);

      job.results.push({
        fileName: file.originalname,
        sourcePath: relativePaths[index] || file.originalname,
        text: resultText || ""
      });
      job.completedFiles += 1;

      // Save progress after each file completes
      await persistJobs();
    }

    job.resultText = formatResultsAsText(job.results);
    job.currentFile = null;
    job.status = "completed";
  } catch (error) {
    console.error(error);
    job.currentFile = null;
    job.status = "failed";
    job.error = error.message || "Failed to transcribe the files.";
  } finally {
    await Promise.allSettled([
      ...uploadedFiles.map((file) => removeFile(file.path)),
      ...convertedPaths.map((filePath) => removeFile(filePath))
    ]);
    await persistJobs();
  }
};

// ── Storage & conversion ──────────────────────────────────────

const ensureStorage = async () => {
  await Promise.all([
    fs.mkdir(uploadDir, { recursive: true }),
    fs.mkdir(audioDir, { recursive: true })
  ]);
};

const convertToWav = (inputPath, outputPath) =>
  new Promise((resolve, reject) => {
    const args = [
      "-i", inputPath, "-vn",
      "-acodec", "pcm_s16le",
      "-ar", "16000", "-ac", "1",
      "-y", outputPath
    ];
    const process = spawn(ffmpegPath, args);
    let stderr = "";
    process.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) { resolve(); return; }
      reject(new Error(stderr || "Failed to convert file to WAV."));
    });
  });

const whisperLanguageMap = { portuguese: "pt", english: "en", spanish: "es" };

const sanitizeRelativePath = (value) => {
  if (typeof value !== "string") return "";
  return value
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== ".." && segment !== ".")
    .join("/");
};

const transcribeWithWhisperCli = (inputPath, language, includeTimestamps, modelFile, speedMode) =>
  new Promise((resolve, reject) => {
    const modelRelPath = `../../models/${modelFile}`;
    const args = [
      "-m", modelRelPath,
      "-l", whisperLanguageMap[language] || "auto",
      "-f", inputPath,
      "-np",
      "-t", "8",
      "-et", "2.8",
      "-lpt", "-0.5"
    ];
    if (speedMode) args.push("-bs", "1", "-bo", "1");
    if (!includeTimestamps) args.push("-nt");

    const child = spawn(whisperCliPath, args, { cwd: whisperBinDir });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) { resolve(stdout.trim()); return; }
      console.error("[whisper] exit code:", code, "| stderr:", stderr);
      reject(new Error(stderr || stdout || "Failed to run whisper.cpp."));
    });
  });

const removeFile = async (filePath) => {
  if (!filePath) return;
  await fs.rm(filePath, { force: true });
};

// ── Multer ────────────────────────────────────────────────────

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname || "").toLowerCase();
    if (allowedMimeTypes.has(file.mimetype) || allowedExtensions.has(extension)) {
      callback(null, true);
      return;
    }
    callback(new Error("Please upload a compatible audio or video file."));
  }
});

// ── Routes ────────────────────────────────────────────────────

const publicDir = path.resolve(__dirname, "public");

// Landing page — always public
app.get("/", (req, res) => res.sendFile(path.join(publicDir, "home.html")));

// App — open if no DB, protected by session if DB available
app.get("/app", (req, res, next) => {
  if (!app.locals.dbAvailable) return res.sendFile(path.join(publicDir, "index.html"));
  auth.requireAuth(req, res, () => res.sendFile(path.join(publicDir, "index.html")));
});

app.use(express.static("public", { etag: false, maxAge: 0 }));

// ── Auth routes ───────────────────────────────────────────────

app.get("/auth/discord",
  passport.authenticate("discord", { scope: ["identify", "guilds"] })
);

app.get("/auth/discord/callback",
  passport.authenticate("discord", { failureRedirect: "/?login=failed" }),
  (req, res) => res.redirect("/app")
);

app.get("/auth/logout", (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect("/");
  });
});

app.get("/auth/me", (req, res) => {
  if (!req.isAuthenticated()) return res.json({ authenticated: false });
  const { id, discord_id, username, avatar, discriminator } = req.user;
  res.json({
    authenticated: true,
    user: {
      id, discord_id, username, discriminator,
      avatarUrl: avatar
        ? `https://cdn.discordapp.com/avatars/${discord_id}/${avatar}.png?size=64`
        : `https://cdn.discordapp.com/embed/avatars/${parseInt(discriminator || 0) % 5}.png`
    }
  });
});

// Transcription history (encrypted, only for authenticated users)
app.get("/api/transcriptions", auth.requireAuth, async (req, res) => {
  try {
    const list = await auth.getUserTranscriptions(req.user.id);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: "Failed to load transcriptions" });
  }
});

app.get("/api/settings", (req, res) => {
  const key = process.env.GROQ_API_KEY || "";
  const token = process.env.DISCORD_BOT_TOKEN || "";
  // RENDER env var is set automatically on Render.com
  const isCloud = !!(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT);
  res.json({
    hasGroqKey: key.length > 0,
    maskedKey: key.length > 8 ? `${key.slice(0, 8)}...` : null,
    hasDiscordToken: token.length > 0,
    recorderAvailable: !isCloud
  });
});

app.post("/api/settings", async (req, res) => {
  const { groqApiKey, discordBotToken } = req.body || {};
  const current = await fs.readFile(settingsFile, "utf8").then(JSON.parse).catch(() => ({}));
  const updated = { ...current };

  if (typeof groqApiKey === "string" && groqApiKey.trim()) {
    process.env.GROQ_API_KEY = groqApiKey.trim();
    updated.groqApiKey = groqApiKey.trim();
  }
  if (typeof discordBotToken === "string" && discordBotToken.trim()) {
    process.env.DISCORD_BOT_TOKEN = discordBotToken.trim();
    updated.discordBotToken = discordBotToken.trim();
  }
  if (!groqApiKey && !discordBotToken) {
    return res.status(400).json({ error: "No settings provided." });
  }

  await saveSettings(updated);
  res.json({ ok: true });
});

// ── Recorder proxy routes (forward to recorder.js on port 3001) ──

const RECORDER_URL = "http://127.0.0.1:3001";

const proxyToRecorder = async (method, path, body) => {
  const res = await fetch(`${RECORDER_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json() };
};

app.get("/api/recorder/status", async (req, res) => {
  try {
    const { status, data } = await proxyToRecorder("GET", "/status");
    return res.status(status).json(data);
  } catch {
    return res.status(503).json({ connected: false, error: "Recorder not running." });
  }
});

app.post("/api/recorder/start", async (req, res) => {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return res.status(400).json({ error: "Discord bot token not configured." });

  const { guildId, channelId, language, context } = req.body || {};
  if (!guildId || !channelId) return res.status(400).json({ error: "guildId and channelId are required." });

  try {
    const { status, data } = await proxyToRecorder("POST", "/start", { guildId, channelId, token });
    return res.status(status).json(data);
  } catch {
    return res.status(503).json({ error: "Recorder process not available." });
  }
});

app.post("/api/recorder/stop", async (req, res) => {
  const { language = "portuguese", context = "" } = req.body || {};

  try {
    const { data } = await proxyToRecorder("POST", "/stop", {});
    if (!data.files || !data.files.length) {
      return res.json({ jobId: null, message: "No audio was recorded." });
    }

    // Build fake multer-style file objects pointing to the recorded WAVs
    const uploadedFiles = data.files.map(({ username, wavPath }) => ({
      path: wavPath,
      originalname: `${username}.wav`,
      mimetype: "audio/wav"
    }));
    const relativePaths = data.files.map(({ username }) => username);

    const job = {
      id: crypto.randomUUID(),
      status: "queued",
      totalFiles: uploadedFiles.length,
      completedFiles: 0,
      currentFile: null,
      startedAt: null,
      error: null,
      resultText: "",
      results: [],
      savedAt: null
    };

    jobs.set(job.id, job);
    void processJob(job, uploadedFiles, relativePaths, language, false, "ggml-tiny.bin", false, context);

    return res.status(202).json({ jobId: job.id, ...serializeJob(job), channelName: data.channelName });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/modelos", async (req, res) => {
  const files = await fs.readdir(whisperModelsDir).catch(() => []);
  const models = files
    .filter((f) => f.startsWith("ggml-") && f.endsWith(".bin"))
    .map((f) => ({ file: f, label: modelLabels[f] || f }));
  return res.json(models);
});

app.post("/api/transcrever", upload.array("media", 20), async (req, res) => {
  const uploadedFiles = req.files || [];

  if (!uploadedFiles.length) {
    return res.status(400).json({ error: "Please upload at least one audio or video file." });
  }

  const relativePaths = normalizeToArray(req.body.relativePath).map(sanitizeRelativePath);
  const language = req.body.language || "portuguese";
  const includeTimestamps = req.body.outputFormat === "timestamps";

  const requestedModel = req.body.model || "ggml-tiny.bin";
  const modelPath = path.join(whisperModelsDir, requestedModel);
  const modelExists = await fs.access(modelPath).then(() => true).catch(() => false);
  const modelFile = modelExists ? requestedModel : "ggml-tiny.bin";
  const speedMode = req.body.speed === "fast";
  const context = typeof req.body.context === "string" ? req.body.context.slice(0, 500).trim() : "";

  const job = {
    id: crypto.randomUUID(),
    status: "queued",
    totalFiles: uploadedFiles.length,
    completedFiles: 0,
    currentFile: null,
    startedAt: null,
    error: null,
    resultText: "",
    results: [],
    savedAt: null
  };

  jobs.set(job.id, job);
  void processJob(job, uploadedFiles, relativePaths, language, includeTimestamps, modelFile, speedMode, context);

  return res.status(202).json({ jobId: job.id, ...serializeJob(job) });
});

app.get("/api/transcrever/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Transcription job not found." });
  }
  return res.json(serializeJob(job));
});

app.use((error, req, res, next) => {
  if (!error) { next(); return; }
  const isMulterLimit = error.code === "LIMIT_FILE_SIZE";
  const message = isMulterLimit
    ? "File exceeds the 200 MB limit."
    : error.message || "Failed to process the file.";
  res.status(400).json({ error: message });
});

// ── Startup ───────────────────────────────────────────────────

ensureStorage()
  .then(async () => {
    await loadSettings();

    // Auth + DB setup (gracefully skipped if DATABASE_URL not set)
    const dbAvailable = await auth.checkDb();
    app.locals.dbAvailable = dbAvailable;
    if (dbAvailable) {
      auth.configurePassport();
      app.use(auth.buildSessionMiddleware(true));
      app.use(passport.initialize());
      app.use(passport.session());
      // Clean expired transcriptions every hour
      setInterval(auth.deleteExpired, 60 * 60 * 1000);
      auth.deleteExpired();
      console.log("[db] connected — auth enabled");
    } else {
      // Still need session + passport stubs so routes don't crash
      app.use(auth.buildSessionMiddleware(false));
      app.use(passport.initialize());
      app.use(passport.session());
      console.log("[db] no DATABASE_URL — running without auth");
    }

    // whisper-cli is optional — Groq Whisper is the primary engine
    const whisperAvailable = await fs.access(whisperCliPath).then(() => true).catch(() => false);
    if (!whisperAvailable) {
      console.warn("[whisper] whisper-cli.exe not found — using Groq Whisper only.");
    }
    await loadJobs();
    const server = app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
    });
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[server] Port ${port} in use, retrying on ${port + 1}`);
        server.close();
        app.listen(port + 1, () => {
          console.log(`Server running at http://localhost:${port + 1}`);
        });
      } else {
        console.error("[server] Fatal:", err);
        process.exit(1);
      }
    });
  })
  .catch((error) => {
    console.error("Failed to prepare application directories.", error);
    process.exit(1);
  });
