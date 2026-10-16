/**
 * Builds build/summarize/index.js: the Lambda handler with every dependency inside,
 * including the AWS SDK clients, so the bundle doesn't depend on the SDK version the
 * runtime happens to ship. CDK zips build/summarize and uploads it.
 */
import { rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { buildSync } from 'esbuild';

const root = path.join(__dirname, '..');
const outdir = path.join(root, 'build', 'summarize');

rmSync(outdir, { recursive: true, force: true });
const result = buildSync({
  entryPoints: [path.join(root, 'app', 'src', 'summarize.ts')],
  outfile: path.join(outdir, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  minify: true,
  sourcemap: true,
  legalComments: 'none',
  metafile: true,
});

// Kept outside build/summarize so it isn't deployed. The bundle test reads it.
writeFileSync(path.join(root, 'build', 'meta.json'), JSON.stringify(result.metafile));

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`bundled build/summarize/index.js (${(bytes / 1024).toFixed(0)} KiB with source map)`);
