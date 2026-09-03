export function loadConfig() {
  const databaseUrl = required("DATABASE_URL");
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

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export type Config = ReturnType<typeof loadConfig>;
