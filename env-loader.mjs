import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function parseEnvFile(text) {
  const result = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

export function loadEnvFiles(paths) {
  for (const relativePath of paths) {
    const absolutePath = resolve(relativePath);
    if (!existsSync(absolutePath)) {
      continue;
    }

    const payload = parseEnvFile(readFileSync(absolutePath, "utf8"));
    for (const [key, value] of Object.entries(payload)) {
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
}

export function loadDefaultEnvForCommand(command) {
  const files = [".env"];

  if (command === "master" || command === "status" || command === "wallet") {
    files.push(".env.master");
  } else if (command === "worker") {
    files.push(".env.worker");
  } else if (command === "solo-gpu") {
    files.push(".env.solo-gpu");
  }

  loadEnvFiles(files);
}
