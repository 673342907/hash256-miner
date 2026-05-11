import { Worker as NodeWorker } from "node:worker_threads";
import { cpus } from "node:os";
import process from "node:process";

const challengeHex =
  process.env.BENCH_CHALLENGE ||
  "0x6c7ee6f1672d8eb5c2f54d6db7d5c0e5b2b7fd55a4f1b71f60d8f669ec8d0201";
const difficultyHex =
  process.env.BENCH_DIFFICULTY ||
  "0x0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const durationMs = Number(process.env.BENCH_MS || "5000");
const cpuCount = cpus().length;

function prefixHex(agentSlot, threadIndex) {
  const seed = Buffer.alloc(16, 0x42);
  const prefix = Buffer.alloc(24, 0);
  seed.copy(prefix, 0);
  prefix.writeUInt32BE(agentSlot >>> 0, 16);
  prefix.writeUInt32BE(threadIndex >>> 0, 20);
  return `0x${prefix.toString("hex")}`;
}

async function runCombo(threads, batchSize) {
  let hashes = 0n;
  const workers = [];

  await new Promise((resolvePromise, rejectPromise) => {
    let finished = 0;

    for (let i = 0; i < threads; i += 1) {
      const worker = new NodeWorker(new URL("./hash256-mine.mjs", import.meta.url), {
        workerData: {
          role: "search",
          challengeHex,
          difficultyHex,
          prefixHex: prefixHex(1, i),
          batchSize: String(batchSize)
        }
      });

      worker.on("message", message => {
        if (message.type === "progress") {
          hashes += BigInt(message.hashesDelta);
        }
      });

      worker.on("error", rejectPromise);
      worker.on("exit", () => {
        finished += 1;
        if (finished === threads) {
          resolvePromise();
        }
      });

      workers.push(worker);
    }

    setTimeout(() => {
      for (const worker of workers) {
        worker.postMessage({ type: "stop" });
      }
    }, durationMs);
  });

  const mh = Number(hashes) / durationMs / 1000;
  return {
    threads,
    batchSize,
    mh
  };
}

async function main() {
  const threadOptions = [...new Set([Math.max(1, Math.floor(cpuCount / 2)), Math.max(1, cpuCount - 1), cpuCount])];
  const batchOptions = [250000, 500000, 1000000, 2000000];

  const results = [];
  for (const threads of threadOptions) {
    for (const batchSize of batchOptions) {
      const result = await runCombo(threads, batchSize);
      results.push(result);
      console.log(`threads=${result.threads} batch=${result.batchSize} => ${result.mh.toFixed(3)} MH/s`);
    }
  }

  results.sort((a, b) => b.mh - a.mh);
  const best = results[0];

  console.log("");
  console.log("推荐配置");
  console.log(`WORKERS=${best.threads}`);
  console.log(`BATCH_SIZE=${best.batchSize}`);
  console.log(`预计算力=${best.mh.toFixed(3)} MH/s`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
