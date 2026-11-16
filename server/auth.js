import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { createToken, timingSafeEqualString } from './security.js';

const scryptAsync = promisify(crypto.scrypt);
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
const SECRET_MIN_LENGTH = 8;
const SECRET_MAX_LENGTH = 64;

export function isValidNewSecret(secret) {
  if (typeof secret !== 'string') return false;
  const length = Array.from(secret).length;
  return length >= SECRET_MIN_LENGTH && length <= SECRET_MAX_LENGTH && !/^\s*$/u.test(secret);
}

function isCustom(auth) {
  return Boolean(auth?.passwordHash && auth?.passwordSalt);
}

export function hasStoredCredential(auth) {
  return Boolean(
    auth
    && typeof auth.token === 'string'
    && auth.token
    && typeof auth.deviceId === 'string'
    && auth.deviceId
    && (auth.accessCode || isCustom(auth)),
  );
}

async function deriveHash(secret, salt) {
  return scryptAsync(secret, salt, 64, SCRYPT_OPTIONS);
}

export class AuthManager {
  #auth;
  #store;
  #tokenBytes;

  constructor({ store, auth, tokenBytes = 32 }) {
    if (!hasStoredCredential(auth)) throw new TypeError('认证数据无效');
    this.#store = store;
    this.#auth = { ...auth };
    this.#tokenBytes = tokenBytes;
  }

  getToken() {
    return this.#auth.token;
  }

  getDeviceId() {
    return this.#auth.deviceId;
  }

  isCustom() {
    return isCustom(this.#auth);
  }

  current() {
    const result = {
      token: this.#auth.token,
      deviceId: this.#auth.deviceId,
      custom: isCustom(this.#auth),
    };
    if (this.#auth.accessCode) result.accessCode = this.#auth.accessCode;
    return result;
  }

  async verifySecret(secret) {
    const credential = { ...this.#auth };
    if (credential.accessCode) {
      const supplied = String(secret || '').trim().toUpperCase();
      return timingSafeEqualString(supplied, String(credential.accessCode).toUpperCase());
    }
    if (!isCustom(credential) || typeof secret !== 'string') return false;
    try {
      const suppliedHash = await deriveHash(secret, Buffer.from(credential.passwordSalt, 'base64'));
      const storedHash = Buffer.from(credential.passwordHash, 'base64');
      return suppliedHash.length === storedHash.length && crypto.timingSafeEqual(suppliedHash, storedHash);
    } catch {
      return false;
    }
  }

  async rotate(newSecret) {
    if (!isValidNewSecret(newSecret)) throw new TypeError('新密码格式无效');
    const salt = crypto.randomBytes(32);
    const passwordHash = await deriveHash(newSecret, salt);
    const next = {
      version: 2,
      passwordHash: passwordHash.toString('base64'),
      passwordSalt: salt.toString('base64'),
      token: createToken(Math.max(32, this.#tokenBytes)),
      deviceId: this.#auth.deviceId,
    };
    await this.#store.saveAuth(next);
    this.#auth = next;
    return this.current();
  }
}
