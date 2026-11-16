import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApp, AccessLimiter } from '../server/app.js';
import { resolveConfig } from '../server/config.js';
import { Store } from '../server/store.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>hi</text></svg>');

async function startTestApp(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lan-drop-test-'));
  const config = resolveConfig({
    HOST: '127.0.0.1',
    PORT: '0',
    DATA_DIR: dir,
    RETENTION_MS: options.retentionMs || '600000',
    CLEANUP_MS: '60000',
    RATE_LIMIT_POINTS: options.rateLimitPoints || '1000',
    RATE_LIMIT_WINDOW_MS: '60000',
    RATE_LIMIT_MAX_IP_ENTRIES: '20',
    MAX_ITEM_BYTES: options.maxItemBytes || '20971520',
    MAX_TEXT_CHARS: '20000',
    MAX_TOTAL_BYTES: options.maxTotalBytes || '536870912',
    MAX_ITEMS: options.maxItems || '1000',
    ...(options.env || {}),
  }, process.cwd());
  const app = await createApp({ config, baseDir: process.cwd() });
  const returnedAuth = app.auth;
  const server = http.createServer(app.handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const fixture = {
    app,
    auth: returnedAuth,
    server,
    base,
    dir,
    port,
    config,
    keepData: options.keepData === true,
    async close() {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await app.close();
      if (!this.keepData) await fs.rm(dir, { recursive: true, force: true });
    },
  };
  return fixture;
}

async function request(base, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  const body = options.body;
  if (body && !headers['content-length'] && !(body instanceof Uint8Array || Buffer.isBuffer(body))) {
    headers['content-length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const target = new URL(base);
    const req = http.request({ host: target.hostname, port: target.port, path: pathname, method: options.method || 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}


function json(res) {
  try { return JSON.parse(res.body.toString('utf8')); } catch { return null; }
}

async function connect(app) {
  const auth = app.auth;
  const res = await request(app.base, '/api/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: app.base },
    body: JSON.stringify({ code: auth.accessCode }),
  });
  assert.equal(res.status, 200);
  return json(res);
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

test('文字上传、列表、复制接口与重启持久化', async () => {
  const fixture = await startTestApp();
  try {
    const connected = await connect(fixture);
    const token = connected.token;
    const text = '你好 <script>alert(1)</script>\n第二行';
    const createRes = await request(fixture.base, '/api/items', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'text/plain; charset=utf-8' },
      body: text,
    });
    assert.equal(createRes.status, 201);
    const created = json(createRes);
    assert.equal(created.item.text, text);
    assert.equal(created.item.kind, 'text');

    const listRes = await request(fixture.base, `/api/items?revision=${created.revision - 1}`, { headers: bearer(token) });
    assert.equal(listRes.status, 200);
    const list = json(listRes);
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].text, text);

    const copyRes = await request(fixture.base, `/api/items/${created.item.id}/copy`, { headers: bearer(token) });
    assert.equal(copyRes.status, 200);
    assert.equal(json(copyRes).text, text);

    const port = fixture.port;
    const savedDataDir = fixture.dir;
    await new Promise((resolve) => fixture.server.close(resolve));
    fixture.keepData = true;
    const restarted = await startTestApp({ env: { DATA_DIR: savedDataDir } });
    try {
      const auth = restarted.app.auth;
      const token2 = (await request(restarted.base, '/api/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: auth.accessCode }),
      })).body.toString('utf8');
      const list2 = await request(restarted.base, '/api/items', { headers: bearer(JSON.parse(token2).token) });
      assert.equal(json(list2).items.length, 1);
      assert.equal(json(list2).items[0].text, text);
    } finally {
      await restarted.close();
    }
  } finally {
    await fixture.close();
  }
});

