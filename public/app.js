const form = document.getElementById("transcription-form");
const mediaInput = document.getElementById("media");
const craigFolderInput = document.getElementById("craig-folder");
const languageSelect = document.getElementById("language");
const outputFormatSelect = document.getElementById("output-format");
const modelSelect = document.getElementById("model");
const speedSelect = document.getElementById("speed");
const resultField = document.getElementById("result");
const statusField = document.getElementById("status");
const selectionSummary = document.getElementById("selection-summary");
const progressCard = document.getElementById("progress-card");
const progressLabel = document.getElementById("progress-label");
const progressPercent = document.getElementById("progress-percent");
const progressFill = document.getElementById("progress-fill");
const progressFiles = document.getElementById("progress-files");
const progressEta = document.getElementById("progress-eta");
const contextInput = document.getElementById("context");
const submitButton = document.getElementById("submit-button");
const copyButton = document.getElementById("copy-button");
const downloadButton = document.getElementById("download-button");
const reportSection     = document.getElementById("report-section");
const reportResult      = document.getElementById("report-result");
const reportCopyBtn     = document.getElementById("report-copy-btn");
const reportDownloadBtn = document.getElementById("report-download-btn");

const supportedExtensions = new Set([".mp3", ".wav", ".flac", ".m4a", ".mp4", ".webm", ".ogg", ".mov", ".m4v"]);
let pollTimer;

const updateStatus = (message, isError = false) => {
  statusField.textContent = message;
  statusField.dataset.error = isError ? "true" : "false";
};

const setResultActions = (enabled) => {
  copyButton.disabled = !enabled;
  downloadButton.disabled = !enabled;
};

const getFileExtension = (name) => {
  const lastDot = name.lastIndexOf(".");
  return lastDot === -1 ? "" : name.slice(lastDot).toLowerCase();
};

const getSelectedEntries = () => {
  const folderFiles = Array.from(craigFolderInput.files || []);
  if (folderFiles.length) {
    return folderFiles
      .filter((file) => supportedExtensions.has(getFileExtension(file.name)))
      .map((file) => ({
        file,
        relativePath: file.webkitRelativePath || file.name,
        source: "craig"
      }));
  }

  return Array.from(mediaInput.files || []).map((file) => ({
    file,
    relativePath: file.name,
    source: "files"
  }));
};

const updateSelectionSummary = () => {
  const entries = getSelectedEntries();

  if (!entries.length) {
    selectionSummary.textContent = "No files selected.";
    return;
  }

  const mode = entries[0].source === "craig" ? "Craig mode" : "Individual files";
  selectionSummary.textContent = `${mode}: ${entries.length} file(s) ready for transcription.`;
};

