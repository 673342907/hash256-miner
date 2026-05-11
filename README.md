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

## Install

```bash
npm install
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
- all detected worker statuses
- master wallet HASH and ETH balances
- estimated mined reward count
- current reward, era, epoch, difficulty
- total mining minted and remaining supply

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

## systemd

Master template:
- `hash256-master.service`

Worker template:
- `hash256-worker.service`

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
```

## Important

- Keep the private key on the master only.
- Do not copy `hash256-wallet.json` to worker machines.
- Protect the master port with a firewall and a strong `MASTER_TOKEN`.
- Use a stable Ethereum mainnet RPC for the master.
