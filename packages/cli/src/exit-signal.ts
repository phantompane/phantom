const exitSignalPatterns = [
  /^Exit with code \d+/,
  /^Process exit with code \d+/,
];

export function isExitSignal(error: unknown): error is Error {
  return (
    error instanceof Error &&
    exitSignalPatterns.some((pattern) => pattern.test(error.message))
  );
}
