import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { cpus, hostname } from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  concat,
  formatEther,
  getBytes,
  hexlify,
  keccak256,
  parseEther,
  randomBytes,
  toBeHex,
  zeroPadValue
} from "ethers";

const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const WALLET_PATH = process.env.WALLET_PATH || "./hash256-wallet.json";
const DEFAULT_RPC_URL = process.env.RPC_URL || "https://ethereum-rpc.publicnode.com";
const DEFAULT_MASTER_BIND_HOST = process.env.MASTER_BIND_HOST || process.env.MASTER_HOST || "0.0.0.0";
const DEFAULT_MASTER_PUBLIC_HOST = process.env.MASTER_PUBLIC_HOST || process.env.MASTER_HOST || "127.0.0.1";
const DEFAULT_MASTER_PORT = Number(process.env.MASTER_PORT || "7331");
const DEFAULT_MIN_GAS_BALANCE = process.env.MIN_GAS_BALANCE || "0.001";
const DEFAULT_POLL_MS = Number(process.env.POLL_MS || "12000");
const DEFAULT_OPEN_CHECK_MS = Number(process.env.OPEN_CHECK_MS || "30000");
const DEFAULT_STATUS_MS = Number(process.env.STATUS_MS || "5000");
const DEFAULT_RECONNECT_MS = Number(process.env.RECONNECT_MS || "5000");
function parseBatchSize(value) {
  if (!value || value.toLowerCase() === "auto") {
    return 1_000_000n;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1_000_000n;
  }

  return BigInt(Math.floor(parsed));
}

const DEFAULT_BATCH_SIZE = parseBatchSize(process.env.BATCH_SIZE);

function parseInnerLoops(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 8;
  }
  return Math.min(256, Math.floor(parsed));
}

const DEFAULT_WORKER_INNER_LOOPS = parseInnerLoops(process.env.WORKER_INNER_LOOPS);
const DEFAULT_AGENT_NAME =
  process.env.AGENT_NAME && process.env.AGENT_NAME.toLowerCase() !== "auto"
    ? process.env.AGENT_NAME
    : hostname();
function parseWorkerCount(value) {
  if (!value || value.toLowerCase() === "auto") {
    return Math.max(1, cpus().length);
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return Math.max(1, cpus().length);
  }

  return parsed;
}

const DEFAULT_WORKERS = Math.max(1, Math.min(parseWorkerCount(process.env.WORKERS), cpus().length));

const ABI = [
  {
    type: "function",
    stateMutability: "view",
    name: "genesisState",
    inputs: [],
    outputs: [
      { name: "minted", type: "uint256" },
      { name: "remaining", type: "uint256" },
      { name: "ethRaised", type: "uint256" },
      { name: "complete", type: "bool" }
    ]
  },
  {
    type: "function",
    stateMutability: "view",
    name: "getChallenge",
    inputs: [{ name: "miner", type: "address" }],
    outputs: [{ type: "bytes32" }]
  },
  {
    type: "function",
    stateMutability: "view",
    name: "miningState",
    inputs: [],
    outputs: [
      { name: "era", type: "uint256" },
      { name: "reward", type: "uint256" },
      { name: "difficulty", type: "uint256" },
      { name: "minted", type: "uint256" },
      { name: "remaining", type: "uint256" },
      { name: "epoch", type: "uint256" },
      { name: "epochBlocksLeft", type: "uint256" }
    ]
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "mine",
    inputs: [{ name: "nonce", type: "uint256" }],
    outputs: []
  }
];

function now() {
  return new Date().toISOString().replace("T", " ").replace(/\..+/, "");
}

function log(scope, message) {
  console.log(`[${now()}] [${scope}] ${message}`);
}

function normalizeRemoteIp(value) {
  if (!value) {
    return "unknown";
  }
  if (value.startsWith("::ffff:")) {
    return value.slice(7);
  }
  if (value === "::1") {
    return "127.0.0.1";
  }
  return value;
}

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function toBytes32(value) {
  return getBytes(zeroPadValue(toBeHex(value), 32));
}

