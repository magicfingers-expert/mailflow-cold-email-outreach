const https = require('https');
const { URL } = require('url');

class DiscordService {
  static async sendNotification(webhookUrl, payload) {
    if (!webhookUrl || !webhookUrl.trim() || !webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
      return { success: false, reason: 'Invalid or missing Discord Webhook URL' };
    }

    try {
      const parsedUrl = new URL(webhookUrl);
      const dataString = JSON.stringify(payload);

      return new Promise((resolve, reject) => {
        const req = https.request({
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(dataString)
          },
          timeout: 8000
        }, res => {
          let responseData = '';
          res.on('data', chunk => responseData += chunk);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ success: true, statusCode: res.statusCode });
            } else {
              resolve({ success: false, statusCode: res.statusCode, error: responseData });
            }
          });
        });

        req.on('error', (err) => resolve({ success: false, error: err.message }));
        req.on('timeout', () => {
          req.destroy();
          resolve({ success: false, error: 'Discord webhook request timed out' });
        });
        req.write(dataString);
        req.end();
      });
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  static async sendInboundLeadAlert(webhookUrl, lead) {
    const score = (lead.score || 'WARM').toUpperCase();
    
    // Color mapping: Red/Orange for HOT (0xFF4500 / 0xE74C3C), Gold for WARM (0xF1C40F), Blue/Cyan for COLD (0x3498DB)
    let color = 0xF1C40F;
    let emoji = '⭐';
    if (score === 'HOT') {
      color = 0xE74C3C;
      emoji = '🔥';
    } else if (score === 'COLD') {
      color = 0x3498DB;
      emoji = '❄️';
    }

    const discordPayload = {
      username: 'FlowLead AI Bot',
      avatar_url: 'https://cdn-icons-png.flaticon.com/512/4712/4712109.png',
      content: `${emoji} **NEW REAL ESTATE LEAD!**`,
      embeds: [
        {
          title: `🏡 Inbound Lead Qualified - ${lead.name}`,
          color: color,
          description: `**AI Rationale:** ${lead.rationale || 'Lead automatically scored and processed.'}`,
          fields: [
            { name: '👤 Name', value: lead.name || 'N/A', inline: true },
            { name: '✉️ Email', value: lead.email || 'N/A', inline: true },
            { name: '📱 Phone', value: lead.phone || 'N/A', inline: true },
            { name: '🎯 Looking For', value: lead.lookingFor || 'Property Search', inline: true },
            { name: '💰 Budget', value: lead.budget || 'Unspecified', inline: true },
            { name: '📍 Location / Area', value: lead.location || 'General', inline: true },
            { name: '⏳ Timeline', value: lead.timeline || 'Flexible', inline: true },
            { name: '🏆 Lead Score', value: `**${emoji} ${score}**`, inline: true },
            { name: '📨 Auto-Reply Status', value: lead.emailSent ? '✅ Sent via Gmail' : '⏳ Queued', inline: true }
          ],
          footer: {
            text: `FlowLead Automation Engine • ${new Date().toLocaleTimeString()}`
          },
          timestamp: new Date().toISOString()
        }
      ]
    };

    return await this.sendNotification(webhookUrl, discordPayload);
  }

  static async sendOutreachAlert(webhookUrl, outreach) {
    const discordPayload = {
      username: 'FlowLead AI Outreach',
      avatar_url: 'https://cdn-icons-png.flaticon.com/512/3062/3062634.png',
      content: `🚀 **COLD EMAIL SENT!**`,
      embeds: [
        {
          title: `✉️ Automated Pitch Delivered`,
          color: 0x9B59B6, // Purple
          fields: [
            { name: '👤 Contact Name', value: outreach.name || 'Prospect', inline: true },
            { name: '🏢 Company', value: outreach.company || 'Direct Prospect', inline: true },
            { name: '✉️ Email', value: outreach.email || 'N/A', inline: true },
            { name: '🎯 Niche / Sector', value: outreach.niche || 'Real Estate / Property Mgmt', inline: true },
            { name: '📌 Subject Line', value: outreach.outreachSubject || 'Quick inquiry', inline: false },
            { name: '⚡ Status', value: 'First email sent ✅', inline: true },
            { name: '⏰ Next Follow-up', value: 'Pending in 48hrs ⏰', inline: true }
          ],
          footer: {
            text: 'FlowLead Auto-Outreach System'
          },
          timestamp: new Date().toISOString()
        }
      ]
    };

    return await this.sendNotification(webhookUrl, discordPayload);
  }
}

module.exports = DiscordService;
