const path = require("node:path");
const os = require("node:os");
const { cp, mkdir, readFile, rm, stat, writeFile } = require("node:fs/promises");
const { execFile: execFileCallback } = require("node:child_process");
const { app, BrowserWindow, ipcMain } = require("electron");
const { promisify } = require("node:util");

const execFile = promisify(execFileCallback);

const devServerUrl = process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173";
const apiBaseUrl = process.env.ELECTRON_API_BASE_URL ?? "http://localhost:8787";
const useDevServer = process.env.ELECTRON_USE_DEV_SERVER === "true";
const dashboardIndexPath = path.resolve(__dirname, "../../dashboard/dist/index.html");

let mainWindow = null;
let servicesWindow = null;

const SERVICE_LABELS = {
  agent: "com.queuemaster9000.agent",
  server: "com.queuemaster9000.server"
};

function getDesktopRuntimeDir() {
  return path.resolve(__dirname, "../runtime");
}

function getUserPaths() {
  const appSupportDir = path.join(app.getPath("appData"), "QueueMaster9000");
  return {
    appSupportDir,
    runtimeDir: path.join(appSupportDir, "runtime"),
    logDir: path.join(appSupportDir, "logs"),
    launchAgentsDir: path.join(os.homedir(), "Library", "LaunchAgents")
  };
}

function getServicePaths(serviceName) {
  const userPaths = getUserPaths();
  const label = SERVICE_LABELS[serviceName];
  return {
    label,
    runtimeScriptPath: path.join(userPaths.runtimeDir, `${serviceName}.mjs`),
    plistPath: path.join(userPaths.launchAgentsDir, `${label}.plist`),
    stdoutPath: path.join(userPaths.logDir, `${serviceName}.log`),
    stderrPath: path.join(userPaths.logDir, `${serviceName}.error.log`)
  };
}

async function fileExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureRuntimeInstalled() {
  const sourceRuntimeDir = getDesktopRuntimeDir();
  const userPaths = getUserPaths();
  const hasAgentBundle = await fileExists(path.join(sourceRuntimeDir, "agent.mjs"));
  const hasServerBundle = await fileExists(path.join(sourceRuntimeDir, "server.mjs"));

  if (!hasAgentBundle || !hasServerBundle) {
    throw new Error(
      "Desktop runtime bundles are missing. Run `npm run build:desktop` before installing services."
    );
  }

  await mkdir(userPaths.runtimeDir, { recursive: true });
  await mkdir(userPaths.logDir, { recursive: true });
  await mkdir(userPaths.launchAgentsDir, { recursive: true });
  await cp(sourceRuntimeDir, userPaths.runtimeDir, { recursive: true, force: true });
}

