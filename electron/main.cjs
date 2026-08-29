const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell } = require('electron');
const { DatabaseSync } = require('node:sqlite');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MINI_SIZE = { width: 228, height: 60 };
const BOARD_SIZE = { width: 520, height: 320 };
const DETAIL_SIZE = { width: 1040, height: 720 };
const ADMIN_PORT = 50831;
const SLOT_MINUTES = 15;
const DEFAULT_HOURLY_WAGE = 60;
const DEFAULT_OVERTIME_RATE = 1.5;
const WORK_SETTINGS_KEY = 'work_settings_v1';
const DEFAULT_WORK_SETTINGS = { start: '09:00', end: '18:00', hourlyWage: DEFAULT_HOURLY_WAGE, overtimeRate: DEFAULT_OVERTIME_RATE };
let mainWindow;
let tray;
let trayMenu;
let adminServer;
let adminPort;
let saveTimer;
let statePath;
let taskDb;
let isQuitting = false;
let savedState = { miniBounds: null, boardBounds: null, detailBounds: null, pinned: true, mode: 'mini' };

function initializeTaskDb() {
  const dbPath = path.join(app.getPath('userData'), 'clockout.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  taskDb = new DatabaseSync(dbPath);
  taskDb.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      duration_slots INTEGER NOT NULL DEFAULT 1,
      type TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'todo',
      locked INTEGER NOT NULL DEFAULT 0,
      day TEXT NOT NULL DEFAULT 'today',
      fixed_start_slot INTEGER,
      actual_slots INTEGER NOT NULL DEFAULT 0,
      deadline TEXT,
      assignee TEXT NOT NULL DEFAULT '员工',
      priority INTEGER NOT NULL DEFAULT 3,
      sort_order INTEGER NOT NULL DEFAULT 0,
      published INTEGER NOT NULL DEFAULT 1,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workday_controls (
      work_date TEXT PRIMARY KEY,
      confirmed_at REAL,
      paid_slots INTEGER NOT NULL DEFAULT 0,
      paid_amount REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS overage_payments (
      id TEXT PRIMARY KEY,
      work_date TEXT NOT NULL,
      task_count INTEGER NOT NULL,
      slots INTEGER NOT NULL,
      amount REAL NOT NULL,
      paid_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  taskDb.prepare('INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)').run(WORK_SETTINGS_KEY, JSON.stringify(DEFAULT_WORK_SETTINGS));
  try {
    taskDb.exec('ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  } catch (error) {
    if (!String(error.message || error).includes('duplicate column name')) throw error;
  }
  try {
    taskDb.exec('ALTER TABLE tasks ADD COLUMN published INTEGER NOT NULL DEFAULT 1');
  } catch (error) {
    if (!String(error.message || error).includes('duplicate column name')) throw error;
  }
  const resetKey = taskDb.prepare('SELECT value FROM app_meta WHERE key = ?').get('initial_confirmation_reset_v1');
  if (!resetKey) {
    const now = Date.now();
    taskDb.exec('BEGIN');
    try {
      taskDb.prepare('UPDATE tasks SET published = 0, updated_at = ?').run(now);
      taskDb.prepare('DELETE FROM workday_controls').run();
      taskDb.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run('initial_confirmation_reset_v1', String(now));
      taskDb.exec('COMMIT');
      console.log('[sqlite]', JSON.stringify({ initialConfirmationReset: true }));
    } catch (error) {
      taskDb.exec('ROLLBACK');
      throw error;
    }
  }
  console.log('[sqlite]', JSON.stringify({ path: dbPath, ready: true }));
}

function taskFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    durationSlots: Math.max(1, Number(row.duration_slots) || 1),
    type: row.type,
    status: row.status,
    locked: Boolean(row.locked),
    day: row.day,
    fixedStartSlot: row.fixed_start_slot === null ? undefined : Number(row.fixed_start_slot),
    actualSlots: Math.max(0, Number(row.actual_slots) || 0),
    deadline: row.deadline || undefined,
    assignee: row.assignee || '员工',
    priority: Math.max(1, Math.min(5, Number(row.priority) || 3)),
    published: Boolean(row.published),
    createdAt: Number(row.created_at) || Date.now()
  };
}

function listAllTasks() {
  return taskDb ? taskDb.prepare('SELECT * FROM tasks ORDER BY day ASC, sort_order ASC, created_at ASC').all().map(taskFromRow) : [];
}

function listPublishedTasks() {
  return listAllTasks().filter((task) => task.published !== false);
}

function saveAllTasks(tasks) {
  if (!taskDb) return [];
  const now = Date.now();
  const insert = taskDb.prepare(`
    INSERT INTO tasks (
      id, title, duration_slots, type, status, locked, day, fixed_start_slot,
      actual_slots, deadline, assignee, priority, sort_order, published, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, duration_slots = excluded.duration_slots,
      type = excluded.type, status = excluded.status, locked = excluded.locked,
      day = excluded.day, fixed_start_slot = excluded.fixed_start_slot,
      actual_slots = excluded.actual_slots, deadline = excluded.deadline,
      assignee = excluded.assignee, priority = excluded.priority, sort_order = excluded.sort_order,
      published = excluded.published,
      updated_at = excluded.updated_at
  `);
  taskDb.exec('BEGIN');
  try {
    const ids = new Set();
    for (const [sortOrder, task] of (Array.isArray(tasks) ? tasks : []).entries()) {
      if (!task || typeof task.id !== 'string' || typeof task.title !== 'string' || !task.title.trim()) continue;
      ids.add(task.id);
      insert.run(
        task.id, task.title.trim(), Math.max(1, Math.round(Number(task.durationSlots) || 1)),
        String(task.type || 'normal'), String(task.status || 'todo'), task.locked ? 1 : 0,
        task.day === 'tomorrow' ? 'tomorrow' : 'today', Number.isFinite(task.fixedStartSlot) ? Math.round(task.fixedStartSlot) : null,
        Math.max(0, Math.round(Number(task.actualSlots) || 0)), task.deadline ? String(task.deadline) : null,
        task.assignee ? String(task.assignee) : '员工', Math.max(1, Math.min(5, Math.round(Number(task.priority) || 3))), sortOrder,
        task.published === false ? 0 : 1,
        Number(task.createdAt) || now, now
      );
    }
    const remove = taskDb.prepare('DELETE FROM tasks WHERE id = ?');
    for (const task of listAllTasks()) if (!ids.has(task.id)) remove.run(task.id);
    taskDb.exec('COMMIT');
  } catch (error) {
    taskDb.exec('ROLLBACK');
    throw error;
  }
  return listAllTasks();
}

function savePublishedTasks(tasks) {
  const published = (Array.isArray(tasks) ? tasks : []).map((task) => ({ ...task, published: true }));
  saveAllTasks([...listAllTasks().filter((task) => task.published === false), ...published]);
  return listPublishedTasks();
}

function deleteTask(taskId) {
  if (taskDb && typeof taskId === 'string') taskDb.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  return listPublishedTasks();
}

function broadcastTasks() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:changed', listPublishedTasks());
}

function broadcastWorkdayControl() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workday:changed', getWorkdayControl());
}

