const crypto = require('crypto');

// Secret key derived from environment variable or deterministic default for persistence
const ENCRYPTION_SECRET = process.env.TOKEN_ENCRYPTION_KEY || 'mailflow_secure_aes256_secret_key_32_bytes_long!!';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

function getKey(salt) {
  return crypto.pbkdf2Sync(ENCRYPTION_SECRET, salt, ITERATIONS, KEY_LENGTH, 'sha256');
}

class EncryptionService {
  static encrypt(plainText) {
    if (!plainText) return null;
    try {
      const textToEncrypt = typeof plainText === 'object' ? JSON.stringify(plainText) : String(plainText);
      const salt = crypto.randomBytes(SALT_LENGTH);
      const iv = crypto.randomBytes(IV_LENGTH);
      const key = getKey(salt);
      
      const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
      const encrypted = Buffer.concat([cipher.update(textToEncrypt, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();

      // Pack salt + iv + tag + encrypted data as hex
      return Buffer.concat([salt, iv, tag, encrypted]).toString('hex');
    } catch (err) {
      console.error('Encryption error:', err.message);
      return null;
    }
  }

  static decrypt(cipherHex) {
    if (!cipherHex || typeof cipherHex !== 'string') return null;
    try {
      const buffer = Buffer.from(cipherHex, 'hex');
      if (buffer.length < SALT_LENGTH + IV_LENGTH + TAG_LENGTH) {
        return null;
      }

      const salt = buffer.subarray(0, SALT_LENGTH);
      const iv = buffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
      const tag = buffer.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
      const encrypted = buffer.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

      const key = getKey(salt);
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);

      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
      
      try {
        return JSON.parse(decrypted);
      } catch {
        return decrypted;
      }
    } catch (err) {
      console.error('Decryption error:', err.message);
      return null;
    }
  }

  static hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
  }

  static verifyPassword(password, storedHash) {
    if (!storedHash || !storedHash.includes(':')) return false;
    const [salt, hash] = storedHash.split(':');
    const verifyHash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(verifyHash, 'hex'));
  }

  static generateToken(length = 32) {
    return crypto.randomBytes(length).toString('hex');
  }
}

module.exports = EncryptionService;
