const test = require('node:test');
const assert = require('node:assert/strict');
const deliverabilityService = require('../../services/deliverabilityService');

test('deliverabilityService - live DNS audit on gmail.com returns real records and passes', async () => {
  const audit = await deliverabilityService.auditDomain('gmail.com');

  assert.equal(audit.domain, 'gmail.com');
  assert.equal(audit.isGmail, true);
  assert.equal(typeof audit.score, 'number');
  assert.ok(audit.score >= 80, `Expected score >= 80, got ${audit.score}`);

  // SPF check
  assert.equal(audit.checks.spf.status, 'pass');
  assert.ok(audit.checks.spf.value.includes('v=spf1'), 'SPF record must contain v=spf1');
  assert.ok(audit.checks.spf.value.includes('_spf.google.com') || audit.checks.spf.value.includes('redirect='), 'SPF record must reference Google SPF');

  // MX check
  assert.equal(audit.checks.mx.status, 'pass');
  assert.ok(Array.isArray(audit.checks.mx.records), 'MX records must be an array');
  assert.ok(audit.checks.mx.records.length > 0, 'Must have at least one MX record');
  assert.ok(audit.checks.mx.records.some(r => r.includes('google.com')), 'MX must point to Google servers');
  assert.equal(audit.checks.mx.isGoogleMx, true, 'isGoogleMx flag must be true');

  // DMARC check
  assert.equal(audit.checks.dmarc.status, 'pass');
  assert.ok(audit.checks.dmarc.value.includes('v=DMARC1'), 'DMARC record must contain v=DMARC1');
  assert.ok(['none', 'quarantine', 'reject'].includes(audit.checks.dmarc.policy), 'DMARC policy must be parsed');

  // DKIM check (Google uses selector 20230601)
  assert.equal(audit.checks.dkim.status, 'pass');
  assert.ok(audit.checks.dkim.selector, 'DKIM selector must be found');
  assert.ok(audit.checks.dkim.value.includes('v=DKIM1') || audit.checks.dkim.value.includes('p='), 'DKIM record must contain public key or DKIM1');
});

test('deliverabilityService - handles domain without DNS records gracefully', async () => {
  const audit = await deliverabilityService.auditDomain('this-is-a-definitely-nonexistent-domain-123456789.org');

  assert.equal(audit.domain, 'this-is-a-definitely-nonexistent-domain-123456789.org');
  assert.equal(audit.isGmail, false);
  assert.equal(audit.checks.spf.status, 'missing');
  assert.equal(audit.checks.mx.status, 'warning');
  assert.equal(audit.checks.dmarc.status, 'missing');
  assert.ok(audit.score <= 40, `Expected failing score <= 40, got ${audit.score}`);
});

test('deliverabilityService - auditDomain with email address extracts domain accurately', async () => {
  const audit = await deliverabilityService.auditDomain('founder@gmail.com');
  assert.equal(audit.domain, 'gmail.com');
  assert.equal(audit.isGmail, true);
});
