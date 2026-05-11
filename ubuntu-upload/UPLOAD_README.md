## Upload This Folder To Ubuntu

Upload all files in this folder to the Ubuntu server, for example:

```bash
scp -r ubuntu-upload/* root@your-server:/opt/hash256-miner/
```

After upload:

```bash
cd /opt/hash256-miner
npm install --omit=dev
cp .env.master.example .env.master
```

Then edit `.env.master`:
- set `RPC_URL`
- set `MASTER_TOKEN`
- set `PRIVATE_KEY`

Start master:

```bash
node hash256-mine.mjs master
```

Or use systemd:

```bash
cp hash256-master.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now hash256-master
```

For worker servers:

```bash
cp .env.worker.example .env.worker
```

Then edit `.env.worker`:
- set `MASTER_HOST`
- set `MASTER_TOKEN`
- set `AGENT_NAME`
- set `WORKERS`

Start worker:

```bash
node hash256-mine.mjs worker
```
