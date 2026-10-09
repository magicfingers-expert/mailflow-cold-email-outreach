const assert = require('assert');
const path = require('path');
const fs = require('fs');

const EncryptionService = require('./services/encryptionService');
const db = require('./services/db');
const AuthService = require('./services/authService');
const EmailValidator = require('./services/emailValidator');
const EmailConnectionService = require('./services/gmailOAuthService');
const QueueService = require('./services/queueService');

async function runTests() {
  console.log('--- STARTING SYSTEM INTEGRATION TESTS ---');

  // Test 1: Encryption / Decryption
  console.log('1. Testing AES-256 Token Encryption & PBKDF2 Password Hashing...');
  const secretData = { accessToken: 'ya29.sample_oauth_token_12345', expires: 3600 };
  const encrypted = EncryptionService.encrypt(secretData);
  assert(encrypted !== null, 'Encryption failed');
  const decrypted = EncryptionService.decrypt(encrypted);
  assert.strictEqual(decrypted.accessToken, secretData.accessToken, 'Decrypted token mismatch');
  
  const hash = EncryptionService.hashPassword('MySecurePassword123!');
  assert(EncryptionService.verifyPassword('MySecurePassword123!', hash), 'Password verify failed');
  assert(!EncryptionService.verifyPassword('WrongPassword', hash), 'Password verify false positive');
  console.log('✓ Encryption & Password Hashing: Passed');

  // Test 2: Email Validator (Parsing, deduplication, invalid detection, 50 limit)
  console.log('2. Testing Email Validation & 50-Recipient Limits...');
  const sampleRaw = `
    john.doe@example.com
    SARAH@EXAMPLE.COM
    john.doe@example.com
    invalid-email-address
    mike@test.co
    another.invalid@
  `;
  const valResult = EmailValidator.cleanAndValidate(sampleRaw);
  assert.strictEqual(valResult.validCount, 3, `Expected 3 valid emails, got ${valResult.validCount}`);
  assert.strictEqual(valResult.duplicatesRemoved, 1, `Expected 1 duplicate, got ${valResult.duplicatesRemoved}`);
  assert.strictEqual(valResult.invalidCount, 2, `Expected 2 invalid emails, got ${valResult.invalidCount}`);
  assert.strictEqual(valResult.canSend, false, 'Should block send when invalid emails exist');

  // Test 55 emails pasted (over 50)
  const manyEmails = Array.from({ length: 55 }, (_, i) => `user${i + 1}@domain.com`).join('\n');
  const limitResult = EmailValidator.cleanAndValidate(manyEmails);
  assert.strictEqual(limitResult.validCount, 55, 'Should count all 55 valid');
  assert.strictEqual(limitResult.cappedRecipients.length, 50, 'Must cap to exactly 50');
  assert.strictEqual(limitResult.isOverLimit, true, 'isOverLimit should be true');
  assert.strictEqual(limitResult.canSend, true, 'Should allow send since no invalid emails');
  console.log('✓ Email Validation & 50 Limit Enforcement: Passed');

  // Test 3: User Authentication & Registration
  console.log('3. Testing Multi-User Auth & Registration...');
  const testEmail = `tester_${Date.now()}@example.com`;
  const authRes = AuthService.register({
    name: 'Test Engineer',
    email: testEmail,
    password: 'Password999!'
  });
  assert(authRes.user && authRes.token, 'Register failed');
  assert.strictEqual(authRes.user.email, testEmail);

  const loginRes = AuthService.login({
    email: testEmail,
    password: 'Password999!'
  });
  assert(loginRes.token, 'Login failed');
  console.log('✓ Multi-User Registration & Login: Passed');

  // Test 4: Email Connection
  console.log('4. Testing Email Connection...');
  const emailService = new EmailConnectionService();
  const conn = emailService.connectSimulatedAccount(authRes.user.id, `tester.outreach@gmail.com`);
  assert(conn && conn.email_address === 'tester.outreach@gmail.com', 'Connect email failed');
  const userConns = emailService.getSafeConnections(authRes.user.id);
  assert.strictEqual(userConns.length, 1);
  console.log('✓ Email Connection: Passed');

  // Test 5: Queue Service Campaign Creation & Background Processing
  console.log('5. Testing Campaign Creation & Queue Execution...');
  const queueService = new QueueService(emailService);
  const campRes = await queueService.createCampaign(authRes.user.id, {
    connectionId: conn.id,
    subject: 'Exclusive Beta Invitation',
    message: 'Hello {{email}}, check out our new update!',
    rawRecipients: `lead1@corp.com\nlead2@corp.com\nlead3@corp.com`
  });
  assert(campRes.campaign && campRes.campaign.recipient_count === 3, 'Create campaign failed');

  // Trigger send
  const sendRes = await queueService.startCampaignSending(authRes.user.id, campRes.campaign.id);
  assert(sendRes.success, 'Start campaign sending failed');

  // Wait 4 seconds for queue to finish 3 emails
  console.log('Waiting for background server queue to dispatch 3 emails...');
  await new Promise(r => setTimeout(r, 4500));

  const campStatus = queueService.getCampaignStatus(authRes.user.id, campRes.campaign.id);
  assert(campStatus.campaign.sent_count === 3, `Expected 3 sent emails, got ${campStatus.campaign.sent_count}`);
  assert.strictEqual(campStatus.campaign.status, 'Completed', 'Campaign status should be Completed');
  console.log('✓ Server-Side Campaign Execution & Background Queue: Passed');

  // Test 6: Multi-Tenant Data Isolation
  console.log('6. Testing Multi-Tenant Data Isolation...');
  const user2Res = AuthService.register({
    name: 'Second User',
    email: `isolated_${Date.now()}@domain.com`,
    password: 'Password123!'
  });
  const user2Campaigns = queueService.getUserCampaigns(user2Res.user.id);
  assert.strictEqual(user2Campaigns.length, 0, 'User 2 should not see User 1 campaigns');
  const user1Campaigns = queueService.getUserCampaigns(authRes.user.id);
  assert(user1Campaigns.length >= 1, 'User 1 should see their own campaigns');
  console.log('✓ Multi-Tenant Isolation: Passed');

  console.log('\n========================================');
  console.log('🎉 ALL INTEGRATION TESTS PASSED 100%!');
  console.log('========================================\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('❌ Test failure:', err);
  process.exit(1);
});
