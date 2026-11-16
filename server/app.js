import fs from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import { Store, buildPublicImage, buildPublicText, isProbablyImage } from './store.js';
import {
  createAccessCode,
  createToken,
  isAllowedHost,
  isPrivateIpv4,
  isTrustedOrigin,
  normalizeHost,
  normalizePathname,
  randomId,
  safeFilename,
  timingSafeEqualString,
} from './security.js';

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

const JSON_LIMIT = 16 * 1024;

function extensionForMime(mime) {
  return ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif', 'image/heic': '.heic' })[mime] || '.bin';
}

class ClientError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function sendJson(res, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendError(res, error) {
  if (['LIMIT_SPACE', 'LIMIT_ITEMS'].includes(error.code)) {
    error = new ClientError(429, error.message);
  }
  const status = error instanceof ClientError ? error.status : 500;
  const message = error instanceof ClientError ? error.message : '服务暂时不可用';
  sendJson(res, status, { ok: false, error: message }, error.headers);
}

function securityHeaders(res, noStore = false) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (noStore) res.setHeader('cache-control', 'no-store');
}

function requestProtocol(req) {
  return req.socket.encrypted ? 'https' : 'http';
}

function bareHost(hostHeader) {
  return String(hostHeader || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
}

function bearerToken(req) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(req.headers.authorization || ''));
  return match?.[1] || '';
}

function safeDecodedName(header) {
  try {
    return safeFilename(decodeURIComponent(String(header || '')));
  } catch {
    return safeFilename('图片');
  }
}

async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    throw new ClientError(413, `内容超过 ${Math.ceil(limit / 1024 / 1024)} MiB 限制`);
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        throw new ClientError(413, `内容超过 ${Math.ceil(limit / 1024 / 1024)} MiB 限制`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ClientError) throw error;
    throw new ClientError(400, '读取请求内容失败');
  }
  return Buffer.concat(chunks, size);
}

function publicItem(item) {
  return item.kind === 'image' ? buildPublicImage(item) : buildPublicText(item);
}

