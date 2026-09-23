import type { Type } from '@nestjs/common';
import type { HttpRequest } from './http-request.interface.js';

export type HttpHandler = (request: HttpRequest) => Promise<Response>;

export type HttpClientInterceptorFn = (
  request: HttpRequest,
  next: HttpHandler,
) => Promise<Response>;

/** Class form; resolved from the DI container when registered as a type. */
export interface HttpClientInterceptor {
  intercept(request: HttpRequest, next: HttpHandler): Promise<Response>;
}

export type HttpClientInterceptorLike =
  HttpClientInterceptorFn | HttpClientInterceptor | Type<HttpClientInterceptor>;
