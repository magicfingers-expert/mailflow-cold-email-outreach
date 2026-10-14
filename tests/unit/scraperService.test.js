const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const storage = require('../../services/storageService');
const ScraperService = require('../../services/scraperService');
const LeadService = require('../../services/leadService');

const testJobsFile = path.join(__dirname, '..', '..', 'data', 'test_scraper_jobs_unit.json');
const testLeadsFile = path.join(__dirname, '..', '..', 'data', 'test_scraper_leads_unit.json');

function cleanup() {
  [testJobsFile, testLeadsFile].forEach(f => {
    storage.deleteFile(f);
  });
}

test('ScraperService - creates, executes, pauses, resumes, and cancels jobs', async () => {
  cleanup();
  const leadService = new LeadService({ leadsFile: testLeadsFile, tenantId: 'test_tenant' });
  const scraper = new ScraperService({ jobsFile: testJobsFile, tenantId: 'test_tenant', leadService });

  // 1. Create a job
  const job = scraper.createJob({
    niche: 'Dental clinic',
    location: 'Austin, TX',
    source: 'directory',
    maxResults: 15
  });

  assert.ok(job);
  assert.ok(job.id);
  assert.equal(job.niche, 'Dental clinic');
  assert.equal(job.location, 'Austin, TX');
  assert.ok(['Queued', 'pending'].includes(job.status));

  // 2. Start job
  const startedJob = await scraper.startJob(job.id);
  assert.ok(['Running', 'Completed', 'running', 'completed'].includes(startedJob.status));

  // Wait briefly for asynchronous steps to populate
  await new Promise(r => setTimeout(r, 200));

  const refreshedJob = scraper.getJob(job.id);
  assert.ok(Array.isArray(refreshedJob.leads));
  assert.ok(refreshedJob.leads.length > 0, 'Job should discover directory leads');

  // 3. Verify lead structure
  const firstLead = refreshedJob.leads[0];
  assert.ok(firstLead.businessName);
  assert.ok(firstLead.city);
  assert.ok(firstLead.website);

  // 4. Test Deduplication: adding duplicate lead should be skipped
  const duplicateLead = { ...firstLead };
  const prevCount = refreshedJob.leads.length;
  refreshedJob.leads.push(duplicateLead);
  // Service's deduplication logic
  const uniqueLeads = scraper._deduplicateLeads(refreshedJob.leads);
  assert.equal(uniqueLeads.length, prevCount);

  // 5. Test Pause, Resume, Cancel lifecycle states
  const job2 = scraper.createJob({ niche: 'HVAC', location: 'Miami, FL', maxResults: 10 });
  job2.status = 'Running';
  scraper.saveJobs();

  const paused = scraper.pauseJob(job2.id);
  assert.equal(paused.status, 'Paused');

  const resumed = scraper.resumeJob(job2.id);
  assert.ok(['Running', 'Completed'].includes(resumed.status));

  const cancelled = scraper.cancelJob(job2.id);
  assert.equal(cancelled.status, 'Cancelled');

  // 6. Test CSV Export format
  const csvContent = scraper.exportCsv(job.id);
  assert.ok(csvContent.startsWith('Business Name,Website,Email,Phone,Category,City,Location,Verification Status'));
  assert.ok(csvContent.includes(firstLead.businessName));

  // 7. Test Save to Database
  const saveResult = scraper.saveLeadsToDatabase(job.id);
  assert.ok(saveResult.savedCount > 0, 'Leads should be successfully saved to LeadService');

  const dbLeads = leadService.getLeads().leads;
  assert.ok(dbLeads.length > 0);
  assert.ok(dbLeads.some(l => l.email === firstLead.email || l.businessName === firstLead.businessName));

  cleanup();
});
