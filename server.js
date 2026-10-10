const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const EmailService = require('./services/emailService');
const EmailValidator = require('./services/emailValidator');
const QueueService = require('./services/queueService');
const InboxService = require('./services/inboxService');
const bounceService = require('./services/bounceService');
const deliverabilityService = require('./services/deliverabilityService');
const storage = require('./services/storageService');

// Global error handlers to prevent crashes from transient socket resets (e.g. ECONNRESET)
process.on('uncaughtException', (err) => {
  console.warn('[Global Uncaught Exception Handled]:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.warn('[Global Unhandled Rejection Handled]:', reason && reason.message ? reason.message : reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Force no caching on all responses to ensure real-time state and no stale assets
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0
}));

// Initialize Core Services
const emailService = new EmailService();
const queueService = new QueueService(emailService);
const inboxService = new InboxService(emailService, queueService);

const DRAFTS_FILE = path.join(__dirname, 'data', 'drafts.json');
const VARIANTS_FILE = path.join(__dirname, 'data', 'saved_variants.json');

// Transparent 1x1 GIF Buffer for Open Tracking
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// ---------------- EMAIL TRACKING ENDPOINTS ----------------

// Tracking Pixel GET endpoint - triggers when recipient opens email
app.get('/api/track/open/:trackingId', (req, res) => {
  const { trackingId } = req.params;
  
  try {
    queueService.recordEmailOpen(trackingId, {
      userAgent: req.headers['user-agent'],
      ip: req.headers['x-forwarded-for'] || req.ip || (req.connection && req.connection.remoteAddress) || '127.0.0.1'
    });
  } catch (err) {
    console.error('Error logging open tracking:', err.message);
  }

  // Return non-cached transparent 1x1 image
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': PIXEL_GIF.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.end(PIXEL_GIF);
});

// Recent Opens API - polled by frontend for real-time live open notifications
app.get('/api/track/recent-opens', (req, res) => {
  const since = parseInt(req.query.since || 0);
  const opens = queueService.getRecentOpens(since);
  res.json({ success: true, opens });
});

// Simulate / Test Open API - Allows instant verification of live notification & audio chime
app.post('/api/track/simulate-open', (req, res) => {
  const { email, subject, trackingId } = req.body;
  const event = queueService.recordEmailOpen(trackingId || `sim-trk-${Date.now()}`, {
    email: email || 'lead.recipient@example.com',
    userAgent: 'Web Browser / Test Simulation',
    ip: req.ip || '127.0.0.1'
  });
  res.json({ success: true, openEvent: event });
});

// ---------------- OUTREACH MESSAGE VARIANTS (1-5 BLANK SLATE) ----------------

const DEFAULT_MESSAGE_VARIANTS = [
  { subject: "", message: "" },
  { subject: "", message: "" },
  { subject: "", message: "" },
  { subject: "", message: "" },
  { subject: "", message: "" }
];

function getSavedVariants() {
  const data = storage.readJSON(VARIANTS_FILE, null);
  if (Array.isArray(data) && data.length >= 5) {
    const hasOldSample = data.some(v => 
      (v?.subject && v.subject.includes('{quick question')) ||
      (v?.message && (v.message.includes('discussing new opportunities') || v.message.includes('Quick question for you')))
    );
    if (!hasOldSample) return data;
  }
  return DEFAULT_MESSAGE_VARIANTS;
}

function saveVariantsToFile(variants) {
  return storage.writeJSON(VARIANTS_FILE, variants);
}

// Get saved message variants (clean blank by default)
app.get('/api/variants', (req, res) => {
  const variants = getSavedVariants();
  res.json({ success: true, variants });
});

// Save all message variants
app.post('/api/variants', (req, res) => {
  const { variants } = req.body || {};
  if (Array.isArray(variants) && variants.length > 0) {
    saveVariantsToFile(variants);
    return res.json({ success: true, message: 'All message variants saved', variants });
  }
  res.status(400).json({ success: false, error: 'Invalid variants data' });
});

