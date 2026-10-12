const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const EmailValidator = require('./services/emailValidator');
const deliverabilityService = require('./services/deliverabilityService');
const tenantManager = require('./services/tenantManager');
const { tenantContextMiddleware, requireAuth, requireTenantRole } = require('./services/tenantMiddleware');
const AuthService = require('./services/authService');
const db = require('./services/db');

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

// Apply Multi-Tenant Context Middleware to all routes
app.use(tenantContextMiddleware);

// Transparent 1x1 GIF Buffer for Open Tracking
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// ---------------- AUTHENTICATION & MULTI-TENANT WORKSPACE APIS ----------------

// Register new user + create isolated primary workspace
app.post('/api/auth/register', (req, res) => {
  try {
    const { name, email, password, workspaceName } = req.body || {};
    const result = AuthService.register({ name, email, password, workspaceName });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Login user + return accessible tenants
app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = AuthService.login({ email, password });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Current user profile & accessible workspaces
app.get('/api/auth/me', (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-session-token'];
  const result = AuthService.getMe(token);
  if (!result) {
    const activeTenant = db.findTenantById(req.tenantId) || db.ensureDefaultTenant();
    return res.json({
      success: true,
      authenticated: false,
      user: null,
      activeTenant,
      tenants: [activeTenant]
    });
  }
  res.json({ success: true, authenticated: true, ...result });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-session-token'];
  AuthService.logout(token);
  res.json({ success: true, message: 'Signed out successfully' });
});

// List all workspaces for the current user/session
app.get('/api/tenants', (req, res) => {
  if (req.user) {
    const tenants = db.getTenantsByUserId(req.user.id);
    return res.json({ success: true, tenants, activeTenantId: req.tenantId });
  }
  const defaultTenant = db.findTenantById(req.tenantId) || db.ensureDefaultTenant();
  res.json({ success: true, tenants: [defaultTenant], activeTenantId: req.tenantId });
});

// Create new isolated workspace
app.post('/api/tenants', (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Workspace name is required.' });
    }
    const userId = req.user ? req.user.id : null;
    const tenant = db.createTenant({ name: name.trim(), owner_id: userId });
    tenantManager.getTenantServices(tenant.id);
    res.json({ success: true, tenant, message: `Workspace "${tenant.name}" created successfully` });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Switch active workspace
app.post('/api/tenants/switch/:id', (req, res) => {
  try {
    const targetId = req.params.id;
    if (req.user) {
      const token = req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-session-token'];
      const result = AuthService.switchTenant(req.user.id, token, targetId);
      return res.json({ success: true, activeTenant: result.activeTenant, message: 'Switched workspace' });
    }
    const tenant = db.findTenantById(targetId) || db.createTenant({ id: targetId, name: 'Workspace ' + targetId });
    tenantManager.getTenantServices(tenant.id);
    res.json({ success: true, activeTenant: tenant, message: 'Switched workspace' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Current workspace details and members list
app.get('/api/tenants/current', (req, res) => {
  const members = db.getTenantMembers(req.tenantId);
  res.json({
    success: true,
    tenant: req.tenant,
    role: req.tenantRole,
    members
  });
});

// Invite member to workspace
app.post('/api/tenants/members', (req, res) => {
  try {
    const { email, role } = req.body || {};
    if (req.user && req.tenantRole !== 'owner' && req.tenantRole !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only workspace owners or admins can invite members.' });
    }
    const inviterId = req.user ? req.user.id : 'usr-default';
    const member = AuthService.inviteMember(req.tenantId, inviterId, { email, role });
    res.json({ success: true, member, message: `Invited ${email} to workspace` });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Remove member from workspace
app.delete('/api/tenants/members/:userId', (req, res) => {
  try {
    if (req.user && req.tenantRole !== 'owner') {
      return res.status(403).json({ success: false, error: 'Only the workspace owner can remove members.' });
    }
    const ok = db.removeTenantMember(req.tenantId, req.params.userId);
    res.json({ success: ok, message: 'Member removed from workspace' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ---------------- EMAIL TRACKING ENDPOINTS (CROSS-TENANT DISPATCH) ----------------

// Tracking Pixel GET endpoint - triggers when recipient opens email
// Automatically resolves the originating tenant and records isolated open event
app.get('/api/track/open/:trackingId', (req, res) => {
  const { trackingId } = req.params;
  
  try {
    tenantManager.handleEmailOpen(trackingId, {
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

// Recent Opens API - polled by frontend for real-time live open notifications (Scoped to Active Tenant)
app.get('/api/track/recent-opens', (req, res) => {
  const since = parseInt(req.query.since || 0);
  const opens = req.tenantServices.queueService.getRecentOpens(since);
  res.json({ success: true, opens, serverTime: Date.now(), tenantId: req.tenantId });
});

// Simulate / Test Open API - Allows instant verification of live notification & audio chime
app.post('/api/track/simulate-open', (req, res) => {
  const { email, subject, trackingId, campaignId } = req.body;
  const event = req.tenantServices.queueService.recordEmailOpen(trackingId || `test_${req.tenantId}_${Date.now()}`, {
    email: email || 'lead.recipient@example.com',
    subject: subject || 'Outreach Email',
    campaignId: campaignId || 'general',
    userAgent: 'Web Browser / Test Simulation',
    ip: req.ip || '127.0.0.1'
  });
  res.json({ success: true, openEvent: event, tenantId: req.tenantId });
});

// ---------------- OUTREACH MESSAGE VARIANTS (1-5 BLANK SLATE - TENANT ISOLATED) ----------------

const DEFAULT_MESSAGE_VARIANTS = [
  { subject: "", message: "" },
  { subject: "", message: "" },
  { subject: "", message: "" },
  { subject: "", message: "" },
  { subject: "", message: "" }
];

// Get saved message variants for active workspace
app.get('/api/variants', (req, res) => {
  const variants = req.tenantServices.getVariants();
  res.json({ success: true, variants, tenantId: req.tenantId });
});

// Save all message variants for active workspace
app.post('/api/variants', (req, res) => {
  const { variants } = req.body || {};
  if (Array.isArray(variants) && variants.length > 0) {
    req.tenantServices.saveVariants(variants);
    return res.json({ success: true, message: 'All message variants saved', variants, tenantId: req.tenantId });
  }
  res.status(400).json({ success: false, error: 'Invalid variants data' });
});

// Reset variants to clean blank state
app.post('/api/variants/reset', (req, res) => {
  req.tenantServices.saveVariants(DEFAULT_MESSAGE_VARIANTS);
  res.json({ success: true, variants: DEFAULT_MESSAGE_VARIANTS, message: 'Variants reset to blank slots', tenantId: req.tenantId });
});

// Deprecated templates endpoint - returns empty array
app.get('/api/variants/sample-templates', (req, res) => {
  res.json({ success: true, templates: [] });
});

// Save a single message variant by index (0-4)
app.post('/api/variants/:index', (req, res) => {
  const index = parseInt(req.params.index);
  const { subject, message } = req.body || {};
  const updated = req.tenantServices.saveVariantAtIndex(index, subject, message);
  if (updated) {
    return res.json({ success: true, message: `Message ${index + 1} saved successfully`, variant: updated, index, tenantId: req.tenantId });
  }
  res.status(400).json({ success: false, error: 'Invalid variant index' });
});

// ---------------- ACCOUNTS & MULTI-SENDER MANAGEMENT (TENANT ISOLATED) ----------------

// Get all saved sender accounts for active workspace
app.get('/api/accounts', (req, res) => {
  res.json({
    success: true,
    accounts: req.tenantServices.emailService.getSafeAccounts(),
    tenantId: req.tenantId
  });
});

// Save or add an account to active workspace
app.post('/api/accounts', async (req, res) => {
  try {
    const { email, password, name, isDefault } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'Valid email address is required' });
    }
    const account = req.tenantServices.emailService.saveOrUpdateAccount({ email, password, name, isDefault });
    res.json({
      success: true,
      account: { id: account.id, email: account.email, name: account.name, isDefault: account.isDefault },
      tenantId: req.tenantId
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Switch active sender account within active workspace
app.post('/api/accounts/switch/:id', (req, res) => {
  const success = req.tenantServices.emailService.setDefaultAccount(req.params.id);
  res.json({ success, message: 'Active sender switched', tenantId: req.tenantId });
});

// Delete sender account from active workspace
app.delete('/api/accounts/:id', (req, res) => {
  const success = req.tenantServices.emailService.deleteAccount(req.params.id);
  res.json({ success, message: 'Account removed', tenantId: req.tenantId });
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
    const result = await req.tenantServices.emailService.diagnoseSmtpSocket({ email, password, host, port });
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
    const trackingId = `test_${req.tenantId}_${Date.now()}`;

    req.tenantServices.queueService.registerTestTracking({
      trackingId,
      senderEmail: 'outreach@mailflow.app',
      recipientEmail: (to || 'lead@example.com').trim(),
      subject: subject || 'Test Outreach Email'
    });

    const result = await req.tenantServices.emailService.sendEtherealTestMail({
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
      result,
      tenantId: req.tenantId
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/smtp/verify', async (req, res) => {
  const { email, password, host, port } = req.body;
  const result = await req.tenantServices.emailService.diagnoseSmtpSocket({ email, password, host, port });
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

// ---------------- IMAGE UPLOADER FOR COMPOSER ----------------

app.post('/api/upload-image', (req, res) => {
  try {
    const { imageBase64, filename } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ success: false, error: 'No image data provided.' });
    }

    const matches = imageBase64.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
    let ext = 'png';
    let base64Data = imageBase64;

    if (matches && matches.length === 3) {
      ext = matches[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg');
      base64Data = matches[2];
    } else if (filename && filename.includes('.')) {
      ext = filename.split('.').pop().toLowerCase();
    }

    const allowedExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
    if (!allowedExts.includes(ext.toLowerCase())) {
      ext = 'png';
    }

    const uploadsDir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const safeBaseName = (filename || 'img')
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 30) || 'image';

    const uniqueFileName = `${safeBaseName}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}.${ext}`;
    const filePath = path.join(uploadsDir, uniqueFileName);

    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(filePath, buffer);

    const host = req.get('host') || 'localhost:3000';
    const protocol = req.protocol || 'http';
    const baseUrl = process.env.BASE_URL || `${protocol}://${host}`;
    const fullUrl = `${baseUrl}/uploads/${uniqueFileName}`;
    const relativeUrl = `/uploads/${uniqueFileName}`;

    res.json({
      success: true,
      url: fullUrl,
      relativeUrl,
      filename: uniqueFileName,
      size: buffer.length
    });
  } catch (err) {
    console.error('Image upload error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- CAMPAIGN DISPATCHER & QUEUE (TENANT ISOLATED) ----------------

// Direct Single Test Send to verify inbox receipt in 5 seconds
app.post('/api/campaigns/test-send', async (req, res) => {
  try {
    const { senderEmail, senderPassword, senderName, testRecipient, subject, message, plainTextOnly = true, enableTracking = true } = req.body;
    if (!testRecipient || !testRecipient.includes('@')) {
      return res.status(400).json({ success: false, error: 'Valid test recipient email is required.' });
    }

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const trackingId = `test_${req.tenantId}_${Date.now()}`;

    // Register test tracking ID in tenant queueService
    req.tenantServices.queueService.registerTestTracking({
      trackingId,
      senderEmail: senderEmail || 'sender@outreach.com',
      recipientEmail: testRecipient.trim(),
      subject: subject || 'Test Outreach Email'
    });

    const result = await req.tenantServices.emailService.sendEmail({
      senderEmail,
      senderPassword,
      senderName,
      to: testRecipient.trim(),
      subject: subject || 'Quick question regarding collaboration',
      message: message || 'Hi,\n\nI came across your work recently and wanted to connect.\n\nBest regards',
      trackingId,
      baseUrl,
      enableTracking: enableTracking !== false,
      plainTextOnly: plainTextOnly !== false
    });

    req.tenantServices.inboxService.recordSentMessage({
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
      result,
      tenantId: req.tenantId
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Launch Direct Outreach Campaign for Active Workspace
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
      enableTracking = true
    } = req.body;

    if (senderEmail && senderPassword) {
      req.tenantServices.emailService.saveOrUpdateAccount({
        email: senderEmail,
        password: senderPassword,
        name: senderName,
        isDefault: true
      });
    }

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

    const result = await req.tenantServices.queueService.startDirectCampaign({
      senderEmail,
      senderPassword,
      senderName,
      subject,
      message,
      messageVariants,
      rawRecipients,
      delaySeconds: parseInt(delaySeconds) || 60,
      plainTextOnly: plainTextOnly !== false,
      enableTracking: enableTracking !== false,
      baseUrl
    });

    res.json({ ...result, tenantId: req.tenantId });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get Live Campaign Status & Live Countdown Timer (Active Workspace)
app.get('/api/campaigns/:id/status', (req, res) => {
  const status = req.tenantServices.queueService.getCampaignStatus(req.params.id);
  if (!status) return res.status(404).json({ success: false, error: 'Campaign not found' });
  res.json({ success: true, ...status, tenantId: req.tenantId });
});

// Pause Campaign
app.post('/api/campaigns/:id/pause', (req, res) => {
  const result = req.tenantServices.queueService.pauseCampaign(req.params.id);
  res.json({ ...result, tenantId: req.tenantId });
});

// Stop Campaign
app.post('/api/campaigns/:id/stop', (req, res) => {
  const result = req.tenantServices.queueService.stopCampaign(req.params.id);
  res.json({ ...result, tenantId: req.tenantId });
});

// Get Campaigns History for Active Workspace
app.get('/api/campaigns', (req, res) => {
  res.json({ success: true, campaigns: req.tenantServices.queueService.getCampaigns(), tenantId: req.tenantId });
});

// Delete Campaign from History
app.delete('/api/campaigns/:id', (req, res) => {
  const result = req.tenantServices.queueService.deleteCampaign(req.params.id);
  res.json({ ...result, tenantId: req.tenantId });
});

// Clear All History for Active Workspace
app.delete('/api/campaigns', (req, res) => {
  const result = req.tenantServices.queueService.clearAllCampaigns();
  res.json({ ...result, tenantId: req.tenantId });
});

// Get Stats for Active Workspace
app.get('/api/stats', (req, res) => {
  res.json({ success: true, stats: req.tenantServices.queueService.getStats(), tenantId: req.tenantId });
});

// ---------------- UNIFIED INBOX & REPLY ENGINE (TENANT ISOLATED) ----------------

// Get Inbox / Sent / Spam Messages
app.get('/api/inbox', (req, res) => {
  const { search, folder, accountEmail, limit } = req.query;
  const data = req.tenantServices.inboxService.getMessages({ 
    search, 
    folder: folder || 'all', 
    accountEmail: accountEmail || '', 
    limit: parseInt(limit) || 100 
  });
  res.json({ success: true, ...data, tenantId: req.tenantId });
});

// Trigger Live IMAP sync for a specific account and folder
app.post('/api/inbox/sync', async (req, res) => {
  try {
    const { email, password, folder } = req.body || {};
    const result = await req.tenantServices.inboxService.syncGmailAccount({ 
      email, 
      password, 
      folder: folder || 'INBOX', 
      maxFetch: 30 
    });
    res.json({ ...result, tenantId: req.tenantId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trigger Live IMAP sync across ALL connected accounts for Active Workspace
app.post('/api/inbox/sync-all', async (req, res) => {
  try {
    const { folder = 'ALL' } = req.body || {};
    const result = await req.tenantServices.inboxService.syncAllAccounts({ folder });
    res.json({ ...result, tenantId: req.tenantId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rescue a message from Spam to Primary Inbox
app.post('/api/inbox/rescue/:uid', (req, res) => {
  const result = req.tenantServices.inboxService.rescueSpamMessage(req.params.uid);
  res.json({ ...result, tenantId: req.tenantId });
});

// Get single message detail
app.get('/api/inbox/:uid', (req, res) => {
  const msg = req.tenantServices.inboxService.getMessageByUid(req.params.uid);
  if (!msg) return res.status(404).json({ success: false, error: 'Message not found' });
  req.tenantServices.inboxService.markAsRead(req.params.uid);
  res.json({ success: true, message: msg, tenantId: req.tenantId });
});

// Mark message as read
app.post('/api/inbox/mark-read/:uid', (req, res) => {
  const ok = req.tenantServices.inboxService.markAsRead(req.params.uid);
  res.json({ success: ok, tenantId: req.tenantId });
});

// Delete message from inbox cache
app.delete('/api/inbox/:uid', (req, res) => {
  const ok = req.tenantServices.inboxService.deleteMessage(req.params.uid);
  res.json({ success: ok, tenantId: req.tenantId });
});

// ---------------- BOUNCED LEADS & SUPPRESSION ENGINE (TENANT ISOLATED) ----------------

// Get Bounced Leads & Statistics for Active Workspace
app.get('/api/bounces', (req, res) => {
  const { search, bounceType, accountEmail, limit } = req.query;
  const result = req.tenantServices.bounceService.getBounces({
    search,
    bounceType,
    accountEmail,
    limit: parseInt(limit) || 100
  });
  res.json({ success: true, ...result, tenantId: req.tenantId });
});

// Fast stats endpoint for auto-sync polling
app.get('/api/bounces/stats', (req, res) => {
  const result = req.tenantServices.bounceService.getBounces({ limit: 1 });
  res.json({ 
    success: true, 
    total: result.total, 
    stats: result.stats,
    suppressionCount: result.suppressedCount,
    tenantId: req.tenantId
  });
});

// Delete / Remove a Bounced Lead
app.delete('/api/bounces/:id', (req, res) => {
  const success = req.tenantServices.bounceService.deleteBounce(req.params.id);
  res.json({ success, message: 'Bounced lead removed', tenantId: req.tenantId });
});

// Clear All Bounces History
app.delete('/api/bounces', (req, res) => {
  const success = req.tenantServices.bounceService.clearAllBounces();
  res.json({ success, message: 'Bounce history cleared', tenantId: req.tenantId });
});

// Simulate Test Bounce for Verification
app.post('/api/bounces/simulate', (req, res) => {
  const { email, recipientEmail, senderEmail, reason, bounceType, category } = req.body || {};
  const testBounce = req.tenantServices.bounceService.recordBounce({
    email: email || recipientEmail || 'invalid.mailbox@nonexistent-domain.xyz',
    senderEmail: senderEmail || 'sender@example.com',
    subject: 'Outreach Campaign inquiry',
    reason: reason || '550 5.1.1 The email account that you tried to reach does not exist.',
    bounceType: bounceType || category || 'Hard Bounce (User Unknown - 550)',
    diagnosticCode: '550 5.1.1'
  });
  res.json({ success: true, bounce: testBounce, tenantId: req.tenantId });
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

    const accounts = req.tenantServices.emailService.accounts;
    let defaultAcc = null;
    if (senderEmail && senderEmail.includes('@')) {
      defaultAcc = accounts.find(a => a.email && a.email.toLowerCase() === senderEmail.toLowerCase().trim());
    }
    if (!defaultAcc) {
      defaultAcc = accounts.find(a => a.isDefault) || accounts[0];
    }

    if (!defaultAcc || !defaultAcc.email || !defaultAcc.password) {
      return res.status(400).json({ success: false, error: 'No active Gmail sender account connected in this workspace.' });
    }

    const replySubject = (subject && subject.toLowerCase().startsWith('re:')) ? subject : `Re: ${subject || 'Outreach'}`;

    const sendResult = await req.tenantServices.emailService.sendEmail({
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
    req.tenantServices.inboxService.recordSentMessage({
      senderEmail: defaultAcc.email,
      to,
      subject: replySubject,
      message
    });

    res.json({
      success: true,
      message: `Reply sent directly to ${to}`,
      sendResult,
      tenantId: req.tenantId
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- DRAFTS (TENANT ISOLATED) ----------------

app.get('/api/draft', (req, res) => {
  const draft = req.tenantServices.getDraft();
  res.json({ success: true, draft, tenantId: req.tenantId });
});

app.post('/api/draft', (req, res) => {
  const { subject, message } = req.body;
  req.tenantServices.saveDraft({ subject, message });
  res.json({ success: true, message: 'Draft saved', tenantId: req.tenantId });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 MailFlow Outreach Server Running at: http://localhost:${PORT}`);
    console.log(`🏢 Multi-Tenant Architecture with Strict Data Isolation: ACTIVE`);
    console.log(`👁️ Live Email Open Tracker & Notification Engine: ACTIVE`);
    console.log(`====================================================`);
  });
}

module.exports = app;
