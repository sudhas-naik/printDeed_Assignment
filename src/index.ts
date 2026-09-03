import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { buildApp } from "./app.js";

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await migrate(pool);
  const app = await buildApp({
    pool,
    apiKeys: new Set(config.apiKeys),
  });
  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`money-transfer-api listening on :${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
