const { app, BrowserWindow, shell: systemShell } = require('electron');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { createServer } = require('node:net');

let backend;
let window;
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
app.on('second-instance', () => {
  if (window?.isMinimized()) window.restore();
  window?.focus();
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

if (lock) app.whenReady().then(async () => {
  const port = await freePort();
  const address = 'http://127.0.0.1:' + port;
  const shell = '/bin/zsh';
  const bootstrap = [
    'command -v codex >/dev/null || export ENABLE_CODEX=0',
    'command -v claude >/dev/null || export ENABLE_CLAUDE=0',
    'command -v dsh >/dev/null || export ENABLE_DSH=0',
    'if command -v pi >/dev/null && [[ -n $DEEPSEEK_API_KEY && -z $PI_MODEL ]]; then export PI_MODEL=deepseek/deepseek-flash; fi',
    'exec "$@"'
  ].join('\n');
  backend = spawn(shell, ['-ic', bootstrap, 'agent-chat', process.execPath, join(__dirname, 'server.mjs')], {
    env: {
      ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port), CHAT_LOCAL: '1',
      CHAT_DATA: join(app.getPath('userData'), 'chat'),
      ENABLE_CODEX: process.env.ENABLE_CODEX || '1',
      ENABLE_CLAUDE: process.env.ENABLE_CLAUDE || '1',
      ENABLE_DSH: process.env.ENABLE_DSH || '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const started = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('服务启动超时')), 12000);
    backend.stdout.on('data', chunk => {
      if (!chunk.toString().includes('Agent Chat http://')) return;
      clearTimeout(timeout);
      resolve(true);
    });
    backend.stderr.resume();
    backend.once('error', reject);
    backend.once('exit', () => reject(new Error('本地服务启动失败')));
  });
  if (!started) return;
  window = new BrowserWindow({
    width: 1140, height: 790, minWidth: 430, minHeight: 520,
    title: '同席', backgroundColor: '#eff5ef',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void systemShell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== address) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  await window.loadURL(address);
}).catch(error => {
  require('electron').dialog.showErrorBox('同席无法启动', error.message);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => backend?.kill());
