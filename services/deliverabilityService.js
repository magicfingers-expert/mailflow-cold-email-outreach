const dns = require('dns').promises;
const securityService = require('./securityService');

class DeliverabilityService {
  constructor() {
    this.cache = new Map();
  }

  extractDomain(emailOrDomain) {
    if (!emailOrDomain) return '';
    const clean = String(emailOrDomain).trim().toLowerCase();
    if (clean.includes('@')) {
      return clean.split('@')[1].trim();
    }
    return clean;
  }

  isStandardGmail(domain) {
    return domain === 'gmail.com' || domain === 'googlemail.com';
  }

  async auditDomain(emailOrDomain) {
    const domain = this.extractDomain(emailOrDomain);
    if (!domain || !domain.includes('.')) {
      return {
        success: false,
        domain: domain || 'unknown',
        error: 'Invalid domain format'
      };
    }

    // Check in-memory cache (TTL: 2 minutes)
    const cached = this.cache.get(domain);
    if (cached && (Date.now() - cached.timestamp < 120000)) {
      return cached.data;
    }

    const audit = {
      domain,
      isGmail: this.isStandardGmail(domain),
      auditedAt: new Date().toISOString(),
      score: 100,
      checks: {
        spf: { status: 'checking', value: null, isGoogleAligned: false, details: '' },
        dkim: { status: 'checking', selector: null, value: null, isGoogleAligned: false, details: '' },
        dmarc: { status: 'checking', policy: null, value: null, isCompliant: false, details: '' },
        mx: { status: 'checking', records: [], isGoogleMx: false, details: '' },
        postmaster: { status: 'ready', complianceScore: 100, recommendations: [] }
      },
      recommendedDnsRecords: [],
      googlePostmasterUrl: `https://postmaster.google.com/`,
      mxToolboxUrl: `https://mxtoolbox.com/emailhealth/${domain}/`
    };

    // -------------------------------------------------------------
    // LIVE DNS AUDIT (SPF, DMARC, DKIM, MX)
    // -------------------------------------------------------------
    try {
      // --- SPF Check ---
      try {
        const txtRecords = await dns.resolveTxt(domain);
        const spfRecord = txtRecords.flat().find(r => r.startsWith('v=spf1'));
        if (spfRecord) {
          const isGoogle = spfRecord.includes('_spf.google.com') || spfRecord.includes('google.com') || spfRecord.includes('redirect=');
          audit.checks.spf = {
            status: 'pass',
            value: spfRecord,
            isGoogleAligned: isGoogle,
            details: isGoogle 
              ? '✓ Valid SPF record found with Google authorized routing.' 
              : '✓ SPF record found. (For Google SMTP, include:_spf.google.com is recommended).'
          };
          if (!isGoogle && audit.isGmail) audit.score -= 5;
        } else {
          audit.checks.spf = {
            status: 'missing',
            value: null,
            isGoogleAligned: false,
            details: '⚠️ No SPF TXT record found on your domain. Gmail may flag emails as spoofed without SPF.'
          };
          audit.score -= 25;
          audit.recommendedDnsRecords.push({
            type: 'TXT',
            host: '@ (or domain root)',
            value: 'v=spf1 include:_spf.google.com ~all',
            purpose: 'Authorizes Google SMTP servers to send on behalf of your domain'
          });
        }
      } catch (e) {
        audit.checks.spf = {
          status: 'missing',
          value: null,
          isGoogleAligned: false,
          details: '⚠️ SPF lookup returned no TXT records.'
        };
        audit.score -= 25;
        audit.recommendedDnsRecords.push({
          type: 'TXT',
          host: '@',
          value: 'v=spf1 include:_spf.google.com ~all',
          purpose: 'Authorizes Google SMTP servers'
        });
      }

      // --- DMARC Check ---
      try {
        const dmarcRecords = await dns.resolveTxt(`_dmarc.${domain}`);
        const dmarcRecord = dmarcRecords.flat().find(r => r.startsWith('v=DMARC1'));
        if (dmarcRecord) {
          const policyMatch = dmarcRecord.match(/p=([a-z]+)/i);
          const spMatch = dmarcRecord.match(/sp=([a-z]+)/i);
          const policy = policyMatch ? policyMatch[1].toLowerCase() : 'none';
          const subPolicy = spMatch ? spMatch[1].toLowerCase() : null;
          audit.checks.dmarc = {
            status: 'pass',
            policy,
            subPolicy,
            value: dmarcRecord,
            isCompliant: true,
            details: `✓ DMARC active with policy: p=${policy}${subPolicy ? ` (subdomains: sp=${subPolicy})` : ''}. Complies with Google 2024 Bulk Sender rules.`
          };
        } else {
          audit.checks.dmarc = {
            status: 'missing',
            policy: null,
            value: null,
            isCompliant: false,
            details: '⚠️ DMARC record is missing. Google requires a DMARC policy for all senders.'
          };
          audit.score -= 25;
          audit.recommendedDnsRecords.push({
            type: 'TXT',
            host: '_dmarc',
            value: `v=DMARC1; p=none; rua=mailto:dmarc-reports@${domain}; pct=100; sp=none; aspf=r;`,
            purpose: 'Google mandatory DMARC email authentication policy'
          });
        }
      } catch (e) {
        audit.checks.dmarc = {
          status: 'missing',
          policy: null,
          value: null,
          isCompliant: false,
          details: '⚠️ No DMARC record found at _dmarc.' + domain
        };
        audit.score -= 25;
        audit.recommendedDnsRecords.push({
          type: 'TXT',
          host: '_dmarc',
          value: `v=DMARC1; p=none; rua=mailto:dmarc-reports@${domain}; pct=100; sp=none; aspf=r;`,
          purpose: 'Google mandatory DMARC email authentication policy'
        });
      }

      // --- DKIM Check ---
      const commonSelectors = ['20230601', '20210112', '20161025', 'google', 'default', 'mail', 'k1', 'smtp', 'selector1'];
      let dkimFound = false;
      for (const sel of commonSelectors) {
        try {
          const dkimRecords = await dns.resolveTxt(`${sel}._domainkey.${domain}`);
          const dkimRecord = dkimRecords.flat().find(r => r.includes('v=DKIM1') || r.includes('p=') || r.includes('k=rsa'));
          if (dkimRecord) {
            audit.checks.dkim = {
              status: 'pass',
              selector: sel,
              value: dkimRecord.length > 50 ? `${dkimRecord.substring(0, 48)}...` : dkimRecord,
              isGoogleAligned: true,
              details: `✓ Active DKIM public key located under selector: "${sel}".`
            };
            dkimFound = true;
            break;
          }
        } catch (e) {}
      }

      if (!dkimFound) {
        audit.checks.dkim = {
          status: 'warning',
          selector: 'google',
          value: null,
          isGoogleAligned: false,
          details: 'ℹ️ DKIM TXT key could not be detected automatically. (Ensure DKIM is generated in Google Workspace Admin > Apps > Gmail > Authenticate email).'
        };
        audit.score -= 10;
        audit.recommendedDnsRecords.push({
          type: 'TXT',
          host: 'google._domainkey',
          value: 'v=DKIM1; k=rsa; p=(Generate in Google Admin Console > Gmail > Authenticate email)',
          purpose: 'Cryptographic digital signature verifying domain authenticity (RFC 6376)'
        });
      }

      // --- MX Records Check ---
      try {
        const mxRecords = await dns.resolveMx(domain);
        if (mxRecords && mxRecords.length > 0) {
          const isGoogle = mxRecords.some(r => r.exchange && (r.exchange.includes('google.com') || r.exchange.includes('googlemail.com')));
          audit.checks.mx = {
            status: 'pass',
            records: mxRecords.map(r => `${r.exchange} (Pri ${r.priority})`),
            isGoogleMx: isGoogle,
            details: isGoogle ? '✓ Google Workspace MX Mail Routing active.' : '✓ MX Records configured.'
          };
        } else {
          audit.checks.mx = {
            status: 'missing',
            records: [],
            isGoogleMx: false,
            details: '⚠️ No MX records found on domain.'
          };
          audit.score -= 15;
        }
      } catch (e) {
        audit.checks.mx = {
          status: 'warning',
          records: [],
          isGoogleMx: false,
          details: 'ℹ️ MX record lookup returned no entries.'
        };
      }

      // Postmaster Recommendations
      audit.checks.postmaster.complianceScore = Math.max(20, Math.min(100, audit.score));
      if (audit.checks.spf.status !== 'pass') {
        audit.checks.postmaster.recommendations.push('Add an SPF TXT record pointing to include:_spf.google.com');
      }
      if (audit.checks.dmarc.status !== 'pass') {
        audit.checks.postmaster.recommendations.push('Publish a DMARC record to satisfy Google 2024 Bulk Sender rules.');
      }
      if (audit.checks.dkim.status !== 'pass') {
        audit.checks.postmaster.recommendations.push('Generate 2048-bit DKIM keys in Google Workspace Admin.');
      }
      audit.checks.postmaster.recommendations.push('Register domain on postmaster.google.com to view Google\'s internal spam reputation score.');

    } catch (err) {
      console.warn(`[DNS Deliverability Audit Warning for ${domain}]:`, err.message);
    }

    audit.score = Math.max(20, Math.min(100, audit.score));
    const result = { success: true, ...audit };
    this.cache.set(domain, { timestamp: Date.now(), data: result });
    return result;
  }
}

module.exports = new DeliverabilityService();
