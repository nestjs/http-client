import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  HttpClient,
  HttpClientModule,
  HTTP_CLIENT_MODULE_OPTIONS,
  InjectHttpClient,
  getHttpClientToken,
  type HttpClientAsyncOptions,
  type HttpClientInterceptor,
  type HttpClientModuleAsyncOptions,
  type HttpClientModuleOptionsFactory,
  type HttpClientOptionsFactory,
  type HttpHandler,
  type HttpRequest,
} from '../lib/index.js';
import { echo, startServer, type TestServer } from './server.js';

type Echo = { url: string; headers: Record<string, string> };

let server: TestServer;
beforeAll(async () => {
  server = await startServer(echo);
});
afterAll(() => server.close());

@Injectable()
class TokenService {
  calls = 0;
  async getToken() {
    return `token-${++this.calls}`;
  }
}

@Module({ providers: [TokenService], exports: [TokenService] })
class AuthModule {}

/** A DI-resolved interceptor: its dependency comes from the container. */
@Injectable()
class AuthInterceptor implements HttpClientInterceptor {
  constructor(private readonly tokens: TokenService) {}

  async intercept(req: HttpRequest, next: HttpHandler) {
    req.headers.set('authorization', `Bearer ${await this.tokens.getToken()}`);
    return next(req);
  }
}

/** Minimal stand-in for @nestjs/config. */
@Injectable()
class ConfigService {
  constructor(private readonly values: Record<string, string>) {}
  get(key: string) {
    return this.values[key];
  }
}

