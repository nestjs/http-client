/** Stream bodies passed to fetch so far: a stream can be sent only once. */
const sentStreamBodies = new WeakSet<object>();

/** Throws when a stream body is about to be sent a second time, which would send it empty. */
export function claimStreamBody(body: unknown): void {
  if (isReplayableBody(body)) return;
  if (sentStreamBodies.has(body as object)) {
    throw new TypeError(
      'The request body is a stream that was already sent, and a stream can be sent only once. ' +
        'To send a request again (e.g. from an interceptor, after a 401), give it a string, ' +
        'Buffer, Blob, FormData or URLSearchParams body.',
    );
  }
  sentStreamBodies.add(body as object);
}

/** Stream bodies are consumed by the first attempt and can't be replayed. */
export function isReplayableBody(body: unknown): boolean {
  if (body === null || body === undefined) return true;
  if (
    typeof body === 'string' ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer
  )
    return true;
  if (body instanceof ReadableStream) return false;
  return (
    typeof (body as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] !== 'function'
  );
}
