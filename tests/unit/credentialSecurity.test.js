const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const EmailService = require('../../services/emailService');
const securityService = require('../../services/securityService');

test('EmailService.cleanPassword - sanitizes and transparently decrypts vault passwords', () => {
  const svc = new EmailService();

  // 1. Plain text app password with spaces
  const plainAppPass = 'abcd efgh ijkl mnop';
  assert.equal(svc.cleanPassword(plainAppPass), 'abcdefghijklmnop');

  // 2. Plain text password with quotes and surrounding whitespace
  assert.equal(svc.cleanPassword('  "secretpass123"  '), 'secretpass123');

  // 3. Hyphenated app password format
  assert.equal(svc.cleanPassword('abcd-efgh-ijkl-mnop'), 'abcdefghijklmnop');

  // 4. AES-256-GCM encrypted vault password (starts with 'enc:')
  const rawSecret = 'wxyz qrst uvwx yzab';
  const encrypted = securityService.encrypt(rawSecret);
  assert.ok(encrypted.startsWith('enc:'), 'Encrypted password must start with enc:');

  const decryptedAndCleaned = svc.cleanPassword(encrypted);
  assert.equal(decryptedAndCleaned, 'wxyzqrstuvwxyzab', 'cleanPassword must decrypt and strip spaces from vault passwords');
});

test('EmailService.getSafeAccounts - ensures zero credential leakage to frontend', () => {
  // Setup a test instance
  const testAccountFile = path.join(__dirname, '..', '..', 'scratch', 'test_accounts_sec.json');
  fs.mkdirSync(path.dirname(testAccountFile), { recursive: true });
  fs.writeFileSync(testAccountFile, '[]');

  const svc = new EmailService({ accountsFile: testAccountFile });

  const plainPass = 'pass word 1234 5678';
  const saved = svc.saveOrUpdateAccount({
    email: 'outreach@testdomain.com',
    password: plainPass,
    name: 'Outreach Team'
  });

  // Verify internal storage is encrypted
  assert.ok(saved.password.startsWith('enc:'), 'Stored account in vault must be AES-256-GCM encrypted');

  // Verify getSafeAccounts() strips the password field entirely
  const safeAccounts = svc.getSafeAccounts();
  assert.equal(safeAccounts.length, 1);
  const safe = safeAccounts[0];
  assert.equal(safe.email, 'outreach@testdomain.com');
  assert.equal(safe.hasPassword, true, 'hasPassword flag must indicate password presence');
  assert.equal(safe.password, undefined, 'password field MUST be omitted in safe accounts');

  // Clean up
  try { fs.unlinkSync(testAccountFile); } catch (e) {}
});

test('EmailService.getAccountPassword - decrypts stored vault password correctly', () => {
  const svc = new EmailService();
  const rawPass = 'abcd efgh ijkl mnop';
  const encPass = securityService.encrypt(rawPass);

  const accountObj = {
    email: 'user@example.com',
    password: encPass
  };

  const retrieved = svc.getAccountPassword(accountObj);
  assert.equal(retrieved, rawPass);
});
