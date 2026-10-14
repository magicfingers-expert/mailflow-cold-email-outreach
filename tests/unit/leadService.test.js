const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const LeadService = require('../../services/leadService');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailflow_leads_test_'));
const testLeadsFile = path.join(tempDir, 'leads.json');

test.before(() => {
  if (fs.existsSync(testLeadsFile)) fs.unlinkSync(testLeadsFile);
});

test('LeadService - create and retrieve lead', () => {
  const service = new LeadService({ leadsFile: testLeadsFile, tenantId: 'test_tenant' });
  const lead = service.createLead({
    email: 'SARAH@company.com',
    firstName: 'Sarah',
    lastName: 'Connor',
    company: 'Cyberdyne',
    niche: 'AI Security'
  });

  assert.ok(lead.id, 'Lead must have generated ID');
  assert.equal(lead.email, 'sarah@company.com', 'Email must be normalized to lowercase');
  assert.equal(lead.status, 'Active');

  const fetched = service.getLeadById(lead.id);
  assert.equal(fetched.email, 'sarah@company.com');
  assert.equal(fetched.company, 'Cyberdyne');
});

test('LeadService - duplicate prevention', () => {
  const service = new LeadService({ leadsFile: testLeadsFile, tenantId: 'test_tenant' });

  assert.throws(() => {
    service.createLead({ email: 'sarah@company.com', company: 'Another Corp' });
  }, /already exists/);
});

test('LeadService - update lead fields', () => {
  const service = new LeadService({ leadsFile: testLeadsFile, tenantId: 'test_tenant' });
  const lead = service.getLeadByEmail('sarah@company.com');

  const updated = service.updateLead(lead.id, {
    company: 'Resistance HQ',
    status: 'Contacted'
  });

  assert.equal(updated.company, 'Resistance HQ');
  assert.equal(updated.status, 'Contacted');
});

test('LeadService - CSV and text import with deduplication and update', () => {
  const service = new LeadService({ leadsFile: testLeadsFile, tenantId: 'test_tenant' });
  const rawCsv = `
email,name,company,niche
john@rebel.org,John Connor,Tech,Defense
kyle@rebel.org,Kyle Reese,Logistics,Military
sarah@company.com,Sarah Connor,Updated Cyberdyne,Defense
invalid-address,Nobody,Void,Null
`;

  const summary = service.importFromRawText(rawCsv, {
    defaultNiche: 'General',
    updateExisting: true
  });

  assert.equal(summary.imported, 2, '2 new valid leads imported');
  assert.equal(summary.updated, 1, 'Sarah Connor updated because updateExisting=true');
  assert.equal(summary.invalid, 1, 'invalid-address counted as invalid');
  assert.equal(summary.errors.length, 1);
});

test('LeadService - search and filtering', () => {
  const service = new LeadService({ leadsFile: testLeadsFile, tenantId: 'test_tenant' });

  // Search by name
  const resName = service.getLeads({ search: 'Kyle' });
  assert.equal(resName.leads.length, 1);
  assert.equal(resName.leads[0].email, 'kyle@rebel.org');

  // Search by company
  const resComp = service.getLeads({ search: 'Rebel' });
  assert.equal(resComp.leads.length, 2);

  // Filter by status
  const resStatus = service.getLeads({ status: 'Contacted' });
  assert.equal(resStatus.leads.length, 1);
  assert.equal(resStatus.leads[0].email, 'sarah@company.com');
});

test('LeadService - export to CSV', () => {
  const service = new LeadService({ leadsFile: testLeadsFile, tenantId: 'test_tenant' });
  const csvData = service.exportToCsv();

  assert.ok(csvData.startsWith('Email,Name,Business Name,Website,Phone,City,Category,Audit Status,Audit Score,Status,Created At'));
  assert.ok(csvData.includes('john@rebel.org'));
  assert.ok(csvData.includes('kyle@rebel.org'));
  assert.ok(csvData.includes('sarah@company.com'));
});

test('LeadService - bulk deletion', () => {
  const service = new LeadService({ leadsFile: testLeadsFile, tenantId: 'test_tenant' });
  const all = service.getLeads().leads;
  const idsToDelete = [all[0].id, all[1].id];

  const deletedCount = service.bulkDeleteLeads(idsToDelete);
  assert.equal(deletedCount, 2);

  const remaining = service.getLeads().leads;
  assert.equal(remaining.length, all.length - 2);
});

test('LeadService - suppression and bounce status updates', () => {
  const service = new LeadService({ leadsFile: testLeadsFile, tenantId: 'test_tenant' });
  service.createLead({ email: 'target@bouncetest.com', name: 'Target' });

  service.markLeadBounced('target@bouncetest.com', '550 Mailbox does not exist');
  let lead = service.getLeadByEmail('target@bouncetest.com');
  assert.equal(lead.status, 'Bounced');

  service.markLeadSuppressed('target@bouncetest.com', 'Unsubscribed via RFC-8058');
  lead = service.getLeadByEmail('target@bouncetest.com');
  assert.equal(lead.status, 'Suppressed');
  assert.equal(lead.suppressedReason, 'Unsubscribed via RFC-8058');
});
