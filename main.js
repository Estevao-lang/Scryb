const { app, BrowserWindow, Tray, Menu, nativeImage, shell, utilityProcess } = require("electron");
const path = require("path");
const fs = require("fs");
const net = require("net");

const ICON_PATH = path.join(__dirname, "public", "icon.png");

// utilityProcess.fork cannot load files from inside .asar — use the unpacked path
const appDir = __dirname.replace("app.asar", "app.asar.unpacked");

// Find a free TCP port starting from preferred
const getFreePort = (preferred = 3000) =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.listen(preferred, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", () => resolve(getFreePort(preferred + 1)));
  });

let PORT = 3000;
let BASE_URL = `http://localhost:${PORT}`;

// Generate the icon PNG on first run if it doesn't exist yet
if (!fs.existsSync(ICON_PATH)) {
  try { require("./scripts/generate-icon.js"); } catch (e) { /* non-fatal */ }
}

let mainWindow = null;
let tray = null;
let serverProcess = null;
let recorderProcess = null;

// ── Start Express server as a child process ──────────────────

const startServer = () =>
  new Promise((resolve, reject) => {
    // utilityProcess.fork is the correct Electron API for running Node.js scripts
    serverProcess = utilityProcess.fork(path.join(appDir, "server.js"), [], {
      env: { ...process.env, PORT: String(PORT), USER_DATA_PATH: app.getPath("userData"), ELECTRON_APP: "1" },
      stdio: "inherit"
    });

    serverProcess.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Server exited with code ${code}`));
      }
    });

    // Wait 2s before polling — gives Node time to load modules from disk on first launch
    setTimeout(() => {
      // Poll until the server responds
      const check = setInterval(async () => {
        try {
          const res = await fetch(BASE_URL);
          if (res.ok || res.status < 500) {
            clearInterval(check);
            resolve();
          }
        } catch {
          // still starting — keep waiting
        }
      }, 300);

      // Timeout after 60 s — first launch can be slow (opusscript init, disk warm-up)
      setTimeout(() => {
        clearInterval(check);
        reject(new Error("Server did not start in time."));
      }, 58_000);
    }, 2000);
  });

// ── Create the main window ────────────────────────────────────

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 720,
    minHeight: 600,
    title: "scryb",
    icon: ICON_PATH,
    backgroundColor: "#07070f",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    },
    // Frameless feel on Windows — keep default frame for now
    autoHideMenuBar: true
  });

  // Show loading page while server boots
  mainWindow.loadFile(path.join(__dirname, "loading.html"));

  startServer()
    .then(() => {
      mainWindow.loadURL(`${BASE_URL}/`);
    })
    .catch((err) => {
      mainWindow.loadFile(path.join(__dirname, "error.html"));
      console.error("[electron] failed to start server:", err.message);
    });

  mainWindow.on("closed", () => { mainWindow = null; });

  // Open external links in the system browser instead of Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
};

// ── System tray ───────────────────────────────────────────────

const createTray = () => {
  const icon = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("scryb — Audio Transcription");

  const menu = Menu.buildFromTemplate([
    {
      label: "Open scryb",
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        else createWindow();
      }
    },
    { type: "separator" },
    { label: "Quit", role: "quit" }
  ]);

  tray.setContextMenu(menu);
  tray.on("double-click", () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    else createWindow();
  });
};

// ── App lifecycle ─────────────────────────────────────────────

const startRecorder = () => {
  recorderProcess = utilityProcess.fork(path.join(appDir, "recorder.js"), [], {
    env: { ...process.env, USER_DATA_PATH: app.getPath("userData") },
    stdio: "inherit"
  });
  recorderProcess.on("exit", (code) => {
    if (code !== 0) console.error("[electron] recorder exited with code", code);
    recorderProcess = null;
  });
};

// Only one instance allowed — focus existing window if user opens a second
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    PORT = await getFreePort(3000);
    BASE_URL = `http://localhost:${PORT}`;
    createTray();
    createWindow();
    startRecorder();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on("before-quit", () => {
    if (recorderProcess) { recorderProcess.kill("SIGTERM"); recorderProcess = null; }
    if (serverProcess)   { serverProcess.kill("SIGTERM");   serverProcess = null; }
  });
}
