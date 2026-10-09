const fs = require('fs');
const path = require('path');
const EmailValidator = require('./emailValidator');
const bounceService = require('./bounceService');

const CAMPAIGNS_FILE = path.join(__dirname, '..', 'data', 'campaigns.json');
const OPEN_EVENTS_FILE = path.join(__dirname, '..', 'data', 'open_events.json');

class QueueService {
  constructor(emailService) {
    this.emailService = emailService;
    this.campaigns = [];
    this.activeJobs = new Map();
    this.recentOpens = []; // Store real-time open notification events
    this.loadCampaigns();
    this.loadOpenEvents();
  }

  loadCampaigns() {
    if (fs.existsSync(CAMPAIGNS_FILE)) {
      try {
        this.campaigns = JSON.parse(fs.readFileSync(CAMPAIGNS_FILE, 'utf8'));
      } catch (e) {
        this.campaigns = [];
      }
    }
  }

  saveCampaigns() {
    try {
      fs.writeFileSync(CAMPAIGNS_FILE, JSON.stringify(this.campaigns, null, 2), 'utf8');
    } catch (e) {
      console.error('Error saving campaigns.json:', e.message);
    }
  }

  loadOpenEvents() {
    if (fs.existsSync(OPEN_EVENTS_FILE)) {
      try {
        this.recentOpens = JSON.parse(fs.readFileSync(OPEN_EVENTS_FILE, 'utf8'));
      } catch (e) {
        this.recentOpens = [];
      }
    }
  }

  saveOpenEvents() {
    try {
      fs.writeFileSync(OPEN_EVENTS_FILE, JSON.stringify(this.recentOpens.slice(0, 150), null, 2), 'utf8');
    } catch (e) {
      console.error('Error saving open_events.json:', e.message);
    }
  }

  // Register a test send tracking ID so it can trigger live open alerts
  registerTestTracking({ trackingId, senderEmail, recipientEmail, subject }) {
    if (!this.testTrackings) this.testTrackings = new Map();
    this.testTrackings.set(trackingId, {
      trackingId,
      senderEmail,
      recipientEmail,
      subject: subject || 'Test Outreach Email',
      createdAt: new Date().toISOString(),
      openCount: 0
    });
  }

  // Record an email open from tracking pixel or test trigger
  recordEmailOpen(trackingId, meta = {}) {
    if (!trackingId) return null;

    const now = new Date().toISOString();

    // 1. Check campaigns recipients
    for (let camp of this.campaigns) {
      if (camp.recipients) {
        const rec = camp.recipients.find(r => r.trackingId === trackingId);
        if (rec) {
          const isFirstOpen = !rec.opened;
          rec.opened = true;
          rec.openedAt = rec.openedAt || now;
          rec.lastOpenedAt = now;
          rec.openCount = (rec.openCount || 0) + 1;
          rec.lastIp = meta.ip || rec.lastIp || 'Direct';
          rec.lastUserAgent = meta.userAgent || rec.lastUserAgent || 'Mail Client';

          camp.openCount = camp.recipients.filter(r => r.opened).length;
          this.saveCampaigns();

          const openEvent = {
            id: 'open-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
            campaignId: camp.id,
            subject: camp.subject,
            email: rec.email,
            openedAt: rec.lastOpenedAt,
            openCount: rec.openCount,
            isFirstOpen,
            ip: meta.ip || 'Unknown',
            userAgent: meta.userAgent || 'Mail Client'
          };

          this.recentOpens.unshift(openEvent);
          if (this.recentOpens.length > 150) this.recentOpens.pop();
          this.saveOpenEvents();

          console.log(`👁️ [EMAIL OPEN DETECTED] ${rec.email} opened "${camp.subject}" (Total Opens: ${rec.openCount})`);
          return openEvent;
        }
      }
    }

    // 2. Check test sends
    if (this.testTrackings && this.testTrackings.has(trackingId)) {
      const testItem = this.testTrackings.get(trackingId);
      testItem.openCount = (testItem.openCount || 0) + 1;
      testItem.lastOpenedAt = now;

      const openEvent = {
        id: 'open-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
        campaignId: 'test-send',
        subject: testItem.subject,
        email: testItem.recipientEmail,
        openedAt: now,
        openCount: testItem.openCount,
        isFirstOpen: testItem.openCount === 1,
        ip: meta.ip || 'Direct',
        userAgent: meta.userAgent || 'Mail Client'
      };

      this.recentOpens.unshift(openEvent);
      if (this.recentOpens.length > 150) this.recentOpens.pop();
      this.saveOpenEvents();

      console.log(`👁️ [TEST EMAIL OPEN DETECTED] ${testItem.recipientEmail} opened "${testItem.subject}"`);
      return openEvent;
    }

    // 3. Standalone tracking ID (direct hit or test simulation)
    const openEvent = {
      id: 'open-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
      campaignId: 'general',
      subject: 'Outreach Email',
      email: meta.email || 'Lead Recipient',
      openedAt: now,
      openCount: 1,
      isFirstOpen: true,
      ip: meta.ip || 'Direct',
      userAgent: meta.userAgent || 'Mail Client'
    };

    this.recentOpens.unshift(openEvent);
    if (this.recentOpens.length > 150) this.recentOpens.pop();
    this.saveOpenEvents();
    return openEvent;
  }

