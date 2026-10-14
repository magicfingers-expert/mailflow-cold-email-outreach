const path = require('path');
const EmailValidator = require('./emailValidator');
const bounceService = require('./bounceService');
const LeadService = require('./leadService');
const storage = require('./storageService');

const CAMPAIGNS_FILE = path.join(__dirname, '..', 'data', 'campaigns.json');
const OPEN_EVENTS_FILE = path.join(__dirname, '..', 'data', 'open_events.json');

class QueueService {
  constructor(emailService, options = {}) {
    if (emailService && typeof emailService === 'object' && !emailService.loadAccounts && emailService.emailService) {
      options = emailService;
      emailService = options.emailService;
    }
    this.emailService = emailService;
    this.campaignsFile = options.campaignsFile || CAMPAIGNS_FILE;
    this.openEventsFile = options.openEventsFile || OPEN_EVENTS_FILE;
    this.tenantId = options.tenantId || 'default';
    this.bounceService = options.bounceService || bounceService;
    this.leadService = options.leadService || null;
    this.campaigns = [];
    this.activeJobs = new Map();
    this.recentOpens = []; // Store real-time open notification events
    this.loadCampaigns();
    this.loadOpenEvents();
  }

  loadCampaigns() {
    const data = storage.readJSON(this.campaignsFile, []);
    this.campaigns = Array.isArray(data) ? data : [];
  }

  saveCampaigns() {
    storage.writeJSON(this.campaignsFile, this.campaigns);
  }

  loadOpenEvents() {
    const data = storage.readJSON(this.openEventsFile, []);
    this.recentOpens = Array.isArray(data) ? data : [];
  }

