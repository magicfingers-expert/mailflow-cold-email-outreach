class BlueprintService {
  static getMakeComInboundBlueprint(webhookUrl = 'https://your-webhook-receiver.com') {
    return {
      name: "FlowLead Real Estate AI Lead Qualification & Discord Alert",
      flow: [
        {
          id: 1,
          module: "gateway:CustomWebHook",
          version: 1,
          parameters: {
            hook: 12345
          },
          metadata: {
            designer: { x: 0, y: 0 },
            restore: { extra: { type: "webhook" } },
            label: "1. Inbound Tally/Typeform Webhook"
          }
        },
        {
          id: 2,
          module: "openai:createChatCompletion",
          version: 1,
          parameters: {
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: "Score real estate lead: HOT, WARM, COLD based on timeline and budget. Return JSON with score, rationale, and personalized email body."
              },
              {
                role: "user",
                content: "Name: {{1.data.name}}, Email: {{1.data.email}}, Budget: {{1.data.budget}}, Timeline: {{1.data.timeline}}, Area: {{1.data.location}}"
              }
            ]
          },
          metadata: {
            designer: { x: 300, y: 0 },
            label: "2. OpenAI Lead Scoring & Email Copywriter"
          }
        },
        {
          id: 3,
          module: "airtable:createRecord",
          version: 1,
          parameters: {
            base: "Real Estate CRM",
            table: "Leads",
            fields: {
              "Name": "{{1.data.name}}",
              "Email": "{{1.data.email}}",
              "Phone": "{{1.data.phone}}",
              "Budget": "{{1.data.budget}}",
              "Location": "{{1.data.location}}",
              "Timeline": "{{1.data.timeline}}",
              "Lead Score": "{{2.data.score}}"
            }
          },
          metadata: {
            designer: { x: 600, y: -100 },
            label: "3. Airtable CRM Log"
          }
        },
        {
          id: 4,
          module: "discord:sendChannelMessage",
          version: 1,
          parameters: {
            content: "🔥 NEW REAL ESTATE LEAD!\nName: {{1.data.name}}\nEmail: {{1.data.email}}\nPhone: {{1.data.phone}}\nBudget: {{1.data.budget}}\nArea: {{1.data.location}}\nTimeline: {{1.data.timeline}}\nLead Score: {{2.data.score}}"
          },
          metadata: {
            designer: { x: 900, y: -100 },
            label: "4. Discord #leads Alert"
          }
        },
        {
          id: 5,
          module: "google-email:sendEmail",
          version: 1,
          parameters: {
            to: "{{1.data.email}}",
            subject: "Thank you for your inquiry - {{1.data.name}}",
            content: "{{2.data.emailBody}}"
          },
          metadata: {
            designer: { x: 900, y: 100 },
            label: "5. Gmail Automated Response"
          }
        }
      ],
      metadata: {
        version: 1,
        author: "FlowLead AI Studio",
        description: "Zero-friction real estate qualification, CRM sync, Discord ping, and Gmail dispatcher."
      }
    };
  }

  static getN8nInboundBlueprint() {
    return {
      name: "FlowLead Real Estate AI Automation (n8n)",
      nodes: [
        {
          parameters: {
            httpMethod: "POST",
            path: "lead-intake",
            options: {}
          },
          name: "Webhook Trigger",
          type: "n8n-nodes-base.webhook",
          typeVersion: 1,
          position: [100, 300]
        },
        {
          parameters: {
            model: "gpt-4o-mini",
            prompt: "Qualify lead and output JSON with score and reply email."
          },
          name: "OpenAI Lead Qualifier",
          type: "@n8n/n8n-nodes-langchain.agent",
          typeVersion: 1,
          position: [350, 300]
        },
        {
          parameters: {
            webhookUri: "https://discord.com/api/webhooks/YOUR_WEBHOOK",
            text: "🔥 New Real Estate Lead Scored!"
          },
          name: "Discord Notification",
          type: "n8n-nodes-base.discord",
          typeVersion: 1,
          position: [600, 200]
        },
        {
          parameters: {
            toEmail: "={{$json.email}}",
            subject: "Regarding your property inquiry",
            message: "={{$json.aiReply}}"
          },
          name: "Send Email (Gmail)",
          type: "n8n-nodes-base.gmail",
          typeVersion: 2,
          position: [600, 400]
        }
      ],
      connections: {
        "Webhook Trigger": {
          main: [[{ node: "OpenAI Lead Qualifier", type: "main", index: 0 }]]
        },
        "OpenAI Lead Qualifier": {
          main: [
            [{ node: "Discord Notification", type: "main", index: 0 }],
            [{ node: "Send Email (Gmail)", type: "main", index: 0 }]
          ]
        }
      }
    };
  }
}

module.exports = BlueprintService;
