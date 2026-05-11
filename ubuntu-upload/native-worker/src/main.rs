use serde::{Deserialize, Serialize};
use std::env;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::process;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};
use tiny_keccak::{Hasher, Keccak};

#[derive(Serialize)]
struct RegisterMessage<'a> {
    r#type: &'static str,
    token: &'a str,
    #[serde(rename = "agentName")]
    agent_name: &'a str,
    threads: usize,
}

#[derive(Serialize)]
struct ProgressMessage<'a> {
    r#type: &'static str,
    #[serde(rename = "jobId")]
    job_id: &'a str,
    #[serde(rename = "hashesDelta")]
    hashes_delta: String,
    hashrate: f64,
}

#[derive(Serialize)]
struct FoundMessage<'a> {
    r#type: &'static str,
    #[serde(rename = "jobId")]
    job_id: &'a str,
    #[serde(rename = "nonceHex")]
    nonce_hex: String,
    #[serde(rename = "resultHex")]
    result_hex: String,
}

#[derive(Deserialize, Debug)]
struct RegisteredMessage {
    #[serde(rename = "agentId")]
    agent_id: String,
    #[serde(rename = "agentSlot")]
    agent_slot: u32,
}

#[derive(Deserialize, Debug, Clone)]
struct JobMessage {
    #[serde(rename = "jobId")]
    job_id: String,
    #[serde(rename = "jobSeedHex")]
    job_seed_hex: String,
    #[serde(rename = "challengeHex")]
    challenge_hex: String,
    #[serde(rename = "difficultyHex")]
    difficulty_hex: String,
    era: String,
    epoch: String,
    #[serde(rename = "epochBlocksLeft")]
    epoch_blocks_left: String,
    #[serde(rename = "batchSize")]
    batch_size: String,
}

