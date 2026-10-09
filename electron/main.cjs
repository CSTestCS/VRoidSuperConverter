// Electron main process: window, menu and native file dialogs for the renderer.
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#1d1f24',
    title: 'VRoid Super Converter',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

const MAX_SIBLING_BYTES = 256 * 1024 * 1024;
const TEXTURE_EXT = new Set(['.png', '.jpg', '.jpeg', '.tga', '.bmp', '.webp', '.bin', '.ktx2', '.dds', '.mtl', '.tif', '.tiff']);

ipcMain.handle('open-files', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, {
    title: opts.title,
    filters: [...(opts.filters ?? []), { name: 'All files', extensions: ['*'] }],
    properties: ['openFile', ...(opts.multiple ? ['multiSelections'] : [])],
  });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(async (p) => ({ name: path.basename(p), path: p, bytes: new Uint8Array(await fs.readFile(p)) })));
});

ipcMain.handle('save-file', async (_e, { defaultName, bytes, filters, extraFiles }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [...(filters ?? []), { name: 'All files', extensions: ['*'] }] });
  if (r.canceled || !r.filePath) return null;
  await fs.writeFile(r.filePath, Buffer.from(bytes));
  // Extra files (textures of a .dae, etc.) go next to the main file; names are reduced to a base name.
  for (const f of extraFiles ?? []) {
    const name = path.basename(String(f.name)).replace(/[<>:"/\\|?*]/g, '_');
    if (name) await fs.writeFile(path.join(path.dirname(r.filePath), name), Buffer.from(f.bytes));
  }
  return r.filePath;
});

// Texture files next to a model (FBX/OBJ/glTF often reference external images)
ipcMain.handle('read-siblings', async (_e, filePath) => {
  const dir = path.dirname(filePath);
  const out = new Map();
  let total = 0;
  const visit = async (d, depth) => {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory() && depth < 2) await visit(full, depth + 1);
      else if (ent.isFile() && TEXTURE_EXT.has(path.extname(ent.name).toLowerCase())) {
        const st = await fs.stat(full);
        if (total + st.size > MAX_SIBLING_BYTES) continue;
        total += st.size;
        const bytes = new Uint8Array(await fs.readFile(full));
        out.set(ent.name, bytes);
        out.set(ent.name.toLowerCase(), bytes);
      }
    }
  };
  await visit(dir, 0);
  return out;
});

Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: 'File', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'quit' }] },
  { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  { label: 'Help', submenu: [{ label: 'Project page', click: () => shell.openExternal('https://github.com/CSTestCS/VRoidSuperConverter') }] },
]));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
