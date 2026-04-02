import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;
const devServerUrl = process.env.ELECTRON_RENDERER_URL ?? "http://127.0.0.1:5173";
const apiBaseUrl = process.env.ELECTRON_API_BASE_URL ?? "http://127.0.0.1:8787";

ipcMain.on("queuemaster:get-runtime-config", (event) => {
  event.returnValue = { apiBaseUrl };
});

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    title: "QueueMaster9000",
    autoHideMenuBar: true,
    backgroundColor: "#09111f",
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    const dashboardIndexPath = path.resolve(__dirname, "../../dashboard/dist/index.html");
    void mainWindow.loadFile(dashboardIndexPath);
  }

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  if (process.env.ELECTRON_OPEN_DEVTOOLS === "true") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

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
