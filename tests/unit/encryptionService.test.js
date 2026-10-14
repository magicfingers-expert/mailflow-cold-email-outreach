const test = require('node:test');
const assert = require('node:assert/strict');
const EncryptionService = require('../../services/encryptionService');
const SecurityService = require('../../services/securityService');

test('EncryptionService - hashes password and verifies correctly', () => {
  const password = 'SuperSecretPassword123!';
  const hash = EncryptionService.hashPassword(password);

  assert.ok(hash.includes(':'), 'Hash must contain salt and digest separated by colon');
  assert.equal(EncryptionService.verifyPassword(password, hash), true, 'Correct password must verify');
  assert.equal(EncryptionService.verifyPassword('WrongPassword', hash), false, 'Wrong password must fail');
  assert.equal(EncryptionService.verifyPassword('', hash), false, 'Empty password must fail');
  assert.equal(EncryptionService.verifyPassword(password, 'invalid:hash'), false, 'Corrupted hash must fail safely');
});

test('EncryptionService - timingSafeEqual resistance to mismatched buffer lengths', () => {
  const shortHash = 'abcdef:1234';
  assert.equal(EncryptionService.verifyPassword('password', shortHash), false);
  assert.equal(EncryptionService.verifyPassword('password', ''), false);
  assert.equal(EncryptionService.verifyPassword('password', null), false);
});

test('EncryptionService - AES-256-GCM encrypts and decrypts string & object data', () => {
  const sensitiveString = 'my-oauth-access-token-xyz-123';
  const ciphertext = EncryptionService.encrypt(sensitiveString);

  assert.notEqual(ciphertext, sensitiveString);
  assert.equal(typeof ciphertext, 'string');

  const decrypted = EncryptionService.decrypt(ciphertext);
  assert.equal(decrypted, sensitiveString);

  // Object encryption
  const sensitiveObj = { user: 'thomas', role: 'admin', apiKey: 'key_998877' };
  const objCiphertext = EncryptionService.encrypt(sensitiveObj);
  const decryptedObj = EncryptionService.decrypt(objCiphertext);
  assert.deepEqual(decryptedObj, sensitiveObj);
});

test('EncryptionService - rejects tampered ciphertext', () => {
  const original = 'legitimate message';
  const ciphertext = EncryptionService.encrypt(original);

  // Tamper with last 2 characters
  const tampered = ciphertext.slice(0, -2) + (ciphertext.slice(-2) === 'aa' ? 'bb' : 'aa');
  const result = EncryptionService.decrypt(tampered);

  assert.equal(result, null, 'Tampered ciphertext must fail authentication and return null');
});

test('SecurityService - credential vault AES-256-GCM encryption and decryption', () => {
  const security = SecurityService;
  const rawPassword = 'abcd efgh ijkl mnop'; // Google App Password format

  const encrypted = security.encrypt(rawPassword);
  assert.ok(encrypted.startsWith('enc:'), 'Encrypted password must have enc: prefix');
  assert.notEqual(encrypted, rawPassword);

  // Idempotent: re-encrypting already encrypted string returns same string
  const doubleEncrypted = security.encrypt(encrypted);
  assert.equal(doubleEncrypted, encrypted);

  // Decrypts accurately
  const decrypted = security.decrypt(encrypted);
  assert.equal(decrypted, rawPassword);

  // Decrypting unencrypted string returns itself
  assert.equal(security.decrypt('plaintext-pass'), 'plaintext-pass');
});
