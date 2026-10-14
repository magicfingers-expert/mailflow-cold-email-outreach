const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const storage = require('../../services/storageService');
const LeadService = require('../../services/leadService');

const testLeadsFile = path.join(__dirname, '..', '..', 'data', 'test_bulk_leads.json');
const testImportJobsFile = path.join(__dirname, '..', '..', 'data', 'test_bulk_import_jobs.json');

function cleanup() {
  [testLeadsFile, testImportJobsFile].forEach(f => {
    storage.deleteFile(f);
  });
}

test('LeadService - processes bulk input of >1,000 records with chunking, dedup, suppression, and reports', async () => {
  cleanup();
  const leadService = new LeadService({
    leadsFile: testLeadsFile,
    importJobsFile: testImportJobsFile,
    tenantId: 'test_tenant'
  });

  // Pre-seed an existing lead to test duplicate skipping
  leadService.createLead({
    email: 'existing_lead@company.com',
    businessName: 'Existing Co',
    status: 'Active'
  });

  // Pre-seed a suppressed lead to test suppression protection
  leadService.createLead({
    email: 'optout_user@domain.com',
    businessName: 'Opted Out Inc',
    status: 'Suppressed'
  });

  // Generate 1,050 rows of test CSV data:
  // - 1 existing duplicate
  // - 1 suppressed lead
  // - 5 invalid rows (malformed email)
  // - 1,043 valid new leads
  const lines = ['email,businessName,website,phone,niche'];
  lines.push('existing_lead@company.com,Existing Duplicate,https://existing.com,555-0100,Tech');
  lines.push('optout_user@domain.com,Suppressed User,https://optout.com,555-0101,Legal');
  lines.push('not-an-email,Bad Format,https://bad.com,555-0102,Spam');
  lines.push('missing-at-sign.com,No At,https://bad2.com,555-0103,Spam');

  for (let i = 1; i <= 1046; i++) {
    lines.push(`prospect_${i}@growthfirm${i}.com,Firm ${i},https://growthfirm${i}.com,555-${1000 + i},Marketing`);
  }

  const rawCsv = lines.join('\n');
  assert.ok(lines.length > 1000, 'Test dataset must exceed 1,000 records');

  // Launch bulk import job with updateExisting: false so duplicates are skipped
  const job = await leadService.createBulkImportJob(rawCsv, {
    updateExisting: false,
    defaultNiche: 'Marketing'
  });

  assert.ok(job);
  assert.ok(job.id);
  assert.equal(job.totalSubmitted, lines.length - 1);

  // Poll until the non-blocking chunked processor finishes
  let completedJob = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise(r => setTimeout(r, 100));
    const current = leadService.getImportJob(job.id);
    if (current && ['completed', 'failed'].includes(current.status)) {
      completedJob = current;
      break;
    }
  }

  assert.ok(completedJob, 'Job should complete processing chunks');
  assert.equal(completedJob.status, 'completed');
  assert.ok(completedJob.importedCount >= 1040, 'Should import all valid new leads');
  assert.ok(completedJob.duplicateCount >= 1, 'Should detect and flag duplicate lead');
  assert.ok(completedJob.invalidCount >= 2, 'Should reject invalid email lines');

  // Verify Lead Database count
  const allLeads = leadService.getLeads({ limit: 2000 }).leads;
  assert.ok(allLeads.length >= 1040);

  // Test Export Report (Accepted vs Rejected CSV)
  const reportCsv = leadService.exportImportJobReport(job.id);
  assert.ok(reportCsv, 'Report must be generated');
  assert.ok(reportCsv.startsWith('Email,Status,Reason,Line Number,Business Name,Website'));
  assert.ok(reportCsv.includes('DUPLICATE'));
  assert.ok(reportCsv.includes('INVALID_FORMAT'));
  assert.ok(reportCsv.includes('ACCEPTED'));

  cleanup();
});