function broadcastSettings() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings:changed', getWorkSettings());
}

function currentWorkDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function clockMinutes(value) {
  const [hours, minutes] = String(value).split(':').map(Number);
  return hours * 60 + minutes;
}

function normalizeTime(value, fallback) {
  const candidate = String(value || '');
  if (!/^\d{2}:\d{2}$/.test(candidate)) return fallback;
  const minutes = clockMinutes(candidate);
  return minutes >= 0 && minutes <= 1439 ? candidate : fallback;
}

function normalizeWorkSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const hourlyWage = Number(source.hourlyWage);
  const overtimeRate = Number(source.overtimeRate);
  return {
    start: normalizeTime(source.start, DEFAULT_WORK_SETTINGS.start),
    end: normalizeTime(source.end, DEFAULT_WORK_SETTINGS.end),
    hourlyWage: Number.isFinite(hourlyWage) && hourlyWage > 0 ? Math.round(hourlyWage * 100) / 100 : DEFAULT_WORK_SETTINGS.hourlyWage,
    overtimeRate: Number.isFinite(overtimeRate) && overtimeRate > 0 ? Math.round(overtimeRate * 100) / 100 : DEFAULT_WORK_SETTINGS.overtimeRate
  };
}

function getWorkSettings() {
  const row = taskDb?.prepare('SELECT value FROM app_meta WHERE key = ?').get(WORK_SETTINGS_KEY);
  if (!row) return { ...DEFAULT_WORK_SETTINGS };
  try {
    return normalizeWorkSettings(JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_WORK_SETTINGS };
  }
}