  getRecentOpens(sinceTimestamp = 0) {
    if (!sinceTimestamp) return this.recentOpens.slice(0, 30);
    return this.recentOpens.filter(o => new Date(o.openedAt).getTime() > sinceTimestamp);
  }

  // Launch campaign with direct sender email, password, leads, subject, message, and anti-spam delay
  // Launch campaign with direct sender email, password, leads, subject, message, message variants, and anti-spam delay
  async startDirectCampaign({
    senderEmail,
    senderPassword,
    senderName,
    subject,
    message,
    messageVariants = [],
    rawRecipients,
    delaySeconds = 15,
    enableTracking = false,
    plainTextOnly = true,
    baseUrl = 'http://localhost:3000',
    smtpHost = null,
    smtpPort = null
  }) {
    if (!senderEmail || !senderEmail.includes('@')) {
      throw new Error('Please provide your sender email address.');
    }
    if (!subject || !subject.trim()) {
      throw new Error('Please provide an email subject.');
    }
    if (!message || !message.trim()) {
      throw new Error('Please provide your outreach message.');
    }

    const validation = EmailValidator.cleanAndValidate(rawRecipients);
    if (!validation.canSend) {
      if (validation.invalidCount > 0) {
        throw new Error(`Please fix or remove the ${validation.invalidCount} invalid email address${validation.invalidCount > 1 ? 'es' : ''} before sending.`);
      }
      throw new Error('Please paste at least one valid lead email address.');
    }

    const cappedRecipients = validation.cappedRecipients;
    const recipientCount = cappedRecipients.length;
    const effectiveDelaySec = Math.max(3, Math.min(120, parseInt(delaySeconds) || 15));

    const campaignId = `camp-${Date.now()}`;
    const recipientsList = cappedRecipients.map((email, idx) => ({
      id: `rec-${idx + 1}`,
      trackingId: `trk-${Date.now()}-${idx + 1}-${Math.random().toString(36).substr(2, 6)}`,
      email: email.toLowerCase().trim(),
      variantNumber: (Array.isArray(messageVariants) && messageVariants.length > 0) ? (idx % messageVariants.length) + 1 : 1,
      status: 'Pending',
      sentAt: null,
      error: null,
      opened: false,
      openedAt: null,
      openCount: 0
    }));

    // Filter valid variants
    const validVariants = Array.isArray(messageVariants) && messageVariants.length > 0
      ? messageVariants.filter(v => v && v.message && v.message.trim())
      : [];

    const campaign = {
      id: campaignId,
      senderEmail: senderEmail.trim(),
      senderName: senderName ? senderName.trim() : senderEmail.split('@')[0],
      subject: subject.trim(),
      message: message.trim(),
      messageVariants: validVariants.length > 0 ? validVariants : [{ subject: subject.trim(), message: message.trim() }],
      totalRecipients: recipientCount,
      sentCount: 0,
      failedCount: 0,
      pendingCount: recipientCount,
      openCount: 0,
      delaySeconds: effectiveDelaySec,
      plainTextOnly: !!plainTextOnly,
      enableTracking: !!enableTracking,
      status: 'In Progress',
      createdAt: new Date().toISOString(),
      completedAt: null,
      recipients: recipientsList
    };

    this.campaigns.unshift(campaign);
    this.saveCampaigns();

    const jobState = {
      campaignId,
      isRunning: true,
      isPaused: false,
      currentLead: null,
      currentIndex: 0,
      nextSendTimestamp: Date.now(),
      secondsLeft: 0,
      delaySeconds: effectiveDelaySec
    };
    this.activeJobs.set(campaignId, jobState);

    // Launch background server queue processing
    this._processQueue(campaign, {
      senderEmail,
      senderPassword,
      senderName,
      smtpHost,
      smtpPort,
      delaySeconds: effectiveDelaySec,
      plainTextOnly: !!plainTextOnly,
      enableTracking: !!enableTracking,
      baseUrl
    }, jobState);

    return {
      success: true,
      campaignId,
      totalRecipients: recipientCount,
      senderEmail: campaign.senderEmail,
      delaySeconds: effectiveDelaySec,
      variantCount: campaign.messageVariants.length
    };
  }