test('图片上传、下载和图片字节一致', async () => {
  const fixture = await startTestApp();
  try {
    const { token } = await connect(fixture);
    const createRes = await request(fixture.base, '/api/items', {
      method: 'POST',
      headers: {
        ...bearer(token),
        'content-type': 'image/png',
        'x-file-name': encodeURIComponent('测试 图片.png'),
      },
      body: PNG,
    });
    assert.equal(createRes.status, 201);
    const item = json(createRes).item;
    assert.equal(item.kind, 'image');
    assert.match(item.originalName, /测试 图片\.png/);

    const imageRes = await request(fixture.base, `/api/items/${item.id}/image`, { headers: bearer(token) });
    assert.equal(imageRes.status, 200);
    assert.deepEqual(imageRes.body, PNG);

    const downloadRes = await request(fixture.base, `/api/items/${item.id}/download`, { headers: bearer(token) });
    assert.equal(downloadRes.status, 200);
    assert.deepEqual(downloadRes.body, PNG);
    assert.match(downloadRes.headers['content-disposition'], /filename\*=UTF-8''/);

    const unauthorized = await request(fixture.base, `/api/items/${item.id}/image`, {});
    assert.equal(unauthorized.status, 401);
  } finally {
    await fixture.close();
  }
});

test('删除单条会释放文件并减少列表', async () => {
  const fixture = await startTestApp();
  try {
    const { token } = await connect(fixture);
    const res = await request(fixture.base, '/api/items', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'text/plain' },
      body: '删除我',
    });
    const item = json(res).item;
    const del = await request(fixture.base, `/api/delete/${item.id}`, { method: 'POST', headers: bearer(token) });
    assert.equal(del.status, 200);
    const list = await request(fixture.base, '/api/items', { headers: bearer(token) });
    assert.equal(json(list).items.length, 0);
  } finally {
    await fixture.close();
  }
});

test('并发写入不丢项目', async () => {
  const fixture = await startTestApp();
  try {
    const { token } = await connect(fixture);
    await Promise.all(Array.from({ length: 20 }, (_, index) => request(fixture.base, '/api/items', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'text/plain' },
      body: `并发-${index}`,
    })));
    const list = await request(fixture.base, '/api/items', { headers: bearer(token) });
    assert.equal(json(list).items.length, 20);
  } finally {
    await fixture.close();
  }
});

test('拒绝 SVG 和伪造图片', async () => {
  const fixture = await startTestApp();
  try {
    const { token } = await connect(fixture);
    const svg = await request(fixture.base, '/api/items', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'image/svg+xml' },
      body: SVG,
    });
    assert.equal(svg.status, 415);
    const html = await request(fixture.base, '/api/items', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'text/html' },
      body: Buffer.from('<b>hi</b>'),
    });
    assert.equal(html.status, 415);
  } finally {
    await fixture.close();
  }
});

test('请求体上限和无效内容', async () => {
  const fixture = await startTestApp({ maxTotalBytes: '120', maxItemBytes: '100', maxItems: '3' });
  try {
    const { token } = await connect(fixture);
    const oversize = await request(fixture.base, '/api/items', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'image/png' },
      body: Buffer.concat([PNG, Buffer.alloc(300)]),
    });
    assert.equal(oversize.status, 413);
    const empty = await request(fixture.base, '/api/items', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'text/plain' },
      body: '   ',
    });
    assert.equal(empty.status, 400);
    for (let index = 0; index < 3; index += 1) {
      const res = await request(fixture.base, '/api/items', {
        method: 'POST',
        headers: { ...bearer(token), 'content-type': 'text/plain' },
        body: `内容${index}`,
      });
      assert.equal(res.status, 201);
    }
    const overItems = await request(fixture.base, '/api/items', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'text/plain' },
      body: '第四条',
    });
    assert.equal(overItems.status, 429);
  } finally {
    await fixture.close();
  }
});

