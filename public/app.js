const $app = document.querySelector('#app');
const TOKEN_KEY = 'lanDropToken';
const DEVICE_KEY = 'lanDropDevice';
const REVISION_KEY = 'lanDropRevision';
const POLL_MS = 2500;
const PAGE_SESSION = Math.random().toString(36).slice(2);
const UPLOAD_TIMEOUT_MS = 120_000;

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  deviceName: localStorage.getItem(DEVICE_KEY) || '',
  revision: Number(localStorage.getItem(REVISION_KEY) || 0),
  items: [],
  imageUrls: new Map(),
  imageRequests: new Map(),
  qrUrl: '',
  connected: false,
  accessCode: '',
  pollTimer: null,
  pollGeneration: 0,
  qrGeneration: 0,
  connectUrl: '',
  maxItemBytes: 20 * 1024 * 1024,
  maxTextChars: 20_000,
};

const app = document.createElement('main');
app.className = 'shell';
if (!$app) throw new Error('页面缺少 #app');

function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 2400);
}

function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  return fetch(path, { ...options, headers });
}

function setStatus(text, mode) {
  const status = document.querySelector('.status');
  if (!status) return;
  status.className = `status ${mode || ''}`;
  status.querySelector('.status-label').textContent = text;
}

function bytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function timeAgo(ts) {
  const delta = Date.now() - ts;
  if (delta < 60_000) return '刚刚';
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / 60 / 60_000)} 小时前`;
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function renderLock() {
  $app.innerHTML = '';
  releaseImageUrls();
  cancelPolling();
  document.body.classList.remove('app-ready');
  const lock = document.createElement('div');
  lock.className = 'lock';
  const form = document.createElement('form');
  form.className = 'lock-card';
  form.innerHTML = `
    <svg class="lock-icon" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#24332B"/><path d="M18 22h28v20H18z" fill="#FAF7F0"/><path d="M25 30l7 8 5-5 9 10" fill="none" stroke="#6F9A78" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="44" cy="27" r="3" fill="#8ABF91"/></svg>
    <h1>隔空小站</h1>
    <p>把这一刻，传到另一台设备。</p>
    <label for="access-code" class="visually-hidden">访问码</label>
    <input id="access-code" class="code-input" maxlength="12" placeholder="输入访问码" autocomplete="one-time-code" inputmode="text" required>
    <div class="actions lock-actions"><button class="primary lock-submit" type="submit">进入</button></div>
    <div class="hint lock-error" id="lock-error"></div>
  `;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = form.querySelector('.code-input');
    const errorEl = form.querySelector('#lock-error');
    const button = form.querySelector('button[type="submit"]');
    if (button.disabled) return;
    errorEl.textContent = '';
    button.disabled = true;
    try {
      const res = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: input.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        errorEl.textContent = data.error || '访问码不正确';
        if (res.status === 429) errorEl.textContent += '，请稍后再试';
        button.disabled = false;
        return;
      }
      state.token = data.token;
      localStorage.setItem(TOKEN_KEY, state.token);
      state.accessCode = data.accessCode;
      await startApp(data.deviceId);
    } catch {
      errorEl.textContent = '连接失败，请检查网络';
      button.disabled = false;
    }
  });
  lock.append(form);
  $app.append(lock);
  form.querySelector('.code-input').focus();
}

async function connectFromHash() {
  const hash = location.hash;
  if (!hash.startsWith('#token=')) return false;
  let token = '';
  try { token = decodeURIComponent(hash.slice('#token='.length)); } catch {}
  history.replaceState(null, '', location.pathname + location.search);
  if (!token) return false;
  state.token = token;
  localStorage.setItem(TOKEN_KEY, state.token);
  try {
    const res = await api('/api/state');
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      state.token = '';
      localStorage.removeItem(TOKEN_KEY);
      return false;
    }
    state.accessCode = '';
    state.maxItemBytes = data.config.maxItemBytes;
    state.maxTextChars = data.config.maxTextChars;
    await startApp(data.deviceId);
    return true;
  } catch {
    return false;
  }
}

async function startApp(deviceId = '') {
  if (!state.deviceName) {
    state.deviceName = deviceId || `设备-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    localStorage.setItem(DEVICE_KEY, state.deviceName);
  }
  renderShell();
  await refreshItems(true);
  cancelPolling();
  state.pollGeneration += 1;
  pollLoop();
}