function plistContent({ label, runtimeScriptPath, stdoutPath, stderrPath, environmentVariables }) {
  const envEntries = Object.entries({
    ELECTRON_RUN_AS_NODE: "1",
    ...environmentVariables
  })
    .map(
      ([key, value]) => `    <key>${key}</key>\n    <string>${String(value)}</string>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${runtimeScriptPath}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${stdoutPath}</string>
  <key>StandardErrorPath</key>
  <string>${stderrPath}</string>
</dict>
</plist>
`;
}

async function launchctl(...args) {
  const uid = String(process.getuid());
  return execFile("launchctl", args.map((arg) => arg.replace("$UID", uid)));
}

async function bootoutIfLoaded(label, plistPath) {
  try {
    await launchctl("bootout", "gui/$UID", plistPath);
  } catch {
    try {
      await launchctl("remove", label);
    } catch {
      // Ignore if the service was not loaded yet.
    }
  }
}

async function serviceRunning(label) {
  try {
    await launchctl("print", `gui/${process.getuid()}/${label}`);
    return true;
  } catch {
    return false;
  }
}

async function readTail(filePath) {
  if (!(await fileExists(filePath))) {
    return "";
  }

  const content = await readFile(filePath, "utf8");
  return content.split(/\r?\n/).slice(-20).join("\n").trim();
}

async function getServiceStatus(serviceName) {
  const { label, plistPath, stdoutPath, stderrPath, runtimeScriptPath } = getServicePaths(serviceName);
  return {
    label,
    installed: await fileExists(plistPath),
    running: await serviceRunning(label),
    plistPath,
    runtimeScriptPath,
    stdoutPath,
    stderrPath,
    recentStdout: await readTail(stdoutPath),
    recentStderr: await readTail(stderrPath)
  };
}

async function installService(serviceName, options = {}) {
  await ensureRuntimeInstalled();
  const { label, plistPath, runtimeScriptPath, stdoutPath, stderrPath } = getServicePaths(serviceName);

  const environmentVariables =
    serviceName === "agent"
      ? {
          API_BASE_URL: options.apiBaseUrl ?? apiBaseUrl,
          POLL_INTERVAL_MS: options.pollIntervalMs ?? 10000
        }
      : {
          PORT: options.port ?? 8787
        };

  const plist = plistContent({
    label,
    runtimeScriptPath,
    stdoutPath,
    stderrPath,
    environmentVariables
  });

  await writeFile(plistPath, plist, "utf8");
  await bootoutIfLoaded(label, plistPath);
  await launchctl("bootstrap", "gui/$UID", plistPath);
  await launchctl("kickstart", "-k", `gui/${process.getuid()}/${label}`);
  return getServiceStatus(serviceName);
}

async function uninstallService(serviceName) {
  const { label, plistPath } = getServicePaths(serviceName);
  await bootoutIfLoaded(label, plistPath);
  if (await fileExists(plistPath)) {
    await rm(plistPath, { force: true });
  }
  return getServiceStatus(serviceName);
}

ipcMain.on("queuemaster:get-runtime-config", (event) => {
  event.returnValue = { apiBaseUrl };
});

ipcMain.handle("queuemaster:services:status", async () => ({
  agent: await getServiceStatus("agent"),
  server: await getServiceStatus("server")
}));

ipcMain.handle("queuemaster:services:install-agent", async (_event, options) =>
  installService("agent", options)
);

ipcMain.handle("queuemaster:services:install-server", async (_event, options) =>
  installService("server", options)
);

ipcMain.handle("queuemaster:services:uninstall-agent", async () => uninstallService("agent"));
ipcMain.handle("queuemaster:services:uninstall-server", async () => uninstallService("server"));

function loadRenderer(window, search = "") {
  if (useDevServer) {
    const url = new URL(devServerUrl);
    url.search = search;
    return window.loadURL(url.toString());
  }

  return window.loadFile(dashboardIndexPath, search ? { search } : undefined);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    title: "QueueMaster9000",
    autoHideMenuBar: true,
    backgroundColor: "#09111f",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  void loadRenderer(mainWindow);

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.on("closed", () => {
    mainWindow = null;
    if (servicesWindow && !servicesWindow.isDestroyed()) {
      servicesWindow.close();
    }
  });

  if (process.env.ELECTRON_OPEN_DEVTOOLS === "true") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

function openServicesWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (servicesWindow && !servicesWindow.isDestroyed()) {
    servicesWindow.focus();
    return;
  }

  servicesWindow = new BrowserWindow({
    width: 600,
    height: 760,
    minWidth: 600,
    maxWidth: 600,
    minHeight: 620,
    title: "QueueMaster9000 Local Services",
    alwaysOnTop: true,
    autoHideMenuBar: true,
    parent: mainWindow,
    backgroundColor: "#09111f",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  servicesWindow.setAlwaysOnTop(true);
  void loadRenderer(servicesWindow, "?window=services");
  servicesWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  servicesWindow.on("closed", () => {
    servicesWindow = null;
  });

  if (process.env.ELECTRON_OPEN_DEVTOOLS === "true") {
    servicesWindow.webContents.openDevTools({ mode: "detach" });
  }
}

ipcMain.handle("queuemaster:windows:open-services", async () => {
  openServicesWindow();
});

app.whenReady().then(() => {
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
