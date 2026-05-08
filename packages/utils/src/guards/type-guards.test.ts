import assert from "node:assert";
import { describe, test } from "vitest";
import { isObject } from "./type-guards.ts";

describe("isObject", () => {
  test("should return true for plain objects", () => {
    assert.strictEqual(isObject({}), true);
    assert.strictEqual(isObject({ a: 1 }), true);
    assert.strictEqual(isObject({ nested: { object: true } }), true);
  });

  test("should return false for arrays", () => {
    assert.strictEqual(isObject([]), false);
    assert.strictEqual(isObject([1, 2, 3]), false);
    assert.strictEqual(isObject(["a", "b", "c"]), false);
  });

  test("should return false for null", () => {
    assert.strictEqual(isObject(null), false);
  });

  test("should return false for undefined", () => {
    assert.strictEqual(isObject(undefined), false);
  });

  test("should return false for primitives", () => {
    assert.strictEqual(isObject("string"), false);
    assert.strictEqual(isObject(123), false);
    assert.strictEqual(isObject(true), false);
    assert.strictEqual(isObject(false), false);
    assert.strictEqual(isObject(Symbol("test")), false);
    assert.strictEqual(isObject(BigInt(123)), false);
  });

  test("should return true for objects created with Object.create", () => {
    assert.strictEqual(isObject(Object.create(null)), true);
    assert.strictEqual(isObject(Object.create({})), true);
  });

  test("should return true for class instances", () => {
    class TestClass {
      value: unknown;
      constructor(value: unknown) {
        this.value = value;
      }
    }
    assert.strictEqual(isObject(new TestClass(42)), true);
  });

  test("should return false for functions", () => {
    assert.strictEqual(
      isObject(() => {}),
      false,
    );
    assert.strictEqual(
      isObject(() => {}),
      false,
    );
    assert.strictEqual(
      isObject(async () => {}),
      false,
    );
    assert.strictEqual(isObject(class {}), false);
  });

  test("should return true for built-in objects", () => {
    assert.strictEqual(isObject(new Date()), true);
    assert.strictEqual(isObject(new Map()), true);
    assert.strictEqual(isObject(new Set()), true);
    assert.strictEqual(isObject(/regex/), true);
    assert.strictEqual(isObject(new Error()), true);
  });
});