function renderShell() {
  $app.innerHTML = '';
  document.body.classList.add('app-ready');
  app.innerHTML = `
    <header class="masthead">
      <div class="brand">
        <div class="brand-icon">
          <svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#24332B"/><path d="M18 22h28v20H18z" fill="#FAF7F0"/><path d="M25 30l7 8 5-5 9 10" fill="none" stroke="#6F9A78" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="44" cy="27" r="3" fill="#8ABF91"/></svg>
        </div>
        <div>
          <h1>隔空小站</h1>
          <p>把这一刻，传到另一台设备。</p>
        </div>
      </div>
      <div class="status offline"><span class="status-dot"></span><span class="status-label">正在连接</span></div>
    </header>
    <section class="card connect-card" aria-labelledby="connect-title">
      <div class="connect-copy">
        <div>
          <h2 id="connect-title">手机扫码，继续传</h2>
          <p>手机与电脑连在同一 Wi-Fi 后扫一扫。</p>
        </div>
        <div class="connect-body" id="connect-body">正在获取局域网地址…</div>
      </div>
      <div class="qr-wrap" id="qr-wrap" aria-live="polite"></div>
    </section>
    <section class="grid">
      <div class="card send-card">
        <h2>发送到共享收件箱</h2>
        <div class="device-row">
          <label for="device-name" class="visually-hidden">设备名（仅保存在当前浏览器）</label>
          <input id="device-name" maxlength="40" value="${escapeAttr(state.deviceName)}" placeholder="给这台设备起个名字">
          <button class="ghost" id="save-device">保存</button>
        </div>
        <div class="editor">
          <label for="text-input" class="visually-hidden">要发送的文字</label>
          <textarea id="text-input" placeholder="输入文字，粘贴到这里也行"></textarea>
          <div class="actions">
            <button class="primary" id="send-text">发送文字</button>
            <button class="ghost" id="pick-image">选择图片</button>
            <button class="ghost" id="clear-all">清空收件箱</button>
          </div>
        </div>
        <div class="dropzone" id="dropzone">
          <strong>拖拽图片到这里</strong>
          <div>或 Ctrl/⌘ + V 粘贴文字和图片</div>
        </div>
        <input type="file" id="file-input" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/heic,image/heif" multiple hidden>
        <div class="upload-list" id="upload-list"></div>
        <div class="hint">支持 PNG / JPEG / GIF / WebP / AVIF / HEIC，单个最大 20 MiB，文字最多 2 万字符；图片和文字共用 512 MiB 总存储。</div>
      </div>
      <div class="card inbox-card">
        <div class="inbox-head">
          <h2>收件箱</h2>
          <button class="ghost" id="refresh">刷新</button>
        </div>
        <div class="items" id="items"></div>
        <div class="empty hidden" id="empty">还没有内容，发一条文字或图片试试。</div>
      </div>
    </section>
  `;
  $app.append(app);
  bindShell();
  bindDevice();
  renderConnect();
  renderItems();
}

function escapeAttr(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function bindShell() {
  document.querySelector('#save-device').addEventListener('click', () => {
    state.deviceName = document.querySelector('#device-name').value.trim() || '我的设备';
    localStorage.setItem(DEVICE_KEY, state.deviceName);
    toast('设备名已保存');
  });
  document.querySelector('#send-text').addEventListener('click', sendText);
  document.querySelector('#pick-image').addEventListener('click', () => document.querySelector('#file-input').click());
  document.querySelector('#file-input').addEventListener('change', (event) => uploadFiles([...event.target.files]));
  document.querySelector('#file-input').addEventListener('click', (event) => {
    event.currentTarget.value = '';
  });
  document.querySelector('#refresh').addEventListener('click', () => refreshItems(true));
  document.querySelector('#clear-all').addEventListener('click', clearAll);
  document.querySelector('#text-input').addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      sendText();
    }
  });
  bindDropzone();
  bindPaste();
}

