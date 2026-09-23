// Module: app-wide defaults, one client per upstream, injection
export { HttpClientModule } from './http-client.module.js';
export {
  HTTP_CLIENT_MODULE_OPTIONS,
  getHttpClientToken,
  type HttpClientAsyncOptions,
  type HttpClientFactoryOptions,
  type HttpClientModuleFactoryOptions,
  type HttpClientModuleAsyncOptions,
  type HttpClientModuleOptionsFactory,
  type HttpClientOptionsFactory,
} from './http-client.module-definition.js';
export * from './decorators/index.js';

// Client: requests and their options
export { HttpClient } from './http-client.js';
export type {
  HttpBackoffOptions,
  HttpClientModuleOptions,
  HttpClientOptions,
  HttpHeadersInit,
  HttpQuery,
  HttpRequestBody,
  HttpRequestOptions,
  HttpResponse,
  HttpResponseType,
  HttpRetryOptions,
} from './interfaces/index.js';
export type { Duration } from './types/index.js';

// Interceptors: implemented by the app
export type {
  HttpClientInterceptor,
  HttpClientInterceptorFn,
  HttpHandler,
  HttpRequest,
} from './interfaces/index.js';

// Errors: caught by the app, and mapped to Nest exceptions in one place
export * from './errors/index.js';
export {
  toHttpException,
  type ToHttpExceptionOptions,
} from './utils/to-http-exception.util.js';
