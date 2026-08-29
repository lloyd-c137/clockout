import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app/src/App.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../app/src/styles.css', import.meta.url), 'utf8');

assert.match(main, /MINI_SIZE = \{ width: 228, height: 60 \}/);
assert.match(main, /BOARD_SIZE = \{ width: 520, height: 320 \}/);
assert.match(main, /DETAIL_SIZE = \{ width: 1040, height: 720 \}/);
assert.match(app, /type Mode = 'mini' \| 'board' \| 'detail'/);
assert.match(app, /mode === 'mini' \? miniWidget : mode === 'board' \? boardWidget/);
assert.match(preload, /quit: \(\) => ipcRenderer\.send\('app:quit'\)/);
assert.match(main, /ipcMain\.on\('app:quit'/);
assert.match(css, /\.mini-clock-shell/);
assert.match(css, /\.tetris-board-widget/);
assert.match(css, /\.detail-shell/);
assert.equal((app.match(/<WindowControls/g) || []).length, 3);

console.log('window-mode-tests: 11/11 passed');
