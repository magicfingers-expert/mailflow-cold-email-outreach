const test = require('node:test');
const assert = require('node:assert/strict');
const LeadService = require('../../services/leadService');

test('Personalization - variable substitution with exact lead fields', () => {
  const template = 'Hi {{name}}, I noticed your work at {{company}}. Can I send info to {{email}}?';
  const lead = {
    email: 'elon@x.com',
    name: 'Elon Musk',
    firstName: 'Elon',
    company: 'X Corp'
  };

  const { text, unresolved } = LeadService.renderTemplate(template, lead);

  assert.equal(text, 'Hi Elon Musk, I noticed your work at X Corp. Can I send info to elon@x.com?');
  assert.equal(unresolved.length, 0);
});

test('Personalization - fallback values when lead fields are missing', () => {
  const template = 'Hello {{firstName|friend}}, hope all is well at {{company|your company}}!';
  const lead = { email: 'anon@domain.com' };

  const { text, unresolved } = LeadService.renderTemplate(template, lead);

  assert.equal(text, 'Hello friend, hope all is well at your company!');
  assert.equal(unresolved.length, 0);
});

test('Personalization - detects and flags unresolved variables', () => {
  const template = 'Hi {{name}}, are you currently using {{crm_software}} in {{region}}?';
  const lead = {
    email: 'pat@example.com',
    name: 'Pat'
  };

  const { text, unresolved } = LeadService.renderTemplate(template, lead);

  assert.ok(unresolved.includes('{{crm_software}}'));
  assert.ok(unresolved.includes('{{region}}'));
  assert.equal(unresolved.length, 2);
});

test('Personalization - supports custom fields from lead object', () => {
  const template = 'Congratulations on {{funding_round}} for {{company}}!';
  const lead = {
    email: 'founder@nextgen.ai',
    name: 'Dana',
    company: 'NextGen AI',
    customFields: {
      funding_round: 'Series A'
    }
  };

  const { text, unresolved } = LeadService.renderTemplate(template, lead);

  assert.equal(text, 'Congratulations on Series A for NextGen AI!');
  assert.equal(unresolved.length, 0);
});

test('Personalization - sender variables substitution', () => {
  const template = 'Best regards,\n{{senderName}}\n{{senderEmail}}';
  const lead = { email: 'client@domain.com' };
  const sender = { name: 'Sarah Jenkins', email: 'sarah@mailflow.io' };

  const { text, unresolved } = LeadService.renderTemplate(template, lead, sender);

  assert.equal(text, 'Best regards,\nSarah Jenkins\nsarah@mailflow.io');
  assert.equal(unresolved.length, 0);
});
