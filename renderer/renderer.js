const pickIsoBtn = document.getElementById('pick-iso-btn');
const isoLabel = document.getElementById('iso-label');
const refreshBtn = document.getElementById('refresh-btn');
const driveSelect = document.getElementById('drive-select');
const flashBtn = document.getElementById('flash-btn');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const logEl = document.getElementById('log');

const confirmOverlay = document.getElementById('confirm-overlay');
const confirmDetails = document.getElementById('confirm-details');
const confirmCancel = document.getElementById('confirm-cancel');
const confirmOk = document.getElementById('confirm-ok');

let selectedIso = null; // { path, size, name }
let drives = [];
let isFlashing = false;

function formatBytes(bytes) {
  if (!bytes) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function appendLog(line) {
  logEl.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function updateFlashButtonState() {
  flashBtn.disabled = isFlashing || !selectedIso || !driveSelect.value;
}

async function refreshDrives() {
  driveSelect.innerHTML = '<option value="">Chargement...</option>';
  try {
    drives = await window.api.listDrives();
  } catch (err) {
    appendLog(`ERREUR: ${err.message}`);
    drives = [];
  }

  driveSelect.innerHTML = '';
  if (drives.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Aucune clé USB détectée';
    driveSelect.appendChild(opt);
  } else {
    for (const drive of drives) {
      const opt = document.createElement('option');
      opt.value = drive.device;
      opt.textContent = `${drive.device} — ${drive.model} (${formatBytes(drive.size)})`;
      driveSelect.appendChild(opt);
    }
  }
  updateFlashButtonState();
}

pickIsoBtn.addEventListener('click', async () => {
  const result = await window.api.selectIso();
  if (!result) return;
  selectedIso = result;
  isoLabel.textContent = `${result.name} (${formatBytes(result.size)})`;
  updateFlashButtonState();
});

refreshBtn.addEventListener('click', refreshDrives);
driveSelect.addEventListener('change', updateFlashButtonState);

flashBtn.addEventListener('click', () => {
  const drive = drives.find((d) => d.device === driveSelect.value);
  if (!drive || !selectedIso) return;

  confirmDetails.innerHTML = `
    <div><strong>Périphérique :</strong> ${drive.device}</div>
    <div><strong>Modèle :</strong> ${drive.model}</div>
    <div><strong>Taille :</strong> ${formatBytes(drive.size)}</div>
    <div><strong>Image :</strong> ${selectedIso.name}</div>
  `;
  confirmOverlay.classList.remove('hidden');
});

confirmCancel.addEventListener('click', () => {
  confirmOverlay.classList.add('hidden');
});

confirmOk.addEventListener('click', async () => {
  confirmOverlay.classList.add('hidden');
  const device = driveSelect.value;
  if (!device || !selectedIso) return;

  isFlashing = true;
  updateFlashButtonState();
  progressFill.style.width = '0%';
  progressText.textContent = 'Démarrage...';
  logEl.textContent = '';

  try {
    await window.api.startFlash(selectedIso.path, device);
    progressText.textContent = 'Terminé avec succès.';
  } catch (err) {
    progressText.textContent = `Échec : ${err.message}`;
    appendLog(`ERREUR: ${err.message}`);
  } finally {
    isFlashing = false;
    updateFlashButtonState();
  }
});

window.api.onProgress(({ percent, message }) => {
  progressFill.style.width = `${percent}%`;
  progressText.textContent = message;
});

window.api.onLog((line) => appendLog(line));

refreshDrives();
