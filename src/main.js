/**
 * Wormhole-Nym Web — UI entry point.
 */

import qrcode from 'qrcode-generator';
import { Mixnet } from './mixnet.js';
import { receiveFile, sendFile } from './wormhole.js';
import { hostRoom, joinRoom } from './chat.js';
import { generatePassword }   from './words.js';

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

function selectTab(which) {
  for (const t of ['send', 'receive', 'chat']) {
    $(`tab-${t}`).classList.toggle('active', t === which);
    $(`panel-${t}`).classList.toggle('hidden', t !== which);
  }
}
$('tab-send').addEventListener('click',    () => selectTab('send'));
$('tab-receive').addEventListener('click', () => selectTab('receive'));
$('tab-chat').addEventListener('click',    () => { selectTab('chat'); renderRoomList(); });

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

// ── CHAT flow ─────────────────────────────────────────────────────────────────

const chatPanel = $('panel-chat');
const ROOMS_STORAGE_KEY = 'wormhole-web-chat-rooms';

/**
 * Rooms persisted to localStorage:
 *   { id, role: 'host'|'participant', name, nickname, encrypted, password?,
 *     hostAddress?, createdAt, history: [{nickname, text, ts_ms, kind, encrypted}] }
 *
 * Per-session runtime state (controller from chat.js, members) lives in
 * `liveRooms` and is NOT persisted.  When the page reloads, all rooms
 * disconnect; the user can re-host or re-join from the lobby.
 */
const liveRooms = new Map(); // roomId → { controller, members }
let currentRoomId = null;

