/**
 * Represents a value that is either successful (Ok) or contains an error (Err).
 * This type is inspired by Rust's Result type and provides type-safe error handling.
 *
 * @template T - The type of the success value
 * @template E - The type of the error value (defaults to Error)
 */
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/**
 * Creates a successful Result containing the given value.
 *
 * @template T - The type of the success value
 * @param value - The success value to wrap
 * @returns A Result in the Ok state containing the value
 *
 * @example
 * const result = ok(42);
 * // result: Result<number, never> = { ok: true, value: 42 }
 */
export const ok = <T>(value: T): Result<T, never> => ({
  ok: true,
  value,
});

/**
 * Creates a failed Result containing the given error.
 *
 * @template E - The type of the error value
 * @param error - The error value to wrap
 * @returns A Result in the Err state containing the error
 *
 * @example
 * const result = err(new Error("Something went wrong"));
 * // result: Result<never, Error> = { ok: false, error: Error(...) }
 */
export const err = <E>(error: E): Result<never, E> => ({
  ok: false,
  error,
});

/**
 * Type guard that checks if a Result is in the Ok state.
 *
 * @template T - The type of the success value
 * @template E - The type of the error value
 * @param result - The Result to check
 * @returns True if the Result is Ok, false otherwise
 *
 * @example
 * if (isOk(result)) {
 *   console.log(result.value); // TypeScript knows result.value exists
 * }
 */
export const isOk = <T, E>(
  result: Result<T, E>,
): result is { ok: true; value: T } => result.ok;

/**
 * Type guard that checks if a Result is in the Err state.
 *
 * @template T - The type of the success value
 * @template E - The type of the error value
 * @param result - The Result to check
 * @returns True if the Result is Err, false otherwise
 *
 * @example
 * if (isErr(result)) {
 *   console.error(result.error); // TypeScript knows result.error exists
 * }
 */
export const isErr = <T, E>(
  result: Result<T, E>,
): result is { ok: false; error: E } => !result.ok;
