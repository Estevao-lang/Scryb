# scryb — Audio Transcription

Fast, free and private AI-powered audio transcription. Built with whisper.cpp (local) and Groq Whisper Large v3 Turbo (cloud). Available as a desktop app (Electron) and a local web server.

## How It Works

### Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  Electron App (main.js)                             │
│  ┌─────────────────────┐  ┌─────────────────────┐  │
│  │  BrowserWindow      │  │  utilityProcess     │  │
│  │  (Chromium UI)      │  │  (server.js)        │  │
│  │                     │  │                     │  │
│  │  public/index.html  │◄─► Express API :3000   │  │
│  │  public/app.js      │  │  Job Queue          │  │
│  │  public/styles.css  │  │  Groq API           │  │
│  └─────────────────────┘  │  whisper.cpp        │  │
│                            └─────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

When the app starts:
1. `main.js` (Electron) spawns `server.js` via `utilityProcess.fork()`
2. A loading screen appears while the Express server boots
3. Once the server responds, the UI loads at `http://localhost:3000`
4. The app stays in the system tray when the window is closed

### Transcription Pipeline

For each uploaded file:

```
Audio/Video file
      │
      ▼
FFmpeg → WAV (16kHz mono PCM)
      │
      ├──► Groq Whisper Large v3 Turbo (primary)
      │    • Converts WAV → OGG (smaller file)
      │    • Sends to Groq API with language + context prompt
      │    • Returns clean transcript in ~5–10 seconds
      │    • Falls back to local if file > 24 MB
      │
      └──► whisper.cpp (fallback, local)
           • Uses ggml-tiny.bin (or selected model)
           • Runs whisper-cli.exe with anti-hallucination flags
           • Returns raw transcript
                 │
                 ▼
          cleanTranscription()
          • Removes noise markers ([music], [laughter])
          • Removes subtitle hallucinations ("Legenda Nome Sobrenome")
          • Collapses filler word loops ("E aí E aí E aí" → "E aí...")
          • Removes consecutive duplicate lines
                 │
                 ▼ (local whisper only)
          refineWithGroq()
          • Llama 3.1-8b-instant fixes grammar and removes artifacts
          • Skipped for Groq Whisper (already accurate)
                 │
                 ▼
          Final transcription text
```

### Job Queue

Every transcription request creates a **job**:

- Jobs are stored in a `Map` in memory and persisted to `storage/jobs.json`
- The UI polls `GET /api/transcribe/:jobId` every 1.2 seconds
- If the page reloads mid-transcription, `sessionStorage` resumes polling automatically
- On server restart, completed jobs are restored from `storage/jobs.json`
- Maximum 100 jobs are kept on disk

### File Storage

