/**
 * Compile-only: `tsc -p tsconfig.json` checks this file with
 * `exactOptionalPropertyTypes`, and nothing runs it. The runtime treats an
 * explicit `undefined` option as "not set", so every optional field of a
 * public option type must accept `undefined` too.
 */
import type {
  HttpBackoffOptions,
  HttpClientFactoryOptions,
  HttpClientModuleFactoryOptions,
  HttpClientModuleOptions,
  HttpClientOptions,
  HttpRequestOptions,
  HttpResponseErrorInit,
  HttpRetryOptions,
  ToHttpExceptionOptions,
} from '../lib/index.js';
import type { HttpClientRegisterOptions } from '../lib/http-client.module-definition.js';

/** The keys of `T` that reject `undefined`; `never` when every field accepts it. */
type RejectsUndefined<T> = {
  [K in keyof T]-?: { [P in K]: undefined } extends Pick<T, K> ? never : K;
}[keyof T];
type None<T extends never> = T;

export type Checked = [
  None<RejectsUndefined<HttpClientOptions>>,
  None<RejectsUndefined<HttpClientModuleOptions>>,
  None<RejectsUndefined<HttpRequestOptions>>,
  None<RejectsUndefined<HttpRetryOptions>>,
  None<RejectsUndefined<HttpBackoffOptions>>,
  None<RejectsUndefined<HttpClientRegisterOptions>>,
  None<RejectsUndefined<HttpClientFactoryOptions>>,
  None<RejectsUndefined<HttpClientModuleFactoryOptions>>,
  None<RejectsUndefined<ToHttpExceptionOptions>>,
  None<
    Exclude<
      RejectsUndefined<HttpResponseErrorInit>,
      'method' | 'url' | 'status'
    >
  >,
];