function makeNonce(prefixBytes, counter) {
  const nonceBytes = new Uint8Array(32);
  nonceBytes.set(prefixBytes, 0);
  const tail = toBytes32(counter).slice(24);
  nonceBytes.set(tail, 24);
  return nonceBytes;
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

function parseArgs() {
  const [, , command, ...rest] = process.argv;
  return {
    command: command || "help",
    args: rest
  };
}

function createWalletPayload() {
  const wallet = Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    createdAt: new Date().toISOString()
  };
}

function loadOrCreateWalletFile() {
  if (!existsSync(WALLET_PATH)) {
    const payload = createWalletPayload();
    writeFileSync(WALLET_PATH, JSON.stringify(payload, null, 2), "utf8");
    log("wallet", `created ${payload.address} at ${WALLET_PATH}`);
    return payload;
  }
  return JSON.parse(readFileSync(WALLET_PATH, "utf8"));
}

function resolveMasterWallet() {
  const envPrivateKey = process.env.PRIVATE_KEY;
  if (envPrivateKey) {
    const wallet = new Wallet(envPrivateKey);
    return {
      address: wallet.address,
      privateKey: envPrivateKey,
      source: "PRIVATE_KEY"
    };
  }

  const payload = loadOrCreateWalletFile();
  return {
    address: payload.address,
    privateKey: payload.privateKey,
    source: WALLET_PATH
  };
}

function formatHashrate(value) {
  return `${value.toFixed(0)} H/s`;
}

async function readChainState(provider, address) {
  const contract = new Contract(CONTRACT_ADDRESS, ABI, provider);
  const genesisState = await contract.genesisState();
  const miningState = await contract.miningState();
  const challenge = address ? await contract.getChallenge(address) : null;

  return {
    genesisComplete: genesisState[3],
    genesisMinted: genesisState[0],
    ethRaised: genesisState[2],
    era: miningState[0],
    reward: miningState[1],
    difficulty: miningState[2],
    miningMinted: miningState[3],
    remaining: miningState[4],
    epoch: miningState[5],
    epochBlocksLeft: miningState[6],
    challenge
  };
}

class MasterController {
  constructor() {
    const walletData = resolveMasterWallet();
    this.provider = new JsonRpcProvider(DEFAULT_RPC_URL, 1, { staticNetwork: true });
    this.wallet = new Wallet(walletData.privateKey, this.provider);
    this.walletSource = walletData.source;
    this.contract = new Contract(CONTRACT_ADDRESS, ABI, this.wallet);
    this.host = DEFAULT_MASTER_BIND_HOST;
    this.port = DEFAULT_MASTER_PORT;
    this.token = process.env.MASTER_TOKEN || "";
    this.minGasBalance = parseEther(DEFAULT_MIN_GAS_BALANCE);
    this.pollMs = DEFAULT_POLL_MS;
    this.openCheckMs = DEFAULT_OPEN_CHECK_MS;
    this.statusMs = DEFAULT_STATUS_MS;
    this.server = null;
    this.agents = new Map();
    this.agentSeq = 1;
    this.agentSlotSeq = 1;
    this.currentJob = null;
    this.currentRoundKey = null;
    this.submitting = false;
    this.pollTimer = null;
    this.statusTimer = null;
  }

  async start() {
    log("master", `wallet ${this.wallet.address} from ${this.walletSource}`);
    log("master", `rpc ${DEFAULT_RPC_URL}`);
    await this.waitForBalance();
    await this.waitForMiningOpen();
    await this.startServer();
    await this.refreshRound(true);
    this.pollTimer = setInterval(() => {
      this.refreshRound(false).catch(error => {
        log("master", `round refresh failed: ${error.message}`);
      });
    }, this.pollMs);
    this.statusTimer = setInterval(() => {
      this.renderStatus();
    }, this.statusMs);
  }

  async waitForBalance() {
    while (true) {
      const balance = await this.provider.getBalance(this.wallet.address);
      if (balance >= this.minGasBalance) {
        log("master", `balance ${formatEther(balance)} ETH`);
        return;
      }
      log(
        "master",
        `waiting for gas on ${this.wallet.address}, current ${formatEther(balance)} ETH, need at least ${DEFAULT_MIN_GAS_BALANCE} ETH`
      );
      await sleep(this.openCheckMs);
    }
  }

