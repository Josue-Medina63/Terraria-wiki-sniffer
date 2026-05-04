import { spawn } from "node:child_process";

const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
const args = process.argv.slice(2);

if (!args.length) {
  console.error("Usage: node scripts/python-runner.mjs <script.py> [...args]");
  process.exit(1);
}

for (const command of candidates) {
  const runArgs = command === "py" ? ["-3", ...args] : args;
  const code = await run(command, runArgs);
  if (code !== "ENOENT") process.exit(code);
}

console.error(`Could not find Python. Tried: ${candidates.join(", ")}`);
process.exit(1);

function run(command, runArgs) {
  return new Promise((resolve) => {
    const child = spawn(command, runArgs, {
      stdio: "inherit",
      windowsHide: true
    });
    child.on("error", (error) => {
      resolve(error.code === "ENOENT" ? "ENOENT" : 1);
    });
    child.on("exit", (code) => {
      resolve(code ?? 0);
    });
  });
}
