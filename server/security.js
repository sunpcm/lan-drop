import crypto from 'node:crypto';

export function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function normalizeHost(hostHeader) {
  if (!hostHeader) return '';
  const raw = String(hostHeader).trim().toLowerCase();
  const noPort = raw.replace(/:\d+$/, '');
  if (noPort.startsWith('[') && noPort.endsWith(']')) return noPort.slice(1, -1);
  return noPort;
}

export function isAllowedHost(hostHeader, allowedHosts) {
  const host = normalizeHost(hostHeader);
  if (!host) return false;
  return allowedHosts.some((allowed) => normalizeHost(allowed) === host);
}

function hostAndPort(host) {
  const lower = String(host || '').trim().toLowerCase();
  if (!lower) return { host: '', port: '' };
  if (lower.startsWith('[')) {
    const end = lower.indexOf(']');
    if (end === -1) return { host: lower, port: '' };
    const hostname = lower.slice(1, end);
    const rest = lower.slice(end + 1);
    return { host: hostname, port: rest.startsWith(':') ? rest.slice(1) : '' };
  }
  const idx = lower.lastIndexOf(':');
  if (idx === -1) return { host: lower, port: '' };
  const hostname = lower.slice(0, idx);
  const port = lower.slice(idx + 1);
  if (hostname.includes(':')) return { host: lower, port: '' };
  return { host: hostname, port };
}

function effectivePort(port, protocol) {
  if (port) return port;
  return protocol === 'https' ? '443' : '80';
}

export function isTrustedOrigin(originHeader, hostHeader, protocol = 'http') {
  if (!originHeader) return true;
  if (String(originHeader).trim().toLowerCase() === 'null') return false;
  let origin;
  try {
    origin = new URL(String(originHeader));
  } catch {
    return false;
  }
  if (origin.protocol !== `${protocol}:` || origin.username || origin.password) return false;
  const originHost = hostAndPort(origin.host);
  const requestHost = hostAndPort(hostHeader);
  if (originHost.host !== requestHost.host) return false;
  return effectivePort(originHost.port, protocol) === effectivePort(requestHost.port, protocol);
}

export function isPrivateIpv4(host) {
  const octets = String(host || '').split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 169 && octets[1] === 254);
}

export function createAccessCode(length = 6) {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

export function createToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function safeFilename(name, fallback = 'download') {
  const cleaned = String(name || '')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, 180);
}

export function normalizePathname(url) {
  const path = String(url || '/').split('?')[0];
  if (path.length > 2048) return '/';
  return path;
}
