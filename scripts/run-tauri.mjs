import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const localAppData = process.env.LOCALAPPDATA;
const targetDir =
  process.env.CARGO_TARGET_DIR ??
  (localAppData
    ? path.join(localAppData, "HMLHConverter", "cargo-target")
    : path.join(os.tmpdir(), "hmlh-converter-cargo-target"));

mkdirSync(targetDir, { recursive: true });

const tauriBin =
  process.platform === "win32"
    ? path.join(process.cwd(), "node_modules", ".bin", "tauri.cmd")
    : path.join(process.cwd(), "node_modules", ".bin", "tauri");

const child = spawn(tauriBin, args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    CARGO_TARGET_DIR: targetDir,
    CARGO_INCREMENTAL: process.env.CARGO_INCREMENTAL ?? "0",
  },
});

child.on("error", (error) => {
  console.error("Failed to start tauri:", error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