function saveWorkSettings(value) {
  const next = normalizeWorkSettings(value);
  if (clockMinutes(next.start) >= clockMinutes(next.end)) throw new Error('上班时间必须早于下班时间');
  taskDb.prepare(`INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(WORK_SETTINGS_KEY, JSON.stringify(next));
  broadcastSettings();
  broadcastWorkdayControl();
  return next;
}

function overageAmount(slots, settings = getWorkSettings()) {
  return slots * SLOT_MINUTES / 60 * settings.hourlyWage * settings.overtimeRate;
}

function getWorkdayControl() {
  const workDate = currentWorkDate();
  const settings = getWorkSettings();
  const row = taskDb?.prepare('SELECT * FROM workday_controls WHERE work_date = ?').get(workDate);
  const pendingTasks = listAllTasks().filter((task) => task.published === false);
  const pendingSlots = pendingTasks.reduce((sum, task) => sum + Math.max(1, Math.round(task.durationSlots)), 0);
  return {
    workDate,
    confirmedAt: row?.confirmed_at ? Number(row.confirmed_at) : null,
    paidSlots: Number(row?.paid_slots) || 0,
    paidAmount: Number(row?.paid_amount) || 0,
    pendingCount: pendingTasks.length,
    pendingSlots,
    pendingMinutes: pendingSlots * SLOT_MINUTES,
    overageAmount: overageAmount(pendingSlots, settings),
    hourlyWage: settings.hourlyWage,
    overtimeRate: settings.overtimeRate
  };
}

function confirmPendingTasks() {
  const control = getWorkdayControl();
  if (control.confirmedAt) throw new Error('今日任务已经确认，新增任务需要支付超额费用');
  const now = Date.now();
  taskDb.exec('BEGIN');
  try {
    taskDb.prepare('UPDATE tasks SET published = 1, updated_at = ? WHERE published = 0').run(now);
    taskDb.prepare(`INSERT INTO workday_controls (work_date, confirmed_at) VALUES (?, ?)
      ON CONFLICT(work_date) DO UPDATE SET confirmed_at = excluded.confirmed_at`).run(control.workDate, now);
    taskDb.exec('COMMIT');
  } catch (error) {
    taskDb.exec('ROLLBACK');
    throw error;
  }
  broadcastTasks();
  broadcastWorkdayControl();
  return getWorkdayControl();
}

function payAndPublishPendingTasks() {
  const control = getWorkdayControl();
  if (!control.confirmedAt) throw new Error('请先确认今日任务');
  if (!control.pendingCount) return control;
  const now = Date.now();
  const amount = overageAmount(control.pendingSlots);
  taskDb.exec('BEGIN');
  try {
    taskDb.prepare('UPDATE tasks SET published = 1, updated_at = ? WHERE published = 0').run(now);
    taskDb.prepare(`INSERT INTO workday_controls (work_date, confirmed_at, paid_slots, paid_amount) VALUES (?, ?, ?, ?)
      ON CONFLICT(work_date) DO UPDATE SET paid_slots = workday_controls.paid_slots + excluded.paid_slots, paid_amount = workday_controls.paid_amount + excluded.paid_amount`).run(control.workDate, control.confirmedAt, control.pendingSlots, amount);
    taskDb.prepare('INSERT INTO overage_payments (id, work_date, task_count, slots, amount, paid_at) VALUES (?, ?, ?, ?, ?, ?)').run(`payment-${now}-${Math.random().toString(36).slice(2, 8)}`, control.workDate, control.pendingCount, control.pendingSlots, amount, now);
    taskDb.exec('COMMIT');
  } catch (error) {
    taskDb.exec('ROLLBACK');
    throw error;
  }
  broadcastTasks();
  broadcastWorkdayControl();
  return getWorkdayControl();
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function serveAdminFile(response, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const staticRoot = path.resolve(__dirname, '../dist');
  const target = path.resolve(staticRoot, relativePath);
  if (target !== staticRoot && !target.startsWith(staticRoot + path.sep)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
  fs.readFile(target, (error, content) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      response.end(error.code === 'ENOENT' ? 'Not Found' : 'Internal Server Error');
      return;
    }
    response.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store' });
    response.end(content);
  });
}

function startAdminServer() {
  if (adminServer && adminPort) return Promise.resolve(adminPort);
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      if (requestUrl.pathname === '/api/tasks' && request.method === 'GET') {
        sendJson(response, 200, listAllTasks());
        return;
      }
      if (requestUrl.pathname === '/api/admin/state' && request.method === 'GET') {
        sendJson(response, 200, getWorkdayControl());
        return;
      }
      if (requestUrl.pathname === '/api/admin/settings' && request.method === 'GET') {
        sendJson(response, 200, getWorkSettings());
        return;
      }
      if (requestUrl.pathname === '/api/admin/settings' && request.method === 'PUT') {
        try {
          const payload = await readRequestBody(request);
          sendJson(response, 200, saveWorkSettings(payload.settings || payload));
        } catch (error) {
          sendJson(response, 400, { error: String(error.message || error) });
        }
        return;
      }
      if (requestUrl.pathname === '/api/tasks' && request.method === 'PUT') {
        try {
          const payload = await readRequestBody(request);
          const saved = saveAllTasks(Array.isArray(payload) ? payload : payload.tasks);
          broadcastTasks();
          sendJson(response, 200, saved);
        } catch (error) {
          sendJson(response, 400, { error: String(error.message || error) });
        }
        return;
      }
      if (requestUrl.pathname === '/api/admin/confirm' && request.method === 'POST') {
        try {
          sendJson(response, 200, confirmPendingTasks());
        } catch (error) {
          sendJson(response, 409, { error: String(error.message || error) });
        }
        return;
      }
      if (requestUrl.pathname === '/api/admin/pay-and-publish' && request.method === 'POST') {
        try {
          sendJson(response, 200, payAndPublishPendingTasks());
        } catch (error) {
          sendJson(response, 409, { error: String(error.message || error) });
        }
        return;
      }
      if (requestUrl.pathname.startsWith('/api/tasks/') && request.method === 'DELETE') {
        const taskId = decodeURIComponent(requestUrl.pathname.slice('/api/tasks/'.length));
        sendJson(response, 200, deleteTask(taskId));
        broadcastTasks();
        return;
      }
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'Method not allowed' });
        return;
      }
      serveAdminFile(response, requestUrl.pathname);
    });
    server.once('error', reject);
    server.listen(ADMIN_PORT, '127.0.0.1', () => {
      adminServer = server;
      adminPort = ADMIN_PORT;
      console.log('[admin]', JSON.stringify({ url: `http://127.0.0.1:${adminPort}/admin.html`, ready: true }));
      resolve(adminPort);
    });
  });
}

