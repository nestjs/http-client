import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(projectRoot, 'dist');
const entry = join(distDir, 'index.js');

const packageJson = JSON.parse(
  readFileSync(join(projectRoot, 'package.json'), 'utf8'),
);

const RUNTIME_EXPORTS = [
  'HTTP_CLIENT_MODULE_OPTIONS',
  'HttpClient',
  'HttpClientError',
  'HttpClientModule',
  'HttpNetworkError',
  'HttpParseError',
  'HttpResponseError',
  'HttpTimeoutError',
  'InjectHttpClient',
  'getHttpClientToken',
  'toHttpException',
];

/**
 * The packaging contract: the emitted entry points exist where package.json
 * advertises them, relative specifiers keep their extensions, and the entry
 * loads in a real Node process, from ESM and from CommonJS (`require()` of an
 * ES module, which Nest 11 applications compiled to CommonJS rely on).
 */
describe('Packaging', () => {
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
  }, 120_000);

  it('declares itself as an ES module', () => {
    expect(packageJson.type).toBe('module');
  });

  it('points main, types and exports at files that exist', async () => {
    const targets = [
      packageJson.main,
      packageJson.types,
      packageJson.exports['.'].types,
      packageJson.exports['.'].import,
      packageJson.exports['.'].default,
    ];
    for (const target of targets) {
      expect(target).toBeTypeOf('string');
      await expect(
        access(resolve(projectRoot, target)),
      ).resolves.toBeUndefined();
    }
  });

  it('emits relative specifiers with explicit .js extensions', () => {
    const source = readFileSync(entry, 'utf8');
    const specifiers = [...source.matchAll(/from\s+'(\.[^']*)'/g)].map(
      (m) => m[1],
    );
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).toMatch(/\.js$/);
    }
  });

  it('publishes types that need neither the DOM lib nor undici', () => {
    const offending = readdirSync(distDir)
      .filter((file) => file.endsWith('.d.ts'))
      .filter((file) =>
        /\bBodyInit\b|from ['"]undici/.test(
          readFileSync(join(distDir, file), 'utf8'),
        ),
      );
    expect(offending).toEqual([]);
  });

  it('loads the built entry point in a real Node ESM context', async () => {
    const loaded = await import(/* @vite-ignore */ pathToFileURL(entry).href);
    expect(Object.keys(loaded).sort()).toEqual(RUNTIME_EXPORTS);
  });

  it('loads through Node without vitest, from ESM and from CommonJS', () => {
    const check = `
      if (typeof HttpClientModule.forRoot !== 'function') throw new Error('forRoot missing');
      if (HttpClientModule.register({ name: 'api', baseUrl: 'https://example.com' }).module !== HttpClientModule) throw new Error('bad dynamic module');
      console.log('ok');
    `;
    const esm = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import 'reflect-metadata'; const { HttpClientModule } = await import(${JSON.stringify(pathToFileURL(entry).href)}); ${check}`,
      ],
      { cwd: projectRoot, encoding: 'utf8' },
    );
    expect(esm.trim()).toBe('ok');

    const cjs = execFileSync(
      process.execPath,
      [
        '--input-type=commonjs',
        '--eval',
        `require('reflect-metadata'); const { HttpClientModule } = require(${JSON.stringify(entry)}); ${check}`,
      ],
      { cwd: projectRoot, encoding: 'utf8' },
    );
    expect(cjs.trim()).toBe('ok');
  });
});
