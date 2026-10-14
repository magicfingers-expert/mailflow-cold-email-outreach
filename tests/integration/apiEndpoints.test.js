const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

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

test('Leads API - full lifecycle CRUD, CSV import and export', async () => {
  const tenantId = `tenant_leads_${Date.now()}`;
  const headers = { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId };

  // 1. Create Lead
  const createRes = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email: 'alex@cloudscale.io',
      name: 'Alex Rivera',
      company: 'CloudScale',
      niche: 'DevOps'
    })
  });
  const createData = await createRes.json();
  assert.equal(createRes.status, 200);
  assert.equal(createData.lead.email, 'alex@cloudscale.io');
  const leadId = createData.lead.id;

  // 2. Update Lead
  const updateRes = await fetch(`${baseUrl}/api/leads/${leadId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ company: 'CloudScale Global' })
  });
  const updateData = await updateRes.json();
  assert.equal(updateRes.status, 200);
  assert.equal(updateData.lead.company, 'CloudScale Global');

  // 3. Import CSV
  const importRes = await fetch(`${baseUrl}/api/leads/import`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      rawText: 'email,name,company\nbeth@quantum.com,Beth Harmon,Quantum AI\nclark@daily.com,Clark Kent,Daily Planet',
      defaultNiche: 'Tech'
    })
  });
  const importData = await importRes.json();
  assert.equal(importRes.status, 200);
  assert.equal(importData.summary.imported, 2);

  // 4. Export CSV
  const exportRes = await fetch(`${baseUrl}/api/leads/export`, {
    headers: { 'X-Tenant-Id': tenantId }
  });
  assert.equal(exportRes.status, 200);
  assert.equal(exportRes.headers.get('content-type'), 'text/csv; charset=utf-8');
  const csvContent = await exportRes.text();
  assert.ok(csvContent.includes('alex@cloudscale.io'));
  assert.ok(csvContent.includes('beth@quantum.com'));

  // 5. Delete Lead
  const delRes = await fetch(`${baseUrl}/api/leads/${leadId}`, {
    method: 'DELETE',
    headers: { 'X-Tenant-Id': tenantId }
  });
  assert.equal(delRes.status, 200);

  // Verify deletion
  const getDelRes = await fetch(`${baseUrl}/api/leads/${leadId}`, {
    headers: { 'X-Tenant-Id': tenantId }
  });
  assert.equal(getDelRes.status, 404);
});

test('Suppression & RFC-8058 Unsubscribe API - enforcement and lifecycle', async () => {
  const tenantId = `tenant_unsub_${Date.now()}`;
  const headers = { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId };
  const targetEmail = `optout_${Date.now()}@prospect.com`;

  // 1. First add prospect as lead
  await fetch(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: targetEmail, name: 'Opt Out Prospect' })
  });

  // 2. Perform RFC-8058 POST One-Click Unsubscribe
  const postUnsubRes = await fetch(`${baseUrl}/api/unsubscribe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Tenant-Id': tenantId
    },
    body: `email=${encodeURIComponent(targetEmail)}`
  });
  const postUnsubData = await postUnsubRes.json();
  assert.equal(postUnsubRes.status, 200);
  assert.equal(postUnsubData.unsubscribed, true);

  // 3. Query suppression list
  const suppRes = await fetch(`${baseUrl}/api/suppression`, {
    headers: { 'X-Tenant-Id': tenantId }
  });
  const suppData = await suppRes.json();
  assert.equal(suppRes.status, 200);
  assert.ok(suppData.suppressed.includes(targetEmail.toLowerCase()));

  // 4. Verify lead status was automatically marked 'Suppressed'
  const leadsRes = await fetch(`${baseUrl}/api/leads?search=${encodeURIComponent(targetEmail)}`, {
    headers: { 'X-Tenant-Id': tenantId }
  });
  const leadsData = await leadsRes.json();
  assert.equal(leadsData.leads[0].status, 'Suppressed');

  // 5. Test human GET Unsubscribe page renders clean HTML
  const getUnsubRes = await fetch(`${baseUrl}/api/unsubscribe?email=${encodeURIComponent(targetEmail)}`);
  assert.equal(getUnsubRes.status, 200);
  assert.ok((await getUnsubRes.text()).includes('Unsubscribed Successfully'));

  // 6. Delete from suppression list
  const delSuppRes = await fetch(`${baseUrl}/api/suppression/${encodeURIComponent(targetEmail)}`, {
    method: 'DELETE',
    headers: { 'X-Tenant-Id': tenantId }
  });
  assert.equal(delSuppRes.status, 200);
});

test('Security & Safe Error Response - internal errors never leak stack traces', async () => {
  // Trigger bad JSON
  const errRes = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"malformed_json": '
  });
  assert.equal(errRes.status, 400);
  const errData = await errRes.json();
  assert.equal(errData.success, false);
  assert.equal(typeof errData.error, 'string');
  assert.equal(errData.stack, undefined, 'Stack traces must never leak to client');
});