async function openAdminPage() {
  const port = await startAdminServer();
  const url = `http://127.0.0.1:${port}/admin.html`;
  await shell.openExternal(url);
  return url;
}

function readState() {
  statePath = path.join(app.getPath('userData'), 'window-state.json');
  try {
    savedState = { ...savedState, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) };
  } catch (_) {}
}

function clampBounds(bounds) {
  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;
  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height),
    width: Math.min(bounds.width, area.width),
    height: Math.min(bounds.height, area.height)
  };
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const bounds = mainWindow.getBounds();
    if (savedState.mode === 'detail') savedState.detailBounds = bounds;
    else if (savedState.mode === 'board') savedState.boardBounds = bounds;
    else savedState.miniBounds = bounds;
    fs.writeFileSync(statePath, JSON.stringify(savedState, null, 2));
  }, 180);
}

function positionUnderTray() {
  if (!mainWindow || !tray) return;
  const trayBounds = tray.getBounds();
  const current = mainWindow.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: Math.round(trayBounds.x + trayBounds.width / 2),
    y: Math.round(trayBounds.y + trayBounds.height)
  });
  const area = display.workArea;
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - current.width / 2);
  const y = process.platform === 'darwin'
    ? Math.round(trayBounds.y + trayBounds.height + 6)
    : Math.round(area.y + 8);
  mainWindow.setPosition(
    Math.min(Math.max(x, area.x + 8), area.x + area.width - current.width - 8),
    Math.min(Math.max(y, area.y + 8), area.y + area.height - current.height - 8),
    false
  );
}

