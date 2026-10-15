const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');
const url = require('url');
const path = require('path');
const storage = require('./storageService');

class WebsiteAuditorService {
  constructor(options = {}) {
    this.auditsFile = options.auditsFile || path.join(__dirname, '..', 'data', 'website_audits.json');
    this.tenantId = options.tenantId || 'default';
    this.audits = [];
    this.loadAudits();
  }

  loadAudits() {
    const data = storage.readJSON(this.auditsFile, []);
    this.audits = Array.isArray(data) ? data : [];
  }

  saveAudits() {
    storage.writeJSON(this.auditsFile, this.audits);
  }

  /**
   * SSRF IP validation: strictly blocks private, loopback, link-local, cloud-metadata, and reserved IPs.
   */
  isPrivateOrBlockedIP(ip) {
    if (!ip) return true;

    // IPv4 validation
    if (net.isIPv4(ip)) {
      const parts = ip.split('.').map(p => parseInt(p, 10));
      if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return true;

      // 0.0.0.0/8 (Current network)
      if (parts[0] === 0) return true;
      // 10.0.0.0/8 (Private)
      if (parts[0] === 10) return true;
      // 100.64.0.0/10 (Carrier-Grade NAT)
      if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
      // 127.0.0.0/8 (Loopback / localhost)
      if (parts[0] === 127) return true;
      // 169.254.0.0/16 (Link-local & AWS/GCP/Azure Metadata 169.254.169.254)
      if (parts[0] === 169 && parts[1] === 254) return true;
      // 172.16.0.0/12 (Private)
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      // 192.0.0.0/24 (IETF Protocol Assignments)
      if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
      // 192.0.2.0/24 (TEST-NET-1)
      if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return true;
      // 192.168.0.0/16 (Private)
      if (parts[0] === 192 && parts[1] === 168) return true;
      // 198.18.0.0/15 (Network benchmark)
      if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
      // 198.51.100.0/24 (TEST-NET-2)
      if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return true;
      // 203.0.113.0/24 (TEST-NET-3)
      if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return true;
      // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
      if (parts[0] >= 224) return true;
      // 255.255.255.255 (Broadcast)
      if (ip === '255.255.255.255') return true;

      return false;
    }

    // IPv6 validation
    if (net.isIPv6(ip)) {
      const lower = ip.toLowerCase();
      // ::1 (Loopback)
      if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
      // :: (Unspecified)
      if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return true;
      // fe80::/10 (Link-local)
      if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
      // fc00::/7 (Unique local / private)
      if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
      // IPv4-mapped IPv6 (::ffff:127.0.0.1, ::ffff:10.0.0.1, etc.)
      if (lower.includes('::ffff:')) {
        const v4Part = lower.split('::ffff:')[1];
        if (v4Part && net.isIPv4(v4Part)) {
          return this.isPrivateOrBlockedIP(v4Part);
        }
        return true;
      }
      return false;
    }

    return true; // Not a recognized IP version -> block
  }

  /**
   * Pre-flight DNS validation for URL: checks protocol and validates all resolved IPs.
   */
  async validateUrlSsrf(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') {
      throw new Error('Invalid URL provided.');
    }