  async waitForMiningOpen() {
    while (true) {
      const state = await readChainState(this.provider, this.wallet.address);
      if (state.genesisComplete) {
        log("master", `mining open, era ${state.era.toString()}, epoch ${state.epoch.toString()}`);
        return;
      }
      log("master", "mining not open yet, waiting for genesis completion");
      await sleep(this.openCheckMs);
    }
  }

  async startServer() {
    this.server = net.createServer(socket => this.handleConnection(socket));
    await new Promise((resolvePromise, rejectPromise) => {
      this.server.once("error", rejectPromise);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", rejectPromise);
        resolvePromise();
      });
    });
    log("master", `listening on ${this.host}:${this.port}`);
  }

  handleConnection(socket) {
    socket.setNoDelay(true);
    let registeredAgentId = null;
    const remoteIp = normalizeRemoteIp(socket.remoteAddress || "");

    attachJsonLineParser(socket, message => {
      if (message.type === "register") {
        const presentedToken = message.token || "";
        if (this.token && presentedToken !== this.token) {
          log("master", `rejecting worker ${socket.remoteAddress} due to invalid token`);
          socket.destroy();
          return;
        }

        const agentId = `agent-${String(this.agentSeq).padStart(4, "0")}`;
        const agentSlot = this.agentSlotSeq;
        this.agentSeq += 1;
        this.agentSlotSeq += 1;

        const agent = {
          id: agentId,
          slot: agentSlot,
          name: message.agentName || agentId,
          ip: remoteIp,
          threads: Number(message.threads || 1),
          socket,
          lastSeenAt: Date.now(),
          hashrate: 0,
          totalHashes: 0n
        };

        registeredAgentId = agentId;
        this.agents.set(agentId, agent);
        sendJson(socket, {
          type: "registered",
          agentId,
          agentSlot
        });
        log("master", `worker connected ${agent.name} [${agent.ip}] (${agentId}) threads=${agent.threads}`);

        if (this.currentJob) {
          this.sendJob(agent, this.currentJob);
        }
        return;
      }

      if (!registeredAgentId) {
        socket.destroy();
        return;
      }

      const agent = this.agents.get(registeredAgentId);
      if (!agent) {
        return;
      }

      agent.lastSeenAt = Date.now();

      if (message.type === "progress") {
        if (!this.currentJob || message.jobId !== this.currentJob.jobId) {
          return;
        }
        agent.totalHashes += BigInt(message.hashesDelta || "0");
        agent.hashrate = Number(message.hashrate || 0);
        return;
      }

      if (message.type === "found") {
        if (!this.currentJob || message.jobId !== this.currentJob.jobId || this.submitting) {
          return;
        }
        this.submitSolution(agent, message.nonceHex, message.resultHex).catch(error => {
          log("master", `submit failed: ${error.message}`);
        });
      }
    });

    socket.on("close", () => {
      if (!registeredAgentId) {
        return;
      }
      const agent = this.agents.get(registeredAgentId);
      if (agent) {
        this.agents.delete(registeredAgentId);
        log("master", `worker disconnected ${agent.name} [${agent.ip}] (${agent.id})`);
      }
    });

    socket.on("error", error => {
      log("master", `socket error from ${socket.remoteAddress}: ${error.message}`);
    });
  }

  async refreshRound(force) {
    if (this.submitting) {
      return;
    }

    const state = await readChainState(this.provider, this.wallet.address);
    const roundKey = [
      state.challenge,
      state.difficulty.toString(),
      state.epoch.toString()
    ].join(":");

    if (!force && this.currentRoundKey === roundKey) {
      return;
    }

    this.currentRoundKey = roundKey;
    this.currentJob = {
      jobId: `${Date.now()}-${hexlify(randomBytes(4)).slice(2)}`,
      jobSeedHex: hexlify(randomBytes(16)),
      challengeHex: state.challenge,
      difficultyHex: zeroPadValue(toBeHex(state.difficulty), 32),
      era: state.era.toString(),
      reward: state.reward.toString(),
      epoch: state.epoch.toString(),
      epochBlocksLeft: state.epochBlocksLeft.toString(),
      batchSize: DEFAULT_BATCH_SIZE.toString()
    };

    for (const agent of this.agents.values()) {
      agent.hashrate = 0;
      agent.totalHashes = 0n;
      this.sendJob(agent, this.currentJob);
    }

    log(
      "master",
      `new round job=${this.currentJob.jobId} era=${this.currentJob.era} epoch=${this.currentJob.epoch} agents=${this.agents.size}`
    );
  }

  sendJob(agent, job) {
    sendJson(agent.socket, {
      type: "job",
      ...job
    });
  }

  stopAllAgents() {
    if (!this.currentJob) {
      return;
    }
    for (const agent of this.agents.values()) {
      sendJson(agent.socket, {
        type: "stop",
        jobId: this.currentJob.jobId
      });
      agent.hashrate = 0;
    }
  }

  renderStatus() {
    let totalRate = 0;
    let totalHashes = 0n;
    for (const agent of this.agents.values()) {
      totalRate += agent.hashrate;
      totalHashes += agent.totalHashes;
    }

    const jobText = this.currentJob ? `${this.currentJob.jobId} epoch=${this.currentJob.epoch}` : "none";
    log(
      "master",
      `agents=${this.agents.size} hashrate=${formatHashrate(totalRate)} hashes=${totalHashes.toString()} job=${jobText}`
    );

    for (const agent of this.agents.values()) {
      log(
        "master",
        `agent ${agent.name} [${agent.ip}] slot=${agent.slot} threads=${agent.threads} hashrate=${formatHashrate(agent.hashrate)} hashes=${agent.totalHashes.toString()}`
      );
    }
  }

  async submitSolution(agent, nonceHex, resultHex) {
    this.submitting = true;
    this.stopAllAgents();
    log(
      "master",
      `solution from ${agent.name} [${agent.ip}] (${agent.id}) nonce=${nonceHex} result=${resultHex || "n/a"}`
    );

    try {
      const nonce = BigInt(nonceHex);
      let gasLimit = 300000n;
      try {
        const estimate = await this.contract.mine.estimateGas(nonce);
        gasLimit = (estimate * 3n) / 2n;
      } catch (error) {
        log("master", `gas estimate failed, using fallback: ${error.message}`);
      }

      if (gasLimit < 200000n) {
        gasLimit = 200000n;
      }
      if (gasLimit > 400000n) {
        gasLimit = 400000n;
      }

      const tx = await this.contract.mine(nonce, { gasLimit });
      log("master", `submitted tx ${tx.hash}`);
      const receipt = await tx.wait();
      log("master", `tx confirmed in block ${receipt.blockNumber}`);
    } catch (error) {
      log("master", `submit error: ${error.shortMessage || error.message}`);
    } finally {
      this.submitting = false;
      await this.refreshRound(true);
    }
  }
}

