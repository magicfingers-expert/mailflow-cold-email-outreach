const fs = require('fs');
const path = require('path');
const storage = require('./storageService');
const EmailService = require('./emailService');
const QueueService = require('./queueService');
const InboxService = require('./inboxService');
const BounceService = require('./bounceService').BounceService || require('./bounceService');
const LeadService = require('./leadService');
const WebsiteAuditorService = require('./websiteAuditorService');
const ScraperService = require('./scraperService');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TENANTS_DIR = path.join(DATA_DIR, 'tenants');

const DEFAULT_MESSAGE_VARIANTS = [
  { subject: "", message: "" },
  { subject: "", message: "" },
  { subject: "", message: "" },
  { subject: "", message: "" },
  { subject: "", message: "" }
];

class TenantManager {
  constructor() {
    this.instances = new Map();
    this.ensureDirectory(TENANTS_DIR);
    this.bootstrapDefaultTenant();
  }

  ensureDirectory(dirPath) {
    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
    } catch (e) {}
  }

  getTenantDir(tenantId) {
    const cleanId = (tenantId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    const tenantDir = path.join(TENANTS_DIR, cleanId);
    this.ensureDirectory(tenantDir);
    return tenantDir;
  }

  getTenantFilePaths(tenantId) {
    const dir = this.getTenantDir(tenantId);
    return {
      accountsFile: path.join(dir, 'accounts.json'),
      campaignsFile: path.join(dir, 'campaigns.json'),
      openEventsFile: path.join(dir, 'open_events.json'),
      inboxCacheFile: path.join(dir, 'inbox_cache.json'),
      bouncesFile: path.join(dir, 'bounces.json'),
      suppressionFile: path.join(dir, 'suppression.json'),
      leadsFile: path.join(dir, 'leads.json'),
      variantsFile: path.join(dir, 'saved_variants.json'),
      draftsFile: path.join(dir, 'drafts.json'),
      auditsFile: path.join(dir, 'website_audits.json'),
      scraperJobsFile: path.join(dir, 'scraping_jobs.json'),
      importJobsFile: path.join(dir, 'import_jobs.json')
    };
  }

  /**
   * Initializes or migrates initial data for a tenant directory
   */
  ensureTenantFiles(tenantId) {
    const paths = this.getTenantFilePaths(tenantId);

    // Initialize blank variants if missing
    if (!storage.exists(paths.variantsFile)) {
      storage.writeJSON(paths.variantsFile, DEFAULT_MESSAGE_VARIANTS);
    }

    // Initialize drafts if missing
    if (!storage.exists(paths.draftsFile)) {
      storage.writeJSON(paths.draftsFile, { subject: '', message: '', updatedAt: new Date().toISOString() });
    }

    // Initialize empty collections if missing
    [
      paths.accountsFile,
      paths.campaignsFile,
      paths.openEventsFile,
      paths.inboxCacheFile,
      paths.bouncesFile,
      paths.suppressionFile,
      paths.leadsFile,
      paths.auditsFile,
      paths.scraperJobsFile,
      paths.importJobsFile
    ].forEach(filePath => {
      if (!storage.exists(filePath)) {
        storage.writeJSON(filePath, []);
      }
    });

    return paths;
  }

  /**
   * Migrate any existing top-level data into 'default' tenant
   */
  bootstrapDefaultTenant() {
    const defaultPaths = this.ensureTenantFiles('default');

    // Check if legacy root data files exist with data and copy if tenant directory is empty
    const legacyFiles = [
      { legacy: path.join(DATA_DIR, 'accounts.json'), target: defaultPaths.accountsFile },
      { legacy: path.join(DATA_DIR, 'campaigns.json'), target: defaultPaths.campaignsFile },
      { legacy: path.join(DATA_DIR, 'open_events.json'), target: defaultPaths.openEventsFile },
      { legacy: path.join(DATA_DIR, 'inbox_cache.json'), target: defaultPaths.inboxCacheFile },
      { legacy: path.join(DATA_DIR, 'bounces.json'), target: defaultPaths.bouncesFile },
      { legacy: path.join(DATA_DIR, 'suppression.json'), target: defaultPaths.suppressionFile },
      { legacy: path.join(DATA_DIR, 'saved_variants.json'), target: defaultPaths.variantsFile },
      { legacy: path.join(DATA_DIR, 'drafts.json'), target: defaultPaths.draftsFile }
    ];

    legacyFiles.forEach(({ legacy, target }) => {
      try {
        if (storage.exists(legacy)) {
          const legacyData = storage.readJSON(legacy, null);
          const currentTargetData = storage.readJSON(target, null);
          // If target is empty array/default but legacy had actual content, seed target with legacy data
          const isTargetEmpty = !currentTargetData || (Array.isArray(currentTargetData) && currentTargetData.length === 0);
          if (legacyData && isTargetEmpty) {
            storage.writeJSON(target, legacyData);
          }
        }
      } catch (e) {}
    });
  }

  /**
   * Get or create tenant-scoped service bundle
   */
  getTenantServices(tenantId = 'default') {
    const cleanId = (tenantId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');

    if (this.instances.has(cleanId)) {
      return this.instances.get(cleanId);
    }

    const paths = this.ensureTenantFiles(cleanId);

    // Instantiate tenant-isolated services
    const bounceService = new BounceService({
      bouncesFile: paths.bouncesFile,
      suppressionFile: paths.suppressionFile,
      tenantId: cleanId
    });

    const emailService = new EmailService({
      accountsFile: paths.accountsFile,
      tenantId: cleanId
    });

    const leadService = new LeadService({
      leadsFile: paths.leadsFile,
      tenantId: cleanId,
      bounceService
    });

    const queueService = new QueueService(emailService, {
      campaignsFile: paths.campaignsFile,
      openEventsFile: paths.openEventsFile,
      tenantId: cleanId,
      bounceService,
      leadService
    });

    const inboxService = new InboxService(emailService, queueService, {
      cacheFile: paths.inboxCacheFile,
      tenantId: cleanId,
      bounceService,
      autoSync: cleanId === 'default' // Background sync for default tenant in local dev
    });

    const websiteAuditorService = new WebsiteAuditorService({
      auditsFile: paths.auditsFile,
      tenantId: cleanId
    });

    const scraperService = new ScraperService({
      jobsFile: paths.scraperJobsFile,
      tenantId: cleanId,
      leadService
    });

    const bundle = {
      tenantId: cleanId,
      paths,
      emailService,
      queueService,
      inboxService,
      bounceService,
      leadService,
      websiteAuditorService,
      scraperService,

      // Variant Helpers
      getVariants: () => {
        const data = storage.readJSON(paths.variantsFile, null);
        if (Array.isArray(data) && data.length >= 5) {
          return data;
        }
        return DEFAULT_MESSAGE_VARIANTS;
      },
      saveVariants: (variants) => {
        return storage.writeJSON(paths.variantsFile, variants);
      },
      saveVariantAtIndex: (index, subject, message) => {
        const variants = [...bundle.getVariants()];
        if (index >= 0 && index < 5) {
          variants[index] = {
            subject: subject !== undefined ? subject : (variants[index]?.subject || ''),
            message: message !== undefined ? message : (variants[index]?.message || '')
          };
          bundle.saveVariants(variants);
          return variants[index];
        }
        return null;
      },

      // Draft Helpers
      getDraft: () => {
        const draft = storage.readJSON(paths.draftsFile, null);
        if (draft && draft.subject !== undefined) return draft;
        const variants = bundle.getVariants();
        return variants[0] || { subject: '', message: '' };
      },
      saveDraft: (draftData) => {
        return storage.writeJSON(paths.draftsFile, {
          ...draftData,
          updatedAt: new Date().toISOString()
        });
      }
    };

    this.instances.set(cleanId, bundle);
    return bundle;
  }

  /**
   * Route tracking pixel hit to the correct tenant's queue service
   */
  handleEmailOpen(trackingId, meta = {}) {
    if (!trackingId) return null;

    let targetTenantId = 'default';

    // 1. Try extracting tenant from prefix format: trk_<tenantId>_<timestamp>_...
    if (trackingId.startsWith('trk_')) {
      const parts = trackingId.split('_');
      if (parts.length >= 3) {
        targetTenantId = parts[1];
      }
    } else if (trackingId.startsWith('test_')) {
      const parts = trackingId.split('_');
      if (parts.length >= 3) {
        targetTenantId = parts[1];
      }
    }

    // Verify candidate tenant services
    let services = this.getTenantServices(targetTenantId);
    services.queueService.loadCampaigns();
    let matched = services.queueService.campaigns.some(c =>
      c.recipients && c.recipients.some(r => r.trackingId === trackingId)
    ) || (services.queueService.testTrackings && services.queueService.testTrackings.has(trackingId));

    // If not matched in candidate tenant, search across all existing tenants
    if (!matched) {
      try {
        const allTenants = db.getAllTenants();
        for (const t of allTenants) {
          if (t.id === targetTenantId) continue;
          const s = this.getTenantServices(t.id);
          s.queueService.loadCampaigns();
          const found = s.queueService.campaigns.some(c =>
            c.recipients && c.recipients.some(r => r.trackingId === trackingId)
          ) || (s.queueService.testTrackings && s.queueService.testTrackings.has(trackingId));
          if (found) {
            targetTenantId = t.id;
            services = s;
            matched = true;
            break;
          }
        }
      } catch (e) {}

      // Fallback: check all directories under data/tenants/
      if (!matched) {
        try {
          const tenantsDir = path.join(DATA_DIR, 'tenants');
          if (fs.existsSync(tenantsDir)) {
            const dirs = fs.readdirSync(tenantsDir);
            for (const dirName of dirs) {
              if (dirName === targetTenantId) continue;
              const s = this.getTenantServices(dirName);
              s.queueService.loadCampaigns();
              const found = s.queueService.campaigns.some(c =>
                c.recipients && c.recipients.some(r => r.trackingId === trackingId)
              ) || (s.queueService.testTrackings && s.queueService.testTrackings.has(trackingId));
              if (found) {
                targetTenantId = dirName;
                services = s;
                matched = true;
                break;
              }
            }
          }
        } catch (e) {}
      }
    }

    return services.queueService.recordEmailOpen(trackingId, meta);
  }

  /**
   * Remove cached tenant instances when a tenant is removed
   */
  evictTenant(tenantId) {
    if (this.instances.has(tenantId)) {
      this.instances.delete(tenantId);
    }
  }
}

const tenantManager = new TenantManager();
module.exports = tenantManager;
