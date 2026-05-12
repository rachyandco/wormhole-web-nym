/**
 * Wormhole-Nym Web — UI entry point.
 */

import qrcode from 'qrcode-generator';
import { Mixnet } from './mixnet.js';
import { receiveFile, sendFile } from './wormhole.js';

const NYM_API_URL    = 'https://validator.nymtech.net/api';
const NYM_FORCE_TLS  = true;
const CLIENT_ID_KEY  = 'wormhole-web-client-id';

// Magic marker so the receiver can distinguish a text message from a regular
// file. A CLI receiver will just save the file as normal; the web receiver
// strips the header and displays the text.
const TEXT_MSG_FILENAME = '__wormhole_text_message__.txt';
const TEXT_MSG_MAGIC    = new TextEncoder().encode('WORMHOLE-TEXT-v1\n');

// ── State ──────────────────────────────────────────────────────────────────────
const mixnet = new Mixnet();
let nymInitPromise = null;
let activeTransfer = false;

function getOrCreateClientId() {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = `wormhole-web-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

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

// ── Active-transfer warning ──────────────────────────────────────────────────

function showTransferWarning() { show('transfer-warning'); }
function hideTransferWarning() { hide('transfer-warning'); }

// ── Screen Wake Lock ──────────────────────────────────────────────────────────
// Browsers release the wake lock automatically when the page becomes hidden,
// so we track intent separately and re-request on visibilitychange.

let wakeLock     = null;
let wantWakeLock = false;

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (err) {
    console.warn('Wake lock request failed:', err);
  }
}

function releaseWakeLock() {
  wantWakeLock = false;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (wantWakeLock && document.visibilityState === 'visible' && !wakeLock) {
    acquireWakeLock();
  }
});

// ── QR code rendering ──────────────────────────────────────────────────────────

function renderQR(targetEl, text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  targetEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
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
  if (mixnet.isStarted) return;
  if (nymInitPromise) return nymInitPromise;

  mixnetShow();
  mixnetSetState('connecting');

  nymInitPromise = (async () => {
    try {
      await mixnet.start({
        clientId:  getOrCreateClientId(),
        nymApiUrl: NYM_API_URL,
        forceTls:  NYM_FORCE_TLS,
        onStatus:  onStatusUpdate,
      });
      mixnetSetState('connected', mixnet.address);
      onStatusUpdate('Connected to Nym mixnet.');
    } catch (err) {
      mixnetSetState('error');
      throw err;
    } finally {
      nymInitPromise = null;
    }
  })();

  return nymInitPromise;
}

// ── Visibility-driven restart ──────────────────────────────────────────────────
// Mobile browsers may suspend background tabs and drop the WebSocket to the
// gateway. When the page becomes visible during an active transfer, probe the
// SDK and restart it if the connection is dead. Reusing the same clientId
// gives us the same Nym address back as long as the gateway re-accepts us.

let restarting = false;

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (!activeTransfer || !mixnet.isStarted || restarting) return;

  const ok = await mixnet.healthcheck();
  if (ok) return;

  restarting = true;
  mixnetSetState('connecting');
  try {
    const { addressChanged } = await mixnet.restart({
      onStatus: text => console.info('[mixnet restart]', text),
    });
    mixnetSetState('connected', mixnet.address);
    if (addressChanged) {
      console.warn('Nym address changed after restart; existing wormhole code is no longer valid.');
    } else {
      console.info('Nym client restarted with same address.');
    }
  } catch (err) {
    console.error('Nym restart failed:', err);
    mixnetSetState('error');
  } finally {
    restarting = false;
  }
});

// ── Dark / light theme toggle ──────────────────────────────────────────────────

(function () {
  const root   = document.documentElement;
  const btn    = $('theme-toggle');
  const DARK   = '🌙';
  const LIGHT  = '☀️';
  const stored = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  // Resolve effective theme: stored preference wins, then browser default
  const effective = stored ?? (prefersDark ? 'dark' : 'light');

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    btn.textContent = theme === 'dark' ? LIGHT : DARK;
  }

  applyTheme(effective);

  btn.addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem('theme', next);
    applyTheme(next);
  });
})();

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

/** Return text payload if blob carries the wormhole-text marker, else null. */
async function tryDecodeTextMessage(filename, blob) {
  if (filename !== TEXT_MSG_FILENAME) return null;
  if (blob.size < TEXT_MSG_MAGIC.length) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  for (let i = 0; i < TEXT_MSG_MAGIC.length; i++) {
    if (bytes[i] !== TEXT_MSG_MAGIC[i]) return null;
  }
  return new TextDecoder().decode(bytes.subarray(TEXT_MSG_MAGIC.length));
}

$('btn-connect').addEventListener('click', async () => {
  const code = $('code-input').value.trim();
  if (!code) { alert('Please enter a wormhole code.'); return; }

  $('btn-connect').disabled = true;
  showOnly(['step-r-connecting'], receivePanel);
  setStatus('status-r-connect', 'Initializing…');

  wantWakeLock = true;
  acquireWakeLock();

  try {
    await initNym(text => setStatus('status-r-connect', text));
  } catch (err) {
    showOnly(['step-r-code'], receivePanel);
    $('btn-connect').disabled = false;
    setStatus('status-r-code', `Connection failed: ${err.message}`, 'error');
    releaseWakeLock();
    return;
  }

  activeTransfer = true;
  showTransferWarning();
  try {
    await receiveFile(code, mixnet, {
      onStatus: text => setStatus('status-r-connect', text),
      onPacketSent,
      onPacketReceived,

      onOffer: async offer => {
        const isText = offer.filename === TEXT_MSG_FILENAME;
        if (isText) {
          $('offer-heading').textContent = 'Incoming text message';
          $('offer-filename').textContent = '';
          $('offer-filesize').textContent = `Size: ${formatBytes(offer.filesize)}`;
          $('btn-accept').textContent = 'Read message';
        } else {
          $('offer-heading').textContent = 'Incoming file';
          $('offer-filename').textContent = `File: ${offer.filename}`;
          $('offer-filesize').textContent = `Size: ${formatBytes(offer.filesize)}`;
          $('btn-accept').textContent = 'Accept & download';
        }
        showOnly(['step-r-offer'], receivePanel);
        return new Promise(resolve => {
          $('btn-accept').onclick = () => {
            showOnly(['step-r-progress'], receivePanel);
            setStatus('status-r-progress', isText ? 'Receiving message…' : 'Starting download…');
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

      onComplete: async (filename, blob) => {
        const text = await tryDecodeTextMessage(filename, blob);
        if (text !== null) {
          $('received-text').value = text;
          showOnly(['step-r-text'], receivePanel);
          return;
        }
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
  } finally {
    activeTransfer = false;
    hideTransferWarning();
    releaseWakeLock();
  }
});

$('btn-receive-again').addEventListener('click', () => {
  $('code-input').value = '';
  $('btn-connect').disabled = false;
  showOnly(['step-r-code'], receivePanel);
  setStatus('status-r-code', '');
});

$('btn-receive-text-again').addEventListener('click', () => {
  $('code-input').value = '';
  $('received-text').value = '';
  $('btn-connect').disabled = false;
  showOnly(['step-r-code'], receivePanel);
  setStatus('status-r-code', '');
});

$('btn-copy-text').addEventListener('click', () => {
  navigator.clipboard.writeText($('received-text').value).then(() => {
    $('btn-copy-text').textContent = 'Copied!';
    setTimeout(() => { $('btn-copy-text').textContent = 'Copy text'; }, 2000);
  });
});

// ── SEND flow ──────────────────────────────────────────────────────────────────

const sendPanel = $('panel-send');
let selectedFile = null;
let sendMode = 'file'; // 'file' | 'text'

function updateSendButtonState() {
  const btn = $('btn-send-start');
  if (sendMode === 'file') {
    btn.disabled = !selectedFile;
    btn.textContent = 'Nym it (send file)';
  } else {
    btn.disabled = $('text-input').value.length === 0;
    btn.textContent = 'Nym it (send text)';
  }
}

function setSendMode(mode) {
  sendMode = mode;
  const isFile = mode === 'file';
  $('mode-file').classList.toggle('active', isFile);
  $('mode-text').classList.toggle('active', !isFile);
  $('mode-file').setAttribute('aria-selected', String(isFile));
  $('mode-text').setAttribute('aria-selected', String(!isFile));
  $('mode-file-pane').classList.toggle('hidden', !isFile);
  $('mode-text-pane').classList.toggle('hidden', isFile);
  updateSendButtonState();
}

$('mode-file').addEventListener('click', () => setSendMode('file'));
$('mode-text').addEventListener('click', () => setSendMode('text'));

$('file-input').addEventListener('change', e => {
  selectedFile = e.target.files[0] || null;
  updateSendButtonState();
});

$('text-input').addEventListener('input', e => {
  $('text-char-count').textContent = `${e.target.value.length} characters`;
  updateSendButtonState();
});

/** Wrap a text string into a File using the wormhole-text marker. */
function buildTextMessageFile(text) {
  const textBytes = new TextEncoder().encode(text);
  const body = new Uint8Array(TEXT_MSG_MAGIC.length + textBytes.length);
  body.set(TEXT_MSG_MAGIC, 0);
  body.set(textBytes, TEXT_MSG_MAGIC.length);
  return new File([body], TEXT_MSG_FILENAME, { type: 'text/plain' });
}

$('btn-send-start').addEventListener('click', async () => {
  if (sendMode === 'text') {
    const text = $('text-input').value;
    if (!text) return;
    selectedFile = buildTextMessageFile(text);
  }
  if (!selectedFile) return;
  $('btn-send-start').disabled = true;
  showOnly(['step-s-connecting'], sendPanel);
  setStatus('status-s-connect', 'Initializing…');

  wantWakeLock = true;
  acquireWakeLock();

  try {
    await initNym(text => setStatus('status-s-connect', text));
  } catch (err) {
    showOnly(['step-s-file'], sendPanel);
    $('btn-send-start').disabled = false;
    setStatus('status-s-file', `Connection failed: ${err.message}`, 'error');
    releaseWakeLock();
    return;
  }

  activeTransfer = true;
  showTransferWarning();
  try {
    await sendFile(selectedFile, mixnet, {
      onPacketSent,
      onPacketReceived,
      onCode: code => {
        $('wormhole-code').textContent = code;
        const link = window.location.origin + window.location.pathname + '#code=' + encodeURIComponent(code);
        const linkEl = $('wormhole-link');
        linkEl.href = link;
        linkEl.textContent = link;
        renderQR($('qr-code'), link);
        const shareBtn = $('btn-share');
        if (navigator.share) {
          shareBtn.classList.remove('hidden');
          shareBtn.onclick = () => {
            navigator.share({
              title: 'Wormhole-Nym file transfer',
              text:  'Receive a file via the Nym mixnet:',
              url:   link,
            }).catch(() => {});
          };
        }
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
        $('text-input').value = '';
        $('text-char-count').textContent = '0 characters';
        $('btn-send-start').disabled = true;
        showOnly(['step-s-done'], sendPanel);
      },
    });
  } catch (err) {
    showOnly(['step-s-file'], sendPanel);
    $('btn-send-start').disabled = false;
    setStatus('status-s-file', `Error: ${err.message}`, 'error');
  } finally {
    activeTransfer = false;
    hideTransferWarning();
    releaseWakeLock();
  }
});

$('btn-copy-code').addEventListener('click', () => {
  navigator.clipboard.writeText($('wormhole-code').textContent).then(() => {
    $('btn-copy-code').textContent = 'Copied!';
    setTimeout(() => { $('btn-copy-code').textContent = 'Copy code'; }, 2000);
  });
});

$('btn-copy-link').addEventListener('click', () => {
  navigator.clipboard.writeText($('wormhole-link').href).then(() => {
    $('btn-copy-link').textContent = 'Copied!';
    setTimeout(() => { $('btn-copy-link').textContent = 'Copy link'; }, 2000);
  });
});

$('btn-send-again').addEventListener('click', () => {
  selectedFile = null;
  $('file-input').value = '';
  $('text-input').value = '';
  $('text-char-count').textContent = '0 characters';
  $('wormhole-code').textContent = '';
  $('qr-code').innerHTML = '';
  $('btn-share').classList.add('hidden');
  showOnly(['step-s-file'], sendPanel);
  setStatus('status-s-file', '');
  updateSendButtonState();
});

// ── Auto-fill code from URL fragment and auto-connect ────────────────────────
// We use the URL fragment (#code=…) so the code is never sent to any server —
// browsers don't include fragments in HTTP requests. Query-string (?code=…)
// is still parsed as a fallback for older shared links.

(function () {
  const hash      = window.location.hash.replace(/^#/, '');
  const hashParams = new URLSearchParams(hash);
  const code = hashParams.get('code')
            ?? new URLSearchParams(window.location.search).get('code');
  if (!code) return;
  $('code-input').value = code;
  // Switch to receive tab
  $('tab-receive').classList.add('active');
  $('tab-send').classList.remove('active');
  show('panel-receive'); hide('panel-send');
  // Auto-trigger connect
  $('btn-connect').click();
})();