#[derive(Deserialize, Debug)]
struct StopMessage {
    #[serde(rename = "jobId")]
    job_id: String,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type")]
enum IncomingMessage {
    #[serde(rename = "registered")]
    Registered(RegisteredMessage),
    #[serde(rename = "job")]
    Job(JobMessage),
    #[serde(rename = "stop")]
    Stop(StopMessage),
}

#[derive(Clone)]
struct SharedConfig {
    master_host: String,
    master_port: u16,
    master_token: String,
    agent_name: String,
    threads: usize,
    batch_size: u64,
}

#[derive(Clone)]
struct JobState {
    job_id: String,
    challenge: [u8; 32],
    difficulty: [u8; 32],
    job_seed: [u8; 16],
}

enum WorkerEvent {
    Progress { hashes: u64, hashrate: f64 },
    Found { nonce_hex: String, result_hex: String },
}

fn parse_hex<const N: usize>(input: &str) -> [u8; N] {
    let clean = input.strip_prefix("0x").unwrap_or(input);
    let bytes = hex::decode(clean).expect("invalid hex");
    let arr: [u8; N] = bytes.try_into().expect("unexpected hex length");
    arr
}

fn prefix_bytes(seed: [u8; 16], slot: u32, thread_index: u32) -> [u8; 24] {
    let mut out = [0u8; 24];
    out[..16].copy_from_slice(&seed);
    out[16..20].copy_from_slice(&slot.to_be_bytes());
    out[20..24].copy_from_slice(&thread_index.to_be_bytes());
    out
}

fn hash_less_than_difficulty(challenge: &[u8; 32], nonce: &[u8; 32], difficulty: &[u8; 32]) -> Option<[u8; 32]> {
    let mut keccak = Keccak::v256();
    let mut result = [0u8; 32];
    keccak.update(challenge);
    keccak.update(nonce);
    keccak.finalize(&mut result);
    if result < *difficulty {
        Some(result)
    } else {
        None
    }
}

fn search_loop(
    challenge: [u8; 32],
    difficulty: [u8; 32],
    prefix: [u8; 24],
    batch_size: u64,
    running: Arc<AtomicBool>,
    sender: mpsc::Sender<WorkerEvent>,
) {
    let mut counter: u64 = 0;

    while running.load(Ordering::Relaxed) {
        let started = Instant::now();
        let mut local_hashes = 0u64;

        for _ in 0..batch_size {
            if !running.load(Ordering::Relaxed) {
                break;
            }

            let mut nonce = [0u8; 32];
            nonce[..24].copy_from_slice(&prefix);
            nonce[24..32].copy_from_slice(&counter.to_be_bytes());

            if let Some(result) = hash_less_than_difficulty(&challenge, &nonce, &difficulty) {
                let _ = sender.send(WorkerEvent::Found {
                    nonce_hex: format!("0x{}", hex::encode(nonce)),
                    result_hex: format!("0x{}", hex::encode(result)),
                });
                running.store(false, Ordering::Relaxed);
                return;
            }

            counter = counter.wrapping_add(1);
            local_hashes += 1;
        }

        let elapsed = started.elapsed().as_secs_f64().max(0.000_001);
        let hashrate = local_hashes as f64 / elapsed;
        let _ = sender.send(WorkerEvent::Progress {
            hashes: local_hashes,
            hashrate,
        });
    }
}

fn worker_count() -> usize {
    match env::var("WORKERS") {
        Ok(value) if value.eq_ignore_ascii_case("auto") => num_cpus::get().max(1),
        Ok(value) => value.parse::<usize>().ok().filter(|v| *v > 0).unwrap_or_else(|| num_cpus::get().max(1)),
        Err(_) => num_cpus::get().max(1),
    }
}

fn batch_size() -> u64 {
    match env::var("BATCH_SIZE") {
        Ok(value) if value.eq_ignore_ascii_case("auto") => 1_000_000,
        Ok(value) => value.parse::<u64>().ok().filter(|v| *v > 0).unwrap_or(1_000_000),
        Err(_) => 1_000_000,
    }
}

fn agent_name() -> String {
    match env::var("AGENT_NAME") {
        Ok(value) if value.eq_ignore_ascii_case("auto") => hostname_string(),
        Ok(value) if !value.is_empty() => value,
        _ => hostname_string(),
    }
}

fn hostname_string() -> String {
    env::var("HOSTNAME").unwrap_or_else(|_| "native-worker".to_string())
}

fn read_config() -> SharedConfig {
    let master_host = env::var("MASTER_PUBLIC_HOST")
        .or_else(|_| env::var("MASTER_HOST"))
        .unwrap_or_else(|_| "127.0.0.1".to_string());
    let master_port = env::var("MASTER_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(7331);
    let master_token = env::var("MASTER_TOKEN").unwrap_or_default();

    SharedConfig {
        master_host,
        master_port,
        master_token,
        agent_name: agent_name(),
        threads: worker_count(),
        batch_size: batch_size(),
    }
}

fn main() {
  loop {
    let config = read_config();
    let address = format!("{}:{}", config.master_host, config.master_port);

    let stream = match TcpStream::connect(&address) {
        Ok(stream) => stream,
        Err(err) => {
            eprintln!("[worker] connection ended: {}", err);
            thread::sleep(Duration::from_secs(5));
            continue;
        }
    };

    stream.set_nodelay(true).ok();
    let mut writer = stream.try_clone().expect("clone writer");
    let reader = BufReader::new(stream);

    let register = RegisterMessage {
        r#type: "register",
        token: &config.master_token,
        agent_name: &config.agent_name,
        threads: config.threads,
    };
    serde_json::to_writer(&mut writer, &register).expect("write register");
    writer.write_all(b"\n").expect("newline");
    writer.flush().ok();

    let mut agent_slot: u32 = 0;
    let mut running = Arc::new(AtomicBool::new(false));
    let mut event_threads: Vec<thread::JoinHandle<()>> = Vec::new();
    let (event_tx, event_rx) = mpsc::channel::<WorkerEvent>();
    let mut current_job_id = String::new();
    let mut local_hashes = Arc::new(AtomicU64::new(0));

    let mut lines = reader.lines();
    while let Some(Ok(line)) = lines.next() {
        if line.trim().is_empty() {
            continue;
        }
        let incoming: IncomingMessage = match serde_json::from_str(&line) {
            Ok(msg) => msg,
            Err(err) => {
                eprintln!("[worker] bad json: {}", err);
                continue;
            }
        };

        match incoming {
            IncomingMessage::Registered(msg) => {
                agent_slot = msg.agent_slot;
                eprintln!("[worker] registered as {}, slot={}", msg.agent_id, msg.agent_slot);
            }
            IncomingMessage::Job(job) => {
                for handle in event_threads.drain(..) {
                    running.store(false, Ordering::Relaxed);
                    let _ = handle.join();
                }

                local_hashes.store(0, Ordering::Relaxed);
                current_job_id = job.job_id.clone();
                let state = JobState {
                    job_id: job.job_id.clone(),
                    challenge: parse_hex::<32>(&job.challenge_hex),
                    difficulty: parse_hex::<32>(&job.difficulty_hex),
                    job_seed: parse_hex::<16>(&job.job_seed_hex),
                };

                eprintln!(
                    "[worker] job={} era={} epoch={} blocksLeft={} threads={}",
                    job.job_id, job.era, job.epoch, job.epoch_blocks_left, config.threads
                );

                running = Arc::new(AtomicBool::new(true));
                for idx in 0..config.threads {
                    let sender = event_tx.clone();
                    let run_flag = running.clone();
                    let prefix = prefix_bytes(state.job_seed, agent_slot, idx as u32);
                    let challenge = state.challenge;
                    let difficulty = state.difficulty;
                    let batch = config.batch_size;
                    event_threads.push(thread::spawn(move || {
                        search_loop(challenge, difficulty, prefix, batch, run_flag, sender);
                    }));
                }

                let mut progress_hashes = 0u64;
                let mut progress_rate = 0.0f64;
                let start = Instant::now();

                while running.load(Ordering::Relaxed) {
                    match event_rx.recv_timeout(Duration::from_secs(1)) {
                        Ok(WorkerEvent::Progress { hashes, hashrate }) => {
                            local_hashes.fetch_add(hashes, Ordering::Relaxed);
                            progress_hashes += hashes;
                            progress_rate += hashrate;
                        }
                        Ok(WorkerEvent::Found { nonce_hex, result_hex }) => {
                            running.store(false, Ordering::Relaxed);
                            let found = FoundMessage {
                                r#type: "found",
                                job_id: &state.job_id,
                                nonce_hex,
                                result_hex,
                            };
                            serde_json::to_writer(&mut writer, &found).ok();
                            writer.write_all(b"\n").ok();
                            writer.flush().ok();
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(_) => break,
                    }

                    if progress_hashes > 0 {
                        let progress = ProgressMessage {
                            r#type: "progress",
                            job_id: &state.job_id,
                            hashes_delta: progress_hashes.to_string(),
                            hashrate: progress_rate.max(0.0),
                        };
                        serde_json::to_writer(&mut writer, &progress).ok();
                        writer.write_all(b"\n").ok();
                        writer.flush().ok();
                        progress_hashes = 0;
                        progress_rate = 0.0;
                    }

                    if start.elapsed() > Duration::from_secs(3600) {
                        break;
                    }
                }

                for handle in event_threads.drain(..) {
                    let _ = handle.join();
                }
            }
            IncomingMessage::Stop(stop) => {
                if stop.job_id == current_job_id {
                    running.store(false, Ordering::Relaxed);
                }
            }
        }
    }
  }
}
