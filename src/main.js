/**
 * Wormhole-Nym Web — UI entry point.
 *
 * Handles:
 *  - Nym client lifecycle (lazy init, shared between Send and Receive)
 *  - Tab switching
 *  - Receive flow: code input → SPAKE2 → offer → accept/reject → download
 *  - Send flow:    file select → SPAKE2 → code display → send chunks → ack
 */

import { createNymMixnetClient } from '@nymproject/sdk-full-fat';
import { receiveFile, sendFile } from './wormhole.js';

// ── Nym config ────────────────────────────────────────────────────────────────
const NYM_API_URL = 'https://validator.nymtech.net/api';
// These WSS gateways are known to accept browser connections.
// The SDK will auto-select a gateway; forceTls ensures WSS.
const NYM_FORCE_TLS = true;

// ── State ─────────────────────────────────────────────────────────────────────
let nymClient   = null;   // shared once initialized
let nymAddress  = null;
let nymReady    = false;
let nymInitPromise = null;

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function show(id)  { $(id)?.classList.remove('hidden'); }
function hide(id)  { $(id)?.classList.add('hidden'); }
function showOnly(ids, parent) {
  parent.querySelectorAll('.step').forEach(el => el.classList.add('hidden'));
  ids.forEach(id => show(id));
}

function setStatus(id, text, cls = '') {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'status ' + cls;
}

function setProgress(id, received, total) {
  const fill = $(id);
  if (!fill) return;
  const pct = total > 0n ? Number((received * 100n) / total) : 0;
  fill.style.width = Math.min(pct, 100) + '%';
}

function formatBytes(bytes) {
  const n = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  if (n < 1024)       return `${n} B`;
  if (n < 1048576)    return `${(n/1024).toFixed(1)} KiB`;
  if (n < 1073741824) return `${(n/1048576).toFixed(1)} MiB`;
  return `${(n/1073741824).toFixed(2)} GiB`;
}

// ── Nym client init ───────────────────────────────────────────────────────────

async function initNym(onStatusUpdate) {
  if (nymReady) return;
  if (nymInitPromise) return nymInitPromise;

  nymInitPromise = (async () => {
    onStatusUpdate('Creating Nym WebAssembly client…');
    nymClient = await createNymMixnetClient();

    await new Promise((resolve, reject) => {
      nymClient.events.subscribeToConnected(e => {
        nymAddress = e.args.address;
        nymReady   = true;
        resolve();
      });

      const clientId = `wormhole-web-${crypto.randomUUID().slice(0, 8)}`;
      onStatusUpdate('Connecting to Nym mixnet (this takes ~30 seconds)…');

      nymClient.client.start({
        clientId,
        nymApiUrl: NYM_API_URL,
        forceTls:  NYM_FORCE_TLS,
      }).catch(reject);

      // Safety timeout
      setTimeout(() => reject(new Error('Nym connection timeout after 90 s')), 90_000);
    });

    onStatusUpdate(`Connected. Address: ${nymAddress.slice(0, 24)}…`);
  })();

  return nymInitPromise;
}

// ── Tab switching ─────────────────────────────────────────────────────────────

$('tab-receive').addEventListener('click', () => {
  $('tab-receive').classList.add('active');
  $('tab-send').classList.remove('active');
  show('panel-receive');
  hide('panel-send');
});

$('tab-send').addEventListener('click', () => {
  $('tab-send').classList.add('active');
  $('tab-receive').classList.remove('active');
  show('panel-send');
  hide('panel-receive');
});

// ── RECEIVE flow ──────────────────────────────────────────────────────────────

const receivePanel = $('panel-receive');

