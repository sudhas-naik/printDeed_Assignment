import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { createAccount, getAccountBalance } from "./accounts.js";
import { AppError, errorBody } from "./errors.js";
import { hashApiKey } from "./db.js";
import { Money } from "./money.js";
import { createTransfer, getTransfer } from "./transfers.js";
import { isUuid } from "./uuid.js";

export type AppDeps = {
  pool: pg.Pool;
  apiKeys: Set<string>;
};

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(errorBody(err.code, err.message));
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      const message = err instanceof Error ? err.message : "invalid request";
      return reply.status(status).send(errorBody("VALIDATION_ERROR", message));
    }
    app.log.error(err);
    return reply.status(500).send(errorBody("INTERNAL_ERROR", "internal error"));
  });

  app.get("/health", async () => ({ ok: true }));

  app.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (path === "/health" || req.method === "OPTIONS") {
      return;
    }
    const key = req.headers["x-api-key"];
    if (typeof key !== "string" || !deps.apiKeys.has(key)) {
      return reply
        .status(401)
        .send(errorBody("UNAUTHORIZED", "missing or invalid X-API-Key"));
    }
    (req as typeof req & { callerId: string }).callerId = hashApiKey(key);
  });

  app.post("/accounts", async (req, reply) => {
    const body = asObject(req.body);
    const currency = typeof body.currency === "string" ? body.currency : "USD";
    const account = await createAccount(deps.pool, {
      currency,
      initialBalance: Money.parseBalance(body.initial_balance ?? "0.00"),
    });
    return reply.status(201).send(account);
  });

  app.get("/accounts/:id/balance", async (req, reply) => {
    const { id } = req.params as { id: string };
    requireUuid(id, "account id");
    const account = await getAccountBalance(deps.pool, id);
    return reply.status(200).send({
      account_id: account.id,
      balance: account.balance,
      currency: account.currency,
    });
  });

  app.post("/transfers", async (req, reply) => {
    const idempotencyKey = req.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key header is required",
      );
    }
    const body = asObject(req.body);
    const fromAccountId = stringField(body, "from_account_id");
    const toAccountId = stringField(body, "to_account_id");
    requireUuid(fromAccountId, "from_account_id");
    requireUuid(toAccountId, "to_account_id");
    const currency = typeof body.currency === "string" ? body.currency : "";
    if (!currency) {
      throw new AppError(400, "VALIDATION_ERROR", "currency is required");
    }

    const callerId = (req as typeof req & { callerId: string }).callerId;
    const { transfer, replayed } = await createTransfer(
      deps.pool,
      callerId,
      idempotencyKey,
      {
        fromAccountId,
        toAccountId,
        amount: Money.parse(body.amount),
        currency,
      },
    );
    return reply.status(replayed ? 200 : 201).send(transfer);
  });

  app.get("/transfers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    requireUuid(id, "transfer id");
    const callerId = (req as typeof req & { callerId: string }).callerId;
    const transfer = await getTransfer(deps.pool, callerId, id);
    return reply.status(200).send(transfer);
  });

  return app;
}

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, "VALIDATION_ERROR", "JSON object body is required");
  }
  return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", `${name} is required`);
  }
  return value;
}

function requireUuid(value: string, name: string): void {
  if (!isUuid(value)) {
    throw new AppError(400, "VALIDATION_ERROR", `${name} must be a UUID`);
  }
}
