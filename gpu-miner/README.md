# Hash256 GPU Miner for Windows

This is a standalone OpenCL GPU searcher for the same proof-of-work layout used by the existing CPU/WASM miners:

- Input hash: `Keccak256(challenge || nonce)`
- `challenge`: 32 bytes from `getChallenge(address)`
- `nonce`: 32 bytes, `prefix[24] || counter_be_u64`
- `difficulty`: 32-byte big-endian threshold
- Hit rule: the 32-byte Keccak output is lexicographically lower than `difficulty`

The program prints a JSON `found` message to stdout when it finds a nonce:

```json
{"type":"found","nonceHex":"0x...","resultHex":"0x...","counter":"123"}
```

Progress is printed to stderr.

## Requirements

- Windows x64
- A GPU driver with OpenCL 1.2+ support
- CMake 3.20+
- Visual Studio 2022 Build Tools or Visual Studio with C++ desktop workload

NVIDIA, AMD, and Intel GPUs usually expose OpenCL through their normal Windows drivers. If CMake cannot find OpenCL, install the vendor GPU driver or SDK runtime first.

## Build

From the repository root:

```powershell
cmake -S gpu-miner -B gpu-miner/build -G "Visual Studio 17 2022" -A x64
cmake --build gpu-miner/build --config Release
```

The executable will be at:

```text
gpu-miner/build/Release/hash256-gpu-miner.exe
```

## Run

Run from the `gpu-miner` directory so the default kernel path resolves:

```powershell
cd gpu-miner
.\build\Release\hash256-gpu-miner.exe `
  --challenge 0x6c7ee6f1672d8eb5c2f54d6db7d5c0e5b2b7fd55a4f1b71f60d8f669ec8d0201 `
  --difficulty 0x0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff `
  --prefix 0x424242424242424242424242424242420000000100000000
```

Useful tuning flags:

```powershell
--platform 0       # OpenCL platform index
--device 0         # GPU device index within that platform
--global 1048576   # work items per dispatch
--local 256        # work-group size, or 0 to let the driver choose
--start 0          # starting low 64-bit counter
--progress-ms 1000 # stderr progress interval
```

## Relationship to the existing miner

This is only the GPU proof-of-work core. It does not yet connect to the `hash256-mine.mjs master` TCP protocol by itself. Use its stdout `found` JSON as the integration point for a wrapper, or extend the host program to register with the same master protocol.

The prefix must be unique per machine/GPU/run to avoid duplicate nonce ranges. The existing CPU worker builds prefixes from `jobSeedHex`, `agentSlot`, and `threadIndex`; use the same 24-byte prefix scheme if you integrate this with the master.