function setWindowMode(requestedMode, showWindow = true) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const current = mainWindow.getBounds();
  savedState.mode = requestedMode === 'detail' ? 'detail' : requestedMode === 'board' ? 'board' : 'mini';

  if (savedState.mode === 'detail') {
    mainWindow.setResizable(true);
    mainWindow.setMaximumSize(1600, 1100);
    mainWindow.setMinimumSize(820, 600);
    const target = clampBounds(savedState.detailBounds || {
      x: current.x + current.width - DETAIL_SIZE.width,
      y: current.y,
      ...DETAIL_SIZE
    });
    mainWindow.setBounds(target, true);
  } else if (savedState.mode === 'board') {
    mainWindow.setMinimumSize(BOARD_SIZE.width, BOARD_SIZE.height);
    mainWindow.setMaximumSize(BOARD_SIZE.width, BOARD_SIZE.height);
    const target = clampBounds(savedState.boardBounds || { x: current.x + current.width - BOARD_SIZE.width, y: current.y, ...BOARD_SIZE });
    mainWindow.setBounds(target, true);
    mainWindow.setResizable(false);
  } else {
    mainWindow.setMinimumSize(MINI_SIZE.width, MINI_SIZE.height);
    mainWindow.setMaximumSize(MINI_SIZE.width, MINI_SIZE.height);
    mainWindow.setBounds({ ...current, ...MINI_SIZE }, false);
    mainWindow.setResizable(false);
    positionUnderTray();
  }

  if (showWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
  if (!mainWindow.webContents.isLoading()) mainWindow.webContents.send('window:mode-changed', savedState.mode);
  scheduleSave();
  return true;
}

function toggleTrayWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
    return;
  }
  setWindowMode('mini');
}