const formatDuration = (seconds) => {
  if (typeof seconds !== "number" || Number.isNaN(seconds) || seconds < 0) {
    return null;
  }

  const totalSeconds = Math.ceil(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${remainingSeconds}s`;
  }

  return `${minutes}min ${String(remainingSeconds).padStart(2, "0")}s`;
};

const renderProgressFromJob = (job) => {
  progressCard.hidden = false;

  const currentFileLabel = job.currentFile ? `Processing: ${job.currentFile}` : "Preparing transcription...";
  const label = job.status === "completed" ? "Transcription complete" : currentFileLabel;
  const percent = job.status === "completed" ? 100 : Math.max(0, Math.min(99, job.progressPercent || 0));

  progressLabel.textContent = label;
  progressPercent.textContent = `${percent}%`;
  progressFill.style.width = `${percent}%`;
  progressFiles.textContent = `${job.completedFiles || 0} of ${job.totalFiles || 0} files`;

  if (job.status === "completed") {
    progressEta.textContent = "Processing complete.";
  } else if (job.status === "failed") {
    progressEta.textContent = "Processing interrupted.";
  } else {
    const eta = formatDuration(job.remainingSeconds);
    progressEta.textContent = eta ? `Estimated time remaining: ${eta}` : "Estimating time remaining...";
  }
};

const hideProgress = () => {
  clearInterval(pollTimer);
  progressCard.hidden = true;
  progressFill.style.width = "0%";
};

const pollJobUntilFinished = async (jobId) => {
  while (true) {
    const response = await fetch(`/api/transcrever/${jobId}`);
    const job = await response.json();

    if (!response.ok) {
      throw new Error(job.error || "Failed to check transcription progress.");
    }

    renderProgressFromJob(job);

    if (job.status === "completed") {
      return job;
    }

    if (job.status === "failed") {
      throw new Error(job.error || "Failed to transcribe files.");
    }

    await new Promise((resolve) => {
      pollTimer = setTimeout(resolve, 1200);
    });
  }
};

const filesLabel = document.getElementById("files-label");
const craigLabel = document.getElementById("craig-label");
const dropFiles = document.getElementById("drop-files");
const dropCraig = document.getElementById("drop-craig");

mediaInput.addEventListener("change", () => {
  if (mediaInput.files.length) {
    craigFolderInput.value = "";
    craigLabel.textContent = "Click to select";
    dropCraig.classList.remove("has-files");
    filesLabel.textContent = `${mediaInput.files.length} file(s) selected`;
    dropFiles.classList.add("has-files");
  }
  updateSelectionSummary();
});

craigFolderInput.addEventListener("change", () => {
  if (craigFolderInput.files.length) {
    mediaInput.value = "";
    filesLabel.textContent = "Click to select";
    dropFiles.classList.remove("has-files");
    const entries = getSelectedEntries();
    craigLabel.textContent = `${entries.length} audio file(s)`;
    dropCraig.classList.add("has-files");
  }
  updateSelectionSummary();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const entries = getSelectedEntries();

  if (!entries.length) {
    updateStatus("Please select at least one valid file.", true);
    return;
  }

  const body = new FormData();
  for (const entry of entries) {
    body.append("media", entry.file);
    body.append("relativePath", entry.relativePath);
  }
  body.append("language", languageSelect.value);
  body.append("outputFormat", outputFormatSelect.value);
  body.append("model", modelSelect.value);
  body.append("speed", speedSelect.value);
  body.append("context", contextInput.value.trim());

  submitButton.disabled = true;
  setResultActions(false);
  resultField.value = "";
  progressCard.hidden = false;
  renderProgressFromJob({
    status: "queued",
    progressPercent: 0,
    completedFiles: 0,
    totalFiles: entries.length,
    currentFile: null,
    remainingSeconds: null
  });
  updateStatus(`Uploading ${entries.length} file(s) and starting transcription...`);

  try {
    const startResponse = await fetch("/api/transcrever", {
      method: "POST",
      body
    });

    const startData = await startResponse.json();

    if (!startResponse.ok) {
      throw new Error(startData.error || "Falha ao iniciar a transcrição.");
    }

    renderProgressFromJob(startData);
    updateStatus("Transcription started. Track progress in real time.");
    sessionStorage.setItem("activeJobId", startData.jobId);

    const finishedJob = await pollJobUntilFinished(startData.jobId);
    resultField.value = finishedJob.resultText || "";
    renderProgressFromJob(finishedJob);
    updateStatus(`${finishedJob.totalFiles} file(s) transcribed successfully.`);
    setResultActions(Boolean(resultField.value));
    showReport(finishedJob.report);
    sessionStorage.removeItem("activeJobId");
  } catch (error) {
    hideProgress();
    updateStatus(error.message, true);
    sessionStorage.removeItem("activeJobId");
  } finally {
    clearTimeout(pollTimer);
    submitButton.disabled = false;
  }
});

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(resultField.value);
  updateStatus("Text copied.");
});

downloadButton.addEventListener("click", () => {
  const blob = new Blob([resultField.value], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = "transcriptions.txt";
  anchor.click();

  URL.revokeObjectURL(url);
  updateStatus(".txt file downloaded.");
});

updateSelectionSummary();
hideProgress();

// ── Report ────────────────────────────────────────────────────

const showReport = (reportText) => {
  if (!reportText) { reportSection.hidden = true; return; }
  reportResult.value = reportText;
  reportSection.hidden = false;
};

reportCopyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(reportResult.value);
  const orig = reportCopyBtn.innerHTML;
  reportCopyBtn.textContent = "✓ Copied!";
  setTimeout(() => { reportCopyBtn.innerHTML = orig; }, 1500);
});

reportDownloadBtn.addEventListener("click", () => {
  const date = new Date().toISOString().slice(0, 10);
  const blob = new Blob([reportResult.value], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `scryb-report-${date}.md`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── Tab switcher ──────────────────────────────────────────────

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => { p.hidden = true; p.classList.remove("active"); });
    btn.classList.add("active");
    const panel = document.getElementById(`tab-${btn.dataset.tab}`);
    panel.hidden = false;
    panel.classList.add("active");
  });
});

// ── Tutorial modal ────────────────────────────────────────────

const helpBtn         = document.getElementById("help-btn");
const tutorialOverlay = document.getElementById("tutorial-overlay");
const tutorialClose   = document.getElementById("tutorial-close");

helpBtn.addEventListener("click", () => { tutorialOverlay.hidden = false; });
tutorialClose.addEventListener("click", () => { tutorialOverlay.hidden = true; });
tutorialOverlay.addEventListener("click", (e) => { if (e.target === tutorialOverlay) tutorialOverlay.hidden = true; });

// ── Settings modal ────────────────────────────────────────────

const settingsOverlay  = document.getElementById("settings-overlay");
const settingsClose    = document.getElementById("settings-close");
const settingsBtn      = document.getElementById("settings-btn");
const settingsSave     = document.getElementById("settings-save");
const groqKeyInput     = document.getElementById("groq-key-input");
const keyToggle        = document.getElementById("key-toggle");
const keyStatus        = document.getElementById("key-status");
const setupBanner      = document.getElementById("setup-banner");
const bannerOpenBtn    = document.getElementById("banner-open-settings");

const openSettings = () => { settingsOverlay.hidden = false; groqKeyInput.focus(); };
const closeSettings = () => { settingsOverlay.hidden = true; keyStatus.textContent = ""; keyStatus.className = "key-status"; };

settingsBtn.addEventListener("click", openSettings);
bannerOpenBtn.addEventListener("click", openSettings);
settingsClose.addEventListener("click", closeSettings);
settingsOverlay.addEventListener("click", (e) => { if (e.target === settingsOverlay) closeSettings(); });

keyToggle.addEventListener("click", () => {
  groqKeyInput.type = groqKeyInput.type === "password" ? "text" : "password";
});

settingsSave.addEventListener("click", async () => {
  const key = groqKeyInput.value.trim();

  if (!key) {
    keyStatus.textContent = "Paste your Groq API key to save.";
    keyStatus.className = "key-status error";
    return;
  }

  settingsSave.disabled = true;
  keyStatus.textContent = "Saving...";
  keyStatus.className = "key-status";

  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groqApiKey: key })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed to save.");

    keyStatus.textContent = "Saved successfully!";
    keyStatus.className = "key-status ok";
    setupBanner.hidden = true;
    groqKeyInput.value = "";
    setTimeout(closeSettings, 1200);
  } catch (err) {
    keyStatus.textContent = err.message || "Failed to save. Please try again.";
    keyStatus.className = "key-status error";
  } finally {
    settingsSave.disabled = false;
  }
});

// ── Onboarding ───────────────────────────────────────────────
const onboardingOverlay = document.getElementById("onboarding-overlay");

const showObStep = (n) => {
  document.querySelectorAll(".ob-step").forEach((el, i) => {
    el.hidden = i !== n;
    if (i === n) el.classList.add("active");
    else el.classList.remove("active");
  });
};

const saveObSettings = async (groqApiKey, discordBotToken) => {
  const body = {};
  if (groqApiKey) body.groqApiKey = groqApiKey;
  if (discordBotToken) body.discordBotToken = discordBotToken;
  if (Object.keys(body).length === 0) return;
  await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
};

const finishOnboarding = () => {
  localStorage.setItem("scryb_onboarded", "1");
  onboardingOverlay.hidden = true;
  fetch("/api/settings").then(r => r.json()).then(s => {
    if (!s.hasGroqKey) setupBanner.hidden = false;
    document.getElementById("recorder-no-token").hidden = s.hasDiscordToken;
  }).catch(() => {});
};

// Step 0 → 1
document.querySelector("[data-next='1']").addEventListener("click", () => showObStep(1));

// Step 1 toggles
document.getElementById("ob-groq-toggle").addEventListener("click", () => {
  const inp = document.getElementById("ob-groq-input");
  inp.type = inp.type === "password" ? "text" : "password";
});

// Step 1 save
document.getElementById("ob-groq-save").addEventListener("click", async () => {
  const key = document.getElementById("ob-groq-input").value.trim();
  const status = document.getElementById("ob-groq-status");
  if (!key) { status.textContent = "Please paste your API key."; status.className = "ob-status error"; return; }
  if (!key.startsWith("gsk_")) { status.textContent = "Groq keys start with gsk_"; status.className = "ob-status error"; return; }
  status.textContent = "Saving..."; status.className = "ob-status";
  await saveObSettings(key, null);
  status.textContent = "✓ Saved!"; status.className = "ob-status";
  const s = await fetch("/api/settings").then(r => r.json()).catch(() => ({}));
  setTimeout(() => s.hasDiscordToken ? finishOnboarding() : showObStep(2), 600);
});

// Step 1 skip
document.getElementById("ob-groq-skip").addEventListener("click", async () => {
  const s = await fetch("/api/settings").then(r => r.json()).catch(() => ({}));
  if (s.hasDiscordToken) { finishOnboarding(); } else { showObStep(2); }
});

// Step 2 toggles
document.getElementById("ob-discord-toggle").addEventListener("click", () => {
  const inp = document.getElementById("ob-discord-input");
  inp.type = inp.type === "password" ? "text" : "password";
});

// Step 2 save
document.getElementById("ob-discord-save").addEventListener("click", async () => {
  const token = document.getElementById("ob-discord-input").value.trim();
  const status = document.getElementById("ob-discord-status");
  if (token) {
    status.textContent = "Saving..."; status.className = "ob-status";
    await saveObSettings(null, token);
    status.textContent = "✓ Saved!"; status.className = "ob-status";
    await new Promise(r => setTimeout(r, 500));
  }
  finishOnboarding();
});

// Step 2 skip
document.getElementById("ob-discord-skip").addEventListener("click", finishOnboarding);

const addBotBtn = document.getElementById("add-bot-btn");
let botInviteUrl = "https://discord.com/oauth2/authorize?client_id=1497296876565954561&scope=bot&permissions=3145728";

addBotBtn.addEventListener("click", () => {
  if (!botInviteUrl) return;
  if (window.electronAPI) {
    window.electronAPI.openExternal(botInviteUrl);
  } else {
    window.open(botInviteUrl, "_blank");
  }
});

// Check on load — show onboarding or banner
fetch("/api/settings")
  .then((r) => r.json())
  .then((s) => {
    // Hide Record tab on cloud deployments (no recorder process)
    if (s.recorderAvailable === false) {
      document.querySelector('[data-tab="record"]').hidden = true;
    }

    // Show "Add bot to server" button if client ID is available
    if (s.discordClientId) {
      botInviteUrl = `https://discord.com/oauth2/authorize?client_id=${s.discordClientId}&scope=bot&permissions=3145728`;
      addBotBtn.hidden = false;
    }

    const onboarded = localStorage.getItem("scryb_onboarded");
    if (!onboarded && !s.hasGroqKey) {
      onboardingOverlay.hidden = false;
      showObStep(0);
    } else {
      if (!s.hasGroqKey) setupBanner.hidden = false;
      // Only show "no token" warning if token is truly missing (not pre-bundled)
      if (!s.hasDiscordToken && s.recorderAvailable !== false) {
        document.getElementById("recorder-no-token").hidden = false;
      }
    }
  })
  .catch(() => {});

