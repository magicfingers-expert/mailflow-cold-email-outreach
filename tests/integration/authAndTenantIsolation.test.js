const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// Set VERCEL=1 so server.js exports app without listening on port 3000
process.env.VERCEL = '1';
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

test('Auth API - User registration and login flow', async () => {
  const testEmail = `user_${Date.now()}@testcompany.io`;
  const testPassword = 'StrongPassword123!';

  // 1. Register new user
  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: testEmail,
      password: testPassword,
      name: 'Test Founder'
    })
  });
  const regData = await regRes.json();
  assert.equal(regRes.status, 200);
  assert.equal(regData.success, true);
  assert.ok(regData.token, 'Registration should return an authentication token');
  assert.equal(regData.user.email, testEmail);

  // 2. Login with registered credentials
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: testEmail,
      password: testPassword
    })
  });
  const loginData = await loginRes.json();
  assert.equal(loginRes.status, 200);
  assert.equal(loginData.success, true);
  assert.ok(loginData.token);
  assert.equal(loginData.user.email, testEmail);

  // 3. Login with invalid password
  const badLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: testEmail,
      password: 'WrongPassword999!'
    })
  });
  assert.equal(badLoginRes.status, 401);
});

test('Tenant Isolation - User A data is strictly invisible to User B', async () => {
  const tenantA = `tenant_alpha_${Date.now()}`;
  const tenantB = `tenant_beta_${Date.now()}`;

  // Tenant A adds a private lead
  const addLeadRes = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': tenantA
    },
    body: JSON.stringify({
      email: 'confidential_prospect@enterprise.com',
      firstName: 'Confidential',
      company: 'Alpha Exclusive'
    })
  });
  const addLeadData = await addLeadRes.json();
  assert.equal(addLeadRes.status, 200);
  assert.equal(addLeadData.success, true);
  const leadId = addLeadData.lead.id;

  // Tenant A queries leads -> sees 1 lead
  const getLeadsARes = await fetch(`${baseUrl}/api/leads`, {
    headers: { 'X-Tenant-Id': tenantA }
  });
  const getLeadsAData = await getLeadsARes.json();
  assert.equal(getLeadsAData.total, 1);
  assert.equal(getLeadsAData.leads[0].email, 'confidential_prospect@enterprise.com');

  // Tenant B queries leads -> sees 0 leads (Tenant isolation enforced)
  const getLeadsBRes = await fetch(`${baseUrl}/api/leads`, {
    headers: { 'X-Tenant-Id': tenantB }
  });
  const getLeadsBData = await getLeadsBRes.json();
  assert.equal(getLeadsBData.total, 0, 'Tenant B must NOT see Tenant A leads');
  assert.equal(getLeadsBData.leads.length, 0);

  // Tenant B attempts to delete Tenant A lead -> must fail with 404
  const deleteRes = await fetch(`${baseUrl}/api/leads/${leadId}`, {
    method: 'DELETE',
    headers: { 'X-Tenant-Id': tenantB }
  });
  assert.equal(deleteRes.status, 404, 'Cross-tenant deletion must be rejected');

  // Verify Tenant A still has the lead intact
  const verifyLeadsARes = await fetch(`${baseUrl}/api/leads`, {
    headers: { 'X-Tenant-Id': tenantA }
  });
  const verifyLeadsAData = await verifyLeadsARes.json();
  assert.equal(verifyLeadsAData.total, 1);
});
