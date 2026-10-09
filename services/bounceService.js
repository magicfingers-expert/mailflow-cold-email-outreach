const fs = require('fs');
const path = require('path');

const BOUNCES_FILE = path.join(__dirname, '..', 'data', 'bounces.json');
const SUPPRESSION_FILE = path.join(__dirname, '..', 'data', 'suppression.json');

class BounceService {
  constructor() {
    this.bounces = [];
    this.suppressionList = new Set();
    this.loadBounces();
    this.loadSuppression();
  }

  loadBounces() {
    if (fs.existsSync(BOUNCES_FILE)) {
      try {
        this.bounces = JSON.parse(fs.readFileSync(BOUNCES_FILE, 'utf8'));
      } catch (e) {
        this.bounces = [];
      }
    }
  }

  saveBounces() {
    try {
      fs.writeFileSync(BOUNCES_FILE, JSON.stringify(this.bounces, null, 2), 'utf8');
    } catch (e) {
      console.error('Error saving bounces.json:', e.message);
    }
  }

  loadSuppression() {
    if (fs.existsSync(SUPPRESSION_FILE)) {
      try {
        const list = JSON.parse(fs.readFileSync(SUPPRESSION_FILE, 'utf8'));
        if (Array.isArray(list)) {
          list.forEach(em => this.suppressionList.add(em.toLowerCase().trim()));
        }
      } catch (e) {
        this.suppressionList = new Set();
      }
    }
  }

  saveSuppression() {
    try {
      fs.writeFileSync(SUPPRESSION_FILE, JSON.stringify(Array.from(this.suppressionList), null, 2), 'utf8');
    } catch (e) {
      console.error('Error saving suppression.json:', e.message);
    }
  }

  isSuppressed(email) {
    if (!email) return false;
    return this.suppressionList.has(email.toLowerCase().trim());
  }

  addToSuppression(email, reason = 'Bounced') {
    if (!email) return false;
    const clean = email.toLowerCase().trim();
    if (!this.suppressionList.has(clean)) {
      this.suppressionList.add(clean);
      this.saveSuppression();
      console.log(`🛡️ [AUTO-SUPPRESSION] Added ${clean} to suppression list (Reason: ${reason})`);
      return true;
    }
    return false;
  }

  removeFromSuppression(email) {
    if (!email) return false;
    const clean = email.toLowerCase().trim();
    const removed = this.suppressionList.delete(clean);
    if (removed) this.saveSuppression();
    return removed;
  }

  recordBounce({ email, senderEmail = '', campaignId = '', subject = '', reason = '', bounceType = 'Hard Bounce', rawSnippet = '', diagnosticCode = '' } = {}) {
    if (!email || !email.includes('@')) return null;

    const cleanRecipient = email.toLowerCase().trim();
    const now = new Date().toISOString();

    // Check if already recorded recently
    const existing = this.bounces.find(b => b.recipientEmail === cleanRecipient);
    if (existing) {
      existing.bounceCount = (existing.bounceCount || 1) + 1;
      existing.lastBouncedAt = now;
      existing.reason = reason || existing.reason;
      existing.diagnosticCode = diagnosticCode || existing.diagnosticCode;
      this.saveBounces();
      this.addToSuppression(cleanRecipient, reason);
      return existing;
    }

    const bounceEntry = {
      id: 'bnc-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      email: cleanRecipient,
      recipientEmail: cleanRecipient,
      senderEmail: (senderEmail || '').toLowerCase().trim(),
      campaignId: campaignId || '',
      subject: subject || 'Outreach Email',
      reason: reason || 'Address not found or mailbox rejected message',
      category: bounceType || 'Hard Bounce 550',
      bounceType: bounceType || 'Hard Bounce (User Unknown - 550)',
      diagnosticCode: diagnosticCode || '550 5.1.1',
      rawSnippet: (rawSnippet || '').substring(0, 300),
      rawBounceText: (rawSnippet || '').substring(0, 300),
      bounceCount: 1,
      timestamp: now,
      bouncedAt: now,
      lastBouncedAt: now,
      isSuppressed: true
    };

    this.bounces.unshift(bounceEntry);
    this.saveBounces();
    this.addToSuppression(cleanRecipient, reason);

    console.log(`⚠️ [BOUNCE DETECTED] ${cleanRecipient} bounced! Recorded into Bounced Leads dashboard.`);
    return bounceEntry;
  }

  // Parse incoming IMAP message to detect and extract bounce details
  parseBounceMessage(msg) {
    if (!msg) return null;

    const from = (msg.from || '').toLowerCase();
    const fromName = (msg.fromName || '').toLowerCase();
    const subject = (msg.subject || '').toLowerCase();
    const textBody = (msg.textBody || msg.snippet || '') + ' ' + (msg.htmlBody || '');

    const isBounceSender = 
      from.includes('mailer-daemon') ||
      from.includes('postmaster') ||
      from.includes('mail-delivery') ||
      from.includes('bounce') ||
      fromName.includes('mail delivery subsystem') ||
      fromName.includes('mail delivery system') ||
      fromName.includes('mailer-daemon');

    const isBounceSubject = 
      subject.includes('delivery status notification') ||
      subject.includes('undelivered mail') ||
      subject.includes('undeliverable') ||
      subject.includes('mail delivery failed') ||
      subject.includes('returned mail') ||
      subject.includes('failure notice') ||
      subject.includes('address not found') ||
      subject.includes('message blocked');

    if (!isBounceSender && !isBounceSubject) {
      return null;
    }

    // Extract target failed recipient email from body or subject
    let targetEmail = '';
    const emailRegexMatches = textBody.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g);
    if (emailRegexMatches) {
      for (const candidate of emailRegexMatches) {
        const cLower = candidate.toLowerCase();
        if (
          !cLower.includes('google.com') &&
          !cLower.includes('googlemail.com') &&
          !cLower.includes('mailer-daemon') &&
          !cLower.includes('postmaster') &&
          !cLower.includes('wix') &&
          cLower !== (msg.accountEmail || '').toLowerCase()
        ) {
          targetEmail = cLower;
          break;
        }
      }
    }

