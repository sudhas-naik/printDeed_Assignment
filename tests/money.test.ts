import { describe, expect, it } from "vitest";
import { Money } from "../src/money.js";

describe("Money", () => {
  it("parses decimal strings into integer cents", () => {
    expect(Money.parse("10.50").cents).toBe(1050n);
    expect(Money.parse("10").cents).toBe(1000n);
    expect(Money.parse("0.01").cents).toBe(1n);
    expect(Money.parse("10.5").cents).toBe(1050n);
    expect(Money.parse("10.50").toDecimalString()).toBe("10.50");
  });

  it("rejects JSON numbers so floats cannot enter the system", () => {
    expect(() => Money.parse(10.5)).toThrow(/decimal string/);
  });

  it("rejects more than two decimal places", () => {
    expect(() => Money.parse("10.123")).toThrow(/two places/);
  });

  it("rejects zero and negative amounts for transfers", () => {
    expect(() => Money.parse("0")).toThrow(/greater than zero/);
    expect(() => Money.parse("0.00")).toThrow(/greater than zero/);
    expect(() => Money.parse("-1.00")).toThrow(/two places/);
  });
});