document.getElementById("open-settings-from-rec").addEventListener("click", openSettings);

// ── Record tab logic ──────────────────────────────────────────

const startRecordBtn   = document.getElementById("start-record-btn");
const stopRecordBtn    = document.getElementById("stop-record-btn");
const recordSetup      = document.getElementById("record-setup");
const recordLive       = document.getElementById("record-live");
const recTimer         = document.getElementById("rec-timer");
const recParticipants  = document.getElementById("rec-participants");
const recProgressCard  = document.getElementById("rec-progress-card");
const recProgressLabel = document.getElementById("rec-progress-label");
const recProgressPct   = document.getElementById("rec-progress-percent");
const recProgressFill  = document.getElementById("rec-progress-fill");
const recProgressFiles = document.getElementById("rec-progress-files");
const recProgressEta   = document.getElementById("rec-progress-eta");
const recStatusEl      = document.getElementById("rec-status");
const recResultSection = document.getElementById("rec-result-section");
const recResultField   = document.getElementById("rec-result");
const recCopyBtn       = document.getElementById("rec-copy-btn");
const recDownloadBtn   = document.getElementById("rec-download-btn");

let recTimerInterval = null;
let recPollTimer     = null;

const formatHMS = (ms) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
};

const updateRecParticipants = (participants = []) => {
  recParticipants.innerHTML = participants.length
    ? participants.map(({ username }) => `<div class="rec-participant"><span class="p-dot"></span>${username}</div>`).join("")
    : '<span style="color:var(--muted);font-size:0.83rem">Waiting for participants to speak...</span>';
};