function loadRooms() {
  try {
    const raw = localStorage.getItem(ROOMS_STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    // Convert ts_ms strings back to BigInt for history
    for (const r of arr) {
      for (const m of r.history || []) {
        if (typeof m.ts_ms === 'string') m.ts_ms = BigInt(m.ts_ms);
      }
    }
    return arr;
  } catch { return []; }
}

function saveRooms(rooms) {
  // Cap history at 200 entries per room to keep storage bounded
  const serialised = rooms.map(r => ({
    ...r,
    history: (r.history || []).slice(-200).map(m => ({ ...m, ts_ms: m.ts_ms?.toString?.() ?? String(m.ts_ms) })),
  }));
  localStorage.setItem(ROOMS_STORAGE_KEY, JSON.stringify(serialised));
}

function getRoom(id)     { return loadRooms().find(r => r.id === id); }
function upsertRoom(room) {
  const rooms = loadRooms();
  const i = rooms.findIndex(r => r.id === room.id);
  if (i >= 0) rooms[i] = room; else rooms.push(room);
  saveRooms(rooms);
}
function deleteRoom(id) {
  saveRooms(loadRooms().filter(r => r.id !== id));
}

function renderRoomList() {
  const list = $('room-list');
  const rooms = loadRooms();
  if (rooms.length === 0) {
    list.innerHTML = '<p class="status">No rooms yet. Create one to get started.</p>';
  } else {
    list.innerHTML = '';
    rooms.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    for (const r of rooms) {
      const row = document.createElement('div');
      row.className = 'room-row';
      const isLive = liveRooms.has(r.id);
      row.innerHTML = `
        <span class="room-icon">${r.encrypted ? '🔒' : '💬'}</span>
        <span class="room-name"></span>
        <span class="room-meta"></span>
        <span class="room-actions">
          <button data-act="delete" title="Delete this room">✕</button>
        </span>
      `;
      row.querySelector('.room-name').textContent = (r.name || 'Unnamed room') + (isLive ? ' • live' : '');
      const role = r.role === 'host' ? 'host' : 'participant';
      const msgCount = (r.history || []).length;
      row.querySelector('.room-meta').textContent = `${role} · ${msgCount} msg${msgCount === 1 ? '' : 's'}`;
      row.addEventListener('click', e => {
        if (e.target.closest('button[data-act]')) return;
        openRoom(r.id).catch(err => alert(`Open failed: ${err.message}`));
      });
      row.querySelector('button[data-act="delete"]').addEventListener('click', e => {
        e.stopPropagation();
        if (!confirm(`Delete room "${r.name || 'Unnamed'}"? History will be lost.`)) return;
        const live = liveRooms.get(r.id);
        live?.controller.close();
        liveRooms.delete(r.id);
        deleteRoom(r.id);
        renderRoomList();
      });
      list.appendChild(row);
    }
  }
  // Identity info
  $('identity-info').textContent = mixnet.isStarted
    ? `Your Nym address: ${mixnet.address.slice(0, 22)}…`
    : 'Nym client not yet started.';
}

function buildChatLink(room) {
  // Fragment format: #chat=<password|->:<hostAddress>:<roomName>
  // The "-" sentinel means plain (unencrypted) room.
  const parts = [
    room.encrypted ? room.password : '-',
    room.hostAddress,
    room.name || '',
  ];
  const payload = parts.map(s => encodeURIComponent(s)).join(':');
  return window.location.origin + window.location.pathname + '#chat=' + payload;
}

function parseChatFragment(value) {
  // value is everything after #chat=
  const parts = value.split(':').map(decodeURIComponent);
  if (parts.length < 2) throw new Error('Invalid chat link');
  const [pwOrDash, hostAddress, roomName = ''] = parts;
  return {
    password:  pwOrDash === '-' ? null : pwOrDash,
    hostAddress,
    roomName,
  };
}

function fmtTime(ts_ms) {
  const n = typeof ts_ms === 'bigint' ? Number(ts_ms) : ts_ms;
  const d = new Date(n);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendChatMessage(roomId, msg) {
  const room = getRoom(roomId);
  if (!room) return;
  room.history = room.history || [];
  room.history.push(msg);
  upsertRoom(room);
  if (currentRoomId === roomId) renderChatMessage(msg);
}

function renderChatMessage(msg) {
  const wrap = $('chat-messages');
  const el = document.createElement('div');
  if (msg.kind === 'system') {
    el.className = 'chat-msg system';
    el.innerHTML = `<span class="chat-text"></span>`;
    el.querySelector('.chat-text').textContent = `— ${msg.text} —`;
  } else {
    const room = getRoom(currentRoomId);
    const isYou = room && msg.nickname === room.nickname;
    el.className = 'chat-msg' + (isYou ? ' you' : '');
    el.innerHTML = `
      <span class="chat-ts"></span>
      <span class="chat-nick"></span>
      <span class="chat-lock-mini"></span>
      <span class="chat-text"></span>
    `;
    el.querySelector('.chat-ts').textContent  = fmtTime(msg.ts_ms);
    el.querySelector('.chat-nick').textContent = msg.nickname + ':';
    el.querySelector('.chat-lock-mini').textContent = msg.encrypted ? '🔒' : '';
    el.querySelector('.chat-text').textContent = msg.text;
  }
  wrap.appendChild(el);
  wrap.scrollTop = wrap.scrollHeight;
}

function renderChatRoom(room) {
  $('chat-room-name').textContent = room.name || (room.role === 'host' ? 'My room' : 'Joined room');
  $('chat-lock').classList.toggle('hidden', !room.encrypted);
  $('chat-messages').innerHTML = '';
  for (const m of room.history || []) renderChatMessage(m);
  // Share button only for host
  $('btn-chat-share').classList.toggle('hidden', room.role !== 'host');
  $('chat-share-area').classList.add('hidden');
  // Members
  const live = liveRooms.get(room.id);
  const members = live?.members ?? [room.nickname];
  renderMembers(members, room.nickname);
}

function renderMembers(members, you) {
  const wrap = $('chat-members');
  wrap.innerHTML = '';
  for (const m of members) {
    const chip = document.createElement('span');
    chip.className = 'chat-member-chip' + (m === you ? ' you' : '');
    chip.textContent = m + (m === you ? ' (you)' : '');
    wrap.appendChild(chip);
  }
}

async function ensureNymStarted() {
  if (!mixnet.isStarted) {
    showOnly(['step-c-connecting'], chatPanel);
    setStatus('status-c-connect', 'Initializing Nym client…');
    await initNym(text => setStatus('status-c-connect', text));
  }
}

// ─ Open existing room from list ────────────────────────────────────────────
async function openRoom(roomId) {
  const room = getRoom(roomId);
  if (!room) throw new Error('Room not found');
  await ensureNymStarted();

  // If not live, try to (re)connect
  if (!liveRooms.has(roomId)) {
    if (room.role === 'host') {
      await startHosting(room);
    } else {
      // Participant: rejoin
      await startJoining(room, /*persisted=*/true);
    }
  }
  currentRoomId = roomId;
  renderChatRoom(room);
  showOnly(['step-c-room'], chatPanel);
}

// ─ Host helpers ────────────────────────────────────────────────────────────
async function startHosting(room) {
  // Update host address to current one (may have changed after identity refresh)
  room.hostAddress = mixnet.address;
  upsertRoom(room);

  const controller = hostRoom({
    roomName: room.name,
    nickname: room.nickname,
    password: room.encrypted ? room.password : null,
    mixnet,
    callbacks: {
      onMessage: msg => {
        appendChatMessage(room.id, msg);
      },
      onMembersChanged: members => {
        const live = liveRooms.get(room.id);
        if (live) {
          live.members = members;
          if (currentRoomId === room.id) renderMembers(members, room.nickname);
        }
      },
    },
  });
  liveRooms.set(room.id, { controller, members: [room.nickname] });
}

// ─ Participant helpers ─────────────────────────────────────────────────────
async function startJoining(room, persisted) {
  setStatus('status-c-connect', 'Joining room…');
  const controller = await joinRoom({
    hostAddress: room.hostAddress,
    nickname:    room.nickname,
    password:    room.encrypted ? room.password : null,
    mixnet,
    callbacks: {
      onMessage: msg => appendChatMessage(room.id, msg),
      onStatus:  text => setStatus('status-c-connect', text),
      onClosed:  reason => {
        appendChatMessage(room.id, { nickname: '', text: reason || 'Connection closed', ts_ms: BigInt(Date.now()), kind: 'system', encrypted: room.encrypted });
        liveRooms.delete(room.id);
      },
    },
  });
  // Pick up the canonical room name from the host's JoinAck the first time
  if (!persisted || !room.name) {
    room.name = controller.roomName || room.name || 'Joined room';
    upsertRoom(room);
  }
  liveRooms.set(room.id, { controller, members: [room.nickname] });
}

// ─ Create-room button ──────────────────────────────────────────────────────
$('btn-create-room').addEventListener('click', () => {
  $('create-nickname').value = '';
  $('create-roomname').value = '';
  $('create-password').value = '';
  setStatus('status-c-create', '');
  showOnly(['step-c-create'], chatPanel);
});
$('btn-create-cancel').addEventListener('click', () => {
  showOnly(['step-c-lobby'], chatPanel);
  renderRoomList();
});
$('btn-suggest-password').addEventListener('click', () => {
  $('create-password').value = generatePassword(3);
});

$('btn-create-confirm').addEventListener('click', async () => {
  const nickname = $('create-nickname').value.trim();
  if (!nickname) { setStatus('status-c-create', 'Nickname is required.', 'error'); return; }
  const roomName = $('create-roomname').value.trim() || `${nickname}'s room`;
  const password = $('create-password').value.trim() || null;

  $('btn-create-confirm').disabled = true;
  setStatus('status-c-create', 'Starting Nym client…');
  try {
    await ensureNymStarted();
  } catch (err) {
    setStatus('status-c-create', `Failed: ${err.message}`, 'error');
    $('btn-create-confirm').disabled = false;
    return;
  }

  const room = {
    id: `r-${crypto.randomUUID().slice(0, 8)}`,
    role: 'host',
    name: roomName,
    nickname,
    encrypted: !!password,
    password: password || undefined,
    hostAddress: mixnet.address,
    createdAt: Date.now(),
    history: [],
  };
  upsertRoom(room);
  await startHosting(room);
  $('btn-create-confirm').disabled = false;
  currentRoomId = room.id;
  renderChatRoom(room);
  showOnly(['step-c-room'], chatPanel);
});

// ─ Join-form (entered from #chat= link) ────────────────────────────────────
let pendingJoin = null; // { hostAddress, password, roomName }

function openJoinForm(parsed) {
  pendingJoin = parsed;
  $('join-room-info').innerHTML = parsed.password
    ? '🔒 This room is password-protected.'
    : '💬 Plain room (no end-to-end encryption).';
  $('join-password').value = parsed.password || '';
  $('join-password-field').classList.toggle('hidden', !parsed.password);
  $('join-nickname').value = '';
  setStatus('status-c-join', '');
  selectTab('chat');
  showOnly(['step-c-join'], chatPanel);
}

$('btn-join-cancel').addEventListener('click', () => {
  pendingJoin = null;
  showOnly(['step-c-lobby'], chatPanel);
  renderRoomList();
});

$('btn-join-confirm').addEventListener('click', async () => {
  if (!pendingJoin) return;
  const nickname = $('join-nickname').value.trim();
  if (!nickname) { setStatus('status-c-join', 'Nickname is required.', 'error'); return; }
  const password = pendingJoin.password ? $('join-password').value : null;

  $('btn-join-confirm').disabled = true;
  setStatus('status-c-join', 'Starting Nym client…');
  showOnly(['step-c-connecting'], chatPanel);
  try {
    await ensureNymStarted();
  } catch (err) {
    setStatus('status-c-join', `Failed: ${err.message}`, 'error');
    showOnly(['step-c-join'], chatPanel);
    $('btn-join-confirm').disabled = false;
    return;
  }

  const room = {
    id: `r-${crypto.randomUUID().slice(0, 8)}`,
    role: 'participant',
    name: pendingJoin.roomName || 'Joined room',
    nickname,
    encrypted: !!password,
    password: password || undefined,
    hostAddress: pendingJoin.hostAddress,
    createdAt: Date.now(),
    history: [],
  };
  upsertRoom(room);

  try {
    await startJoining(room, false);
  } catch (err) {
    setStatus('status-c-join', `Join failed: ${err.message}`, 'error');
    deleteRoom(room.id);
    showOnly(['step-c-join'], chatPanel);
    $('btn-join-confirm').disabled = false;
    return;
  }

  $('btn-join-confirm').disabled = false;
  pendingJoin = null;
  currentRoomId = room.id;
  renderChatRoom(getRoom(room.id));
  showOnly(['step-c-room'], chatPanel);
});

// ─ Refresh identity ────────────────────────────────────────────────────────
$('btn-refresh-identity').addEventListener('click', async () => {
  if (!confirm(
    'Refreshing your identity generates a new Nym address.\n\n' +
    'Existing rooms hosted by you will become unreachable until you re-share their links. ' +
    'Any room you joined will lose its connection.\n\nProceed?'
  )) return;

  // Close all live rooms
  for (const [id, live] of liveRooms) live.controller.close();
  liveRooms.clear();

  // Generate fresh clientId
  const newId = `wormhole-web-${crypto.randomUUID().slice(0, 8)}`;
  localStorage.setItem(CLIENT_ID_KEY, newId);

  // Restart mixnet
  try {
    if (mixnet.isStarted) {
      await mixnet.restart({ onStatus: t => setStatus('status-c-connect', t) });
    }
  } catch (err) {
    alert('Restart failed: ' + err.message);
    return;
  }
  renderRoomList();
  alert('New identity active. Share new links from your hosted rooms.');
});

// ─ Chat send form ──────────────────────────────────────────────────────────
$('chat-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!currentRoomId) return;
  const text = $('chat-input').value.trim();
  if (!text) return;
  const live = liveRooms.get(currentRoomId);
  if (!live) { alert('Room is not live.'); return; }
  $('chat-input').value = '';
  try {
    await live.controller.say(text);
  } catch (err) {
    alert('Send failed: ' + err.message);
  }
});

// ─ Share / leave ───────────────────────────────────────────────────────────
$('btn-chat-share').addEventListener('click', () => {
  const room = getRoom(currentRoomId);
  if (!room) return;
  const link = buildChatLink(room);
  $('chat-share-link').textContent = link;
  $('chat-share-area').classList.remove('hidden');
});
$('btn-chat-share-close').addEventListener('click', () => {
  $('chat-share-area').classList.add('hidden');
});
$('btn-chat-copy-link').addEventListener('click', () => {
  const link = $('chat-share-link').textContent;
  navigator.clipboard.writeText(link).then(() => {
    $('btn-chat-copy-link').textContent = 'Copied!';
    setTimeout(() => { $('btn-chat-copy-link').textContent = 'Copy link'; }, 2000);
  });
});

$('btn-chat-leave').addEventListener('click', () => {
  if (!currentRoomId) return;
  const live = liveRooms.get(currentRoomId);
  if (live) {
    // For participant, close = leave; for host, leave just returns to lobby (room stays).
    const room = getRoom(currentRoomId);
    if (room?.role === 'participant') {
      live.controller.close();
      liveRooms.delete(currentRoomId);
    }
  }
  currentRoomId = null;
  showOnly(['step-c-lobby'], chatPanel);
  renderRoomList();
});

// ── Auto-route from URL fragment ─────────────────────────────────────────────
// We use the URL fragment (#code=…, #chat=…) so the secret never reaches any
// server — browsers don't include fragments in HTTP requests. Query-string
// (?code=…) is still parsed as a fallback for older shared links.

(function () {
  const hash       = window.location.hash.replace(/^#/, '');
  const hashParams = new URLSearchParams(hash);

  // Wormhole transfer link
  const code = hashParams.get('code')
            ?? new URLSearchParams(window.location.search).get('code');
  if (code) {
    $('code-input').value = code;
    selectTab('receive');
    $('btn-connect').click();
    return;
  }

  // Chat room link: #chat=<password|->:<hostAddress>:<roomName>
  const chat = hashParams.get('chat');
  if (chat) {
    try {
      openJoinForm(parseChatFragment(chat));
    } catch (err) {
      alert('Invalid chat link: ' + err.message);
    }
    return;
  }
})();

// Render the initial room list state on load
renderRoomList();