class WorkerAgent {
  constructor() {
    this.host = DEFAULT_MASTER_PUBLIC_HOST;
    this.port = DEFAULT_MASTER_PORT;
    this.token = process.env.MASTER_TOKEN || "";
    this.agentName = DEFAULT_AGENT_NAME;
    this.threads = DEFAULT_WORKERS;
    this.batchSize = DEFAULT_BATCH_SIZE;
    this.reconnectMs = DEFAULT_RECONNECT_MS;
    this.socket = null;
    this.agentId = null;
    this.agentSlot = null;
    this.currentJob = null;
    this.miners = [];
    this.workerRates = new Map();
    this.hashesSinceFlush = 0n;
    this.flushTimer = null;
  }

  async start() {
    while (true) {
      try {
        await this.connectOnce();
      } catch (error) {
        log("worker", `connection ended: ${error.message}`);
      }
      this.stopLocalMining();
      log("worker", `reconnecting in ${this.reconnectMs} ms`);
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
          log("worker", `connected to ${this.host}:${this.port}`);
          sendJson(socket, {
            type: "register",
            token: this.token,
            agentName: this.agentName,
            threads: this.threads
          });
        }
      );

      socket.setNoDelay(true);

      attachJsonLineParser(socket, message => {
        if (message.type === "registered") {
          this.agentId = message.agentId;
          this.agentSlot = Number(message.agentSlot);
          log("worker", `registered as ${this.agentId}, slot=${this.agentSlot}`);
          return;
        }

        if (message.type === "job") {
          this.startJob(message);
          return;
        }

        if (message.type === "stop") {
          if (this.currentJob && message.jobId === this.currentJob.jobId) {
            log("worker", `stopping job ${message.jobId}`);
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
    this.hashesSinceFlush = 0n;
    this.workerRates.clear();

    log(
      "worker",
      `job=${job.jobId} era=${job.era} epoch=${job.epoch} blocksLeft=${job.epochBlocksLeft} threads=${this.threads}`
    );

    for (let threadIndex = 0; threadIndex < this.threads; threadIndex += 1) {
      const prefixHex = makePrefix(job.jobSeedHex, this.agentSlot, threadIndex);
      const miner = new Worker(new URL(import.meta.url), {
        workerData: {
          role: "search",
          challengeHex: job.challengeHex,
          difficultyHex: job.difficultyHex,
          prefixHex,
          batchSize: this.batchSize.toString(),
          innerLoops: DEFAULT_WORKER_INNER_LOOPS
        }
      });

      miner.on("message", message => {
        if (message.type === "progress") {
          this.hashesSinceFlush += BigInt(message.hashesDelta);
          this.workerRates.set(threadIndex, Number(message.hashrate));
          return;
        }

        if (message.type === "found") {
          log("worker", `solution found by thread=${threadIndex} nonce=${message.nonceHex}`);
          this.reportFound(message.nonceHex, message.resultHex);
        }
      });

      miner.on("error", error => {
        log("worker", `local miner error thread=${threadIndex}: ${error.message}`);
      });

      this.miners.push(miner);
    }

    this.flushTimer = setInterval(() => {
      this.flushProgress();
    }, 1000);
  }

  flushProgress() {
    if (!this.socket || !this.currentJob) {
      return;
    }

    let totalRate = 0;
    for (const rate of this.workerRates.values()) {
      totalRate += rate;
    }

    sendJson(this.socket, {
      type: "progress",
      jobId: this.currentJob.jobId,
      hashesDelta: this.hashesSinceFlush.toString(),
      hashrate: totalRate
    });

    this.hashesSinceFlush = 0n;
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
    this.stopLocalMining();
  }

  stopLocalMining() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    for (const miner of this.miners) {
      miner.postMessage({ type: "stop" });
    }

    this.miners = [];
    this.workerRates.clear();
    this.hashesSinceFlush = 0n;
    this.currentJob = null;
  }
}

function runSearchWorker() {
  const challengeBytes = getBytes(workerData.challengeHex);
  const difficultyBytes = getBytes(workerData.difficultyHex);
  const prefixBytes = getBytes(workerData.prefixHex);
  const batchSize = BigInt(workerData.batchSize);
  let running = true;
  let counter = 0n;

  parentPort.on("message", message => {
    if (message.type === "stop") {
      running = false;
    }
  });

  const start = async () => {
    const minerModule = await import(new URL("./hash_miner.js", import.meta.url));
    const wasmBytes = readFileSync(new URL("./hash_miner_bg.wasm", import.meta.url));

    if (typeof minerModule.initSync === "function") {
      minerModule.initSync(wasmBytes);
    } else if (typeof minerModule.default === "function") {
      await minerModule.default(wasmBytes);
    }

    const miner = new minerModule.Miner(challengeBytes, difficultyBytes, prefixBytes);
    const innerLoops = workerData.innerLoops ?? DEFAULT_WORKER_INNER_LOOPS;

    const loop = () => {
      if (!running) {
        miner.free?.();
        process.exit(0);
      }

      const tickStart = Date.now();
      let tickHashes = 0n;
      let hit = null;

      for (let i = 0; i < innerLoops && running; i += 1) {
        const result = miner.search(counter, batchSize);
        const hashesDelta = result ? result.hashes : batchSize;
        counter += hashesDelta;
        tickHashes += hashesDelta;

        if (result) {
          hit = result;
          break;
        }
      }

      const elapsedMs = Math.max(1, Date.now() - tickStart);
      const hashrate = Number(tickHashes) / (elapsedMs / 1000);

      parentPort.postMessage({
        type: "progress",
        hashesDelta: tickHashes.toString(),
        hashrate
      });

      if (hit) {
        parentPort.postMessage({
          type: "found",
          nonceHex: hexlify(hit.nonce),
          resultHex: hexlify(hit.result)
        });
        hit.free?.();
        miner.free?.();
        process.exit(0);
      }

      setImmediate(loop);
    };

    loop();
  };

  start().catch(error => {
    parentPort.postMessage({
      type: "error",
      message: error.message || String(error)
    });
    process.exit(1);
  });
}

async function printStatus() {
  const walletData = existsSync(WALLET_PATH) ? JSON.parse(readFileSync(WALLET_PATH, "utf8")) : null;
  const address = process.env.PRIVATE_KEY ? new Wallet(process.env.PRIVATE_KEY).address : walletData?.address;
  const provider = new JsonRpcProvider(DEFAULT_RPC_URL, 1, { staticNetwork: true });
  const state = await readChainState(provider, address || null);
  const payload = {
    rpc: DEFAULT_RPC_URL,
    walletAddress: address || null,
    genesisComplete: state.genesisComplete,
    genesisMinted: state.genesisMinted.toString(),
    ethRaised: state.ethRaised.toString(),
    era: state.era.toString(),
    reward: state.reward.toString(),
    difficulty: state.difficulty.toString(),
    miningMinted: state.miningMinted.toString(),
    remaining: state.remaining.toString(),
    epoch: state.epoch.toString(),
    epochBlocksLeft: state.epochBlocksLeft.toString(),
    challenge: state.challenge
  };
  console.log(JSON.stringify(payload, null, 2));
}

function printHelp() {
  console.log(`Usage:
  node hash256-mine.mjs wallet
  node hash256-mine.mjs status
  node hash256-mine.mjs master
  node hash256-mine.mjs worker

Environment:
  RPC_URL              Ethereum mainnet RPC for master/status
  PRIVATE_KEY          Optional master wallet private key
  WALLET_PATH          Wallet file path for master
  MASTER_BIND_HOST     Master listen host, default 0.0.0.0
  MASTER_PUBLIC_HOST   Master public host or IP used by remote workers
  MASTER_HOST          Backward-compatible alias
  MASTER_PORT          Master bind port or worker target port
  MASTER_TOKEN         Shared token between master and workers
  MIN_GAS_BALANCE      Minimum ETH balance required on master wallet
  WORKERS              Worker thread count per worker agent
  BATCH_SIZE           Search batch size per local miner thread
  WORKER_INNER_LOOPS   WASM search batches per event-loop tick, default 8
  AGENT_NAME           Worker display name
  RECONNECT_MS         Worker reconnect delay

Tune WORKERS/BATCH_SIZE for this CPU: node perf-bench.mjs
`);
}

async function main() {
  const { command } = parseArgs();

  if (command === "wallet") {
    const payload = loadOrCreateWalletFile();
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "status") {
    await printStatus();
    return;
  }

  if (command === "master") {
    const master = new MasterController();
    await master.start();
    return;
  }

  if (command === "worker") {
    const agent = new WorkerAgent();
    await agent.start();
    return;
  }

  printHelp();
}

if (!isMainThread && workerData?.role === "search") {
  runSearchWorker();
} else {
  const thisFile = fileURLToPath(import.meta.url);
  const entryFile = process.argv[1] ? resolve(process.argv[1]) : null;
  if (entryFile && thisFile === entryFile) {
    main().catch(error => {
      console.error(error);
      process.exit(1);
    });
  }
}