test('过期清理会删除过期文字和图片文件', async () => {
  let clock = 1_800_000_000_000;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lan-drop-expiry-'));
  const config = resolveConfig({ HOST: '127.0.0.1', DATA_DIR: dir, RETENTION_MS: '60000', CLEANUP_MS: '60000' });
  const store = new Store({ ...config, retentionMs: 100 }, { now: () => clock });
  try {
    await store.init();
    const text = await store.addText('会过期');
    const image = await store.addImage({ buffer: PNG, originalName: '测试.png', mimeType: 'image/png', detectedType: 'image/png', bytesRead: PNG.length });
    const imagePath = path.join(store.filesDir, image.storedName);
    await fs.access(imagePath);
    clock += 100;
    assert.equal(await store.cleanupExpired(), true);
    assert.equal(store.index.items.length, 0);
    assert.equal((await store.getItem(text.id)), null);
    await assert.rejects(fs.access(imagePath));
    const replacement = await store.addText('过期项已清掉后可继续新增');
    assert.equal(replacement.text, '过期项已清掉后可继续新增');
    assert.equal(await store.deleteItem(replacement.id), true);
    clock += 101;
    const afterExpiry = await store.addText('已有过期项时也可以新增');
    assert.equal(store.index.items.length, 1);
    assert.equal(await store.deleteItem(afterExpiry.id), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('文字和图片共用总存储限额', async () => {
  const fixture = await startTestApp({ maxTotalBytes: '200' });
  try {
    const { token } = await connect(fixture);
    const text = await request(fixture.base, '/api/items', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'text/plain' },
      body: 'x'.repeat(170),
    });
    assert.equal(text.status, 201);
    const image = await request(fixture.base, '/api/items', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'image/png' },
      body: PNG,
    });
    assert.equal(image.status, 429);
    assert.match(json(image).error, /存储空间/);
  } finally {
    await fixture.close();
  }
});

test('Host 和 Origin 防护', async () => {
  const fixture = await startTestApp();
  try {
    const badHost = await request('http://127.0.0.1:' + fixture.port, '/api/state', { headers: { host: 'evil.example' } });
    assert.equal(badHost.status, 403);
    const badOrigin = await request(fixture.base, '/api/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ code: 'AAAAAA' }),
    });
    assert.equal(badOrigin.status, 403);
    const nullOrigin = await request(fixture.base, '/api/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null' },
      body: JSON.stringify({ code: fixture.app.auth.accessCode }),
    });
    assert.equal(nullOrigin.status, 403);
    const login = await request(fixture.base, '/api/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: fixture.base },
      body: JSON.stringify({ code: fixture.app.auth.accessCode }),
    });
    assert.equal(login.status, 200);
    const token = json(login).token;
    const upload = await request(fixture.base, '/api/items', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'text/plain', origin: fixture.base },
      body: '同源发送',
    });
    assert.equal(upload.status, 201);
    const crossOrigin = await request(fixture.base, '/api/items', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'text/plain', origin: 'https://evil.example' },
      body: '拒绝跨源',
    });
    assert.equal(crossOrigin.status, 403);
    const item = json(upload).item;
    const getDelete = await request(fixture.base, `/api/delete/${item.id}`, { headers: bearer(token) });
    assert.equal(getDelete.status, 405);
    const stillThere = await request(fixture.base, '/api/items', { headers: bearer(token) });
    assert.equal(json(stillThere).items.length, 1);
  } finally {
    await fixture.close();
  }
});

test('访问码失败和限流会提示稍后再试', async () => {
  const fixture = await startTestApp({ rateLimitPoints: '2' });
  try {
    const first = await request(fixture.base, '/api/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'WRONG' }),
    });
    assert.equal(first.status, 401);
    const second = await request(fixture.base, '/api/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'WRONG' }),
    });
    assert.equal(second.status, 401);
    const third = await request(fixture.base, '/api/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'WRONG' }),
    });
    assert.equal(third.status, 429);
    assert.ok(json(third).error.includes('稍后再试'));
    assert.ok(Number(third.headers['retry-after']) >= 1);
    const spoofed = await request(fixture.base, '/api/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.30' },
      body: JSON.stringify({ code: 'WRONG' }),
    });
    assert.equal(spoofed.status, 429);
  } finally {
    await fixture.close();
  }
});

