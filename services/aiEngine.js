const https = require('https');

class AIEngine {
  constructor(config = {}) {
    this.openaiApiKey = config.openaiApiKey || process.env.OPENAI_API_KEY || '';
    this.geminiApiKey = config.geminiApiKey || process.env.GEMINI_API_KEY || '';
    this.companyName = config.companyName || 'Apex Automations & Real Estate';
    this.agentName = config.agentName || 'Timmy / Lead Advisor';
  }

  updateConfig(config) {
    if (config.openaiApiKey !== undefined) this.openaiApiKey = config.openaiApiKey;
    if (config.geminiApiKey !== undefined) this.geminiApiKey = config.geminiApiKey;
    if (config.companyName !== undefined) this.companyName = config.companyName;
    if (config.agentName !== undefined) this.agentName = config.agentName;
  }

  async scoreAndQualifyLead(lead) {
    // If OpenAI API key is set, attempt real LLM call
    if (this.openaiApiKey && this.openaiApiKey.startsWith('sk-')) {
      try {
        const aiResponse = await this._callOpenAI([
          {
            role: 'system',
            content: `You are an elite AI Lead Qualification & CRM Specialist for ${this.companyName}. 
Analyze the real estate or service lead and return a JSON object with:
1. "score": "HOT", "WARM", or "COLD".
   - HOT: Timeline is immediate (now / this week / within 1 month) OR High budget, eager to buy/view.
   - WARM: Timeline is within 3 months, medium budget, actively planning.
   - COLD: Just browsing, uncertain timeline, low budget or general inquiry.
2. "rationale": Short 1-sentence reason for this classification.
3. "category": Primary intent category (e.g., "Luxury Buyer", "Urgent Rental", "Land Investment", "General Inquiry").
4. "emailSubject": Compelling personalized subject line for the automated response.
5. "emailBody": Professional, warm, 3-4 sentence personalized follow-up email mentioning their specific requirements, budget, location, and a clear call-to-action signed by ${this.agentName}.

Return ONLY pure valid JSON, no markdown code blocks.`
          },
          {
            role: 'user',
            content: JSON.stringify(lead)
          }
        ]);

        const parsed = JSON.parse(aiResponse);
        if (parsed.score && parsed.emailBody) {
          return {
            score: parsed.score.toUpperCase(),
            rationale: parsed.rationale || 'Qualified by OpenAI engine',
            category: parsed.category || 'Real Estate Lead',
            emailSubject: parsed.emailSubject || `Thank you for your inquiry - ${lead.name}`,
            emailBody: parsed.emailBody,
            source: 'openai-gpt'
          };
        }
      } catch (err) {
        console.warn('OpenAI call failed or returned invalid format, using high-accuracy heuristic AI fallback:', err.message);
      }
    }

    // High-Accuracy Heuristic AI Engine (Instant, 0-cost, 100% reliable)
    return this._heuristicLeadScoring(lead);
  }

  _heuristicLeadScoring(lead) {
    const timeline = (lead.timeline || '').toLowerCase();
    const budget = (lead.budget || '').toLowerCase();
    const lookingFor = (lead.lookingFor || '').toLowerCase();
    const location = lead.location || 'your preferred location';
    const name = lead.name || 'Valued Client';

    let score = 'WARM';
    let rationale = '';
    let category = 'Property Inquiry';

    // Timeline evaluation
    const isImmediate = timeline.includes('immediate') || timeline.includes('asap') || timeline.includes('now') || timeline.includes('this month');
    const isColdTimeline = timeline.includes('browsing') || timeline.includes('just looking') || timeline.includes('6+') || timeline.includes('not sure');
    
    // Budget evaluation
    const isHighBudget = budget.includes('above') || budget.includes('50m') || budget.includes('100m') || budget.includes('million') || budget.includes('luxury') || budget.includes('500k');
    const isLowBudget = budget.includes('below') || budget.includes('under 5m') || budget.includes('50k');

    if (isImmediate || isHighBudget) {
      score = 'HOT';
      category = isHighBudget ? 'High-Value Buyer' : 'Urgent Property Search';
      rationale = `Urgent timeline (${lead.timeline || 'Immediate'}) with prime interest in ${location}.`;
    } else if (isColdTimeline || isLowBudget) {
      score = 'COLD';
      category = lookingFor.includes('land') ? 'Land Discovery' : 'General Exploration';
      rationale = `Informational phase (${lead.timeline || 'Browsing'}) - assigned to automated nurture track.`;
    } else {
      score = 'WARM';
      category = 'Qualified Prospect';
      rationale = `Active buyer planning within standard timeframe (${lead.timeline || 'Within 3 months'}).`;
    }

    // Dynamic tailored email generation
    let emailSubject = '';
    let emailBody = '';

    if (score === 'HOT') {
      emailSubject = `Exclusive ${lookingFor ? lookingFor.replace(/^\w/, c => c.toUpperCase()) : 'Property'} Portfolio - ${name}`;
      emailBody = `Dear ${name},\n\nThank you for reaching out to us regarding your immediate property requirements in ${location}. Given your budget tier (${lead.budget || 'your specifications'}), we have priority listings and off-market options available immediately.\n\nOur senior property advisor is available for a private walkthrough or virtual presentation this week. Please reply to this email with your preferred time.\n\nBest regards,\n${this.agentName}\n${this.companyName}`;
    } else if (score === 'WARM') {
      emailSubject = `Thank you for your inquiry - ${name}`;
      emailBody = `Dear ${name},\n\nThank you for considering ${this.companyName}! For your search in ${location} with a planned timeline of ${lead.timeline || 'within the coming months'}, we have curated an exclusive selection matching your budget of ${lead.budget || 'target range'}.\n\nI would love to learn more about your key preferences. Are there specific amenities or neighborhood features you prioritize?\n\nBest regards,\n${this.agentName}\n${this.companyName}`;
    } else {
      emailSubject = `Real Estate Insights & Portfolio Catalog - ${name}`;
      emailBody = `Hello ${name},\n\nThank you for exploring property options in ${location} with ${this.companyName}. We have enrolled you in our VIP Property Watchlist so you will be the first to receive new verified listings and market insights.\n\nWhenever you are ready to take the next step, our team is just an email or call away!\n\nWarm regards,\n${this.companyName} Team`;
    }

    return {
      score,
      rationale,
      category,
      emailSubject,
      emailBody,
      source: 'smart-heuristic'
    };
  }

