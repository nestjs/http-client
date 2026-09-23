import type { Type } from '@nestjs/common';
import type { HttpClientInterceptor } from '../interfaces/http-client-interceptor.interface.js';
import type {
  HttpClientModuleOptions,
  HttpClientOptions,
} from '../interfaces/http-client-options.interface.js';
import { mergeHeaders } from './headers.util.js';
import { mergeRetry } from './retry.util.js';

/**
 * `forRoot()` defaults under a client's own options: the client's values win,
 * headers and retry settings merge, and global interceptors run first.
 */
export function mergeClientOptions(
  defaults: HttpClientModuleOptions | undefined,
  options: HttpClientOptions,
): HttpClientOptions {
  if (!defaults) return options;
  return {
    ...definedOnly(defaults),
    ...definedOnly(options),
    headers: mergeHeaders(new Headers(), defaults.headers, options.headers),
    retry: mergeRetry(defaults.retry, options.retry),
    interceptors: [
      ...(defaults.interceptors ?? []),
      ...(options.interceptors ?? []),
    ],
  };
}

function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}

/** A class to instantiate, as opposed to a function or an object with `intercept()`. */
export function isInterceptorClass(
  entry: unknown,
): entry is Type<HttpClientInterceptor> {
  return (
    typeof entry === 'function' &&
    typeof entry.prototype?.intercept === 'function'
  );
}

export function checkInterceptor(entry: unknown, index: number): void {
  if (typeof entry === 'function') return;
  if (
    typeof (entry as { intercept?: unknown } | null)?.intercept === 'function'
  )
    return;
  throw new TypeError(
    `HttpClient \`interceptors[${index}]\` is ${entry === null ? 'null' : typeof entry}: expected a ` +
      'function, an object with intercept(), or a class that implements HttpClientInterceptor. ' +
      'An undefined entry usually means a circular import.',
  );
}
