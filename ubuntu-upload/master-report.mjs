import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import process from "node:process";
import { Contract, JsonRpcProvider, Wallet, formatEther } from "ethers";

const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const WALLET_PATH = process.env.WALLET_PATH || "./hash256-wallet.json";
const MASTER_ENV_PATH = process.env.MASTER_ENV_PATH || "./.env.master";
const RPC_URL = process.env.RPC_URL || readEnvValue("RPC_URL") || "https://ethereum-rpc.publicnode.com";

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
  }
];

function readEnvValue(key) {
  if (!existsSync(MASTER_ENV_PATH)) {
    return "";
  }
  const text = readFileSync(MASTER_ENV_PATH, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(`${key}=`)) {
      return line.slice(key.length + 1).trim();
    }
  }
  return "";
}

function loadWalletAddress() {
  const envPrivateKey = process.env.PRIVATE_KEY || readEnvValue("PRIVATE_KEY");
  if (envPrivateKey) {
    return new Wallet(envPrivateKey).address;
  }
  if (existsSync(WALLET_PATH)) {
    const payload = JSON.parse(readFileSync(WALLET_PATH, "utf8"));
    if (payload?.privateKey) {
      return new Wallet(payload.privateKey).address;
    }
    if (payload?.address) {
      return payload.address;
    }
  }
  throw new Error("未找到主控钱包地址，请检查 .env.master 或 hash256-wallet.json");
}

function formatHash(value) {
  const text = String(value);
  return `${text.slice(0, 10)}...${text.slice(-6)}`;
}

function formatMegahashFromHashrate(value) {
  return `${(Number(value) / 1_000_000).toFixed(3)} MH/s`;
}

function colorize(text, color) {
  const colors = {
    red: "\x1b[31m",
    green: "\x1b[32m",
    reset: "\x1b[0m"
  };
  return `${colors[color] || ""}${text}${colors.reset}`;
}

function summarizeWorkersFromJournal() {
  let output = "";
  try {
    output = execSync("journalctl -u hash256-master -n 400 --no-pager", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return {
      workers: [],
      totalHashrate: null,
      totalHashes: null
    };
  }

  const workerMap = new Map();
  let totalHashrate = null;
  let totalHashes = null;

  for (const line of output.split(/\r?\n/)) {
    const totalMatch = line.match(/agents=(\d+)\s+hashrate=([0-9.]+)\s+H\/s\s+hashes=([0-9]+)/);
    if (totalMatch) {
      totalHashrate = Number(totalMatch[2]);
      totalHashes = totalMatch[3];
    }

    const workerMatch = line.match(/agent\s+(.+?)\s+\[([^\]]+)\]\s+slot=(\d+)\s+threads=(\d+)\s+hashrate=([0-9.]+)\s+H\/s\s+hashes=([0-9]+)/);
    if (workerMatch) {
      const ip = workerMatch[2];
      workerMap.set(ip, {
        名称: workerMatch[1],
        IP: ip,
        槽位: Number(workerMatch[3]),
        线程: Number(workerMatch[4]),
        哈希率数值: Number(workerMatch[5]),
        哈希率: formatMegahashFromHashrate(workerMatch[5]),
        已尝试哈希: workerMatch[6]
      });
    }
  }

  return {
    workers: [...workerMap.values()],
    totalHashrate,
    totalHashes
  };
}

async function main() {
  const provider = new JsonRpcProvider(RPC_URL, 1, { staticNetwork: true });
  const walletAddress = loadWalletAddress();
  const contract = new Contract(CONTRACT_ADDRESS, ABI, provider);

  const [ethBalance, tokenBalance, genesisState, miningState, workerSummary] = await Promise.all([
    provider.getBalance(walletAddress),
    contract.balanceOf(walletAddress),
    contract.genesisState(),
    contract.miningState(),
    Promise.resolve(summarizeWorkersFromJournal())
  ]);

  const totalMiningMinted = miningState[3];
  const currentReward = miningState[1];
  const estMines = currentReward > 0n ? tokenBalance / currentReward : 0n;

  const lines = [];
  lines.push("主控总览");
  lines.push(`主控钱包: ${walletAddress}`);
  lines.push(`主网 RPC: ${RPC_URL}`);
  lines.push("");

  lines.push("收益情况");
  lines.push(`钱包中 HASH 余额: ${formatEther(tokenBalance)} HASH`);
  lines.push(`钱包中 ETH 余额: ${formatEther(ethBalance)} ETH`);
  lines.push(`按当前单次奖励估算，累计挖到次数: ${estMines.toString()} 次`);
  lines.push(`当前单次奖励: ${formatEther(currentReward)} HASH`);
  lines.push("");

  lines.push("Worker 状态");
  if (workerSummary.workers.length === 0) {
    lines.push(colorize("暂无已识别的 worker 运行数据", "red"));
  } else {
    const sorted = workerSummary.workers.sort((a, b) => b.哈希率数值 - a.哈希率数值 || a.IP.localeCompare(b.IP));
    for (const worker of sorted) {
      const ok = worker.哈希率数值 > 0;
      const status = ok ? colorize("正常挖矿", "green") : colorize("在线但无算力", "red");
      lines.push(
        `${worker.IP} | ${worker.名称} | ${status} | 槽位 ${worker.槽位} | 线程 ${worker.线程} | 哈希率 ${worker.哈希率} | 已尝试 ${worker.已尝试哈希}`
      );
    }
  }
  if (workerSummary.totalHashrate !== null) {
    lines.push(`总哈希率: ${formatMegahashFromHashrate(workerSummary.totalHashrate)}`);
  }
  if (workerSummary.totalHashes !== null) {
    lines.push(`本轮累计已尝试: ${workerSummary.totalHashes}`);
  }
  lines.push("");

  lines.push("链上统计");
  lines.push(`Genesis 是否完成: ${genesisState[3] ? "是" : "否"}`);
  lines.push(`Genesis 已铸造: ${formatEther(genesisState[0])} HASH`);
  lines.push(`Genesis 已筹集: ${formatEther(genesisState[2])} ETH`);
  lines.push(`当前 Era: ${miningState[0].toString()}`);
  lines.push(`当前 Epoch: ${miningState[5].toString()}`);
  lines.push(`Epoch 剩余区块: ${miningState[6].toString()}`);
  lines.push(`当前难度: ${formatHash(miningState[2].toString())}`);
  lines.push(`全网已挖出: ${formatEther(totalMiningMinted)} HASH`);
  lines.push(`全网剩余可挖: ${formatEther(miningState[4])} HASH`);
  lines.push("");

  lines.push("说明");
  lines.push("钱包中 HASH 余额包含历史挖矿奖励，以及你未转出的链上余额。");
  lines.push("累计挖到次数是按当前单次奖励倒推的估算值，Halving 后这个值仅供参考。");

  console.log(lines.join("\n"));
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
