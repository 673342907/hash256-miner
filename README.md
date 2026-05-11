# HASH256 Group Miner

This project runs HASH256 mining in a master/worker layout.

The master:
- holds the wallet private key
- reads `getChallenge(address)` and `miningState()`
- accepts worker agents over TCP
- submits `mine(nonce)` on chain

Worker agents:
- do not hold the wallet private key
- connect to the master
- receive mining jobs
- search for valid nonces locally
- report solutions back to the master
- can run as Node CPU workers, Rust native CPU workers, or OpenCL GPU workers

## Install

```bash
npm install
```

## GPU Worker Build

Build the OpenCL GPU miner on Ubuntu:

```bash
npm run gpu:build
```

Default binary path on Ubuntu:

```text
gpu-miner/build/hash256-gpu-miner
```

If you already created the build directory and only want to rebuild:

```bash
npm run gpu:build:release
```

## One-click Ubuntu deploy

```bash
chmod +x deploy-ubuntu.sh
./deploy-ubuntu.sh
```

The script:
- installs Node.js 20 if needed
- installs npm dependencies
- prompts for master or worker settings
- writes `.env.master` / `.env.worker`
- writes systemd service files using the current directory
- starts the required services

Master env notes:
- `MASTER_BIND_HOST` is where the master listens, usually `0.0.0.0`
- `MASTER_PUBLIC_HOST` is what remote workers should connect to

## Fleet Control

Use `fleet.sh` on the master machine to manage remote worker machines over SSH.

Files:
- `fleet.sh`
- `workers.txt.example`

Worker inventory format:

```text
host|user|ssh_key|worker_name|threads|remote_dir
```

Example:

```text
43.110.24.90|root|/root/.ssh/worker-01.pem|worker-01|8|/opt/hash256-miner
43.110.24.91|root|/root/.ssh/worker-02.pem|worker-02|16|/opt/hash256-miner
```

Typical usage on the master:

```bash
cp workers.txt.example workers.txt
nano workers.txt
chmod +x fleet.sh
./fleet.sh deploy
./fleet.sh status
./fleet.sh logs
```

Important:
- `MASTER_PUBLIC_HOST` in `.env.master` must be set to the real IP or hostname that remote workers can reach.
- `fleet.sh` only deploys and manages workers. It does not touch the master wallet.

## Fleet Lite

If every worker machine uses the same SSH user, the same SSH key, the same remote path, and the same default install flow, use `fleet-lite.sh`.

Files:
- `fleet-lite.sh`
- `ips.txt.example`

You only maintain an IP list:

```text
43.110.24.90
43.110.24.91
43.110.24.92
```

Defaults:
- `SSH_USER=root`
- `SSH_KEY=/root/.ssh/worker.pem`
- `REMOTE_DIR=/opt/hash256-miner`
- `WORKER_PREFIX=worker`

Typical usage:

```bash
cp ips.txt.example ips.txt
nano ips.txt
chmod +x fleet-lite.sh
./fleet-lite.sh deploy
./fleet-lite.sh status
./fleet-lite.sh logs
```

Optional overrides:

```bash
SSH_KEY=/root/.ssh/my-worker.pem ./fleet-lite.sh deploy
SSH_USER=ubuntu REMOTE_DIR=/srv/hash256 ./fleet-lite.sh deploy
```

## Worker Images

You can make a **worker-only** image from a configured worker server.

Recommended:
- do **not** make a master image
- make an image only from a worker machine
- keep `.env.worker` pointed at the stable master public IP
- use `AGENT_NAME=auto`
- use `WORKERS=auto`

With the current code:
- `AGENT_NAME=auto` uses the machine hostname
- `WORKERS=auto` uses the machine CPU count

That makes cloned worker instances much closer to zero-touch after boot.

## Generate or show the master wallet

```bash
npm run wallet
```

This writes `hash256-wallet.json` if it does not already exist.

## Check live chain state

```bash
npm run status
```

## Chinese master report

On the master machine:

```bash
npm run report
```

This prints:
- how much this wallet has mined in total
- confirmed mint count for this wallet
- wallet HASH and ETH balances
- current total hashrate and worker breakdown
- submitted and confirmed tx counts
- current reward, era, epoch, difficulty
- total mining minted and remaining supply

JSON output:

```bash
npm run report:json
```

## Run the master on Ubuntu

```bash
export RPC_URL="https://your-mainnet-rpc"
export MASTER_HOST="0.0.0.0"
export MASTER_PORT="7331"
export MASTER_TOKEN="replace-this"
export PRIVATE_KEY="0x..."
npm run master
```

Notes:
- `PRIVATE_KEY` is recommended on Ubuntu servers.
- If `PRIVATE_KEY` is not set, the script will use `hash256-wallet.json`.
- Only the master needs ETH for gas.

Example env file:
- `.env.master.example`

## Run a worker

```bash
export MASTER_HOST="your-master-ip"
export MASTER_PORT="7331"
export MASTER_TOKEN="replace-this"
export AGENT_NAME="worker-01"
export WORKERS="8"
npm run worker
```