function bindDevice() {
  const input = document.querySelector('#device-name');
  input.addEventListener('change', () => {
    state.deviceName = input.value.trim() || '我的设备';
    localStorage.setItem(DEVICE_KEY, state.deviceName);
  });
}

function bindDropzone() {
  const zone = document.querySelector('#dropzone');
  ['dragenter', 'dragover'].forEach((name) => zone.addEventListener(name, (event) => {
    event.preventDefault();
    zone.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach((name) => zone.addEventListener(name, (event) => {
    event.preventDefault();
    zone.classList.remove('drag');
  }));
  zone.addEventListener('drop', (event) => {
    const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith('image/'));
    uploadFiles(files);
  });
}

function bindPaste() {
  document.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith('image/'));
    if (files.length) {
      event.preventDefault();
      uploadFiles(files);
      return;
    }
    if (document.activeElement?.matches('textarea, input')) return;
    const text = event.clipboardData?.getData('text/plain');
    if (text) {
      event.preventDefault();
      appendSuggestedText(text);
      toast('已粘贴文字，点发送即可');
    }
  });
}

function bindConnect() {
  const input = document.querySelector('#connect-host');
  if (!input) return;
  input.addEventListener('input', () => scheduleQr());
  input.addEventListener('change', () => scheduleQr());
  document.querySelector('#connect-form').addEventListener('submit', (event) => {
    event.preventDefault();
    scheduleQr();
  });
  document.querySelector('#copy-link').addEventListener('click', async () => {
    if (!state.connectUrl) return;
    try {
      await copyText(state.connectUrl);
      toast('链接已复制');
    } catch {
      showSelectableText(state.connectUrl);
      toast('复制失败，请手动选择链接');
    }
  });
}

function showConnectForm(hosts) {
  const body = document.querySelector('#connect-body');
  const current = locationHostname();
  const preferred = hosts.includes(current) ? current : hosts[0] || '';
  body.innerHTML = `
    <form id="connect-form" class="connect-form" novalidate>
      <label for="connect-host" class="field-label">局域网 IP</label>
      <div class="connect-input">
        <input id="connect-host" list="lan-hosts" value="${escapeAttr(preferred)}" autocomplete="off" spellcheck="false" aria-describedby="connect-hint">
        <datalist id="lan-hosts">${hosts.map((host) => `<option value="${escapeAttr(host)}"></option>`).join('')}</datalist>
        <span class="port-label">端口 <output id="connect-port">${escapeAttr(connectionPort())}</output></span>
        <button class="primary" type="submit">生成</button>
      </div>
      <div class="hint" id="connect-hint" role="status">输入 IP 后自动生成，按 Enter 可立即重试；二维码包含访问令牌。</div>
    </form>
    <div class="connect-link-row">
      <span class="connect-link" id="connect-link" aria-live="polite">请选择本机局域网 IP</span>
      <button class="ghost" id="copy-link" type="button" disabled>复制链接</button>
    </div>
  `;
  bindConnect();
}

async function renderConnect() {
  const generation = ++state.qrGeneration;
  const body = document.querySelector('#connect-body');
  const qrWrap = document.querySelector('#qr-wrap');
  if (!body || !qrWrap) return;
  clearQr(qrWrap, '正在获取本机地址…');
  body.innerHTML = '正在获取局域网地址…';
  let response;
  let data;
  try {
    response = await api('/api/state');
    data = await response.json().catch(() => ({}));
    if (generation !== state.qrGeneration) return;
    if (!response.ok) {
      const error = new Error(data.error || '无法获得本机地址');
      error.status = response.status;
      throw error;
    }
  } catch (error) {
    if (generation !== state.qrGeneration) return;
    await handleAuthError(error);
    if (generation !== state.qrGeneration) return;
    body.innerHTML = '<span role="alert">地址获取失败，暂时无法生成二维码。</span><button class="ghost retry-connect" type="button">重试</button>';
    body.querySelector('.retry-connect').addEventListener('click', renderConnect);
    clearQr(qrWrap, '暂时无法生成二维码');
    return;
  }
  const hosts = data.allowedHosts || [];
  if (!hosts.length) {
    body.textContent = '没有可用的局域网 IPv4 地址，请检查网络接口。';
    clearQr(qrWrap, '没有可用的局域网地址');
    return;
  }
  showConnectForm(hosts);
  const current = locationHostname();
  scheduleQr(hosts.includes(current) ? current : hosts[0], hosts);
}