function formatTrayCountdown(totalSeconds) {
  if (totalSeconds <= 0) return '下班';
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = String(Math.floor(safe / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((safe % 3600) / 60)).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function updateTrayCountdown(totalSeconds) {
  if (!tray) return false;
  const label = formatTrayCountdown(Number(totalSeconds) || 0);
  tray.setTitle(process.platform === 'darwin' ? ` ${label}` : '');
  tray.setToolTip(`clockout · 距离下班 ${label}`);
  return true;
}

function createTrayImage() {
  const pixels = [
    '0001111111111000',
    '0010000000000100',
    '0100000110000010',
    '0100001111000010',
    '0100011111100010',
    '0100000110000010',
    '0100000110000010',
    '0100000000000010',
    '0100000000000010',
    '0100000110000010',
    '0100000110000010',
    '0100011111100010',
    '0100001111000010',
    '0100000110000010',
    '0010000000000100',
    '0001111111111000'
  ];
  const bitmap = Buffer.alloc(16 * 16 * 4);
  pixels.forEach((row, y) => {
    Array.from(row).forEach((pixel, x) => {
      if (pixel !== '1') return;
      const offset = (y * 16 + x) * 4;
      bitmap[offset + 3] = 255;
    });
  });
  const image = nativeImage.createFromBitmap(bitmap, { width: 16, height: 16, scaleFactor: 1 });
  image.setTemplateImage(true);
  return image;
}

function createTray() {
  const trayImage = createTrayImage();
  tray = new Tray(trayImage);
  tray.setToolTip('clockout');
  tray.on('click', toggleTrayWindow);
  trayMenu = Menu.buildFromTemplate([
    { label: '打开任务棋盘', click: () => setWindowMode('board') },
    { label: '打开详细界面', click: () => setWindowMode('detail') },
    { label: '打开管理后台', click: () => void openAdminPage() },
    { label: '显示／隐藏倒计时', click: toggleTrayWindow },
    { type: 'separator' },
    {
      label: '退出 clockout',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu));

  const now = new Date();
  const secondsUntilSix = Math.max(0, (18 * 60 - now.getHours() * 60 - now.getMinutes()) * 60 - now.getSeconds());
  updateTrayCountdown(secondsUntilSix);
  setTimeout(() => {
    console.log('[status-bar]', JSON.stringify({ imageEmpty: trayImage.isEmpty(), bounds: tray.getBounds(), title: tray.getTitle() }));
  }, 500);
}

function createWindow() {
  readState();
  const primary = screen.getPrimaryDisplay().workArea;
  const initial = clampBounds(savedState.miniBounds || {
    x: primary.x + primary.width - MINI_SIZE.width - 24,
    y: primary.y + 8,
    ...MINI_SIZE
  });
  savedState.mode = 'mini';

  mainWindow = new BrowserWindow({
    ...initial,
    width: MINI_SIZE.width,
    height: MINI_SIZE.height,
    minWidth: MINI_SIZE.width,
    minHeight: MINI_SIZE.height,
    maxWidth: MINI_SIZE.width,
    maxHeight: MINI_SIZE.height,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    hasShadow: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.on('move', scheduleSave);
  mainWindow.on('resize', scheduleSave);
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  if (process.platform === 'darwin') {
    app.dock.hide();
    mainWindow.setWindowButtonVisibility(false);
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
}

app.whenReady().then(async () => {
  initializeTaskDb();
  await startAdminServer();
  createWindow();
  createTray();
  setWindowMode('mini');
});
app.on('before-quit', () => { isQuitting = true; if (adminServer) adminServer.close(); if (taskDb) taskDb.close(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else toggleTrayWindow();
});

ipcMain.handle('window:set-mode', (_event, requestedMode) => setWindowMode(requestedMode));
ipcMain.handle('tasks:list', () => listPublishedTasks());
ipcMain.handle('tasks:has-any', () => listAllTasks().length > 0);
ipcMain.handle('workday:get-control', () => getWorkdayControl());
ipcMain.handle('settings:get', () => getWorkSettings());
ipcMain.handle('tasks:save', (_event, tasks) => {
  const saved = savePublishedTasks(tasks);
  broadcastTasks();
  return saved;
});
ipcMain.handle('tasks:delete', (_event, taskId) => {
  const saved = deleteTask(taskId);
  broadcastTasks();
  return saved;
});

ipcMain.handle('window:toggle-pin', () => {
  if (!mainWindow) return false;
  savedState.pinned = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(savedState.pinned, 'floating');
  scheduleSave();
  return savedState.pinned;
});

ipcMain.handle('tray:update-countdown', (_event, totalSeconds) => updateTrayCountdown(totalSeconds));
ipcMain.on('app:quit', () => {
  isQuitting = true;
  app.quit();
});

ipcMain.on('window:hide-for', (_event, milliseconds) => {
  if (!mainWindow) return;
  mainWindow.hide();
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) setWindowMode('mini');
  }, Math.max(1000, Math.min(milliseconds || 300000, 3600000)));
});

ipcMain.on('window:close', () => mainWindow && mainWindow.hide());
