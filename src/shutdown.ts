/** No implicit deadline: the caller owns the module/child shutdown contract. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS: number | undefined = undefined;

export function validateShutdownTimeout(timeoutMs: number | undefined): void {
  if (timeoutMs === undefined) return;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new RangeError('Shutdown timeout must be an integer from 1 to 2147483647 ms');
  }
}

export class ShutdownTimeoutError extends AggregateError {
  constructor(readonly pending: string[], timeoutMs: number, failures: unknown[]) {
    super([...failures, new Error(`Shutdown timed out after ${timeoutMs} ms; pending: ${pending.join(', ')}`)],
      `Shutdown timed out after ${timeoutMs} ms; pending: ${pending.join(', ')}` +
      (failures.length ? `; failures: ${failures.map(shutdownErrorMessage).join('; ')}` : ''));
    this.name = 'ShutdownTimeoutError';
  }
}

export function shutdownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function waitForShutdown(
  attempts: Array<{ label: string; promise: Promise<void> }>, timeoutMs: number | undefined,
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
    if (timeoutMs === undefined) await settled;
    else await Promise.race([settled, new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new ShutdownTimeoutError(
        [...pending].map(index => attempts[index]!.label), timeoutMs, [...failures.values()],
      )), timeoutMs);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const errors = [...failures.values()];
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors,
    `Shutdown failed: ${errors.map(shutdownErrorMessage).join('; ')}`);
}
