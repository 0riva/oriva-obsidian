import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'main.js',
  bundle: true,
  format: 'cjs',
  target: 'es2020',
  platform: 'browser',
  external: ['obsidian', 'electron'],
  logLevel: 'info',
});
