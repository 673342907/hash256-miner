import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import net from "node:net";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getBytes, hexlify, toBeHex, zeroPadValue } from "ethers";
import { loadDefaultEnvForCommand } from "./env-loader.mjs";

loadDefaultEnvForCommand("worker");

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MASTER_PUBLIC_HOST = process.env.MASTER_PUBLIC_HOST || process.env.MASTER_HOST || "127.0.0.1";
const DEFAULT_MASTER_PORT = Number(process.env.MASTER_PORT || "7331");
const DEFAULT_RECONNECT_MS = parsePositiveInteger(process.env.RECONNECT_MS, 5000);
const DEFAULT_AGENT_NAME =
  process.env.AGENT_NAME && process.env.AGENT_NAME.toLowerCase() !== "auto"
    ? process.env.AGENT_NAME
    : hostname();
const DEFAULT_GPU_EXECUTABLE = resolveGpuExecutable();
const DEFAULT_GPU_PLATFORM = parseNonNegativeInteger(process.env.GPU_PLATFORM, 0);
const DEFAULT_GPU_DEVICE = parseNonNegativeInteger(process.env.GPU_DEVICE, 0);
const DEFAULT_GPU_GLOBAL_WORK_SIZE = parsePositiveInteger(process.env.GPU_GLOBAL_WORK_SIZE, 1 << 20);
const DEFAULT_GPU_LOCAL_WORK_SIZE = parseNonNegativeInteger(process.env.GPU_LOCAL_WORK_SIZE, 256);
const DEFAULT_GPU_PROGRESS_MS = parsePositiveInteger(process.env.GPU_PROGRESS_MS, 1000);
const DEFAULT_GPU_START_COUNTER = parseBigIntValue(process.env.GPU_START_COUNTER, 0n);

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseBigIntValue(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return BigInt(value);
  } catch {
    return fallback;
  }
}

function now() {
  return new Date().toISOString().replace("T", " ").replace(/\..+/, "");
}

function log(scope, message) {
  console.log(`[${now()}] [${scope}] ${message}`);
}

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function sendJson(socket, payload) {
  socket.write(`${JSON.stringify(payload)}\n`);
}

