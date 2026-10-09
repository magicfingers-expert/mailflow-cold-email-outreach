const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const EmailService = require('./services/emailService');
const EmailValidator = require('./services/emailValidator');
const QueueService = require('./services/queueService');
const InboxService = require('./services/inboxService');
const bounceService = require('./services/bounceService');

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
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Core Services
const emailService = new EmailService();
const queueService = new QueueService(emailService);
const inboxService = new InboxService(emailService, queueService);

const DRAFTS_FILE = path.join(__dirname, 'data', 'drafts.json');

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

// ---------------- OUTREACH MESSAGE VARIANTS & TEMPLATES (1-5) ----------------

const VARIANTS_FILE = path.join(__dirname, 'data', 'saved_variants.json');

const DEFAULT_MESSAGE_VARIANTS = [
  {
    subject: "{quick question|quick thought|intro|hey}",
    message: "{Hi|Hey|Hello} {{email}},\n\n{Quick question for you — are you open to discussing new opportunities this month?|I came across your profile and wanted to reach out with a brief question.|Just wanted to reach out directly with a quick note.}\n\n{Would you be open to a quick 2-minute chat sometime this week?|Let me know if you might be free for a brief 2-minute call this week.}\n\n{Best|Thanks|Best regards},\nThomas"
  },
  {
    subject: "{question regarding your workflow|quick inquiry for {{email}}|partnership inquiry}",
    message: "{Hi|Hello|Hey} {{email}},\n\n{I was exploring your work recently and wanted to see how you are currently handling client acquisition this quarter.|Hope you are having a productive week — wanted to ask a quick question about your current operations.}\n\n{We recently built a system that helps streamline outreach seamlessly. Would you be open to seeing a 1-minute breakdown?|If you're interested, happy to share a brief note on how we help similar teams.}\n\n{Cheers|Warmly|Regards},\nThomas"
  },
  {
    subject: "{quick intro|connecting briefly|reaching out to {{email}}}",
    message: "{Hey|Hi} {{email}},\n\n{Are you currently taking on new projects or clients this month?|Just checking in to see if you have any availability for new collaboration this month.}\n\n{If so, let me know when might be a convenient time to connect briefly.|Let me know if you'd be open to a brief exchange.}\n\n{Best|Thanks|All the best},\nThomas"
  },
  {
    subject: "{quick question for {{email}}|seeking your perspective|brief question}",
    message: "{Hi|Hello} {{email}},\n\n{I came across your recent work and really admired what you are building.|I've been following your progress and wanted to ask a quick question.}\n\n{Are you open to exploring fresh ways to scale your outreach without ending up in spam?|Would you be open to a 2-minute chat to share perspectives?}\n\n{Best regards|Thanks|Warm regards},\nThomas"
  },
  {
    subject: "{hello from Thomas|checking in with {{email}}|quick hello}",
    message: "{Hey|Hi|Hello} {{email}},\n\n{Hope everything is going smoothly with you.|Wanted to drop a quick personal note to see if you are exploring new growth channels this quarter.}\n\n{If you're open to a 2-minute discussion, let me know what day works best for you.|Feel free to let me know if you'd like to chat briefly.}\n\n{Have a great week|Best|Warmly},\nThomas"
  }
];

function getSavedVariants() {
  if (fs.existsSync(VARIANTS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(VARIANTS_FILE, 'utf8'));
      if (Array.isArray(data) && data.length > 0) return data;
    } catch (e) {}
  }
  return DEFAULT_MESSAGE_VARIANTS;
}

function saveVariantsToFile(variants) {
  try {
    fs.writeFileSync(VARIANTS_FILE, JSON.stringify(variants, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Error saving variants file:', e.message);
    return false;
  }
}

// Get saved message variants
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

// Reset variants to default
app.post('/api/variants/reset', (req, res) => {
  saveVariantsToFile(DEFAULT_MESSAGE_VARIANTS);
  res.json({ success: true, variants: DEFAULT_MESSAGE_VARIANTS, message: 'Variants reset to defaults' });
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

// Compatibility route for /api/draft
app.get('/api/draft', (req, res) => {
  const variants = getSavedVariants();
  res.json({ success: true, draft: variants[0] });
});

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
      recipientEmail: (to || 'thomashammed3@gmail.com').trim(),
      subject: subject || 'Test Outreach Email'
    });

    const result = await emailService.sendEtherealTestMail({
      to: (to || 'thomashammed3@gmail.com').trim(),
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
    senderEmail: senderEmail || 'alexawixpartner@gmail.com',
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
  let draft = {
    subject: 'Partnership Opportunity',
    message: 'Hi,\n\nI noticed your recent work and wanted to reach out regarding a potential collaboration.\nI would love to discuss how we can work together.\n\nBest regards'
  };
  if (fs.existsSync(DRAFTS_FILE)) {
    try { draft = JSON.parse(fs.readFileSync(DRAFTS_FILE, 'utf8')); } catch (e) {}
  }
  res.json({ success: true, draft });
});

app.post('/api/draft', (req, res) => {
  const { subject, message } = req.body;
  try {
    fs.writeFileSync(DRAFTS_FILE, JSON.stringify({ subject, message, updatedAt: new Date().toISOString() }, null, 2));
    res.json({ success: true, message: 'Draft saved' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to save draft' });
  }
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
