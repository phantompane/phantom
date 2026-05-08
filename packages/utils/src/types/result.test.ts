import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "vitest";
import { err, isErr, isOk, ok } from "./result.ts";

describe("Result type", () => {
  describe("ok", () => {
    it("should create an Ok result", () => {
      const result = ok(42);
      deepStrictEqual(result, { ok: true, value: 42 });
    });
  });

  describe("err", () => {
    it("should create an Err result", () => {
      const error = new Error("Something went wrong");
      const result = err(error);
      deepStrictEqual(result, { ok: false, error });
    });
  });

  describe("isOk", () => {
    it("should return true for Ok result", () => {
      const result = ok(42);
      strictEqual(isOk(result), true);
    });

    it("should return false for Err result", () => {
      const result = err(new Error("Error"));
      strictEqual(isOk(result), false);
    });
  });

  describe("isErr", () => {
    it("should return true for Err result", () => {
      const result = err(new Error("Error"));
      strictEqual(isErr(result), true);
    });

    it("should return false for Ok result", () => {
      const result = ok(42);
      strictEqual(isErr(result), false);
    });
  });
});