let qrTimer = null;
function scheduleQr(host = document.querySelector('#connect-host')?.value, allowedHosts) {
  clearTimeout(qrTimer);
  qrTimer = null;
  const generation = ++state.qrGeneration;
  const body = document.querySelector('#connect-body');
  const qrWrap = document.querySelector('#qr-wrap');
  if (!body || !qrWrap) return;
  state.connectUrl = '';
  const link = body.querySelector('#connect-link');
  const copyButton = body.querySelector('#copy-link');
  if (link) link.textContent = '';
  if (copyButton) copyButton.disabled = true;
  const hint = body.querySelector('#connect-hint');
  if (hint) hint.textContent = '输入 IP 后自动生成，按 Enter 可立即重试；二维码包含访问令牌。';
  clearQr(qrWrap, '正在生成二维码…');
  qrTimer = setTimeout(() => loadQr(host, generation, allowedHosts), 200);
}

async function loadQr(host, generation, allowedHosts) {
  const normalizedHost = String(host || '').trim();
  const body = document.querySelector('#connect-body');
  const qrWrap = document.querySelector('#qr-wrap');
  if (!body || !qrWrap || generation !== state.qrGeneration) return;
  const hint = body.querySelector('#connect-hint');
  if (!normalizedHost) {
    if (hint) hint.textContent = '请输入局域网 IP 地址';
    clearQr(qrWrap, '等待可用的局域网 IP');
    return;
  }
  try {
    const hosts = allowedHosts || await fetchAllowedHosts(generation);
    if (generation !== state.qrGeneration) return;
    if (!hosts.includes(normalizedHost)) {
      throw new Error('这个 IP 不在本机允许的局域网地址中，请从提示地址选择或输入本机 IP。');
    }
    const response = await api(`/api/qr?host=${encodeURIComponent(normalizedHost)}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const error = new Error(data.error || '二维码生成失败，请检查 IP 后重试。');
      error.status = response.status;
      throw error;
    }
    const blob = await response.blob();
    if (generation !== state.qrGeneration) return;
    if (!blob.type.startsWith('image/')) throw new Error('二维码响应格式不正确，请重试。');
    const image = await loadQrImage(blob, normalizedHost);
    if (generation !== state.qrGeneration) return;
    const objectUrl = URL.createObjectURL(blob);
    image.src = objectUrl;
    releaseQrUrl();
    state.qrUrl = objectUrl;
    qrWrap.dataset.host = normalizedHost;
    qrWrap.dataset.loaded = 'true';
    qrWrap.replaceChildren(image);
    state.connectUrl = buildConnectUrl(normalizedHost, state.token);
    body.querySelector('#connect-link').textContent = state.connectUrl;
    body.querySelector('#copy-link').disabled = false;
    if (hint) hint.textContent = '二维码和链接已按此地址生成。';
  } catch (error) {
    if (generation !== state.qrGeneration) return;
    await handleAuthError(error);
    if (generation !== state.qrGeneration) return;
    state.connectUrl = '';
    if (hint) hint.textContent = error.message || '二维码生成失败，请检查 IP 后重试。';
    clearQr(qrWrap, '暂无可用的连接二维码');
    body.querySelector('#connect-link').textContent = '';
    body.querySelector('#copy-link').disabled = true;
  }
}

async function fetchAllowedHosts(generation) {
  const response = await api('/api/state');
  const data = await response.json().catch(() => ({}));
  if (generation !== state.qrGeneration) return [];
  if (!response.ok) {
    const error = new Error(data.error || '无法验证局域网地址');
    error.status = response.status;
    throw error;
  }
  return data.allowedHosts || [];
}

function loadQrImage(blob, host) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(blob);
    image.alt = `使用 ${host} 连接的二维码`;
    image.addEventListener('load', () => {
      resolve(image);
      queueMicrotask(() => URL.revokeObjectURL(objectUrl));
    }, { once: true });
    image.addEventListener('error', () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('二维码图片加载失败'));
    }, { once: true });
    image.src = objectUrl;
  });
}

function clearQr(qrWrap, message) {
  releaseQrUrl();
  delete qrWrap.dataset.host;
  delete qrWrap.dataset.loaded;
  qrWrap.textContent = message;
}

function connectionPort() {
  return location.port || '80';
}

function buildConnectUrl(host, token) {
  const suffix = token ? `#token=${encodeURIComponent(token)}` : '';
  const safeHost = host.includes(':') ? `[${host}]` : host;
  return `http://${safeHost}:${connectionPort()}/${suffix}`;
}

function locationHostname() {
  return location.hostname.replace(/^\[|\]$/g, '');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand?.('copy') ?? false;
    area.remove();
    if (!ok) throw new Error('copy failed');
    return true;
  }
}

async function sendText() {
  const textarea = document.querySelector('#text-input');
  const text = textarea.value;
  if (!text.trim()) {
    toast('先输入一点文字');
    return;
  }
  if ([...text].length > state.maxTextChars) {
    toast(`文字超过 ${state.maxTextChars} 字符上限`);
    return;
  }
  const button = document.querySelector('#send-text');
  if (button.disabled) return;
  button.disabled = true;
  try {
    const res = await api('/api/items', {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: text,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || '发送失败');
    textarea.value = '';
    state.revision = data.revision;
    localStorage.setItem(REVISION_KEY, state.revision);
    await refreshItems(true);
    toast('已发送');
  } catch (error) {
    toast(error.message || '发送失败');
  } finally {
    button.disabled = false;
  }
}

function uploadFiles(files) {
  const input = document.querySelector('#file-input');
  if (input) input.value = '';
  for (const file of files) uploadOne(file);
}

async function uploadOne(file) {
  const list = document.querySelector('#upload-list');
  const row = document.createElement('div');
  row.className = 'upload-row';
  row.innerHTML = `<span class="name">${escapeAttr(file.name)}</span><span class="bar"><i></i></span><span class="state">0%</span>`;
  list.prepend(row);
  const bar = row.querySelector('i');
  const stateEl = row.querySelector('.state');
  if (file.size > state.maxItemBytes) {
    row.classList.add('fail');
    stateEl.textContent = `超过 ${Math.ceil(state.maxItemBytes / 1024 / 1024)} MiB`;
    return;
  }
  if (!file.type.startsWith('image/')) {
    row.classList.add('fail');
    stateEl.textContent = '不是图片';
    return;
  }
  try {
    const xhr = new XMLHttpRequest();
    const result = await new Promise((resolve, reject) => {
      xhr.open('POST', '/api/items');
      xhr.timeout = UPLOAD_TIMEOUT_MS;
      if (state.token) xhr.setRequestHeader('authorization', `Bearer ${state.token}`);
      xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
      xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100);
          bar.style.width = `${percent}%`;
          stateEl.textContent = `${percent}%`;
        }
      };
      xhr.onload = () => {
        const contentType = xhr.getResponseHeader('content-type') || '';
        if (contentType.includes('application/json')) {
          const data = JSON.parse(xhr.responseText || '{}');
          resolve({ ok: xhr.status >= 200 && xhr.status < 300, data });
        } else {
          resolve({ ok: xhr.status >= 200 && xhr.status < 300, data: {} });
        }
      };
      xhr.onerror = () => reject(new Error('网络失败'));
      xhr.ontimeout = () => reject(new Error('上传超时'));
      xhr.onabort = () => reject(new Error('上传已取消'));
      xhr.onloadend = () => {
        if (xhr.status === 401) invalidateSession('连接已失效，请重新输入访问码');
      };
      xhr.send(file);
    });
    if (!result.ok) throw new Error(result.data?.error || `上传失败（${xhr.status}）`);
    row.classList.add('ok');
    stateEl.textContent = '完成';
    state.revision = result.data.revision;
    localStorage.setItem(REVISION_KEY, state.revision);
    await refreshItems(true);
  } catch (error) {
    row.classList.add('fail');
    stateEl.textContent = error.message || '上传失败';
  }
}

