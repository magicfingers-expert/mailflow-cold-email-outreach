const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const storage = require('../../services/storageService');
const WebsiteAuditorService = require('../../services/websiteAuditorService');

const testAuditsFile = path.join(__dirname, '..', '..', 'data', 'test_audits_unit.json');

function cleanup() {
  storage.deleteFile(testAuditsFile);
}

test('WebsiteAuditorService - SSRF protection blocks forbidden IP ranges and protocols', async (t) => {
  cleanup();
  const auditor = new WebsiteAuditorService({ auditsFile: testAuditsFile, tenantId: 'test_tenant' });

  // 1. Loopback addresses
  await assert.rejects(async () => {
    await auditor.auditUrl('http://127.0.0.1/admin');
  }, /blocked|loopback|private/i);

  await assert.rejects(async () => {
    await auditor.auditUrl('http://localhost:8080');
  }, /blocked|loopback|private/i);

  // 2. Cloud metadata endpoints
  await assert.rejects(async () => {
    await auditor.auditUrl('http://169.254.169.254/latest/meta-data/');
  }, /blocked|metadata|private/i);

  // 3. Private CIDR blocks (RFC 1918)
  await assert.rejects(async () => {
    await auditor.auditUrl('http://10.0.0.5/internal');
  }, /blocked|private/i);

  await assert.rejects(async () => {
    await auditor.auditUrl('http://172.16.1.100/');
  }, /blocked|private/i);

  await assert.rejects(async () => {
    await auditor.auditUrl('http://192.168.1.1/');
  }, /blocked|private/i);

  // 4. IPv4-mapped IPv6 loopback
  await assert.rejects(async () => {
    await auditor.auditUrl('http://[::ffff:127.0.0.1]/status');
  }, /blocked|loopback|private/i);

  // 5. Non-HTTP protocols
  await assert.rejects(async () => {
    await auditor.auditUrl('file:///etc/passwd');
  }, /protocol|http/i);

  await assert.rejects(async () => {
    await auditor.auditUrl('ftp://ftp.example.com/test');
  }, /protocol|http/i);
});

test('WebsiteAuditorService - analyzes sample HTML and produces diagnostic scores and findings', () => {
  cleanup();
  const auditor = new WebsiteAuditorService({ auditsFile: testAuditsFile, tenantId: 'test_tenant' });

  // Mock sample unoptimized HTML
  const sampleBadHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Short</title>
        <!-- Missing meta description, missing og:tags, missing viewport -->
      </head>
      <body>
        <p>No H1 tag here.</p>
        <img src="/logo.png"> <!-- Missing alt -->
        <a href="http://insecure.com">Unencrypted Link</a>
      </body>
    </html>
  `;

  const result = auditor.analyzeHtml('https://mybusiness.com', sampleBadHtml, {
    statusCode: 200,
    headers: { 'content-type': 'text/html' },
    responseTimeMs: 350
  });

  assert.ok(result);
  assert.equal(result.url, 'https://mybusiness.com');
  assert.ok(result.score < 90, 'Score should be penalized for missing description, H1, viewport, alt tags');
  assert.ok(Array.isArray(result.findings), 'Findings must be an array');
  assert.ok(result.findings.length > 0, 'Should detect multiple issues');

  // Verify findings categories
  const categories = new Set(result.findings.map(f => f.category));
  assert.ok(categories.has('SEO') || categories.has('Technical') || categories.has('Quality'));

  // Verify pitch snippet generation
  assert.ok(result.pitchSnippet, 'Pitch snippet must be generated');
  assert.ok(result.pitchSnippet.length > 20, 'Pitch snippet should be a substantive outreach pitch');

  // Verify findings severity levels
  const severities = result.findings.map(f => f.severity);
  assert.ok(severities.includes('Critical') || severities.includes('High') || severities.includes('Medium'));

  // Test storage and retrieval
  auditor.saveAuditResult(result);
  const history = auditor.getAuditHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].url, 'https://mybusiness.com');

  cleanup();
});