describe('HttpClientModule', () => {
  it('provides named clients from different modules, plus the default client', async () => {
    @Module({
      imports: [
        HttpClientModule.register({
          name: 'github',
          baseUrl: `${server.url}/github`,
        }),
      ],
      exports: [HttpClientModule],
    })
    class GithubModule {}

    @Module({
      imports: [
        HttpClientModule.register({
          name: 'stripe',
          baseUrl: `${server.url}/stripe`,
        }),
      ],
      exports: [HttpClientModule],
    })
    class StripeModule {}

    @Injectable()
    class Consumer {
      constructor(
        readonly http: HttpClient,
        @InjectHttpClient('github') readonly github: HttpClient,
        @InjectHttpClient('stripe') readonly stripe: HttpClient,
      ) {}
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        GithubModule,
        StripeModule,
        HttpClientModule.register({ baseUrl: server.url }),
      ],
      providers: [Consumer],
    }).compile();
    const consumer = moduleRef.get(Consumer);

    expect((await consumer.github.get<Echo>('/repos')).data.url).toBe(
      '/github/repos',
    );
    expect((await consumer.stripe.get<Echo>('/charges')).data.url).toBe(
      '/stripe/charges',
    );
    expect((await consumer.http.get<Echo>('/plain')).data.url).toBe('/plain');
    expect(consumer.github).not.toBe(consumer.stripe);
  });

  it('resolves class interceptors from the container (existing provider)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AuthModule,
        HttpClientModule.register({
          baseUrl: server.url,
          interceptors: [AuthInterceptor],
        }),
      ],
      providers: [AuthInterceptor],
    }).compile();
    const client = moduleRef.get(HttpClient);

    expect((await client.get<Echo>('/')).data.headers.authorization).toBe(
      'Bearer token-1',
    );
    expect((await client.get<Echo>('/')).data.headers.authorization).toBe(
      'Bearer token-2',
    );
    // Same singleton TokenService the rest of the app sees
    expect(moduleRef.get(TokenService).calls).toBe(2);
  });

  it('instantiates class interceptors in the registerAsync imports scope', async () => {
    @Module({
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({ BILLING_URL: `${server.url}/billing` }),
        },
      ],
      exports: [ConfigService],
    })
    class ConfigModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        HttpClientModule.registerAsync({
          name: 'billing',
          interceptors: [AuthInterceptor],
          imports: [ConfigModule, AuthModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            baseUrl: config.get('BILLING_URL'),
            timeout: '1s',
          }),
        }),
      ],
    }).compile();
    const billing = moduleRef.get<HttpClient>(getHttpClientToken('billing'));

    const res = await billing.get<Echo>('/invoices');
    expect(res.data.url).toBe('/billing/invoices');
    expect(res.data.headers.authorization).toBe('Bearer token-1');
  });

  it('applies forRoot() defaults to every client; global interceptors run first', async () => {
    const order: string[] = [];
    const moduleRef = await Test.createTestingModule({
      imports: [
        HttpClientModule.forRoot({
          headers: { 'user-agent': 'nest-app/1.0', 'x-env': 'test' },
          interceptors: [(req, next) => (order.push('global'), next(req))],
        }),
        HttpClientModule.register({
          name: 'api',
          baseUrl: server.url,
          headers: { 'x-env': 'override' },
          interceptors: [(req, next) => (order.push('client'), next(req))],
        }),
      ],
    }).compile();
    const res = await moduleRef
      .get<HttpClient>(getHttpClientToken('api'))
      .get<Echo>('/');

    expect(order).toEqual(['global', 'client']);
    expect(res.data.headers['user-agent']).toBe('nest-app/1.0');
    expect(res.data.headers['x-env']).toBe('override');
  });

  it('is easy to mock: a stub fetch, or overriding the client provider', async () => {
    const stubFetch = vi.fn(async () => Response.json([{ name: 'nest' }]));

    @Injectable()
    class ReposService {
      constructor(
        @InjectHttpClient('github') private readonly github: HttpClient,
      ) {}
      async names() {
        const { data } = await this.github.get<{ name: string }[]>(
          '/orgs/:org/repos',
          {
            params: { org: 'nestjs' },
          },
        );
        return data.map((r) => r.name);
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        HttpClientModule.register({
          name: 'github',
          baseUrl: 'https://api.github.com',
          fetch: stubFetch,
        }),
      ],
      providers: [ReposService],
    }).compile();

    expect(await moduleRef.get(ReposService).names()).toEqual(['nest']);
    expect(String((stubFetch.mock.calls[0] as unknown[])[0])).toBe(
      'https://api.github.com/orgs/nestjs/repos',
    );

    // Alternatively replace the whole client
    const overridden = await Test.createTestingModule({
      imports: [
        HttpClientModule.register({
          name: 'github',
          baseUrl: 'https://api.github.com',
        }),
      ],
      providers: [ReposService],
    })
      .overrideProvider(getHttpClientToken('github'))
      .useValue({ get: async () => ({ data: [{ name: 'mocked' }] }) })
      .compile();
    expect(await overridden.get(ReposService).names()).toEqual(['mocked']);
  });

  it('resolves class interceptors when the app initializes, so a broken one fails at startup', async () => {
    const moduleRef = await Test.createTestingModule({
      // AuthInterceptor needs TokenService, which the client module can't see
      imports: [
        HttpClientModule.register({
          baseUrl: server.url,
          interceptors: [AuthInterceptor],
        }),
      ],
    }).compile();
    await expect(moduleRef.init()).rejects.toThrow(/AuthInterceptor/);
  });

  it('resolves interceptors at init even when the client depends on a service that uses it', async () => {
    // The auth interceptor's service injects the very client the interceptor is attached to
    @Injectable()
    class SelfTokenService {
      constructor(@InjectHttpClient('api') readonly api: HttpClient) {}
    }
    @Injectable()
    class SelfAuthInterceptor implements HttpClientInterceptor {
      constructor(readonly tokens: SelfTokenService) {}
      intercept(req: HttpRequest, next: HttpHandler) {
        req.headers.set('authorization', 'Bearer self');
        return next(req);
      }
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        HttpClientModule.register({
          name: 'api',
          baseUrl: server.url,
          interceptors: [SelfAuthInterceptor],
        }),
      ],
      providers: [SelfTokenService, SelfAuthInterceptor],
    }).compile();
    await moduleRef.init();
    const res = await moduleRef
      .get<HttpClient>(getHttpClientToken('api'))
      .get<Echo>('/');
    expect(res.data.headers.authorization).toBe('Bearer self');
    await moduleRef.close();
  });

  it('stubs fetch for every client with forRoot({ fetch }), keeping their own options', async () => {
    const stubFetch = vi.fn(async () =>
      Response.json({ url: 'stubbed', headers: {} }),
    );
    const ownFetch = vi.fn(async () =>
      Response.json({ url: 'own', headers: {} }),
    );
    const moduleRef = await Test.createTestingModule({
      imports: [
        HttpClientModule.forRoot({ fetch: stubFetch }),
        HttpClientModule.register({
          name: 'github',
          baseUrl: `${server.url}/github`,
          headers: { 'x-client': 'github' },
          interceptors: [AuthInterceptor],
        }),
        HttpClientModule.registerAsync({
          name: 'stripe',
          useFactory: () => ({
            baseUrl: `${server.url}/stripe`,
            fetch: ownFetch,
          }),
        }),
        AuthModule,
      ],
      providers: [AuthInterceptor],
    }).compile();
    await moduleRef.init();

    const github = moduleRef.get<HttpClient>(getHttpClientToken('github'));
    expect((await github.get<Echo>('/repos')).data.url).toBe('stubbed');
    const [url, init] = stubFetch.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(String(url)).toBe(`${server.url}/github/repos`);
    const headers = new Headers(init.headers);
    expect(headers.get('x-client')).toBe('github');
    expect(headers.get('authorization')).toBe('Bearer token-1');
    // A client's own fetch still wins over the default
    const stripe = moduleRef.get<HttpClient>(getHttpClientToken('stripe'));
    expect((await stripe.get<Echo>('/charges')).data.url).toBe('own');
    expect(stubFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps forRoot() interceptors when a test overrides HTTP_CLIENT_MODULE_OPTIONS', async () => {
    const order: string[] = [];
    const stubFetch = vi.fn(async () =>
      Response.json({ url: 'stubbed', headers: {} }),
    );
    const moduleRef = await Test.createTestingModule({
      imports: [
        HttpClientModule.forRoot({
          headers: { 'user-agent': 'nest-app/1.0' },
          interceptors: [(req, next) => (order.push('global'), next(req))],
        }),
        HttpClientModule.register({ baseUrl: server.url }),
      ],
    })
      .overrideProvider(HTTP_CLIENT_MODULE_OPTIONS)
      .useValue({ fetch: stubFetch })
      .compile();

    expect((await moduleRef.get(HttpClient).get<Echo>('/')).data.url).toBe(
      'stubbed',
    );
    expect(order).toEqual(['global']);
  });

  it('configures defaults from DI with forRootAsync(); interceptors sit next to useFactory', async () => {
    @Module({
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({ APP_NAME: 'acme' }),
        },
      ],
      exports: [ConfigService],
    })
    class ConfigModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        AuthModule,
        HttpClientModule.forRootAsync({
          interceptors: [AuthInterceptor],
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            headers: { 'user-agent': `${config.get('APP_NAME')}/1.0` },
            timeout: '2s',
            retry: false,
          }),
        }),
        HttpClientModule.register({ baseUrl: server.url }),
      ],
      providers: [AuthInterceptor],
    }).compile();
    await moduleRef.init();

    const res = await moduleRef.get(HttpClient).get<Echo>('/');
    expect(res.data.headers['user-agent']).toBe('acme/1.0');
    expect(res.data.headers.authorization).toBe('Bearer token-1');
  });

  it('an async factory may return interceptor instances and functions built from its injections', async () => {
    @Module({
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({ APP_NAME: 'acme', API_KEY: 'k-123' }),
        },
      ],
      exports: [ConfigService],
    })
    class ConfigModule {}

    /** Needs a value from the config, not a provider: built by the factory. */
    class ApiKeyInterceptor implements HttpClientInterceptor {
      constructor(private readonly key: string) {}
      intercept(req: HttpRequest, next: HttpHandler) {
        req.headers.set('x-api-key', this.key);
        return next(req);
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        HttpClientModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            interceptors: [
              (req, next) => (
                req.headers.set('x-app', config.get('APP_NAME')),
                next(req)
              ),
            ],
          }),
        }),
        HttpClientModule.registerAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            baseUrl: server.url,
            interceptors: [new ApiKeyInterceptor(config.get('API_KEY'))],
          }),
        }),
      ],
    }).compile();
    await moduleRef.init();

    const res = await moduleRef.get(HttpClient).get<Echo>('/');
    expect(res.data.headers['x-app']).toBe('acme');
    expect(res.data.headers['x-api-key']).toBe('k-123');
  });

  it('takes an options factory class: createHttpClientOptions() and createHttpClientModuleOptions()', async () => {
    @Module({
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({ BILLING_URL: `${server.url}/billing` }),
        },
      ],
      exports: [ConfigService],
    })
    class ConfigModule {}

    @Injectable()
    class BillingClientOptions implements HttpClientOptionsFactory {
      constructor(private readonly config: ConfigService) {}
      createHttpClientOptions() {
        return {
          baseUrl: this.config.get('BILLING_URL'),
          headers: { 'x-client': 'billing' },
        };
      }
    }

    @Injectable()
    class HttpDefaults implements HttpClientModuleOptionsFactory {
      createHttpClientModuleOptions() {
        return { headers: { 'user-agent': 'acme/2.0' } };
      }
    }

    // What a library that wraps the module would accept and pass on
    const billing: HttpClientAsyncOptions = {
      name: 'billing',
      interceptors: [AuthInterceptor],
      imports: [ConfigModule, AuthModule],
      useClass: BillingClientOptions,
    };
    const defaults: HttpClientModuleAsyncOptions = { useClass: HttpDefaults };

    const moduleRef = await Test.createTestingModule({
      imports: [
        HttpClientModule.forRootAsync(defaults),
        HttpClientModule.registerAsync(billing),
      ],
    }).compile();
    await moduleRef.init();

    const res = await moduleRef
      .get<HttpClient>(getHttpClientToken('billing'))
      .get<Echo>('/invoices');
    expect(res.data.url).toBe('/billing/invoices');
    expect(res.data.headers).toMatchObject({
      'x-client': 'billing',
      'user-agent': 'acme/2.0',
      authorization: 'Bearer token-1',
    });
  });

  it('fails at startup when an async factory returns an interceptor class', async () => {
    const client = await Test.createTestingModule({
      imports: [
        HttpClientModule.registerAsync({
          name: 'billing',
          // @ts-expect-error: the factory returns instances and functions; classes go next to it
          useFactory: () => ({
            baseUrl: server.url,
            interceptors: [AuthInterceptor],
          }),
        }),
      ],
    })
      .compile()
      .catch((error: unknown) => error);
    expect(String(client)).toContain(
      'HttpClientModule.registerAsync(): the factory returned the class AuthInterceptor in ' +
        '`interceptors`. Classes go at the top level, next to useFactory/useClass, so Nest can ' +
        'create them with their dependencies. The factory may return instances and functions.',
    );

    // forRoot()'s factory result is checked even when no client is registered
    const root = await Test.createTestingModule({
      imports: [
        HttpClientModule.forRootAsync({
          // @ts-expect-error: the factory returns instances and functions; classes go next to it
          useFactory: () => ({ interceptors: [AuthInterceptor] }),
        }),
      ],
    })
      .compile()
      .catch((error: unknown) => error);
    expect(String(root)).toContain(
      'HttpClientModule.forRootAsync(): the factory returned the class AuthInterceptor in `interceptors`.',
    );
  });

  it('fails at startup when interceptors are set both next to useFactory and in its result', async () => {
    const fn = (req: HttpRequest, next: HttpHandler) => next(req);
    for (const [method, module] of [
      [
        'registerAsync',
        HttpClientModule.registerAsync({
          interceptors: [AuthInterceptor],
          useFactory: () => ({ baseUrl: server.url, interceptors: [fn] }),
        }),
      ],
      [
        'forRootAsync',
        HttpClientModule.forRootAsync({
          interceptors: [AuthInterceptor],
          useFactory: () => ({ interceptors: [fn] }),
        }),
      ],
    ] as const) {
      const result = await Test.createTestingModule({ imports: [module] })
        .compile()
        .catch((error: unknown) => error);
      expect(String(result)).toContain(
        `HttpClientModule.${method}(): \`interceptors\` is set both next to useFactory/useClass ` +
          'and in the options they return. Set it in one place.',
      );
    }
  });

  it('register() takes imports, for interceptor classes that are not providers', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        HttpClientModule.register({
          baseUrl: server.url,
          interceptors: [AuthInterceptor],
          imports: [AuthModule],
        }),
      ],
    }).compile();
    await moduleRef.init();

    const res = await moduleRef.get(HttpClient).get<Echo>('/');
    expect(res.data.headers.authorization).toBe('Bearer token-1');
  });

  it('forRoot() and forRootAsync() create their interceptor classes with their own imports', async () => {
    for (const root of [
      HttpClientModule.forRoot({
        imports: [AuthModule],
        interceptors: [AuthInterceptor],
      }),
      HttpClientModule.forRootAsync({
        imports: [AuthModule],
        interceptors: [AuthInterceptor],
        useFactory: () => ({ timeout: '1s' }),
      }),
    ]) {
      const moduleRef = await Test.createTestingModule({
        imports: [
          root,
          HttpClientModule.register({ name: 'api', baseUrl: server.url }),
        ],
      }).compile();
      await moduleRef.init();

      const res = await moduleRef
        .get<HttpClient>(getHttpClientToken('api'))
        .get<Echo>('/');
      expect(res.data.headers.authorization).toBe('Bearer token-1');
    }

    // Without them, the class can't be created: the client's module doesn't see AuthModule either
    const moduleRef = await Test.createTestingModule({
      imports: [
        HttpClientModule.forRoot({ interceptors: [AuthInterceptor] }),
        HttpClientModule.register({ baseUrl: server.url }),
      ],
    }).compile();
    await expect(moduleRef.init()).rejects.toThrow(
      /can't resolve dependencies of the AuthInterceptor/,
    );
  });

  it('overriding HTTP_CLIENT_MODULE_OPTIONS drops interceptors the factory returned, not top-level ones', async () => {
    const order: string[] = [];
    const stubFetch = vi.fn(async () =>
      Response.json({ url: 'stubbed', headers: {} }),
    );
    const moduleRef = await Test.createTestingModule({
      imports: [
        HttpClientModule.forRootAsync({
          interceptors: [(req, next) => (order.push('top-level'), next(req))],
          useFactory: () => ({ retry: false }),
        }),
        HttpClientModule.register({ baseUrl: server.url }),
      ],
    })
      .overrideProvider(HTTP_CLIENT_MODULE_OPTIONS)
      .useValue({ fetch: stubFetch })
      .compile();
    await moduleRef.get(HttpClient).get<Echo>('/');
    expect(order).toEqual(['top-level']);

    const fromFactory = await Test.createTestingModule({
      imports: [
        HttpClientModule.forRootAsync({
          useFactory: () => ({
            interceptors: [(req, next) => (order.push('factory'), next(req))],
          }),
        }),
        HttpClientModule.register({ baseUrl: server.url }),
      ],
    })
      .overrideProvider(HTTP_CLIENT_MODULE_OPTIONS)
      .useValue({ fetch: stubFetch })
      .compile();
    await fromFactory.get(HttpClient).get<Echo>('/');
    expect(order).toEqual(['top-level']); // the factory, and its interceptors, never ran
  });

  it('fails at startup on an invalid duration, naming the option', async () => {
    const result = await Test.createTestingModule({
      imports: [
        HttpClientModule.registerAsync({
          useFactory: () => ({
            baseUrl: server.url,
            timeout: '30 sec' as '30s',
          }),
        }),
      ],
    })
      .compile()
      .catch((error: unknown) => error);
    expect(String(result)).toContain(
      'HttpClient `timeout`: Invalid duration "30 sec"',
    );
  });
});
