const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');
const path = require('path');
const bounceService = require('./bounceService');

const INBOX_CACHE_FILE = path.join(__dirname, '..', 'data', 'inbox_cache.json');

class InboxService {
  constructor(emailService, queueService) {
    this.emailService = emailService;
    this.queueService = queueService;
    this.messages = [];
    this.isSyncing = false;
    this.lastSyncTime = null;
    this.autoSyncTimer = null;
    this.loadCache();
    this.startBackgroundAutoSync(20000); // Automatically sync every 20 seconds
  }

  startBackgroundAutoSync(intervalMs = 20000) {
    if (this.autoSyncTimer) clearInterval(this.autoSyncTimer);
    // Initial sync after 3 seconds of server startup
    setTimeout(() => {
      this.syncAllAccounts({ folder: 'ALL' }).catch(() => {});
    }, 3000);

    this.autoSyncTimer = setInterval(async () => {
      if (!this.isSyncing) {
        try {
          await this.syncAllAccounts({ folder: 'ALL' });
        } catch (e) {
          // Silently handle background sync transient network hiccups
        }
      }
    }, intervalMs);
  }

  loadCache() {
    if (fs.existsSync(INBOX_CACHE_FILE)) {
      try {
        this.messages = JSON.parse(fs.readFileSync(INBOX_CACHE_FILE, 'utf8'));
      } catch (e) {
        this.messages = [];
      }
    }
  }

  saveCache() {
    try {
      fs.writeFileSync(INBOX_CACHE_FILE, JSON.stringify(this.messages, null, 2), 'utf8');
    } catch (e) {
      console.error('Error saving inbox_cache.json:', e.message);
    }
  }

  // Get filtered messages (by folder: INBOX, SPAM, SENT, or ALL; by account; by search)
  getMessages({ search = '', folder = 'all', accountEmail = '', limit = 100 } = {}) {
    let list = [...this.messages];

    // Filter by folder if specified
    if (folder && folder !== 'all') {
      const fUpper = folder.toUpperCase();
      list = list.filter(m => (m.folder || 'INBOX').toUpperCase() === fUpper);
    }

    // Filter by account email if specified
    if (accountEmail && accountEmail.trim()) {
      const cleanAcc = accountEmail.toLowerCase().trim();
      list = list.filter(m => (m.accountEmail || '').toLowerCase() === cleanAcc);
    }

    // Filter by search query
    if (search && search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter(m => 
        (m.from && m.from.toLowerCase().includes(q)) ||
        (m.fromName && m.fromName.toLowerCase().includes(q)) ||
        (m.to && m.to.toLowerCase().includes(q)) ||
        (m.subject && m.subject.toLowerCase().includes(q)) ||
        (m.snippet && m.snippet.toLowerCase().includes(q))
      );
    }

    const inboxCount = this.messages.filter(m => (m.folder || 'INBOX') === 'INBOX').length;
    const unreadInboxCount = this.messages.filter(m => (m.folder || 'INBOX') === 'INBOX' && !m.isRead).length;
    const spamCount = this.messages.filter(m => (m.folder || '') === 'SPAM').length;
    const sentCount = this.messages.filter(m => (m.folder || '') === 'SENT').length;
    const bouncedCount = this.messages.filter(m => (m.folder || '') === 'BOUNCED' || m.isBounce).length;

    return {
      messages: list.slice(0, limit),
      totalCount: list.length,
      allCachedCount: this.messages.length,
      unreadCount: unreadInboxCount,
      inboxCount,
      spamCount,
      sentCount,
      bouncedCount,
      lastSyncTime: this.lastSyncTime
    };
  }

  getMessageByUid(uid) {
    return this.messages.find(m => String(m.uid) === String(uid)) || null;
  }

  markAsRead(uid) {
    const msg = this.messages.find(m => String(m.uid) === String(uid));
    if (msg) {
      msg.isRead = true;
      this.saveCache();
      return true;
    }
    return false;
  }

  deleteMessage(uid) {
    this.messages = this.messages.filter(m => String(m.uid) !== String(uid));
    this.saveCache();
    return true;
  }

  // 1-Click Rescue message from SPAM to INBOX
  rescueSpamMessage(uid) {
    const msg = this.messages.find(m => String(m.uid) === String(uid));
    if (msg) {
      msg.folder = 'INBOX';
      msg.isSpam = false;
      msg.isRescued = true;
      msg.rescuedAt = new Date().toISOString();
      this.saveCache();
      return { success: true, message: msg };
    }
    return { success: false, error: 'Message not found' };
  }