function mount(mainApp) {
  const { config, store, auth, state } = mainApp;

  function authenticate(req) {
    if (!timingSafeEqualString(bearerToken(req), auth.token)) {
      throw new ClientError(401, '连接已失效，请重新输入访问码');
    }
  }

  function enforceWrite(req) {
    const origin = req.headers.origin;
    if (!isTrustedOrigin(origin, req.headers.host, requestProtocol(req))) {
      throw new ClientError(403, '拒绝跨站请求');
    }
  }

  function deny() {
    throw new ClientError(405, '不支持此请求方法', { allow: 'GET, POST' });
  }

  function stateResponse(req) {
    const hosts = allowedQrHosts(mainApp, normalizeHost(req.headers.host));
    return {
      ok: true,
      allowedHosts: hosts,
      config: {
        deviceId: auth.deviceId,
        maxItemBytes: config.maxItemBytes,
        maxTextChars: config.maxTextChars,
        maxTotalBytes: config.maxTotalBytes,
        retentionMs: config.retentionMs,
      },
    };
  }

  async function route(req, res, pathname, url) {
    if (pathname === '/api/connect') {
      if (req.method !== 'POST') deny();
      enforceWrite(req);
      const limiter = state.limiter;
      const limiterKey = req.socket.remoteAddress || 'unknown';
      if (limiter.exhausted(limiterKey)) {
        throw new ClientError(429, '尝试次数过多，请稍后再试', { 'retry-after': String(limiter.retryAfter(limiterKey)) });
      }
      const raw = await readBody(req, JSON_LIMIT);
      let data;
      try { data = JSON.parse(raw.toString('utf8')); } catch { throw new ClientError(400, '请求格式错误'); }
      const code = String(data?.code || '').trim().toUpperCase();
      if (!timingSafeEqualString(code, auth.accessCode)) {
        limiter.failed(limiterKey);
        throw new ClientError(401, '访问码不正确');
      }
      limiter.succeed(limiterKey);
      sendJson(res, 200, {
        ok: true,
        token: auth.token,
        accessCode: auth.accessCode,
        deviceId: auth.deviceId,
      });
      return;
    }

    authenticate(req);
    if (pathname === '/api/state') {
      if (req.method !== 'GET') deny();
      sendJson(res, 200, stateResponse(req));
      return;
    }
    if (pathname === '/api/items') {
      if (req.method === 'GET') {
        const snapshot = await store.getSnapshot();
        const supplied = Number(url.searchParams.get('revision'));
        if (Number.isSafeInteger(supplied) && supplied === snapshot.revision) {
          sendJson(res, 200, { ok: true, unchanged: true, revision: snapshot.revision });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          unchanged: false,
          revision: snapshot.revision,
          items: snapshot.items.map(publicItem),
        });
        return;
      }
      if (req.method === 'POST') {
        enforceWrite(req);
        const length = Number(req.headers['content-length'] || 0);
        if (length > config.maxItemBytes) {
          throw new ClientError(413, `图片超过 ${Math.round(config.maxItemBytes / 1024 / 1024)} MiB 限制`);
        }
        const body = await readBody(req, config.maxItemBytes);
        const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (contentType === 'text/plain') {
          let text;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { throw new ClientError(400, '文字编码无效'); }
          if (!text.trim()) throw new ClientError(400, '请输入文字');
          if ([...text].length > config.maxTextChars) throw new ClientError(413, `文字超过 ${config.maxTextChars} 字符上限`);
          const item = await store.addText(text);
          sendJson(res, 201, { ok: true, revision: store.index.revision, item: publicItem(item) });
          return;
        }
        const detectedType = isProbablyImage(body);
        if (!detectedType || !contentType.startsWith('image/')) throw new ClientError(415, '仅支持安全的 PNG、JPEG、GIF、WebP、AVIF 或 HEIC 图片');
        const sourceName = safeDecodedName(req.headers['x-file-name']);
        const item = await store.addImage({
          buffer: body,
          originalName: /\.(png|jpe?g|gif|webp|avif|heic|heif)$/i.test(sourceName)
            ? sourceName
            : `${sourceName.replace(/\.[^.]+$/, '')}${extensionForMime(detectedType)}`,
          mimeType: contentType,
          detectedType,
          bytesRead: body.length,
        });
        sendJson(res, 201, { ok: true, revision: store.index.revision, item: publicItem(item) });
        return;
      }
      deny();
    }

    const itemMatch = /^\/api\/items\/([A-Za-z0-9_-]+)(?:\/(copy|image|download))?$/.exec(pathname);
    if (itemMatch) {
      if (req.method !== 'GET') deny();
      const item = await store.getItem(itemMatch[1]);
      if (!item) throw new ClientError(404, '内容不存在或已过期');
      const action = itemMatch[2] || '';
      if (!action) {
        sendJson(res, 200, { ok: true, item: publicItem(item) });
        return;
      }
      if (action === 'copy') {
        if (item.kind !== 'text') throw new ClientError(404, '此内容没有文字');
        sendJson(res, 200, { ok: true, text: item.text });
        return;
      }
      if (item.kind !== 'image') throw new ClientError(404, '此内容不是图片');
      let data;
      try { data = await store.readImage(item); } catch (error) {
        if (error.code === 'ENOENT') throw new ClientError(404, '图片文件不存在');
        throw error;
      }
      const headers = {
        'content-type': item.mimeType,
        'content-length': data.length,
        'content-disposition': action === 'download' ? `attachment; filename*=UTF-8''${encodeURIComponent(item.originalName)}` : 'inline',
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      };
      res.writeHead(200, headers);
      res.end(data);
      return;
    }

    const deleteMatch = /^\/api\/delete\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (deleteMatch) {
      if (req.method !== 'POST') deny();
      enforceWrite(req);
      const removed = await store.deleteItem(deleteMatch[1]);
      if (!removed) throw new ClientError(404, '内容不存在或已过期');
      sendJson(res, 200, { ok: true, revision: store.index.revision });
      return;
    }

    if (pathname === '/api/qr') {
      if (req.method !== 'GET') deny();
      const requestedHost = String(url.searchParams.get('host') || '').trim();
      if (!isAllowedQrHost(mainApp, requestedHost)) throw new ClientError(400, '二维码地址不可用');
      const port = portFromHost(req.headers.host);
      const urlText = `http://${formatUrlHost(requestedHost)}:${port}/#token=${encodeURIComponent(auth.token)}`;
      try {
        const image = await QRCode.toBuffer(urlText, { type: 'png', width: 480, margin: 2, errorCorrectionLevel: 'M' });
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': image.length, 'cache-control': 'no-store' });
        res.end(image);
      } catch {
        throw new ClientError(500, '二维码生成失败');
      }
      return;
    }
    throw new ClientError(404, '接口不存在');
  }

  return async function handler(req, res) {
    securityHeaders(res, true);
    let pathname;
    let url;
    try {
      url = new URL(req.url || '/', 'http://local');
      pathname = normalizePathname(url.pathname);
    } catch {
      sendJson(res, 400, { ok: false, error: '请求地址无效' });
      return;
    }
    if (!isAllowedHost(req.headers.host, config.allowedHosts)) {
      sendJson(res, 403, { ok: false, error: 'Host 不允许' });
      return;
    }
    const origin = req.headers.origin;
    if (origin && !isTrustedOrigin(origin, req.headers.host, requestProtocol(req))) {
      sendJson(res, 403, { ok: false, error: '拒绝跨站请求' });
      return;
    }
    try {
      if (pathname.startsWith('/api/')) {
        await route(req, res, pathname, url);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') deny();
      const staticFile = STATIC_FILES.get(pathname);
      if (!staticFile) throw new ClientError(404, '页面不存在');
      const filePath = path.join(mainApp.publicDir, staticFile[0]);
      const data = await fs.readFile(filePath);
      res.writeHead(200, { 'content-type': staticFile[1], 'content-length': data.length, 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (!res.headersSent) sendError(res, error);
      else res.destroy();
      if (!(error instanceof ClientError) && error.statusCode !== 413) console.error(error);
    }
  };
}

function allowedQrHosts(mainApp, requestHost) {
  const privateHosts = mainApp.config.allowedHosts.filter((host) => isPrivateIpv4(host) || (!/^\d+\.\d+\.\d+\.\d+$/.test(host) && host !== 'localhost' && host !== '::1'));
  if (isPrivateIpv4(requestHost) && !privateHosts.includes(requestHost)) privateHosts.unshift(requestHost);
  return privateHosts;
}

function isAllowedQrHost(mainApp, host) {
  if (!host || !isAllowedHost(host, mainApp.config.allowedHosts)) return false;
  return isPrivateIpv4(normalizeHost(host)) || (!/^\d+\.\d+\.\d+\.\d+$/.test(normalizeHost(host)) && normalizeHost(host) !== 'localhost' && normalizeHost(host) !== '::1');
}

function portFromHost(hostHeader) {
  const raw = String(hostHeader || '');
  const match = raw.startsWith('[') ? /^\[[^\]]+\]:(\d+)$/.exec(raw) : /^[^:]+:(\d+)$/.exec(raw);
  return match?.[1] || '80';
}

function formatUrlHost(host) {
  return host.includes(':') ? `[${host}]` : host;
}

class AccessLimiter {
  constructor({ points, windowMs, maxIpEntries }, now = () => Date.now()) {
    this.points = points;
    this.windowMs = windowMs;
    this.maxIpEntries = maxIpEntries;
    this.buckets = new Map();
    this.total = { start: now(), count: 0 };
    this.totalPoints = points * 10;
    this.now = now;
  }

  static fromConfig(config, now = () => Date.now()) {
    return new AccessLimiter({
      points: config.rateLimitPoints,
      windowMs: config.rateLimitWindowMs,
      maxIpEntries: config.rateLimitMaxIpEntries,
    }, now);
  }

  #refreshTotal() {
    const time = this.now();
    if (time - this.total.start >= this.windowMs) this.total = { start: time, count: 0 };
    return time;
  }

  allow(address) {
    const time = this.#refreshTotal();
    const key = String(address || 'unknown');
    let bucket = this.buckets.get(key);
    if (bucket && time - bucket.start >= this.windowMs) bucket = null;
    if (this.total.count >= this.totalPoints) return false;
    if (bucket?.count >= this.points) return false;
    if (!bucket) {
      this.#evictExpired(time);
      if (this.buckets.size >= this.maxIpEntries) this.#evictExpired(time);
      if (this.buckets.size >= this.maxIpEntries) {
        throw new ClientError(429, '连接请求过多，请稍后再试', { 'retry-after': String(this.windowMs / 1000) });
      }
      bucket = { start: time, count: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    this.total.count += 1;
    return true;
  }

  #evictExpired(time) {
    for (const [key, bucket] of this.buckets) {
      if (time - bucket.start >= this.windowMs) this.buckets.delete(key);
    }
  }

  succeed(address) {
    this.buckets.delete(String(address || 'unknown'));
  }

  retryAfter(address) {
    const bucket = this.buckets.get(String(address || 'unknown'));
    const start = bucket?.start ?? this.total.start;
    return Math.max(1, Math.ceil((start + this.windowMs - this.now()) / 1000));
  }

  failed(address) {
    const key = String(address || 'unknown');
    const time = this.#refreshTotal();
    if (this.total.count >= this.totalPoints) return true;
    let bucket = this.buckets.get(key);
    if (bucket && time - bucket.start >= this.windowMs) {
      this.buckets.delete(key);
      bucket = null;
    }
    if (!bucket) {
      this.#evictExpired(time);
      if (this.buckets.size >= this.maxIpEntries) {
        const oldest = this.buckets.keys().next().value;
        this.buckets.delete(oldest);
      }
      bucket = { start: time, count: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    this.total.count += 1;
    return bucket.count <= this.points;
  }

  exhausted(address) {
    const key = String(address || 'unknown');
    const time = this.#refreshTotal();
    if (this.total.count >= this.totalPoints) return true;
    let bucket = this.buckets.get(key);
    if (bucket && time - bucket.start >= this.windowMs) {
      this.buckets.delete(key);
      bucket = null;
    }
    return Boolean(bucket && bucket.count >= this.points);
  }
}

export async function createApp({ config, baseDir = process.cwd(), store: suppliedStore } = {}) {
  if (!config) throw new TypeError('createApp requires config');
  const store = suppliedStore || new Store(config);
  await store.init();
  let auth = await store.getAuth();
  if (!auth?.accessCode || !auth?.token) {
    auth = {
      accessCode: createAccessCode(config.accessCodeLength),
      token: createToken(config.tokenBytes),
      deviceId: `设备-${randomId(2)}`,
    };
    await store.saveAuth(auth);
  }
  const state = {
    limiter: AccessLimiter.fromConfig(config),
    interval: null,
  };
  const mainApp = {
    config,
    store,
    auth,
    state,
    publicDir: path.join(baseDir, 'public'),
  };
  mainApp.handler = mount(mainApp);
  state.interval = setInterval(() => {
    store.cleanupExpired().catch((error) => console.error('过期清理失败', error));
  }, config.cleanupMs);
  state.interval.unref();
  mainApp.close = async () => {
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = null;
    }
    await store.mutation;
  };
  return mainApp;
}

export { AccessLimiter };