$('btn-connect').addEventListener('click', async () => {
  const code = $('code-input').value.trim();
  if (!code) { alert('Please enter a wormhole code.'); return; }

  $('btn-connect').disabled = true;
  showOnly(['step-r-connecting'], receivePanel);
  setStatus('status-r-connect', 'Initializing…');

  try {
    await initNym(text => setStatus('status-r-connect', text));
  } catch (err) {
    showOnly(['step-r-code'], receivePanel);
    $('btn-connect').disabled = false;
    setStatus('status-r-code', `Connection failed: ${err.message}`, 'error');
    return;
  }

  try {
    let offerResolve;
    const offerPromise = new Promise(r => { offerResolve = r; });

    await receiveFile(code, nymClient, {
      onStatus: text => setStatus('status-r-connect', text),

      onOffer: async offer => {
        // Show offer UI and wait for user decision
        $('offer-filename').textContent = `File: ${offer.filename}`;
        $('offer-filesize').textContent = `Size: ${formatBytes(offer.filesize)}`;
        showOnly(['step-r-offer'], receivePanel);

        return new Promise(resolve => {
          offerResolve = resolve;
          $('btn-accept').onclick = () => {
            showOnly(['step-r-progress'], receivePanel);
            setStatus('status-r-progress', 'Starting download…');
            resolve(true);
          };
          $('btn-reject').onclick = () => {
            resolve(false);
            showOnly(['step-r-code'], receivePanel);
            $('btn-connect').disabled = false;
            setStatus('status-r-code', 'Transfer rejected.', 'error');
          };
        });
      },

      onProgress: (received, total) => {
        setProgress('progress-r-fill', received, total);
        setStatus('status-r-progress',
          `${formatBytes(received)} / ${formatBytes(total)}`);
      },

      onComplete: (filename, blob) => {
        // Trigger browser download
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href     = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        showOnly(['step-r-done'], receivePanel);
      },
    });
  } catch (err) {
    showOnly(['step-r-code'], receivePanel);
    $('btn-connect').disabled = false;
    setStatus('status-r-code', `Error: ${err.message}`, 'error');
  }
});

// Reset receive on new transfer
$('btn-receive-again').addEventListener('click', () => {
  $('code-input').value = '';
  $('btn-connect').disabled = false;
  showOnly(['step-r-code'], receivePanel);
  setStatus('status-r-code', '');
});

// ── SEND flow ─────────────────────────────────────────────────────────────────

const sendPanel = $('panel-send');
let selectedFile = null;

$('file-input').addEventListener('change', e => {
  selectedFile = e.target.files[0] || null;
  $('btn-send-start').disabled = !selectedFile;
});

$('btn-send-start').addEventListener('click', async () => {
  if (!selectedFile) return;
  $('btn-send-start').disabled = true;
  showOnly(['step-s-connecting'], sendPanel);
  setStatus('status-s-connect', 'Initializing…');

  try {
    await initNym(text => setStatus('status-s-connect', text));
  } catch (err) {
    showOnly(['step-s-file'], sendPanel);
    $('btn-send-start').disabled = false;
    setStatus('status-s-file', `Connection failed: ${err.message}`, 'error');
    return;
  }

  try {
    await sendFile(selectedFile, nymClient, {
      onCode: code => {
        $('wormhole-code').textContent = code;
        showOnly(['step-s-waiting', 'step-s-progress'], sendPanel);
        setStatus('status-s-progress', 'Waiting for receiver…');
      },

      onStatus: text => setStatus('status-s-progress', text),

      onProgress: (sent, total) => {
        setProgress('progress-s-fill', sent, total);
        setStatus('status-s-progress',
          `${formatBytes(sent)} / ${formatBytes(total)}`);
      },

      onComplete: () => {
        showOnly(['step-s-done'], sendPanel);
      },
    });
  } catch (err) {
    showOnly(['step-s-file'], sendPanel);
    $('btn-send-start').disabled = false;
    setStatus('status-s-file', `Error: ${err.message}`, 'error');
  }
});

$('btn-copy-code').addEventListener('click', () => {
  const code = $('wormhole-code').textContent;
  navigator.clipboard.writeText(code).then(() => {
    $('btn-copy-code').textContent = 'Copied!';
    setTimeout(() => { $('btn-copy-code').textContent = 'Copy'; }, 2000);
  });
});

$('btn-send-again').addEventListener('click', () => {
  selectedFile = null;
  $('file-input').value = '';
  $('btn-send-start').disabled = true;
  $('wormhole-code').textContent = '';
  showOnly(['step-s-file'], sendPanel);
  setStatus('status-s-file', '');
});
