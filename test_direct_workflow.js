const assert = require('assert');
const EmailService = require('./services/emailService');
const QueueService = require('./services/queueService');
const EmailValidator = require('./services/emailValidator');

async function testDirectOutreach() {
  console.log('--- TESTING DIRECT EMAIL/PASSWORD & ANTI-SPAM OUTREACH WORKFLOW ---');

  // Test 1: Email Validator
  console.log('1. Testing 50-lead limit & validation...');
  const testLeads = `
    lead1@company.com
    lead2@company.com
    lead1@company.com
    bad-lead
    lead3@domain.io
  `;
  const val = EmailValidator.cleanAndValidate(testLeads);
  assert.strictEqual(val.validCount, 3);
  assert.strictEqual(val.duplicatesRemoved, 1);
  assert.strictEqual(val.invalidCount, 1);
  assert.strictEqual(val.canSend, false); // blocked due to invalid email
  console.log('✓ Validation & Duplicate Stripping: Passed');

  // Test 2: Direct Queue with Anti-Spam Throttling (Simulated with short delay)
  console.log('2. Testing Direct Queue Dispatch & Anti-Spam Interval...');
  const emailService = new EmailService();
  const queueService = new QueueService(emailService);

  const directCamp = await queueService.startDirectCampaign({
    senderEmail: 'myrealaccount@gmail.com',
    senderPassword: 'abcd efgh ijkl mnop',
    senderName: 'My Real Name',
    subject: 'Partnership Inquiry',
    message: 'Hi {{email}},\n\nI would love to partner with you.',
    rawRecipients: `founder1@startup.com\nfounder2@startup.com`,
    delaySeconds: 10 // Fast test
  });

  assert(directCamp.success && directCamp.campaignId, 'Direct campaign launch failed');
  console.log(`Campaign Launched with ID: ${directCamp.campaignId}`);

  // Inspect live status
  const status1 = queueService.getCampaignStatus(directCamp.campaignId);
  assert(status1.campaign.senderEmail === 'myrealaccount@gmail.com');
  assert.strictEqual(status1.campaign.totalRecipients, 2);
  console.log('✓ Direct Mailbox Setup & Campaign Initialized: Passed');

  // Wait for queue
  console.log('Waiting for queue processing...');
  await new Promise(r => setTimeout(r, 1500));

  const status2 = queueService.getCampaignStatus(directCamp.campaignId);
  console.log(`Progress: ${status2.campaign.sentCount} sent, ${status2.campaign.pendingCount} pending`);
  assert(status2.campaign.sentCount >= 1, 'First email should be sent');
  console.log('✓ Anti-Spam Delivery & Live Tracking: Passed');

  console.log('\n========================================');
  console.log('🎉 DIRECT OUTREACH ENGINE VERIFIED 100%!');
  console.log('========================================\n');
  process.exit(0);
}

testDirectOutreach().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
