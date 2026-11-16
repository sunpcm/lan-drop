import os from 'node:os';
import path from 'node:path';

const MIB = 1024 * 1024;
const MINUTE = 60 * 1000;

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function csvEnv(name, env = process.env) {
  const raw = env[name];
  if (!raw) return [];
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

export function resolveConfig(env = process.env, baseDir = process.cwd()) {
  const host = env.HOST || '0.0.0.0';
  const portRaw = env.PORT;
  const port = portRaw === '0' ? 0 : intEnv('PORT', 8787, { min: 1, max: 65535 }, env);
  const dataDir = path.resolve(baseDir, env.DATA_DIR || '.data');
  const maxItemBytes = intEnv('MAX_ITEM_BYTES', 20 * MIB, { min: 1 }, env);
  const maxTextChars = intEnv('MAX_TEXT_CHARS', 20_000, { min: 1 }, env);
  const maxTotalBytes = intEnv('MAX_TOTAL_BYTES', 512 * MIB, { min: 1 }, env);
  const maxItems = intEnv('MAX_ITEMS', 1000, { min: 1 }, env);
  const retentionMs = intEnv('RETENTION_MS', 24 * 60 * MINUTE, { min: MINUTE }, env);
  const cleanupMs = intEnv('CLEANUP_MS', 15 * MINUTE, { min: MINUTE }, env);
  const tokenBytes = intEnv('TOKEN_BYTES', 32, { min: 16, max: 128 }, env);
  const accessCodeLength = intEnv('ACCESS_CODE_LENGTH', 6, { min: 4, max: 12 }, env);
  const rateLimitPoints = intEnv('RATE_LIMIT_POINTS', 20, { min: 1 }, env);
  const rateLimitWindowMs = intEnv('RATE_LIMIT_WINDOW_MS', 60 * MINUTE, { min: 1000 }, env);
  const rateLimitMaxIpEntries = intEnv('RATE_LIMIT_MAX_IP_ENTRIES', 500, { min: 10 }, env);

  return {
    host,
    port,
    dataDir,
    maxItemBytes,
    maxTextChars,
    maxTotalBytes,
    maxItems,
    retentionMs,
    cleanupMs,
    tokenBytes,
    accessCodeLength,
    rateLimitPoints,
    rateLimitWindowMs,
    rateLimitMaxIpEntries,
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      '::1',
      ...localIPv4Addresses(),
      ...csvEnv('EXTRA_ALLOWED_HOSTS', env),
    ],
  };
}

export function localIPv4Addresses() {
  const results = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const info of interfaces || []) {
      if (info.family === 'IPv4' && !info.internal) results.push(info.address);
    }
  }
  return [...new Set(results)];
}
