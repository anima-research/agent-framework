/** Bounds observation without cancelling teardown or losing later rejections. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

export function validateShutdownTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new RangeError('Shutdown timeout must be an integer from 1 to 2147483647 ms');
  }
}

export class ShutdownTimeoutError extends AggregateError {
  constructor(readonly pending: string[], timeoutMs: number, failures: unknown[]) {
    super([...failures, new Error(`Shutdown timed out after ${timeoutMs} ms; pending: ${pending.join(', ')}`)],
      `Shutdown timed out after ${timeoutMs} ms; pending: ${pending.join(', ')}`);
    this.name = 'ShutdownTimeoutError';
  }
}

export async function waitForShutdown(
  attempts: Array<{ label: string; promise: Promise<void> }>, timeoutMs: number,
): Promise<void> {
  validateShutdownTimeout(timeoutMs);
  const pending = new Set(attempts.map((_, index) => index));
  const failures = new Map<number, unknown>();
  const settled = Promise.all(attempts.map(({ promise }, index) => promise.then(
    () => { pending.delete(index); },
    error => { failures.set(index, error); pending.delete(index); },
  )));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([settled, new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new ShutdownTimeoutError(
        [...pending].map(index => attempts[index]!.label), timeoutMs, [...failures.values()],
      )), timeoutMs);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const errors = [...failures.values()];
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Shutdown failed');
}