async function clearAll() {
  if (!confirm('确定清空收件箱吗？此操作会删除这台设备上的所有内容。')) return;
  const items = [...state.items];
  const results = await Promise.all(items.map((item) => api(`/api/delete/${encodeURIComponent(item.id)}`, { method: 'POST' })));
  if (results.some((res) => res.status === 401)) {
    invalidateSession('连接已失效，请重新输入访问码');
    return;
  }
  if (results.some((res) => !res.ok && res.status !== 404)) toast('部分内容删除失败');
  await refreshItems(true);
}

async function refreshItems(force = false) {
  const url = new URL('/api/items', location.origin);
  if (!force) url.searchParams.set('revision', String(state.revision));
  try {
    const res = await api(url.pathname + url.search);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      invalidateSession(data.error || '连接已失效，请重新输入访问码');
      return;
    }
    if (!res.ok || !data.ok) throw new Error(data.error || '同步失败');
    if (data.unchanged && !force) {
      setStatus('已连接', 'online');
      return;
    }
    state.revision = data.revision;
    localStorage.setItem(REVISION_KEY, state.revision);
    state.items = data.items || [];
    renderItems();
    setStatus('已连接', 'online');
    state.connected = true;
  } catch (error) {
    setStatus('连接中断', 'offline');
    state.connected = false;
    if (force) toast(error.message || '同步失败');
  }
}

