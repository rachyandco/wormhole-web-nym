/**
 * Wormhole-Nym Web — UI entry point.
 */

import { createNymMixnetClient } from '@nymproject/sdk-full-fat';
import { receiveFile, sendFile } from './wormhole.js';

const NYM_API_URL = 'https://validator.nymtech.net/api';
const NYM_FORCE_TLS = true;

// ── State ──────────────────────────────────────────────────────────────────────
let nymClient      = null;
let nymAddress     = null;
let nymReady       = false;
let nymInitPromise = null;

// ── DOM helpers ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const show = id => $(id)?.classList.remove('hidden');
const hide = id => $(id)?.classList.add('hidden');

function showOnly(ids, parent) {
  parent.querySelectorAll('.step').forEach(el => el.classList.add('hidden'));
  ids.forEach(show);
}
function setStatus(id, text, cls = '') {
  const el = $(id); if (!el) return;
  el.textContent = text; el.className = 'status ' + cls;
}
function setProgress(id, received, total) {
  const fill = $(id); if (!fill) return;
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

// ── Mixnet visualization ───────────────────────────────────────────────────────

let pktSent = 0, pktRecv = 0;
// Throttle: max one dot animation per 250 ms per direction (not applied to cover)
const animThrottle = { out: 0, in: 0 };

function mixnetShow() { show('mixnet-card'); }

let coverInterval = null;
let _coverFlip = false;

function mixnetSetState(state, gatewayAddr) {
  const card = $('mixnet-card');
  const dot  = $('conn-dot');
  const text = $('conn-text');
  card.classList.remove('connected');
  dot.className = `conn-dot ${state}`;
  if (state === 'connecting') {
    text.textContent = 'Connecting to Nym mixnet…';
    clearInterval(coverInterval); coverInterval = null;
  } else if (state === 'connected') {
    text.textContent = 'Connected to Nym mixnet';
    card.classList.add('connected');
    if (gatewayAddr) {
      $('conn-gateway').textContent = `via ${gatewayAddr.slice(0, 20)}…`;
    }
    if (!coverInterval) {
      coverInterval = setInterval(() => {
        _coverFlip = !_coverFlip;
        mixnetAnimPkt(_coverFlip ? 'out' : 'in', true);
      }, 1400);
    }
  } else if (state === 'error') {
    text.textContent = 'Nym connection error';
    clearInterval(coverInterval); coverInterval = null;
  }
}

function mixnetAnimPkt(dir /* 'out' | 'in' */, cover = false) {
  if (!cover) {
    const now = Date.now();
    if (now - animThrottle[dir] < 250) return;
    animThrottle[dir] = now;
  }

  const lane = $('pkt-lane');
  if (!lane) return;
  const dot = document.createElement('div');
  dot.className = cover ? `pkt ${dir} cover` : `pkt ${dir}`;
  lane.appendChild(dot);
  dot.addEventListener('animationend', () => dot.remove(), { once: true });
}

function mixnetUpdateCounters() {
  $('pkt-sent').textContent = `↑ ${pktSent} sent`;
  $('pkt-recv').textContent = `↓ ${pktRecv} received`;
}

// ── Mixnet packet callbacks ────────────────────────────────────────────────────

function onPacketSent() {
  pktSent++;
  mixnetAnimPkt('out');
  mixnetUpdateCounters();
}

function onPacketReceived() {
  pktRecv++;
  mixnetAnimPkt('in');
  mixnetUpdateCounters();
}

// ── Nym client init ────────────────────────────────────────────────────────────

async function initNym(onStatusUpdate) {
  if (nymReady) return;
  if (nymInitPromise) return nymInitPromise;

  mixnetShow();
  mixnetSetState('connecting');

  nymInitPromise = (async () => {
    onStatusUpdate('Creating Nym WebAssembly client…');
    nymClient = await createNymMixnetClient();

    await new Promise((resolve, reject) => {
      let done = false;

      nymClient.events.subscribeToConnected(e => {
        if (done) return;
        done = true;
        clearTimeout(timeoutId);
        nymAddress = e.args.address;
        nymReady   = true;
        mixnetSetState('connected', nymAddress);
        resolve();
      });

      const clientId = `wormhole-web-${crypto.randomUUID().slice(0, 8)}`;
      onStatusUpdate('Connecting to Nym mixnet (this may take ~30 s)…');

      nymClient.client.start({
        clientId,
        nymApiUrl: NYM_API_URL,
        forceTls:  NYM_FORCE_TLS,
      }).catch(err => {
        if (done) return;
        done = true;
        clearTimeout(timeoutId);
        mixnetSetState('error');
        reject(err);
      });

      const timeoutId = setTimeout(() => {
        if (done) return;
        done = true;
        mixnetSetState('error');
        reject(new Error('Nym connection timeout after 90 s'));
      }, 90_000);
    });

    onStatusUpdate('Connected to Nym mixnet.');
  })();

  return nymInitPromise;
}

// ── Tab switching ──────────────────────────────────────────────────────────────

$('tab-receive').addEventListener('click', () => {
  $('tab-receive').classList.add('active');
  $('tab-send').classList.remove('active');
  show('panel-receive'); hide('panel-send');
});
$('tab-send').addEventListener('click', () => {
  $('tab-send').classList.add('active');
  $('tab-receive').classList.remove('active');
  show('panel-send'); hide('panel-receive');
});

// ── RECEIVE flow ───────────────────────────────────────────────────────────────

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
    await receiveFile(code, nymClient, {
      onStatus: text => setStatus('status-r-connect', text),
      onPacketSent,
      onPacketReceived,

      onOffer: async offer => {
        $('offer-filename').textContent = `File: ${offer.filename}`;
        $('offer-filesize').textContent = `Size: ${formatBytes(offer.filesize)}`;
        showOnly(['step-r-offer'], receivePanel);
        return new Promise(resolve => {
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
        setStatus('status-r-progress', `${formatBytes(received)} / ${formatBytes(total)}`);
      },

      onComplete: (filename, blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.click();
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

$('btn-receive-again').addEventListener('click', () => {
  $('code-input').value = '';
  $('btn-connect').disabled = false;
  showOnly(['step-r-code'], receivePanel);
  setStatus('status-r-code', '');
});

// ── SEND flow ──────────────────────────────────────────────────────────────────

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
      onPacketSent,
      onPacketReceived,
      onCode: code => {
        $('wormhole-code').textContent = code;
        showOnly(['step-s-waiting', 'step-s-progress'], sendPanel);
        setStatus('status-s-progress', 'Waiting for receiver…');
      },
      onStatus: text => setStatus('status-s-progress', text),
      onProgress: (sent, total) => {
        setProgress('progress-s-fill', sent, total);
        setStatus('status-s-progress', `${formatBytes(sent)} / ${formatBytes(total)}`);
      },
      onComplete: () => {
        selectedFile = null;
        $('file-input').value = '';
        $('btn-send-start').disabled = true;
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
  navigator.clipboard.writeText($('wormhole-code').textContent).then(() => {
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
