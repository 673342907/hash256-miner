import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import process from "node:process";
import { Contract, JsonRpcProvider, Wallet, ZeroAddress, formatEther } from "ethers";
import { loadEnvFiles } from "./env-loader.mjs";

loadEnvFiles([".env", ".env.master"]);

const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const WALLET_PATH = process.env.WALLET_PATH || "./hash256-wallet.json";
const RPC_URL = process.env.RPC_URL || "https://ethereum-rpc.publicnode.com";
const JSON_MODE = process.argv.includes("--json");
const JOURNAL_UNITS = ["hash256-solo-gpu", "hash256-master"];
const LOG_SCAN_LINES = 2000;
const DEFAULT_TRANSFER_SCAN_STEP = Number(process.env.REPORT_LOG_BLOCK_RANGE || "50000");

const ABI = [
  {
    type: "function",
    stateMutability: "view",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }]
  },
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
    type: "event",
    anonymous: false,
    name: "Transfer",
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" }
    ]
  }
];

function safeExec(command) {
  try {
    return execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

function readWalletAddress() {
  const envPrivateKey = process.env.PRIVATE_KEY;
  if (envPrivateKey) {
    return new Wallet(envPrivateKey).address;
  }

  if (!existsSync(WALLET_PATH)) {
    throw new Error(`wallet not found: ${WALLET_PATH}`);
  }

  const payload = JSON.parse(readFileSync(WALLET_PATH, "utf8"));
  if (payload?.privateKey) {
    return new Wallet(payload.privateKey).address;
  }
  if (payload?.address) {
    return payload.address;
  }

  throw new Error(`cannot resolve wallet address from ${WALLET_PATH}`);
}

function formatToken(value) {
  const text = formatEther(value);
  if (!text.includes(".")) {
    return text;
  }
  return text.replace(/\.?0+$/, "");
}

function formatHashrateFromHps(value) {
  return `${(Number(value || 0) / 1_000_000).toFixed(3)} MH/s`;
}

function parseHashrate(value, unit) {
  const numeric = Number(value || 0);
  if (unit === "MH/s") {
    return numeric * 1_000_000;
  }
  return numeric;
}

function formatDifficulty(value) {
  const text = String(value);
  return `${text.slice(0, 10)}...${text.slice(-6)}`;
}

function collectServiceState() {
  const result = {};
  for (const unit of JOURNAL_UNITS) {
    const status = safeExec(`systemctl is-active ${unit}`);
    if (status) {
      result[unit] = status;
    }
  }
  return result;
}

function collectJournalLines() {
  const unitArgs = JOURNAL_UNITS.map(unit => `-u ${unit}`).join(" ");
  const output = safeExec(`journalctl ${unitArgs} -n ${LOG_SCAN_LINES} --no-pager`);
  return output ? output.split(/\r?\n/) : [];
}

function summarizeRuntimeFromJournal(lines) {
  const workers = new Map();
  let totalHashrate = null;
  let totalHashes = null;
  let confirmedTxCount = 0;
  let submittedTxCount = 0;
  let lastSubmittedTxHash = null;
  let lastConfirmedBlock = null;
  let lastConfirmedAt = null;
  let lastSolutionNonce = null;
  let lastSolutionAt = null;
  let lastRound = null;

  for (const line of lines) {
    const timestampMatch = line.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
    const timestamp = timestampMatch?.[1] || null;

    const totalMatch = line.match(/agents=(\d+)\s+hashrate=([0-9.]+)\s+(MH\/s|H\/s)\s+hashes=([0-9]+)/);
    if (totalMatch) {
      totalHashrate = parseHashrate(totalMatch[2], totalMatch[3]);
      totalHashes = totalMatch[4];
    }

    const workerMatch = line.match(
      /agent\s+(.+?)\s+\[([^\]]+)\]\s+slot=(\d+)\s+threads=(\d+)\s+hashrate=([0-9.]+)\s+(MH\/s|H\/s)\s+hashes=([0-9]+)/
    );
    if (workerMatch) {
      const ip = workerMatch[2];
      const hashrate = parseHashrate(workerMatch[5], workerMatch[6]);
      workers.set(ip, {
        name: workerMatch[1],
        ip,
        slot: Number(workerMatch[3]),
        threads: Number(workerMatch[4]),
        hashrate,
        hashes: workerMatch[7]
      });
    }

    const roundMatch = line.match(/new round job=(\S+)\s+era=(\S+)\s+epoch=(\S+)\s+agents=(\d+)/);
    if (roundMatch) {
      lastRound = {
        jobId: roundMatch[1],
        era: roundMatch[2],
        epoch: roundMatch[3],
        agents: Number(roundMatch[4]),
        seenAt: timestamp
      };
    }

    const solutionMatch = line.match(/solution from .* nonce=(0x[a-fA-F0-9]+)/);
    if (solutionMatch) {
      lastSolutionNonce = solutionMatch[1];
      lastSolutionAt = timestamp;
    }

    const submitMatch = line.match(/submitted tx (0x[a-fA-F0-9]+)/);
    if (submitMatch) {
      submittedTxCount += 1;
      lastSubmittedTxHash = submitMatch[1];
    }

    const confirmMatch = line.match(/tx confirmed in block (\d+)/);
    if (confirmMatch) {
      confirmedTxCount += 1;
      lastConfirmedBlock = Number(confirmMatch[1]);
      lastConfirmedAt = timestamp;
    }
  }

  return {
    workers: [...workers.values()].sort((a, b) => b.hashrate - a.hashrate || a.ip.localeCompare(b.ip)),
    totalHashrate,
    totalHashes,
    submittedTxCount,
    confirmedTxCount,
    lastSubmittedTxHash,
    lastConfirmedBlock,
    lastConfirmedAt,
    lastSolutionNonce,
    lastSolutionAt,
    lastRound
  };
}

function isBlockRangeLimitError(error) {
  const message = String(error?.message || error?.shortMessage || "");
  return /maximum block range|exceed maximum block range|block range/i.test(message);
}

async function queryMintedTransfers(contract, walletAddress, latestBlock) {
  const filter = contract.filters.Transfer(ZeroAddress, walletAddress);
  let total = 0n;
  let count = 0;
  let lastBlock = null;
  let step = Math.max(1, DEFAULT_TRANSFER_SCAN_STEP);

  for (let fromBlock = 0; fromBlock <= latestBlock;) {
    const toBlock = Math.min(latestBlock, fromBlock + step - 1);
    let logs;
    try {
      logs = await contract.queryFilter(filter, fromBlock, toBlock);
    } catch (error) {
      if (!isBlockRangeLimitError(error) || step === 1) {
        throw error;
      }
      step = Math.max(1, Math.floor(step / 2));
      continue;
    }

    for (const log of logs) {
      total += BigInt(log.args?.value ?? 0n);
      count += 1;
      lastBlock = log.blockNumber;
    }

    fromBlock = toBlock + 1;
  }

  return { total, count, lastBlock };
}

function renderTextReport(payload) {
  const lines = [];

  lines.push("HASH256 Mining Report");
  lines.push(`wallet: ${payload.wallet.address}`);
  lines.push(`rpc: ${payload.rpcUrl}`);
  lines.push("");

  lines.push("Mined");
  lines.push(`minted total: ${payload.mined.totalHash} HASH`);
  lines.push(`confirmed mined count: ${payload.mined.mintedCount}`);
  lines.push(`wallet HASH balance: ${payload.wallet.hashBalance} HASH`);
  lines.push(`wallet ETH balance: ${payload.wallet.ethBalance} ETH`);
  if (payload.mined.lastMintBlock !== null) {
    lines.push(`last mint block: ${payload.mined.lastMintBlock}`);
  }
  lines.push("");

  lines.push("Runtime");
  for (const [unit, status] of Object.entries(payload.runtime.services)) {
    lines.push(`${unit}: ${status}`);
  }
  if (payload.runtime.totalHashrate !== null) {
    lines.push(`total hashrate: ${payload.runtime.totalHashrateText}`);
  }
  if (payload.runtime.totalHashes !== null) {
    lines.push(`current round hashes: ${payload.runtime.totalHashes}`);
  }
  lines.push(`submitted tx count: ${payload.runtime.submittedTxCount}`);
  lines.push(`confirmed tx count: ${payload.runtime.confirmedTxCount}`);
  if (payload.runtime.lastSubmittedTxHash) {
    lines.push(`last submitted tx: ${payload.runtime.lastSubmittedTxHash}`);
  }
  if (payload.runtime.lastConfirmedBlock !== null) {
    lines.push(`last confirmed block: ${payload.runtime.lastConfirmedBlock}`);
  }
  if (payload.runtime.lastConfirmedAt) {
    lines.push(`last confirmed at: ${payload.runtime.lastConfirmedAt}`);
  }
  if (payload.runtime.lastSolutionNonce) {
    lines.push(`last solution nonce: ${payload.runtime.lastSolutionNonce}`);
  }
  if (payload.runtime.lastRound) {
    lines.push(
      `last round: job=${payload.runtime.lastRound.jobId} era=${payload.runtime.lastRound.era} epoch=${payload.runtime.lastRound.epoch} agents=${payload.runtime.lastRound.agents}`
    );
  }
  lines.push("");

  lines.push("Workers");
  if (payload.runtime.workers.length === 0) {
    lines.push("no worker runtime data found in journal");
  } else {
    for (const worker of payload.runtime.workers) {
      lines.push(
        `${worker.ip} | ${worker.name} | slot=${worker.slot} | threads=${worker.threads} | hashrate=${formatHashrateFromHps(worker.hashrate)} | hashes=${worker.hashes}`
      );
    }
  }
  lines.push("");

  lines.push("Chain");
  lines.push(`genesis complete: ${payload.chain.genesisComplete}`);
  lines.push(`genesis minted: ${payload.chain.genesisMinted} HASH`);
  lines.push(`genesis eth raised: ${payload.chain.genesisEthRaised} ETH`);
  lines.push(`current reward: ${payload.chain.currentReward} HASH`);
  lines.push(`era: ${payload.chain.era}`);
  lines.push(`epoch: ${payload.chain.epoch}`);
  lines.push(`epoch blocks left: ${payload.chain.epochBlocksLeft}`);
  lines.push(`difficulty: ${payload.chain.difficulty}`);
  lines.push(`global mined: ${payload.chain.globalMiningMinted} HASH`);
  lines.push(`global remaining: ${payload.chain.globalRemaining} HASH`);

  return lines.join("\n");
}

async function main() {
  const provider = new JsonRpcProvider(RPC_URL, 1, { staticNetwork: true });
  const walletAddress = readWalletAddress();
  const contract = new Contract(CONTRACT_ADDRESS, ABI, provider);
  const journalLines = collectJournalLines();

  const [ethBalance, tokenBalance, genesisState, miningState, latestBlock] = await Promise.all([
    provider.getBalance(walletAddress),
    contract.balanceOf(walletAddress),
    contract.genesisState(),
    contract.miningState(),
    provider.getBlockNumber()
  ]);

  const [minted, runtime] = await Promise.all([
    queryMintedTransfers(contract, walletAddress, latestBlock),
    Promise.resolve(summarizeRuntimeFromJournal(journalLines))
  ]);

  const payload = {
    wallet: {
      address: walletAddress,
      hashBalance: formatToken(tokenBalance),
      ethBalance: formatToken(ethBalance)
    },
    rpcUrl: RPC_URL,
    mined: {
      totalHash: formatToken(minted.total),
      mintedCount: minted.count,
      lastMintBlock: minted.lastBlock
    },
    runtime: {
      services: collectServiceState(),
      totalHashrate: runtime.totalHashrate,
      totalHashrateText: runtime.totalHashrate !== null ? formatHashrateFromHps(runtime.totalHashrate) : null,
      totalHashes: runtime.totalHashes,
      submittedTxCount: runtime.submittedTxCount,
      confirmedTxCount: runtime.confirmedTxCount,
      lastSubmittedTxHash: runtime.lastSubmittedTxHash,
      lastConfirmedBlock: runtime.lastConfirmedBlock,
      lastConfirmedAt: runtime.lastConfirmedAt,
      lastSolutionNonce: runtime.lastSolutionNonce,
      lastSolutionAt: runtime.lastSolutionAt,
      lastRound: runtime.lastRound,
      workers: runtime.workers.map(worker => ({
        ...worker,
        hashrateText: formatHashrateFromHps(worker.hashrate)
      }))
    },
    chain: {
      genesisComplete: genesisState[3],
      genesisMinted: formatToken(genesisState[0]),
      genesisEthRaised: formatToken(genesisState[2]),
      currentReward: formatToken(miningState[1]),
      era: miningState[0].toString(),
      epoch: miningState[5].toString(),
      epochBlocksLeft: miningState[6].toString(),
      difficulty: formatDifficulty(miningState[2].toString()),
      globalMiningMinted: formatToken(miningState[3]),
      globalRemaining: formatToken(miningState[4])
    }
  };

  if (JSON_MODE) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(renderTextReport(payload));
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