  saveOpenEvents() {
    storage.writeJSON(this.openEventsFile, this.recentOpens.slice(0, 150));
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

    // Ensure fresh in-memory state
    this.loadCampaigns();
    this.loadOpenEvents();

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
      campaignId: meta.campaignId || 'general',
      subject: meta.subject || 'Outreach Email',
      email: meta.email || (meta.recipientEmail || 'Lead Recipient'),
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
    this.loadOpenEvents();
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
    enableTracking = true,
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

    const suppressedList = this.bounceService ? this.bounceService.getSuppressedEmails() : [];
    const validation = EmailValidator.cleanAndValidate(rawRecipients, suppressedList);
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
    const recipientsList = cappedRecipients.map((email, idx) => {
      const cleanEmail = email.toLowerCase().trim();
      const leadInfo = this.leadService ? this.leadService.getLeadByEmail(cleanEmail) : null;
      return {
        id: `rec-${idx + 1}`,
        trackingId: `trk_${this.tenantId}_${Date.now()}_${idx + 1}_${Math.random().toString(36).substr(2, 6)}`,
        email: cleanEmail,
        name: leadInfo ? leadInfo.name : null,
        firstName: leadInfo ? leadInfo.firstName : null,
        lastName: leadInfo ? leadInfo.lastName : null,
        company: leadInfo ? leadInfo.company : null,
        variantNumber: (Array.isArray(messageVariants) && messageVariants.length > 0) ? (idx % messageVariants.length) + 1 : 1,
        status: 'Pending',
        sentAt: null,
        error: null,
        opened: false,
        openedAt: null,
        openCount: 0
      };
    });

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
      enableTracking: enableTracking !== false,
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
      enableTracking: enableTracking !== false,
      baseUrl: baseUrl || 'http://localhost:3000'
    }, jobState);

    return {
      success: true,
      campaignId,
      totalRecipients: recipientCount,
      senderEmail: campaign.senderEmail,
      delaySeconds: effectiveDelaySec,
      variantCount: campaign.messageVariants.length,
      // Inform the client if running on Vercel where long campaigns may be interrupted
      serverlessWarning: process.env.VERCEL
        ? 'Running on Vercel serverless — the campaign processes directly. For best results with 10+ leads, send in smaller batches of 5-10 leads at a time.'
        : null
    };
  }

  // Preview Multi-Account Allocation
  previewMultiAccountAllocation({ rawRecipients, selectedAccountIds = [], maxSendsPerAccount = null }) {
    const suppressedList = this.bounceService ? this.bounceService.getSuppressedEmails() : [];
    const validation = EmailValidator.cleanAndValidate(rawRecipients, suppressedList);
    const eligibleList = validation.cappedRecipients || [];

    this.emailService.loadAccounts();
    let candidateAccounts = this.emailService.accounts;
    if (Array.isArray(selectedAccountIds) && selectedAccountIds.length > 0) {
      candidateAccounts = candidateAccounts.filter(a => selectedAccountIds.includes(a.id));
    }

    const accountAllocations = candidateAccounts.map(acc => {
      this.emailService.resetDailyUsageIfNewDay(acc);
      const isThrottled = !!(acc.throttleUntil && new Date(acc.throttleUntil) > new Date());
      const dailyCap = acc.dailyLimit || 50;
      const sentToday = acc.sentToday || 0;
      let remaining = Math.max(0, dailyCap - sentToday);
      if (maxSendsPerAccount) {
        remaining = Math.min(remaining, parseInt(maxSendsPerAccount, 10));
      }
      if (isThrottled) remaining = 0;

      return {
        id: acc.id,
        email: acc.email,
        name: acc.name,
        provider: acc.provider,
        dailyLimit: dailyCap,
        sentToday,
        remainingCapacity: remaining,
        isThrottled,
        throttleUntil: acc.throttleUntil || null,
        allocatedCount: 0
      };
    });

    const activeAccounts = accountAllocations.filter(a => a.remainingCapacity > 0);
    let totalSchedulable = 0;

    if (activeAccounts.length > 0) {
      let leadIdx = 0;
      let keepAllocating = true;
      while (keepAllocating && leadIdx < eligibleList.length) {
        let allocatedInRound = 0;
        for (const acc of activeAccounts) {
          if (leadIdx >= eligibleList.length) break;
          if (acc.allocatedCount < acc.remainingCapacity) {
            acc.allocatedCount++;
            leadIdx++;
            allocatedInRound++;
            totalSchedulable++;
          }
        }
        if (allocatedInRound === 0) {
          keepAllocating = false;
        }
      }
    }

    const totalPoolCapacity = accountAllocations.reduce((s, a) => s + (a.remainingCapacity || 0), 0);
    const isCapped = eligibleList.length > totalSchedulable;

    return {
      totalSubmitted: (rawRecipients || '').split(/\r?\n/).filter(Boolean).length,
      eligibleLeads: eligibleList.length,
      totalValid: eligibleList.length,
      suppressedCount: validation.suppressedCount,
      invalidCount: validation.invalidCount,
      accounts: accountAllocations,
      allocations: accountAllocations.map(a => ({
        accountId: a.id,
        email: a.email,
        count: a.allocatedCount,
        assignedLeads: a.allocatedCount,
        dailySendCap: a.dailyLimit,
        remainingToday: a.remainingCapacity
      })),
      activeAccountCount: activeAccounts.length,
      totalCapacity: totalPoolCapacity,
      totalPoolCapacity,
      totalSchedulable,
      totalAllocated: totalSchedulable,
      isCapped,
      overflowCount: Math.max(0, eligibleList.length - totalSchedulable)
    };
  }

  // Launch Multi-Account Campaign with Round-Robin Allocation & Cap Enforcement
  async startMultiAccountCampaign({
    selectedAccountIds = [],
    maxSendsPerAccount = null,
    subject,
    message,
    messageVariants = [],
    rawRecipients,
    delaySeconds = 15,
    enableTracking = true,
    plainTextOnly = true,
    baseUrl = 'http://localhost:3000'
  }) {
    if (!subject || !subject.trim()) {
      throw new Error('Please provide an email subject.');
    }
    if (!message || !message.trim()) {
      throw new Error('Please provide your outreach message.');
    }

    const allocation = this.previewMultiAccountAllocation({
      rawRecipients,
      selectedAccountIds,
      maxSendsPerAccount
    });

    if (allocation.activeAccountCount === 0) {
      throw new Error('No eligible sender accounts available. Selected accounts may have reached their daily limit or are throttled.');
    }

    if (allocation.totalSchedulable === 0) {
      throw new Error('No eligible leads to send or all selected accounts have 0 remaining quota.');
    }

    const suppressedList = this.bounceService ? this.bounceService.getSuppressedEmails() : [];
    const validation = EmailValidator.cleanAndValidate(rawRecipients, suppressedList);
    const eligibleList = validation.cappedRecipients || [];

    // Pre-allocate recipients round-robin to active accounts
    const activeAccs = allocation.accounts.filter(a => a.remainingCapacity > 0);
    const campaignId = `camp-multi-${Date.now()}`;
    const recipientsList = [];

    let accIdx = 0;
    for (let i = 0; i < eligibleList.length; i++) {
      const email = eligibleList[i].toLowerCase().trim();
      const leadInfo = this.leadService ? this.leadService.getLeadByEmail(email) : null;
      const targetAcc = activeAccs[accIdx % activeAccs.length];
      accIdx++;

      recipientsList.push({
        id: `rec-${i + 1}`,
        trackingId: `trk_${this.tenantId}_${Date.now()}_${i + 1}_${Math.random().toString(36).substr(2, 6)}`,
        email,
        name: leadInfo ? (leadInfo.name || leadInfo.businessName) : null,
        firstName: leadInfo ? leadInfo.firstName : null,
        lastName: leadInfo ? leadInfo.lastName : null,
        businessName: leadInfo ? (leadInfo.businessName || leadInfo.company) : null,
        company: leadInfo ? leadInfo.company : null,
        website: leadInfo ? leadInfo.website : null,
        city: leadInfo ? leadInfo.city : null,
        websiteAuditSummary: leadInfo ? leadInfo.websiteAuditSummary : null,
        assignedAccountId: targetAcc ? targetAcc.id : null,
        assignedSenderEmail: targetAcc ? targetAcc.email : null,
        variantNumber: (Array.isArray(messageVariants) && messageVariants.length > 0) ? (i % messageVariants.length) + 1 : 1,
        status: 'Pending',
        sentAt: null,
        error: null,
        opened: false,
        openedAt: null,
        openCount: 0
      });
    }

    const validVariants = Array.isArray(messageVariants) && messageVariants.length > 0
      ? messageVariants.filter(v => v && v.message && v.message.trim())
      : [];

    const effectiveDelaySec = Math.max(3, Math.min(120, parseInt(delaySeconds, 10) || 15));

    const campaign = {
      id: campaignId,
      isMultiAccount: true,
      selectedAccountIds: activeAccs.map(a => a.id),
      senderEmail: activeAccs.map(a => a.email).join(', '),
      senderName: 'Multi-Account Engine',
      subject: subject.trim(),
      message: message.trim(),
      messageVariants: validVariants.length > 0 ? validVariants : [{ subject: subject.trim(), message: message.trim() }],
      totalRecipients: recipientsList.length,
      sentCount: 0,
      failedCount: 0,
      pendingCount: recipientsList.length,
      openCount: 0,
      delaySeconds: effectiveDelaySec,
      plainTextOnly: !!plainTextOnly,
      enableTracking: enableTracking !== false,
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

    this._processQueue(campaign, {
      isMultiAccount: true,
      delaySeconds: effectiveDelaySec,
      plainTextOnly: !!plainTextOnly,
      enableTracking: enableTracking !== false,
      baseUrl: baseUrl || 'http://localhost:3000'
    }, jobState);

    return {
      success: true,
      campaignId,
      totalRecipients: recipientsList.length,
      activeAccountCount: activeAccs.length,
      schedulableCount: allocation.totalSchedulable,
      overflowCount: allocation.overflowCount,
      delaySeconds: effectiveDelaySec,
      variantCount: campaign.messageVariants.length
    };
  }

  async _processQueue(campaign, creds, jobState) {
    const total = campaign.recipients.length;

    for (let i = 0; i < total; i++) {
      if (!jobState.isRunning) break;

      while (jobState.isPaused && jobState.isRunning) {
        const pauseInterval = process.env.MAILFLOW_TEST_MODE === '1' ? 10 : 600;
        await new Promise(r => setTimeout(r, pauseInterval));
      }

      if (!jobState.isRunning) break;

      const rec = campaign.recipients[i];
      // Idempotency safeguard: skip already processed leads on resume or retry
      if (rec.status === 'Sent' || rec.status === 'Suppressed') {
        continue;
      }

      jobState.currentIndex = i + 1;
      jobState.currentLead = rec.email;

      // Auto-Suppression check: Skip previously bounced or unsubscribed leads
      if (this.bounceService.isSuppressed(rec.email)) {
        rec.status = 'Suppressed';
        rec.error = 'Recipient is on suppression/unsubscribe list (Automatically skipped)';
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

      // Determine active sender credentials (supporting Multi-Account rotation)
      let effectiveSenderEmail = creds.senderEmail;
      let effectiveSenderPassword = creds.senderPassword;
      let effectiveSenderName = creds.senderName;
      let activeAccountId = null;

      if (campaign.isMultiAccount || creds.isMultiAccount) {
        this.emailService.loadAccounts();

        // 1. Try assigned account
        let targetAcc = rec.assignedAccountId ? this.emailService.getAccountById(rec.assignedAccountId) : null;
        const canTargetSend = targetAcc &&
          (!targetAcc.throttleUntil || new Date(targetAcc.throttleUntil) <= new Date()) &&
          (targetAcc.dailyLimit || 50) > (targetAcc.sentToday || 0);

        if (!canTargetSend) {
          // 2. Rotate to next eligible account with capacity
          const selectedAccounts = (campaign.selectedAccountIds && campaign.selectedAccountIds.length > 0)
            ? this.emailService.accounts.filter(a => campaign.selectedAccountIds.includes(a.id))
            : this.emailService.accounts;

          targetAcc = selectedAccounts.find(a =>
            (!a.throttleUntil || new Date(a.throttleUntil) <= new Date()) &&
            (a.dailyLimit || 50) > (a.sentToday || 0)
          );
        }

        if (!targetAcc) {
          // All accounts reached limit -> Pause campaign gracefully
          campaign.status = 'Paused (Quota Limit)';
          rec.status = 'Pending';
          this.saveCampaigns();
          break;
        }

        activeAccountId = targetAcc.id;
        effectiveSenderEmail = targetAcc.email;
        effectiveSenderPassword = this.emailService.getAccountPassword(targetAcc);
        effectiveSenderName = targetAcc.name || targetAcc.email.split('@')[0];
        rec.assignedAccountId = activeAccountId;
        rec.assignedSenderEmail = effectiveSenderEmail;
      }

      const sName = effectiveSenderName || (effectiveSenderEmail ? effectiveSenderEmail.split('@')[0] : 'Team');
      const sFirst = sName.split(' ')[0] || sName;
      const rEmail = rec.email;
      const rName = rec.name || rEmail.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

      // Personalization with variable fallbacks (including website, businessName, auditFinding)
      const renderRes = LeadService.renderTemplate(targetTemplate, {
        email: rEmail,
        name: rName,
        firstName: rec.firstName,
        lastName: rec.lastName,
        businessName: rec.businessName || rec.company,
        company: rec.company || '',
        website: rec.website || '',
        city: rec.city || '',
        websiteAuditSummary: rec.websiteAuditSummary || ''
      }, {
        senderName: sName,
        senderFirstName: sFirst,
        senderEmail: effectiveSenderEmail
      });
      const personalizedMessage = renderRes.text;

      const subRenderRes = LeadService.renderTemplate(targetSubject, {
        email: rEmail,
        name: rName,
        firstName: rec.firstName,
        lastName: rec.lastName,
        businessName: rec.businessName || rec.company,
        company: rec.company || '',
        website: rec.website || '',
        city: rec.city || '',
        websiteAuditSummary: rec.websiteAuditSummary || ''
      }, {
        senderName: sName,
        senderFirstName: sFirst,
        senderEmail: effectiveSenderEmail
      });
      const personalizedSubject = subRenderRes.text;

      try {
        const result = await this.emailService.sendEmail({
          senderEmail: effectiveSenderEmail,
          senderPassword: effectiveSenderPassword,
          senderName: sName,
          to: rec.email,
          subject: personalizedSubject,
          message: personalizedMessage,
          trackingId: rec.trackingId,
          baseUrl: creds.baseUrl || 'http://localhost:3000',
          enableTracking: creds.enableTracking !== false,
          plainTextOnly: creds.plainTextOnly,
          host: creds.smtpHost,
          port: creds.smtpPort
        });

        rec.status = 'Sent';
        rec.sentAt = new Date().toISOString();
        rec.mode = result.mode || 'smtp';
        rec.messageId = result.messageId;
        rec.subjectSent = result.subjectSent || targetSubject;
        if (activeAccountId) {
          rec.actualSenderId = activeAccountId;
          rec.actualSenderEmail = effectiveSenderEmail;
          this.emailService.incrementSentToday(activeAccountId);
        }
        campaign.sentCount++;
      } catch (err) {
        console.error(`Failed to dispatch outreach to ${rec.email}:`, err.message);
        const errMsg = err.message || 'Delivery failed';
        rec.status = 'Failed';
        rec.error = errMsg;
        campaign.failedCount++;

        // Provider rate limit / throttling detection (do NOT rotate failed lead to evade bans)
        const isProviderThrottle = 
          errMsg.includes('421') ||
          errMsg.includes('454') ||
          errMsg.toLowerCase().includes('user sending limit') ||
          errMsg.toLowerCase().includes('rate limit') ||
          errMsg.toLowerCase().includes('daily sending quota') ||
          errMsg.toLowerCase().includes('suspension') ||
          errMsg.toLowerCase().includes('temporarily deferred');

        if (isProviderThrottle && activeAccountId) {
          this.emailService.markAccountThrottled(activeAccountId, errMsg, 3600000);
        }

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
          this.bounceService.recordBounce({
            email: rec.email,
            senderEmail: effectiveSenderEmail,
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
        const baseDelay = process.env.MAILFLOW_TEST_MODE === '1' ? 0.01 : (creds.delaySeconds || 15);
        const jitter = process.env.MAILFLOW_TEST_MODE === '1' ? 0 : (Math.floor(Math.random() * (baseDelay * 0.25)) - Math.floor(baseDelay * 0.12));
        const effectiveJitterSec = process.env.MAILFLOW_TEST_MODE === '1' ? 0.01 : Math.max(3, baseDelay + jitter);
        const delayMs = process.env.MAILFLOW_TEST_MODE === '1' ? 20 : effectiveJitterSec * 1000;

        jobState.nextSendTimestamp = Date.now() + delayMs;

        if (process.env.MAILFLOW_TEST_MODE === '1') {
          await new Promise(r => setTimeout(r, 10));
        } else {
          const startTime = Date.now();
          while (Date.now() - startTime < delayMs && jobState.isRunning) {
            while (jobState.isPaused && jobState.isRunning) {
              await new Promise(r => setTimeout(r, 600));
            }
            jobState.secondsLeft = Math.max(0, Math.ceil((delayMs - (Date.now() - startTime)) / 1000));
            await new Promise(r => setTimeout(r, 200));
          }
        }
      }
    }

    jobState.isRunning = false;
    jobState.secondsLeft = 0;
    if (campaign.sentCount + campaign.failedCount >= campaign.totalRecipients) {
      campaign.status = 'Completed';
      campaign.completedAt = new Date().toISOString();
    }
    this.saveCampaigns();
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
    if (job) {
      job.isPaused = !job.isPaused;
    }

    const camp = this.campaigns.find(c => c.id === campaignId);
    if (camp) {
      const isPaused = job ? job.isPaused : (camp.status !== 'Paused');
      camp.status = isPaused ? 'Paused' : 'In Progress';
      this.saveCampaigns();
      return { success: true, isPaused };
    }
    return { success: false, error: 'Campaign not found' };
  }

  getCampaignById(campaignId) {
    this.loadCampaigns();
    return this.campaigns.find(c => c.id === campaignId) || null;
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

  resumeCampaign(campaignId, creds = {}) {
    const camp = this.campaigns.find(c => c.id === campaignId);
    if (!camp) return { success: false, error: 'Campaign not found' };

    const remainingPending = camp.recipients.filter(r => r.status === 'Pending').length;
    if (remainingPending === 0) {
      return { success: false, error: 'Campaign has already completed all leads.' };
    }

    camp.status = 'In Progress';
    this.saveCampaigns();

    const effectiveDelaySec = camp.delaySeconds || 15;
    const jobState = {
      campaignId,
      isRunning: true,
      isPaused: false,
      currentLead: null,
      currentIndex: camp.sentCount + camp.failedCount,
      nextSendTimestamp: Date.now(),
      secondsLeft: 0,
      delaySeconds: effectiveDelaySec
    };
    this.activeJobs.set(campaignId, jobState);

    let sPass = creds.senderPassword;
    const sEmail = creds.senderEmail || camp.senderEmail;
    if (!sPass && this.emailService) {
      const acc = this.emailService.getAccountByEmail(sEmail);
      if (acc) sPass = this.emailService.getAccountPassword(acc);
    }

    this._processQueue(camp, {
      senderEmail: sEmail,
      senderPassword: sPass || '',
      senderName: creds.senderName || camp.senderName,
      delaySeconds: effectiveDelaySec,
      plainTextOnly: camp.plainTextOnly,
      enableTracking: camp.enableTracking,
      baseUrl: creds.baseUrl || 'http://localhost:3000'
    }, jobState);

    return { success: true, message: `Resumed sending to ${remainingPending} pending leads.`, campaign: camp };
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
    let totalSent = 0;
    let totalFailed = 0;
    let totalCamps = 0;
    let totalOpens = 0;
    let totalRecipients = 0;

    this.campaigns.forEach(c => {
      totalSent += (c.sentCount || 0);
      totalFailed += (c.failedCount || 0);
      totalOpens += (c.openCount || 0);
      totalRecipients += (c.totalRecipients || 0);
      if (c.status === 'Completed' || c.status === 'In Progress') {
        totalCamps++;
      }
    });

    const bouncesCount = this.bounceService && Array.isArray(this.bounceService.bounces) ? this.bounceService.bounces.length : 0;
    const suppressedCount = this.bounceService && typeof this.bounceService.getSuppressedEmails === 'function' ? this.bounceService.getSuppressedEmails().length : 0;
    const activeSenders = this.emailService && Array.isArray(this.emailService.accounts) ? this.emailService.accounts.filter(a => a.sendingReady || a.status === 'Connected').length : 0;

    const openRate = totalSent > 0 ? Number(((totalOpens / totalSent) * 100).toFixed(1)) : 0;
    const bounceDenominator = totalSent + bouncesCount;
    const bounceRate = bounceDenominator > 0 ? Number(((bouncesCount / bounceDenominator) * 100).toFixed(1)) : 0;

    return {
      campaignsTotal: this.campaigns.length,
      campaignsSent: totalCamps,
      emailsSent: totalSent,
      emailsFailed: totalFailed,
      totalRecipients,
      totalOpens,
      openRate,
      bouncesCount,
      bounceRate,
      suppressedCount,
      activeSenders,
      openTrackingNotice: 'Open rates are measured approximations subject to recipient email client privacy proxies and image blocking.'
    };
  }
}

module.exports = QueueService;
