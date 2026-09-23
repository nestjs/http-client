export type Timer = { signal: AbortSignal; clear(): void };

export function createTimer(ms: number | undefined): Timer | undefined {
  if (!ms) return undefined;
  const controller = new AbortController();
  const handle = setTimeout(
    () =>
      controller.abort(
        new DOMException(`Timed out after ${ms}ms`, 'TimeoutError'),
      ),
    ms,
  );
  return { signal: controller.signal, clear: () => clearTimeout(handle) };
}

export function anySignal(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => !!s);
  if (present.length === 0) return new AbortController().signal;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The longest delay `setTimeout` supports (about 24.8 days); longer ones fire at once. */
export const MAX_TIMER_MS = 2_147_483_647;