function attachJsonLineParser(socket, onMessage) {
  let buffer = "";

  socket.on("data", chunk => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        onMessage(JSON.parse(line));
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
}

function attachLineParser(stream, onLine) {
  let buffer = "";

  stream.on("data", chunk => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        onLine(line);
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
}

function toBytes32(value) {
  return getBytes(zeroPadValue(toBeHex(value), 32));
}

function resolveGpuExecutable() {
  const candidates = [
    process.env.GPU_EXECUTABLE ? resolve(ROOT_DIR, process.env.GPU_EXECUTABLE) : null,
    resolve(ROOT_DIR, "gpu-miner", "build", "hash256-gpu-miner"),
    resolve(ROOT_DIR, "gpu-miner", "build", "Release", "hash256-gpu-miner.exe")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function makePrefix(jobSeedHex, agentSlot, threadIndex) {
  const seed = getBytes(jobSeedHex);
  if (seed.length !== 16) {
    throw new Error(`expected 16-byte job seed, got ${seed.length}`);
  }

  const prefix = new Uint8Array(24);
  prefix.set(seed, 0);
  prefix.set(toBytes32(agentSlot).slice(28), 16);
  prefix.set(toBytes32(threadIndex).slice(28), 20);
  return hexlify(prefix);
}

function defaultKernelPath(executablePath) {
  return resolve(dirname(executablePath), "kernels", "keccak_miner.cl");
}

function resolveKernelPath(executablePath) {
  const candidates = [
    process.env.GPU_KERNEL_PATH ? resolve(ROOT_DIR, process.env.GPU_KERNEL_PATH) : null,
    defaultKernelPath(executablePath),
    resolve(ROOT_DIR, "gpu-miner", "kernels", "keccak_miner.cl")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function printHelp() {
  console.log(`Usage:
  node hash256-gpu-worker.mjs

Environment:
  MASTER_PUBLIC_HOST   Master public host or IP used by remote workers
  MASTER_HOST          Backward-compatible alias
  MASTER_PORT          Master port, default 7331
  MASTER_TOKEN         Shared token between master and workers
  AGENT_NAME           Worker display name, default hostname
  RECONNECT_MS         Reconnect delay in ms, default 5000
  GPU_EXECUTABLE       Path to GPU miner binary
  GPU_KERNEL_PATH      Optional explicit OpenCL kernel path
  GPU_PLATFORM         OpenCL platform index, default 0
  GPU_DEVICE           OpenCL device index, default 0
  GPU_GLOBAL_WORK_SIZE Work items per dispatch, default 1048576
  GPU_LOCAL_WORK_SIZE  Local work-group size, default 256, 0 lets the driver choose
  GPU_PROGRESS_MS      GPU progress interval in ms, default 1000
  GPU_START_COUNTER    Optional low 64-bit counter start, default 0

One process controls one GPU device. Start multiple processes for multi-GPU hosts.
`);
}

class GpuWorkerAgent {
  constructor() {
    this.host = DEFAULT_MASTER_PUBLIC_HOST;
    this.port = DEFAULT_MASTER_PORT;
    this.token = process.env.MASTER_TOKEN || "";
    this.agentName = DEFAULT_AGENT_NAME;
    this.reconnectMs = DEFAULT_RECONNECT_MS;
    this.gpuExecutable = DEFAULT_GPU_EXECUTABLE;
    this.gpuKernelPath = resolveKernelPath(this.gpuExecutable);
    this.gpuPlatform = DEFAULT_GPU_PLATFORM;
    this.gpuDevice = DEFAULT_GPU_DEVICE;
    this.gpuGlobalWorkSize = DEFAULT_GPU_GLOBAL_WORK_SIZE;
    this.gpuLocalWorkSize = DEFAULT_GPU_LOCAL_WORK_SIZE;
    this.gpuProgressMs = DEFAULT_GPU_PROGRESS_MS;
    this.gpuStartCounter = DEFAULT_GPU_START_COUNTER;
    this.reportedThreads = 1;
    this.socket = null;
    this.agentId = null;
    this.agentSlot = null;
    this.currentJob = null;
    this.currentPrefixHex = null;
    this.pendingHashes = 0n;
    this.lastHashrate = 0;
    this.lastNextCounter = this.gpuStartCounter;
    this.flushTimer = null;
    this.restartTimer = null;
    this.minerChild = null;
    this.minerChildToken = null;
    this.minerHashesSinceSpawn = 0n;
  }

  validateConfig() {
    if (!existsSync(this.gpuExecutable)) {
      throw new Error(`GPU executable not found: ${this.gpuExecutable}`);
    }
    if (!existsSync(this.gpuKernelPath)) {
      throw new Error(`GPU kernel not found: ${this.gpuKernelPath}`);
    }
  }

  async start() {
    this.validateConfig();
    log(
      "gpu-worker",
      `using ${this.gpuExecutable} platform=${this.gpuPlatform} device=${this.gpuDevice} global=${this.gpuGlobalWorkSize} local=${this.gpuLocalWorkSize}`
    );

    while (true) {
      try {
        await this.connectOnce();
      } catch (error) {
        log("gpu-worker", `connection ended: ${error.message}`);
      }
      this.stopLocalMining();
      log("gpu-worker", `reconnecting in ${this.reconnectMs} ms`);
      await sleep(this.reconnectMs);
    }
  }

  async connectOnce() {
    await new Promise((resolvePromise, rejectPromise) => {
      const socket = net.createConnection(
        {
          host: this.host,
          port: this.port
        },
        () => {
          this.socket = socket;
          log("gpu-worker", `connected to ${this.host}:${this.port}`);
          sendJson(socket, {
            type: "register",
            token: this.token,
            agentName: this.agentName,
            threads: this.reportedThreads
          });
        }
      );

      socket.setNoDelay(true);

      attachJsonLineParser(socket, message => {
        if (message.type === "registered") {
          this.agentId = message.agentId;
          this.agentSlot = Number(message.agentSlot);
          log("gpu-worker", `registered as ${this.agentId}, slot=${this.agentSlot}`);
          return;
        }

        if (message.type === "job") {
          this.startJob(message);
          return;
        }

        if (message.type === "stop") {
          if (this.currentJob && message.jobId === this.currentJob.jobId) {
            log("gpu-worker", `stopping job ${message.jobId}`);
          }
          this.stopLocalMining();
        }
      });

      socket.on("error", rejectPromise);
      socket.on("close", () => {
        rejectPromise(new Error("socket closed"));
      });
    });
  }

  startJob(job) {
    if (!this.agentSlot) {
      return;
    }

    this.stopLocalMining();
    this.currentJob = job;
    this.currentPrefixHex = makePrefix(job.jobSeedHex, this.agentSlot, 0);
    this.pendingHashes = 0n;
    this.lastHashrate = 0;
    this.lastNextCounter = this.gpuStartCounter;

    log(
      "gpu-worker",
      `job=${job.jobId} era=${job.era} epoch=${job.epoch} blocksLeft=${job.epochBlocksLeft} device=${this.gpuDevice}`
    );

    this.launchMiner(this.lastNextCounter);
    this.flushTimer = setInterval(() => {
      this.flushProgress();
    }, 1000);
  }

  launchMiner(startCounter) {
    if (!this.currentJob || !this.currentPrefixHex) {
      return;
    }

    const args = [
      "--challenge",
      this.currentJob.challengeHex,
      "--difficulty",
      this.currentJob.difficultyHex,
      "--prefix",
      this.currentPrefixHex,
      "--kernel",
      this.gpuKernelPath,
      "--platform",
      String(this.gpuPlatform),
      "--device",
      String(this.gpuDevice),
      "--start",
      startCounter.toString(),
      "--global",
      String(this.gpuGlobalWorkSize),
      "--local",
      String(this.gpuLocalWorkSize),
      "--progress-ms",
      String(this.gpuProgressMs)
    ];

    const child = spawn(this.gpuExecutable, args, {
      cwd: dirname(this.gpuExecutable),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const token = Symbol("gpu-miner");

    this.minerChild = child;
    this.minerChildToken = token;
    this.minerHashesSinceSpawn = 0n;

    log("gpu-worker", `started gpu miner pid=${child.pid ?? "n/a"} start=${startCounter.toString()}`);

    attachLineParser(child.stdout, line => {
      this.handleMinerStdout(line);
    });

    attachLineParser(child.stderr, line => {
      this.handleMinerStderr(line);
    });

    child.on("error", error => {
      if (this.minerChildToken !== token) {
        return;
      }
      log("gpu-worker", `gpu miner error: ${error.message}`);
    });

    child.on("close", (code, signal) => {
      if (this.minerChildToken !== token) {
        return;
      }

      this.minerChild = null;
      this.minerChildToken = null;
      this.minerHashesSinceSpawn = 0n;

      if (!this.currentJob) {
        return;
      }

      log("gpu-worker", `gpu miner exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      this.scheduleRestart();
    });
  }

  handleMinerStdout(line) {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      log("gpu-worker", `[miner-stdout] ${line}`);
      return;
    }

    if (payload.type !== "found" || !this.currentJob) {
      return;
    }

    log("gpu-worker", `solution found nonce=${payload.nonceHex}`);
    this.reportFound(payload.nonceHex, payload.resultHex);
  }

  handleMinerStderr(line) {
    const progressMatch = line.match(/hashes=(\d+)\s+rate=([0-9.]+)\s+MH\/s\s+nextCounter=(\d+)/);
    if (progressMatch) {
      const totalHashes = BigInt(progressMatch[1]);
      const hashrate = Number(progressMatch[2]) * 1_000_000;
      const nextCounter = BigInt(progressMatch[3]);
      const hashesDelta = totalHashes - this.minerHashesSinceSpawn;

      if (hashesDelta > 0n) {
        this.pendingHashes += hashesDelta;
      }

      this.minerHashesSinceSpawn = totalHashes;
      this.lastHashrate = hashrate;
      this.lastNextCounter = nextCounter;
      return;
    }

    log("gpu-worker", `[miner] ${line}`);
  }

  flushProgress() {
    if (!this.socket || !this.currentJob) {
      return;
    }

    sendJson(this.socket, {
      type: "progress",
      jobId: this.currentJob.jobId,
      hashesDelta: this.pendingHashes.toString(),
      hashrate: this.lastHashrate
    });

    this.pendingHashes = 0n;
  }

  reportFound(nonceHex, resultHex) {
    if (!this.socket || !this.currentJob) {
      return;
    }

    sendJson(this.socket, {
      type: "found",
      jobId: this.currentJob.jobId,
      nonceHex,
      resultHex
    });

    this.stopMinerProcess();
  }

  scheduleRestart() {
    if (this.restartTimer || !this.currentJob) {
      return;
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.currentJob || this.minerChild) {
        return;
      }
      log("gpu-worker", `restarting gpu miner from counter=${this.lastNextCounter.toString()}`);
      this.launchMiner(this.lastNextCounter);
    }, 1000);
  }

  stopMinerProcess() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const child = this.minerChild;
    this.minerChild = null;
    this.minerChildToken = null;
    this.minerHashesSinceSpawn = 0n;
    this.lastHashrate = 0;

    if (child) {
      child.kill();
    }
  }

  stopLocalMining() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    this.stopMinerProcess();
    this.pendingHashes = 0n;
    this.currentJob = null;
    this.currentPrefixHex = null;
    this.lastNextCounter = this.gpuStartCounter;
  }
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
} else {
  const agent = new GpuWorkerAgent();
  agent.start().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