function renderItems() {
  const list = document.querySelector('#items');
  const empty = document.querySelector('#empty');
  if (!list) return;
  list.innerHTML = '';
  if (!state.items.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  const currentIds = new Set(state.items.map((item) => item.id));
  for (const [id, objectUrl] of state.imageUrls) {
    if (currentIds.has(id)) continue;
    URL.revokeObjectURL(objectUrl);
    state.imageUrls.delete(id);
  }
  for (const item of state.items) {
    list.append(buildItem(item));
  }
}

function buildItem(item) {
  const card = document.createElement('article');
  card.className = 'item';
  card.dataset.id = item.id;
  const meta = document.createElement('div');
  meta.className = 'item-meta';
  const kind = document.createElement('span');
  kind.className = 'item-kind';
  kind.textContent = item.kind === 'image' ? '图片' : '文字';
  const time = document.createElement('span');
  time.textContent = timeAgo(item.createdAt);
  meta.append(kind, time);
  card.append(meta);

  if (item.kind === 'image') {
    const img = document.createElement('img');
    img.className = 'item-image';
    img.loading = 'lazy';
    img.alt = item.originalName || '图片';
    img.addEventListener('click', () => window.open(img.src, '_blank', 'noopener'));
    loadImage(item.id, img);
    card.append(img);
  } else {
    const pre = document.createElement('div');
    pre.className = 'item-text';
    pre.textContent = item.text;
    card.append(pre);
  }

  const actions = document.createElement('div');
  actions.className = 'item-actions';
  const copy = document.createElement('button');
  copy.className = 'ghost';
  copy.textContent = item.kind === 'image' ? '复制图片' : '复制文字';
  copy.addEventListener('click', async () => {
    try {
      if (item.kind === 'text') {
        await copyText(item.text);
      } else {
        const res = await api(`/api/items/${encodeURIComponent(item.id)}/image`);
        if (!res.ok) throw new Error('图片获取失败');
        const blob = await res.blob();
        await copyImage(blob);
      }
      toast('已复制');
    } catch {
      showSelectableText(item.kind === 'text' ? item.text : '图片复制失败，请长按图片保存或下载原图');
    }
  });
  actions.append(copy);

  if (item.kind === 'image') {
    const download = document.createElement('button');
    download.className = 'ghost';
    download.textContent = '下载原图';
    download.addEventListener('click', async () => {
      download.disabled = true;
      try {
        const res = await api(`/api/items/${encodeURIComponent(item.id)}/download`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || '下载失败');
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = item.originalName || `image-${item.id}`;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) {
        toast(error.message || '下载失败');
      } finally {
        download.disabled = false;
      }
    });
    actions.append(download);
  }

  const del = document.createElement('button');
  del.className = 'danger';
  del.textContent = '删除';
  del.addEventListener('click', async () => {
    if (!confirm('删除这条内容吗？')) return;
    const res = await api(`/api/delete/${encodeURIComponent(item.id)}`, { method: 'POST' });
    if (res.ok) {
      state.items = state.items.filter((entry) => entry.id !== item.id);
      renderItems();
    } else {
      toast('删除失败');
    }
  });
  actions.append(del);
  card.append(actions);
  return card;
}

async function loadImage(id, img) {
  if (state.imageUrls.has(id)) {
    img.src = state.imageUrls.get(id);
    return;
  }
  if (state.imageRequests.has(id)) {
    await state.imageRequests.get(id).promise;
    loadImage(id, img);
    return;
  }
  const request = { canceled: false };
  request.promise = (async () => {
    try {
      const res = await api(`/api/items/${encodeURIComponent(id)}/image`);
      if (!res.ok) throw new Error('图片加载失败');
      const blob = await res.blob();
      if (request.canceled || !img.isConnected) return;
      const objectUrl = URL.createObjectURL(blob);
      state.imageUrls.set(id, objectUrl);
      img.src = objectUrl;
    } catch {
      if (img.isConnected) showImageFailure(img);
    } finally {
      state.imageRequests.delete(id);
    }
  })();
  state.imageRequests.set(id, request);
  img.addEventListener('error', () => {
    showImageFailure(img);
  }, { once: true });
  await request.promise;
}

function showImageFailure(img) {
  const notice = document.createElement('div');
  notice.className = 'image-failed';
  notice.textContent = '图片未能加载，可点击刷新重试。';
  img.replaceWith(notice);
}

function releaseImageUrls() {
  for (const request of state.imageRequests.values()) request.canceled = true;
  state.imageRequests.clear();
  for (const objectUrl of state.imageUrls.values()) URL.revokeObjectURL(objectUrl);
  state.imageUrls.clear();
  releaseQrUrl();
}

function releaseQrUrl() {
  if (state.qrUrl) URL.revokeObjectURL(state.qrUrl);
  state.qrUrl = '';
}

async function copyImage(blob) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
    return true;
  } catch {
    throw new Error('clipboard image failed');
  }
}

