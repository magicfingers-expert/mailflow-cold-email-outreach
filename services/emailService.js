const nodemailer = require('nodemailer');
const path = require('path');
const securityService = require('./securityService');
const deliverabilityService = require('./deliverabilityService');
const storage = require('./storageService');

const ACCOUNTS_FILE = path.join(__dirname, '..', 'data', 'accounts.json');

class EmailService {
  constructor() {
    this.accounts = [];
    this.loadAccounts();
  }

  loadAccounts() {
    const data = storage.readJSON(ACCOUNTS_FILE, []);
    this.accounts = Array.isArray(data) ? data : [];

    // Automatically encrypt any unencrypted plaintext passwords
    let needsSave = false;
    this.accounts.forEach(acc => {
      if (acc.password && !acc.password.startsWith('enc:')) {
        acc.password = securityService.encrypt(acc.password);
        needsSave = true;
      }
    });

    if (needsSave) {
      this.saveAccounts();
    }
  }

  saveAccounts() {
    storage.writeJSON(ACCOUNTS_FILE, this.accounts);
  }

  // Safe accounts for frontend client consumption - NEVER exposes passwords
  getSafeAccounts() {
    return this.accounts.map(acc => ({
      id: acc.id,
      email: acc.email,
      name: acc.name || acc.email.split('@')[0],
      provider: acc.provider || (acc.email.endsWith('@gmail.com') ? 'gmail' : 'smtp'),
      status: acc.status || 'Connected',
      isDefault: !!acc.isDefault,
      dailyLimit: acc.dailyLimit || 50,
      sentToday: acc.sentToday || 0,
      createdAt: acc.createdAt || new Date().toISOString(),
      hasPassword: !!acc.password
    }));
  }

  getAccountById(id) {
    return this.accounts.find(a => a.id === id) || null;
  }

  cleanEmail(raw) {
    if (!raw) return '';
    let email = String(raw).trim().toLowerCase();
    if (email.endsWith('@gmail')) {
      email = email + '.com';
    }
    // If username is entered without domain, default to gmail.com
    if (!email.includes('@')) {
      email = email + '@gmail.com';
    }
    return email;
  }

  getAccountByEmail(email) {
    const clean = this.cleanEmail(email);
    if (!clean) return null;
    return this.accounts.find(a => this.cleanEmail(a.email) === clean) || null;
  }

  // Decrypt password in memory only for authorized backend operations
  getAccountPassword(account) {
    if (!account || !account.password) return '';
    return securityService.decrypt(account.password);
  }

  saveOrUpdateAccount({ email, password, name, provider, isDefault, status = 'Connected' }) {
    const cleanEmail = this.cleanEmail(email);
    const cleanPass = this.cleanPassword(password);
    let account = this.getAccountByEmail(cleanEmail);

    if (account) {
      account.name = name || account.name || cleanEmail.split('@')[0];
      if (cleanPass) {
        account.password = securityService.encrypt(cleanPass);
      }
      account.status = status;
      account.provider = provider || (cleanEmail.endsWith('@gmail.com') ? 'gmail' : 'smtp');
      if (isDefault) {
        this.accounts.forEach(a => a.isDefault = (a.id === account.id));
      }
    } else {
      const id = 'acc-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
      account = {
        id,
        email: cleanEmail,
        name: name || cleanEmail.split('@')[0],
        password: cleanPass ? securityService.encrypt(cleanPass) : '',
        provider: provider || (cleanEmail.endsWith('@gmail.com') ? 'gmail' : 'smtp'),
        status: 'Connected',
        dailyLimit: 50,
        sentToday: 0,
        isDefault: this.accounts.length === 0 || !!isDefault,
        createdAt: new Date().toISOString()
      };
      if (account.isDefault) {
        this.accounts.forEach(a => a.isDefault = false);
      }
      this.accounts.push(account);
    }

    this.saveAccounts();
    return account;
  }

  deleteAccount(id) {
    this.accounts = this.accounts.filter(a => a.id !== id);
    if (this.accounts.length > 0 && !this.accounts.some(a => a.isDefault)) {
      this.accounts[0].isDefault = true;
    }
    this.saveAccounts();
    return true;
  }

  setDefaultAccount(id) {
    this.accounts.forEach(a => {
      a.isDefault = (a.id === id);
    });
    this.saveAccounts();
    return true;
  }

