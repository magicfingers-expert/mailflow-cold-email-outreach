const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const storage = require('../../services/storageService');
const EmailService = require('../../services/emailService');
const QueueService = require('../../services/queueService');

const testAccountsFile = path.join(__dirname, '..', '..', 'data', 'test_multi_accounts.json');
const testCampaignsFile = path.join(__dirname, '..', '..', 'data', 'test_multi_campaigns.json');

function cleanup() {
  [testAccountsFile, testCampaignsFile].forEach(f => {
    storage.deleteFile(f);
  });
}

test('Multi-Account Routing - Quota preview, balanced allocation, daily caps, and anti-abuse throttles', async () => {
  cleanup();

  const emailService = new EmailService({
    accountsFile: testAccountsFile,
    tenantId: 'test_tenant'
  });

  const queueService = new QueueService({
    campaignsFile: testCampaignsFile,
    emailService,
    tenantId: 'test_tenant'
  });

  // 1. Bulk setup 3 sender accounts with daily send caps:
  // Account A: 10 daily cap, 0 used
  // Account B: 15 daily cap, 5 used (10 remaining)
  // Account C: 5 daily cap, 5 used (0 remaining - EXHAUSTED)
  const accA = emailService.addAccount({
    email: 'senderA@domain.com',
    password: 'abcdefghijklmnop',
    name: 'Sender A',
    dailyLimit: 10,
    dailySendCap: 10
  });

  const accB = emailService.addAccount({
    email: 'senderB@domain.com',
    password: 'bcdefghijklmnopa',
    name: 'Sender B',
    dailyLimit: 15,
    dailySendCap: 15
  });

  const accC = emailService.addAccount({
    email: 'senderC@domain.com',
    password: 'cdefghijklmnopab',
    name: 'Sender C',
    dailyLimit: 5,
    dailySendCap: 5
  });

  // Simulate usage on B and C
  emailService.recordEmailSent(accB.id, 5);
  emailService.recordEmailSent(accC.id, 5);

  const safeAccounts = emailService.getSafeAccounts();
  const safeA = safeAccounts.find(a => a.id === accA.id);
  const safeB = safeAccounts.find(a => a.id === accB.id);
  const safeC = safeAccounts.find(a => a.id === accC.id);

  assert.equal(safeA.remainingCapacity, 10);
  assert.equal(safeB.remainingCapacity, 10);
  assert.equal(safeC.remainingCapacity, 0, 'Account C should have 0 remaining sends');

  // 2. Test Multi-Account Allocation Preview with 16 recipients
  // Total pool capacity across A (10) and B (10) is 20.
  // Account C (0 remaining) must receive 0 allocated leads.
  const rawRecipients = Array.from({ length: 16 }, (_, i) => `lead_${i + 1}@prospect.com`).join('\n');

  const preview = queueService.previewMultiAccountAllocation({
    rawRecipients,
    selectedAccountIds: [accA.id, accB.id, accC.id]
  });

  assert.ok(preview);
  assert.equal(preview.totalValid, 16);
  assert.equal(preview.totalPoolCapacity, 20);
  assert.equal(preview.isCapped, false);

  const allocA = preview.allocations.find(a => a.accountId === accA.id);
  const allocB = preview.allocations.find(a => a.accountId === accB.id);
  const allocC = preview.allocations.find(a => a.accountId === accC.id);

  assert.ok(allocA && allocB);
  assert.equal(allocA.count + allocB.count, 16, 'All 16 leads should be shared between A and B');
  assert.ok(allocA.count <= 10, 'A should not exceed its remaining capacity of 10');
  assert.ok(allocB.count <= 10, 'B should not exceed its remaining capacity of 10');
  assert.equal(allocC ? allocC.count : 0, 0, 'Exhausted account C must receive 0 allocations');

  // 3. Test Cap Enforcement with 25 recipients (pool capacity is 20)
  const largeRecipients = Array.from({ length: 25 }, (_, i) => `bulk_${i + 1}@client.com`).join('\n');
  const cappedPreview = queueService.previewMultiAccountAllocation({
    rawRecipients: largeRecipients,
    selectedAccountIds: [accA.id, accB.id, accC.id]
  });

  assert.equal(cappedPreview.isCapped, true);
  assert.equal(cappedPreview.totalAllocated, 20, 'Should strictly cap total allocated to remaining pool capacity');

  // 4. Test Provider Cooldown / Throttle Protection:
  // If Account A experiences a provider rate limit (e.g. 421 / 454 error),
  // it is set to throttled and must not be used to evade provider limits.
  emailService.setAccountThrottled(accA.id, 60 * 1000, '421 4.7.0 Rate limit exceeded');
  const throttledSafeA = emailService.getSafeAccounts().find(a => a.id === accA.id);
  assert.equal(throttledSafeA.isThrottled, true);
  assert.ok(throttledSafeA.throttleUntil);

  // Re-previewing allocation should now automatically skip throttled Account A
  const postThrottlePreview = queueService.previewMultiAccountAllocation({
    rawRecipients: 'test1@company.com\ntest2@company.com',
    selectedAccountIds: [accA.id, accB.id]
  });

  const postAllocA = postThrottlePreview.allocations.find(a => a.accountId === accA.id);
  assert.equal(postAllocA ? postAllocA.count : 0, 0, 'Throttled account must be excluded from dispatch');

  cleanup();
});