const pollRecorderStatus = async () => {
  try {
    const res = await fetch("/api/recorder/status");
    const data = await res.json();
    if (data.connected) {
      updateRecParticipants(data.participants);
      recTimer.textContent = data.durationLabel || "00:00:00";
    }
  } catch { /* recorder might not be ready yet */ }
};

startRecordBtn.addEventListener("click", async () => {
  const guildId = document.getElementById("guild-id").value.trim();
  const channelId = document.getElementById("channel-id").value.trim();
  if (!guildId || !channelId) {
    recStatusEl.textContent = "Please enter Guild ID and Channel ID.";
    recStatusEl.dataset.error = "true";
    return;
  }

  startRecordBtn.disabled = true;
  recStatusEl.textContent = "Connecting to Discord...";
  recStatusEl.dataset.error = "false";

  try {
    const res = await fetch("/api/recorder/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guildId, channelId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to start recording.");

    recStatusEl.textContent = `Connected to #${data.channelName}`;
    recordSetup.hidden = true;
    recordLive.hidden = false;
    recResultSection.style.display = "none";
    updateRecParticipants([]);

    const startMs = Date.now();
    recTimerInterval = setInterval(() => { recTimer.textContent = formatHMS(Date.now() - startMs); }, 1000);
    recPollTimer = setInterval(pollRecorderStatus, 2000);
  } catch (err) {
    recStatusEl.textContent = err.message;
    recStatusEl.dataset.error = "true";
    startRecordBtn.disabled = false;
  }
});

