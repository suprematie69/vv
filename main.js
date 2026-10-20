const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const sudoPrompt = require('sudo-prompt');

const SUDO_OPTIONS = { name: 'USB ISO Flasher' };

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 640,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// Drive listing (platform-specific)
// ---------------------------------------------------------------------------

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || `${cmd} exited with code ${code}`));
      else resolve(stdout);
    });
  });
}

async function listDrivesLinux() {
  // lsblk reports every block device; we only keep USB-transport or
  // removable whole disks so internal/system disks never show up.
  const out = await runCommand('lsblk', [
    '-J',
    '-b',
    '-o',
    'NAME,SIZE,MODEL,VENDOR,TRAN,RM,TYPE,MOUNTPOINT,PATH',
  ]);
  const data = JSON.parse(out);

  const collectMountpoints = (node, acc) => {
    if (node.mountpoint) acc.push(node.mountpoint);
    if (Array.isArray(node.children)) {
      for (const child of node.children) collectMountpoints(child, acc);
    }
    return acc;
  };

  const drives = [];
  for (const node of data.blockdevices || []) {
    if (node.type !== 'disk') continue;
    const isRemovable = node.rm === true || node.rm === '1' || node.rm === 1;
    const isUsb = node.tran === 'usb';
    if (!isRemovable && !isUsb) continue;

    drives.push({
      device: node.path || `/dev/${node.name}`,
      size: Number(node.size) || 0,
      model: [node.vendor, node.model].filter(Boolean).join(' ').trim() || 'Périphérique USB',
      mountpoints: collectMountpoints(node, []),
    });
  }
  return drives;
}

async function listDrivesDarwin() {
  // Best-effort: parses `diskutil list` text output. Not tested on real
  // macOS hardware in this build environment.
  const out = await runCommand('diskutil', ['list', 'external', 'physical']);
  const diskIds = Array.from(out.matchAll(/^(\/dev\/disk\d+)\s/gm)).map((m) => m[1]);

  const drives = [];
  for (const diskId of diskIds) {
    try {
      const info = await runCommand('diskutil', ['info', '-plist', diskId]);
      const sizeMatch = info.match(/<key>TotalSize<\/key>\s*<integer>(\d+)<\/integer>/);
      const nameMatch = info.match(/<key>MediaName<\/key>\s*<string>([^<]*)<\/string>/);
      const removableMatch = info.match(/<key>RemovableMedia<\/key>\s*<(true|false)\/>/);
      const isRemovable = !removableMatch || removableMatch[1] === 'true';
      if (!isRemovable) continue;
      drives.push({
        device: diskId,
        size: sizeMatch ? Number(sizeMatch[1]) : 0,
        model: nameMatch ? nameMatch[1] : 'Périphérique USB',
        mountpoints: [],
      });
    } catch {
      // Skip disks we fail to introspect rather than guessing.
    }
  }
  return drives;
}

async function listDrivesWindows() {
  // Best-effort: PowerShell/WMI based listing. Not tested on real Windows
  // hardware in this build environment.
  const script =
    "Get-CimInstance Win32_DiskDrive | Where-Object { $_.InterfaceType -eq 'USB' } | " +
    'Select-Object DeviceID,Size,Model,Index | ConvertTo-Json';
  const out = await runCommand('powershell', ['-NoProfile', '-Command', script]);
  const trimmed = out.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.map((item) => ({
    device: item.DeviceID, // e.g. \\.\PHYSICALDRIVE1
    size: Number(item.Size) || 0,
    model: item.Model || 'Périphérique USB',
    mountpoints: [],
  }));
}

