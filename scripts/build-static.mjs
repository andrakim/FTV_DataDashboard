import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const dist = path.resolve(root, 'dist');
if (dist !== path.join(root, 'dist') || (existsSync(dist) && lstatSync(dist).isSymbolicLink())) throw new Error('Unsafe output directory');
if (existsSync(dist)) rmSync(dist, { recursive: true });
mkdirSync(dist);
cpSync(path.join(root, 'index.html'), path.join(dist, 'index.html'));
cpSync(path.join(root, 'src'), path.join(dist, 'src'), { recursive: true });
console.log(`Static build ready: ${dist}`);
