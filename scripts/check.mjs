import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
function files(directory) { return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]); }
const scripts = ['src', 'scripts', 'tests'].flatMap(dir => files(path.join(root, dir))).filter(file => /\.m?js$/.test(file));
for (const file of scripts) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${file}`);
  for (const [, relative] of readFileSync(file, 'utf8').matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
    if (!existsSync(path.resolve(path.dirname(file), relative))) throw new Error(`Missing module ${relative} in ${file}`);
  }
}
const html = readFileSync(path.join(root, 'index.html'), 'utf8'), ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
if (new Set(ids).size !== ids.length) throw new Error('Duplicate HTML ids');
for (const [, relative] of html.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g)) if (!existsSync(path.resolve(root, relative))) throw new Error(`Missing HTML asset ${relative}`);
console.log(`Checked ${scripts.length} scripts, local imports, HTML ids and assets.`);
