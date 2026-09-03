export type ErrorCode =
  | "UNAUTHORIZED"
  | "VALIDATION_ERROR"
  | "ACCOUNT_NOT_FOUND"
  | "TRANSFER_NOT_FOUND"
  | "INSUFFICIENT_FUNDS"
  | "UNSUPPORTED_CURRENCY"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "CONFLICT"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorBody(code: ErrorCode, message: string) {
  return { error: { code, message } };
}
