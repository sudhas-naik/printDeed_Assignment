import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_DATABASE_URL =
  "postgres://transfer:transfer@localhost:15432/transfer";

export function loadConfig() {
  loadDotEnv();
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const apiKeys = (process.env.API_KEYS ?? "dev-secret-key")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (apiKeys.length === 0) {
    throw new Error("API_KEYS must contain at least one key");
  }
  return {
    port: Number(process.env.PORT ?? 3000),
    databaseUrl,
    apiKeys,
  };
}

function loadDotEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) {
    return;
  }
  const text = readFileSync(path, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export type Config = ReturnType<typeof loadConfig>;