| Path | Purpose |
|------|---------|
| `storage/uploads/` | Multer temporary upload directory |
| `storage/jobs.json` | Completed job persistence |
| `%TEMP%\whisper-transcricao\` | WAV/OGG working files (OS temp dir) |
| `%APPDATA%\scryb\settings.json` | User API key (Electron only) |

> **Why `os.tmpdir()`?** Windows encodes special characters (like `ç`) differently in ANSI vs UTF-8. The project path contains `trancrição`, which caused `whisper-cli.exe` to crash with exit code `0xC0000409`. Moving audio files to the temp directory (which has no special characters) fixed this entirely.

---

## Setup

### Prerequisites

- Node.js 18+
- The `vendor/whispercpp/` directory with `whisper-cli.exe` and model files in `models/`

### Install dependencies

```bash
npm install
```

### Configure Groq API key

Create a `.env` file in the project root:

```
GROQ_API_KEY=gsk_your_key_here
```

Get a free key at [console.groq.com/keys](https://console.groq.com/keys).
Free tier: **7,200 minutes/day** (120 hours) — effectively unlimited for personal use.

Alternatively, configure the key inside the app via the ⚙️ Settings button.

### Run as web server

```bash
npm start
# → Server running at http://localhost:3000
```

### Run as desktop app (Electron)

```bash
npm run electron
```

### Build desktop installer (.exe)

```bash
npm run build
# → dist/scryb Setup 1.0.0.exe
```

---

## API Reference

### `POST /api/transcribe`

Upload one or more audio/video files for transcription.

**Form fields:**

| Field | Type | Description |
|-------|------|-------------|
| `media` | File (multiple) | Audio/video files (max 200 MB each, up to 20 files) |
| `relativePath` | string (multiple) | Original relative paths (used for Craig folder mode) |
| `language` | string | `portuguese` \| `english` \| `spanish` (default: `portuguese`) |
| `outputFormat` | string | `txt` \| `timestamps` |
| `model` | string | Whisper model filename, e.g. `ggml-tiny.bin` |
| `speed` | string | `fast` (greedy decoding) \| `normal` |
| `context` | string | Optional meeting context to improve recognition (max 500 chars) |

**Response `202`:**
```json
{
  "jobId": "uuid",
  "status": "queued",
  "totalFiles": 3,
  "completedFiles": 0
}
```

### `GET /api/transcribe/:jobId`

Poll job status.

**Response:**
```json
{
  "id": "uuid",
  "status": "processing",
  "totalFiles": 3,
  "completedFiles": 1,
  "currentFile": "audio-1.flac",
  "progressPercent": 33,
  "remainingSeconds": 42,
  "resultText": "",
  "results": []
}
```

Statuses: `queued` → `processing` → `completed` | `failed`

### `GET /api/models`

Returns available local whisper models.

```json
[
  { "file": "ggml-tiny.bin", "label": "Tiny (75 MB) — fastest" },
  { "file": "ggml-base.bin", "label": "Base (142 MB) — recommended" }
]
```

### `GET /api/settings`

Returns whether a Groq API key is configured.

```json
{ "hasGroqKey": true, "maskedKey": "gsk_AsPa..." }
```

### `POST /api/settings`

Save a new Groq API key. Updates `process.env.GROQ_API_KEY` immediately (no restart needed).

```json
{ "groqApiKey": "gsk_your_key_here" }
```

---

## Supported Formats

Audio: `.mp3`, `.wav`, `.flac`, `.m4a`, `.ogg`
Video: `.mp4`, `.webm`, `.mov`, `.m4v`
Max file size: **200 MB**
Max files per request: **20**

---

## Whisper Models

| File | Size | Speed | Quality |
|------|------|-------|---------|
| `ggml-tiny.bin` | 75 MB | Fastest | Basic |
| `ggml-base.bin` | 142 MB | Fast | Good |
| `ggml-small.bin` | 466 MB | Medium | Better |
| `ggml-medium.bin` | 1.5 GB | Slow | High |

Download models from [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp) and place them in `vendor/whispercpp/models/`.

> **Note:** Groq Whisper (cloud) is always used first. Local models are the fallback when Groq is unavailable or files exceed 24 MB.

---

## Craig Bot Integration

[Craig](https://craig.horse) is a Discord bot for recording multi-track audio from voice channels.

**Workflow:**
1. Use Craig to record a Discord call
2. Download the Craig export (a folder with one `.flac` file per participant)
3. In scryb, click **Craig folder** and select the entire export folder
4. scryb transcribes each track separately and labels them by filename

---

## Project Structure

```
scryb/
├── main.js              # Electron entry point — spawns server, creates window
├── server.js            # Express API — job queue, transcription logic, settings
├── loading.html         # Startup screen shown while server boots
├── error.html           # Error screen if server fails to start
├── package.json         # Dependencies + electron-builder config
├── .env                 # GROQ_API_KEY (not committed)
├── public/
│   ├── index.html       # Main UI
│   ├── app.js           # Frontend logic — form, polling, settings modal
│   ├── styles.css       # Dark theme styles
│   ├── logo.svg         # App logo
│   └── favicon.svg      # App icon
├── storage/
│   ├── uploads/         # Multer temp uploads
│   └── jobs.json        # Persisted completed jobs
└── vendor/
    └── whispercpp/
        ├── bin/Release/
        │   └── whisper-cli.exe
        └── models/
            ├── ggml-tiny.bin
            └── ggml-base.bin
```

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron 33 |
| Backend | Node.js + Express 4 |
| File upload | Multer |
| Audio conversion | FFmpeg (ffmpeg-static) |
| Local transcription | whisper.cpp (whisper-cli.exe) |
| Cloud transcription | Groq Whisper Large v3 Turbo |
| Text refinement | Groq Llama 3.1-8b-instant |
| Frontend | Vanilla JS + HTML + CSS |
| Installer | electron-builder (NSIS) |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_API_KEY` | Recommended | Groq API key for Whisper Large + Llama |
| `PORT` | No | HTTP port (default: `3000`) |
| `USER_DATA_PATH` | No | Set automatically by Electron for settings storage |
