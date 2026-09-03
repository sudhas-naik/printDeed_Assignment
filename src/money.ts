import { AppError } from "./errors.js";

const AMOUNT_RE = /^(0|[1-9]\d*)(\.\d{1,2})?$/;

/**
 * USD amounts as integer cents. Parsing never goes through Number/float.
 * JSON numbers are rejected at the HTTP boundary so IEEE-754 cannot sneak in.
 */
export class Money {
  private constructor(public readonly cents: bigint) {}

  static fromCents(cents: bigint): Money {
    return new Money(cents);
  }

  static parse(amount: unknown): Money {
    if (typeof amount === "number") {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "amount must be a decimal string (e.g. \"10.50\"), not a JSON number",
      );
    }
    if (typeof amount !== "string" || !AMOUNT_RE.test(amount)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "amount must be a non-negative decimal string with at most two places",
      );
    }

    const [wholeRaw, fracRaw = ""] = amount.split(".");
    const whole = BigInt(wholeRaw!);
    const frac = BigInt((fracRaw + "00").slice(0, 2));
    const cents = whole * 100n + frac;
    if (cents <= 0n) {
      throw new AppError(400, "VALIDATION_ERROR", "amount must be greater than zero");
    }
    return new Money(cents);
  }

  static parseBalance(amount: unknown): Money {
    if (typeof amount === "number") {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "initial_balance must be a decimal string (e.g. \"10.50\"), not a JSON number",
      );
    }
    if (typeof amount !== "string" || !AMOUNT_RE.test(amount)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "initial_balance must be a non-negative decimal string with at most two places",
      );
    }
    const [wholeRaw, fracRaw = ""] = amount.split(".");
    const whole = BigInt(wholeRaw!);
    const frac = BigInt((fracRaw + "00").slice(0, 2));
    return new Money(whole * 100n + frac);
  }

  toDecimalString(): string {
    const negative = this.cents < 0n;
    const abs = negative ? -this.cents : this.cents;
    const whole = abs / 100n;
    const frac = abs % 100n;
    return `${negative ? "-" : ""}${whole}.${frac.toString().padStart(2, "0")}`;
  }
}
