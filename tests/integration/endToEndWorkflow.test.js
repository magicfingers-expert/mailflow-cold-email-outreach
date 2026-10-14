const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.VERCEL = '1';
process.env.MAILFLOW_TEST_MODE = '1';
const app = require('../../server');

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test('E2E Lifecycle - Complete user workflow from auth to campaign and suppression', async () => {
  const userEmail = `founder_${Date.now()}@saasstartup.com`;
  const userPassword = 'EnterpriseSecurePassword2026!';

  // Step 1: Register and login user
  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: userEmail, password: userPassword, name: 'SaaS Founder' })
  });
  const regData = await regRes.json();
  assert.equal(regRes.status, 200);
  assert.ok(regData.token);
  const tenantId = regData.user.default_tenant_id;

  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${regData.token}`,
    'X-Tenant-Id': tenantId
  };

  // Step 2: Create a test prospect lead
  const leadEmail = `prospect_${Date.now()}@targetcompany.io`;
  const createLeadRes = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      email: leadEmail,
      firstName: 'Samantha',
      lastName: 'Carter',
      company: 'Stargate Corp',
      niche: 'Deep Tech'
    })
  });
  const createLeadData = await createLeadRes.json();
  assert.equal(createLeadRes.status, 200);
  assert.equal(createLeadData.lead.email, leadEmail);
  assert.equal(createLeadData.lead.status, 'Active');

  // Step 3: Compose and preview personalized message
  const previewRes = await fetch(`${baseUrl}/api/leads/preview-template`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      template: 'Hi {{name}}, loved your work at {{company}}. Quick question about {{niche}}?',
      lead: createLeadData.lead,
      sender: { name: 'SaaS Founder', email: userEmail }
    })
  });
  const previewData = await previewRes.json();
  assert.equal(previewData.text, 'Hi Samantha Carter, loved your work at Stargate Corp. Quick question about Deep Tech?');
  assert.equal(previewData.unresolved.length, 0);

  // Step 4: Connect sender account
  const senderEmail = `outreach_${Date.now()}@gmail.com`;
  const addAccountRes = await fetch(`${baseUrl}/api/accounts`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      email: senderEmail,
      password: 'abcd efgh ijkl mnop',
      isDefault: true
    })
  });
  const addAccountData = await addAccountRes.json();
  assert.equal(addAccountRes.status, 200);
  assert.ok(addAccountData.account);

  // Step 5: Launch campaign using controlled test adapter mode
  const launchRes = await fetch(`${baseUrl}/api/campaigns/send-direct`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      senderEmail,
      senderPassword: 'abcd efgh ijkl mnop',
      senderName: 'SaaS Founder',
      subject: 'Collaboration with {{company}}',
      message: 'Hi {{firstName|there}},\n\nLet us connect.\n\nBest,\nSaaS Founder',
      rawRecipients: `${leadEmail}\nsecondary_${Date.now()}@targetcompany.io`,
      delaySeconds: 1
    })
  });
  const launchData = await launchRes.json();
  assert.equal(launchRes.status, 200);
  assert.equal(launchData.success, true);
  assert.ok(launchData.campaignId);
  const campId = launchData.campaignId;

  // Step 6: Verify actual campaign job processing and state persistence
  const getCampRes = await fetch(`${baseUrl}/api/campaigns`, { headers: authHeaders });
  const getCampData = await getCampRes.json();
  assert.equal(getCampRes.status, 200);
  assert.ok(Array.isArray(getCampData.campaigns));
  const activeCamp = getCampData.campaigns.find(c => c.id === campId);
  assert.ok(activeCamp);
  assert.equal(activeCamp.totalRecipients, 2);

  // Step 7: Test pause, resume, and stop controls
  const pauseRes = await fetch(`${baseUrl}/api/campaigns/pause`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ campaignId: campId })
  });
  assert.equal(pauseRes.status, 200);

  const resumeRes = await fetch(`${baseUrl}/api/campaigns/resume`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ campaignId: campId, password: 'abcd efgh ijkl mnop' })
  });
  assert.equal(resumeRes.status, 200);

  const stopRes = await fetch(`${baseUrl}/api/campaigns/stop`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ campaignId: campId })
  });
  assert.equal(stopRes.status, 200);

  // Step 8: Unsubscribe the test contact
  const unsubRes = await fetch(`${baseUrl}/api/unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Tenant-Id': tenantId },
    body: `email=${encodeURIComponent(leadEmail)}`
  });
  assert.equal(unsubRes.status, 200);

  // Step 9: Verify that future sends to this contact are strictly blocked
  const reLaunchRes = await fetch(`${baseUrl}/api/campaigns/send-direct`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      senderEmail,
      senderPassword: 'abcd efgh ijkl mnop',
      subject: 'Attempting blocked send',
      message: 'This should not be delivered',
      rawRecipients: leadEmail, // only the unsubscribed contact
      delaySeconds: 1
    })
  });
  // Since all recipients in rawRecipients are suppressed, canSend must be false and throw 400
  assert.equal(reLaunchRes.status, 400);
  const reLaunchData = await reLaunchRes.json();
  assert.ok(reLaunchData.error.includes('valid lead email address'));

  // Step 10: Unauthorized cross-user access attempt
  const crossUserHeaders = {
    'Content-Type': 'application/json',
    'X-Tenant-Id': `intruder_tenant_${Date.now()}`
  };
  const intruderLeadsRes = await fetch(`${baseUrl}/api/leads`, { headers: crossUserHeaders });
  const intruderLeadsData = await intruderLeadsRes.json();
  assert.equal(intruderLeadsData.total, 0, 'Intruder tenant must not see any leads belonging to user');

  const intruderCampRes = await fetch(`${baseUrl}/api/campaigns`, { headers: crossUserHeaders });
  const intruderCampData = await intruderCampRes.json();
  assert.equal(intruderCampData.campaigns.length, 0, 'Intruder tenant must not see any campaigns');
});
