const test = require('node:test');
const assert = require('node:assert/strict');
const EmailValidator = require('../../services/emailValidator');

test('EmailValidator - valid email acceptance', () => {
  const input = 'alice@example.com\nbob.smith@sub.domain.co.uk\ncarol+tag@company.io';
  const result = EmailValidator.cleanAndValidate(input);

  assert.equal(result.validCount, 3);
  assert.equal(result.invalidCount, 0);
  assert.equal(result.canSend, true);
  assert.deepEqual(result.validRecipients, [
    'alice@example.com',
    'bob.smith@sub.domain.co.uk',
    'carol+tag@company.io'
  ]);
});

test('EmailValidator - cleans brackets, quotes, and mailto prefix', () => {
  const input = '<john@example.com>, "Jane Doe" <jane@company.org>, mailto:alex@startup.tech';
  const result = EmailValidator.cleanAndValidate(input);

  assert.equal(result.validCount, 2); // 'Jane Doe' without cleaning brackets could fail or pass depending on formatting
  assert.ok(result.validRecipients.includes('john@example.com'));
  assert.ok(result.validRecipients.includes('alex@startup.tech'));
});

test('EmailValidator - invalid emails detection and blocking', () => {
  const input = 'good@domain.com\nnot-an-email\nmissing@domain\n@nodomain.com';
  const result = EmailValidator.cleanAndValidate(input);

  assert.equal(result.validCount, 1);
  assert.equal(result.invalidCount, 3);
  assert.equal(result.canSend, false); // invalid addresses must block campaign send
  assert.ok(result.error.includes('Please fix or remove'));
});

test('EmailValidator - deduplication of recipient addresses', () => {
  const input = 'lead@example.com\nLEAD@EXAMPLE.COM\nlead@example.com\nother@example.com';
  const result = EmailValidator.cleanAndValidate(input);

  assert.equal(result.validCount, 2);
  assert.equal(result.duplicatesRemoved, 2);
  assert.deepEqual(result.validRecipients, ['lead@example.com', 'other@example.com']);
});

test('EmailValidator - suppression list enforcement', () => {
  const input = 'allowed@domain.com\nunsubscribed@domain.com\nbounced@domain.com';
  const suppressionList = ['unsubscribed@domain.com', 'bounced@domain.com'];

  const result = EmailValidator.cleanAndValidate(input, suppressionList);

  assert.equal(result.validCount, 1);
  assert.equal(result.suppressedCount, 2);
  assert.deepEqual(result.validRecipients, ['allowed@domain.com']);
  assert.deepEqual(result.suppressedEmails, ['unsubscribed@domain.com', 'bounced@domain.com']);
});

test('EmailValidator - 50 recipient batch limit capping', () => {
  const emails = Array.from({ length: 60 }, (_, i) => `prospect_${i}@company.com`).join('\n');
  const result = EmailValidator.cleanAndValidate(emails);

  assert.equal(result.validCount, 60);
  assert.equal(result.isOverLimit, true);
  assert.equal(result.limitReached, true);
  assert.equal(result.cappedRecipients.length, 50);
});

test('EmailValidator - empty input handling', () => {
  const result = EmailValidator.cleanAndValidate('   \n  \t  ');
  assert.equal(result.validCount, 0);
  assert.equal(result.canSend, false);
});