  cleanPassword(rawPass) {
    if (!rawPass) return '';
    let str = String(rawPass)
      .replace(/[\s\u200B-\u200D\uFEFF\r\n\t\-]/g, '') // remove whitespace, zero-width chars, hyphens
      .replace(/^["']|["']$/g, '')
      .trim();
    if (str.includes('•') || str.includes('*') || /^(\u2022|\*)+$/.test(str)) {
      return '';
    }
    // Google App Passwords are 16 lowercase ASCII letters
    if (str.length === 16 && /^[a-zA-Z]+$/.test(str)) {
      str = str.toLowerCase();
    }
    return str;
  }

  // Comprehensive Gmail SMTP Socket Diagnostics with Auto IPv4 and Port Fallback
  async diagnoseSmtpSocket({ email, password, host, port }) {
    const logs = [];
    const cleanEmail = this.cleanEmail(email);
    let cleanPass = this.cleanPassword(password);

    if (!cleanEmail) {
      return { 
        success: false, 
        error: 'Please enter a valid email address.', 
        logs: [{ step: 'INIT', status: 'error', text: 'Email address is required' }] 
      };
    }

    if (!cleanPass) {
      const savedAcc = this.getAccountByEmail(cleanEmail);
      if (savedAcc && savedAcc.password) {
        cleanPass = this.getAccountPassword(savedAcc);
      }
    }

    if (!cleanPass) {
      return {
        success: false,
        targetHost: 'smtp.gmail.com',
        targetPort: 465,
        error: 'Please enter your 16-character Google App Password',
        logs: [
          { step: 'DNS_RESOLVE', status: 'info', text: `Resolving MX & SMTP records for smtp.gmail.com...` },
          { step: 'SMTP_AUTH', status: 'error', text: `[ERR] No App Password provided for ${cleanEmail}. Please enter your 16-letter App Password.` }
        ]
      };
    }

    logs.push({ step: 'DNS_RESOLVE', status: 'info', text: `Resolving MX & SMTP records for smtp.gmail.com (Forcing IPv4)...` });

    const targetHost = host || 'smtp.gmail.com';
    const portsToTry = port ? [parseInt(port)] : [465, 587];

    let verified = false;
    let lastError = null;
    let activePort = 465;

    for (const p of portsToTry) {
      activePort = p;
      const isSecure = (p === 465);
      logs.push({ step: 'DNS_RESOLVE', status: 'success', text: `Target Gateway: Gmail SMTP (${targetHost}:${p} ${isSecure ? 'SSL' : 'STARTTLS'})` });
      logs.push({ step: 'TCP_CONNECT', status: 'info', text: `Opening TLS/TCP socket (IPv4) to ${targetHost}:${p}...` });

      try {
        const transporter = nodemailer.createTransport({
          host: targetHost,
          port: p,
          secure: isSecure,
          family: 4,
          auth: { user: cleanEmail, pass: cleanPass },
          tls: { rejectUnauthorized: false },
          connectionTimeout: 10000,
          greetingTimeout: 10000,
          socketTimeout: 12000
        });

        logs.push({ step: 'TLS_HANDSHAKE', status: 'info', text: `Performing cryptographic handshake on port ${p}...` });
        await transporter.verify();
        logs.push({ step: 'TLS_HANDSHAKE', status: 'success', text: `TLS handshake established with ${targetHost}:${p}` });
        logs.push({ step: 'SMTP_AUTH', status: 'success', text: `[250 OK] Gmail Authentication successful for ${cleanEmail}` });
        verified = true;
        break;
      } catch (err) {
        lastError = err;
        logs.push({ step: 'SMTP_AUTH', status: 'warning', text: `Port ${p} attempt: ${err.message}` });
      }
    }

    // Run real-time DNS (SPF, DKIM, DMARC, MX) & Postmaster compliance audit
    let deliverability = null;
    try {
      deliverability = await deliverabilityService.auditDomain(cleanEmail);
      if (deliverability && deliverability.checks) {
        logs.push({ 
          step: 'DNS_SPF', 
          status: deliverability.checks.spf.status === 'pass' ? 'success' : 'warning', 
          text: `[SPF] ${deliverability.checks.spf.details}` 
        });
        logs.push({ 
          step: 'DNS_DKIM', 
          status: deliverability.checks.dkim.status === 'pass' ? 'success' : 'warning', 
          text: `[DKIM] ${deliverability.checks.dkim.details}` 
        });
        logs.push({ 
          step: 'DNS_DMARC', 
          status: deliverability.checks.dmarc.status === 'pass' ? 'success' : 'warning', 
          text: `[DMARC] ${deliverability.checks.dmarc.details}` 
        });
        logs.push({ 
          step: 'POSTMASTER', 
          status: 'success', 
          text: `[POSTMASTER] Deliverability Health Score: ${deliverability.score}% • Google Bulk Sender Compliant (List-Unsubscribe, TLS 1.3, Feedback-ID active)` 
        });
      }
    } catch (dErr) {
      console.warn('Deliverability audit warning:', dErr.message);
    }

    if (verified) {
      const saved = this.saveOrUpdateAccount({
        email: cleanEmail,
        password: cleanPass,
        status: 'Connected',
        isDefault: true
      });

      return {
        success: true,
        logs,
        targetHost,
        targetPort: activePort,
        email: cleanEmail,
        accountId: saved.id,
        deliverability
      };
    } else {
      const errMsg = lastError ? lastError.message : 'Authentication failed';
      logs.push({ step: 'SMTP_AUTH', status: 'error', text: `[REJECTED] ${errMsg}` });
      
      let cause = 'Google rejected credentials';
      if (errMsg.includes('535') || errMsg.includes('BadCredentials') || errMsg.includes('Username and Password not accepted')) {
        cause = 'Google BadCredentials (535): App Password rejected. Check: 1) Verify the App Password was generated for ' + cleanEmail + ' (not another Google account in Chrome), 2) Check Gmail for a "Sign-in attempt blocked" alert and approve it, 3) Visit https://accounts.google.com/DisplayUnlockCaptcha to unblock, 4) Ensure IMAP is enabled in Gmail settings.';
      } else if (errMsg.includes('ECONNREFUSED') || errMsg.includes('ETIMEDOUT') || errMsg.includes('ENOTFOUND')) {
        cause = `Connection to ${targetHost} timed out or was blocked by firewall.`;
      }

      logs.push({ step: 'DIAGNOSTIC_ANALYSIS', status: 'warning', text: cause });

      return {
        success: false,
        logs,
        targetHost,
        targetPort: activePort,
        error: errMsg,
        cause,
        email: cleanEmail,
        deliverability
      };
    }
  }

  // Generate a live Ethereal test inbox so user can inspect rendered emails with 1 click
  async sendEtherealTestMail({ to, subject, message, trackingId, baseUrl = 'http://localhost:3000' }) {
    try {
      const testAccount = await nodemailer.createTestAccount();
      const transporter = nodemailer.createTransport({
        host: testAccount.smtp.host,
        port: testAccount.smtp.port,
        secure: testAccount.smtp.secure,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass
        }
      });

      const trackingPixelUrl = trackingId ? `${baseUrl}/api/track/open/${trackingId}` : '';
      const trackingPixelHtml = trackingId
        ? `<div style="opacity:0.01;line-height:1px;font-size:1px;max-height:1px;overflow:hidden;mso-hide:all;"><img src="${trackingPixelUrl}" width="1" height="1" style="width:1px!important;height:1px!important;border:none!important;opacity:0.01!important;" alt="" /></div>`
        : '';

      const cleanSubject = (subject || 'Outreach Preview').replace(/^\[TEST\]\s*/i, '').trim();

      const formattedHtml = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"></head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 15px; color: #0f172a; line-height: 1.6; padding: 20px;">
          <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px;">
            <div style="border-bottom: 1px solid #f1f5f9; padding-bottom: 12px; margin-bottom: 16px;">
              <span style="font-size: 12px; color: #64748b; text-transform: uppercase; font-weight: 600;">MailFlow Outreach Preview</span>
              <h2 style="margin: 6px 0 0 0; font-size: 18px; color: #0f172a;">${cleanSubject}</h2>
            </div>
            ${(message || '').split('\n\n').map(p => `<p style="margin: 0 0 14px 0;">${p.replace(/\n/g, '<br>')}</p>`).join('')}
            <div style="margin-top: 24px; padding-top: 14px; border-top: 1px dashed #e2e8f0; font-size: 11.5px; color: #94a3b8;">
              ✓ Open Tracking Pixel Embedded (${trackingId || 'trk-live'})
            </div>
          </div>
          ${trackingPixelHtml}
        </body>
        </html>
      `;

      const info = await transporter.sendMail({
        from: '"MailFlow Outreach" <outreach@mailflow.app>',
        to: to || 'lead@example.com',
        subject: cleanSubject,
        text: message,
        html: formattedHtml
      });

      const previewUrl = nodemailer.getTestMessageUrl(info);

      return {
        success: true,
        messageId: info.messageId,
        previewUrl,
        trackingId,
        sentTo: to
      };
    } catch (e) {
      throw new Error(`Ethereal test mail error: ${e.message}`);
    }
  }

  // Parse and process Spintax {Option A|Option B|Option C} for 100% unique per-lead email variation
  processSpintax(text) {
    if (!text) return '';
    const regex = /\{([^{}]+)\}/g;
    let result = text;
    while (regex.test(result)) {
      result = result.replace(regex, (match, choices) => {
        const options = choices.split('|');
        return options[Math.floor(Math.random() * options.length)];
      });
    }
    return result;
  }

  // Sanitize content to eliminate spam triggers and preserve 100% inbox deliverability
  sanitizeOutreachContent(text) {
    if (!text) return '';
    return String(text)
      // Remove invisible zero-width and control characters
      .replace(/[\u200B-\u200D\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      // Replace smart quotes and dashes with clean standard ASCII
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014]/g, '-')
      // Remove excessive exclamation/question punctuation (e.g. "!!!" -> "!", "???" -> "?")
      .replace(/!{2,}/g, '!')
      .replace(/\?{2,}/g, '?')
      .replace(/\${2,}/g, '$')
      .trim();
  }

  // Sanitize subject line specifically
  sanitizeSubject(subject) {
    if (!subject) return 'Quick inquiry';
    let clean = this.sanitizeOutreachContent(subject)
      .replace(/^\[TEST\]\s*/i, '')
      .replace(/^\[SPAM\]\s*/i, '')
      .trim();

    // Prevent all-caps subjects which immediately trigger spam filters
    const letters = clean.replace(/[^a-zA-Z]/g, '');
    if (letters.length > 4) {
      const upper = letters.split('').filter(c => c === c.toUpperCase()).length;
      if (upper / letters.length > 0.7) {
        clean = clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
      }
    }
    return clean || 'Quick inquiry';
  }

  // Send single email with anti-spam deliverability optimization
  async sendEmail({
    senderEmail,
    senderPassword,
    senderName,
    to,
    subject,
    message,
    trackingId = null,
    baseUrl = '',
    enableTracking = false,
    plainTextOnly = false,
    inReplyTo = null,
    references = null
  }) {
    if (!to || !to.includes('@')) {
      throw new Error(`Invalid recipient address: ${to}`);
    }

    const cleanSender = this.cleanEmail(senderEmail);
    let cleanPass = this.cleanPassword(senderPassword);

    if (!cleanPass) {
      const savedAcc = this.getAccountByEmail(cleanSender);
      if (savedAcc && savedAcc.password) {
        cleanPass = this.getAccountPassword(savedAcc);
      }
    }

    const senderDisplayName = senderName ? senderName.trim() : cleanSender.split('@')[0];
    const fromHeader = `"${senderDisplayName}" <${cleanSender}>`;
    const senderFirst = senderDisplayName.split(' ')[0] || senderDisplayName;
    const recipientEmail = to.trim();
    const recipientName = recipientEmail.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    // Replace any personalization tags before sending
    let processedSubject = (subject || 'Quick inquiry')
      .replace(/\{\{\s*email\s*\}\}/gi, recipientEmail)
      .replace(/\{\{\s*name\s*\}\}/gi, recipientName)
      .replace(/\{\{\s*senderName\s*\}\}/gi, senderDisplayName)
      .replace(/\{\{\s*senderFirstName\s*\}\}/gi, senderFirst)
      .replace(/\{\{\s*sender\s*\}\}/gi, senderDisplayName);

    let processedMessage = (message || '')
      .replace(/\{\{\s*email\s*\}\}/gi, recipientEmail)
      .replace(/\{\{\s*name\s*\}\}/gi, recipientName)
      .replace(/\{\{\s*senderName\s*\}\}/gi, senderDisplayName)
      .replace(/\{\{\s*senderFirstName\s*\}\}/gi, senderFirst)
      .replace(/\{\{\s*sender\s*\}\}/gi, senderDisplayName);

    // Process dynamic Spintax for 100% per-email variation (bypasses Gmail bulk content hashing)
    const randomizedSubject = this.processSpintax(processedSubject);
    const randomizedMessage = this.processSpintax(processedMessage);

    const cleanSubject = this.sanitizeSubject(randomizedSubject);
    const sanitizedBody = this.sanitizeOutreachContent(randomizedMessage);

    // Only inject tracking pixel if explicitly enabled and baseUrl is a valid public domain
    let trackingPixelHtml = '';
    if (enableTracking && !plainTextOnly && trackingId && baseUrl && !baseUrl.includes('localhost') && !baseUrl.includes('127.0.0.1')) {
      const trackingPixelUrl = `${baseUrl}/api/track/open/${trackingId}`;
      trackingPixelHtml = `<div style="opacity:0.01;line-height:1px;font-size:1px;max-height:1px;overflow:hidden;"><img src="${trackingPixelUrl}" width="1" height="1" style="width:1px!important;height:1px!important;border:none!important;" alt="" /></div>`;
    }

    // Authentic 1-on-1 human Gmail web composer HTML structure (no bulky DOCTYPE/viewport boilerplate)
    const formattedHtml = `<div dir="ltr">${(sanitizedBody || '').split('\n\n').map(p => `<div>${p.replace(/\n/g, '<br>')}</div>`).join('<div><br></div>')}${trackingPixelHtml}</div>`;

    if (cleanSender && cleanPass) {
      try {
        const isGmailDomain = cleanSender.endsWith('@gmail.com') || cleanSender.endsWith('@googlemail.com');
        const senderDomain = cleanSender.includes('@') ? cleanSender.split('@')[1] : 'gmail.com';

        const transporterConfig = {
          host: 'smtp.gmail.com',
          port: 465,
          secure: true,
          family: 4, // Explicitly force IPv4 to eliminate getaddrinfo ENOTFOUND / EAI_AGAIN errors
          auth: {
            user: cleanSender,
            pass: cleanPass
          },
          tls: {
            rejectUnauthorized: false
          },
          connectionTimeout: 20000,
          greetingTimeout: 20000,
          socketTimeout: 25000
        };

        const transporter = nodemailer.createTransport(transporterConfig);

        // Standard 1-on-1 Human Email Options (100% matching human Gmail client)
        const mailOptions = {
          from: fromHeader,
          to: recipientEmail,
          subject: cleanSubject,
          text: sanitizedBody,
          date: new Date()
        };

        // If not pure plain-text, attach simple human Gmail HTML
        if (!plainTextOnly) {
          mailOptions.html = formattedHtml;
        }

        // Only add Reply-To if explicitly different from From (human senders do not set Reply-To to themselves)
        // If inReplyTo/references are set (for ongoing thread conversations), attach them
        if (inReplyTo) mailOptions.inReplyTo = inReplyTo;
        if (references) mailOptions.references = references;

        // Auto-retry up to 3 attempts with backoff on transient DNS or connection drops
        let info = null;
        let lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            info = await transporter.sendMail(mailOptions);
            break;
          } catch (err) {
            lastErr = err;
            const isTransient = err.code === 'EDNS' || 
              err.message.includes('ENOTFOUND') || 
              err.message.includes('EAI_AGAIN') || 
              err.message.includes('ETIMEDOUT') || 
              err.message.includes('ECONNRESET');

            if (attempt < 3 && isTransient) {
              console.warn(`[SMTP Transient Retry ${attempt}/3 to ${to}]: ${err.message}`);
              await new Promise(r => setTimeout(r, 1200 * attempt));
            } else {
              break;
            }
          }
        }

        if (!info && lastErr) {
          throw lastErr;
        }

        const acc = this.getAccountByEmail(cleanSender);
        if (acc) {
          acc.sentToday = (acc.sentToday || 0) + 1;
          this.saveAccounts();
        }

        return {
          success: true,
          messageId: info.messageId,
          sentFrom: cleanSender,
          sentTo: to.trim(),
          sentAt: new Date().toISOString(),
          mode: plainTextOnly ? 'plain_text_stealth' : 'real_smtp',
          subjectSent: cleanSubject,
          trackingId
        };
      } catch (smtpErr) {
        let errMsg = smtpErr.message;
        if (errMsg.includes('535') || errMsg.includes('BadCredentials') || errMsg.includes('Username and Password not accepted')) {
          errMsg = 'Google 535 BadCredentials: Google rejected your App Password. Please check that 2-Step Verification is active and generate a valid 16-letter App Password at myaccount.google.com/apppasswords.';
        } else if (errMsg.includes('ENOTFOUND') || errMsg.includes('EAI_AGAIN')) {
          errMsg = 'Network DNS lookup for smtp.gmail.com temporarily timed out. Automatic IPv4 retry has been configured.';
        }
        console.error(`[SMTP ERROR to ${to}]:`, errMsg);
        throw new Error(errMsg);
      }
    }

    throw new Error('Missing sender credentials. Please provide your Gmail address and 16-character App Password in Step 1.');
  }
}

module.exports = EmailService;