  async _processQueue(campaign, creds, jobState) {
    const total = campaign.recipients.length;

    for (let i = 0; i < total; i++) {
      if (!jobState.isRunning) break;

      while (jobState.isPaused && jobState.isRunning) {
        await new Promise(r => setTimeout(r, 600));
      }

      if (!jobState.isRunning) break;

      const rec = campaign.recipients[i];
      jobState.currentIndex = i + 1;
      jobState.currentLead = rec.email;

      // Auto-Suppression check: Skip previously bounced leads to protect sender reputation
      if (bounceService.isSuppressed(rec.email)) {
        rec.status = 'Suppressed';
        rec.error = 'Lead was previously bounced (Auto-Suppressed to protect inbox reputation)';
        rec.isSuppressed = true;
        campaign.failedCount++;
        campaign.pendingCount = Math.max(0, campaign.totalRecipients - (campaign.sentCount + campaign.failedCount));
        this.saveCampaigns();
        continue;
      }

      rec.status = 'Sending';

      // Auto-Shuffle / Rotate between the 5 message variants
      let targetSubject = campaign.subject;
      let targetTemplate = campaign.message;

      if (Array.isArray(campaign.messageVariants) && campaign.messageVariants.length > 0) {
        const vIndex = i % campaign.messageVariants.length;
        const v = campaign.messageVariants[vIndex];
        if (v && v.message && v.message.trim()) {
          targetTemplate = v.message.trim();
          targetSubject = v.subject && v.subject.trim() ? v.subject.trim() : campaign.subject;
          rec.variantNumber = vIndex + 1;
        }
      }

      const personalizedMessage = targetTemplate.replace(/\{\{\s*email\s*\}\}/gi, rec.email);

      try {
        const result = await this.emailService.sendEmail({
          senderEmail: creds.senderEmail,
          senderPassword: creds.senderPassword,
          senderName: creds.senderName,
          to: rec.email,
          subject: targetSubject,
          message: personalizedMessage,
          trackingId: rec.trackingId,
          baseUrl: creds.baseUrl,
          enableTracking: creds.enableTracking,
          plainTextOnly: creds.plainTextOnly,
          host: creds.smtpHost,
          port: creds.smtpPort
        });

        rec.status = 'Sent';
        rec.sentAt = new Date().toISOString();
        rec.mode = result.mode || 'smtp';
        rec.messageId = result.messageId;
        rec.subjectSent = result.subjectSent || targetSubject;
        campaign.sentCount++;
      } catch (err) {
        console.error(`Failed to dispatch outreach to ${rec.email}:`, err.message);
        const errMsg = err.message || 'Delivery failed';
        rec.status = 'Failed';
        rec.error = errMsg;
        campaign.failedCount++;

        // Live SMTP rejection / hard bounce detection
        const isSmtpBounce = 
          errMsg.includes('550') ||
          errMsg.includes('551') ||
          errMsg.includes('552') ||
          errMsg.includes('553') ||
          errMsg.includes('554') ||
          errMsg.toLowerCase().includes('recipient address rejected') ||
          errMsg.toLowerCase().includes('user unknown') ||
          errMsg.toLowerCase().includes('mailbox not found') ||
          errMsg.toLowerCase().includes('does not exist') ||
          errMsg.toLowerCase().includes('invalid recipient');

        if (isSmtpBounce) {
          rec.isBounced = true;
          bounceService.recordBounce({
            email: rec.email,
            senderEmail: creds.senderEmail,
            campaignId: campaign.id,
            subject: targetSubject,
            reason: errMsg,
            bounceType: 'Hard Bounce (SMTP Rejected)',
            diagnosticCode: errMsg.match(/\b55[0-9]\b/)?.[0] || '550'
          });
        }
      }

      campaign.pendingCount = Math.max(0, campaign.totalRecipients - (campaign.sentCount + campaign.failedCount));
      this.saveCampaigns();

      // If there are remaining leads, wait humanized jitter anti-spam delay (e.g. 5s - 20s)
      if (i < total - 1 && jobState.isRunning) {
        // Add +/- 15% random jitter to simulate human typing and sending rhythm
        const baseDelay = creds.delaySeconds || 15;
        const jitter = Math.floor(Math.random() * (baseDelay * 0.25)) - Math.floor(baseDelay * 0.12);
        const effectiveJitterSec = Math.max(3, baseDelay + jitter);
        const delayMs = effectiveJitterSec * 1000;

        jobState.nextSendTimestamp = Date.now() + delayMs;

        const startTime = Date.now();
        while (Date.now() - startTime < delayMs && jobState.isRunning) {
          while (jobState.isPaused && jobState.isRunning) {
            await new Promise(r => setTimeout(r, 600));
          }
          jobState.secondsLeft = Math.max(0, Math.ceil((delayMs - (Date.now() - startTime)) / 1000));
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }

    const finalStatus = jobState.isRunning ? 'Completed' : 'Stopped';
    campaign.status = finalStatus;
    campaign.completedAt = new Date().toISOString();
    this.saveCampaigns();

    jobState.isRunning = false;
    jobState.secondsLeft = 0;
  }

  getCampaignStatus(campaignId) {
    const camp = this.campaigns.find(c => c.id === campaignId) || null;
    if (!camp) return null;

    const job = this.activeJobs.get(campaignId);

    return {
      campaign: camp,
      isRunning: job ? job.isRunning : (camp.status === 'In Progress'),
      isPaused: job ? job.isPaused : (camp.status === 'Paused'),
      currentLead: job ? job.currentLead : null,
      currentIndex: job ? job.currentIndex : camp.sentCount + camp.failedCount,
      secondsLeft: job ? (job.secondsLeft || 0) : 0,
      delaySeconds: camp.delaySeconds || 60,
      openCount: camp.openCount || 0,
      recipients: camp.recipients || []
    };
  }

  pauseCampaign(campaignId) {
    const job = this.activeJobs.get(campaignId);
    if (!job || !job.isRunning) return { success: false, error: 'No active sending job.' };

    job.isPaused = !job.isPaused;
    const camp = this.campaigns.find(c => c.id === campaignId);
    if (camp) {
      camp.status = job.isPaused ? 'Paused' : 'In Progress';
      this.saveCampaigns();
    }
    return { success: true, isPaused: job.isPaused };
  }

  stopCampaign(campaignId) {
    const job = this.activeJobs.get(campaignId);
    if (job) {
      job.isRunning = false;
      job.isPaused = false;
    }

    const camp = this.campaigns.find(c => c.id === campaignId);
    if (camp) {
      camp.status = 'Stopped';
      camp.completedAt = new Date().toISOString();
      this.saveCampaigns();
    }
    return { success: true, message: 'Campaign stopped' };
  }

  getCampaigns() {
    return this.campaigns;
  }

  deleteCampaign(campaignId) {
    this.campaigns = this.campaigns.filter(c => c.id !== campaignId);
    this.saveCampaigns();
    return { success: true, message: 'Campaign deleted' };
  }

  clearAllCampaigns() {
    this.campaigns = [];
    this.saveCampaigns();
    return { success: true, message: 'All campaign history cleared' };
  }

  getStats() {
    let totalEmails = 0;
    let totalCamps = 0;
    let totalOpens = 0;

    this.campaigns.forEach(c => {
      totalEmails += (c.sentCount || 0);
      totalOpens += (c.openCount || 0);
      if (c.status === 'Completed' || c.status === 'In Progress') {
        totalCamps++;
      }
    });

    return {
      maxLeads: 50,
      campaignsSent: totalCamps,
      emailsSent: totalEmails,
      totalOpens
    };
  }
}

module.exports = QueueService;