stopRecordBtn.addEventListener("click", async () => {
  stopRecordBtn.disabled = true;
  clearInterval(recTimerInterval);
  clearInterval(recPollTimer);
  recStatusEl.textContent = "Stopping recording...";
  recStatusEl.dataset.error = "false";

  const language = document.getElementById("rec-language").value;
  const context  = document.getElementById("rec-context").value.trim();

  try {
    const res = await fetch("/api/recorder/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language, context })
    });
    const data = await res.json();

    recordLive.hidden = true;
    recordSetup.hidden = false;
    startRecordBtn.disabled = false;
    stopRecordBtn.disabled = false;

    if (!data.jobId) {
      recStatusEl.textContent = data.message || "No audio recorded.";
      return;
    }

    // Poll the transcription job
    recProgressCard.hidden = false;
    recStatusEl.textContent = "Transcribing recording...";

    let pollHandle;
    const pollJob = async () => {
      const jr = await fetch(`/api/transcrever/${data.jobId}`);
      const job = await jr.json();

      const pct = job.status === "completed" ? 100 : Math.max(0, Math.min(99, job.progressPercent || 0));
      recProgressLabel.textContent = job.status === "completed" ? "Transcription complete" : `Transcribing: ${job.currentFile || "..."}`;
      recProgressPct.textContent   = `${pct}%`;
      recProgressFill.style.width  = `${pct}%`;
      recProgressFiles.textContent = `${job.completedFiles} of ${job.totalFiles} tracks`;
      recProgressEta.textContent   = job.remainingSeconds ? `~${formatDuration(job.remainingSeconds * 1000)} remaining` : "";

      if (job.status === "completed") {
        recResultField.value = job.resultText || "";
        recResultSection.style.display = "";
        recStatusEl.textContent = `${job.totalFiles} track(s) transcribed.`;
        recProgressCard.hidden = true;
        return;
      }
      if (job.status === "failed") {
        recStatusEl.textContent = job.error || "Transcription failed.";
        recStatusEl.dataset.error = "true";
        recProgressCard.hidden = true;
        return;
      }
      pollHandle = setTimeout(pollJob, 1200);
    };
    await pollJob();
  } catch (err) {
    recStatusEl.textContent = err.message;
    recStatusEl.dataset.error = "true";
    stopRecordBtn.disabled = false;
  }
});

recCopyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(recResultField.value);
  recStatusEl.textContent = "Text copied.";
});

recDownloadBtn.addEventListener("click", () => {
  const blob = new Blob([recResultField.value], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "recording-transcription.txt"; a.click();
  URL.revokeObjectURL(url);
});

// Resume job if page was reloaded during transcription
const savedJobId = sessionStorage.getItem("activeJobId");
if (savedJobId) {
  submitButton.disabled = true;
  updateStatus("Resuming active transcription...");
  pollJobUntilFinished(savedJobId)
    .then((job) => {
      resultField.value = job.resultText || "";
      renderProgressFromJob(job);
      updateStatus(`${job.totalFiles} file(s) transcribed successfully.`);
      setResultActions(Boolean(resultField.value));
      sessionStorage.removeItem("activeJobId");
    })
    .catch((err) => {
      hideProgress();
      updateStatus(err.message, true);
      sessionStorage.removeItem("activeJobId");
    })
    .finally(() => { submitButton.disabled = false; });
}

// ── Histórico tab ─────────────────────────────────────────

const historyList  = document.getElementById("history-list");
const historyEmpty = document.getElementById("history-empty");
let historyData = {};

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const histSourceLabels = { craig: "Craig folder", files: "Individual files", recorder: "Discord recording" };
const histLangLabels   = { portuguese: "Português", english: "English", spanish: "Español" };

const histFormatDate = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" })
    + " às " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
};