// Reset variants to clean blank state
app.post('/api/variants/reset', (req, res) => {
  saveVariantsToFile(DEFAULT_MESSAGE_VARIANTS);
  res.json({ success: true, variants: DEFAULT_MESSAGE_VARIANTS, message: 'Variants reset to blank slots' });
});

// Deprecated templates endpoint - returns empty array
app.get('/api/variants/sample-templates', (req, res) => {
  res.json({ success: true, templates: [] });
});

// Save a single message variant by index (0-4)
app.post('/api/variants/:index', (req, res) => {
  const index = parseInt(req.params.index);
  const { subject, message } = req.body || {};
  const variants = [...getSavedVariants()];
  if (!isNaN(index) && index >= 0 && index < 5) {
    variants[index] = {
      subject: subject !== undefined ? subject : (variants[index]?.subject || ''),
      message: message !== undefined ? message : (variants[index]?.message || '')
    };
    saveVariantsToFile(variants);
    return res.json({ success: true, message: `Message ${index + 1} saved successfully`, variant: variants[index], index });
  }
  res.status(400).json({ success: false, error: 'Invalid variant index' });
});

// Compatibility route for /api/draft - handled in the DRAFTS section below

// ---------------- ACCOUNTS & MULTI-SENDER MANAGEMENT ----------------

// Get all saved sender accounts
app.get('/api/accounts', (req, res) => {
  res.json({ success: true, accounts: emailService.getSafeAccounts() });
});

// Save or add an account
app.post('/api/accounts', async (req, res) => {
  try {
    const { email, password, name, isDefault } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'Valid email address is required' });
    }
    const account = emailService.saveOrUpdateAccount({ email, password, name, isDefault });
    res.json({ success: true, account: { id: account.id, email: account.email, name: account.name, isDefault: account.isDefault } });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Switch active sender account
app.post('/api/accounts/switch/:id', (req, res) => {
  const success = emailService.setDefaultAccount(req.params.id);
  res.json({ success, message: 'Active sender switched' });
});

// Delete sender account
app.delete('/api/accounts/:id', (req, res) => {
  const success = emailService.deleteAccount(req.params.id);
  res.json({ success, message: 'Account removed' });
});

// ---------------- GOOGLE POSTMASTER & DNS DELIVERABILITY AUDIT ----------------

