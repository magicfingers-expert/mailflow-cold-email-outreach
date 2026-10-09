const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET_FILE = path.join(__dirname, '..', 'data', '.app_vault_key');

class SecurityService {
  constructor() {
    this.algorithm = 'aes-256-gcm';
    this.key = this._getOrCreateMasterKey();
  }

  _getOrCreateMasterKey() {
    if (process.env.APP_VAULT_KEY && process.env.APP_VAULT_KEY.length === 64) {
      return Buffer.from(process.env.APP_VAULT_KEY, 'hex');
    }
    if (fs.existsSync(SECRET_FILE)) {
      try {
        const raw = fs.readFileSync(SECRET_FILE, 'utf8').trim();
        if (raw.length === 64) return Buffer.from(raw, 'hex');
      } catch (e) {}
    }
    const newKey = crypto.randomBytes(32);
    try {
      fs.writeFileSync(SECRET_FILE, newKey.toString('hex'), 'utf8');
    } catch (e) {}
    return newKey;
  }

  encrypt(plainText) {
    if (!plainText || typeof plainText !== 'string') return '';
    if (plainText.startsWith('enc:')) return plainText;
    try {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
      let encrypted = cipher.update(plainText, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      const tag = cipher.getAuthTag().toString('hex');
      return `enc:${iv.toString('hex')}:${tag}:${encrypted}`;
    } catch (err) {
      console.error('Encryption error:', err.message);
      return plainText;
    }
  }

  decrypt(encryptedText) {
    if (!encryptedText || typeof encryptedText !== 'string') return '';
    if (!encryptedText.startsWith('enc:')) return encryptedText;
    try {
      const parts = encryptedText.split(':');
      if (parts.length !== 4) return encryptedText;
      const iv = Buffer.from(parts[1], 'hex');
      const tag = Buffer.from(parts[2], 'hex');
      const cipherText = parts[3];
      const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
      decipher.setAuthTag(tag);
      let decrypted = decipher.update(cipherText, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (err) {
      console.error('Decryption error:', err.message);
      return '';
    }
  }

  maskPassword(pass) {
    if (!pass) return '';
    return '••••••••';
  }
}

module.exports = new SecurityService();
