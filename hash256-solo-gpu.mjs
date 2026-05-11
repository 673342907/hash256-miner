import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { loadDefaultEnvForCommand } from "./env-loader.mjs";

loadDefaultEnvForCommand("solo-gpu");

const SOLO_ENV_PATH = resolve(process.env.SOLO_GPU_ENV_PATH || ".env.solo-gpu");
const MASTER_ENV_PATH = resolve(process.env.MASTER_ENV_PATH || ".env.master");
const WORKER_ENV_PATH = resolve(process.env.WORKER_ENV_PATH || ".env.worker");

function parseEnvFile(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const index = line.indexOf("=");
    if (index <= 0) {
      continue;
    }
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return result;
}

function readEnvFile(path) {
  if (!existsSync(path)) {
    return {};
  }
  return parseEnvFile(readFileSync(path, "utf8"));
}

function writeEnvFile(path, values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

function now() {
  return new Date().toISOString().replace("T", " ").replace(/\..+/, "");
}

function log(scope, message) {
  console.log(`[${now()}] [${scope}] ${message}`);
}

function withDefault(value, fallback) {
  return value && value.length > 0 ? value : fallback;
}

function ensureConfigFiles() {
  const solo = readEnvFile(SOLO_ENV_PATH);
  const privateKey = process.env.PRIVATE_KEY || solo.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(`missing PRIVATE_KEY in ${SOLO_ENV_PATH}`);
  }

  const masterToken = withDefault(process.env.MASTER_TOKEN || solo.MASTER_TOKEN, randomBytes(24).toString("hex"));
  const rpcUrl = withDefault(process.env.RPC_URL || solo.RPC_URL, "https://ethereum-rpc.publicnode.com");
  const masterPort = withDefault(process.env.MASTER_PORT || solo.MASTER_PORT, "7331");
  const minGasBalance = withDefault(process.env.MIN_GAS_BALANCE || solo.MIN_GAS_BALANCE, "0.001");
  const agentName = withDefault(process.env.AGENT_NAME || solo.AGENT_NAME, "gpu-4090");
  const gpuExecutable = withDefault(
    process.env.GPU_EXECUTABLE || solo.GPU_EXECUTABLE,
    "gpu-miner/build/hash256-gpu-miner"
  );

  const masterEnv = {
    RPC_URL: rpcUrl,
    MASTER_BIND_HOST: withDefault(process.env.MASTER_BIND_HOST || solo.MASTER_BIND_HOST, "127.0.0.1"),
    MASTER_PUBLIC_HOST: withDefault(process.env.MASTER_PUBLIC_HOST || solo.MASTER_PUBLIC_HOST, "127.0.0.1"),
    MASTER_PORT: masterPort,
    MASTER_TOKEN: masterToken,
    PRIVATE_KEY: privateKey,
    MIN_GAS_BALANCE: minGasBalance
  };

  const workerEnv = {
    MASTER_HOST: withDefault(process.env.MASTER_HOST || solo.MASTER_HOST, "127.0.0.1"),
    MASTER_PUBLIC_HOST: withDefault(process.env.MASTER_PUBLIC_HOST || solo.MASTER_PUBLIC_HOST, "127.0.0.1"),
    MASTER_PORT: masterPort,
    MASTER_TOKEN: masterToken,
    AGENT_NAME: agentName,
    WORKER_RUNTIME: "gpu",
    GPU_EXECUTABLE: gpuExecutable,
    GPU_PLATFORM: withDefault(process.env.GPU_PLATFORM || solo.GPU_PLATFORM, "0"),
    GPU_DEVICE: withDefault(process.env.GPU_DEVICE || solo.GPU_DEVICE, "0"),
    GPU_GLOBAL_WORK_SIZE: withDefault(process.env.GPU_GLOBAL_WORK_SIZE || solo.GPU_GLOBAL_WORK_SIZE, "4194304"),
    GPU_LOCAL_WORK_SIZE: withDefault(process.env.GPU_LOCAL_WORK_SIZE || solo.GPU_LOCAL_WORK_SIZE, "256"),
    GPU_PROGRESS_MS: withDefault(process.env.GPU_PROGRESS_MS || solo.GPU_PROGRESS_MS, "1000")
  };

  if (process.env.GPU_KERNEL_PATH || solo.GPU_KERNEL_PATH) {
    workerEnv.GPU_KERNEL_PATH = process.env.GPU_KERNEL_PATH || solo.GPU_KERNEL_PATH;
  }

  writeEnvFile(MASTER_ENV_PATH, masterEnv);
  writeEnvFile(WORKER_ENV_PATH, workerEnv);

  return { masterEnv, workerEnv };
}

function spawnManaged(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv
    }
  });

  child.on("exit", (code, signal) => {
    log(name, `exited code=${code ?? "null"} signal=${signal ?? "null"}`);
  });

  return child;
}

async function main() {
  const { masterEnv, workerEnv } = ensureConfigFiles();
  const gpuExecutablePath = resolve(workerEnv.GPU_EXECUTABLE);
  if (!existsSync(gpuExecutablePath)) {
    throw new Error(`GPU executable not found: ${gpuExecutablePath}`);
  }

  log("solo-gpu", `master config written to ${MASTER_ENV_PATH}`);
  log("solo-gpu", `worker config written to ${WORKER_ENV_PATH}`);
  log("solo-gpu", `wallet rewards will go to the address derived from PRIVATE_KEY in ${SOLO_ENV_PATH}`);

  const master = spawnManaged("master", process.execPath, ["hash256-mine.mjs", "master"], masterEnv);
  let worker = null;

  const shutdown = signal => {
    log("solo-gpu", `received ${signal}, shutting down`);
    master.kill();
    if (worker && !worker.killed) {
      worker.kill();
    }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await new Promise(resolvePromise => setTimeout(resolvePromise, 2000));

  worker = spawnManaged("gpu-worker", process.execPath, ["hash256-gpu-worker.mjs"], workerEnv);

  await Promise.race([
    new Promise(resolvePromise => master.on("exit", resolvePromise)),
    new Promise(resolvePromise => worker.on("exit", resolvePromise))
  ]);

  if (!master.killed) {
    master.kill();
  }
  if (!worker.killed) {
    worker.kill();
  }
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
