import fs from 'node:fs/promises';
import path from 'node:path';
import { randomId } from './security.js';

export class Store {
  constructor(config, options = {}) {
    this.dataDir = config.dataDir;
    this.filesDir = path.join(config.dataDir, 'files');
    this.indexFile = path.join(config.dataDir, 'index.json');
    this.secretFile = path.join(config.dataDir, 'auth.json');
    this.maxTotalBytes = config.maxTotalBytes;
    this.maxItems = config.maxItems;
    this.retentionMs = config.retentionMs;
    this.fs = options.fs || fs;
    this.now = options.now || (() => Date.now());
    this.index = { version: 1, revision: 0, items: [] };
    this.mutation = Promise.resolve();
  }

  async init() {
    await this.fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await this.fs.mkdir(this.filesDir, { recursive: true, mode: 0o700 });
    await this.fs.chmod(this.dataDir, 0o700).catch(() => {});
    await this.fs.chmod(this.filesDir, 0o700).catch(() => {});
    await this.#readIndex();
    await this.cleanupOrphans();
    await this.cleanupExpired();
  }

  async #readIndex() {
    try {
      const raw = await this.fs.readFile(this.indexFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.items)) throw new Error('invalid index');
      this.index = {
        version: 1,
        revision: Number.isFinite(parsed.revision) ? parsed.revision : 0,
        items: parsed.items,
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.index = { version: 1, revision: 0, items: [] };
        await this.#writeIndexAtomic(this.index);
        return;
      }
      throw error;
    }
  }

  async #writeIndexAtomic(index) {
    const tmp = `${this.indexFile}.tmp-${randomId(6)}`;
    const body = `${JSON.stringify(index, null, 2)}\n`;
    try {
      await this.fs.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
      await this.fs.rename(tmp, this.indexFile);
    } catch (error) {
      await this.fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
    await this.fs.chmod(this.indexFile, 0o600).catch(() => {});
  }

  #enqueue(fn) {
    const run = this.mutation.then(() => fn());
    this.mutation = run.catch(() => {});
    return run;
  }

  #pruneExpiredSync(index) {
    const nowMs = this.now();
    const kept = [];
    const removed = [];
    for (const item of index.items) {
      if (item.expiresAt <= nowMs) removed.push(item);
      else kept.push(item);
    }
    if (removed.length === 0) {
      return { index: { ...index, items: [...index.items] }, removed: [], changed: false };
    }
    return { index: { ...index, revision: index.revision + 1, items: kept }, removed, changed: true };
  }

  async #commit(index) {
    await this.#writeIndexAtomic(index);
    this.index = index;
  }

  async #removeImageFiles(items) {
    const failures = [];
    for (const item of items) {
      if (item.kind !== 'image') continue;
      try {
        await this.fs.rm(path.join(this.filesDir, item.storedName), { force: true });
      } catch (error) {
        failures.push({ storedName: item.storedName, error });
      }
    }
    return failures;
  }

  #enforceCapacity(index, size) {
    const total = index.items.reduce((sum, item) => sum + (item.size || 0), 0) + size;
    if (index.items.length >= this.maxItems) {
      const error = new Error('项目数量已达上限');
      error.code = 'LIMIT_ITEMS';
      throw error;
    }
    if (total > this.maxTotalBytes) {
      const error = new Error('存储空间已达上限');
      error.code = 'LIMIT_SPACE';
      throw error;
    }
  }

  async getSnapshot() {
    await this.cleanupExpired();
    return {
      revision: this.index.revision,
      items: this.index.items.map((item) => ({ ...item })),
      deviceId: await this.getDeviceId(),
    };
  }

  async addText(text) {
    return this.#enqueue(async () => {
      const pruned = this.#pruneExpiredSync(this.index);
      const size = Buffer.byteLength(text, 'utf8');
      const nowMs = this.now();
      const item = {
        id: randomId(),
        kind: 'text',
        text,
        size,
        createdAt: nowMs,
        expiresAt: nowMs + this.retentionMs,
      };
      this.#enforceCapacity(pruned.index, size);
      const next = { version: 1, revision: pruned.index.revision + 1, items: [...pruned.index.items, item] };
      await this.#commit(next);
      await this.#removeImageFiles(pruned.removed);
      return { ...item };
    });
  }

  async addImage({ buffer, originalName, mimeType, detectedType, bytesRead }) {
    return this.#enqueue(async () => {
      const pruned = this.#pruneExpiredSync(this.index);
      const id = randomId();
      const safeName = originalName || `image-${id}`;
      const ext = extensionForMime(detectedType || mimeType);
      const storedName = `${id}${ext}`;
      const storedPath = path.join(this.filesDir, storedName);
      this.#enforceCapacity(pruned.index, buffer.length);

      await this.fs.writeFile(storedPath, buffer, { mode: 0o600 });
      const nowMs = this.now();
      const item = {
        id,
        kind: 'image',
        originalName: safeName,
        storedName,
        mimeType: detectedType || mimeType,
        size: buffer.length,
        bytesRead,
        createdAt: nowMs,
        expiresAt: nowMs + this.retentionMs,
      };
      const next = { version: 1, revision: pruned.index.revision + 1, items: [...pruned.index.items, item] };
      try {
        await this.#commit(next);
      } catch (error) {
        await this.fs.rm(storedPath, { force: true }).catch(() => {});
        throw error;
      }
      await this.#removeImageFiles(pruned.removed);
      return { ...item };
    });
  }

  async deleteItem(id) {
    return this.#enqueue(async () => {
      const pruned = this.#pruneExpiredSync(this.index);
      const items = [...pruned.index.items];
      const indexPos = items.findIndex((item) => item.id === id);
      if (indexPos === -1) return false;
      const [item] = items.splice(indexPos, 1);
      const next = { version: 1, revision: pruned.index.revision + 1, items };
      await this.#commit(next);
      await this.#removeImageFiles([...pruned.removed, item]);
      return true;
    });
  }

  async cleanupExpired() {
    return this.#enqueue(async () => {
      const pruned = this.#pruneExpiredSync(this.index);
      if (!pruned.changed) return false;
      await this.#commit(pruned.index);
      await this.#removeImageFiles(pruned.removed);
      return true;
    });
  }

  async cleanupOrphans() {
    return this.#enqueue(async () => {
      const entries = await this.fs.readdir(this.filesDir).catch(() => []);
      const known = new Set(this.index.items.filter((item) => item.kind === 'image').map((item) => item.storedName));
      const orphans = entries.filter((name) => !known.has(name)).map((storedName) => ({ kind: 'image', storedName }));
      return (await this.#removeImageFiles(orphans)).length === 0;
    });
  }

  async getItem(id) {
    await this.cleanupExpired();
    return this.index.items.find((item) => item.id === id) || null;
  }

  async readImage(item) {
    if (item.kind !== 'image') return null;
    return this.fs.readFile(path.join(this.filesDir, item.storedName));
  }

  async imagePath(item) {
    if (item.kind !== 'image') return null;
    return path.join(this.filesDir, item.storedName);
  }

  async getAuth() {
    try {
      const raw = await this.fs.readFile(this.secretFile, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return null;
    }
  }

  async saveAuth(auth) {
    const tmp = `${this.secretFile}.tmp-${randomId(6)}`;
    const body = `${JSON.stringify(auth, null, 2)}\n`;
    try {
      await this.fs.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
      await this.fs.rename(tmp, this.secretFile);
    } catch (error) {
      await this.fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
    await this.fs.chmod(this.secretFile, 0o600).catch(() => {});
  }

  async getDeviceId() {
    const auth = await this.getAuth();
    return auth?.deviceId || 'lan-drop';
  }
}

function extensionForMime(mime) {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/avif') return '.avif';
  if (mime === 'image/heic' || mime === 'image/heif') return '.heic';
  return '.bin';
}

export function buildPublicImage(item) {
  return {
    id: item.id,
    kind: 'image',
    originalName: item.originalName,
    mimeType: item.mimeType,
    size: item.size,
    bytesRead: item.bytesRead,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}

export function buildPublicText(item) {
  return {
    id: item.id,
    kind: 'text',
    text: item.text,
    size: item.size,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}

export function isProbablyImage(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp' && ['avif', 'avis'].includes(bytes.subarray(8, 12).toString('ascii'))) return 'image/avif';
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(bytes.subarray(8, 12).toString('ascii'))) return 'image/heic';
  return null;
}
