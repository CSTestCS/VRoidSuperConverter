// Bundles the renderer (src/ui/main.js) and copies static files to dist/.
import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/ui/main.js'],
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  outfile: 'dist/app.js',
  sourcemap: true,
  minify: process.argv.includes('--minify'),
  logLevel: 'info',
});
await copyFile('src/index.html', 'dist/index.html');
await copyFile('src/styles.css', 'dist/styles.css');