You can run many workers at once. Each worker receives the same challenge but a different nonce prefix space, so they do not intentionally overlap.

Example env file:
- `.env.worker.example`

### Run a solo GPU miner on one Ubuntu server

If your 4090 server should both hold the wallet and do the mining, use the solo GPU mode. You only need to provide the wallet private key; the script writes `.env.master` and `.env.worker` automatically and starts both `master` and `gpu worker` on localhost.

```bash
cp .env.solo-gpu.example .env.solo-gpu
nano .env.solo-gpu
npm run gpu:build
npm run solo:gpu
```

If you want it to run in the background and restart automatically after reboot:

```bash
chmod +x install-solo-gpu-service.sh
./install-solo-gpu-service.sh
```

Useful service commands:

```bash
sudo systemctl status hash256-solo-gpu --no-pager -l
sudo journalctl -u hash256-solo-gpu -f
sudo systemctl restart hash256-solo-gpu
```

If your environment does not use `systemd` (for example a container), use the built-in daemon script instead:

```bash
chmod +x solo-gpu-daemon.sh
npm run solo:gpu:start
npm run solo:gpu:status
npm run solo:gpu:logs
```

Stop or restart:

```bash
npm run solo:gpu:stop
npm run solo:gpu:restart
```

Required:

- set `PRIVATE_KEY` in `.env.solo-gpu`

Defaults chosen for a single Ubuntu GPU host:

- `MASTER_BIND_HOST=127.0.0.1`
- `MASTER_PUBLIC_HOST=127.0.0.1`
- `MASTER_HOST=127.0.0.1`
- auto-generated `MASTER_TOKEN`
- `AGENT_NAME=gpu-4090`
- `GPU_PLATFORM=0`
- `GPU_DEVICE=0`
- `GPU_GLOBAL_WORK_SIZE=4194304`
- `GPU_LOCAL_WORK_SIZE=256`

The mining rewards will be sent to the wallet derived from the `PRIVATE_KEY` in `.env.solo-gpu`.
Master and worker hashrate logs are printed in `MH/s`.

### Run a GPU worker

The GPU worker connects directly to the existing `master` TCP protocol, automatically receives jobs, starts the GPU miner process, sends progress updates, and reports hits back to the master.

Ubuntu example when the master already exists elsewhere:

```bash
export MASTER_HOST="your-master-ip"
export MASTER_PORT="7331"
export MASTER_TOKEN="replace-this"
export AGENT_NAME="gpu-01"
export WORKER_RUNTIME="gpu"
export GPU_EXECUTABLE="gpu-miner/build/hash256-gpu-miner"
export GPU_PLATFORM="0"
export GPU_DEVICE="0"
npm run worker:gpu
```

Recommended tuning variables:

- `GPU_PLATFORM`: OpenCL platform index
- `GPU_DEVICE`: GPU device index under the selected platform
- `GPU_GLOBAL_WORK_SIZE`: work items per dispatch, default `1048576`
- `GPU_LOCAL_WORK_SIZE`: work-group size, default `256`, use `0` to let the driver choose
- `GPU_PROGRESS_MS`: GPU progress log interval, default `1000`
- `GPU_KERNEL_PATH`: optional explicit path to `keccak_miner.cl`

Operational notes:

- One `npm run worker:gpu` process controls one GPU device.
- For multi-GPU hosts, start one process per GPU and set a different `GPU_DEVICE` and `AGENT_NAME` for each process.
- The nonce prefix still comes from `jobSeedHex + agentSlot + threadIndex`, so GPU workers stay non-overlapping with existing CPU workers.
- `WORKERS` and `BATCH_SIZE` are ignored by the GPU worker.

## systemd

Master template:
- `hash256-master.service`

Worker template:
- `hash256-worker.service`

Solo GPU template:
- `hash256-solo-gpu.service`

Typical Ubuntu setup:

```bash
sudo mkdir -p /opt/hash256-miner
sudo cp -r . /opt/hash256-miner
cd /opt/hash256-miner
npm install --omit=dev
cp .env.master.example .env.master
cp hash256-master.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hash256-master
```

For a worker host:

```bash
sudo mkdir -p /opt/hash256-miner
sudo cp -r . /opt/hash256-miner
cd /opt/hash256-miner
npm install --omit=dev
cp .env.worker.example .env.worker
cp hash256-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hash256-worker
```

## Commands

```bash
node hash256-mine.mjs wallet
node hash256-mine.mjs status
node hash256-mine.mjs master
node hash256-mine.mjs worker
node hash256-gpu-worker.mjs
node hash256-solo-gpu.mjs
```

npm shortcuts:

```bash
npm run wallet
npm run status
npm run master
npm run worker
npm run worker:gpu
npm run solo:gpu
npm run gpu:build
npm run gpu:build:release
```

## Important

- Keep the private key on the master only.
- Do not copy `hash256-wallet.json` to worker machines.
- Protect the master port with a firewall and a strong `MASTER_TOKEN`.
- Use a stable Ethereum mainnet RPC for the master.
- GPU workers require a working OpenCL runtime from the GPU vendor driver.