const renderHistory = (entries) => {
  historyData = {};
  entries.forEach(e => { historyData[e.id] = e; });

  if (!entries.length) {
    historyList.innerHTML = "";
    historyEmpty.hidden = false;
    return;
  }
  historyEmpty.hidden = true;

  historyList.innerHTML = entries.map(e => {
    const ok = e.status === "completed";
    const badge = ok
      ? '<span class="hist-badge hist-badge--ok">concluído</span>'
      : '<span class="hist-badge hist-badge--error">erro</span>';
    const hasText = ok && e.resultText && e.resultText.trim();
    const files = `${e.totalFiles} arquivo${e.totalFiles !== 1 ? "s" : ""}`;

    return `<div class="hist-card">
      <div class="hist-meta">
        <div class="hist-info">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span>${files} · ${histLangLabels[e.language] || e.language} · ${histSourceLabels[e.source] || e.source}</span>
        </div>
        <div class="hist-right">
          <span class="hist-date">${histFormatDate(e.createdAt)}</span>
          ${badge}
          ${hasText ? `<button class="hist-toggle" data-id="${e.id}" aria-expanded="false">▸ ver</button>` : ""}
        </div>
      </div>
      <div class="hist-body" id="hist-body-${e.id}" hidden>
        <pre class="hist-text">${escapeHtml(e.resultText)}</pre>
        <div class="hist-actions">
          <button class="hist-copy" data-id="${e.id}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy
          </button>
          <button class="hist-download" data-id="${e.id}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download .txt
          </button>
        </div>
      </div>
    </div>`;
  }).join("");
};

historyList.addEventListener("click", (e) => {
  const toggle = e.target.closest(".hist-toggle");
  if (toggle) {
    const id = toggle.dataset.id;
    const body = document.getElementById(`hist-body-${id}`);
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    toggle.textContent = expanded ? "▸ ver" : "▾ fechar";
    body.hidden = expanded;
    return;
  }

  const copyBtn = e.target.closest(".hist-copy");
  if (copyBtn) {
    const entry = historyData[copyBtn.dataset.id];
    if (!entry) return;
    navigator.clipboard.writeText(entry.resultText);
    const orig = copyBtn.innerHTML;
    copyBtn.textContent = "✓ Copiado!";
    setTimeout(() => { copyBtn.innerHTML = orig; }, 1500);
    return;
  }

  const dlBtn = e.target.closest(".hist-download");
  if (dlBtn) {
    const entry = historyData[dlBtn.dataset.id];
    if (!entry) return;
    const date = new Date(entry.createdAt || Date.now()).toISOString().slice(0, 10);
    const blob = new Blob([entry.resultText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `scryb-${date}.txt`; a.click();
    URL.revokeObjectURL(url);
  }
});

document.querySelector('[data-tab="historico"]').addEventListener("click", async () => {
  historyList.innerHTML = '<p class="hist-loading">Carregando...</p>';
  historyEmpty.hidden = true;
  try {
    const res = await fetch("/api/historico");
    renderHistory(await res.json());
  } catch {
    historyList.innerHTML = '<p style="color:var(--error);padding:16px 0">Erro ao carregar histórico.</p>';
  }
});

// Load available models from server
fetch("/api/modelos")
  .then((r) => r.json())
  .then((models) => {
    modelSelect.innerHTML = "";
    for (const m of models) {
      const option = document.createElement("option");
      option.value = m.file;
      option.textContent = m.label;
      modelSelect.appendChild(option);
    }
    if (!models.length) {
      const option = document.createElement("option");
      option.value = "ggml-tiny.bin";
      option.textContent = "Tiny (75 MB)";
      modelSelect.appendChild(option);
    }
  })
  .catch(() => {
    modelSelect.innerHTML = '<option value="ggml-tiny.bin">Tiny (75 MB)</option>';
  });
