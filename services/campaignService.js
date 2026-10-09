const fs = require('fs');
const path = require('path');

const OUTREACH_LEADS_FILE = path.join(__dirname, '..', 'data', 'outreach_leads.json');

class CampaignService {
  constructor(emailService, aiEngine, discordService) {
    this.emailService = emailService;
    this.aiEngine = aiEngine;
    this.discordService = discordService;
    this.leads = [];
    this.isRunning = false;
    this.isPaused = false;
    this.currentCampaign = null;
    this.logs = [];
    this.loadLeads();
  }

  loadLeads() {
    if (fs.existsSync(OUTREACH_LEADS_FILE)) {
      try {
        this.leads = JSON.parse(fs.readFileSync(OUTREACH_LEADS_FILE, 'utf8'));
      } catch (e) {
        this.leads = [];
      }
    } else {
      this.leads = [];
      this.saveLeads();
    }
  }

  saveLeads() {
    try {
      fs.writeFileSync(OUTREACH_LEADS_FILE, JSON.stringify(this.leads, null, 2));
    } catch (e) {
      console.error('Error saving outreach leads:', e.message);
    }
  }

  getLeads() {
    return this.leads;
  }

  // Parses raw text (CSV, tab-separated from Google Sheets / Excel, or email lists)
  importRawLeads(rawText, defaultNiche = 'Property Management') {
    if (!rawText || !rawText.trim()) return { count: 0, leads: [] };

    const lines = rawText.split(/\r?\n/).filter(line => line.trim().length > 0);
    const newLeads = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Check if it's a header row
      if (i === 0 && (line.toLowerCase().includes('name') || line.toLowerCase().includes('email'))) {
        continue;
      }

      let name = '';
      let email = '';
      let company = '';
      let niche = defaultNiche;

      // Detect delimiter: tab, comma, or pipe
      let parts = [];
      if (line.includes('\t')) {
        parts = line.split('\t').map(p => p.trim());
      } else if (line.includes(',')) {
        parts = line.split(',').map(p => p.trim().replace(/^["']|["']$/g, ''));
      } else if (line.includes('|')) {
        parts = line.split('|').map(p => p.trim());
      } else {
        parts = [line];
      }

      if (parts.length === 1) {
        // Just an email or single string
        email = parts[0];
        name = email.split('@')[0];
      } else if (parts.length === 2) {
        // Name, Email OR Email, Company
        if (parts[0].includes('@')) {
          email = parts[0];
          company = parts[1];
          name = email.split('@')[0];
        } else {
          name = parts[0];
          email = parts[1];
        }
      } else if (parts.length >= 3) {
        name = parts[0];
        // Check which field is email
        if (parts[1].includes('@')) {
          email = parts[1];
          company = parts[2];
          if (parts[3]) niche = parts[3];
        } else if (parts[2].includes('@')) {
          company = parts[1];
          email = parts[2];
          if (parts[3]) niche = parts[3];
        } else {
          name = parts[0];
          email = parts[1];
          company = parts[2];
        }
      }

      if (email && email.includes('@')) {
        newLeads.push({
          id: 'lead-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
          name: name || email.split('@')[0],
          email: email.toLowerCase().trim(),
          company: company || 'Real Estate Partner',
          niche: niche || defaultNiche,
          status: 'ready',
          dateAdded: new Date().toISOString()
        });
      }
    }

    // Append new unique leads
    const existingEmails = new Set(this.leads.map(l => l.email.toLowerCase()));
    const filteredNew = newLeads.filter(l => !existingEmails.has(l.email));
    this.leads = [...filteredNew, ...this.leads];
    this.saveLeads();

    return {
      totalImported: newLeads.length,
      newUniqueAdded: filteredNew.length,
      skippedDuplicates: newLeads.length - filteredNew.length
    };
  }

  deleteLead(id) {
    this.leads = this.leads.filter(l => l.id !== id);
    this.saveLeads();
    return true;
  }

  clearLeads() {
    this.leads = [];
    this.saveLeads();
    return true;
  }

  resetAllLeadStatuses() {
    this.leads.forEach(l => l.status = 'ready');
    this.saveLeads();
  }

  getStatus() {
    const total = this.leads.length;
    const ready = this.leads.filter(l => l.status === 'ready').length;
    const sent = this.leads.filter(l => l.status === 'sent').length;
    const failed = this.leads.filter(l => l.status === 'failed').length;
    const senders = this.emailService.getSenders();

    const totalSenderCapacity = senders.reduce((acc, s) => acc + (s.dailyLimit || 50), 0);
    const totalSentToday = senders.reduce((acc, s) => acc + (s.sentToday || 0), 0);
    const totalRemainingCapacity = Math.max(0, totalSenderCapacity - totalSentToday);

    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      campaignProgress: this.currentCampaign,
      leadStats: { total, ready, sent, failed },
      senderStats: {
        totalAccounts: senders.length,
        totalDailyCapacity: totalSenderCapacity,
        sentToday: totalSentToday,
        remainingToday: totalRemainingCapacity
      },
      recentLogs: this.logs.slice(0, 50)
    };
  }

  // Start campaign dispatching with 50 limit per email and automatic account rotation
  async startCampaign({ subjectTemplate, bodyTemplate, useAI = true, delayMs = 3000, discordWebhookUrl = '' }) {
    if (this.isRunning) {
      return { success: false, error: 'Campaign is already running' };
    }

    const pendingLeads = this.leads.filter(l => l.status === 'ready');
    if (pendingLeads.length === 0) {
      return { success: false, error: 'No ready leads to send to. Please import leads or reset statuses.' };
    }

    this.isRunning = true;
    this.isPaused = false;
    this.currentCampaign = {
      total: pendingLeads.length,
      processed: 0,
      successful: 0,
      failed: 0,
      startTime: new Date().toISOString()
    };

    this.log(`🚀 Starting campaign for ${pendingLeads.length} leads with auto-rotation (50 messages / email account limit)...`);

    // Async execution loop
    (async () => {
      for (const lead of pendingLeads) {
        if (!this.isRunning) break;

        while (this.isPaused && this.isRunning) {
          await new Promise(r => setTimeout(r, 1000));
        }

        // 1. Get next available sender (checks sentToday < 50)
        const sender = this.emailService.getNextAvailableSender();
        if (!sender) {
          this.log(`⚠️ All connected email accounts have reached their 50 messages limit! Campaign paused. Connect more accounts or reset daily quotas.`);
          this.isRunning = false;
          break;
        }

        this.log(`📤 Preparing email for ${lead.name} (${lead.email}) using sender [${sender.email}] (Sent today: ${sender.sentToday}/${sender.dailyLimit})...`);

        // 2. Draft subject & pitch
        let subject = '';
        let body = '';

        if (useAI) {
          const aiPitch = await this.aiEngine.generateOutreachPitch(lead);
          subject = aiPitch.subject;
          body = aiPitch.pitch;
        } else {
          subject = (subjectTemplate || 'Quick idea for {{company}}')
            .replace(/\{\{name\}\}/gi, lead.name)
            .replace(/\{\{company\}\}/gi, lead.company)
            .replace(/\{\{niche\}\}/gi, lead.niche)
            .replace(/\{\{email\}\}/gi, lead.email);

          body = (bodyTemplate || 'Hi {{name}},\n\nNoticed {{company}} in the {{niche}} space. Would love to share our automation blueprint.\n\nBest,\nTimmy')
            .replace(/\{\{name\}\}/gi, lead.name)
            .replace(/\{\{company\}\}/gi, lead.company)
            .replace(/\{\{niche\}\}/gi, lead.niche)
            .replace(/\{\{email\}\}/gi, lead.email);
        }

        // 3. Dispatch email with specific sender account
        const sendResult = await this.emailService.sendEmailWithSender(sender, {
          to: lead.email,
          subject,
          text: body
        });

        if (sendResult.success) {
          lead.status = 'sent';
          lead.sentWith = sender.email;
          lead.sentAt = new Date().toISOString();
          lead.subject = subject;
          this.currentCampaign.successful++;
          this.log(`✅ Sent to ${lead.email} from [${sender.email}] (${sendResult.sentCount}/${sender.dailyLimit})`);

          // Discord Alert
          if (discordWebhookUrl) {
            this.discordService.sendOutreachAlert(discordWebhookUrl, {
              name: lead.name,
              company: lead.company,
              email: lead.email,
              niche: lead.niche,
              outreachSubject: subject
            }).catch(() => {});
          }
        } else {
          lead.status = 'failed';
          lead.error = sendResult.error;
          this.currentCampaign.failed++;
          this.log(`❌ Failed to send to ${lead.email} from [${sender.email}]: ${sendResult.error}`);
        }

        this.currentCampaign.processed++;
        this.saveLeads();

        // 4. Rate-limiting throttle delay
        if (delayMs > 0 && this.isRunning) {
          await new Promise(r => setTimeout(r, delayMs));
        }
      }

      this.isRunning = false;
      this.log(`🏁 Campaign execution finished! Total sent: ${this.currentCampaign.successful}, Failed: ${this.currentCampaign.failed}`);
    })();

    return { success: true, message: 'Campaign started' };
  }

  stopCampaign() {
    this.isRunning = false;
    this.isPaused = false;
    this.log('🛑 Campaign stopped by user.');
    return { success: true };
  }

  pauseCampaign() {
    this.isPaused = !this.isPaused;
    this.log(this.isPaused ? '⏸️ Campaign paused.' : '▶️ Campaign resumed.');
    return { success: true, isPaused: this.isPaused };
  }

  log(message) {
    const entry = {
      time: new Date().toLocaleTimeString(),
      text: message
    };
    this.logs.unshift(entry);
    if (this.logs.length > 200) this.logs.pop();
  }
}

module.exports = CampaignService;