ipcMain.handle('list-drives', async () => {
  try {
    if (process.platform === 'linux') return await listDrivesLinux();
    if (process.platform === 'darwin') return await listDrivesDarwin();
    if (process.platform === 'win32') return await listDrivesWindows();
    throw new Error(`Plateforme non supportée: ${process.platform}`);
  } catch (err) {
    throw new Error(`Impossible de lister les clés USB: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// ISO selection
// ---------------------------------------------------------------------------

ipcMain.handle('select-iso', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choisir une image ISO/IMG',
    properties: ['openFile'],
    filters: [{ name: 'Images disque', extensions: ['iso', 'img'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const stat = fs.statSync(filePath);
  return { path: filePath, size: stat.size, name: path.basename(filePath) };
});

// ---------------------------------------------------------------------------
// Flashing
// ---------------------------------------------------------------------------

function sendProgress(percent, message) {
  if (mainWindow) mainWindow.webContents.send('flash-progress', { percent, message });
}

function sendLog(line) {
  if (mainWindow) mainWindow.webContents.send('flash-log', line);
}

function sudoExec(command) {
  return new Promise((resolve, reject) => {
    sudoPrompt.exec(command, SUDO_OPTIONS, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.toString() || error.message));
      else resolve(stdout?.toString() || '');
    });
  });
}

async function unmountLinux(drive) {
  for (const mountpoint of drive.mountpoints) {
    sendLog(`Démontage de ${mountpoint}...`);
    try {
      await sudoExec(`umount ${JSON.stringify(mountpoint)}`);
    } catch (err) {
      throw new Error(`Échec du démontage de ${mountpoint}: ${err.message}`);
    }
  }
}

function flashLinux(isoPath, device) {
  return new Promise((resolve, reject) => {
    sendLog(`pkexec dd if=${isoPath} of=${device} bs=4M conv=fsync oflag=direct status=progress`);
    const dd = spawn('pkexec', [
      'dd',
      `if=${isoPath}`,
      `of=${device}`,
      'bs=4M',
      'conv=fsync',
      'oflag=direct',
      'status=progress',
    ]);

    const totalSize = fs.statSync(isoPath).size;

    dd.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      sendLog(text.trim());
      // dd's status=progress emits lines like: "123456789 bytes (123 MB, 118 MiB) copied, ..."
      const match = text.match(/(\d+)\s+bytes/);
      if (match) {
        const copied = Number(match[1]);
        const percent = Math.min(100, Math.round((copied / totalSize) * 100));
        sendProgress(percent, `${percent}% écrit`);
      }
    });

    dd.on('error', reject);
    dd.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`dd a échoué (code ${code}). As-tu autorisé la demande d'authentification ?`));
    });
  });
}

async function flashDarwin(isoPath, device) {
  sendLog(`Démontage de ${device}...`);
  await sudoExec(`diskutil unmountDisk ${device}`);
  const rawDevice = device.replace('/dev/disk', '/dev/rdisk');
  sendLog(`dd if=${isoPath} of=${rawDevice} bs=4m`);
  sendProgress(0, "Écriture en cours (pas de progression détaillée sur macOS)...");
  await sudoExec(`dd if=${JSON.stringify(isoPath)} of=${JSON.stringify(rawDevice)} bs=4m`);
  sendProgress(100, 'Terminé');
}

async function flashWindows(isoPath, device) {
  // Writes raw bytes directly to the physical drive. The app process must
  // already be running elevated (Run as Administrator) - Node's fs module
  // cannot itself trigger a UAC prompt for an already-open handle.
  sendLog(`Ouverture de ${device} en écriture directe...`);
  const totalSize = fs.statSync(isoPath).size;
  const input = fs.createReadStream(isoPath, { highWaterMark: 4 * 1024 * 1024 });
  const output = fs.createWriteStream(device, { flags: 'w' });

  let copied = 0;
  await new Promise((resolve, reject) => {
    input.on('data', (chunk) => {
      copied += chunk.length;
      const percent = Math.min(100, Math.round((copied / totalSize) * 100));
      sendProgress(percent, `${percent}% écrit`);
    });
    input.on('error', reject);
    output.on('error', reject);
    output.on('finish', resolve);
    input.pipe(output);
  });
}

ipcMain.handle('flash-start', async (_event, { isoPath, device }) => {
  if (!isoPath || !device) throw new Error('ISO ou périphérique manquant.');
  if (!fs.existsSync(isoPath)) throw new Error('Le fichier ISO/IMG est introuvable.');

  try {
    if (process.platform === 'linux') {
      const drives = await listDrivesLinux();
      const drive = drives.find((d) => d.device === device);
      if (!drive) throw new Error('Périphérique USB introuvable ou non amovible.');
      await unmountLinux(drive);
      await flashLinux(isoPath, device);
    } else if (process.platform === 'darwin') {
      await flashDarwin(isoPath, device);
    } else if (process.platform === 'win32') {
      await flashWindows(isoPath, device);
    } else {
      throw new Error(`Plateforme non supportée: ${process.platform}`);
    }
    sendProgress(100, 'Écriture terminée avec succès.');
    return { ok: true };
  } catch (err) {
    sendLog(`ERREUR: ${err.message}`);
    throw new Error(err.message);
  }
});