    // Classify bounce type and extract reason
    let bounceType = 'Hard Bounce (Address Rejected)';
    let diagnosticCode = '';
    let reason = 'Mailbox does not exist or address could not be found';

    if (textBody.includes('550 5.1.1') || textBody.includes('User unknown') || textBody.includes('does not exist')) {
      bounceType = 'Hard Bounce (User Unknown - 550)';
      diagnosticCode = '550 5.1.1';
      reason = 'The recipient mailbox does not exist on the destination mail server.';
    } else if (textBody.includes('Domain not found') || textBody.includes('DNS') || textBody.includes('Host not found') || textBody.includes('550-5.1.2')) {
      bounceType = 'Hard Bounce (Invalid Domain)';
      diagnosticCode = '550 5.1.2';
      reason = 'The destination domain or MX mail server does not exist.';
    } else if (textBody.includes('Mailbox full') || textBody.includes('Quota exceeded') || textBody.includes('552') || textBody.includes('452')) {
      bounceType = 'Soft Bounce (Mailbox Full)';
      diagnosticCode = '552 5.2.2';
      reason = 'The recipient inbox is currently over quota or full.';
    } else if (textBody.includes('blocked') || textBody.includes('Spam') || textBody.includes('554') || textBody.includes('5.7.1')) {
      bounceType = 'Blocked / Content Filtered';
      diagnosticCode = '554 5.7.1';
      reason = 'The receiving server rejected the message due to strict policy or blacklist.';
    } else if (textBody.includes('wasn\'t delivered to') || textBody.includes('couldn\'t be found')) {
      bounceType = 'Hard Bounce (Undeliverable)';
      reason = 'Google Mail could not find or route to this email address.';
    }

    if (targetEmail) {
      return this.recordBounce({
        email: targetEmail,
        senderEmail: msg.accountEmail || '',
        subject: msg.subject || 'Delivery Status Notification',
        reason,
        bounceType,
        diagnosticCode,
        rawSnippet: (msg.snippet || textBody).substring(0, 300)
      });
    }

    return null;
  }

  getBounces({ search = '', bounceType = 'all', accountEmail = '', limit = 100 } = {}) {
    let list = [...this.bounces];

    if (accountEmail && accountEmail.trim()) {
      const cleanAcc = accountEmail.toLowerCase().trim();
      list = list.filter(b => (b.senderEmail || '').toLowerCase() === cleanAcc);
    }

    if (bounceType && bounceType !== 'all') {
      const bTypeLower = bounceType.toLowerCase();
      list = list.filter(b => (b.bounceType || '').toLowerCase().includes(bTypeLower));
    }

    if (search && search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter(b => 
        (b.recipientEmail && b.recipientEmail.toLowerCase().includes(q)) ||
        (b.reason && b.reason.toLowerCase().includes(q)) ||
        (b.subject && b.subject.toLowerCase().includes(q)) ||
        (b.senderEmail && b.senderEmail.toLowerCase().includes(q)) ||
        (b.diagnosticCode && b.diagnosticCode.toLowerCase().includes(q))
      );
    }

    return {
      bounces: list.slice(0, limit),
      total: this.bounces.length,
      totalCount: this.bounces.length,
      filteredCount: list.length,
      stats: {
        total: this.bounces.length,
        hardBounces: this.bounces.filter(b => (b.bounceType || b.category || '').toLowerCase().includes('hard') || (b.bounceType || b.category || '').includes('550')).length,
        softBounces: this.bounces.filter(b => (b.bounceType || b.category || '').toLowerCase().includes('soft') || (b.bounceType || b.category || '').includes('552')).length,
        suppressionCount: this.suppressionList.size,
        blocked: this.bounces.filter(b => (b.bounceType || b.category || '').toLowerCase().includes('blocked') || (b.bounceType || b.category || '').includes('Invalid')).length
      },
      suppressedCount: this.suppressionList.size,
      hardBounceCount: this.bounces.filter(b => (b.bounceType || '').toLowerCase().includes('hard')).length,
      softBounceCount: this.bounces.filter(b => (b.bounceType || '').toLowerCase().includes('soft')).length,
      blockedCount: this.bounces.filter(b => (b.bounceType || '').toLowerCase().includes('blocked')).length
    };
  }

  deleteBounce(id) {
    const item = this.bounces.find(b => b.id === id);
    if (item) {
      this.bounces = this.bounces.filter(b => b.id !== id);
      this.saveBounces();
      return true;
    }
    return false;
  }

  clearAllBounces() {
    this.bounces = [];
    this.saveBounces();
    return true;
  }
}

module.exports = new BounceService();