    let parsed;
    try {
      const target = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
      parsed = new URL(target);
    } catch (e) {
      throw new Error(`Malformed URL: ${rawUrl}`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Unsupported protocol "${parsed.protocol}". Only HTTP and HTTPS are permitted.`);
    }

    const hostname = parsed.hostname;
    if (!hostname) {
      throw new Error('Invalid host in URL.');
    }

    // Check if hostname itself is directly an IP address (handling IPv6 brackets)
    const cleanHost = hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(cleanHost)) {
      if (this.isPrivateOrBlockedIP(cleanHost)) {
        throw new Error(`SSRF_BLOCKED: Destination IP ${cleanHost} is in a restricted private/internal address range.`);
      }
      return { parsedUrl: parsed, resolvedIp: cleanHost };
    }

    // Disallow local domain aliases
    const lowerHost = hostname.toLowerCase();
    if (lowerHost === 'localhost' || lowerHost.endsWith('.local') || lowerHost.endsWith('.internal') || lowerHost.endsWith('.localhost')) {
      throw new Error(`SSRF_BLOCKED: Destination host "${hostname}" resolves to a local/internal address.`);
    }

    // Resolve DNS records (both IPv4 and IPv6)
    let lookups;
    try {
      lookups = await dns.lookup(hostname, { all: true });
    } catch (err) {
      throw new Error(`DNS resolution failed for ${hostname}: ${err.message}`);
    }

    if (!lookups || lookups.length === 0) {
      throw new Error(`No DNS records found for host ${hostname}.`);
    }

    // Every single resolved address must be public
    for (const record of lookups) {
      if (this.isPrivateOrBlockedIP(record.address)) {
        throw new Error(`SSRF_BLOCKED: Host "${hostname}" resolved to restricted IP ${record.address}. Request blocked.`);
      }
    }

    return { parsedUrl: parsed, resolvedIp: lookups[0].address };
  }

  /**
   * Safely fetches a URL using Node http/https with redirect validation, timeout, and max size limits.
   */
  async fetchSafeHtml(rawUrl, options = {}) {
    const maxRedirects = options.maxRedirects || 5;
    const timeoutMs = options.timeoutMs || 8000;
    const maxSizeBytes = options.maxSizeBytes || 2 * 1024 * 1024; // 2MB max

    let currentUrl = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const redirectChain = [];
    let redirectCount = 0;

    while (redirectCount <= maxRedirects) {
      const { parsedUrl, resolvedIp } = await this.validateUrlSsrf(currentUrl);

      const client = parsedUrl.protocol === 'https:' ? https : http;
      const startTime = Date.now();

      const response = await new Promise((resolve, reject) => {
        let timer;
        const req = client.get(parsedUrl.href, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 MailFlowBot/2.0 (Auditing Engine; +https://mailflow.io/bot)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'identity'
          },
          timeout: timeoutMs
        }, (res) => {
          clearTimeout(timer);
          let rawData = '';
          let dataSize = 0;

          res.on('data', (chunk) => {
            dataSize += chunk.length;
            if (dataSize > maxSizeBytes) {
              req.destroy();
              reject(new Error(`Payload exceeded maximum allowable size of ${maxSizeBytes} bytes.`));
              return;
            }
            rawData += chunk;
          });

          res.on('end', () => {
            const responseTime = Date.now() - startTime;
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body: rawData,
              responseTime,
              resolvedIp,
              finalUrl: parsedUrl.href,
              protocol: parsedUrl.protocol
            });
          });
        });

        timer = setTimeout(() => {
          req.destroy();
          reject(new Error(`Request timed out after ${timeoutMs}ms.`));
        }, timeoutMs);

        req.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      // Check for redirect (301, 302, 303, 307, 308)
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        redirectCount++;
        const locationUrl = new URL(response.headers.location, currentUrl).href;
        redirectChain.push({
          from: currentUrl,
          to: locationUrl,
          statusCode: response.statusCode
        });
        currentUrl = locationUrl;
        continue;
      }

      return {
        ...response,
        redirectChain,
        initialUrl: rawUrl,
        effectiveUrl: currentUrl
      };
    }

    throw new Error(`Exceeded maximum redirect limit of ${maxRedirects}.`);
  }

  /**
   * Analyzes HTML document and metadata to extract SEO, Technical, Performance, and Quality findings.
   */
  async auditUrl(rawUrl, options = {}) {
    const cleanInput = (rawUrl || '').trim();
    if (!cleanInput) {
      throw new Error('A valid website URL is required.');
    }

    const auditTimestamp = new Date().toISOString();
    const findings = [];
    let fetchResult = null;
    let auditStatus = 'Completed';
    let errorMessage = null;

    try {
      fetchResult = await this.fetchSafeHtml(cleanInput, options);
    } catch (err) {
      if (/blocked|loopback|private|metadata|protocol|ssrf/i.test(err.message)) {
        throw err;
      }
      auditStatus = 'Failed';
      errorMessage = err.message;
      findings.push({
        id: 'site_unreachable',
        category: 'Technical',
        severity: 'Critical',
        title: 'Website Unreachable or Request Blocked',
        evidence: err.message,
        recommendation: 'Verify the domain name, ensure DNS records are active, and check server firewall.'
      });

      const failedAudit = {
        id: `audit-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
        tenantId: this.tenantId,
        url: cleanInput,
        finalUrl: cleanInput,
        domain: cleanInput.replace(/^https?:\/\//i, '').split('/')[0],
        status: 'Failed',
        healthScore: 0,
        score: 0,
        errorMessage,
        findings,
        categories: { technical: 0, seo: 0, performance: 0, quality: 0, Technical: 0, SEO: 0, Performance: 0, Quality: 0 },
        auditedAt: auditTimestamp,
        auditPitchSnippet: `We tried reaching your website (${cleanInput}) but encountered an accessibility issue: ${err.message}.`
      };

      this.saveAuditRecord(failedAudit);
      return failedAudit;
    }

    const auditResult = this.analyzeHtml(cleanInput, fetchResult.body, {
      statusCode: fetchResult.statusCode,
      headers: fetchResult.headers,
      responseTime: fetchResult.responseTime,
      responseTimeMs: fetchResult.responseTime,
      redirectChain: fetchResult.redirectChain,
      effectiveUrl: fetchResult.effectiveUrl,
      protocol: fetchResult.protocol
    });

    auditResult.tenantId = this.tenantId;
    auditResult.id = `audit-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    this.saveAuditRecord(auditResult);
    return auditResult;
  }

  /**
   * Analyzes an HTML document and metadata to extract SEO, Technical, Performance, and Quality findings.
   */
  analyzeHtml(rawUrl, html = '', meta = {}) {
    const cleanInput = (rawUrl || '').trim();
    const body = html || '';
    const statusCode = meta.statusCode !== undefined ? meta.statusCode : 200;
    const headers = meta.headers || {};
    const responseTime = meta.responseTimeMs !== undefined ? meta.responseTimeMs : (meta.responseTime || 200);
    const redirectChain = meta.redirectChain || [];
    const effectiveUrl = meta.effectiveUrl || (cleanInput.startsWith('http://') || cleanInput.startsWith('https://') ? cleanInput : `https://${cleanInput}`);
    let protocol = meta.protocol;
    if (!protocol) {
      try { protocol = new URL(effectiveUrl).protocol; } catch (e) { protocol = 'https:'; }
    }
    let parsedDomain = 'website.com';
    try { parsedDomain = new URL(effectiveUrl).hostname; } catch (e) { parsedDomain = cleanInput; }

    const auditTimestamp = new Date().toISOString();
    const findings = [];

    // --- A. TECHNICAL HEALTH AUDIT ---
    let technicalScore = 100;

    // HTTP Status Check
    if (statusCode >= 400) {
      technicalScore -= 50;
      findings.push({
        id: 'http_error_status',
        category: 'Technical',
        severity: 'Critical',
        title: `HTTP Server Error: Status ${statusCode}`,
        evidence: `Returned HTTP status code ${statusCode}`,
        recommendation: 'Fix web server routing or upstream backend errors to return 200 OK.'
      });
    }

    // HTTPS Availability
    const isHttps = protocol === 'https:';
    if (!isHttps) {
      technicalScore -= 30;
      findings.push({
        id: 'no_https',
        category: 'Technical',
        severity: 'High',
        title: 'Missing HTTPS SSL/TLS Encryption',
        evidence: `Connected over unencrypted HTTP: ${effectiveUrl}`,
        recommendation: 'Install a valid TLS/SSL certificate (e.g. Let\'s Encrypt / Cloudflare) and enforce HTTPS redirect.'
      });
    } else {
      findings.push({
        id: 'https_active',
        category: 'Technical',
        severity: 'Informational',
        title: 'HTTPS Encryption Active',
        evidence: `Secure TLS connection verified: ${effectiveUrl}`,
        recommendation: 'Maintain active SSL renewals.'
      });
    }

    // Redirect Chains
    if (redirectChain.length > 2) {
      technicalScore -= 15;
      findings.push({
        id: 'excessive_redirect_chain',
        category: 'Technical',
        severity: 'Medium',
        title: `Excessive Redirect Chain (${redirectChain.length} hops)`,
        evidence: redirectChain.map(r => `${r.statusCode} -> ${r.to}`).join(' | '),
        recommendation: 'Reduce redirect hops to a single 301 direct redirect to improve crawl budget and speed.'
      });
    }

    // Meta Robots Directives
    const robotsMatch = body.match(/<meta[^>]*name=["']robots["'][^>]*content=["']([^"']*)["'][^>]*>/i);
    const robotsContent = robotsMatch ? robotsMatch[1].toLowerCase() : '';
    if (robotsContent.includes('noindex')) {
      technicalScore -= 40;
      findings.push({
        id: 'noindex_detected',
        category: 'Technical',
        severity: 'Critical',
        title: 'Page Blocked from Search Engines (noindex)',
        evidence: `<meta name="robots" content="${robotsContent}">`,
        recommendation: 'Remove the "noindex" tag if this page is intended for public organic search indexing.'
      });
    }

    // Canonical URL configuration
    const canonicalMatch = body.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["'][^>]*>/i);
    const canonicalUrl = canonicalMatch ? canonicalMatch[1] : null;
    if (!canonicalUrl) {
      technicalScore -= 10;
      findings.push({
        id: 'missing_canonical',
        category: 'Technical',
        severity: 'Medium',
        title: 'Missing Canonical URL Link Tag',
        evidence: 'No <link rel="canonical" href="..."> element found in <head>',
        recommendation: 'Specify a rel="canonical" tag to prevent duplicate content indexing penalties.'
      });
    } else {
      findings.push({
        id: 'canonical_present',
        category: 'Technical',
        severity: 'Informational',
        title: 'Canonical URL Defined',
        evidence: `Canonical points to: ${canonicalUrl}`,
        recommendation: 'Ensure canonical accurately reflects preferred indexing destination.'
      });
    }

    // --- B. ON-PAGE SEO AUDIT ---
    let seoScore = 100;

    // Title Tag
    const titleMatch = body.match(/<title[^>]*>([^<]*)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].trim() : '';
    if (!pageTitle) {
      seoScore -= 30;
      findings.push({
        id: 'missing_title',
        category: 'SEO',
        severity: 'High',
        title: 'Missing Page Title Tag',
        evidence: 'No <title> tag found in HTML document',
        recommendation: 'Add a descriptive 40-60 character <title> tag including your primary keyword.'
      });
    } else if (pageTitle.length < 20) {
      seoScore -= 10;
      findings.push({
        id: 'title_too_short',
        category: 'SEO',
        severity: 'Low',
        title: `Page Title Too Short (${pageTitle.length} chars)`,
        evidence: `Title: "${pageTitle}"`,
        recommendation: 'Expand title to 40-60 characters to capture relevant search queries.'
      });
    } else if (pageTitle.length > 70) {
      seoScore -= 10;
      findings.push({
        id: 'title_too_long',
        category: 'SEO',
        severity: 'Low',
        title: `Page Title Too Long (${pageTitle.length} chars)`,
        evidence: `Title: "${pageTitle.slice(0, 75)}..."`,
        recommendation: 'Trim title under 65 characters to avoid truncation in Google SERPs.'
      });
    }

    // Meta Description
    const descMatch = body.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
                      body.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);
    const metaDescription = descMatch ? descMatch[1].trim() : '';
    if (!metaDescription) {
      seoScore -= 25;
      findings.push({
        id: 'missing_meta_description',
        category: 'SEO',
        severity: 'Medium',
        title: 'Missing Meta Description',
        evidence: 'No <meta name="description"> tag found in <head>',
        recommendation: 'Write a compelling 140-160 character meta description with a call to action.'
      });
    } else if (metaDescription.length < 50) {
      seoScore -= 10;
      findings.push({
        id: 'meta_description_too_short',
        category: 'SEO',
        severity: 'Low',
        title: `Meta Description Too Short (${metaDescription.length} chars)`,
        evidence: `Description: "${metaDescription}"`,
        recommendation: 'Expand description to 120-160 characters for maximum search snippet click-throughs.'
      });
    }

    // Heading Structure (H1 and H2)
    const h1Matches = body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/gi) || [];
    const h2Matches = body.match(/<h2[^>]*>([\s\S]*?)<\/h2>/gi) || [];
    if (h1Matches.length === 0) {
      seoScore -= 25;
      findings.push({
        id: 'missing_h1',
        category: 'SEO',
        severity: 'High',
        title: 'Missing Main <h1> Heading',
        evidence: 'No <h1> tag found on the page',
        recommendation: 'Add exactly one clear <h1> tag representing the page topic and core value proposition.'
      });
    } else if (h1Matches.length > 2) {
      seoScore -= 10;
      findings.push({
        id: 'multiple_h1_tags',
        category: 'SEO',
        severity: 'Low',
        title: `Multiple <h1> Headings Found (${h1Matches.length})`,
        evidence: `Found ${h1Matches.length} <h1> elements`,
        recommendation: 'Reserve <h1> for the primary topic and convert secondary headings to <h2> and <h3>.'
      });
    }

    // Image Alt Attributes
    const imgMatches = body.match(/<img[^>]*>/gi) || [];
    const missingAltImgs = [];
    imgMatches.forEach(imgTag => {
      const hasAlt = /alt=["'][^"']*["']/i.test(imgTag);
      if (!hasAlt) {
        const srcMatch = imgTag.match(/src=["']([^"']*)["']/i);
        missingAltImgs.push(srcMatch ? srcMatch[1].slice(0, 60) : 'inline-image');
      }
    });

    if (missingAltImgs.length > 0) {
      const deduction = Math.min(20, missingAltImgs.length * 4);
      seoScore -= deduction;
      findings.push({
        id: 'missing_alt_attributes',
        category: 'SEO',
        severity: missingAltImgs.length > 3 ? 'Medium' : 'Low',
        title: `${missingAltImgs.length} Images Missing Alt Text`,
        evidence: `Sample images without alt: ${missingAltImgs.slice(0, 3).join(', ')}`,
        recommendation: 'Add descriptive alt text to all visual images for Google Image search and accessibility.'
      });
    }

    // Open Graph Metadata
    const hasOgTitle = /<meta[^>]*property=["']og:title["']/i.test(body);
    const hasOgImage = /<meta[^>]*property=["']og:image["']/i.test(body);
    if (!hasOgTitle || !hasOgImage) {
      seoScore -= 10;
      findings.push({
        id: 'incomplete_open_graph',
        category: 'SEO',
        severity: 'Low',
        title: 'Incomplete Social Open Graph Metadata',
        evidence: `og:title: ${hasOgTitle ? '✓' : '✕'}, og:image: ${hasOgImage ? '✓' : '✕'}`,
        recommendation: 'Add og:title and og:image tags for rich previews when shared on LinkedIn, X, and Facebook.'
      });
    }

    // Structured Data Detection
    const hasJsonLd = /<script[^>]*type=["']application\/ld\+json["']/i.test(body);
    if (hasJsonLd) {
      findings.push({
        id: 'structured_data_active',
        category: 'SEO',
        severity: 'Informational',
        title: 'Structured Schema.org Data Detected',
        evidence: 'JSON-LD structured data block found in document',
        recommendation: 'Maintain schema validation with Google Rich Results test.'
      });
    } else {
      seoScore -= 10;
      findings.push({
        id: 'missing_structured_data',
        category: 'SEO',
        severity: 'Low',
        title: 'Missing Structured Data (Schema.org / JSON-LD)',
        evidence: 'No application/ld+json blocks found',
        recommendation: 'Implement Organization, LocalBusiness, or WebSite schema to unlock rich search snippets.'
      });
    }

    // --- C. PERFORMANCE AUDIT ---
    let performanceScore = 100;

    // Response Latency / TTFB
    if (responseTime > 3000) {
      performanceScore -= 40;
      findings.push({
        id: 'slow_response_time',
        category: 'Performance',
        severity: 'High',
        title: `Slow Initial Server Response Time (${responseTime}ms)`,
        evidence: `Measured TTFB/HTML response latency: ${responseTime}ms`,
        recommendation: 'Optimize server processing, enable CDN page caching (e.g. Cloudflare / Vercel Edge), or upgrade hosting.'
      });
    } else if (responseTime > 1500) {
      performanceScore -= 20;
      findings.push({
        id: 'moderate_response_time',
        category: 'Performance',
        severity: 'Medium',
        title: `Moderate Server Response Latency (${responseTime}ms)`,
        evidence: `Measured TTFB/HTML response latency: ${responseTime}ms`,
        recommendation: 'Aim for sub-800ms initial page load using server-level caching.'
      });
    } else {
      findings.push({
        id: 'fast_server_response',
        category: 'Performance',
        severity: 'Informational',
        title: `Fast Initial Response Time (${responseTime}ms)`,
        evidence: `Measured server response latency: ${responseTime}ms`,
        recommendation: 'Server response speed is well within the top Google Core Web Vitals threshold.'
      });
    }

    // HTML Payload Size
    const htmlSizeBytes = Buffer.byteLength(body, 'utf8');
    const htmlSizeKb = Math.round(htmlSizeBytes / 1024);
    if (htmlSizeKb > 500) {
      performanceScore -= 20;
      findings.push({
        id: 'large_html_payload',
        category: 'Performance',
        severity: 'Medium',
        title: `Heavy HTML Payload Size (${htmlSizeKb} KB)`,
        evidence: `Uncompressed HTML document size is ${htmlSizeKb} KB`,
        recommendation: 'Minify HTML, defer non-critical scripts, and enable Gzip or Brotli compression.'
      });
    }

    // Mobile Viewport Configuration
    const hasViewport = /<meta[^>]*name=["']viewport["'][^>]*>/i.test(body);
    if (!hasViewport) {
      performanceScore -= 30;
      findings.push({
        id: 'missing_mobile_viewport',
        category: 'Performance',
        severity: 'Critical',
        title: 'Missing Mobile Viewport Meta Tag',
        evidence: 'No <meta name="viewport" content="..."> found',
        recommendation: 'Add <meta name="viewport" content="width=device-width, initial-scale=1.0"> for mobile responsiveness.'
      });
    }

    // --- D. WEBSITE QUALITY & CONVERSION AUDIT ---
    let qualityScore = 100;

    // Contact page detection & Signals
    const hasContactSignal = /href=["'][^"']*(contact|about|support|help)[^"']*["']/i.test(body) ||
                             /mailto:[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i.test(body) ||
                             /tel:[+0-9() -]+/i.test(body) ||
                             /<form[^>]*>/i.test(body);

    if (!hasContactSignal) {
      qualityScore -= 25;
      findings.push({
        id: 'missing_contact_signals',
        category: 'Quality',
        severity: 'Medium',
        title: 'Missing Clear Contact Signals or Form',
        evidence: 'No contact page links, email links (mailto:), phone numbers (tel:), or form inputs detected',
        recommendation: 'Add a clear "Contact" or "Schedule Call" link to improve inbound lead conversions.'
      });
    }

    // Call to Action (CTA) Detection
    const hasCta = /(get started|book a call|schedule|free trial|contact us|sign up|buy now|request quote|get quote)/i.test(body);
    if (!hasCta) {
      qualityScore -= 15;
      findings.push({
        id: 'weak_call_to_action',
        category: 'Quality',
        severity: 'Low',
        title: 'No Prominent Call to Action (CTA) Detected',
        evidence: 'Standard conversion triggers ("Get Started", "Book a Call", "Get Quote") not found in top viewport content',
        recommendation: 'Feature a high-contrast primary CTA button above the fold.'
      });
    }

    // Privacy Policy Link (Trust Signal)
    const hasPrivacy = /href=["'][^"']*(privacy|terms|legal)[^"']*["']/i.test(body);
    if (!hasPrivacy) {
      qualityScore -= 10;
      findings.push({
        id: 'missing_privacy_link',
        category: 'Quality',
        severity: 'Low',
        title: 'Missing Privacy Policy or Terms Link',
        evidence: 'No link pointing to /privacy or /terms detected in page footer',
        recommendation: 'Add a Privacy Policy link in the footer to build visitor trust and comply with privacy regulations.'
      });
    }

    // Calculate Overall Weighted Score (0 - 100)
    technicalScore = Math.max(0, Math.min(100, technicalScore));
    seoScore = Math.max(0, Math.min(100, seoScore));
    performanceScore = Math.max(0, Math.min(100, performanceScore));
    qualityScore = Math.max(0, Math.min(100, qualityScore));

    const overallScore = Math.round(
      (technicalScore * 0.35) +
      (seoScore * 0.30) +
      (performanceScore * 0.20) +
      (qualityScore * 0.15)
    );

    // Build Cold Outreach Pitch Snippet referencing specific verified findings
    let auditPitchSnippet = '';
    const criticalOrHigh = findings.filter(f => f.severity === 'Critical' || f.severity === 'High');
    const mediums = findings.filter(f => f.severity === 'Medium');

    if (criticalOrHigh.length > 0) {
      auditPitchSnippet = `I ran a quick audit on your website (${parsedDomain}) and noticed that ${criticalOrHigh[0].title.toLowerCase()} (${criticalOrHigh[0].recommendation}).`;
    } else if (mediums.length > 0) {
      auditPitchSnippet = `I checked out ${parsedDomain} and noticed ${mediums[0].title.toLowerCase()}, which might be holding back your Google search rankings.`;
    } else {
      auditPitchSnippet = `Your website at ${parsedDomain} is performing well overall (Score: ${overallScore}%), with clean on-page fundamentals.`;
    }

    const auditResult = {
      url: cleanInput,
      effectiveUrl,
      domain: parsedDomain,
      status: 'Completed',
      score: overallScore,
      healthScore: overallScore,
      responseTimeMs: responseTime,
      statusCode,
      categories: {
        technical: technicalScore,
        seo: seoScore,
        performance: performanceScore,
        quality: qualityScore,
        Technical: technicalScore,
        SEO: seoScore,
        Performance: performanceScore,
        Quality: qualityScore
      },
      counts: {
        critical: findings.filter(f => f.severity === 'Critical').length,
        high: findings.filter(f => f.severity === 'High').length,
        medium: findings.filter(f => f.severity === 'Medium').length,
        low: findings.filter(f => f.severity === 'Low').length,
        informational: findings.filter(f => f.severity === 'Informational').length,
        total: findings.length
      },
      pageDetails: {
        title: pageTitle,
        metaDescription,
        h1Count: h1Matches.length,
        h2Count: h2Matches.length,
        imageCount: imgMatches.length,
        imagesMissingAlt: missingAltImgs.length,
        isHttps,
        hasCanonical: !!canonicalUrl,
        hasOpenGraph: hasOgTitle && hasOgImage,
        hasStructuredData: hasJsonLd,
        hasMobileViewport: hasViewport
      },
      findings,
      auditPitchSnippet,
      pitchSnippet: auditPitchSnippet,
      auditedAt: auditTimestamp
    };

    return auditResult;
  }

  saveAuditRecord(audit) {
    this.loadAudits();
    const existingIndex = this.audits.findIndex(a => a.domain === audit.domain || a.url === audit.url);
    if (existingIndex >= 0) {
      this.audits[existingIndex] = audit;
    } else {
      this.audits.unshift(audit);
    }
    // Cap at 200 stored audits per tenant
    if (this.audits.length > 200) {
      this.audits = this.audits.slice(0, 200);
    }
    this.saveAudits();
  }

  saveAuditResult(audit) {
    return this.saveAuditRecord(audit);
  }

  getAudit(id) {
    return this.getAuditById(id);
  }

  getAuditHistory() {
    return this.getAudits();
  }

  getAudits() {
    this.loadAudits();
    return [...this.audits];
  }

  listAudits(query = {}) {
    this.loadAudits();
    let items = [...this.audits];
    if (query && query.domain) {
      const q = query.domain.toLowerCase();
      items = items.filter(a => a.domain && a.domain.toLowerCase().includes(q));
    }
    const page = parseInt(query?.page, 10) || 1;
    const limit = Math.min(2000, parseInt(query?.limit, 10) || 50);
    const total = items.length;
    const start = (page - 1) * limit;
    const paginated = items.slice(start, start + limit);
    return { audits: paginated, total, page, limit };
  }

  getFindingsSummary() {
    this.loadAudits();
    const totalAudits = this.audits.length;
    let totalScore = 0;
    let critical = 0;
    let high = 0;
    let medium = 0;
    let low = 0;
    let totalFindings = 0;

    for (const a of this.audits) {
      totalScore += (a.score || a.healthScore || 0);
      if (a.counts) {
        critical += a.counts.critical || 0;
        high += a.counts.high || 0;
        medium += a.counts.medium || 0;
        low += a.counts.low || 0;
        totalFindings += a.counts.total || 0;
      }
    }

    return {
      totalAudits,
      averageScore: totalAudits > 0 ? Math.round(totalScore / totalAudits) : 0,
      totalFindings,
      breakdown: { critical, high, medium, low }
    };
  }

  getAuditById(id) {
    this.loadAudits();
    return this.audits.find(a => a.id === id) || null;
  }

  getAuditByDomain(domain) {
    if (!domain) return null;
    const clean = domain.toLowerCase().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
    this.loadAudits();
    return this.audits.find(a => a.domain.toLowerCase() === clean) || null;
  }

  deleteAudit(id) {
    this.loadAudits();
    const before = this.audits.length;
    this.audits = this.audits.filter(a => a.id !== id);
    this.saveAudits();
    return this.audits.length < before;
  }

  auditBatch(urls, options = {}) {
    return this.batchAudit(urls, options && options.onProgress ? options.onProgress : null);
  }

  /**
   * Batch auditor with concurrency limit (e.g. 3 concurrent)
   */
  async batchAudit(urls, onProgress = null) {
    const list = Array.isArray(urls) ? urls.filter(u => typeof u === 'string' && u.trim()) : [];
    const results = [];
    const concurrency = 3;
    let completed = 0;

    for (let i = 0; i < list.length; i += concurrency) {
      const chunk = list.slice(i, i + concurrency);
      const chunkPromises = chunk.map(async (targetUrl) => {
        try {
          const res = await this.auditUrl(targetUrl);
          completed++;
          if (onProgress) onProgress({ completed, total: list.length, current: targetUrl, result: res });
          return res;
        } catch (err) {
          completed++;
          const failed = {
            url: targetUrl,
            status: 'Failed',
            healthScore: 0,
            errorMessage: err.message
          };
          if (onProgress) onProgress({ completed, total: list.length, current: targetUrl, result: failed });
          return failed;
        }
      });

      const chunkResults = await Promise.all(chunkPromises);
      results.push(...chunkResults);
    }

    return results;
  }
}

module.exports = WebsiteAuditorService;