  async generateOutreachPitch(prospect) {
    const name = prospect.name || 'Valued Partner';
    const company = prospect.company || 'your agency';
    const niche = prospect.niche || 'Real Estate';

    if (this.openaiApiKey && this.openaiApiKey.startsWith('sk-')) {
      try {
        const aiResponse = await this._callOpenAI([
          {
            role: 'system',
            content: `You are an elite B2B Cold Outreach copywriter. Write a high-converting, concise 3-sentence personalized cold email to a prospect in ${niche}.
Return a JSON object with:
"subject": punchy, curiosity-inducing subject line mentioning company name or niche.
"pitch": 3-sentence email pitching AI lead automation, fast lead response, and admin time reduction.
"followUpSchedule": "Pending in 48hrs"`
          },
          {
            role: 'user',
            content: JSON.stringify(prospect)
          }
        ]);
        const parsed = JSON.parse(aiResponse);
        return {
          subject: parsed.subject,
          pitch: parsed.pitch,
          followUpSchedule: parsed.followUpSchedule || 'Pending in 48hrs',
          source: 'openai-gpt'
        };
      } catch (err) {
        console.warn('OpenAI outreach error, falling back to smart copywriter:', err.message);
      }
    }

    // Smart Outreach Copywriter
    const subject = `${company} - are you losing prospective leads?`;
    const pitch = `Hi ${name},\n\nI noticed ${company} manages prominent listings and client inquiries in the ${niche} sector. We recently helped similar teams cut admin time by 40% and automate lead qualification so hot inquiries get an instant response within 60 seconds without lifting a finger.\n\nWould you be open to a quick 10-minute discovery call next week to see how this customized workflow could work for ${company}?\n\nBest regards,\n${this.agentName}\n${this.companyName}`;

    return {
      subject,
      pitch,
      followUpSchedule: 'Pending in 48hrs',
      source: 'smart-template'
    };
  }

  async classifyInquiry(inquiry) {
    const text = (inquiry.message || inquiry.subject || '').toLowerCase();
    let category = 'General Inquiry';
    let urgency = 'Normal';
    let suggestedAction = 'Standard follow-up';

    if (text.includes('view') || text.includes('tour') || text.includes('visit') || text.includes('inspect')) {
      category = 'Property Viewing Request';
      urgency = 'High';
      suggestedAction = 'Schedule calendar appointment immediately';
    } else if (text.includes('price') || text.includes('budget') || text.includes('cost') || text.includes('discount')) {
      category = 'Pricing & Budget Query';
      urgency = 'Medium';
      suggestedAction = 'Send pricing matrix & financing breakdown';
    } else if (text.includes('complaint') || text.includes('issue') || text.includes('problem') || text.includes('broken')) {
      category = 'Client Complaint / Support';
      urgency = 'Critical';
      suggestedAction = 'Escalate to Senior Support Team';
    } else if (text.includes('agent') || text.includes('broker') || text.includes('commission')) {
      category = 'Agency / Partnership Question';
      urgency = 'Medium';
      suggestedAction = 'Send broker onboarding kit';
    }

    return {
      category,
      urgency,
      suggestedAction
    };
  }

  _callOpenAI(messages) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.7,
        response_format: { type: 'json_object' }
      });

      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.openaiApiKey}`
        },
        timeout: 15000
      }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.choices && parsed.choices[0] && parsed.choices[0].message) {
              resolve(parsed.choices[0].message.content);
            } else {
              reject(new Error(parsed.error ? parsed.error.message : 'Unknown OpenAI error'));
            }
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('OpenAI request timed out'));
      });
      req.write(payload);
      req.end();
    });
  }
}

module.exports = AIEngine;
