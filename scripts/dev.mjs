import { spawn } from "node:child_process";
import net from "node:net";
import electronPath from "electron";
import { createServer } from "vite";

const host = "127.0.0.1";
const preferredPort = Number(process.env.VITE_PORT || 5173);
const port = await findOpenPort(preferredPort);
const devUrl = `http://${host}:${port}`;

const env = { ...process.env, VITE_DEV_SERVER_URL: devUrl };
delete env.ELECTRON_RUN_AS_NODE;

console.log(`Starting Vite on ${devUrl}`);

const vite = await createServer({
  server: {
    host,
    port,
    strictPort: true
  }
});

await vite.listen();
vite.printUrls();

console.log("Starting Electron");
const electron = spawn(electronPath, ["."], {
  env,
  stdio: "inherit",
  windowsHide: false
});

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  vite.close();
  electron.kill();
  process.exit(code);
}

electron.on("exit", (code) => {
  shutdown(code ?? 0);
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function findOpenPort(startPort) {
  for (let candidate = startPort; candidate < startPort + 50; candidate += 1) {
    if (await isPortOpen(candidate)) return candidate;
  }
  throw new Error(`No open port found between ${startPort} and ${startPort + 49}`);
}

function isPortOpen(portToCheck) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(portToCheck, host);
  });
}
