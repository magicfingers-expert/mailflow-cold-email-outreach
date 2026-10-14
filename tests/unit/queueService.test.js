const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const QueueService = require('../../services/queueService');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailflow_queue_test_'));
const testCampaignsFile = path.join(tempDir, 'campaigns.json');
const testOpenEventsFile = path.join(tempDir, 'open_events.json');

test.before(() => {
  if (fs.existsSync(testCampaignsFile)) fs.unlinkSync(testCampaignsFile);
  if (fs.existsSync(testOpenEventsFile)) fs.unlinkSync(testOpenEventsFile);
});

// Mock email service
const sentLog = [];
const mockEmailService = {
  accounts: [{ id: 'acc-1', email: 'sender@example.com', status: 'Connected', sendingReady: true }],
  async sendEmail(options) {
    sentLog.push(options);
    return {
      success: true,
      mode: 'mock',
      messageId: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      subjectSent: options.subject
    };
  }
};

// Mock bounce service
const mockBounceService = {
  bounces: [{ email: 'bounced@prior.com', reason: '550 User not found' }],
  suppressedList: ['suppressed@prior.com'],
  getSuppressedEmails() {
    return this.suppressedList;
  },
  isSuppressed(email) {
    return this.suppressedList.includes(email.toLowerCase());
  },
  recordBounce() {}
};

test('QueueService - launches campaign and executes sends', async () => {
  const queue = new QueueService(mockEmailService, {
    campaignsFile: testCampaignsFile,
    openEventsFile: testOpenEventsFile,
    bounceService: mockBounceService
  });

  const campaign = await queue.startDirectCampaign({
    senderEmail: 'sender@example.com',
    senderPassword: 'mock-password',
    senderName: 'Sender Team',
    subject: 'Hello {{name}}',
    message: 'Message for {{company|your company}}',
    rawRecipients: 'lead1@corp.com\nlead2@corp.com\nsuppressed@prior.com',
    delaySeconds: 1 // fast for test
  });

  assert.ok(campaign.campaignId);
  assert.equal(campaign.totalRecipients, 2, 'Suppressed lead should be filtered out by validator');
  assert.equal(campaign.senderEmail, 'sender@example.com');

  // Verify stats calculation
  const stats = queue.getStats();
  assert.equal(stats.campaignsTotal, 1);
  assert.equal(stats.bouncesCount, 1);
  assert.equal(stats.suppressedCount, 1);
  assert.equal(stats.activeSenders, 1);
  assert.ok(stats.openTrackingNotice.includes('approximations'));
});

test('QueueService - pause and stop state controls', async () => {
  const queue = new QueueService(mockEmailService, {
    campaignsFile: testCampaignsFile,
    openEventsFile: testOpenEventsFile,
    bounceService: mockBounceService
  });

  const campaigns = queue.getCampaigns();
  const campId = campaigns[0].id;

  // Pause campaign
  const pauseRes = queue.pauseCampaign(campId);
  assert.equal(pauseRes.success, true);
  let updatedCamp = queue.getCampaignById(campId);
  assert.equal(updatedCamp.status, 'Paused');

  // Stop campaign
  const stopRes = queue.stopCampaign(campId);
  assert.equal(stopRes.success, true);
  updatedCamp = queue.getCampaignById(campId);
  assert.equal(updatedCamp.status, 'Stopped');
});

test('QueueService - records email opens accurately without inflating stats', () => {
  const queue = new QueueService(mockEmailService, {
    campaignsFile: testCampaignsFile,
    openEventsFile: testOpenEventsFile,
    bounceService: mockBounceService
  });

  const campaigns = queue.getCampaigns();
  const camp = campaigns[0];
  const rec = camp.recipients[0];

  assert.ok(rec.trackingId);

  // First open
  const open1 = queue.recordEmailOpen(rec.trackingId, { ip: '192.168.1.1' });
  assert.ok(open1);
  assert.equal(open1.isFirstOpen, true);
  assert.equal(open1.openCount, 1);

  // Subsequent open from automated scanner
  const open2 = queue.recordEmailOpen(rec.trackingId, { ip: '192.168.1.2' });
  assert.ok(open2);
  assert.equal(open2.isFirstOpen, false);
  assert.equal(open2.openCount, 2);

  // Campaign open count reflects unique opened leads (1 lead opened)
  const refreshedCamp = queue.getCampaignById(camp.id);
  assert.equal(refreshedCamp.openCount, 1, 'Unique recipients opened count must be 1');
  const refreshedRec = refreshedCamp.recipients[0];
  assert.equal(refreshedRec.openCount, 2, 'Raw open events for this lead must be 2');
});
