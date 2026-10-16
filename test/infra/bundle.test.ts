/**
 * The function ships as one esbuild file. Check it has nothing left to install and that
 * Node can load it and find the handler.
 */
import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import { BUNDLE_DIR } from '../../infra/lib/nightly-stack';

test('index.js sits at the package root, with only its source map beside it', () => {
  expect(fs.readdirSync(BUNDLE_DIR).sort()).toEqual(['index.js', 'index.js.map']);
});

test('the bundle imports nothing outside Node.js itself', () => {
  // esbuild's metafile lists every import it left unbundled. Only Node built-ins may remain.
  const meta = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, '..', 'meta.json'), 'utf8')) as {
    outputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
  };
  const builtins = new Set(builtinModules);
  const external = Object.values(meta.outputs)
    .flatMap((o) => o.imports)
    .filter((i) => i.external)
    .map((i) => i.path.replace(/^node:/, ''))
    .filter((p) => !builtins.has(p));
  expect([...new Set(external)]).toEqual([]);
});

test('Node loads the bundle and finds the handler', () => {
  const mod = require(path.join(BUNDLE_DIR, 'index.js')) as { handler?: unknown };
  expect(typeof mod.handler).toBe('function');
});
