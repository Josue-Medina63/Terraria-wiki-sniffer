import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { startServer } from "./server.js";

const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

let mainWindow;
let apiServer;
let apiBase = "";

async function createWindow() {
  apiServer = await startServer({
    userDataPath: app.getPath("userData"),
    resourcesPath: process.resourcesPath,
    isDev
  });
  apiBase = `http://127.0.0.1:${apiServer.port}`;

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 880,
    minHeight: 620,
    title: "Terraria Wiki Sniffer",
    backgroundColor: "#0b1118",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer process gone:", details);
  });

  if (isDev) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173");
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../../dist/renderer/index.html"));
  }
}

ipcMain.handle("api-base", () => apiBase);

app.whenReady().then(createWindow);

app.on("before-quit", async () => {
  if (apiServer) {
    await apiServer.close();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
