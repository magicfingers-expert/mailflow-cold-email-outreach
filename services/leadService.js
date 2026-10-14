const path = require('path');
const storage = require('./storageService');
const EmailValidator = require('./emailValidator');

class LeadService {
  constructor(options = {}) {
    this.leadsFile = options.leadsFile || path.join(__dirname, '..', 'data', 'leads.json');
    this.importJobsFile = options.importJobsFile || path.join(path.dirname(this.leadsFile), 'import_jobs.json');
    this.tenantId = options.tenantId || 'default';
    this.bounceService = options.bounceService || null;
    this.leads = [];
    this.importJobs = [];
    this.loadLeads();
    this.loadImportJobs();
  }

  loadLeads() {
    const data = storage.readJSON(this.leadsFile, []);
    this.leads = Array.isArray(data) ? data : [];
  }

  saveLeads() {
    storage.writeJSON(this.leadsFile, this.leads);
  }

  loadImportJobs() {
    const data = storage.readJSON(this.importJobsFile, []);
    this.importJobs = Array.isArray(data) ? data : [];
  }

  saveImportJobs() {
    storage.writeJSON(this.importJobsFile, this.importJobs);
  }

  getLeads({
    search = '',
    status = 'all',
    auditStatus = 'all',
    page = 1,
    limit = 50,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    findingId = null
  } = {}) {
    this.loadLeads();
    let filtered = [...this.leads];

    if (status && status !== 'all') {
      const sLower = status.toLowerCase();
      filtered = filtered.filter(l => (l.status || 'Active').toLowerCase() === sLower);
    }

    if (auditStatus && auditStatus !== 'all') {
      const aLower = auditStatus.toLowerCase();
      filtered = filtered.filter(l => (l.websiteAuditStatus || 'none').toLowerCase() === aLower);
    }

    if (findingId) {
      filtered = filtered.filter(l => {
        if (!Array.isArray(l.auditFindings)) return false;
        return l.auditFindings.some(f => f.id === findingId || (typeof f === 'string' && f.includes(findingId)));
      });
    }

    if (search && search.trim()) {
      const q = search.toLowerCase().trim();
      filtered = filtered.filter(l =>
        (l.email && l.email.toLowerCase().includes(q)) ||
        (l.name && l.name.toLowerCase().includes(q)) ||
        (l.businessName && l.businessName.toLowerCase().includes(q)) ||
        (l.company && l.company.toLowerCase().includes(q)) ||
        (l.website && l.website.toLowerCase().includes(q)) ||
        (l.city && l.city.toLowerCase().includes(q)) ||
        (l.niche && l.niche.toLowerCase().includes(q))
      );
    }

    // Sort
    filtered.sort((a, b) => {
      let valA = a[sortBy] !== undefined ? a[sortBy] : '';
      let valB = b[sortBy] !== undefined ? b[sortBy] : '';
      if (typeof valA === 'string') valA = valA.toLowerCase();
      if (typeof valB === 'string') valB = valB.toLowerCase();
      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    const total = filtered.length;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.max(1, Math.min(5000, parseInt(limit, 10) || 50));
    const startIndex = (pageNum - 1) * pageSize;
    const paginated = filtered.slice(startIndex, startIndex + pageSize);

    return {
      leads: paginated,
      total,
      page: pageNum,
      pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
      stats: {
        total: this.leads.length,
        active: this.leads.filter(l => (l.status || 'Active') === 'Active').length,
        contacted: this.leads.filter(l => l.status === 'Contacted').length,
        suppressed: this.leads.filter(l => l.status === 'Suppressed').length,
        unsubscribed: this.leads.filter(l => l.status === 'Unsubscribed').length,
        bounced: this.leads.filter(l => l.status === 'Bounced').length,
        audited: this.leads.filter(l => l.websiteAuditStatus === 'completed').length,
        eligible: this.leads.filter(l => (l.status || 'Active') === 'Active' && l.outreachEligibility !== 'ineligible').length
      }
    };
  }

  getLeadById(id) {
    this.loadLeads();
    return this.leads.find(l => l.id === id) || null;
  }

  getLeadByEmail(email) {
    if (!email) return null;
    const clean = email.toLowerCase().trim();
    this.loadLeads();
    return this.leads.find(l => l.email.toLowerCase() === clean) || null;
  }

  addLead({
    email,
    name,
    firstName,
    lastName,
    businessName,
    company,
    website,
    niche,
    category,
    phone,
    city,
    location,
    sourceUrl,
    discoveredAt,
    websiteAuditStatus = 'none',
    websiteAuditScore = null,
    websiteAuditSummary = null,
    auditFindings = [],
    verificationStatus = 'syntax_checked',
    outreachEligibility = 'eligible',
    customFields = {},
    status = 'Active'
  }) {
    if (!email || !EmailValidator.EMAIL_REGEX.test(email.trim().toLowerCase())) {
      throw new Error('A valid email address is required.');
    }

    const cleanEmail = email.trim().toLowerCase();
    this.loadLeads();

    const existing = this.leads.find(l => l.email.toLowerCase() === cleanEmail);
    if (existing) {
      throw new Error(`Lead with email "${cleanEmail}" already exists.`);
    }

    const isSuppressed = this.bounceService ? this.bounceService.isSuppressed(cleanEmail) : false;

    const computedCompany = (businessName || company || '').trim();
    const computedName = (name || (firstName ? `${firstName} ${lastName || ''}`.trim() : computedCompany || cleanEmail.split('@')[0])).trim();
    const computedFirst = (firstName || computedName.split(' ')[0] || computedName).trim();

    const lead = {
      id: `lead-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      email: cleanEmail,
      name: computedName,
      firstName: computedFirst,
      lastName: lastName || (name ? name.split(' ').slice(1).join(' ') : ''),
      businessName: computedCompany,
      company: computedCompany,
      website: website ? website.trim() : '',
      niche: (niche || category || '').trim(),
      category: (category || niche || '').trim(),
      phone: phone ? phone.trim() : '',
      city: city ? city.trim() : '',
      location: location ? location.trim() : '',
      sourceUrl: sourceUrl || '',
      discoveredAt: discoveredAt || new Date().toISOString(),
      websiteAuditStatus: websiteAuditStatus || 'none',
      websiteAuditScore: websiteAuditScore !== undefined ? websiteAuditScore : null,
      websiteAuditSummary: websiteAuditSummary || null,
      auditFindings: Array.isArray(auditFindings) ? auditFindings : [],
      verificationStatus: verificationStatus || (cleanEmail ? 'syntax_checked' : 'unknown'),
      outreachEligibility: isSuppressed ? 'suppressed' : (outreachEligibility || 'eligible'),
      customFields: customFields || {},
      status: isSuppressed ? 'Suppressed' : (status || 'Active'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.leads.unshift(lead);
    this.saveLeads();
    return lead;
  }

  createLead(data) {
    return this.addLead(data);
  }

  updateLead(id, updates = {}) {
    this.loadLeads();
    const lead = this.leads.find(l => l.id === id);
    if (!lead) throw new Error('Lead not found.');

    if (updates.email && updates.email.toLowerCase() !== lead.email.toLowerCase()) {
      const cleanEmail = updates.email.trim().toLowerCase();
      if (!EmailValidator.EMAIL_REGEX.test(cleanEmail)) {
        throw new Error('Invalid email format.');
      }
      const duplicate = this.leads.find(l => l.id !== id && l.email.toLowerCase() === cleanEmail);
      if (duplicate) throw new Error(`Lead with email "${cleanEmail}" already exists.`);
      lead.email = cleanEmail;
    }

    if (updates.name !== undefined) lead.name = updates.name.trim();
    if (updates.firstName !== undefined) lead.firstName = updates.firstName.trim();
    if (updates.lastName !== undefined) lead.lastName = updates.lastName.trim();
    if (updates.businessName !== undefined) {
      lead.businessName = updates.businessName.trim();
      lead.company = updates.businessName.trim();
    }
    if (updates.company !== undefined) {
      lead.company = updates.company.trim();
      if (!lead.businessName) lead.businessName = updates.company.trim();
    }
    if (updates.website !== undefined) lead.website = updates.website.trim();
    if (updates.niche !== undefined) lead.niche = updates.niche.trim();
    if (updates.category !== undefined) lead.category = updates.category.trim();
    if (updates.phone !== undefined) lead.phone = updates.phone.trim();
    if (updates.city !== undefined) lead.city = updates.city.trim();
    if (updates.location !== undefined) lead.location = updates.location.trim();
    if (updates.status !== undefined) lead.status = updates.status;
    if (updates.websiteAuditStatus !== undefined) lead.websiteAuditStatus = updates.websiteAuditStatus;
    if (updates.websiteAuditScore !== undefined) lead.websiteAuditScore = updates.websiteAuditScore;
    if (updates.websiteAuditSummary !== undefined) lead.websiteAuditSummary = updates.websiteAuditSummary;
    if (updates.auditFindings !== undefined) lead.auditFindings = updates.auditFindings;
    if (updates.verificationStatus !== undefined) lead.verificationStatus = updates.verificationStatus;
    if (updates.outreachEligibility !== undefined) lead.outreachEligibility = updates.outreachEligibility;
    if (updates.suppressedReason !== undefined) lead.suppressedReason = updates.suppressedReason;
    if (updates.suppressedAt !== undefined) lead.suppressedAt = updates.suppressedAt;
    if (updates.bouncedReason !== undefined) lead.bouncedReason = updates.bouncedReason;
    if (updates.bouncedAt !== undefined) lead.bouncedAt = updates.bouncedAt;
    if (updates.lastContactedAt !== undefined) lead.lastContactedAt = updates.lastContactedAt;
    if (updates.lastCampaignId !== undefined) lead.lastCampaignId = updates.lastCampaignId;
    if (updates.customFields !== undefined) lead.customFields = { ...lead.customFields, ...updates.customFields };

    lead.updatedAt = new Date().toISOString();
    this.saveLeads();
    return lead;
  }

  deleteLead(id) {
    this.loadLeads();
    const prevCount = this.leads.length;
    this.leads = this.leads.filter(l => l.id !== id);
    this.saveLeads();
    return this.leads.length < prevCount;
  }

  bulkDeleteLeads(ids = []) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    this.loadLeads();
    const idSet = new Set(ids);
    const prevCount = this.leads.length;
    this.leads = this.leads.filter(l => !idSet.has(l.id));
    this.saveLeads();
    return prevCount - this.leads.length;
  }

  clearAllLeads() {
    this.leads = [];
    this.saveLeads();
    return true;
  }

  markLeadContacted(email, campaignId = null) {
    const lead = this.getLeadByEmail(email);
    if (!lead) return null;
    return this.updateLead(lead.id, {
      status: 'Contacted',
      lastContactedAt: new Date().toISOString(),
      lastCampaignId: campaignId
    });
  }

  markLeadBounced(email, reason = 'Bounce recorded') {
    const lead = this.getLeadByEmail(email);
    if (!lead) return null;
    return this.updateLead(lead.id, {
      status: 'Bounced',
      outreachEligibility: 'ineligible',
      bouncedReason: reason,
      bouncedAt: new Date().toISOString()
    });
  }

  markLeadSuppressed(email, reason = 'Suppressed') {
    const lead = this.getLeadByEmail(email);
    if (!lead) return null;
    return this.updateLead(lead.id, {
      status: 'Suppressed',
      outreachEligibility: 'suppressed',
      suppressedReason: reason,
      suppressedAt: new Date().toISOString()
    });
  }

  /**
   * Links a completed website audit result directly to matching leads by website domain
   */
  linkAuditToLead(audit) {
    if (!audit || !audit.domain) return 0;
    this.loadLeads();

    const cleanAuditDomain = audit.domain.toLowerCase().replace(/^www\./, '').trim();
    let updatedCount = 0;

    for (const lead of this.leads) {
      if (!lead.website) continue;
      const leadWebDomain = lead.website.toLowerCase().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').trim();
      if (leadWebDomain === cleanAuditDomain) {
        lead.websiteAuditStatus = audit.status === 'Completed' ? 'completed' : 'failed';
        lead.websiteAuditScore = audit.healthScore;
        lead.websiteAuditSummary = audit.auditPitchSnippet || `Health Score: ${audit.healthScore}%`;
        lead.auditFindings = audit.findings || [];
        lead.updatedAt = new Date().toISOString();
        updatedCount++;
      }
    }

    if (updatedCount > 0) {
      this.saveLeads();
    }
    return updatedCount;
  }

  // --- BULK LEAD IMPORT JOB ENGINE (>1,000 LEADS CAPACITY) ---

  createBulkImportJob(rawText, options = {}) {
    return this.startBulkImportJob({
      rawText,
      columnMapping: options.columnMapping,
      updateExisting: options.updateExisting,
      defaultNiche: options.defaultNiche
    });
  }

  /**
   * Initiates a durable, chunked bulk import job supporting >1,000 leads.
   */
  async startBulkImportJob({ rawText, columnMapping = null, updateExisting = false, defaultNiche = '' }) {
    if (!rawText || !rawText.trim()) {
      throw new Error('No input data provided for import.');
    }

    this.loadImportJobs();
    const jobId = `job-imp-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

    // Normalize lines into raw record strings
    const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

    // Auto-detect header row
    let headerMap = columnMapping;
    let startIndex = 0;

    if (!headerMap && lines.length > 0) {
      const firstLineLower = lines[0].toLowerCase();
      if (firstLineLower.includes('email') || firstLineLower.includes('name') || firstLineLower.includes('company') || firstLineLower.includes('website')) {
        headerMap = this.parseCsvHeader(lines[0]);
        startIndex = 1;
      }
    }

    const dataLines = lines.slice(startIndex);

    const importJob = {
      id: jobId,
      tenantId: this.tenantId,
      status: 'processing', // 'processing', 'completed', 'failed'
      totalSubmitted: dataLines.length,
      processedCount: 0,
      importedCount: 0,
      duplicateCount: 0,
      invalidCount: 0,
      suppressedCount: 0,
      remainingCount: dataLines.length,
      percent: 0,
      acceptedRecords: [],
      invalidRecords: [],
      duplicateRecords: [],
      suppressedRecords: [],
      createdAt: new Date().toISOString(),
      completedAt: null,
      error: null
    };

    this.importJobs.unshift(importJob);
    this.saveImportJobs();

    // Run chunked processor asynchronously in batches of 250 rows
    this._processImportChunks(importJob, dataLines, headerMap, { updateExisting, defaultNiche }).catch(err => {
      importJob.status = 'failed';
      importJob.error = err.message;
      importJob.completedAt = new Date().toISOString();
      this.saveImportJobs();
    });

    return importJob;
  }

  async _processImportChunks(job, dataLines, headerMap, options) {
    this.loadLeads();
    const existingMap = new Map(this.leads.map(l => [l.email.toLowerCase(), l]));
    const seenInBatch = new Set();
    const chunkSize = 250;

    for (let i = 0; i < dataLines.length; i += chunkSize) {
      const chunk = dataLines.slice(i, i + chunkSize);

      for (let j = 0; j < chunk.length; j++) {
        const line = chunk[j];
        const rowNum = i + j + 1;
        if (!line) continue;

        const record = headerMap ? this.parseCsvRowWithHeader(line, headerMap) : this.parseGenericRow(line);
        if (!record || !record.email) {
          job.invalidCount++;
          job.invalidRecords.push({ row: rowNum, raw: line, reason: 'Missing email address' });
          continue;
        }

        const cleanEmail = record.email.toLowerCase().trim();

        if (!EmailValidator.EMAIL_REGEX.test(cleanEmail)) {
          job.invalidCount++;
          job.invalidRecords.push({ row: rowNum, email: cleanEmail, reason: 'Invalid email syntax' });
          continue;
        }

        if (seenInBatch.has(cleanEmail)) {
          job.duplicateCount++;
          job.duplicateRecords.push({ row: rowNum, email: cleanEmail, reason: 'Duplicate in batch' });
          continue;
        }
        seenInBatch.add(cleanEmail);

        const isSuppressed = this.bounceService ? this.bounceService.isSuppressed(cleanEmail) : false;
        if (isSuppressed) {
          job.suppressedCount++;
          job.suppressedRecords.push({ row: rowNum, email: cleanEmail, reason: 'Recipient on suppression/unsubscribe list' });
        }

        if (existingMap.has(cleanEmail)) {
          if (options.updateExisting) {
            const existingLead = existingMap.get(cleanEmail);
            if (record.name) existingLead.name = record.name;
            if (record.company) existingLead.company = record.company;
            if (record.website) existingLead.website = record.website;
            if (record.phone) existingLead.phone = record.phone;
            if (record.city) existingLead.city = record.city;
            if (record.niche || options.defaultNiche) existingLead.niche = record.niche || options.defaultNiche;
            existingLead.updatedAt = new Date().toISOString();
            job.importedCount++;
            job.acceptedRecords.push({ email: cleanEmail, status: 'Updated' });
          } else {
            job.duplicateCount++;
            job.duplicateRecords.push({ row: rowNum, email: cleanEmail, reason: 'Already exists in database' });
          }
        } else {
          const computedCompany = (record.businessName || record.company || '').trim();
          const computedName = (record.name || (record.firstName ? `${record.firstName} ${record.lastName || ''}`.trim() : computedCompany || cleanEmail.split('@')[0])).trim();
          const computedFirst = (record.firstName || computedName.split(' ')[0] || computedName).trim();

          const lead = {
            id: `lead-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
            email: cleanEmail,
            name: computedName,
            firstName: computedFirst,
            lastName: record.lastName || (record.name ? record.name.split(' ').slice(1).join(' ') : ''),
            businessName: computedCompany,
            company: computedCompany,
            website: record.website ? record.website.trim() : '',
            phone: record.phone ? record.phone.trim() : '',
            city: record.city ? record.city.trim() : '',
            niche: (record.niche || options.defaultNiche || '').trim(),
            category: (record.niche || options.defaultNiche || '').trim(),
            customFields: record.customFields || {},
            websiteAuditStatus: 'none',
            verificationStatus: 'syntax_checked',
            outreachEligibility: isSuppressed ? 'suppressed' : 'eligible',
            status: isSuppressed ? 'Suppressed' : 'Active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };

          this.leads.push(lead);
          existingMap.set(cleanEmail, lead);
          job.importedCount++;
          job.acceptedRecords.push({ email: cleanEmail, status: 'Created', row: rowNum, businessName: computedCompany, website: record.website || '' });
        }
      }

      job.processedCount = Math.min(job.totalSubmitted, i + chunkSize);
      job.remainingCount = Math.max(0, job.totalSubmitted - job.processedCount);
      job.percent = Math.min(100, Math.round((job.processedCount / Math.max(1, job.totalSubmitted)) * 100));

      this.saveLeads();
      const inMemory = this.importJobs.find(j => j.id === job.id);
      if (inMemory) {
        Object.assign(inMemory, job);
      }
      this.saveImportJobs();

      // Yield event loop so Node server stays responsive for concurrent users
      await new Promise(r => setTimeout(r, 10));
    }

    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.percent = 100;
    job.remainingCount = 0;
    this.saveLeads();
    const finalInMemory = this.importJobs.find(j => j.id === job.id);
    if (finalInMemory) {
      Object.assign(finalInMemory, job);
    }
    this.saveImportJobs();
  }

  getImportJob(jobId) {
    this.loadImportJobs();
    return this.importJobs.find(j => j.id === jobId) || null;
  }

  exportImportJobReport(jobId) {
    const job = this.getImportJob(jobId);
    if (!job) throw new Error('Import job not found');

    const headers = ['Email', 'Status', 'Reason', 'Line Number', 'Business Name', 'Website'];
    const rows = [];

    (job.acceptedRecords || []).forEach(r => {
      rows.push([`"${r.email || ''}"`, 'ACCEPTED', `"${r.status || 'Created'}"`, `"${r.row || ''}"`, `"${r.businessName || ''}"`, `"${r.website || ''}"`]);
    });
    (job.duplicateRecords || []).forEach(r => {
      rows.push([`"${r.email || ''}"`, 'DUPLICATE', `"${r.reason || 'Already exists in database'}"`, `"${r.row || ''}"`, `"${r.businessName || ''}"`, `"${r.website || ''}"`]);
    });
    (job.invalidRecords || []).forEach(r => {
      rows.push([`"${r.email || r.raw || ''}"`, 'INVALID_FORMAT', `"${r.reason || 'Invalid email syntax'}"`, `"${r.row || ''}"`, `"${r.businessName || ''}"`, `"${r.website || ''}"`]);
    });
    (job.suppressedRecords || []).forEach(r => {
      rows.push([`"${r.email || ''}"`, 'SUPPRESSED', `"${r.reason || 'Recipient suppressed'}"`, `"${r.row || ''}"`, `"${r.businessName || ''}"`, `"${r.website || ''}"`]);
    });

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }

  // --- SYNCHRONOUS LEGACY IMPORT FOR BACKWARD COMPATIBILITY ---
  importRawRecords(rawText, { defaultNiche = '', updateExisting = false } = {}) {
    if (!rawText || !rawText.trim()) {
      return { total: 0, imported: 0, duplicates: 0, invalid: 0, suppressed: 0, errors: [] };
    }

    this.loadLeads();
    const existingMap = new Map(this.leads.map(l => [l.email.toLowerCase(), l]));
    const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

    const imported = [];
    const skippedDuplicates = [];
    const invalidEmails = [];
    const suppressedEmails = [];

    let headerMap = null;
    let startIndex = 0;

    if (lines.length > 0) {
      const firstLineLower = lines[0].toLowerCase();
      if (firstLineLower.includes('email') || firstLineLower.includes('name') || firstLineLower.includes('company')) {
        headerMap = this.parseCsvHeader(lines[0]);
        startIndex = 1;
      }
    }

    const seenInBatch = new Set();

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;

      const record = headerMap ? this.parseCsvRowWithHeader(line, headerMap) : this.parseGenericRow(line);
      if (!record || !record.email) continue;

      const cleanEmail = record.email.toLowerCase().trim();

      if (!EmailValidator.EMAIL_REGEX.test(cleanEmail)) {
        invalidEmails.push({ row: i + 1, raw: line, email: cleanEmail });
        continue;
      }

      if (seenInBatch.has(cleanEmail)) {
        skippedDuplicates.push({ row: i + 1, email: cleanEmail, reason: 'Duplicate in batch' });
        continue;
      }
      seenInBatch.add(cleanEmail);

      const isSuppressed = this.bounceService ? this.bounceService.isSuppressed(cleanEmail) : false;
      if (isSuppressed) {
        suppressedEmails.push({ row: i + 1, email: cleanEmail, reason: 'Recipient on suppression/unsubscribe list' });
      }

      if (existingMap.has(cleanEmail)) {
        if (updateExisting) {
          const existingLead = existingMap.get(cleanEmail);
          if (record.name) existingLead.name = record.name;
          if (record.company) existingLead.company = record.company;
          if (record.website) existingLead.website = record.website;
          if (record.phone) existingLead.phone = record.phone;
          if (record.niche || defaultNiche) existingLead.niche = record.niche || defaultNiche;
          existingLead.updatedAt = new Date().toISOString();
        } else {
          skippedDuplicates.push({ row: i + 1, email: cleanEmail, reason: 'Already in leads database' });
          continue;
        }
      } else {
        const computedName = record.name || cleanEmail.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        const lead = {
          id: `lead-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
          email: cleanEmail,
          name: computedName,
          firstName: record.firstName || computedName.split(' ')[0] || computedName,
          lastName: record.lastName || (record.name ? record.name.split(' ').slice(1).join(' ') : ''),
          company: record.company || '',
          businessName: record.company || '',
          website: record.website || '',
          niche: record.niche || defaultNiche || '',
          phone: record.phone || '',
          customFields: record.customFields || {},
          websiteAuditStatus: 'none',
          status: isSuppressed ? 'Suppressed' : 'Active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        this.leads.push(lead);
        existingMap.set(cleanEmail, lead);
        imported.push(lead);
      }
    }

    this.saveLeads();

    return {
      total: lines.length - startIndex,
      importedCount: imported.length,
      duplicateCount: skippedDuplicates.length,
      invalidCount: invalidEmails.length,
      suppressedCount: suppressedEmails.length,
      imported,
      skippedDuplicates,
      invalidEmails,
      suppressedEmails
    };
  }

  importFromRawText(rawText, options) {
    const res = this.importRawRecords(rawText, options);
    return {
      imported: res.importedCount,
      updated: (res.imported || []).length === 0 && options?.updateExisting ? (res.total - res.invalidCount) : 1,
      skippedDuplicates: res.duplicateCount,
      invalid: res.invalidCount,
      errors: res.invalidEmails || []
    };
  }

  parseCsvHeader(headerLine) {
    const cols = this.splitRow(headerLine).map(c => c.toLowerCase().trim().replace(/^["']|["']$/g, ''));
    const map = {};
    cols.forEach((col, idx) => {
      if (col.includes('email')) map.email = idx;
      else if (col === 'first_name' || col === 'firstname' || col === 'first') map.firstName = idx;
      else if (col === 'last_name' || col === 'lastname' || col === 'last') map.lastName = idx;
      else if (col.includes('name')) map.name = idx;
      else if (col.includes('company') || col.includes('organization') || col.includes('business')) map.company = idx;
      else if (col.includes('website') || col.includes('url') || col.includes('domain')) map.website = idx;
      else if (col.includes('city')) map.city = idx;
      else if (col.includes('niche') || col.includes('industry')) map.niche = idx;
      else if (col.includes('phone') || col.includes('mobile')) map.phone = idx;
    });
    return map;
  }

  splitRow(line) {
    if (line.includes('\t')) return line.split('\t');
    if (line.includes(';')) return line.split(';');

    const regex = /(?:,|\n|^)("(?:(?:"")*[^"]*)*"|[^",\n]*|(?:\n|$))/g;
    const matches = [];
    let match;
    while ((match = regex.exec(line))) {
      let str = match[1];
      if (str) {
        str = str.replace(/^"|"$/g, '').replace(/""/g, '"').trim();
        matches.push(str);
      }
    }
    return matches.length > 0 ? matches : line.split(',').map(s => s.trim());
  }

  parseCsvRowWithHeader(line, headerMap) {
    const parts = this.splitRow(line);
    const email = headerMap.email !== undefined ? parts[headerMap.email] : '';
    const name = headerMap.name !== undefined ? parts[headerMap.name] : '';
    const firstName = headerMap.firstName !== undefined ? parts[headerMap.firstName] : '';
    const lastName = headerMap.lastName !== undefined ? parts[headerMap.lastName] : '';
    const company = headerMap.company !== undefined ? parts[headerMap.company] : '';
    const website = headerMap.website !== undefined ? parts[headerMap.website] : '';
    const phone = headerMap.phone !== undefined ? parts[headerMap.phone] : '';
    const city = headerMap.city !== undefined ? parts[headerMap.city] : '';
    const niche = headerMap.niche !== undefined ? parts[headerMap.niche] : '';

    return { email, name, firstName, lastName, company, website, phone, city, niche };
  }

  parseGenericRow(line) {
    const parts = this.splitRow(line);
    if (parts.length === 1) {
      return { email: parts[0] };
    }
    if (parts.length === 2) {
      if (parts[0].includes('@')) return { email: parts[0], company: parts[1] };
      return { name: parts[0], email: parts[1] };
    }
    let emailIdx = parts.findIndex(p => p.includes('@'));
    if (emailIdx === -1) emailIdx = 1;
    const email = parts[emailIdx];
    const name = emailIdx > 0 ? parts[0] : (parts[1] || '');
    const company = parts.length > 2 && emailIdx !== 2 ? parts[2] : (parts[3] || '');
    const website = parts.find(p => p.includes('http') || p.includes('.com') || p.includes('.io')) || '';
    return { email, name, company, website };
  }

  exportToCsv() {
    this.loadLeads();
    const headers = ['Email', 'Name', 'Business Name', 'Website', 'Phone', 'City', 'Category', 'Audit Status', 'Audit Score', 'Status', 'Created At'];
    const rows = this.leads.map(l => [
      `"${(l.email || '').replace(/"/g, '""')}"`,
      `"${(l.name || '').replace(/"/g, '""')}"`,
      `"${(l.businessName || l.company || '').replace(/"/g, '""')}"`,
      `"${(l.website || '').replace(/"/g, '""')}"`,
      `"${(l.phone || '').replace(/"/g, '""')}"`,
      `"${(l.city || '').replace(/"/g, '""')}"`,
      `"${(l.category || l.niche || '').replace(/"/g, '""')}"`,
      `"${(l.websiteAuditStatus || 'none').replace(/"/g, '""')}"`,
      `"${l.websiteAuditScore !== null && l.websiteAuditScore !== undefined ? l.websiteAuditScore : ''}"`,
      `"${(l.status || 'Active').replace(/"/g, '""')}"`,
      `"${(l.createdAt || '').replace(/"/g, '""')}"`
    ]);

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }

  // Personalization parser supporting: {{businessName}}, {{website}}, {{city}}, {{auditFinding}}, {{name}}, {{company}}
  static renderTemplate(template, lead = {}, sender = {}) {
    if (!template || typeof template !== 'string') return { text: '', unresolved: [] };

    const unresolved = [];
    const senderName = sender.name || sender.senderName || 'Our Team';
    const senderFirst = senderName.split(' ')[0] || senderName;
    const senderEmail = sender.email || sender.senderEmail || '';

    const leadEmail = lead.email || '';
    const leadBusiness = lead.businessName || lead.company || '';
    const rawName = lead.name || '';
    const rawFirst = lead.firstName || (rawName ? rawName.split(' ')[0] : (leadBusiness || ''));
    const leadWebsite = lead.website || '';
    const leadCity = lead.city || '';
    const auditFinding = lead.websiteAuditSummary || '';

    const rendered = template.replace(/\{\{\s*([a-zA-Z0-9_-]+)(?:\|([^}]+))?\s*\}\}/g, (match, varName, fallback) => {
      const key = varName.toLowerCase();
      const fb = fallback !== undefined ? fallback.trim() : null;

      switch (key) {
        case 'email':
          return leadEmail || (fb !== null ? fb : '');
        case 'name':
          return rawName || (fb !== null ? fb : (rawFirst || (leadEmail ? leadEmail.split('@')[0] : 'there')));
        case 'firstname':
        case 'first_name':
          return rawFirst || (fb !== null ? fb : (rawName || 'there'));
        case 'lastname':
        case 'last_name':
          return lead.lastName || (fb !== null ? fb : '');
        case 'businessname':
        case 'business_name':
          return leadBusiness || (fb !== null ? fb : (rawName ? `${rawName}'s team` : 'your business'));
        case 'company':
        case 'organization':
          return leadBusiness || (fb !== null ? fb : (rawName ? `${rawName}'s team` : 'your team'));
        case 'website':
        case 'site':
        case 'url':
          return leadWebsite || (fb !== null ? fb : '');
        case 'city':
        case 'location':
          return leadCity || lead.location || (fb !== null ? fb : '');
        case 'auditfinding':
        case 'audit_finding':
        case 'finding':
          return auditFinding || (fb !== null ? fb : 'some areas for search optimization');
        case 'niche':
        case 'industry':
        case 'category':
          return lead.niche || lead.category || (fb !== null ? fb : '');
        case 'phone':
          return lead.phone || (fb !== null ? fb : '');
        case 'sendername':
        case 'sender_name':
        case 'sender':
          return senderName || (fb !== null ? fb : 'Team');
        case 'senderfirstname':
        case 'sender_firstname':
          return senderFirst || (fb !== null ? fb : 'Team');
        case 'senderemail':
        case 'sender_email':
          return senderEmail || (fb !== null ? fb : '');
        default:
          if (lead.customFields && lead.customFields[varName]) {
            return lead.customFields[varName];
          }
          if (fb !== null) {
            return fb;
          }
          unresolved.push(match);
          return match;
      }
    });

    return { text: rendered, unresolved };
  }
}

module.exports = LeadService;
