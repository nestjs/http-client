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
export { InjectHttpClient } from './inject-http-client.decorator.js';

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
} from './http-client.options.js';
export type { Duration } from './duration.js';

// Interceptors: implemented by the app
export type {
  HttpClientInterceptor,
  HttpClientInterceptorFn,
  HttpHandler,
  HttpRequest,
} from './http-client.options.js';

// Errors: caught by the app, and mapped to Nest exceptions in one place
export {
  HttpClientError,
  HttpNetworkError,
  HttpParseError,
  HttpResponseError,
  HttpTimeoutError,
} from './http-client.errors.js';
export {
  toHttpException,
  type ToHttpExceptionOptions,
} from './to-http-exception.js';
