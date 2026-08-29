import { cpSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const demoAssets = resolve(root, 'assets');
if (existsSync(demoAssets)) rmSync(demoAssets, { recursive: true, force: true });
copyFileSync(resolve(root, 'dist/index.html'), resolve(root, 'index.html'));
cpSync(resolve(root, 'dist/assets'), demoAssets, { recursive: true });