  // Record a sent outreach or direct reply in SENT cache
  recordSentMessage({ senderEmail, to, subject, message, trackingId = null }) {
    if (!senderEmail || !to) return;
    const sentItem = {
      uid: `sent-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      messageId: `sent-${Date.now()}`,
      folder: 'SENT',
      accountEmail: senderEmail.toLowerCase().trim(),
      from: senderEmail.toLowerCase().trim(),
      fromName: senderEmail.split('@')[0],
      to: to.trim(),
      subject: subject || 'Outreach Email',
      date: new Date().toISOString(),
      isRead: true,
      isLeadReply: false,
      trackingId,
      snippet: (message || '').replace(/\r?\n|\r/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 160),
      textBody: message || '',
      htmlBody: `<pre style="font-family: inherit; white-space: pre-wrap;">${this.escapeHtml(message || '')}</pre>`
    };

    this.messages.unshift(sentItem);
    this.saveCache();
    return sentItem;
  }

  // Live IMAP sync for a specific account and folder
  async syncGmailAccount({ email, password, folder = 'INBOX', maxFetch = 30 } = {}) {
    let cleanEmail = (email || '').trim().toLowerCase();
    let cleanPass = this.emailService.cleanPassword(password);

    if (!cleanEmail || !cleanPass) {
      const acc = this.emailService.accounts.find(a => a.email && a.email.toLowerCase() === cleanEmail) 
               || this.emailService.accounts.find(a => a.isDefault) 
               || this.emailService.accounts[0];
      if (acc && acc.email) {
        if (!cleanEmail) cleanEmail = acc.email.toLowerCase().trim();
        cleanPass = this.emailService.getAccountPassword(acc);
      }
    }

    if (!cleanEmail || !cleanPass) {
      return {
        success: false,
        error: `Missing credentials for ${cleanEmail || 'selected account'}. Please check your App Password.`
      };
    }

    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: cleanEmail,
        pass: cleanPass
      },
      logger: false
    });

    // Handle asynchronous socket errors on the ImapFlow instance so ECONNRESET / TLS drops don't crash the server
    client.on('error', (err) => {
      console.warn(`[IMAP Socket Notice] ${cleanEmail}: ${err.message}`);
    });

    try {
      await client.connect();

      // Resolve Mailbox path for Gmail
      let targetMailbox = 'INBOX';
      let normalizedFolder = 'INBOX';

      if (folder.toUpperCase() === 'SPAM') {
        normalizedFolder = 'SPAM';
        targetMailbox = '[Gmail]/Spam';
      } else if (folder.toUpperCase() === 'SENT') {
        normalizedFolder = 'SENT';
        targetMailbox = '[Gmail]/Sent Mail';
      }

      let lock;
      try {
        lock = await client.getMailboxLock(targetMailbox);
      } catch (lockErr) {
        // Fallback for non-standard mailbox names
        if (normalizedFolder === 'SPAM') {
          targetMailbox = 'Spam';
          lock = await client.getMailboxLock(targetMailbox);
        } else if (normalizedFolder === 'SENT') {
          targetMailbox = 'Sent';
          lock = await client.getMailboxLock(targetMailbox);
        } else {
          throw lockErr;
        }
      }

      const fetchedList = [];

      try {
        const mailboxStatus = client.mailbox;
        const totalExists = mailboxStatus ? mailboxStatus.exists : 0;

        if (totalExists > 0) {
          const startSeq = Math.max(1, totalExists - maxFetch + 1);
          const range = `${startSeq}:${totalExists}`;

          for await (let message of client.fetch(range, { envelope: true, flags: true, source: true, uid: true })) {
            try {
              const parsed = await simpleParser(message.source);
              
              const fromAddr = (parsed.from && parsed.from.value && parsed.from.value[0]) 
                ? parsed.from.value[0].address 
                : (message.envelope.from && message.envelope.from[0] ? message.envelope.from[0].address : '');
              
              const fromName = (parsed.from && parsed.from.value && parsed.from.value[0]) 
                ? (parsed.from.value[0].name || fromAddr.split('@')[0]) 
                : (fromAddr.split('@')[0]);

              const isLeadReply = this.checkIfLeadReply(fromAddr);

              // Automated Bounce Detection & Extraction
              const bounceResult = bounceService.parseBounceMessage({
                from: fromAddr,
                fromName: fromName,
                subject: parsed.subject || '',
                snippet: parsed.text || '',
                textBody: parsed.text || '',
                htmlBody: parsed.html || '',
                accountEmail: cleanEmail
              });

              const isBounce = !!bounceResult;
              const msgFolder = isBounce ? 'BOUNCED' : normalizedFolder;

              const cleanSnippet = (parsed.text || parsed.textAsHtml || '')
                .replace(/\r?\n|\r/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .substring(0, 160);

              const isRead = message.flags ? message.flags.has('\\Seen') : false;

              fetchedList.unshift({
                uid: `${cleanEmail}-${msgFolder.toLowerCase()}-${message.uid}`,
                rawUid: message.uid,
                folder: msgFolder,
                messageId: parsed.messageId || `uid-${cleanEmail}-${message.uid}`,
                subject: parsed.subject || (msgFolder === 'SPAM' ? '(Filtered Lead Message)' : (isBounce ? '⚠️ Delivery Status Notification (Bounced)' : '(No Subject)')),
                from: fromAddr,
                fromName: fromName,
                accountEmail: cleanEmail,
                to: (parsed.to && parsed.to.text) || cleanEmail,
                date: (parsed.date || new Date()).toISOString(),
                isRead: normalizedFolder === 'SENT' ? true : isRead,
                isLeadReply,
                isSpam: normalizedFolder === 'SPAM',
                isBounce,
                bounceInfo: bounceResult,
                snippet: cleanSnippet,
                textBody: parsed.text || '',
                htmlBody: parsed.html || `<p>${this.escapeHtml(parsed.text || '')}</p>`
              });
            } catch (parseErr) {
              console.warn('Error parsing individual email MIME:', parseErr.message);
            }
          }
        }
      } finally {
        if (lock) lock.release();
      }

      await client.logout();

      // Merge into cache
      if (fetchedList.length > 0) {
        const existingMap = new Map(this.messages.map(m => [String(m.uid), m]));
        fetchedList.forEach(m => {
          if (existingMap.has(String(m.uid))) {
            const old = existingMap.get(String(m.uid));
            m.isRead = old.isRead;
            if (old.isRescued) {
              m.folder = 'INBOX';
              m.isSpam = false;
              m.isRescued = true;
            }
          }
          existingMap.set(String(m.uid), m);
        });

        this.messages = Array.from(existingMap.values())
          .sort((a, b) => new Date(b.date) - new Date(a.date));

        this.saveCache();
      }

      return {
        success: true,
        accountEmail: cleanEmail,
        folder: normalizedFolder,
        fetchedCount: fetchedList.length
      };

    } catch (err) {
      try { await client.logout(); } catch (e) {}
      let errMsg = err.message || 'IMAP Connection Error';
      if (
        errMsg.includes('535') || 
        errMsg.includes('BadCredentials') || 
        errMsg.includes('AUTHENTICATIONFAILED') || 
        errMsg.includes('Command failed') ||
        errMsg.includes('Invalid credentials') ||
        errMsg.includes('NO ') ||
        errMsg.includes('AUTHENTICATE')
      ) {
        errMsg = `Google IMAP Authentication Failed for ${cleanEmail}: Google rejected the login credentials. Please verify your 16-character App Password at myaccount.google.com/apppasswords and ensure IMAP is enabled in Gmail Settings.`;
      } else if (errMsg.includes('ENOTFOUND') || errMsg.includes('EAI_AGAIN') || errMsg.includes('ETIMEDOUT')) {
        errMsg = `Network timeout connecting to imap.gmail.com for ${cleanEmail}. Please check your connection.`;
      }
      return { success: false, accountEmail: cleanEmail, error: errMsg };
    }
  }

  // Sync all connected sender accounts across INBOX & SPAM
  async syncAllAccounts({ folder = 'INBOX' } = {}) {
    if (this.isSyncing) {
      return { success: false, message: 'Sync already in progress' };
    }

    this.isSyncing = true;
    const accounts = this.emailService.accounts.filter(a => a.email && a.password);

    if (accounts.length === 0) {
      this.isSyncing = false;
      return { success: false, error: 'No sender accounts with saved passwords found to sync.' };
    }

    const results = [];
    for (const acc of accounts) {
      const res = await this.syncGmailAccount({
        email: acc.email,
        password: acc.password,
        folder,
        maxFetch: 25
      });
      results.push(res);

      // Also sync Spam if requested or for full refresh
      if (folder === 'ALL') {
        const spamRes = await this.syncGmailAccount({
          email: acc.email,
          password: acc.password,
          folder: 'SPAM',
          maxFetch: 15
        });
        results.push(spamRes);
      }
    }

    this.lastSyncTime = new Date().toISOString();
    this.isSyncing = false;

    return {
      success: true,
      results,
      lastSyncTime: this.lastSyncTime,
      ...this.getMessages()
    };
  }

  // Check if sender email exists in campaigns recipients or outreach leads
  checkIfLeadReply(senderEmail) {
    if (!senderEmail || !senderEmail.includes('@')) return false;
    const clean = senderEmail.toLowerCase().trim();

    if (this.queueService && Array.isArray(this.queueService.campaigns)) {
      for (const camp of this.queueService.campaigns) {
        if (Array.isArray(camp.recipients)) {
          if (camp.recipients.some(r => r.email && r.email.toLowerCase().trim() === clean)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    })[m]);
  }
}

module.exports = InboxService;
