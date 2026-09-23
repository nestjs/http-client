import { Inject } from '@nestjs/common';
import { getHttpClientToken } from '../http-client.module-definition.js';

/** `@InjectHttpClient('github')`; without a name, same as typing the param as `HttpClient`. */
export const InjectHttpClient = (name?: string) =>
  Inject(getHttpClientToken(name));