// Run DNS deliverability audit (SPF, DKIM, DMARC, MX, Postmaster compliance)
app.get('/api/deliverability/audit', async (req, res) => {
  const emailOrDomain = req.query.email || req.query.domain || 'gmail.com';
  try {
    const audit = await deliverabilityService.auditDomain(emailOrDomain);
    res.json(audit);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/deliverability/audit', async (req, res) => {
  const { email, domain } = req.body || {};
  const target = email || domain || 'gmail.com';
  try {
    const audit = await deliverabilityService.auditDomain(target);
    res.json(audit);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Google Postmaster Tools & DNS Setup Guide
app.get('/api/deliverability/postmaster-guide', (req, res) => {
  const domain = req.query.domain || 'yourdomain.com';
  res.json({
    success: true,
    domain,
    googlePostmasterUrl: 'https://postmaster.google.com/',
    mxToolboxUrl: `https://mxtoolbox.com/emailhealth/${domain}/`,
    requirements: [
      { name: 'SPF Authentication', status: 'Required', desc: 'Authorizes Google SMTP servers to dispatch from your domain.' },
      { name: 'DKIM 2048-bit Key', status: 'Required', desc: 'Cryptographically signs outgoing emails against spoofing.' },
      { name: 'DMARC Alignment', status: 'Required', desc: 'Specifies mailbox policy (p=none / p=quarantine / p=reject).' },
      { name: 'Spam Rate < 0.10%', status: 'Mandatory', desc: 'Google blocks domains when spam rate exceeds 0.30%.' },
      { name: 'One-Click Unsubscribe', status: 'Enforced', desc: 'MailFlow automatically injects RFC-8058 List-Unsubscribe headers.' },
      { name: 'TLS 1.3 / SSL 465', status: 'Enforced', desc: 'All connections are encrypted over secure sockets.' }
    ]
  });
});

// ---------------- SMTP VERIFICATION & SOCKET DIAGNOSTICS ----------------

// Live Socket Diagnostics (DNS, TCP, TLS 1.3, Auth Handshake)
app.post('/api/smtp/diagnose', async (req, res) => {
  const { email, password, host, port } = req.body;
  try {
    const result = await emailService.diagnoseSmtpSocket({ email, password, host, port });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Direct Ethereal Live Web Mailbox Test Dispatch
app.post('/api/campaigns/test-ethereal', async (req, res) => {
  try {
    const { to, subject, message } = req.body;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const trackingId = `test-eth-${Date.now()}`;

    queueService.registerTestTracking({
      trackingId,
      senderEmail: 'outreach@mailflow.app',
      recipientEmail: (to || 'lead@example.com').trim(),
      subject: subject || 'Test Outreach Email'
    });

    const result = await emailService.sendEtherealTestMail({
      to: (to || 'lead@example.com').trim(),
      subject,
      message,
      trackingId,
      baseUrl
    });

    res.json({
      success: true,
      message: `Test email created and available in live web mailbox!`,
      previewUrl: result.previewUrl,
      trackingId,
      result
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/smtp/verify', async (req, res) => {
  const { email, password, host, port } = req.body;
  const result = await emailService.diagnoseSmtpSocket({ email, password, host, port });
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

// ---------------- RECIPIENTS PARSER & VALIDATOR ----------------

app.post('/api/recipients/parse', (req, res) => {
  const { rawText } = req.body;
  const result = EmailValidator.cleanAndValidate(rawText);
  res.json({ success: true, ...result });
});

// ---------------- CAMPAIGN DISPATCHER & QUEUE ----------------

// Direct Single Test Send to verify inbox receipt in 5 seconds
app.post('/api/campaigns/test-send', async (req, res) => {
  try {
    const { senderEmail, senderPassword, senderName, testRecipient, subject, message, plainTextOnly = true, enableTracking = false } = req.body;
    if (!testRecipient || !testRecipient.includes('@')) {
      return res.status(400).json({ success: false, error: 'Valid test recipient email is required.' });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const trackingId = `test-trk-${Date.now()}`;

    // Register test tracking ID in queueService
    queueService.registerTestTracking({
      trackingId,
      senderEmail: senderEmail || 'sender@outreach.com',
      recipientEmail: testRecipient.trim(),
      subject: subject || 'Test Outreach Email'
    });

    const result = await emailService.sendEmail({
      senderEmail,
      senderPassword,
      senderName,
      to: testRecipient.trim(),
      subject: subject || 'Quick question regarding collaboration',
      message: message || 'Hi,\n\nI came across your work recently and wanted to connect.\n\nBest regards',
      trackingId,
      baseUrl,
      enableTracking: !!enableTracking,
      plainTextOnly: plainTextOnly !== false
    });

    inboxService.recordSentMessage({
      senderEmail: senderEmail || 'sender@outreach.com',
      to: testRecipient.trim(),
      subject: subject || 'Test Outreach Email',
      message: message || 'Hi,\n\nI came across your work recently and wanted to connect.\n\nBest regards',
      trackingId
    });

    res.json({
      success: true,
      message: `Test email sent directly to ${testRecipient} from ${senderEmail}`,
      trackingId,
      testOpenUrl: `${baseUrl}/api/track/open/${trackingId}`,
      result
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Launch Direct Outreach Campaign
app.post('/api/campaigns/send-direct', async (req, res) => {
  try {
    const {
      senderEmail,
      senderPassword,
      senderName,
      subject,
      message,
      messageVariants = [],
      rawRecipients,
      delaySeconds = 60,
      plainTextOnly = true,
      enableTracking = false
    } = req.body;

    if (senderEmail && senderPassword) {
      emailService.saveOrUpdateAccount({
        email: senderEmail,
        password: senderPassword,
        name: senderName,
        isDefault: true
      });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const result = await queueService.startDirectCampaign({
      senderEmail,
      senderPassword,
      senderName,
      subject,
      message,
      messageVariants,
      rawRecipients,
      delaySeconds: parseInt(delaySeconds) || 60,
      plainTextOnly: plainTextOnly !== false,
      enableTracking: !!enableTracking,
      baseUrl
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get Live Campaign Status & Live Countdown Timer
app.get('/api/campaigns/:id/status', (req, res) => {
  const status = queueService.getCampaignStatus(req.params.id);
  if (!status) return res.status(404).json({ success: false, error: 'Campaign not found' });
  res.json({ success: true, ...status });
});

// Pause Campaign
app.post('/api/campaigns/:id/pause', (req, res) => {
  const result = queueService.pauseCampaign(req.params.id);
  res.json(result);
});

// Stop Campaign
app.post('/api/campaigns/:id/stop', (req, res) => {
  const result = queueService.stopCampaign(req.params.id);
  res.json(result);
});

// Get Campaigns History
app.get('/api/campaigns', (req, res) => {
  res.json({ success: true, campaigns: queueService.getCampaigns() });
});

// Delete Campaign from History
app.delete('/api/campaigns/:id', (req, res) => {
  const result = queueService.deleteCampaign(req.params.id);
  res.json(result);
});

// Clear All History
app.delete('/api/campaigns', (req, res) => {
  const result = queueService.clearAllCampaigns();
  res.json(result);
});

// Get Stats
app.get('/api/stats', (req, res) => {
  res.json({ success: true, stats: queueService.getStats() });
});

// ---------------- UNIFIED INBOX & REPLY ENGINE ----------------

// Get Inbox / Sent / Spam Messages (cached with live filter & search)
app.get('/api/inbox', (req, res) => {
  const { search, folder, accountEmail, limit } = req.query;
  const data = inboxService.getMessages({ 
    search, 
    folder: folder || 'all', 
    accountEmail: accountEmail || '', 
    limit: parseInt(limit) || 100 
  });
  res.json({ success: true, ...data });
});

// Trigger Live IMAP sync for a specific account and folder
app.post('/api/inbox/sync', async (req, res) => {
  try {
    const { email, password, folder } = req.body || {};
    const result = await inboxService.syncGmailAccount({ 
      email, 
      password, 
      folder: folder || 'INBOX', 
      maxFetch: 30 
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trigger Live IMAP sync across ALL connected accounts
app.post('/api/inbox/sync-all', async (req, res) => {
  try {
    const { folder = 'ALL' } = req.body || {};
    const result = await inboxService.syncAllAccounts({ folder });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rescue a message from Spam to Primary Inbox
app.post('/api/inbox/rescue/:uid', (req, res) => {
  const result = inboxService.rescueSpamMessage(req.params.uid);
  res.json(result);
});

// Get single message detail
app.get('/api/inbox/:uid', (req, res) => {
  const msg = inboxService.getMessageByUid(req.params.uid);
  if (!msg) return res.status(404).json({ success: false, error: 'Message not found' });
  inboxService.markAsRead(req.params.uid);
  res.json({ success: true, message: msg });
});

// Mark message as read
app.post('/api/inbox/mark-read/:uid', (req, res) => {
  const ok = inboxService.markAsRead(req.params.uid);
  res.json({ success: ok });
});

// Delete message from inbox cache
app.delete('/api/inbox/:uid', (req, res) => {
  const ok = inboxService.deleteMessage(req.params.uid);
  res.json({ success: ok });
});

// ---------------- BOUNCED LEADS & SUPPRESSION ENGINE ----------------

// Get Bounced Leads & Statistics
app.get('/api/bounces', (req, res) => {
  const { search, bounceType, accountEmail, limit } = req.query;
  const result = bounceService.getBounces({
    search,
    bounceType,
    accountEmail,
    limit: parseInt(limit) || 100
  });
  res.json({ success: true, ...result });
});

// Fast stats endpoint for auto-sync polling
app.get('/api/bounces/stats', (req, res) => {
  const result = bounceService.getBounces({ limit: 1 });
  res.json({ 
    success: true, 
    total: result.total, 
    stats: result.stats,
    suppressionCount: result.suppressedCount 
  });
});

// Delete / Remove a Bounced Lead
app.delete('/api/bounces/:id', (req, res) => {
  const success = bounceService.deleteBounce(req.params.id);
  res.json({ success, message: 'Bounced lead removed' });
});

// Clear All Bounces History
app.delete('/api/bounces', (req, res) => {
  const success = bounceService.clearAllBounces();
  res.json({ success, message: 'Bounce history cleared' });
});

// Simulate Test Bounce for Verification
app.post('/api/bounces/simulate', (req, res) => {
  const { email, recipientEmail, senderEmail, reason, bounceType, category } = req.body || {};
  const testBounce = bounceService.recordBounce({
    email: email || recipientEmail || 'invalid.mailbox@nonexistent-domain.xyz',
    senderEmail: senderEmail || 'sender@example.com',
    subject: 'Outreach Campaign inquiry',
    reason: reason || '550 5.1.1 The email account that you tried to reach does not exist.',
    bounceType: bounceType || category || 'Hard Bounce (User Unknown - 550)',
    diagnosticCode: '550 5.1.1'
  });
  res.json({ success: true, bounce: testBounce });
});

// Send direct reply to a lead from the inbox and record in SENT
app.post('/api/inbox/reply', async (req, res) => {
  try {
    const { to, subject, message, senderEmail, inReplyTo, references } = req.body;
    if (!to || !to.includes('@')) {
      return res.status(400).json({ success: false, error: 'Recipient address is required.' });
    }
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, error: 'Reply message cannot be empty.' });
    }

    let defaultAcc = null;
    if (senderEmail && senderEmail.includes('@')) {
      defaultAcc = emailService.accounts.find(a => a.email && a.email.toLowerCase() === senderEmail.toLowerCase().trim());
    }
    if (!defaultAcc) {
      defaultAcc = emailService.accounts.find(a => a.isDefault) || emailService.accounts[0];
    }

    if (!defaultAcc || !defaultAcc.email || !defaultAcc.password) {
      return res.status(400).json({ success: false, error: 'No active Gmail sender account connected.' });
    }

    const replySubject = (subject && subject.toLowerCase().startsWith('re:')) ? subject : `Re: ${subject || 'Outreach'}`;

    const sendResult = await emailService.sendEmail({
      senderEmail: defaultAcc.email,
      senderPassword: defaultAcc.password,
      senderName: defaultAcc.name || 'Sales Partner',
      to,
      subject: replySubject,
      message,
      inReplyTo,
      references
    });

    // Record in SENT cache
    inboxService.recordSentMessage({
      senderEmail: defaultAcc.email,
      to,
      subject: replySubject,
      message
    });

    res.json({
      success: true,
      message: `Reply sent directly to ${to}`,
      sendResult
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- DRAFTS ----------------

app.get('/api/draft', (req, res) => {
  const variants = getSavedVariants();
  const draft = storage.readJSON(DRAFTS_FILE, null);
  if (draft && draft.subject) return res.json({ success: true, draft });
  res.json({ success: true, draft: variants[0] || { subject: '', message: '' } });
});

app.post('/api/draft', (req, res) => {
  const { subject, message } = req.body;
  const draftData = { subject, message, updatedAt: new Date().toISOString() };
  storage.writeJSON(DRAFTS_FILE, draftData);
  res.json({ success: true, message: 'Draft saved' });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 MailFlow Outreach Server Running at: http://localhost:${PORT}`);
    console.log(`👁️ Live Email Open Tracker & Notification Engine: Active`);
    console.log(`====================================================`);
  });
}

module.exports = app;