test('限流器独立总量桶不受IP桶淘汰影响', () => {
  let clock = 1_000_000;
  const limiter = new AccessLimiter({ points: 1, windowMs: 60_000, maxIpEntries: 10 }, () => clock);
  assert.equal(limiter.failed('198.51.100.1'), true);
  clock += 1;
  assert.equal(limiter.failed('198.51.100.2'), true);
  for (let index = 3; index <= 10; index += 1) {
    clock += 1;
    assert.equal(limiter.failed(`198.51.100.${index}`), true);
  }
  clock += 1;
  assert.equal(limiter.exhausted('198.51.100.11'), true);
});

test('持久化失败不污染内存、不残留新文件，恢复后仍可提交', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lan-drop-failure-'));
  const config = resolveConfig({ DATA_DIR: dir, CLEANUP_MS: '60000' });
  const store = new Store(config);
  try {
    await store.init();
    const text = await store.addText('可保留文字');
    const image = await store.addImage({ buffer: PNG, originalName: '保留.png', mimeType: 'image/png', detectedType: 'image/png', bytesRead: PNG.length });
    const filesBefore = await fs.readdir(store.filesDir);
    const revisionBefore = store.index.revision;
    const backup = `${store.indexFile}.saved`;
    await fs.rename(store.indexFile, backup);
    await fs.mkdir(store.indexFile);
    try {
      await assert.rejects(store.addText('不能提交文字'));
      await assert.rejects(store.addImage({ buffer: PNG, originalName: '失败.png', mimeType: 'image/png', detectedType: 'image/png', bytesRead: PNG.length }));
      await assert.rejects(store.deleteItem(text.id));
      assert.equal(store.index.revision, revisionBefore);
      assert.deepEqual(store.index.items.map((item) => item.id), [text.id, image.id]);
      assert.deepEqual(await fs.readdir(store.filesDir), filesBefore);
      assert.equal((await fs.readdir(dir)).some((name) => name.startsWith('index.json.tmp-')), false);
    } finally {
      await fs.rmdir(store.indexFile);
      await fs.rename(backup, store.indexFile);
    }
    const added = await store.addText('故障后恢复');
    assert.ok(added.id);
    const restarted = new Store(config);
    await restarted.init();
    assert.deepEqual(restarted.index.items.map((item) => item.text ?? item.originalName), ['可保留文字', '保留.png', '故障后恢复']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('已鉴权轮询不消耗接入尝试限流', async () => {
  const fixture = await startTestApp({ rateLimitPoints: '2' });
  try {
    const { token } = await connect(fixture);
    for (let index = 0; index < 35; index += 1) {
      const response = await request(fixture.base, '/api/items?revision=' + fixture.app.store.index.revision, { headers: bearer(token) });
      assert.equal(response.status, 200);
    }
  } finally {
    await fixture.close();
  }
});

test('真实 npm 入口监听、回执随机端口并由 SIGTERM 清理', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lan-drop-entry-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve('.'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        const check = () => {
          if (/已启动[\s\S]*http:\/\/127\.0\.0\.1:\d+/.test(stdout)) return resolve();
          if (child.exitCode !== null) return reject(new Error(`入口退出 (${child.exitCode}): ${stderr}`));
          setTimeout(check, 20);
        };
        check();
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`入口启动超时: ${stderr}`)), 5000)),
    ]);
    const port = Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout)[1]);
    assert.ok(port > 0);
    child.kill('SIGTERM');
    const exitCode = await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('SIGTERM 未释放进程')), 5000)),
    ]);
    assert.equal(exitCode, 0);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