async function pollLoop() {
  const generation = state.pollGeneration;
  while (generation === state.pollGeneration && state.token) {
    await new Promise((resolve) => {
      state.pollTimer = setTimeout(resolve, POLL_MS);
    });
    state.pollTimer = null;
    if (generation !== state.pollGeneration || !state.token) return;
    await refreshItems(false);
  }
}

function cancelPolling() {
  state.pollGeneration += 1;
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

function invalidateSession(message = '连接已失效，请重新输入访问码') {
  state.token = '';
  localStorage.removeItem(TOKEN_KEY);
  renderLock();
  queueMicrotask(() => {
    const error = document.querySelector('#lock-error');
    if (error) error.textContent = message;
  });
}

async function handleAuthError(error) {
  if (error.status === 401) invalidateSession(error.message);
}

function appendSuggestedText(text) {
  const textarea = document.querySelector('#text-input');
  if (!textarea) return;
  textarea.value = textarea.value ? `${textarea.value}\n${text}` : text;
}

function showSelectableText(text) {
  const dialog = document.createElement('div');
  dialog.className = 'modal-backdrop';
  const panel = document.createElement('div');
  panel.className = 'modal';
  const title = document.createElement('h2');
  title.textContent = '复制失败，请手动选择';
  const content = document.createElement('textarea');
  content.className = 'selectable-content';
  content.readOnly = true;
  content.value = text;
  const close = document.createElement('button');
  close.className = 'primary';
  close.textContent = '关闭';
  close.addEventListener('click', () => dialog.remove());
  panel.append(title, content, close);
  dialog.append(panel);
  document.body.append(dialog);
  content.focus();
  content.select();
}

async function bootApp() {
  const hashOk = await connectFromHash();
  if (hashOk) return;
  if (state.token) {
    try {
      const res = await api('/api/state');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        state.accessCode = '';
        state.maxItemBytes = data.config.maxItemBytes;
        state.maxTextChars = data.config.maxTextChars;
        await startApp(data.deviceId);
        return;
      }
    } catch {}
    state.token = '';
    localStorage.removeItem(TOKEN_KEY);
  }
  renderLock();
}

bootApp();
