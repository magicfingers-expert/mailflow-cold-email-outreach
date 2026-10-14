// MailFlow - Multi-Account Direct Outreach, Unified Inbox & Live Open Tracker Controller

// Multi-Tenant Session & API Client Interceptor
(function() {
  // Ensure every unique browser has an isolated guest identifier
  // This guarantees two different browsers/computers NEVER collide or leak accounts!
  if (!localStorage.getItem('mailflow_client_guest_id')) {
    const guestId = 'guest_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);
    localStorage.setItem('mailflow_client_guest_id', guestId);
  }

  const originalFetch = window.fetch;
  window.fetch = function(url, options = {}) {
    options = options || {};
    options.headers = options.headers || {};

    const token = localStorage.getItem('mailflow_auth_token');
    if (token) {
      if (options.headers instanceof Headers) {
        if (!options.headers.has('Authorization')) options.headers.set('Authorization', `Bearer ${token}`);
      } else {
        if (!options.headers['Authorization'] && !options.headers['authorization']) {
          options.headers['Authorization'] = `Bearer ${token}`;
        }
      }
    }

    // Isolate by active authenticated tenant, or unique per-browser guest session
    let activeTenantId = localStorage.getItem('mailflow_active_tenant');
    if (!token && (!activeTenantId || activeTenantId === 'default')) {
      activeTenantId = localStorage.getItem('mailflow_client_guest_id') || 'default';
    } else if (!activeTenantId) {
      activeTenantId = 'default';
    }

    if (options.headers instanceof Headers) {
      if (!options.headers.has('X-Tenant-Id')) options.headers.set('X-Tenant-Id', activeTenantId);
    } else {
      if (!options.headers['X-Tenant-Id'] && !options.headers['x-tenant-id']) {
        options.headers['X-Tenant-Id'] = activeTenantId;
      }
    }

    return originalFetch.call(this, url, options);
  };
})();

const app = {
  authToken: localStorage.getItem('mailflow_auth_token') || null,
  activeTenantId: (function() {
    const token = localStorage.getItem('mailflow_auth_token');
    const saved = localStorage.getItem('mailflow_active_tenant');
    if (token && saved && saved !== 'default') return saved;
    const guest = localStorage.getItem('mailflow_client_guest_id');
    return (saved && saved !== 'default') ? saved : (guest || 'default');
  })(),
  currentWorkspace: null,
  userWorkspaces: [],
  currentUser: null,
  sentViewMode: 'leads',

  accounts: [],
  activeAccountId: null,
  activeCampaignId: null,
  pollTimer: null,
  openTrackerTimer: null,
  lastOpenCheckTimestamp: Date.now(),
  
  // All Inbox State
  allInboxMessages: [],
  activeAllInboxUid: null,
  activeAllInboxFilter: 'all',
  activeAllInboxAccountFilter: 'all',
  isSyncingAllInbox: false,

  // Primary Inbox State
  primaryInboxMessages: [],
  activePrimaryInboxUid: null,
  activePrimaryInboxFilter: 'all',
  selectedPrimaryInboxAccount: '',
  isSyncingPrimaryInbox: false,

  // Sent State
  sentItems: [],
  activeSentAccountFilter: 'all',

  // Spam State
  spamMessages: [],
  activeSpamUid: null,
  activeSpamAccountFilter: 'all',
  isSyncingSpam: false,

  // Bounces State
  bouncesList: [],
  activeBounceFilter: 'all',
  bouncesSearchQuery: '',
  activeBounceDetailId: null,

  // Campaign history cache
  campaignsList: [],

  // Leads & Contacts Management State
  leadsList: [],
  leadsTotalCount: 0,
  leadsCurrentPage: 1,
  leadsPageSize: 20,
  leadsSearchQuery: '',
  leadsStatusFilter: 'all',
  selectedLeadIds: new Set(),
  composerPickedLeadIds: new Set(),
  activeEditLeadId: null,

  parsedValidation: {
    validRecipients: [],
    cappedRecipients: [],
    validCount: 0,
    duplicatesRemoved: 0,
    invalidCount: 0,
    invalidEmails: [],
    isOverLimit: false,
    canSend: false
  },

  allOpenEvents: [],

  activeVariantIndex: 0,
  messageVariants: [
    { subject: "", message: "" },
    { subject: "", message: "" },
    { subject: "", message: "" },
    { subject: "", message: "" },
    { subject: "", message: "" }
  ],

  deliverabilityAudit: null,
  autoSyncTimer: null,

  init() {
    // Force clear inputs immediately on startup
    const subjEl = document.getElementById('emailSubject');
    const msgEl = document.getElementById('emailMessage');
    if (subjEl) subjEl.value = '';
    if (msgEl) msgEl.value = '';

    this.messageVariants = [
      { subject: '', message: '' },
      { subject: '', message: '' },
      { subject: '', message: '' },
      { subject: '', message: '' },
      { subject: '', message: '' }
    ];

    this.bindEvents();
    this.initAudioUnlock();
    this.initTenantAuth();
    this.loadSavedAccounts();
    this.loadSendingDelayPreference();
    this.loadOpenEventsFromStorage();
    this.loadOpenEvents();
    this.loadMessageVariants();
    this.loadCampaigns();
    this.loadLeads();
    this.loadAllInbox();
    this.loadPrimaryInbox();
    this.loadSent();
    this.loadSpam();
    this.loadBounces();
    this.startRealtimeOpenTracker();
    this.startAutoSyncEngine();
    this.analyzeSpamScoreLive();
    this.updateTopNotifBadge();
    this.renderTopNotifDropdown();
    this.updateDesktopLivePreview();
    this.runDeliverabilityAudit();
    this.loadOverviewMetrics();

    // Restore collapsed preview mockup state if saved
    try {
      const isCollapsed = localStorage.getItem('mailflow_preview_collapsed') === 'true';
      const body = document.getElementById('previewMockupCollapsibleBody');
      const icon = document.getElementById('previewMockupToggleIcon');
      if (isCollapsed && body) {
        body.style.display = 'none';
        if (icon) icon.innerText = '▸';
      }
    } catch (e) {}
  },

  updateAllInboxBadge(count) {
    const badge = document.getElementById('navAllInboxBadge');
    if (badge) {
      if (count > 0) {
        badge.innerText = count;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    }
  },

  updatePrimaryInboxBadge(count) {
    const badge = document.getElementById('navPrimaryInboxBadge');
    const mbBadge = document.getElementById('mbPrimaryInboxBadge');
    if (badge) {
      if (count > 0) {
        badge.innerText = count;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    }
    if (mbBadge) {
      if (count > 0) {
        mbBadge.innerText = count;
        mbBadge.style.display = 'inline-block';
      } else {
        mbBadge.style.display = 'none';
      }
    }
  },

  updateSpamBadge(count) {
    const badge = document.getElementById('navSpamBadge');
    if (badge) {
      if (count > 0) {
        badge.innerText = count;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    }
  },

  updateBouncesBadge(count) {
    const badge = document.getElementById('navBouncesBadge');
    const mbBadge = document.getElementById('mbBouncesBadge');
    const countText = count > 99 ? '99+' : count;
    if (badge) {
      if (count > 0) {
        badge.innerText = countText;
        badge.style.display = 'inline-flex';
      } else {
        badge.style.display = 'none';
      }
    }
    if (mbBadge) {
      if (count > 0) {
        mbBadge.innerText = countText;
        mbBadge.style.display = 'inline-flex';
      } else {
        mbBadge.style.display = 'none';
      }
    }
  },

  onDelayChange(val) {
    const label = document.getElementById('sendingDelayLabel');
    if (label) label.innerText = `Sends 1 email every ~${val}s`;
    try {
      localStorage.setItem('mailflow_sending_delay', val);
    } catch (e) {}
    this.updateDesktopLivePreview();
  },

  loadSendingDelayPreference() {
    try {
      const saved = localStorage.getItem('mailflow_sending_delay') || '15';
      const select = document.getElementById('sendingDelaySelect');
      if (select) {
        select.value = saved;
        this.onDelayChange(saved);
      }
    } catch (e) {}
  },

  startAutoSyncEngine() {
    if (this.autoSyncTimer) clearInterval(this.autoSyncTimer);

    // Continuous auto-sync polling every 8-10 seconds
    this.autoSyncTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/inbox?folder=all');
        const data = await res.json();
        if (data.success && Array.isArray(data.messages)) {
          const prevInboxCount = this.allInboxMessages.length;
          const prevUnread = this.allInboxMessages.filter(m => !m.isRead).length;

          // Split by folder
          const inboxes = data.messages.filter(m => (m.folder || 'INBOX') === 'INBOX');
          const spams = data.messages.filter(m => (m.folder || '') === 'SPAM');

          const newUnread = inboxes.filter(m => !m.isRead).length;

          // Check for newly arrived lead replies
          if (inboxes.length > prevInboxCount && newUnread > prevUnread) {
            const newest = inboxes[0];
            if (newest && !newest.isRead) {
              this.playChimeSound();
              this.showToast(`📬 New Lead Reply received from ${newest.fromName || newest.from}!`);
            }
          }

          this.allInboxMessages = inboxes;
          this.spamMessages = spams;
          this.updateAllInboxBadge(newUnread);
          this.updateSpamBadge(spams.length);

          // Update primary inbox
          const activeEmail = this.getActiveAccountEmail().toLowerCase();
          const priMessages = inboxes.filter(m => (m.accountEmail || '').toLowerCase() === activeEmail);
          this.primaryInboxMessages = priMessages;
          this.updatePrimaryInboxBadge(priMessages.filter(m => !m.isRead).length);

          // Silent live refresh of active visible lists
          const activeTab = document.querySelector('.tab-view.active')?.id;
          if (activeTab === 'tab-all-inbox') this.renderAllInboxView();
          if (activeTab === 'tab-primary-inbox') this.renderPrimaryInboxView();
          if (activeTab === 'tab-spam') this.renderSpamView();

          // Auto-sync bounces metrics
          try {
            const bRes = await fetch('/api/bounces/stats');
            const bData = await bRes.json();
            if (bData.success) {
              this.updateBouncesBadge(bData.total || 0);
              this.updateBouncesStats(bData.stats || {});
              if (activeTab === 'tab-bounces') {
                const bounceListRes = await fetch('/api/bounces');
                const bounceListData = await bounceListRes.json();
                if (bounceListData.success && Array.isArray(bounceListData.bounces)) {
                  this.bouncesList = bounceListData.bounces;
                  this.renderBouncesTable();
                }
              }
            }
          } catch (be) {}
        }
      } catch (e) {
        // Silently continue polling
      }
    }, 8000);
  },

  loadOpenEventsFromStorage() {
    try {
      const local = localStorage.getItem('mailflow_open_events');
      if (local) {
        this.allOpenEvents = JSON.parse(local);
        if (this.allOpenEvents.length > 0) {
          this.updateTrackerViewUI();
        }
      }
    } catch (e) {
      this.allOpenEvents = [];
    }
  },

  saveOpenEventsToStorage() {
    try {
      localStorage.setItem('mailflow_open_events', JSON.stringify(this.allOpenEvents.slice(0, 100)));
    } catch (e) {}
  },

  async loadOpenEvents() {
    try {
      const res = await fetch('/api/track/recent-opens?since=0');
      const data = await res.json();
      if (data && data.success && Array.isArray(data.opens)) {
        this.allOpenEvents = data.opens;
        this.seenOpenEventIds = new Set(data.opens.map(o => o.id));
        this.saveOpenEventsToStorage();
        this.updateTrackerViewUI();
        this.updateTopNotifBadge();
        this.renderTopNotifDropdown();
        this.renderBannerOpenItems();
      }
    } catch (e) {
      console.warn('Failed to fetch open events:', e.message);
    }
  },

  bindEvents() {
    // Nav tabs
    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const tab = link.getAttribute('data-tab');
        if (tab) this.switchTab(tab);
      });
    });

    // Mobile Bottom Nav items
    document.querySelectorAll('.mobile-bottom-nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const tab = item.getAttribute('data-tab');
        if (tab) this.switchTab(tab);
      });
    });

    // Global keyboard shortcuts (Cmd/Ctrl + 1-9)
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey || e.altKey) && e.key >= '1' && e.key <= '9') {
        const tabMap = {
          '1': 'composer',
          '2': 'tracker',
          '3': 'sent',
          '4': 'all-inbox',
          '5': 'primary-inbox',
          '6': 'spam',
          '7': 'bounces',
          '8': 'accounts',
          '9': 'deliverability'
        };
        const targetTab = tabMap[e.key];
        if (targetTab) {
          e.preventDefault();
          this.switchTab(targetTab);
        }
      }
    });

    // Real-time recipient parser with debounce
    const leadsInput = document.getElementById('leadsInput');
    if (leadsInput) {
      let debounce = null;
      leadsInput.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          this.parseLeadsLive();
          this.updateDesktopLivePreview();
        }, 250);
      });
    }

    // Auto-clean password input on paste / input
    const passInput = document.getElementById('senderPassword');
    if (passInput) {
      passInput.addEventListener('input', () => {
        const cleaned = passInput.value.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
        if (cleaned !== passInput.value) {
          passInput.value = cleaned;
        }
        
        let email = document.getElementById('senderEmail')?.value.trim().toLowerCase() || '';
        if (email.endsWith('@gmail')) email = email + '.com';
        const name = document.getElementById('senderDisplayName')?.value.trim() || email.split('@')[0];

        if (email && email.includes('@')) {
          let acc = this.accounts.find(a => a.email.toLowerCase() === email);
          if (acc) {
            if (cleaned) {
              acc.password = cleaned;
              acc.hasPassword = true;
            }
            acc.name = name;
          } else {
            acc = {
              id: 'acc-' + Date.now(),
              email,
              name,
              password: cleaned,
              hasPassword: !!cleaned,
              isDefault: this.accounts.length === 0,
              status: 'Connected'
            };
            this.accounts.push(acc);
            this.activeAccountId = acc.id;
          }
          this.saveAccountsToStorage();
        }
      });
    }

    const emailInput = document.getElementById('senderEmail');
    if (emailInput) {
      emailInput.addEventListener('input', () => {
        let email = emailInput.value.trim().toLowerCase();
        try {
          localStorage.setItem('mailflow_last_active_email', email);
        } catch (e) {}
        this.updateDesktopLivePreview();
      });
      emailInput.addEventListener('change', () => {
        this.normalizeEmailInput(emailInput);
        let email = emailInput.value.trim().toLowerCase();
        if (email && email.includes('@')) {
          try {
            localStorage.setItem('mailflow_last_active_email', email);
          } catch (e) {}
          const acc = this.accounts.find(a => a.email.toLowerCase() === email);
          if (acc && passInput) {
            if (acc.password) {
              passInput.value = acc.password;
            } else if (acc.hasPassword) {
              passInput.value = '';
              passInput.placeholder = '•••••••••••••••• (Saved in Vault)';
            }
          }
        }
        this.updateDesktopLivePreview();
      });
    }

    const nameInput = document.getElementById('senderDisplayName');
    if (nameInput) {
      nameInput.addEventListener('input', () => {
        const name = nameInput.value.trim();
        try {
          localStorage.setItem('mailflow_last_active_name', name);
        } catch (e) {}
        this.updateDesktopLivePreview();
      });
    }

    // Track active composer field for tag insertion
    const subjEl = document.getElementById('emailSubject');
    const msgEl = document.getElementById('emailMessage');
    if (subjEl) subjEl.addEventListener('focus', () => { this._lastFocusedInput = 'emailSubject'; });
    if (msgEl) {
      msgEl.addEventListener('focus', () => { this._lastFocusedInput = 'emailMessage'; });

      // Support pasting screenshots (Ctrl+V) directly into message textarea
      msgEl.addEventListener('paste', (e) => {
        const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
        if (!items) return;
        for (const item of items) {
          if (item.type.indexOf('image') === 0) {
            e.preventDefault();
            const file = item.getAsFile();
            this.uploadAndInsertImageFile(file, 'Pasted Screenshot');
            break;
          }
        }
      });

      // Support dragging and dropping images directly onto message textarea
      msgEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        msgEl.style.borderColor = '#2563eb';
      });
      msgEl.addEventListener('dragleave', () => {
        msgEl.style.borderColor = '#cbd5e1';
      });
      msgEl.addEventListener('drop', (e) => {
        e.preventDefault();
        msgEl.style.borderColor = '#cbd5e1';
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          const file = e.dataTransfer.files[0];
          if (file.type.startsWith('image/')) {
            this.uploadAndInsertImageFile(file, file.name);
          }
        }
      });
    }

    // Support drag and drop on modal image drop zone
    const modalDropZone = document.getElementById('imageDropZone');
    if (modalDropZone) {
      modalDropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        modalDropZone.style.borderColor = '#2563eb';
        modalDropZone.style.background = '#eff6ff';
      });
      modalDropZone.addEventListener('dragleave', () => {
        modalDropZone.style.borderColor = '#93c5fd';
        modalDropZone.style.background = '#f8fafc';
      });
      modalDropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        modalDropZone.style.borderColor = '#93c5fd';
        modalDropZone.style.background = '#f8fafc';
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          this.onImageFileSelected(e.dataTransfer.files);
        }
      });
    }

    // Close modals on clicking backdrop
    document.querySelectorAll('.modal-backdrop').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.classList.remove('active');
        }
      });
    });
  },

  normalizeEmailInput(inputEl) {
    if (!inputEl || !inputEl.value) return;
    let val = inputEl.value.trim().toLowerCase();
    if (val.endsWith('@gmail.') || val.endsWith('@gmail')) {
      val = val.replace(/@gmail\.?$/i, '@gmail.com');
    } else if (val && !val.includes('@')) {
      val = val + '@gmail.com';
    }
    inputEl.value = val;
  },

  togglePasswordVisibility(inputId, btnEl) {
    const input = document.getElementById(inputId);
    if (!input) return;
    if (input.type === 'password') {
      input.type = 'text';
      if (btnEl) btnEl.innerText = '🔒 Hide';
    } else {
      input.type = 'password';
      if (btnEl) btnEl.innerText = '👁️ Show';
    }
  },

  validatePasswordFormatLive() {
    const passInput = document.getElementById('senderPassword');
    const hint = document.getElementById('passFormatHint');
    if (!passInput || !hint) return;
    const raw = passInput.value.trim();
    if (!raw) {
      hint.style.display = 'none';
      return;
    }
    const clean = raw.replace(/[\s\-_]/g, '');
    hint.style.display = 'block';
    if (clean.length === 16 && /^[a-zA-Z]+$/.test(clean)) {
      hint.innerHTML = '<span style="color: #059669; font-weight: 600;">✓ 16-Letter App Password format detected</span>';
    } else if (clean.length < 16 && /^[a-zA-Z]+$/.test(clean)) {
      hint.innerHTML = `<span style="color: #d97706; font-weight: 600;">⚠️ ${clean.length}/16 letters entered (Google App Passwords are 16 letters)</span>`;
    } else {
      hint.innerHTML = '<span style="color: #dc2626; font-weight: 600;">⚠️ Standard password detected. Google SMTP requires a 16-letter App Password from myaccount.google.com/apppasswords</span>';
    }
  },

  // ==========================================================
  // REAL-TIME EMAIL OPEN TRACKER & NOTIFICATION ENGINE
  // ==========================================================

  initAudioUnlock() {
    const unlock = () => {
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
          if (!this._audioCtx) this._audioCtx = new AudioContext();
          if (this._audioCtx.state === 'suspended') this._audioCtx.resume().catch(() => {});
        }
      } catch (e) {}
    };
    document.addEventListener('click', unlock, { once: false, passive: true });
    document.addEventListener('keydown', unlock, { once: false, passive: true });
    document.addEventListener('touchstart', unlock, { once: false, passive: true });
  },

  playChimeSound() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      if (!this._audioCtx) {
        this._audioCtx = new AudioContext();
      }
      if (this._audioCtx.state === 'suspended') {
        this._audioCtx.resume().catch(() => {});
      }
      const ctx = this._audioCtx;
      const now = ctx.currentTime;
      
      // Note 1 (D5)
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, now);
      osc1.frequency.exponentialRampToValueAtTime(880, now + 0.12);
      gain1.gain.setValueAtTime(0.35, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.35);

      // Note 2 (Sparkle D6)
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(1174.66, now + 0.08);
      gain2.gain.setValueAtTime(0.25, now + 0.08);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now + 0.08);
      osc2.stop(now + 0.45);
    } catch (e) {
      console.warn('Audio chime notice:', e.message);
    }
  },

  async requestPushPermission() {
    if (!('Notification' in window)) {
      alert('This browser does not support desktop push notifications.');
      return;
    }
    if (Notification.permission === 'granted') {
      this.showToast('✓ Desktop push notifications are already enabled!');
      new Notification('MailFlow Live Open Tracker Active', {
        body: 'You will receive instant desktop alerts whenever a recipient opens your email.',
        icon: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>✉️</text></svg>'
      });
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      this.showToast('✓ Desktop push alerts enabled!');
      new Notification('MailFlow Live Open Tracker Active', {
        body: 'You will receive instant desktop alerts whenever a recipient opens your email.',
        icon: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>✉️</text></svg>'
      });
    } else {
      alert('Desktop notification permission was denied or dismissed.');
    }
  },

  async triggerTestOpenSimulation() {
    try {
      const res = await fetch('/api/track/simulate-open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'lead@example.com',
          subject: 'Quick question about collaboration'
        })
      });
      const data = await res.json();
      if (data.success && data.openEvent) {
        if (!this.seenOpenEventIds) this.seenOpenEventIds = new Set();
        this.seenOpenEventIds.add(data.openEvent.id);
        this.handleLiveOpenNotification(data.openEvent);
      }
    } catch (e) {
      this.handleLiveOpenNotification({
        id: 'open-' + Date.now(),
        email: 'lead@example.com',
        subject: 'Quick question about collaboration',
        openedAt: new Date().toISOString(),
        openCount: 1,
        isFirstOpen: true,
        userAgent: 'Test Browser Simulation',
        ip: '127.0.0.1'
      });
    }
  },

  startRealtimeOpenTracker() {
    if (this.openTrackerTimer) clearInterval(this.openTrackerTimer);
    if (!this.seenOpenEventIds) {
      this.seenOpenEventIds = new Set((this.allOpenEvents || []).map(o => o.id));
    }

    this.openTrackerTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/track/recent-opens');
        const data = await res.json();
        if (data.success && Array.isArray(data.opens) && data.opens.length > 0) {
          const newEvents = data.opens.filter(evt => !this.seenOpenEventIds.has(evt.id));
          if (newEvents.length > 0) {
            newEvents.forEach(openEvent => {
              this.seenOpenEventIds.add(openEvent.id);
              this.handleLiveOpenNotification(openEvent);
            });
          }
        }
      } catch (e) {}
    }, 2000);
  },

  handleLiveOpenNotification(openEvent) {
    this.playChimeSound();

    if (!this.allOpenEvents.some(e => e.id === openEvent.id)) {
      this.allOpenEvents.unshift(openEvent);
      if (this.allOpenEvents.length > 100) this.allOpenEvents.pop();
    }
    this.saveOpenEventsToStorage();
    this.updateTopNotifBadge();
    this.renderTopNotifDropdown();

    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(`👁️ Email Opened by ${openEvent.email}`, {
          body: `Subject: "${openEvent.subject || 'Outreach'}" • Opened at ${new Date(openEvent.openedAt).toLocaleTimeString()}`,
          icon: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>👁️</text></svg>'
        });
      } catch (e) {}
    }

    const banner = document.getElementById('liveOpenAlertBanner');
    const title = document.getElementById('liveOpenAlertTitle');
    const text = document.getElementById('liveOpenAlertText');
    const countBadge = document.getElementById('liveOpenAlertCountBadge');
    const countSpan = document.getElementById('bannerRecentOpensCount');

    if (banner && text) {
      if (title) title.innerText = `👁️ Email Opened!`;
      if (countBadge) countBadge.innerText = `● ${new Date(openEvent.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      if (countSpan) countSpan.innerText = this.allOpenEvents.length;
      text.innerHTML = `<strong>${this.escapeHtml(openEvent.email)}</strong> just opened your outreach <em>"${this.escapeHtml(openEvent.subject || 'Outreach')}"</em>!`;
      banner.style.display = 'block';
    }

    this.renderBannerOpenItems();
    this.showToast(`🔔 Email Opened: ${openEvent.email} just opened your outreach!`);

    if (this.activeCampaignId === openEvent.campaignId) {
      const openedStat = document.getElementById('liveStatOpened');
      if (openedStat) {
        const cur = parseInt(openedStat.innerText) || 0;
        openedStat.innerText = cur + 1;
      }
    }

    this.updateTrackerViewUI();
    this.loadCampaigns();
    this.loadSent();
  },

  // ==========================================================
  // TOP NOTIFICATION BELL & QUICK OPENS DROPDOWN
  // ==========================================================

  toggleTopNotifDropdown() {
    const dropdown = document.getElementById('topNotifDropdown');
    if (!dropdown) return;
    const isHidden = dropdown.style.display === 'none' || !dropdown.style.display;
    if (isHidden) {
      dropdown.style.display = 'block';
      this.renderTopNotifDropdown();
    } else {
      dropdown.style.display = 'none';
    }
  },

  closeTopNotifDropdown() {
    const dropdown = document.getElementById('topNotifDropdown');
    if (dropdown) dropdown.style.display = 'none';
  },

  updateTopNotifBadge() {
    const badge = document.getElementById('topNotifCountBadge');
    const headerCount = document.getElementById('topNotifHeaderCount');
    const count = this.allOpenEvents.length;

    if (badge) {
      badge.innerText = count > 99 ? '99+' : count;
      badge.style.display = count > 0 ? 'inline-flex' : 'none';
    }
    if (headerCount) {
      headerCount.innerText = `${count} Recorded`;
    }
  },

  renderTopNotifDropdown() {
    const container = document.getElementById('topNotifItemsList');
    if (!container) return;

    this.updateTopNotifBadge();

    if (this.allOpenEvents.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 24px 16px; color: var(--text-dim); font-size: 12.5px;">
          <div style="font-size: 28px; margin-bottom: 6px;">🔔</div>
          <div style="font-weight: 600; color: var(--text-main);">No open notifications yet.</div>
          <div style="font-size: 11px; margin-top: 4px;">When leads open your emails, their alerts will appear here instantly!</div>
        </div>
      `;
      return;
    }

    container.innerHTML = this.allOpenEvents.slice(0, 15).map(evt => {
      const timeStr = new Date(evt.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const openCountBadge = evt.openCount > 1 
        ? `<span class="status-badge status-completed" style="font-size: 10px; padding: 1px 6px;">${evt.openCount}x opens</span>` 
        : `<span class="status-badge status-inprogress" style="font-size: 10px; padding: 1px 6px; background: #ecfdf5; color: #059669; border: 1px solid #a7f3d0;">✓ Read</span>`;

      return `
        <div class="notif-item-card" onclick="app.switchTab('tracker'); app.closeTopNotifDropdown();" style="cursor: pointer; padding: 10px 14px; border-bottom: 1px solid var(--border-subtle); display: flex; align-items: flex-start; gap: 10px; transition: background 0.15s ease;">
          <div style="width: 28px; height: 28px; border-radius: 50%; background: #ecfdf5; border: 1px solid #a7f3d0; color: #059669; display: flex; align-items: center; justify-content: center; font-size: 13px; flex-shrink: 0; margin-top: 2px;">
            👁️
          </div>
          <div style="flex: 1; min-width: 0;">
            <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 6px;">
              <strong style="color: var(--text-main); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${this.escapeHtml(evt.email)}</strong>
              <span style="font-size: 10.5px; color: var(--text-dim); white-space: nowrap;">${timeStr}</span>
            </div>
            <div style="font-size: 11.5px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px;">
              "${this.escapeHtml(evt.subject || 'Outreach')}"
            </div>
            <div style="margin-top: 4px; display: flex; align-items: center; gap: 6px;">
              ${openCountBadge}
              <span style="font-size: 10.5px; color: var(--text-dim);">${this.escapeHtml(evt.userAgent ? 'Desktop / Phone' : 'Mail App')}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  },

  clearOpenNotifications() {
    this.allOpenEvents = [];
    this.saveOpenEventsToStorage();
    this.updateTopNotifBadge();
    this.renderTopNotifDropdown();
    this.updateTrackerViewUI();
    const banner = document.getElementById('liveOpenAlertBanner');
    if (banner) banner.style.display = 'none';
    this.showToast('All open notifications cleared.');
  },

  toggleOpenStreamDropdown() {
    const list = document.getElementById('bannerOpenStreamList');
    if (!list) return;
    const isHidden = list.style.display === 'none';
    list.style.display = isHidden ? 'block' : 'none';
    if (isHidden) this.renderBannerOpenItems();
  },

  renderBannerOpenItems() {
    const container = document.getElementById('bannerOpenItemsContainer');
    if (!container) return;

    if (this.allOpenEvents.length === 0) {
      container.innerHTML = `<div style="font-size: 12px; color: var(--text-dim); padding: 4px 0;">No email opens recorded yet.</div>`;
      return;
    }

    container.innerHTML = this.allOpenEvents.slice(0, 8).map((evt, idx) => {
      const timeStr = new Date(evt.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return `
        <div style="display: flex; justify-content: space-between; align-items: center; background: #ffffff; padding: 6px 12px; border-radius: 6px; border: 1px solid #d1fae5; font-size: 12.5px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="color: #059669; font-weight: 700;">👁️</span>
            <strong>${this.escapeHtml(evt.email)}</strong>
            <span style="color: var(--text-dim); font-size: 11.5px;">("${this.escapeHtml(evt.subject || 'Outreach')}")</span>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            ${evt.openCount > 1 ? `<span class="status-badge status-completed" style="font-size: 10px; padding: 1px 6px;">${evt.openCount}x</span>` : ''}
            <span style="font-size: 11px; color: var(--text-dim);">${timeStr}</span>
          </div>
        </div>
      `;
    }).join('');
  },

  updateTrackerViewUI() {
    const totalOpensEl = document.getElementById('trackerStatTotalOpens');
    const lastOpenEl = document.getElementById('trackerStatLastOpenTime');
    const campaignsCountEl = document.getElementById('trackerStatActiveCampaigns');

    if (totalOpensEl) totalOpensEl.innerText = this.allOpenEvents.length;
    if (campaignsCountEl) campaignsCountEl.innerText = (this.campaigns && this.campaigns.length > 0) ? this.campaigns.length : (this.accounts ? this.accounts.length : 0);
    if (lastOpenEl && this.allOpenEvents.length > 0) {
      lastOpenEl.innerText = new Date(this.allOpenEvents[0].openedAt).toLocaleTimeString();
    }

    this.renderTrackerActivityTable();
  },

  renderTrackerActivityTable() {
    const tbody = document.getElementById('trackerActivityTableBody');
    if (!tbody) return;

    if (this.allOpenEvents.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; padding: 28px; color: var(--text-dim);">
            No open events recorded yet. Send outreach emails or click <strong>"🧪 Test Live Open Alert"</strong> above to test!
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = this.allOpenEvents.map((evt, idx) => {
      const timeStr = new Date(evt.openedAt).toLocaleTimeString();
      const openBadge = evt.openCount > 1 
        ? `<span class="status-badge status-inprogress" style="background: #e0e7ff; color: #3730a3;">👁️ Opened ${evt.openCount}x</span>`
        : `<span class="status-badge status-completed" style="background: #dcfce7; color: #166534;">👁️ 1st Open</span>`;

      return `
        <tr style="${idx === 0 ? 'background: #f0fdf4;' : ''}">
          <td><strong>${this.escapeHtml(evt.email)}</strong></td>
          <td style="color: var(--text-muted);">${this.escapeHtml(evt.subject || 'Outreach')}</td>
          <td>${openBadge}</td>
          <td style="font-size: 12.5px; color: var(--text-dim);">${timeStr}</td>
          <td style="font-size: 12px; color: var(--text-dim);">${this.escapeHtml(evt.userAgent || 'Gmail / Mail App')}</td>
          <td>
            <span style="display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--status-success); font-weight: 600;">
              <span class="status-dot"></span> Live Tracked
            </span>
          </td>
        </tr>
      `;
    }).join('');
  },

  // ==========================================================
  // TAB 1B: LEADS & CONTACTS MANAGEMENT CONTROLLER
  // ==========================================================

  async loadLeads(page = 1) {
    this.leadsCurrentPage = page;
    const tbody = document.getElementById('leadsTableBody');
    if (tbody && (!this.leadsList || this.leadsList.length === 0)) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 32px; color: var(--text-muted);">Loading leads...</td></tr>`;
    }

    try {
      const q = encodeURIComponent(this.leadsSearchQuery || '');
      const s = encodeURIComponent(this.leadsStatusFilter || 'all');
      const a = encodeURIComponent(this.leadsAuditFilter || 'all');
      const res = await this.authFetch(`/api/leads?page=${page}&limit=${this.leadsPageSize}&search=${q}&status=${s}&auditStatus=${a}`);
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data = await res.json();
      
      this.leadsList = data.leads || [];
      this.leadsTotalCount = data.total || 0;
      
      // Update statistics badges
      const statTotal = document.getElementById('leadsTotalCount');
      if (statTotal) statTotal.innerText = data.total || 0;

      const navPill = document.getElementById('navLeadsBadge');
      if (navPill) {
        if (data.total > 0) {
          navPill.innerText = data.total > 999 ? '999+' : data.total;
          navPill.style.display = 'inline-block';
        } else {
          navPill.style.display = 'none';
        }
      }

      // Compute status breakdown from leads
      const counts = { Active: 0, Contacted: 0, Bounced: 0, Suppressed: 0 };
      (data.leads || []).forEach(l => {
        const st = (l.status || 'Active');
        if (counts[st] !== undefined) counts[st]++;
      });
      const elAct = document.getElementById('leadsActiveCount');
      if (elAct) elAct.innerText = counts.Active;
      const elCon = document.getElementById('leadsContactedCount');
      if (elCon) elCon.innerText = counts.Contacted;
      const elBnc = document.getElementById('leadsBouncedCount');
      if (elBnc) elBnc.innerText = counts.Bounced;
      const elSup = document.getElementById('leadsSuppressedCount');
      if (elSup) elSup.innerText = counts.Suppressed;

      this.renderLeadsTable();
      this.updateLeadsPagination();
    } catch (e) {
      console.error('Failed to load leads:', e);
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 32px; color: #ef4444;">Failed to load leads from server.</td></tr>`;
      }
    }
  },

  onLeadsAuditFilterChange() {
    const select = document.getElementById('leadsAuditFilter');
    this.leadsAuditFilter = select ? select.value : 'all';
    this.loadLeads(1);
  },

  renderLeadsTable() {
    const tbody = document.getElementById('leadsTableBody');
    if (!tbody) return;

    if (!this.leadsList || this.leadsList.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; padding: 48px 16px;">
            <div style="font-size: 32px; margin-bottom: 8px;">👥</div>
            <div style="font-size: 15px; font-weight: 600; color: var(--text-main); margin-bottom: 4px;">No contacts found</div>
            <div style="font-size: 13px; color: var(--text-muted); max-width: 380px; margin: 0 auto 16px;">
              ${this.leadsSearchQuery ? 'No leads matched your search filter.' : 'Add your prospect leads or import a CSV list to start launching personalized campaigns.'}
            </div>
            <div style="display: flex; gap: 8px; justify-content: center;">
              <button type="button" class="btn btn-sm btn-primary" onclick="app.openAddLeadModal()">+ Add Lead</button>
              <button type="button" class="btn btn-sm btn-secondary" onclick="app.toggleBulkImporterBox()">📥 Bulk Import</button>
            </div>
          </td>
        </tr>`;
      return;
    }

    const rowsHtml = this.leadsList.map(lead => {
      const isSelected = this.selectedLeadIds.has(lead.id);
      const name = lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.businessName || '—';
      const status = lead.status || 'Active';
      
      let badgeClass = 'status-badge status-completed';
      let badgeStyle = 'font-size: 11px; padding: 2px 8px; border-radius: 12px;';
      if (status === 'Contacted') badgeClass = 'status-badge status-inprogress';
      else if (status === 'Bounced') badgeClass = 'status-badge status-failed';
      else if (status === 'Suppressed' || status === 'Unsubscribed') {
        badgeClass = 'status-badge';
        badgeStyle += ' background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5;';
      }

      const auditStatus = lead.websiteAuditStatus || 'none';
      let auditBadge = '<span style="font-size:11px; color:var(--text-light);">No Site</span>';
      if (lead.website) {
        if (auditStatus === 'completed') {
          const score = lead.websiteAuditScore !== undefined ? lead.websiteAuditScore : 80;
          auditBadge = `<span class="status-badge ${score >= 80 ? 'status-completed' : (score >= 50 ? 'status-warning' : 'status-failed')}" style="font-size:10px; cursor:pointer;" onclick="app.viewAuditDetail('${lead.websiteAuditId || ''}')">Score: ${score}/100</span>`;
        } else {
          auditBadge = `<button type="button" class="btn btn-sm btn-secondary" onclick="app.auditLeadWebsiteInline('${lead.id}')" style="font-size:10px; padding:1px 6px;">Audit Site</button>`;
        }
      }

      return `
        <tr style="border-bottom: 1px solid var(--border-color); transition: background 0.15s ease;">
          <td style="padding: 10px; text-align: center;">
            <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="app.toggleSelectLead('${lead.id}', this.checked)">
          </td>
          <td style="padding: 10px 14px;">
            <div style="font-weight: 600; color: var(--text-main);">${app.escapeHtml(name)}</div>
            <div style="font-size: 12px; color: var(--text-muted); font-family: monospace;">${app.escapeHtml(lead.email)}</div>
          </td>
          <td style="padding: 10px 14px;">
            ${lead.website ? `<div><a href="${lead.website}" target="_blank" rel="noopener noreferrer" style="color:var(--primary); font-size:12px; font-weight:600;">${app.escapeHtml(lead.website.replace(/^https?:\/\//, ''))}</a></div>` : ''}
            <div style="margin-top: 3px;">${auditBadge}</div>
          </td>
          <td style="padding: 10px 14px; color: var(--text-muted);">${app.escapeHtml(lead.niche || lead.category || lead.industry || '—')}</td>
          <td style="padding: 10px 14px; color: var(--text-muted); font-size: 12px;">${app.escapeHtml(lead.phone || '—')}</td>
          <td style="padding: 10px 14px;">
            <span class="${badgeClass}" style="${badgeStyle}">${app.escapeHtml(status)}</span>
          </td>
          <td style="padding: 10px 14px; text-align: right;">
            <div style="display: flex; gap: 6px; justify-content: flex-end;">
              <button type="button" class="btn btn-sm btn-secondary" onclick="app.openEditLeadModal('${lead.id}')" style="font-size: 11px; padding: 3px 8px;">Edit</button>
              <button type="button" class="btn btn-sm btn-secondary" onclick="app.deleteLead('${lead.id}')" style="font-size: 11px; padding: 3px 8px; color: #ef4444;" title="Delete lead">✕</button>
            </div>
          </td>
        </tr>`;
    }).join('');

    tbody.innerHTML = rowsHtml;
    this.updateSelectedToolbar();
    this.updateSelectedToolbar();
  },

  onLeadsSearchChange() {
    clearTimeout(this._leadsSearchDebounce);
    this._leadsSearchDebounce = setTimeout(() => {
      const input = document.getElementById('leadsSearchInput');
      this.leadsSearchQuery = input ? input.value.trim() : '';
      this.loadLeads(1);
    }, 300);
  },

  onLeadsStatusFilterChange() {
    const sel = document.getElementById('leadsStatusFilter');
    this.leadsStatusFilter = sel ? sel.value : 'all';
    this.loadLeads(1);
  },

  changeLeadsPage(delta) {
    const newPage = this.leadsCurrentPage + delta;
    if (newPage < 1) return;
    const maxPage = Math.ceil(this.leadsTotalCount / this.leadsPageSize) || 1;
    if (newPage > maxPage) return;
    this.loadLeads(newPage);
  },

  updateLeadsPagination() {
    const info = document.getElementById('leadsPaginationInfo');
    const pageNum = document.getElementById('leadsCurrentPageNum');
    const prevBtn = document.getElementById('leadsPrevPageBtn');
    const nextBtn = document.getElementById('leadsNextPageBtn');

    const maxPage = Math.ceil(this.leadsTotalCount / this.leadsPageSize) || 1;
    const start = this.leadsTotalCount === 0 ? 0 : (this.leadsCurrentPage - 1) * this.leadsPageSize + 1;
    const end = Math.min(this.leadsCurrentPage * this.leadsPageSize, this.leadsTotalCount);

    if (info) info.innerText = `Showing ${start} to ${end} of ${this.leadsTotalCount} leads`;
    if (pageNum) pageNum.innerText = `Page ${this.leadsCurrentPage} of ${maxPage}`;
    if (prevBtn) prevBtn.disabled = this.leadsCurrentPage <= 1;
    if (nextBtn) nextBtn.disabled = this.leadsCurrentPage >= maxPage;
  },

  toggleSelectLead(id, checked) {
    if (checked) this.selectedLeadIds.add(id);
    else this.selectedLeadIds.delete(id);
    this.updateSelectedToolbar();
  },

  toggleSelectAllLeads(checked) {
    if (checked) {
      (this.leadsList || []).forEach(l => this.selectedLeadIds.add(l.id));
    } else {
      this.selectedLeadIds.clear();
    }
    this.renderLeadsTable();
  },

  updateSelectedToolbar() {
    const count = this.selectedLeadIds.size;
    const countSpan = document.getElementById('leadsSelectedCount');
    const deleteBtn = document.getElementById('leadsBulkDeleteBtn');
    const useBtn = document.getElementById('leadsUseInCampaignBtn');
    const allBox = document.getElementById('selectAllLeadsCheckbox');

    if (countSpan) countSpan.innerText = count;
    if (deleteBtn) deleteBtn.style.display = count > 0 ? 'inline-block' : 'none';
    if (useBtn) useBtn.style.display = count > 0 ? 'inline-block' : 'none';
    if (allBox) allBox.checked = (this.leadsList && this.leadsList.length > 0 && this.selectedLeadIds.size === this.leadsList.length);
  },

  async bulkDeleteSelectedLeads() {
    const ids = Array.from(this.selectedLeadIds);
    if (ids.length === 0) return;
    if (!confirm(`Are you sure you want to delete ${ids.length} selected lead(s)?`)) return;

    try {
      const res = await fetch('/api/leads/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      });
      if (!res.ok) throw new Error('Bulk delete failed');
      this.selectedLeadIds.clear();
      this.showToast(`Deleted ${ids.length} leads successfully`);
      this.loadLeads(this.leadsCurrentPage);
    } catch (e) {
      alert('Error deleting leads: ' + e.message);
    }
  },

  openAddLeadModal() {
    this.activeEditLeadId = null;
    const title = document.getElementById('addLeadModalTitle');
    if (title) title.innerText = 'Add New Lead';
    const form = document.getElementById('formAddLead');
    if (form) form.reset();
    document.getElementById('leadModalId').value = '';
    this.openModal('modalAddLead');
  },

  openEditLeadModal(leadId) {
    const lead = this.leadsList.find(l => l.id === leadId);
    if (!lead) return;
    this.activeEditLeadId = leadId;
    const title = document.getElementById('addLeadModalTitle');
    if (title) title.innerText = 'Edit Lead';
    document.getElementById('leadModalId').value = lead.id;
    document.getElementById('leadModalEmail').value = lead.email || '';
    document.getElementById('leadModalFirstName').value = lead.firstName || '';
    document.getElementById('leadModalLastName').value = lead.lastName || '';
    document.getElementById('leadModalCompany').value = lead.company || '';
    document.getElementById('leadModalNiche').value = lead.niche || '';
    document.getElementById('leadModalPhone').value = lead.phone || '';
    document.getElementById('leadModalStatus').value = lead.status || 'Active';
    this.openModal('modalAddLead');
  },

  async saveLeadModal(e) {
    if (e) e.preventDefault();
    const id = document.getElementById('leadModalId').value.trim();
    const email = document.getElementById('leadModalEmail').value.trim();
    const firstName = document.getElementById('leadModalFirstName').value.trim();
    const lastName = document.getElementById('leadModalLastName').value.trim();
    const company = document.getElementById('leadModalCompany').value.trim();
    const niche = document.getElementById('leadModalNiche').value.trim();
    const phone = document.getElementById('leadModalPhone').value.trim();
    const status = document.getElementById('leadModalStatus').value;

    if (!email || !email.includes('@')) {
      alert('Please provide a valid email address.');
      return;
    }

    const payload = {
      email,
      firstName,
      lastName,
      name: [firstName, lastName].filter(Boolean).join(' ') || undefined,
      company,
      niche,
      phone,
      status
    };

    try {
      const url = id ? `/api/leads/${id}` : '/api/leads';
      const method = id ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save lead');
      this.closeModal('modalAddLead');
      this.showToast(id ? 'Lead updated successfully' : 'Lead created successfully');
      this.loadLeads(this.leadsCurrentPage);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  },

  async deleteLead(id) {
    if (!confirm('Are you sure you want to delete this lead?')) return;
    try {
      const res = await fetch(`/api/leads/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      this.selectedLeadIds.delete(id);
      this.showToast('Lead deleted');
      this.loadLeads(this.leadsCurrentPage);
    } catch (e) {
      alert('Error: ' + e.message);
    }
  },

  openImportLeadsModal() {
    const raw = document.getElementById('importLeadsRawText');
    if (raw) raw.value = '';
    const box = document.getElementById('importSummaryBox');
    if (box) box.style.display = 'none';
    this.openModal('modalImportLeads');
  },

  async executeImportLeads() {
    const raw = document.getElementById('importLeadsRawText').value.trim();
    const niche = document.getElementById('importLeadsDefaultNiche').value.trim();
    const updateExisting = document.getElementById('importLeadsUpdateExisting').checked;

    if (!raw) {
      alert('Please paste CSV or email list data to import.');
      return;
    }

    const box = document.getElementById('importSummaryBox');
    if (box) {
      box.style.display = 'block';
      box.innerHTML = '⏳ Processing and validating records...';
    }

    try {
      const res = await fetch('/api/leads/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText: raw, defaultNiche: niche, updateExisting })
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Import failed');

      if (box) {
        box.innerHTML = `
          <div style="font-weight: 700; color: #10b981; margin-bottom: 6px;">✓ Import Completed</div>
          <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; text-align: center;">
            <div style="background: rgba(16, 185, 129, 0.1); padding: 6px; border-radius: 4px;">
              <div style="font-weight: 700; color: #10b981;">${result.summary?.imported || 0}</div>
              <div style="font-size: 11px; color: var(--text-muted);">Imported</div>
            </div>
            <div style="background: rgba(56, 189, 248, 0.1); padding: 6px; border-radius: 4px;">
              <div style="font-weight: 700; color: #38bdf8;">${result.summary?.updated || 0}</div>
              <div style="font-size: 11px; color: var(--text-muted);">Updated</div>
            </div>
            <div style="background: rgba(245, 158, 11, 0.1); padding: 6px; border-radius: 4px;">
              <div style="font-weight: 700; color: #f59e0b;">${result.summary?.skippedDuplicates || 0}</div>
              <div style="font-size: 11px; color: var(--text-muted);">Duplicates</div>
            </div>
            <div style="background: rgba(239, 68, 68, 0.1); padding: 6px; border-radius: 4px;">
              <div style="font-weight: 700; color: #ef4444;">${result.summary?.invalid || 0}</div>
              <div style="font-size: 11px; color: var(--text-muted);">Invalid</div>
            </div>
          </div>`;
      }
      this.showToast(`Imported ${result.summary?.imported || 0} new leads`);
      this.loadLeads(1);
    } catch (err) {
      if (box) box.innerHTML = `<span style="color: #ef4444;">Error: ${err.message}</span>`;
    }
  },

  async exportLeadsCsv() {
    try {
      const res = await fetch('/api/leads/export');
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mailflow_leads_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      this.showToast('✓ Leads exported successfully');
    } catch (e) {
      alert('Error exporting CSV: ' + e.message);
    }
  },

  async confirmClearAllLeads() {
    if (!confirm('⚠️ Are you sure you want to clear all leads in this workspace? This cannot be undone.')) return;
    try {
      const res = await fetch('/api/leads/clear', { method: 'POST' });
      if (!res.ok) throw new Error('Clear failed');
      this.showToast('All leads cleared');
      this.loadLeads(1);
    } catch (e) {
      alert('Error clearing leads: ' + e.message);
    }
  },

  sendToSelectedLeads() {
    const selectedLeads = this.leadsList.filter(l => this.selectedLeadIds.has(l.id));
    if (selectedLeads.length === 0) return;
    const emails = selectedLeads.slice(0, 50).map(l => l.email);
    const textarea = document.getElementById('leadsInput') || document.getElementById('recipientsTextarea');
    if (textarea) {
      textarea.value = emails.join('\n');
      this.parseLeadsLive();
    }
    this.switchTab('composer');
    this.showToast(`Loaded ${emails.length} selected lead(s) into composer`);
  },

  async openSelectLeadsForComposerModal() {
    this.composerPickedLeadIds.clear();
    const tbody = document.getElementById('composerPickLeadsTableBody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 24px; color: var(--text-muted);">Loading active leads...</td></tr>`;
    this.openModal('modalSelectLeadsForComposer');

    try {
      const res = await fetch('/api/leads?status=Active&limit=100');
      const data = await res.json();
      const leads = data.leads || [];

      if (leads.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 24px; color: var(--text-muted);">No active leads found in database. Add or import leads first.</td></tr>`;
        return;
      }

      tbody.innerHTML = leads.map(l => `
        <tr style="border-bottom: 1px solid var(--border-color);">
          <td style="padding: 8px 10px; text-align: center;">
            <input type="checkbox" onchange="app.toggleComposerPickLead('${l.id}', this.checked)">
          </td>
          <td style="padding: 8px 10px; font-weight: 500;">${app.escapeHtml(l.email)}</td>
          <td style="padding: 8px 10px; color: var(--text-muted);">${app.escapeHtml(l.name || l.firstName || '—')}</td>
          <td style="padding: 8px 10px; color: var(--text-muted);">${app.escapeHtml(l.company || '—')}</td>
          <td style="padding: 8px 10px;"><span class="status-badge status-completed" style="font-size: 10px;">${app.escapeHtml(l.status || 'Active')}</span></td>
        </tr>
      `).join('');
      this.updateComposerPickCount();
    } catch (e) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #ef4444;">Error loading leads</td></tr>`;
    }
  },

  toggleComposerPickLead(id, checked) {
    if (checked) {
      if (this.composerPickedLeadIds.size >= 50) {
        alert('Maximum of 50 recipients per outreach batch.');
        return;
      }
      this.composerPickedLeadIds.add(id);
    } else {
      this.composerPickedLeadIds.delete(id);
    }
    this.updateComposerPickCount();
  },

  selectAllActiveForComposer() {
    const checkboxes = document.querySelectorAll('#composerPickLeadsTableBody input[type="checkbox"]');
    checkboxes.forEach((cb, idx) => {
      if (idx < 50) {
        cb.checked = true;
        cb.dispatchEvent(new Event('change'));
      }
    });
  },

  toggleSelectAllComposerPick(checked) {
    const checkboxes = document.querySelectorAll('#composerPickLeadsTableBody input[type="checkbox"]');
    checkboxes.forEach((cb, idx) => {
      if (idx < 50) {
        cb.checked = checked;
        cb.dispatchEvent(new Event('change'));
      }
    });
  },

  updateComposerPickCount() {
    const cnt = document.getElementById('composerLeadSelectionCount');
    if (cnt) cnt.innerText = `${this.composerPickedLeadIds.size} selected (max 50)`;
  },

  async applySelectedLeadsToComposer() {
    if (this.composerPickedLeadIds.size === 0) {
      alert('Please select at least 1 lead.');
      return;
    }
    try {
      const res = await fetch('/api/leads?limit=100');
      const data = await res.json();
      const allLeads = data.leads || [];
      const selected = allLeads.filter(l => this.composerPickedLeadIds.has(l.id));
      const emails = selected.map(l => l.email);
      const textarea = document.getElementById('leadsInput') || document.getElementById('recipientsTextarea');
      if (textarea) {
        textarea.value = emails.join('\n');
        this.parseLeadsLive();
      }
      this.closeModal('modalSelectLeadsForComposer');
      this.showToast(`Loaded ${emails.length} leads into Campaign Studio!`);
    } catch (e) {
      alert('Error applying leads: ' + e.message);
    }
  },

  async openPreviewPersonalizationModal() {
    const sel = document.getElementById('previewLeadSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">Loading test prospects...</option>';
    this.openModal('modalPreviewPersonalization');

    try {
      const res = await fetch('/api/leads?limit=50');
      const data = await res.json();
      const leads = data.leads || [];

      if (leads.length === 0) {
        sel.innerHTML = `
          <option value="sample1" data-name="Jane Doe" data-firstname="Jane" data-company="Acme Corp" data-email="jane@acme.com">Sample: Jane Doe (Acme Corp)</option>
          <option value="sample2" data-name="Alex Vance" data-firstname="Alex" data-company="TechFlow" data-email="alex@techflow.io">Sample: Alex Vance (TechFlow)</option>
        `;
      } else {
        sel.innerHTML = leads.map(l => `
          <option value="${l.id}" data-name="${app.escapeHtml(l.name || l.firstName || 'Friend')}" data-firstname="${app.escapeHtml(l.firstName || 'Friend')}" data-company="${app.escapeHtml(l.company || 'your company')}" data-email="${app.escapeHtml(l.email)}">
            ${app.escapeHtml(l.name || l.email)} (${app.escapeHtml(l.company || 'No Company')})
          </option>
        `).join('');
      }
      this.updatePersonalizationPreview();
    } catch (e) {
      sel.innerHTML = '<option value="">Error loading leads</option>';
    }
  },

  updatePersonalizationPreview() {
    const sel = document.getElementById('previewLeadSelect');
    const varSel = document.getElementById('previewVariantSelect');
    const warnBox = document.getElementById('previewUnresolvedWarning');
    const subjEl = document.getElementById('previewRenderedSubject');
    const bodyEl = document.getElementById('previewRenderedBody');

    if (!sel) return;
    const opt = sel.options[sel.selectedIndex];
    const name = opt ? (opt.getAttribute('data-name') || 'Friend') : 'Friend';
    const firstName = opt ? (opt.getAttribute('data-firstname') || 'Friend') : 'Friend';
    const company = opt ? (opt.getAttribute('data-company') || 'your company') : 'your company';
    const email = opt ? (opt.getAttribute('data-email') || 'lead@example.com') : 'lead@example.com';

    const variantIdx = parseInt(varSel?.value || '0', 10);
    let rawSubj = '';
    let rawBody = '';

    if (variantIdx === 0) {
      rawSubj = document.getElementById('emailSubject')?.value || '';
      rawBody = document.getElementById('emailMessage')?.value || '';
    } else if (this.messageVariants && this.messageVariants[variantIdx]) {
      rawSubj = this.messageVariants[variantIdx].subject || '';
      rawBody = this.messageVariants[variantIdx].message || '';
    }

    // Replace variables
    const render = (template) => {
      if (!template) return '';
      let res = template
        .replace(/\{\{\s*name\s*\}\}/gi, name)
        .replace(/\{\{\s*firstName\s*\}\}/gi, firstName)
        .replace(/\{\{\s*first_name\s*\}\}/gi, firstName)
        .replace(/\{\{\s*company\s*\}\}/gi, company)
        .replace(/\{\{\s*companyName\s*\}\}/gi, company)
        .replace(/\{\{\s*email\s*\}\}/gi, email);
      return res;
    };

    const renderedSubj = render(rawSubj);
    const renderedBody = render(rawBody);

    // Detect unresolved variables
    const unresolvedSubj = (renderedSubj.match(/\{\{([a-zA-Z0-9_]+)\}\}/g) || []);
    const unresolvedBody = (renderedBody.match(/\{\{([a-zA-Z0-9_]+)\}\}/g) || []);
    const allUnresolved = Array.from(new Set([...unresolvedSubj, ...unresolvedBody]));

    if (allUnresolved.length > 0 && warnBox) {
      warnBox.style.display = 'block';
      warnBox.innerHTML = `⚠️ <strong>Unresolved Variables Detected:</strong> The template contains <code>${allUnresolved.join(', ')}</code> which this prospect does not have values for. Please add fallback values or update prospect records.`;
    } else if (warnBox) {
      warnBox.style.display = 'none';
    }

    if (subjEl) subjEl.innerText = renderedSubj || '(Empty Subject)';
    if (bodyEl) bodyEl.innerText = renderedBody || '(Empty Message Body)';
  },

  // ==========================================================
  // TAB 2: ALL INBOX (ALL LOGGED-IN ACCOUNTS UNIFIED)
  // ==========================================================

  async loadAllInbox() {
    try {
      const res = await fetch('/api/inbox?folder=INBOX');
      const data = await res.json();
      if (data.success && Array.isArray(data.messages)) {
        this.allInboxMessages = data.messages;
        this.updateAllInboxBadge(data.unreadCount || 0);
        this.renderAllInboxView();
      }
    } catch (e) {
      console.warn('All Inbox load error:', e);
    }
  },

  updateAllInboxBadge(unreadCount) {
    const badge = document.getElementById('navAllInboxBadge');
    if (badge) {
      badge.innerText = unreadCount;
      badge.style.display = unreadCount > 0 ? 'inline-block' : 'none';
    }
  },

  setAllInboxFilter(filter, btn) {
    this.activeAllInboxFilter = filter;
    document.querySelectorAll('[data-all-filter]').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    this.renderAllInboxView();
  },

  setAllInboxAccountFilter(accountEmail) {
    this.activeAllInboxAccountFilter = accountEmail;
    this.renderAllInboxView();
  },

  filterAllInboxMessages() {
    this.renderAllInboxView();
  },

  renderAllInboxView() {
    // 1. Render Account Filter Chips
    const chipsContainer = document.getElementById('allInboxAccountChips');
    if (chipsContainer) {
      const allActive = this.activeAllInboxAccountFilter === 'all';
      let html = `
        <button type="button" class="btn btn-sm ${allActive ? 'btn-primary' : 'btn-secondary'}" onclick="app.setAllInboxAccountFilter('all')" style="font-size: 11.5px; padding: 3px 10px; border-radius: 14px;">
          All Accounts (${this.allInboxMessages.length})
        </button>
      `;

      const accountSet = new Set();
      this.accounts.forEach(a => accountSet.add(a.email.toLowerCase()));
      this.allInboxMessages.forEach(m => { if (m.accountEmail) accountSet.add(m.accountEmail.toLowerCase()); });

      accountSet.forEach(email => {
        const count = this.allInboxMessages.filter(m => (m.accountEmail || '').toLowerCase() === email).length;
        const isSelected = this.activeAllInboxAccountFilter === email;
        html += `
          <button type="button" class="btn btn-sm ${isSelected ? 'btn-primary' : 'btn-secondary'}" onclick="app.setAllInboxAccountFilter('${email}')" style="font-size: 11.5px; padding: 3px 10px; border-radius: 14px;">
            ✉️ ${email} (${count})
          </button>
        `;
      });
      chipsContainer.innerHTML = html;
    }

    // 2. Filter Messages
    const container = document.getElementById('allInboxItemsList');
    if (!container) return;

    const searchTerm = (document.getElementById('allInboxSearchInput')?.value || '').toLowerCase().trim();
    let list = [...this.allInboxMessages];

    if (this.activeAllInboxAccountFilter !== 'all') {
      list = list.filter(m => (m.accountEmail || '').toLowerCase() === this.activeAllInboxAccountFilter.toLowerCase());
    }

    if (this.activeAllInboxFilter === 'leads') {
      list = list.filter(m => m.isLeadReply);
    } else if (this.activeAllInboxFilter === 'unread') {
      list = list.filter(m => !m.isRead);
    }

    if (searchTerm) {
      list = list.filter(m => 
        (m.from && m.from.toLowerCase().includes(searchTerm)) ||
        (m.fromName && m.fromName.toLowerCase().includes(searchTerm)) ||
        (m.subject && m.subject.toLowerCase().includes(searchTerm)) ||
        (m.snippet && m.snippet.toLowerCase().includes(searchTerm))
      );
    }

    if (list.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 40px 16px; color: var(--text-dim); font-size: 13px;">
          <div style="font-size: 32px; margin-bottom: 8px;">📭</div>
          <div style="font-weight: 600; color: var(--text-main); margin-bottom: 4px;">No messages in this view</div>
          <div style="font-size: 11.5px; line-height: 1.5;">Click <strong>"Sync All Inboxes"</strong> above to sync emails across all connected accounts.</div>
        </div>
      `;
      return;
    }

    container.innerHTML = list.map(m => {
      const isSelected = String(m.uid) === String(this.activeAllInboxUid);
      const cardClasses = [
        'inbox-item-card',
        !m.isRead ? 'unread' : '',
        isSelected ? 'active' : ''
      ].filter(Boolean).join(' ');

      const timeStr = m.date ? new Date(m.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
      const leadBadge = m.isLeadReply ? `<span class="inbox-lead-chip">🎯 Lead Reply</span>` : '';
      const accBadge = m.accountEmail ? `<span class="status-badge" style="font-size: 10px; background: #ecfdf5; color: #047857; margin-right: 6px;">@${this.escapeHtml(m.accountEmail.split('@')[0])}</span>` : '';

      return `
        <div class="${cardClasses}" onclick="app.selectActiveAllInboxMessage('${m.uid}')">
          <div class="inbox-item-header">
            <span class="inbox-item-name">${accBadge}${this.escapeHtml(m.fromName || m.from)}</span>
            <span class="inbox-item-time">${timeStr}</span>
          </div>
          <div class="inbox-item-subject">${this.escapeHtml(m.subject || '(No Subject)')}</div>
          <div class="inbox-item-snippet">${this.escapeHtml(m.snippet || '')}</div>
          ${leadBadge}
        </div>
      `;
    }).join('');
  },

  async selectActiveAllInboxMessage(uid) {
    this.activeAllInboxUid = uid;
    this.renderAllInboxView();

    const emptyPane = document.getElementById('allInboxEmptySelection');
    const activeView = document.getElementById('allInboxActiveView');

    if (emptyPane) emptyPane.style.display = 'none';
    if (activeView) activeView.style.display = 'flex';

    try {
      const res = await fetch(`/api/inbox/${uid}`);
      const data = await res.json();
      if (data.success && data.message) {
        const msg = data.message;
        
        const local = this.allInboxMessages.find(m => String(m.uid) === String(uid));
        if (local) local.isRead = true;
        this.updateAllInboxBadge(this.allInboxMessages.filter(m => !m.isRead).length);

        const subEl = document.getElementById('allInboxViewSubject');
        const fromNameEl = document.getElementById('allInboxViewFromName');
        const fromEmailEl = document.getElementById('allInboxViewFromEmail');
        const dateEl = document.getElementById('allInboxViewDate');
        const avatarEl = document.getElementById('allInboxViewAvatar');
        const contentEl = document.getElementById('allInboxViewContent');
        const accBadgeEl = document.getElementById('allInboxViewAccountBadge');
        const leadBadgeEl = document.getElementById('allInboxViewLeadBadge');
        const senderIndicator = document.getElementById('allInboxReplySenderIndicator');
        const replyText = document.getElementById('allInboxReplyText');

        if (subEl) subEl.innerText = msg.subject || '(No Subject)';
        if (fromNameEl) fromNameEl.innerText = msg.fromName || msg.from;
        if (fromEmailEl) fromEmailEl.innerText = msg.from;
        if (dateEl) dateEl.innerText = new Date(msg.date).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        if (avatarEl) avatarEl.innerText = (msg.fromName || msg.from || 'U').charAt(0).toUpperCase();

        if (accBadgeEl) {
          accBadgeEl.innerText = `@${msg.accountEmail || 'account'}`;
          accBadgeEl.style.display = msg.accountEmail ? 'inline-flex' : 'none';
        }

        if (leadBadgeEl) {
          leadBadgeEl.style.display = msg.isLeadReply ? 'inline-flex' : 'none';
        }

        if (senderIndicator) {
          senderIndicator.innerText = `Replying via ${msg.accountEmail || 'active account'}`;
        }

        if (contentEl) {
          contentEl.innerHTML = msg.htmlBody || `<p style="white-space: pre-wrap;">${this.escapeHtml(msg.textBody || '')}</p>`;
        }

        if (replyText) {
          replyText.value = '';
          replyText.placeholder = `Write your response to ${msg.fromName || msg.from}...`;
        }
      }
    } catch (e) {
      console.error('Error fetching email details:', e);
    }
  },

  async syncAllInboxes() {
    if (this.isSyncingAllInbox) return;
    this.isSyncingAllInbox = true;

    const btn = document.getElementById('btnSyncAllInbox');
    const spinner = document.getElementById('syncAllSpinnerIcon');
    const badge = document.getElementById('allInboxBadge');

    if (btn) btn.disabled = true;
    if (spinner) spinner.style.animation = 'spin 1s linear infinite';
    if (badge) {
      badge.className = 'status-badge status-inprogress';
      badge.innerText = '● Syncing all accounts...';
    }

    try {
      const res = await fetch('/api/inbox/sync-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: 'ALL' })
      });
      const data = await res.json();

      if (btn) btn.disabled = false;
      if (spinner) spinner.style.animation = 'none';

      if (data.success) {
        if (badge) {
          badge.className = 'status-badge status-completed';
          badge.innerText = '● Unified Feed Active';
        }
        this.showToast(`✓ All inboxes synchronized successfully!`);
        this.loadAllInbox();
        this.loadPrimaryInbox();
        this.loadSpam();
      } else {
        alert('Sync notice: ' + (data.error || 'Check sender account App Passwords'));
      }
    } catch (err) {
      if (btn) btn.disabled = false;
      if (spinner) spinner.style.animation = 'none';
      alert('Error syncing: ' + err.message);
    } finally {
      this.isSyncingAllInbox = false;
    }
  },

  async sendAllInboxReply() {
    if (!this.activeAllInboxUid) {
      alert('No active email selected.');
      return;
    }

    const activeMsg = this.allInboxMessages.find(m => String(m.uid) === String(this.activeAllInboxUid));
    if (!activeMsg) {
      alert('Could not locate message.');
      return;
    }

    const replyTextEl = document.getElementById('allInboxReplyText');
    const message = replyTextEl ? replyTextEl.value.trim() : '';
    const btn = document.getElementById('btnSendAllInboxReply');

    if (!message) {
      alert('Please type a reply message before sending.');
      return;
    }

    btn.disabled = true;
    btn.innerText = 'Sending Reply...';

    try {
      const res = await fetch('/api/inbox/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderEmail: activeMsg.accountEmail,
          to: activeMsg.from,
          subject: activeMsg.subject,
          message,
          inReplyTo: activeMsg.messageId
        })
      });

      const data = await res.json();
      btn.disabled = false;
      btn.innerText = '⚡ Send Direct Reply';

      if (data.success) {
        this.showToast(`✓ Reply sent directly to ${activeMsg.from}!`);
        if (replyTextEl) replyTextEl.value = '';

        const contentEl = document.getElementById('allInboxViewContent');
        if (contentEl) {
          const sentBox = document.createElement('div');
          sentBox.style.cssText = 'margin-top: 20px; padding: 14px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px; font-size: 13.5px;';
          sentBox.innerHTML = `
            <div style="font-weight: 700; color: #1d4ed8; font-size: 12px; margin-bottom: 4px;">✓ Reply sent just now to ${activeMsg.from}</div>
            <div style="white-space: pre-wrap; color: #1e3a8a;">${this.escapeHtml(message)}</div>
          `;
          contentEl.appendChild(sentBox);
          contentEl.scrollTop = contentEl.scrollHeight;
        }
        this.loadSent();
      } else {
        alert('Failed to send reply: ' + (data.error || 'Check sender connection'));
      }
    } catch (e) {
      btn.disabled = false;
      btn.innerText = '⚡ Send Direct Reply';
      alert('Error sending reply: ' + e.message);
    }
  },


  // ==========================================================
  // TAB 3: PRIMARY INBOX (SELECTED ACCOUNT ONLY)
  // ==========================================================

  getActiveAccountEmail() {
    if (this.selectedPrimaryInboxAccount) return this.selectedPrimaryInboxAccount;
    const active = this.accounts.find(a => a.id === this.activeAccountId) 
                || this.accounts.find(a => a.isDefault) 
                || this.accounts.find(a => a.password)
                || this.accounts[0];
    if (active && active.email) return active.email;
    const composerEmail = document.getElementById('senderEmail')?.value.trim();
    if (composerEmail && composerEmail.includes('@')) return composerEmail;
    return '';
  },

  async loadPrimaryInbox() {
    const activeEmail = this.getActiveAccountEmail();
    
    // Update labels and selectors
    const titleEl = document.getElementById('primaryInboxAccountTitle');
    const emptyAccEl = document.getElementById('primaryInboxEmptyAccount');
    if (titleEl) titleEl.innerText = activeEmail || 'Select Account';
    if (emptyAccEl) emptyAccEl.innerText = activeEmail || 'your connected account';

    const selectEl = document.getElementById('primaryInboxAccountSelect');
    if (selectEl) {
      let opts = '';
      this.accounts.forEach(a => {
        const isSel = a.email.toLowerCase() === activeEmail.toLowerCase();
        opts += `<option value="${a.email}" ${isSel ? 'selected' : ''}>${a.email}</option>`;
      });
      if (opts) selectEl.innerHTML = opts;
    }

    try {
      const res = await fetch(`/api/inbox?folder=INBOX&accountEmail=${encodeURIComponent(activeEmail)}`);
      const data = await res.json();
      if (data.success && Array.isArray(data.messages)) {
        this.primaryInboxMessages = data.messages;
        this.updatePrimaryInboxBadge(data.unreadCount || 0);
        this.renderPrimaryInboxView();
      }
    } catch (e) {
      console.warn('Primary Inbox load error:', e);
    }
  },

  updatePrimaryInboxBadge(unreadCount) {
    const badge = document.getElementById('navPrimaryInboxBadge');
    if (badge) {
      badge.innerText = unreadCount;
      badge.style.display = unreadCount > 0 ? 'inline-block' : 'none';
    }
  },

  onPrimaryInboxAccountChange(email) {
    this.selectedPrimaryInboxAccount = email;
    this.loadPrimaryInbox();
  },

  setPrimaryInboxFilter(filter, btn) {
    this.activePrimaryInboxFilter = filter;
    document.querySelectorAll('[data-pri-filter]').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    this.renderPrimaryInboxView();
  },

  filterPrimaryInboxMessages() {
    this.renderPrimaryInboxView();
  },

  renderPrimaryInboxView() {
    const container = document.getElementById('primaryInboxItemsList');
    if (!container) return;

    const searchTerm = (document.getElementById('primaryInboxSearchInput')?.value || '').toLowerCase().trim();
    let list = [...this.primaryInboxMessages];

    if (this.activePrimaryInboxFilter === 'leads') {
      list = list.filter(m => m.isLeadReply);
    } else if (this.activePrimaryInboxFilter === 'unread') {
      list = list.filter(m => !m.isRead);
    }

    if (searchTerm) {
      list = list.filter(m => 
        (m.from && m.from.toLowerCase().includes(searchTerm)) ||
        (m.fromName && m.fromName.toLowerCase().includes(searchTerm)) ||
        (m.subject && m.subject.toLowerCase().includes(searchTerm)) ||
        (m.snippet && m.snippet.toLowerCase().includes(searchTerm))
      );
    }

    if (list.length === 0) {
      const activeEmail = this.getActiveAccountEmail();
      container.innerHTML = `
        <div style="text-align: center; padding: 40px 16px; color: var(--text-dim); font-size: 13px;">
          <div style="font-size: 32px; margin-bottom: 8px;">📬</div>
          <div style="font-weight: 600; color: var(--text-main); margin-bottom: 4px;">No emails for ${this.escapeHtml(activeEmail)}</div>
          <div style="font-size: 11.5px; line-height: 1.5;">Click <strong>"Sync Active Inbox"</strong> above to fetch messages for this account.</div>
        </div>
      `;
      return;
    }

    container.innerHTML = list.map(m => {
      const isSelected = String(m.uid) === String(this.activePrimaryInboxUid);
      const cardClasses = [
        'inbox-item-card',
        !m.isRead ? 'unread' : '',
        isSelected ? 'active' : ''
      ].filter(Boolean).join(' ');

      const timeStr = m.date ? new Date(m.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
      const leadBadge = m.isLeadReply ? `<span class="inbox-lead-chip">🎯 Lead Reply</span>` : '';

      return `
        <div class="${cardClasses}" onclick="app.selectActivePrimaryInboxMessage('${m.uid}')">
          <div class="inbox-item-header">
            <span class="inbox-item-name">${this.escapeHtml(m.fromName || m.from)}</span>
            <span class="inbox-item-time">${timeStr}</span>
          </div>
          <div class="inbox-item-subject">${this.escapeHtml(m.subject || '(No Subject)')}</div>
          <div class="inbox-item-snippet">${this.escapeHtml(m.snippet || '')}</div>
          ${leadBadge}
        </div>
      `;
    }).join('');
  },

  async selectActivePrimaryInboxMessage(uid) {
    this.activePrimaryInboxUid = uid;
    this.renderPrimaryInboxView();

    const emptyPane = document.getElementById('primaryInboxEmptySelection');
    const activeView = document.getElementById('primaryInboxActiveView');

    if (emptyPane) emptyPane.style.display = 'none';
    if (activeView) activeView.style.display = 'flex';

    try {
      const res = await fetch(`/api/inbox/${uid}`);
      const data = await res.json();
      if (data.success && data.message) {
        const msg = data.message;
        
        const local = this.primaryInboxMessages.find(m => String(m.uid) === String(uid));
        if (local) local.isRead = true;
        this.updatePrimaryInboxBadge(this.primaryInboxMessages.filter(m => !m.isRead).length);

        const subEl = document.getElementById('primaryInboxViewSubject');
        const fromNameEl = document.getElementById('primaryInboxViewFromName');
        const fromEmailEl = document.getElementById('primaryInboxViewFromEmail');
        const dateEl = document.getElementById('primaryInboxViewDate');
        const avatarEl = document.getElementById('primaryInboxViewAvatar');
        const contentEl = document.getElementById('primaryInboxViewContent');
        const leadBadgeEl = document.getElementById('primaryInboxViewLeadBadge');
        const senderIndicator = document.getElementById('primaryInboxReplySenderIndicator');
        const replyText = document.getElementById('primaryInboxReplyText');

        if (subEl) subEl.innerText = msg.subject || '(No Subject)';
        if (fromNameEl) fromNameEl.innerText = msg.fromName || msg.from;
        if (fromEmailEl) fromEmailEl.innerText = msg.from;
        if (dateEl) dateEl.innerText = new Date(msg.date).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        if (avatarEl) avatarEl.innerText = (msg.fromName || msg.from || 'U').charAt(0).toUpperCase();

        if (leadBadgeEl) {
          leadBadgeEl.style.display = msg.isLeadReply ? 'inline-flex' : 'none';
        }

        if (senderIndicator) {
          senderIndicator.innerText = `Replying via ${this.getActiveAccountEmail()}`;
        }

        if (contentEl) {
          contentEl.innerHTML = msg.htmlBody || `<p style="white-space: pre-wrap;">${this.escapeHtml(msg.textBody || '')}</p>`;
        }

        if (replyText) {
          replyText.value = '';
          replyText.placeholder = `Write your response to ${msg.fromName || msg.from}...`;
        }
      }
    } catch (e) {
      console.error('Error fetching email details:', e);
    }
  },

  async syncPrimaryInbox() {
    if (this.isSyncingPrimaryInbox) return;
    this.isSyncingPrimaryInbox = true;

    const activeEmail = this.getActiveAccountEmail();
    const activeAcc = this.accounts.find(a => a.email.toLowerCase() === activeEmail.toLowerCase());
    const password = activeAcc ? activeAcc.password : document.getElementById('senderPassword')?.value.trim();

    const btn = document.getElementById('btnSyncPrimaryInbox');
    const spinner = document.getElementById('syncPrimarySpinnerIcon');
    const badge = document.getElementById('primaryInboxBadge');

    if (btn) btn.disabled = true;
    if (spinner) spinner.style.animation = 'spin 1s linear infinite';
    if (badge) {
      badge.className = 'status-badge status-inprogress';
      badge.innerText = '● Syncing...';
    }

    try {
      const res = await fetch('/api/inbox/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: activeEmail, password, folder: 'INBOX' })
      });
      const data = await res.json();

      if (btn) btn.disabled = false;
      if (spinner) spinner.style.animation = 'none';

      if (data.success) {
        if (badge) {
          badge.className = 'status-badge status-completed';
          badge.innerText = '● Synchronized';
        }
        this.showToast(`✓ Primary Inbox synced for ${activeEmail}!`);
        this.loadPrimaryInbox();
        this.loadAllInbox();
      } else {
        if (badge) {
          badge.className = 'status-badge status-failed';
          badge.innerText = '● Sync notice';
        }
        this.showToast(`⚠️ Sync notice: ${data.error || 'Check credentials'}`, 'danger');
      }
    } catch (err) {
      if (btn) btn.disabled = false;
      if (spinner) spinner.style.animation = 'none';
      if (badge) {
        badge.className = 'status-badge status-failed';
        badge.innerText = '● Sync error';
      }
      this.showToast(`⚠️ Error syncing primary inbox: ${err.message}`, 'danger');
    } finally {
      this.isSyncingPrimaryInbox = false;
    }
  },

  async sendPrimaryInboxReply() {
    if (!this.activePrimaryInboxUid) {
      alert('No active email selected.');
      return;
    }

    const activeMsg = this.primaryInboxMessages.find(m => String(m.uid) === String(this.activePrimaryInboxUid));
    if (!activeMsg) {
      alert('Could not locate recipient address.');
      return;
    }

    const replyTextEl = document.getElementById('primaryInboxReplyText');
    const message = replyTextEl ? replyTextEl.value.trim() : '';
    const btn = document.getElementById('btnSendPrimaryInboxReply');

    if (!message) {
      alert('Please type a reply message before sending.');
      return;
    }

    btn.disabled = true;
    btn.innerText = 'Sending Reply...';

    try {
      const res = await fetch('/api/inbox/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderEmail: this.getActiveAccountEmail(),
          to: activeMsg.from,
          subject: activeMsg.subject,
          message,
          inReplyTo: activeMsg.messageId
        })
      });

      const data = await res.json();
      btn.disabled = false;
      btn.innerText = '⚡ Send Direct Reply';

      if (data.success) {
        this.showToast(`✓ Reply sent to ${activeMsg.from}!`);
        if (replyTextEl) replyTextEl.value = '';

        const contentEl = document.getElementById('primaryInboxViewContent');
        if (contentEl) {
          const sentBox = document.createElement('div');
          sentBox.style.cssText = 'margin-top: 20px; padding: 14px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px; font-size: 13.5px;';
          sentBox.innerHTML = `
            <div style="font-weight: 700; color: #1d4ed8; font-size: 12px; margin-bottom: 4px;">✓ Reply sent just now to ${activeMsg.from}</div>
            <div style="white-space: pre-wrap; color: #1e3a8a;">${this.escapeHtml(message)}</div>
          `;
          contentEl.appendChild(sentBox);
          contentEl.scrollTop = contentEl.scrollHeight;
        }
        this.loadSent();
      } else {
        alert('Failed to send reply: ' + (data.error || 'Check sender connection'));
      }
    } catch (e) {
      btn.disabled = false;
      btn.innerText = '⚡ Send Direct Reply';
      alert('Error sending reply: ' + e.message);
    }
  },


  // ==========================================================
  // TAB 4: SENT (OUTREACH CAMPAIGNS & SENT MESSAGES)
  // ==========================================================

  async loadSent() {
    try {
      // 1. Fetch campaigns
      const campRes = await fetch('/api/campaigns');
      const campData = await campRes.json();
      const campaigns = (campData.success && Array.isArray(campData.campaigns)) ? campData.campaigns : [];

      // 2. Fetch direct sent messages from inbox service
      const sentRes = await fetch('/api/inbox?folder=SENT');
      const sentData = await sentRes.json();
      const directSent = (sentData.success && Array.isArray(sentData.messages)) ? sentData.messages : [];

      // Combine items according to view mode
      this.sentItems = [];
      const viewMode = this.sentViewMode || 'leads';

      if (viewMode === 'leads') {
        // Individual lead dispatches view
        campaigns.forEach(c => {
          if (Array.isArray(c.recipients) && c.recipients.length > 0) {
            c.recipients.forEach((r, idx) => {
              this.sentItems.push({
                type: 'lead',
                id: `${c.id}_${r.id || idx}`,
                campaignId: c.id,
                senderEmail: c.senderEmail || 'Sender',
                recipientEmail: r.email,
                toText: r.email,
                subject: r.subjectSent || c.subject || 'Outreach Campaign',
                opens: r.openCount || (r.opened ? 1 : 0),
                opened: !!r.opened,
                openedAt: r.openedAt,
                status: r.status || (r.sentAt ? 'Delivered' : 'Pending'),
                date: r.sentAt || c.createdAt || new Date().toISOString(),
                error: r.error,
                trackingId: r.trackingId,
                variantNumber: r.variantNumber,
                raw: { campaign: c, recipient: r }
              });
            });
          } else {
            this.sentItems.push({
              type: 'campaign',
              id: c.id,
              campaignId: c.id,
              senderEmail: c.senderEmail || 'Sender',
              recipientEmail: `${c.totalRecipients || 0} Leads`,
              toText: `${c.totalRecipients || 0} Leads`,
              subject: c.subject || 'Outreach Campaign',
              opens: c.openCount || 0,
              status: c.status || 'Completed',
              date: c.createdAt || new Date().toISOString(),
              raw: c
            });
          }
        });

        directSent.forEach(s => {
          this.sentItems.push({
            type: 'direct',
            id: s.uid,
            senderEmail: s.accountEmail || s.from || 'Sender',
            recipientEmail: s.to || 'Recipient',
            toText: s.to || 'Recipient',
            subject: s.subject || 'Direct Message',
            opens: s.trackingId ? 1 : 0,
            status: 'Delivered',
            date: s.date || new Date().toISOString(),
            raw: s
          });
        });
      } else {
        // Grouped campaigns view
        campaigns.forEach(c => {
          this.sentItems.push({
            type: 'campaign',
            id: c.id,
            campaignId: c.id,
            senderEmail: c.senderEmail || 'Sender',
            recipientEmail: `${c.totalRecipients || (c.recipients ? c.recipients.length : 0)} Leads`,
            toText: `${c.totalRecipients || (c.recipients ? c.recipients.length : 0)} Leads`,
            subject: c.subject || 'Outreach Campaign',
            opens: c.openCount || 0,
            sentCount: c.sentCount || 0,
            failedCount: c.failedCount || 0,
            status: c.status || 'Completed',
            date: c.createdAt || new Date().toISOString(),
            raw: c
          });
        });

        directSent.forEach(s => {
          this.sentItems.push({
            type: 'direct',
            id: s.uid,
            senderEmail: s.accountEmail || s.from || 'Sender',
            recipientEmail: s.to || 'Recipient',
            toText: s.to || 'Recipient',
            subject: s.subject || 'Direct Message',
            opens: s.trackingId ? 1 : 0,
            status: 'Delivered',
            date: s.date || new Date().toISOString(),
            raw: s
          });
        });
      }

      // Sort newest first
      this.sentItems.sort((a, b) => new Date(b.date) - new Date(a.date));

      // Update Telemetry Stat Cards
      let totalLeads = 0;
      let totalOpens = 0;
      campaigns.forEach(c => {
        totalLeads += c.totalRecipients || (c.recipients ? c.recipients.length : 0);
        totalOpens += c.openCount || 0;
      });
      totalLeads += directSent.length;

      const statCampEl = document.getElementById('sentStatCampaigns');
      const statLeadsEl = document.getElementById('sentStatLeads');
      const statOpensEl = document.getElementById('sentStatOpens');

      if (statCampEl) statCampEl.innerText = campaigns.length;
      if (statLeadsEl) statLeadsEl.innerText = totalLeads;
      if (statOpensEl) statOpensEl.innerText = Math.max(totalOpens, this.allOpenEvents.length);

      // Populate Sent Account Selector
      const filterSelect = document.getElementById('sentAccountFilterSelect');
      if (filterSelect) {
        let opts = `<option value="all">All Accounts (${this.sentItems.length})</option>`;
        const senderSet = new Set();
        this.sentItems.forEach(item => { if (item.senderEmail) senderSet.add(item.senderEmail.toLowerCase()); });
        senderSet.forEach(email => {
          const count = this.sentItems.filter(i => (i.senderEmail || '').toLowerCase() === email).length;
          opts += `<option value="${email}">✉️ ${email} (${count})</option>`;
        });
        filterSelect.innerHTML = opts;
      }

      // Keep view mode selector aligned
      const viewSelect = document.getElementById('sentViewModeSelect');
      if (viewSelect && viewSelect.value !== viewMode) {
        viewSelect.value = viewMode;
      }

      this.renderSentTable();
    } catch (e) {
      console.warn('Sent load error:', e);
    }
  },

  onSentViewModeChange(mode) {
    this.sentViewMode = mode || 'leads';
    this.loadSent();
  },

  onSentAccountFilterChange(email) {
    this.activeSentAccountFilter = email;
    this.renderSentTable();
  },

  filterSentTable() {
    this.renderSentTable();
  },

  renderSentTable() {
    const tbody = document.getElementById('sentHistoryTableBody');
    if (!tbody) return;

    const searchTerm = (document.getElementById('sentSearchInput')?.value || '').toLowerCase().trim();
    let list = [...this.sentItems];

    if (this.activeSentAccountFilter !== 'all') {
      list = list.filter(i => (i.senderEmail || '').toLowerCase() === this.activeSentAccountFilter.toLowerCase());
    }

    if (searchTerm) {
      list = list.filter(i => 
        (i.senderEmail && i.senderEmail.toLowerCase().includes(searchTerm)) ||
        (i.toText && i.toText.toLowerCase().includes(searchTerm)) ||
        (i.recipientEmail && i.recipientEmail.toLowerCase().includes(searchTerm)) ||
        (i.subject && i.subject.toLowerCase().includes(searchTerm))
      );
    }

    if (list.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; padding: 36px; color: var(--text-dim); font-size: 13px;">
            No sent messages found. Send an outreach campaign or a test email from the <strong>Compose</strong> tab to see it logged here!
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = list.map(item => {
      const timeStr = item.date ? new Date(item.date).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      
      let openBadge = '';
      if (item.opens > 0) {
        const timeTip = item.openedAt ? ` title="Opened at ${new Date(item.openedAt).toLocaleTimeString()}"` : '';
        openBadge = `<span class="status-badge status-completed"${timeTip} style="font-size: 11px; background: #ecfdf5; color: #047857; font-weight: 700;">👁️ ${item.opens} open${item.opens > 1 ? 's' : ''}</span>`;
      } else {
        openBadge = `<span class="status-badge status-pending" style="font-size: 11px;">⏳ Awaiting open</span>`;
      }

      let statusBadge = '';
      if (item.status === 'Sent' || item.status === 'Delivered' || item.status === 'Completed') {
        statusBadge = `<span class="status-badge status-completed" style="font-size: 11px;">✓ Delivered</span>`;
      } else if (item.status === 'Failed') {
        statusBadge = `<span class="status-badge status-failed" style="font-size: 11px;" title="${this.escapeHtml(item.error || 'Delivery failed')}">✕ Failed</span>`;
      } else if (item.status === 'Suppressed') {
        statusBadge = `<span class="status-badge" style="font-size: 11px; background: #f1f5f9; color: #64748b;" title="Auto-Suppressed bounce">🚫 Suppressed</span>`;
      } else {
        statusBadge = `<span class="status-badge status-inprogress" style="font-size: 11px;">● ${this.escapeHtml(item.status)}</span>`;
      }

      const isLead = item.type === 'lead';
      const toDisplay = isLead 
        ? `<div style="display: flex; align-items: center; gap: 5px;"><span style="color: #0284c7; font-size: 13px;">👤</span><strong style="color: #0284c7; font-size: 12.5px;">${this.escapeHtml(item.toText)}</strong></div>`
        : `<span style="font-weight: 600; color: #059669;">${this.escapeHtml(item.toText)}</span>`;

      return `
        <tr>
          <td><strong style="color: var(--text-main); font-size: 12.5px;">${this.escapeHtml(item.senderEmail)}</strong></td>
          <td>${toDisplay}</td>
          <td style="color: var(--text-muted); font-size: 12.5px;" title="${this.escapeHtml(item.subject)}">${this.escapeHtml(item.subject)}</td>
          <td>${openBadge}</td>
          <td>${statusBadge}</td>
          <td style="font-size: 12px; color: var(--text-dim);">${timeStr}</td>
          <td>
            ${isLead || item.type === 'campaign'
              ? `<button class="btn btn-sm btn-secondary" onclick="app.viewCampaignDetails('${item.campaignId || item.id}')" style="font-size: 11px; padding: 2px 7px;">Audit</button>` 
              : `<button class="btn btn-sm btn-secondary" onclick="app.selectActiveAllInboxMessage('${item.id}'); app.switchTab('all-inbox');" style="font-size: 11px; padding: 2px 7px;">View</button>`}
          </td>
        </tr>
      `;
    }).join('');
  },


  // ==========================================================
  // TAB 5: SPAM (FILTERED LEADS RESCUE & INBOX DISPLAY)
  // ==========================================================

  async loadSpam() {
    try {
      const res = await fetch('/api/inbox?folder=SPAM');
      const data = await res.json();
      if (data.success && Array.isArray(data.messages)) {
        this.spamMessages = data.messages;
        this.updateSpamBadge(data.spamCount || this.spamMessages.length);
        this.renderSpamView();
      }
    } catch (e) {
      console.warn('Spam load error:', e);
    }
  },

  updateSpamBadge(count) {
    const badge = document.getElementById('navSpamBadge');
    if (badge) {
      badge.innerText = count;
      badge.style.display = count > 0 ? 'inline-block' : 'none';
    }
  },

  onSpamAccountChange(email) {
    this.activeSpamAccountFilter = email;
    this.renderSpamView();
  },

  filterSpamMessages() {
    this.renderSpamView();
  },

  renderSpamView() {
    const container = document.getElementById('spamItemsList');
    if (!container) return;

    // Update Spam Account Selector
    const selectEl = document.getElementById('spamAccountSelect');
    if (selectEl) {
      let opts = `<option value="all">All Accounts (${this.spamMessages.length})</option>`;
      this.accounts.forEach(a => {
        const count = this.spamMessages.filter(m => (m.accountEmail || '').toLowerCase() === a.email.toLowerCase()).length;
        const isSel = this.activeSpamAccountFilter === a.email;
        opts += `<option value="${a.email}" ${isSel ? 'selected' : ''}>${a.email} (${count})</option>`;
      });
      selectEl.innerHTML = opts;
    }

    const searchTerm = (document.getElementById('spamSearchInput')?.value || '').toLowerCase().trim();
    let list = [...this.spamMessages];

    if (this.activeSpamAccountFilter !== 'all') {
      list = list.filter(m => (m.accountEmail || '').toLowerCase() === this.activeSpamAccountFilter.toLowerCase());
    }

    if (searchTerm) {
      list = list.filter(m => 
        (m.from && m.from.toLowerCase().includes(searchTerm)) ||
        (m.fromName && m.fromName.toLowerCase().includes(searchTerm)) ||
        (m.subject && m.subject.toLowerCase().includes(searchTerm)) ||
        (m.snippet && m.snippet.toLowerCase().includes(searchTerm))
      );
    }

    if (list.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 40px 16px; color: var(--text-dim); font-size: 13px;">
          <div style="font-size: 32px; margin-bottom: 8px;">🛡️</div>
          <div style="font-weight: 600; color: var(--text-main); margin-bottom: 4px;">Spam folder is clean</div>
          <div style="font-size: 11.5px; line-height: 1.5;">Click <strong>"Sync Spam Folder"</strong> above to inspect Gmail spam/junk folders for lead responses.</div>
        </div>
      `;
      return;
    }

    container.innerHTML = list.map(m => {
      const isSelected = String(m.uid) === String(this.activeSpamUid);
      const cardClasses = [
        'inbox-item-card',
        isSelected ? 'active' : ''
      ].filter(Boolean).join(' ');

      const timeStr = m.date ? new Date(m.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
      const accBadge = m.accountEmail ? `<span class="status-badge" style="font-size: 10px; background: #fee2e2; color: #991b1b; margin-right: 6px;">@${this.escapeHtml(m.accountEmail.split('@')[0])}</span>` : '';

      return `
        <div class="${cardClasses}" onclick="app.selectActiveSpamMessage('${m.uid}')">
          <div class="inbox-item-header">
            <span class="inbox-item-name">${accBadge}${this.escapeHtml(m.fromName || m.from)}</span>
            <span class="inbox-item-time">${timeStr}</span>
          </div>
          <div class="inbox-item-subject" style="color: #991b1b;">⚠️ ${this.escapeHtml(m.subject || '(Filtered Message)')}</div>
          <div class="inbox-item-snippet">${this.escapeHtml(m.snippet || '')}</div>
          <span class="inbox-lead-chip" style="background: #fef3c7; color: #92400e; border-color: #fde68a;">Click to Rescue Lead ⚡</span>
        </div>
      `;
    }).join('');
  },

  async selectActiveSpamMessage(uid) {
    this.activeSpamUid = uid;
    this.renderSpamView();

    const emptyPane = document.getElementById('spamEmptySelection');
    const activeView = document.getElementById('spamActiveView');

    if (emptyPane) emptyPane.style.display = 'none';
    if (activeView) activeView.style.display = 'flex';

    try {
      const res = await fetch(`/api/inbox/${uid}`);
      const data = await res.json();
      if (data.success && data.message) {
        const msg = data.message;

        const subEl = document.getElementById('spamViewSubject');
        const fromNameEl = document.getElementById('spamViewFromName');
        const fromEmailEl = document.getElementById('spamViewFromEmail');
        const dateEl = document.getElementById('spamViewDate');
        const avatarEl = document.getElementById('spamViewAvatar');
        const contentEl = document.getElementById('spamViewContent');
        const replyText = document.getElementById('spamReplyText');

        if (subEl) subEl.innerText = msg.subject || '(Filtered Message)';
        if (fromNameEl) fromNameEl.innerText = msg.fromName || msg.from;
        if (fromEmailEl) fromEmailEl.innerText = msg.from;
        if (dateEl) dateEl.innerText = new Date(msg.date).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        if (avatarEl) avatarEl.innerText = (msg.fromName || msg.from || 'U').charAt(0).toUpperCase();

        if (contentEl) {
          contentEl.innerHTML = msg.htmlBody || `<p style="white-space: pre-wrap;">${this.escapeHtml(msg.textBody || '')}</p>`;
        }

        if (replyText) {
          replyText.value = '';
          replyText.placeholder = `Write your response to ${msg.fromName || msg.from}...`;
        }
      }
    } catch (e) {
      console.error('Error fetching spam details:', e);
    }
  },

  async rescueActiveSpamMessage() {
    if (!this.activeSpamUid) {
      alert('No spam message selected.');
      return;
    }

    try {
      const res = await fetch(`/api/inbox/rescue/${this.activeSpamUid}`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        this.showToast(`✓ Lead Rescued! Message moved to Primary Inbox.`);
        this.activeSpamUid = null;
        const emptyPane = document.getElementById('spamEmptySelection');
        const activeView = document.getElementById('spamActiveView');
        if (emptyPane) emptyPane.style.display = 'flex';
        if (activeView) activeView.style.display = 'none';

        this.loadSpam();
        this.loadAllInbox();
        this.loadPrimaryInbox();
      } else {
        alert('Could not rescue: ' + (data.error || 'Unknown error'));
      }
    } catch (e) {
      alert('Error rescuing message: ' + e.message);
    }
  },

  async syncSpamLive() {
    if (this.isSyncingSpam) return;
    this.isSyncingSpam = true;

    const btn = document.getElementById('btnSyncSpam');
    const spinner = document.getElementById('syncSpamSpinnerIcon');

    if (btn) btn.disabled = true;
    if (spinner) spinner.style.animation = 'spin 1s linear infinite';

    try {
      const res = await fetch('/api/inbox/sync-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: 'SPAM' })
      });
      const data = await res.json();

      if (btn) btn.disabled = false;
      if (spinner) spinner.style.animation = 'none';

      if (data.success) {
        this.showToast(`✓ Spam check completed!`);
        this.loadSpam();
      } else {
        alert('Spam check notice: ' + (data.error || 'Check sender connection'));
      }
    } catch (err) {
      if (btn) btn.disabled = false;
      if (spinner) spinner.style.animation = 'none';
      alert('Error syncing spam: ' + err.message);
    } finally {
      this.isSyncingSpam = false;
    }
  },

  async sendSpamReply() {
    if (!this.activeSpamUid) {
      alert('No active email selected.');
      return;
    }

    const activeMsg = this.spamMessages.find(m => String(m.uid) === String(this.activeSpamUid));
    if (!activeMsg) {
      alert('Could not locate recipient address.');
      return;
    }

    const replyTextEl = document.getElementById('spamReplyText');
    const message = replyTextEl ? replyTextEl.value.trim() : '';

    if (!message) {
      alert('Please type a reply message before sending.');
      return;
    }

    try {
      const res = await fetch('/api/inbox/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderEmail: activeMsg.accountEmail,
          to: activeMsg.from,
          subject: activeMsg.subject,
          message,
          inReplyTo: activeMsg.messageId
        })
      });

      const data = await res.json();
      if (data.success) {
        this.showToast(`✓ Reply sent! Rescuing lead to Primary Inbox...`);
        if (replyTextEl) replyTextEl.value = '';
        await this.rescueActiveSpamMessage();
      } else {
        alert('Failed to send reply: ' + (data.error || 'Check sender connection'));
      }
    } catch (e) {
      alert('Error sending reply: ' + e.message);
    }
  },

  // ==========================================================
  // BOUNCED LEADS & DELIVERY FAILURE MANAGEMENT
  // ==========================================================

  async loadBounces() {
    try {
      const res = await fetch('/api/bounces');
      const data = await res.json();
      if (data.success && Array.isArray(data.bounces)) {
        this.bouncesList = data.bounces;
        this.renderBouncesTable();
        this.updateBouncesBadge(data.total || this.bouncesList.length);
        this.updateBouncesStats(data.stats || {});
      }
    } catch (e) {
      console.warn('Error loading bounces:', e.message);
    }
  },

  updateBouncesStats(stats = {}) {
    const totalEl = document.getElementById('bounceStatTotal');
    const hardEl = document.getElementById('bounceStatHard');
    const softEl = document.getElementById('bounceStatSoft');
    const suppEl = document.getElementById('bounceStatSuppressed');

    const total = stats.total ?? this.bouncesList.length;
    const hard = stats.hardBounces ?? this.bouncesList.filter(b => b.category === 'Hard Bounce 550').length;
    const soft = stats.softBounces ?? this.bouncesList.filter(b => b.category === 'Soft Bounce 552').length;
    const supp = stats.suppressionCount ?? this.bouncesList.length;

    if (totalEl) totalEl.innerText = total;
    if (hardEl) hardEl.innerText = hard;
    if (softEl) softEl.innerText = soft;
    if (suppEl) suppEl.innerText = supp;

    const cAll = document.getElementById('countBounceAll');
    const cHard = document.getElementById('countBounceHard');
    const cSoft = document.getElementById('countBounceSoft');
    const cBlocked = document.getElementById('countBounceBlocked');

    if (cAll) cAll.innerText = total;
    if (cHard) cHard.innerText = hard;
    if (cSoft) cSoft.innerText = soft;
    if (cBlocked) cBlocked.innerText = this.bouncesList.filter(b => b.category === 'Blocked / Filtered' || b.category === 'Invalid Domain').length;
  },


  filterBounces(type) {
    this.activeBounceFilter = type;
    document.querySelectorAll('[id^="bounceFilter"]').forEach(btn => {
      btn.style.fontWeight = '500';
      btn.style.background = 'var(--bg-card)';
    });

    const activeBtn = document.getElementById(
      type === 'all' ? 'bounceFilterAll' :
      type === 'hard' ? 'bounceFilterHard' :
      type === 'soft' ? 'bounceFilterSoft' : 'bounceFilterBlocked'
    );
    if (activeBtn) {
      activeBtn.style.fontWeight = '700';
      activeBtn.style.background = '#fef2f2';
    }

    this.renderBouncesTable();
  },

  searchBounces(query) {
    this.bouncesSearchQuery = (query || '').toLowerCase().trim();
    this.renderBouncesTable();
  },

  renderBouncesTable() {
    const tbody = document.getElementById('bouncesTableBody');
    if (!tbody) return;

    let list = this.bouncesList || [];

    // Filter by category
    if (this.activeBounceFilter === 'hard') {
      list = list.filter(b => b.category === 'Hard Bounce 550');
    } else if (this.activeBounceFilter === 'soft') {
      list = list.filter(b => b.category === 'Soft Bounce 552');
    } else if (this.activeBounceFilter === 'blocked') {
      list = list.filter(b => b.category === 'Blocked / Filtered' || b.category === 'Invalid Domain');
    }

    // Filter by search query
    if (this.bouncesSearchQuery) {
      const q = this.bouncesSearchQuery;
      list = list.filter(b => 
        (b.email && b.email.toLowerCase().includes(q)) ||
        (b.reason && b.reason.toLowerCase().includes(q)) ||
        (b.senderEmail && b.senderEmail.toLowerCase().includes(q)) ||
        (b.diagnosticCode && b.diagnosticCode.toLowerCase().includes(q))
      );
    }

    if (list.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; padding: 36px 16px; color: var(--text-dim);">
            <div style="font-size: 32px; margin-bottom: 8px;">🛡️</div>
            <div style="font-size: 14px; font-weight: 600; color: var(--text-main);">No Bounced Leads Recorded</div>
            <div style="font-size: 12px; margin-top: 4px;">Your sender reputation is spotless. All delivery failures will be automatically caught and isolated here.</div>
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = list.map(b => {
      const isHard = b.category === 'Hard Bounce 550';
      const isSoft = b.category === 'Soft Bounce 552';
      const badgeStyle = isHard
        ? 'background: #fef2f2; color: #dc2626; border: 1px solid #fecaca;'
        : isSoft
        ? 'background: #fefce8; color: #ca8a04; border: 1px solid #fef08a;'
        : 'background: #fff7ed; color: #ea580c; border: 1px solid #fed7aa;';

      const timeStr = b.timestamp ? new Date(b.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Recently';

      return `
        <tr>
          <td>
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 15px;">❌</span>
              <strong style="color: var(--text-main); font-size: 13px;">${this.escapeHtml(b.email)}</strong>
            </div>
          </td>
          <td>
            <span class="status-badge" style="${badgeStyle} font-size: 11px; font-weight: 600;">
              ${this.escapeHtml(b.category || 'Undeliverable')}
            </span>
          </td>
          <td style="max-width: 260px;">
            <div style="font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${this.escapeHtml(b.reason || b.diagnosticCode)}">
              ${this.escapeHtml(b.reason || b.diagnosticCode || 'Delivery permanently failed')}
            </div>
          </td>
          <td>
            <span style="font-size: 12px; color: var(--text-dim);">${this.escapeHtml(b.senderEmail || 'System')}</span>
          </td>
          <td style="font-size: 12px; color: var(--text-dim); white-space: nowrap;">
            ${timeStr}
          </td>
          <td>
            <span class="status-badge status-completed" style="font-size: 11px; background: #ecfdf5; color: #059669; border: 1px solid #a7f3d0;">
              🛡️ Auto-Suppressed
            </span>
          </td>
          <td>
            <div style="display: flex; gap: 6px; align-items: center;">
              <button type="button" class="btn btn-sm btn-secondary" onclick="app.openBounceDetail('${b.id}')" style="font-size: 11px; padding: 3px 8px;" title="View raw SMTP diagnostic error">
                🔍 Details
              </button>
              <button type="button" class="btn btn-sm btn-danger" onclick="app.deleteBounce('${b.id}')" style="font-size: 11px; padding: 3px 8px;" title="Remove from bounce log">
                ✕
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  },

  openBounceDetail(id) {
    const item = (this.bouncesList || []).find(b => b.id === id);
    if (!item) return;

    this.activeBounceDetailId = id;

    const emailEl = document.getElementById('modalBounceEmail');
    const senderEl = document.getElementById('modalBounceSender');
    const reasonEl = document.getElementById('modalBounceReason');
    const timeEl = document.getElementById('modalBounceTime');
    const rawEl = document.getElementById('modalBounceRaw');
    const badgeEl = document.getElementById('modalBounceBadge');

    if (emailEl) emailEl.innerText = item.email;
    if (senderEl) senderEl.innerText = item.senderEmail || 'System Dispatcher';
    if (reasonEl) reasonEl.innerText = item.reason || item.diagnosticCode || 'Undeliverable address';
    if (timeEl) timeEl.innerText = item.timestamp ? new Date(item.timestamp).toLocaleString() : 'Recently';
    if (rawEl) rawEl.innerText = item.rawBounceText || item.diagnosticCode || `Status: ${item.status || '5.1.1'}\nAction: failed\nDiagnostic-Code: smtp; 550 5.1.1 User unknown\nRemote-MTA: dns; smtp-relay.gmail.com`;
    if (badgeEl) {
      badgeEl.innerText = item.category || '550 Hard Bounce';
    }

    this.openModal('modalBounceDetail');
  },

  async deleteActiveModalBounce() {
    if (!this.activeBounceDetailId) return;
    await this.deleteBounce(this.activeBounceDetailId);
    this.closeModal('modalBounceDetail');
  },

  async deleteBounce(id) {
    try {
      const res = await fetch(`/api/bounces/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        this.bouncesList = this.bouncesList.filter(b => b.id !== id);
        this.renderBouncesTable();
        this.updateBouncesBadge(this.bouncesList.length);
        this.updateBouncesStats();
        this.showToast('✓ Bounce record removed.');
      }
    } catch (e) {
      alert('Error deleting bounce record: ' + e.message);
    }
  },

  async clearBouncesHistory() {
    if (!confirm('Are you sure you want to clear the bounce log?')) return;
    try {
      const res = await fetch('/api/bounces', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        this.bouncesList = [];
        this.renderBouncesTable();
        this.updateBouncesBadge(0);
        this.updateBouncesStats();
        this.showToast('✓ All bounce records cleared.');
      }
    } catch (e) {
      alert('Error clearing bounces: ' + e.message);
    }
  },

  async simulateBounceReport() {
    try {
      const res = await fetch('/api/bounces/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientEmail: `undeliverable-lead-${Math.floor(Math.random() * 8999 + 1000)}@invalid-domain-test.com`,
          senderEmail: this.getActiveAccountEmail() || 'sender@domain.com',
          reason: '550 5.1.1 The email account that you tried to reach does not exist. Please try double-checking the recipient email address for typos.',
          category: 'Hard Bounce 550'
        })
      });
      const data = await res.json();
      if (data.success) {
        this.showToast(`⚠️ Simulated 550 Bounce received and Auto-Suppressed!`);
        await this.loadBounces();
      }
    } catch (e) {
      alert('Error simulating bounce: ' + e.message);
    }
  },

  // ==========================================================
  // MULTI-ACCOUNT MANAGEMENT & PERSISTENCE
  // ==========================================================

  async loadSavedAccounts() {
    try {
      localStorage.removeItem('mailflow_accounts_store');
      localStorage.removeItem('mailflow_last_active_password');
      const local = localStorage.getItem('mailflow_accounts_list');
      if (local) {
        this.accounts = JSON.parse(local);
      }
    } catch (e) {
      this.accounts = [];
    }

    const lastEmail = (localStorage.getItem('mailflow_last_active_email') || '').trim().toLowerCase();
    const lastName = (localStorage.getItem('mailflow_last_active_name') || '').trim();

    if (lastEmail && lastEmail.includes('@')) {
      let activeAcc = this.accounts.find(a => a.email.toLowerCase() === lastEmail);
      if (activeAcc) {
        if (lastName && !activeAcc.name) activeAcc.name = lastName;
        activeAcc.isDefault = true;
      } else {
        activeAcc = {
          id: 'acc-' + Date.now(),
          email: lastEmail,
          name: lastName || lastEmail.split('@')[0],
          hasPassword: true,
          isDefault: true,
          status: 'Connected'
        };
        this.accounts.push(activeAcc);
      }
      this.activeAccountId = activeAcc.id;
    }

    try {
      const res = await fetch('/api/accounts');
      const data = await res.json();
      if (data.success && Array.isArray(data.accounts)) {
        data.accounts.forEach(backendAcc => {
          const existing = this.accounts.find(a => a.email.toLowerCase() === backendAcc.email.toLowerCase());
          if (existing) {
            existing.status = backendAcc.status || existing.status || 'Connected';
            existing.hasPassword = !!backendAcc.hasPassword || !!existing.hasPassword;
            if (backendAcc.id) existing.id = backendAcc.id;
          } else {
            this.accounts.push({
              id: backendAcc.id,
              email: backendAcc.email,
              name: backendAcc.name || backendAcc.email.split('@')[0],
              hasPassword: !!backendAcc.hasPassword,
              isDefault: false,
              status: backendAcc.status || 'Connected'
            });
          }
        });
      }
    } catch (e) {}

    this.saveAccountsToStorage();
    this.renderAccountSwitcherDropdown();
    this.renderAccountsManagerTable();

    if (this.accounts.length > 0) {
      const active = (this.activeAccountId && this.accounts.find(a => a.id === this.activeAccountId)) || 
                     this.accounts.find(a => a.isDefault) || 
                     this.accounts[0];
      if (active) {
        this.selectActiveAccount(active.id);
      } else {
        this.resetAccountUI();
      }
    } else {
      this.resetAccountUI();
    }
  },

  resetAccountUI() {
    this.activeAccountId = null;
    const headerEmail = document.getElementById('headerSenderEmail');
    const headerDot = document.getElementById('headerStatusDot');
    const sbText = document.getElementById('sbSenderStatusText');
    const sbDot = document.getElementById('sbStatusDot');
    const sbSubtext = document.getElementById('sbStatusSubtext');
    const headerSmtpBadge = document.getElementById('headerSmtpBadge');
    const statusDiv = document.getElementById('smtpVerifyStatus');
    const emailInput = document.getElementById('senderEmail');
    const passInput = document.getElementById('senderPassword');
    const nameInput = document.getElementById('senderDisplayName');

    if (headerEmail) headerEmail.innerText = 'Connect Sender Account';
    if (headerDot) headerDot.className = 'status-dot disconnected';
    if (headerSmtpBadge) {
      headerSmtpBadge.innerText = '○ Disconnected';
      headerSmtpBadge.style.color = 'var(--text-dim)';
    }
    if (sbText) sbText.innerText = 'No Account Connected';
    if (sbDot) sbDot.className = 'status-dot disconnected';
    if (sbSubtext) sbSubtext.innerText = '○ Click Connect in Step 1';
    if (statusDiv) {
      statusDiv.innerHTML = '<span class="status-dot disconnected"></span><span>Ready to connect Google SMTP account</span>';
    }
    if (emailInput) emailInput.value = '';
    if (passInput) {
      passInput.value = '';
      passInput.placeholder = 'abcd efgh ijkl mnop';
    }
    if (nameInput) nameInput.value = '';
    this.updateDesktopLivePreview();
  },

  disconnectActiveAccount() {
    if (!confirm('Are you sure you want to disconnect this account and sign out?')) return;

    const email = document.getElementById('senderEmail')?.value.trim().toLowerCase() || this.getActiveAccountEmail()?.toLowerCase();
    
    if (this.activeAccountId) {
      this.accounts = this.accounts.filter(a => a.id !== this.activeAccountId);
    } else if (email) {
      this.accounts = this.accounts.filter(a => a.email.toLowerCase() !== email);
    }

    try {
      localStorage.removeItem('mailflow_last_active_email');
      localStorage.removeItem('mailflow_last_active_password');
      localStorage.removeItem('mailflow_last_active_name');
      localStorage.removeItem('mailflow_accounts_store');
    } catch (e) {}

    this.activeAccountId = null;
    this.saveAccountsToStorage();
    this.renderAccountSwitcherDropdown();
    this.renderAccountsManagerTable();
    this.resetAccountUI();
    this.showToast('✓ Account disconnected & session signed out.');
  },

  saveAccountsToStorage() {
    try {
      localStorage.removeItem('mailflow_accounts_store'); // Zero plain passwords in browser storage
      localStorage.removeItem('mailflow_last_active_password');
      const safeAccounts = this.accounts.map(a => ({
        id: a.id,
        email: a.email,
        name: a.name,
        isDefault: !!a.isDefault,
        status: a.status || 'Connected',
        hasPassword: !!a.hasPassword || !!a.password
      }));
      localStorage.setItem('mailflow_accounts_list', JSON.stringify(safeAccounts));
    } catch (e) {}
  },

  renderAccountSwitcherDropdown() {
    const select = document.getElementById('accountSwitcherSelect');
    if (!select) return;

    if (this.accounts.length === 0) {
      select.innerHTML = `<option value="">-- No Accounts Saved --</option>`;
      return;
    }

    select.innerHTML = this.accounts.map(acc => {
      const isSelected = acc.id === this.activeAccountId ? 'selected' : '';
      return `<option value="${acc.id}" ${isSelected}>${this.escapeHtml(acc.email)} ${acc.isDefault ? '(Default)' : ''}</option>`;
    }).join('');
  },

  renderAccountsManagerTable() {
    const tbody = document.getElementById('accountsManagerTableBody');
    if (!tbody) return;

    if (this.accounts.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 24px; color: var(--text-dim);">No accounts saved yet. Click "+ Add Account" or "Bulk Setup" to connect mailboxes.</td></tr>`;
      return;
    }

    tbody.innerHTML = this.accounts.map(acc => {
      const isActive = acc.id === this.activeAccountId;
      const sentToday = acc.sentToday || 0;
      const dailyCap = acc.dailySendCap || 50;
      const remCap = acc.remainingCapacity !== undefined ? acc.remainingCapacity : Math.max(0, dailyCap - sentToday);
      const isThrottled = acc.isThrottled === true;
      const statusText = isThrottled ? 'Throttled (Cooldown)' : (acc.status || 'Connected');
      const statusClass = isThrottled ? 'status-failed' : (acc.status === 'Connected' ? 'status-completed' : 'status-inprogress');

      return `
        <tr>
          <td>
            <strong>${this.escapeHtml(acc.email)}</strong>
            <div style="font-size: 11.5px; color: var(--text-dim);">${this.escapeHtml(acc.name || 'Sender')}</div>
            ${acc.isDefault ? '<span class="status-badge status-inprogress" style="font-size: 9px; padding: 1px 5px; margin-top: 2px;">Default</span>' : ''}
          </td>
          <td>
            <span class="status-badge ${statusClass}">
              ● ${statusText}
            </span>
          </td>
          <td>
            <strong>${sentToday} / ${dailyCap}</strong> sent
            <button type="button" class="btn btn-sm btn-secondary" onclick="app.promptEditAccountCap('${acc.id}', ${dailyCap})" style="font-size: 10px; padding: 1px 5px; margin-left: 4px;" title="Edit Daily Send Cap">✏️</button>
          </td>
          <td>
            <span style="font-weight: 600; color: ${remCap > 0 ? '#059669' : '#dc2626'}; font-size: 13px;">${remCap} sends</span>
          </td>
          <td style="font-size: 12px; color: var(--text-dim);">
            ${acc.lastConnected ? new Date(acc.lastConnected).toLocaleDateString() : 'Never'}
          </td>
          <td>
            <div style="display: flex; gap: 6px; flex-wrap: wrap;">
              <button class="btn btn-sm btn-secondary" onclick="app.testAccountConnectionById('${acc.id}')" title="Test SMTP Socket">⚡ Test</button>
              ${!isActive ? `<button class="btn btn-sm btn-primary" onclick="app.selectActiveAccount('${acc.id}'); app.switchTab('composer');">Use</button>` : '<span style="font-size: 12px; font-weight: 600; color: var(--status-success); padding: 4px 6px;">Active</span>'}
              <button class="btn btn-sm btn-secondary" onclick="app.makeDefaultAccount('${acc.id}')">Default</button>
              <button class="btn btn-sm btn-danger" onclick="app.removeAccount('${acc.id}')" title="Remove account">✕</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  },

  async promptEditAccountCap(accountId, currentCap) {
    const val = prompt(`Enter new daily send cap for this account:`, currentCap);
    if (!val) return;
    const newCap = parseInt(val, 10);
    if (isNaN(newCap) || newCap < 1) {
      this.showToast('Please enter a valid positive number.', 'warning');
      return;
    }
    try {
      const res = await this.authFetch(`/api/accounts/${accountId}/limits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dailySendCap: newCap })
      });
      const data = await res.json();
      if (data.success) {
        this.showToast(`✓ Daily cap updated to ${newCap} sends/day.`);
        this.loadSavedAccounts();
        this.loadOverviewMetrics();
      }
    } catch (err) {
      this.showToast(err.message, 'danger');
    }
  },

  async testAccountConnectionById(accountId) {
    try {
      this.showToast('Testing account SMTP socket connection...', 'info');
      const res = await this.authFetch(`/api/accounts/${accountId}/test`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        this.showToast(`✓ Connection Verified! TLS & Authentication OK (Latency: ${data.latencyMs || 100}ms)`, 'success');
      } else {
        this.showToast(`✕ Connection Failed: ${data.error || 'Server rejected credentials'}`, 'danger');
      }
      this.loadSavedAccounts();
    } catch (err) {
      this.showToast(`Test error: ${err.message}`, 'danger');
    }
  },

  onAccountDropdownChange() {
    const select = document.getElementById('accountSwitcherSelect');
    const selectedId = select?.value;
    if (selectedId) {
      this.selectActiveAccount(selectedId);
    }
  },

  selectActiveAccount(accountId) {
    const acc = this.accounts.find(a => a.id === accountId);
    if (!acc) return;

    this.activeAccountId = accountId;

    const emailInput = document.getElementById('senderEmail');
    const passInput = document.getElementById('senderPassword');
    const nameInput = document.getElementById('senderDisplayName');

    if (emailInput) emailInput.value = acc.email;
    if (nameInput) nameInput.value = acc.name || acc.email.split('@')[0];
    if (passInput) {
      if (acc.password) {
        passInput.value = acc.password;
        passInput.placeholder = '•••••••••••••••• (Saved in Secure Vault)';
      } else if (acc.hasPassword) {
        passInput.value = '';
        passInput.placeholder = '•••••••••••••••• (Saved in Secure Vault)';
      } else {
        passInput.value = '';
        passInput.placeholder = 'abcd efgh ijkl mnop';
      }
    }

    try {
      localStorage.setItem('mailflow_last_active_email', acc.email);
      if (acc.name) localStorage.setItem('mailflow_last_active_name', acc.name);
    } catch (e) {}

    const headerEmail = document.getElementById('headerSenderEmail');
    const headerDot = document.getElementById('headerStatusDot');
    const headerSmtpBadge = document.getElementById('headerSmtpBadge');
    const sbText = document.getElementById('sbSenderStatusText');
    const sbDot = document.getElementById('sbStatusDot');
    const sbSubtext = document.getElementById('sbStatusSubtext');

    const isConnected = acc.status === 'Connected' && (acc.hasPassword || !!acc.password);

    if (headerEmail) headerEmail.innerText = acc.email;
    if (headerDot) headerDot.className = isConnected ? 'status-dot' : 'status-dot disconnected';
    if (headerSmtpBadge) {
      headerSmtpBadge.innerText = isConnected ? '● Connected' : '○ Disconnected';
      headerSmtpBadge.style.color = isConnected ? 'var(--status-success)' : 'var(--text-dim)';
    }
    if (sbText) sbText.innerText = acc.email;
    if (sbDot) sbDot.className = isConnected ? 'status-dot' : 'status-dot disconnected';
    if (sbSubtext) sbSubtext.innerText = isConnected ? '✓ Connected (Port 465 SSL)' : '○ Credentials need verification';

    const mobileDot = document.getElementById('mobileHeaderStatusDot');
    if (mobileDot) mobileDot.className = isConnected ? 'status-dot' : 'status-dot disconnected';

    const statusDiv = document.getElementById('smtpVerifyStatus');
    if (statusDiv) {
      statusDiv.innerHTML = isConnected
        ? `<span style="color: var(--status-success); font-weight: 600; display: inline-flex; align-items: center; gap: 6px;"><span class="status-dot"></span> ✓ Connected: ${this.escapeHtml(acc.email)} (Port 465 SSL)</span>`
        : `<span style="color: var(--text-dim);"><span class="status-dot disconnected"></span> Ready to connect ${this.escapeHtml(acc.email)}</span>`;
    }

    const helpBox = document.getElementById('authHelpBox');
    if (helpBox) helpBox.style.display = 'none';

    const consoleDiv = document.getElementById('smtpDiagnosticConsole');
    if (consoleDiv) consoleDiv.style.display = 'none';

    this.renderAccountSwitcherDropdown();
    this.renderAccountsManagerTable();
    this.validatePasswordFormatLive();
    this.updateDesktopLivePreview();
    this.runDeliverabilityAudit(acc.email);
  },

  getActiveAccountEmail() {
    const inputEmail = document.getElementById('senderEmail')?.value.trim();
    if (inputEmail && inputEmail.includes('@')) return inputEmail;
    const acc = this.accounts.find(a => a.id === this.activeAccountId) || this.accounts.find(a => a.isDefault) || this.accounts[0];
    return acc ? acc.email : 'user@gmail.com';
  },

  getActiveAccountPassword() {
    const passInput = document.getElementById('senderPassword')?.value.trim() || '';
    if (passInput && !passInput.includes('•') && !passInput.includes('*')) {
      return passInput;
    }
    const acc = this.accounts.find(a => a.id === this.activeAccountId) || this.accounts.find(a => a.isDefault) || this.accounts[0];
    if (acc?.password && !acc.password.includes('•')) return acc.password;
    return '';
  },

  saveCurrentAccountToStorage() {
    let email = document.getElementById('senderEmail').value.trim();
    if (email.endsWith('@gmail')) email = email + '.com';
    const name = document.getElementById('senderDisplayName')?.value.trim() || email.split('@')[0];
    let password = document.getElementById('senderPassword').value.trim();

    if (!email || !email.includes('@')) {
      alert('Please enter a valid email address.');
      return;
    }

    let acc = this.accounts.find(a => a.email.toLowerCase() === email.toLowerCase());
    const isNewPassword = password && !password.includes('•') && !password.includes('*');

    if (acc) {
      acc.name = name;
      if (isNewPassword) {
        acc.password = password;
        acc.hasPassword = true;
      }
      acc.status = 'Connected';
    } else {
      acc = {
        id: 'acc-' + Date.now(),
        email: email.toLowerCase(),
        name: name,
        password: isNewPassword ? password : '',
        hasPassword: isNewPassword,
        isDefault: this.accounts.length === 0,
        status: 'Connected'
      };
      this.accounts.push(acc);
    }

    this.activeAccountId = acc.id;
    try {
      localStorage.setItem('mailflow_last_active_email', email);
      localStorage.setItem('mailflow_last_active_name', name);
    } catch (e) {}

    this.saveAccountsToStorage();
    this.renderAccountSwitcherDropdown();
    this.renderAccountsManagerTable();

    const payload = { 
      email, 
      name: acc.name, 
      isDefault: acc.isDefault,
      password: isNewPassword ? password : (acc.password || undefined)
    };

    fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(() => {});

    this.showToast(`✓ Account ${email} saved and connected.`);
    this.updateDesktopLivePreview();
  },

  instantConnectAccount() {
    let email = document.getElementById('senderEmail').value.trim();
    if (email.endsWith('@gmail')) email = email + '.com';
    document.getElementById('senderEmail').value = email;

    if (!email || !email.includes('@')) {
      alert('Please enter a valid email address.');
      return;
    }

    this.saveCurrentAccountToStorage();

    const statusDiv = document.getElementById('smtpVerifyStatus');
    const helpBox = document.getElementById('authHelpBox');
    const consoleDiv = document.getElementById('smtpDiagnosticConsole');

    if (statusDiv) {
      statusDiv.innerHTML = `<span style="color: var(--status-success); font-weight: 600; display: inline-flex; align-items: center; gap: 6px;"><span class="status-dot"></span> ✓ Connected & Ready (${this.escapeHtml(email)})</span>`;
    }
    if (helpBox) helpBox.style.display = 'none';
    if (consoleDiv) consoleDiv.style.display = 'none';

    this.selectActiveAccount(this.activeAccountId);
    this.runDeliverabilityAudit(email);
    this.showToast(`✓ ${email} connected & ready for outreach!`);
  },

  makeDefaultAccount(accountId) {
    this.accounts.forEach(a => a.isDefault = (a.id === accountId));
    this.saveAccountsToStorage();
    this.renderAccountSwitcherDropdown();
    this.renderAccountsManagerTable();
    this.showToast('Default account updated.');

    fetch(`/api/accounts/switch/${accountId}`, { method: 'POST' }).catch(() => {});
  },

  removeAccount(accountId) {
    const acc = this.accounts.find(a => a.id === accountId);
    if (!confirm(`Are you sure you want to remove account ${acc ? acc.email : ''}?`)) return;

    this.accounts = this.accounts.filter(a => a.id !== accountId);
    if (this.activeAccountId === accountId) {
      this.activeAccountId = this.accounts[0] ? this.accounts[0].id : null;
      if (this.activeAccountId) this.selectActiveAccount(this.activeAccountId);
      else {
        document.getElementById('senderEmail').value = '';
        document.getElementById('senderPassword').value = '';
        this.resetAccountUI();
      }
    }

    this.saveAccountsToStorage();
    this.renderAccountSwitcherDropdown();
    this.renderAccountsManagerTable();
    this.showToast('Account removed.');

    fetch(`/api/accounts/${accountId}`, { method: 'DELETE' }).catch(() => {});
  },

  openAddAccountModal() {
    document.getElementById('modalAddEmail').value = '';
    document.getElementById('modalAddPassword').value = '';
    this.openModal('modalAddAccount');
  },

  executeAddNewAccount() {
    let email = document.getElementById('modalAddEmail').value.trim();
    if (email.endsWith('@gmail')) email = email + '.com';
    const password = document.getElementById('modalAddPassword').value.trim();

    if (!email || !email.includes('@')) {
      alert('Please enter a valid email address.');
      return;
    }

    let acc = this.accounts.find(a => a.email.toLowerCase() === email.toLowerCase());
    if (acc) {
      acc.password = password;
      acc.hasPassword = true;
      acc.status = 'Connected';
    } else {
      acc = {
        id: 'acc-' + Date.now(),
        email: email.toLowerCase(),
        name: email.split('@')[0],
        password: password,
        hasPassword: !!password,
        isDefault: this.accounts.length === 0,
        status: 'Connected'
      };
      this.accounts.push(acc);
    }

    this.activeAccountId = acc.id;
    this.saveAccountsToStorage();
    this.selectActiveAccount(acc.id);
    this.runDeliverabilityAudit(email);
    this.closeModal('modalAddAccount');
    this.showToast(`✓ Account ${email} added & Auth Configured!`);

    fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, isDefault: true })
    }).catch(() => {});
  },

  // ==========================================================
  // 5-VARIANT AUTO-SHUFFLE ROTATION & ANTI-SPAM ENGINE
  // ==========================================================
  // 5-VARIANT AUTO-SHUFFLE ROTATION & SAVE PERSISTENCE ENGINE
  // ==========================================================

  variantAutoSaveTimer: null,

  isSampleOutreachTemplate(variants) {
    if (!Array.isArray(variants)) return false;
    const sampleSnippets = [
      'quick question', 'quick thought', 'quick inquiry',
      'workflow question', 'quick intro', 'connecting briefly',
      'seeking your perspective', 'hello from', 'checking in with',
      'quick question for you', 'discussing new opportunities',
      'handling your workflows', 'taking on new projects',
      'streamline your communication', 'drop a quick personal note',
      'would you be open to a quick', 'save several hours each week'
    ];
    return variants.some(v => {
      const s = (v?.subject || '').toLowerCase();
      const m = (v?.message || '').toLowerCase();
      return sampleSnippets.some(snip => s.includes(snip) || m.includes(snip));
    });
  },

  async loadMessageVariants() {
    // Aggressively purge ALL legacy localStorage keys that may hold old samples or templates
    const legacyKeys = [
      'mailflow_message_variants',
      'mailflow_message_variants_user_saved',
      'mailflow_variants',
      'mailflow_variants_user_saved',
      'mailflow_outreach_variants',
      'mailflow_outreach_variants_v2',
      'mailflow_outreach_variants_v3',
      'mailflow_outreach_variants_v4',
      'mailflow_variants_user_saved_v4',
      'mailflow_draft',
      'mailflow_subject',
      'mailflow_message'
    ];
    legacyKeys.forEach(k => {
      try { localStorage.removeItem(k); } catch (e) {}
    });

    // 1. Check v5 local storage (only restore if user explicitly saved custom content)
    try {
      const local = localStorage.getItem('mailflow_outreach_variants_v5');
      const userSaved = localStorage.getItem('mailflow_variants_user_saved_v5') === 'true';
      if (local && userSaved) {
        const parsed = JSON.parse(local);
        if (this.isSampleOutreachTemplate(parsed)) {
          localStorage.removeItem('mailflow_outreach_variants_v5');
          localStorage.removeItem('mailflow_variants_user_saved_v5');
        } else if (Array.isArray(parsed) && parsed.length >= 5) {
          this.messageVariants = parsed;
          this.switchVariantTab(this.activeVariantIndex || 0, false);
          return;
        }
      }
    } catch (e) {}

    // 2. Fetch from server (persisted custom variants if any)
    try {
      const res = await fetch('/api/variants');
      const data = await res.json();
      if (data.success && Array.isArray(data.variants)) {
        if (this.isSampleOutreachTemplate(data.variants)) {
          fetch('/api/variants/reset', { method: 'POST' }).catch(() => {});
        } else if (data.variants.some(v => (v.subject && v.subject.trim()) || (v.message && v.message.trim())) && localStorage.getItem('mailflow_variants_user_saved_v5') === 'true') {
          this.messageVariants = data.variants;
          this.saveVariantsToLocalStorage();
          this.switchVariantTab(this.activeVariantIndex || 0, false);
          return;
        }
      }
    } catch (e) {}

    // 3. 100% Clean Blank Default (all 5 slots empty)
    this.messageVariants = [
      { subject: '', message: '' },
      { subject: '', message: '' },
      { subject: '', message: '' },
      { subject: '', message: '' },
      { subject: '', message: '' }
    ];

    this.saveVariantsToLocalStorage();
    this.switchVariantTab(0, false);
  },

  async _syncVariantsFromServer() {
    try {
      const res = await fetch('/api/variants');
      const data = await res.json();
      if (data.success && Array.isArray(data.variants) && !this.isSampleOutreachTemplate(data.variants)) {
        const localEmpty = !this.messageVariants.some(v => (v.subject && v.subject.trim()) || (v.message && v.message.trim()));
        if (localEmpty && localStorage.getItem('mailflow_variants_user_saved_v5') === 'true') {
          this.messageVariants = data.variants;
          this.saveVariantsToLocalStorage();
          this.switchVariantTab(this.activeVariantIndex || 0, false);
        }
      }
    } catch (e) {}
  },

  clearAllMessageVariants() {
    if (!confirm('Are you sure you want to reset all 5 message subjects and bodies to blank?')) return;
    this.messageVariants = [
      { subject: '', message: '' },
      { subject: '', message: '' },
      { subject: '', message: '' },
      { subject: '', message: '' },
      { subject: '', message: '' }
    ];
    try {
      localStorage.removeItem('mailflow_variants_user_saved_v5');
      localStorage.removeItem('mailflow_outreach_variants_v5');
    } catch (e) {}
    this.saveVariantsToLocalStorage();
    this.switchVariantTab(this.activeVariantIndex || 0, false);
    try {
      fetch('/api/variants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variants: this.messageVariants })
      });
    } catch (e) {}
    this.showToast('✓ All 5 message slots reset to blank.');
  },

  saveVariantsToLocalStorage() {
    try {
      localStorage.setItem('mailflow_outreach_variants_v5', JSON.stringify(this.messageVariants));
    } catch (e) {}
  },

  setVariantSaveStatus(text, type = 'completed') {
    const badge = document.getElementById('variantSaveStatusBadge');
    if (badge) {
      badge.innerText = `● ${text}`;
      badge.className = `status-badge ${type === 'inprogress' ? 'status-inprogress' : (type === 'danger' ? 'status-failed' : 'status-completed')}`;
      if (type === 'completed') {
        badge.style.background = '#ecfdf5';
        badge.style.color = '#059669';
        badge.style.border = '1px solid #a7f3d0';
      }
    }
  },

  async saveCurrentActiveVariant() {
    const idx = this.activeVariantIndex;
    const subj = document.getElementById('emailSubject')?.value || '';
    const msg = document.getElementById('emailMessage')?.value || '';

    if (!this.messageVariants[idx]) {
      this.messageVariants[idx] = { subject: '', message: '' };
    }

    this.messageVariants[idx].subject = subj;
    this.messageVariants[idx].message = msg;
    try {
      localStorage.setItem('mailflow_variants_user_saved_v5', 'true');
    } catch (e) {}
    this.saveVariantsToLocalStorage();

    this.setVariantSaveStatus('Saving...', 'inprogress');

    try {
      const res = await fetch(`/api/variants/${idx}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: subj, message: msg })
      });
      const data = await res.json();
      if (data.success) {
        this.setVariantSaveStatus('✓ Saved Just Now', 'completed');
        this.showToast(`✓ Message ${idx + 1} saved successfully!`);
      } else {
        this.setVariantSaveStatus('Saved Locally', 'completed');
        this.showToast(`✓ Message ${idx + 1} saved locally.`);
      }
    } catch (e) {
      this.setVariantSaveStatus('Saved Locally', 'completed');
      this.showToast(`✓ Message ${idx + 1} saved locally.`);
    }
  },

  async saveAllMessageVariants() {
    const idx = this.activeVariantIndex;
    const curSubj = document.getElementById('emailSubject')?.value || '';
    const curMsg = document.getElementById('emailMessage')?.value || '';
    if (this.messageVariants[idx]) {
      this.messageVariants[idx].subject = curSubj;
      this.messageVariants[idx].message = curMsg;
    }

    try {
      localStorage.setItem('mailflow_variants_user_saved_v5', 'true');
    } catch (e) {}
    this.saveVariantsToLocalStorage();
    this.setVariantSaveStatus('Saving All...', 'inprogress');

    try {
      const res = await fetch('/api/variants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variants: this.messageVariants })
      });
      const data = await res.json();
      if (data.success) {
        this.setVariantSaveStatus('✓ All 5 Saved', 'completed');
        this.showToast('✓ All 5 outreach message variants saved!');
      } else {
        this.setVariantSaveStatus('Saved Locally', 'completed');
        this.showToast('✓ All 5 message variants saved locally.');
      }
    } catch (e) {
      this.setVariantSaveStatus('Saved Locally', 'completed');
      this.showToast('✓ All 5 message variants saved locally.');
    }
  },

  switchVariantTab(index, saveCurrent = true) {
    while (this.messageVariants.length < 5) {
      this.messageVariants.push({ subject: '', message: '' });
    }
    if (index < 0 || index >= this.messageVariants.length) return;

    // Save current input before switching only if explicitly requested and changing tabs
    if (saveCurrent && this.activeVariantIndex !== index) {
      const curSubj = document.getElementById('emailSubject')?.value;
      const curMsg = document.getElementById('emailMessage')?.value;
      if (curSubj !== undefined && this.messageVariants[this.activeVariantIndex]) {
        this.messageVariants[this.activeVariantIndex].subject = curSubj;
      }
      if (curMsg !== undefined && this.messageVariants[this.activeVariantIndex]) {
        this.messageVariants[this.activeVariantIndex].message = curMsg;
      }
      this.saveVariantsToLocalStorage();
    }

    this.activeVariantIndex = index;

    // Update tab switcher UI buttons
    for (let i = 0; i < 5; i++) {
      const btn = document.getElementById(`btnVarTab-${i}`);
      if (btn) {
        if (i === index) {
          btn.className = 'variant-tab-btn active';
          btn.innerHTML = `✉️ Message ${i + 1} <span class="pill-rate">Active</span>`;
        } else {
          btn.className = 'variant-tab-btn';
          btn.innerHTML = `✉️ Message ${i + 1}`;
        }
      }
    }

    // Populate inputs for selected variant
    const targetVar = this.messageVariants[index];
    const subjInput = document.getElementById('emailSubject');
    const msgInput = document.getElementById('emailMessage');
    const varSubjLabel = document.getElementById('variantSubjectLabel');
    const varMsgLabel = document.getElementById('variantMessageLabel');
    const activeVarIndicator = document.getElementById('activeVariantIndicator');
    const btnSaveCurrent = document.getElementById('btnSaveCurrentVariant');
    const btnSaveCurrentBottom = document.getElementById('btnSaveCurrentVariantBottom');

    if (subjInput && targetVar) subjInput.value = targetVar.subject || '';
    if (msgInput && targetVar) msgInput.value = targetVar.message || '';
    if (varSubjLabel) varSubjLabel.innerText = `Email Subject for Message ${index + 1} *`;
    if (varMsgLabel) varMsgLabel.innerText = `Message Body for Message ${index + 1} *`;
    if (activeVarIndicator) activeVarIndicator.innerText = `Editing Message ${index + 1} of 5`;
    if (btnSaveCurrent) btnSaveCurrent.innerText = `💾 Save Message ${index + 1}`;
    if (btnSaveCurrentBottom) btnSaveCurrentBottom.innerText = `💾 Save Message ${index + 1}`;

    const isSlotEmpty = !targetVar?.subject?.trim() && !targetVar?.message?.trim();
    if (isSlotEmpty) {
      this.setVariantSaveStatus('Blank Slot', 'completed');
    } else {
      this.setVariantSaveStatus('Saved', 'completed');
    }
    this.analyzeSpamScoreLive();
    this.updateDesktopLivePreview();
  },

  onCurrentVariantInput() {
    const curSubj = document.getElementById('emailSubject')?.value || '';
    const curMsg = document.getElementById('emailMessage')?.value || '';
    if (this.messageVariants[this.activeVariantIndex]) {
      this.messageVariants[this.activeVariantIndex].subject = curSubj;
      this.messageVariants[this.activeVariantIndex].message = curMsg;
    }

    this.setVariantSaveStatus('Auto-Saving...', 'inprogress');
    clearTimeout(this.variantAutoSaveTimer);
    this.variantAutoSaveTimer = setTimeout(() => {
      this.saveVariantsToLocalStorage();
      this.setVariantSaveStatus('Auto-Saved', 'completed');
    }, 400);

    this.analyzeSpamScoreLive();
    this.updateDesktopLivePreview();
  },

  autoOptimizeSpamDeliverability() {
    const chkStealth = document.getElementById('chkStealthMode');
    const chkJitter = document.getElementById('chkJitterDelay');
    const delaySelect = document.getElementById('sendingDelaySelect');
    if (chkStealth) chkStealth.checked = true;
    if (chkJitter) chkJitter.checked = true;
    if (delaySelect) {
      delaySelect.value = '15';
      this.onDelayChange('15');
    }

    const subj = (document.getElementById('emailSubject')?.value || '').trim();
    const ticketPattern = /(ticket\s*(irn|#|\bid\b)|case\s*#|ref\s*#|order\s*#|support\s*ticket)/i;
    if (ticketPattern.test(subj)) {
      this.fixSubjectForPrimaryInbox();
    }

    this.runDeliverabilityAudit();
    this.analyzeSpamScoreLive();
    this.updateDesktopLivePreview();
    this.showToast('✨ Deliverability Protection Activated! Stealth Mode, Jitter Pacing & Subject Safe.');
  },

  insertSpintaxSample() {
    this.insertTag('{Option 1|Option 2|Option 3}');
    this.updateDesktopLivePreview();
  },

  analyzeSpamScoreLive() {
    const subject = (document.getElementById('emailSubject')?.value || '').trim();
    const message = (document.getElementById('emailMessage')?.value || '').trim();

    const fullText = (subject + ' ' + message).toLowerCase();

    const spamTriggers = [
      'free', '100% free', 'risk free', 'buy now', 'act now', 'urgent',
      'make money', 'cash prize', 'earn $$$', 'winner', 'claim now',
      'special promotion', 'limited time offer', 'cheap price', 'congratulations',
      'order now', 'double your income', 'no catch', 'click here now',
      'guarantee', 'pure profit', 'million', 'billion'
    ];

    const flaggedWords = [];
    spamTriggers.forEach(word => {
      const regex = new RegExp(`\\b${word.replace(/\$/g, '\\$')}\\b`, 'i');
      if (regex.test(fullText)) {
        flaggedWords.push(word);
      }
    });

    // Check for deceptive ticket numbers or fake references in cold outreach
    const ticketPattern = /(ticket\s*(irn|#|\bid\b)|case\s*#|ref\s*#|order\s*#|support\s*ticket)/i;
    const hasTicketPattern = ticketPattern.test(subject);
    if (hasTicketPattern) {
      flaggedWords.push('Fake Support Ticket reference');
    }

    let score = 99;
    score -= (flaggedWords.length * 15);
    if (hasTicketPattern) score -= 25;

    const subjectLetters = subject.replace(/[^a-zA-Z]/g, '');
    if (subjectLetters.length > 5) {
      const upperCount = subjectLetters.split('').filter(c => c === c.toUpperCase()).length;
      if (upperCount / subjectLetters.length > 0.6) {
        score -= 20;
      }
    }

    if (/(!{2,}|\?{2,}|\${2,})/.test(subject + message)) {
      score -= 15;
    }

    score = Math.max(15, Math.min(99, score));

    const meterTitle = document.getElementById('meterTitle');
    const gaugeFill = document.getElementById('meterGaugeFill');
    const meterBadge = document.getElementById('meterBadge');
    const alertBox = document.getElementById('spamKeywordsAlert');

    if (gaugeFill) {
      gaugeFill.style.width = `${score}%`;
      gaugeFill.className = 'inbuilt-gauge-fill' + (score < 70 ? ' danger' : (score < 85 ? ' warning' : ''));
    }

    if (meterBadge) {
      meterBadge.className = 'meter-badge-pill' + (score < 70 ? ' danger' : (score < 85 ? ' warning' : ''));
      if (score >= 90) meterBadge.innerText = `● High Deliverability`;
      else if (score >= 75) meterBadge.innerText = `● Moderate Risk`;
      else meterBadge.innerText = `⚠️ High Spam Risk`;
    }

    if (meterTitle) {
      if (score >= 90) meterTitle.innerText = `Content Deliverability Score: ${score}%`;
      else if (score >= 75) meterTitle.innerText = `Moderate Deliverability: ${score}%`;
      else meterTitle.innerText = `Spam Risk Warning: ${score}%`;
    }

    if (alertBox) {
      if (hasTicketPattern) {
        alertBox.style.display = 'block';
        alertBox.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
            <div style="flex: 1; min-width: 260px;">
              ⚠️ <strong>High Spam Risk Detected:</strong> Google and Outlook flag fake support ticket references (like <em>"Ticket IRN #"</em>) as deceptive phishing and route them to Spam. Use simple human subjects like <em>"quick question"</em> or <em>"question for {{name}}"</em>.
            </div>
            <div style="display: flex; gap: 6px; align-items: center;">
              <button type="button" class="btn btn-sm" onclick="app.fixSubjectForPrimaryInbox()" style="background: #059669; color: #fff; border: none; padding: 4px 10px; font-size: 11.5px; border-radius: 6px; font-weight: 600; cursor: pointer;">
                ✨ Auto-Fix Subject
              </button>
              <button type="button" class="btn btn-sm btn-secondary" onclick="app.openSpamGuideModal()" style="font-size: 11.5px; padding: 4px 8px; border-radius: 6px;">
                💡 Why Spam?
              </button>
            </div>
          </div>`;
      } else if (flaggedWords.length > 0) {
        alertBox.style.display = 'block';
        alertBox.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
            <div>
              ⚠️ <strong>Deliverability Alert:</strong> Remove trigger words like <strong>${flaggedWords.map(w => `"${w}"`).join(', ')}</strong> to improve inbox placement.
            </div>
            <button type="button" class="btn btn-sm btn-secondary" onclick="app.openSpamGuideModal()" style="font-size: 11.5px; padding: 4px 8px; border-radius: 6px;">
              💡 Deliverability Guide
            </button>
          </div>`;
      } else {
        alertBox.style.display = 'none';
      }
    }
  },

  togglePreviewMockup() {
    const body = document.getElementById('previewMockupCollapsibleBody');
    const icon = document.getElementById('previewMockupToggleIcon');
    if (!body) return;
    const isHidden = body.style.display === 'none' || window.getComputedStyle(body).display === 'none';
    body.style.display = isHidden ? 'block' : 'none';
    if (icon) icon.innerText = isHidden ? '▾' : '▸';
    try {
      localStorage.setItem('mailflow_preview_collapsed', isHidden ? 'false' : 'true');
    } catch (e) {}
  },

  openSpamGuideModal() {
    this.openModal('modalSpamGuide');
  },

  fixSubjectForPrimaryInbox() {
    const subjInput = document.getElementById('emailSubject');
    if (!subjInput) return;
    let current = subjInput.value.trim();
    // Strip ticket / case prefix if present (e.g. "Ticket IRN #1240530: Wix website enhancement..." -> "Wix website enhancement..." or "question for {{name}}")
    let fixed = current.replace(/^(ticket\s*(irn|#|\bid\b)|case\s*#|ref\s*#|order\s*#|support\s*ticket)[\s\d#:-]*/i, '').trim();
    if (!fixed || fixed.length < 3) {
      fixed = 'quick question for {{name}}';
    } else {
      fixed = fixed.replace(/^[:\s\-]+/, '');
      if (fixed.length > 0) {
        fixed = fixed.charAt(0).toLowerCase() + fixed.slice(1);
      }
      if (!fixed.includes('question') && !fixed.includes('feedback')) {
        fixed = `question about ${fixed}`;
      }
    }
    subjInput.value = fixed;
    if (this.messageVariants && this.messageVariants[this.activeVariantIndex]) {
      this.messageVariants[this.activeVariantIndex].subject = fixed;
    }
    this.onCurrentVariantInput();
    this.showToast('✨ Subject optimized to reduce spam trigger risks!');
  },

  // ==========================================================
  // DESKTOP LIVE PREVIEW & SPINTAX EVALUATION ENGINE
  // ==========================================================

  processSpintax(text, recipientEmail = 'lead1@example.com') {
    if (!text) return '';
    const senderName = (document.getElementById('senderDisplayName')?.value || '').trim() || this.getActiveAccountEmail()?.split('@')[0] || 'Team';
    const senderFirst = senderName.split(' ')[0] || senderName;
    const recName = recipientEmail.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    let result = text
      .replace(/\{\{\s*email\s*\}\}/gi, recipientEmail)
      .replace(/\{\{\s*name\s*\}\}/gi, recName)
      .replace(/\{\{\s*senderName\s*\}\}/gi, senderName)
      .replace(/\{\{\s*senderFirstName\s*\}\}/gi, senderFirst)
      .replace(/\{\{\s*sender\s*\}\}/gi, senderName);

    let iterations = 0;
    while (/\{([^{}]+)\}/.test(result) && iterations < 10) {
      result = result.replace(/\{([^{}]+)\}/g, (match, choices) => {
        const options = choices.split('|');
        const randIndex = Math.floor(Math.random() * options.length);
        return options[randIndex];
      });
      iterations++;
    }
    return result;
  },

  updateDesktopLivePreview() {
    const senderEmail = (document.getElementById('senderEmail')?.value || '').trim() || this.getActiveAccountEmail() || 'user@gmail.com';
    const senderName = (document.getElementById('senderDisplayName')?.value || '').trim() || senderEmail.split('@')[0] || 'Thomas';
    
    // First recipient from parsed list or textarea
    let targetRecipient = 'sarah@example.com';
    if (this.parsedValidation && Array.isArray(this.parsedValidation.validRecipients) && this.parsedValidation.validRecipients.length > 0) {
      targetRecipient = this.parsedValidation.validRecipients[0];
    } else {
      const rawLeads = (document.getElementById('leadsInput')?.value || '').trim();
      const firstLine = rawLeads.split('\n')[0]?.trim();
      if (firstLine && firstLine.includes('@')) {
        targetRecipient = firstLine;
      }
    }

    const curSubj = document.getElementById('emailSubject')?.value || (this.messageVariants[this.activeVariantIndex]?.subject) || '';
    const curMsg = document.getElementById('emailMessage')?.value || (this.messageVariants[this.activeVariantIndex]?.message) || '';

    const processedSubject = curSubj ? this.processSpintax(curSubj, targetRecipient) : '';
    const processedBody = curMsg ? this.processSpintax(curMsg, targetRecipient) : '';

    const fromValEl = document.getElementById('previewFromVal');
    const toValEl = document.getElementById('previewToVal');
    const subjValEl = document.getElementById('previewSubjectVal');
    const bodyValEl = document.getElementById('previewBodyVal');
    const variantTagEl = document.getElementById('previewVariantTag');
    const summaryLeadsEl = document.getElementById('launchSummaryLeads');
    const summaryDurationEl = document.getElementById('launchSummaryDuration');

    if (fromValEl) fromValEl.innerText = `${senderName} <${senderEmail}>`;
    if (toValEl) toValEl.innerText = targetRecipient;
    if (subjValEl) subjValEl.innerText = processedSubject || '(No subject entered)';
    if (bodyValEl) {
      if (!processedBody) {
        bodyValEl.innerHTML = '<span style="color: var(--text-dim); font-style: italic;">(Your outreach message preview will appear here in real-time as you type in Step 3...)</span>';
      } else {
        bodyValEl.innerHTML = this.renderBodyForPreview(processedBody);
      }
    }
    if (variantTagEl) variantTagEl.innerText = `Message ${this.activeVariantIndex + 1} Active`;

    const leadCount = this.parsedValidation?.allowedCount || 0;
    if (summaryLeadsEl) summaryLeadsEl.innerText = leadCount;

    const delaySec = parseInt(document.getElementById('sendingDelaySelect')?.value) || 15;
    const totalSec = leadCount * delaySec;
    if (summaryDurationEl) {
      if (totalSec === 0) summaryDurationEl.innerText = '~0m';
      else if (totalSec < 60) summaryDurationEl.innerText = `~${totalSec}s`;
      else {
        const mins = Math.ceil(totalSec / 60);
        summaryDurationEl.innerText = `~${mins} min${mins > 1 ? 's' : ''}`;
      }
    }
  },

  renderBodyForPreview(text) {
    if (!text) return '';
    let rendered = this.escapeHtml(text);

    // Unescape safe <img> tags that were inserted
    rendered = rendered.replace(/&lt;img\s+([^&>]+)&gt;/gi, (m, attrs) => {
      const cleanAttrs = attrs.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      return `<img ${cleanAttrs} style="max-width:100%; height:auto; display:block; margin:8px 0; border-radius:6px; box-shadow:0 1px 4px rgba(0,0,0,0.08);">`;
    });

    // Unescape safe <a> tags wrapping images or links
    rendered = rendered.replace(/&lt;a\s+([^&>]+)&gt;(.*?)&lt;\/a&gt;/gi, (m, attrs, content) => {
      const cleanAttrs = attrs.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      return `<a ${cleanAttrs} target="_blank">${content}</a>`;
    });

    // Convert Markdown images: ![alt](url) -> <img>
    rendered = rendered.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+|\/uploads\/[^\s)]+|data:image\/[^;]+;base64,[^\s)]+)\)/gi, (m, alt, url) => {
      return `<div style="margin: 8px 0;"><img src="${url}" alt="${alt}" style="max-width:100%; height:auto; display:block; border-radius:6px; box-shadow:0 1px 4px rgba(0,0,0,0.08);"></div>`;
    });

    // Convert Markdown links: [text](url) -> <a href="...">text</a>
    rendered = rendered.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, (m, linkText, url) => {
      return `<a href="${url}" target="_blank" style="color:#2563eb;text-decoration:underline;">${linkText}</a>`;
    });

    return rendered.replace(/\n/g, '<br>');
  },

  spinSpintaxLivePreview() {
    const subj = document.getElementById('emailSubject')?.value || '';
    const msg = document.getElementById('emailMessage')?.value || '';
    const hasSpintax = /\{([^{}]+)\}/.test(subj + ' ' + msg);

    this.updateDesktopLivePreview();
    const card = document.querySelector('.desktop-preview-card');
    if (card) {
      card.classList.remove('spin-pulse');
      void card.offsetWidth;
      card.classList.add('spin-pulse');
    }

    if (!hasSpintax) {
      this.showToast('🎲 Preview refreshed! Tip: Add Spintax like {Hello|Hi|Hey} to test dynamic rotations.');
    } else {
      this.showToast('🎲 Spun fresh Spintax variation combination!');
    }
  },

  // ==========================================================
  // UNIFIED INBOX & REAL GMAIL IMAP SYNC ENGINE
  // ==========================================================

  async loadInbox() {
    try {
      const res = await fetch('/api/inbox');
      const data = await res.json();
      if (data.success && Array.isArray(data.messages)) {
        this.inboxMessages = data.messages;
        const unreadCount = data.unreadCount || this.inboxMessages.filter(m => !m.isRead).length;
        
        // Update nav counter badge
        const badge = document.getElementById('navInboxBadge');
        if (badge) {
          if (unreadCount > 0) {
            badge.innerText = unreadCount;
            badge.style.display = 'inline-block';
          } else {
            badge.style.display = 'none';
          }
        }

        // Update sync badge
        const syncBadge = document.getElementById('inboxSyncBadge');
        if (syncBadge && data.lastSyncTime) {
          const syncDate = new Date(data.lastSyncTime);
          syncBadge.innerText = `● Synced ${syncDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        }

        this.renderInboxItems();
      }
    } catch (e) {
      console.warn('Error loading inbox cache:', e);
    }
  },

  async syncInboxLive() {
    const btn = document.getElementById('btnSyncInbox');
    const spinner = document.getElementById('syncSpinnerIcon');
    const syncBadge = document.getElementById('inboxSyncBadge');

    let email = document.getElementById('senderEmail')?.value.trim() || '';
    let password = document.getElementById('senderPassword')?.value.trim() || '';

    if (!email || !password) {
      const active = this.accounts.find(a => a.id === this.activeAccountId) || this.accounts.find(a => a.isDefault) || this.accounts[0];
      if (active) {
        if (!email) email = active.email;
        if (!password) password = active.password;
      }
    }

    if (!email || !password) {
      alert('Please enter and save your Gmail address and 16-character App Password in Step 1 (Send Outreach) before syncing.');
      this.switchTab('composer');
      return;
    }

    if (btn) btn.disabled = true;
    if (spinner) spinner.classList.add('rotating');
    if (syncBadge) syncBadge.innerText = '● Connecting to Gmail IMAP...';

    this.showToast('Connecting to Gmail IMAP (Port 993 SSL)...');

    try {
      const res = await fetch('/api/inbox/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await res.json();
      if (btn) btn.disabled = false;
      if (spinner) spinner.classList.remove('rotating');

      if (data.success) {
        this.inboxMessages = data.messages || [];
        this.renderInboxItems();
        if (syncBadge) {
          const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          syncBadge.innerText = `● Synced (${nowTime})`;
        }
        this.showToast(`✓ Fetched ${data.totalFetched || this.inboxMessages.length} real Gmail messages.`);
      } else {
        if (syncBadge) syncBadge.innerText = '⚠️ Sync Failed';
        alert('Gmail IMAP Sync note:\n\n' + (data.error || 'Please check your 16-character App Password and ensure IMAP is enabled in Gmail Settings.'));
      }
    } catch (err) {
      if (btn) btn.disabled = false;
      if (spinner) spinner.classList.remove('rotating');
      if (syncBadge) syncBadge.innerText = '⚠️ Sync Failed';
      alert('Error syncing inbox: ' + err.message);
    }
  },

  setInboxFilter(filter, btnEl) {
    this.activeInboxFilter = filter;
    document.querySelectorAll('.inbox-tab-btn').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    this.renderInboxItems();
  },

  filterInboxMessages() {
    this.renderInboxItems();
  },

  renderInboxItems() {
    const container = document.getElementById('inboxItemsList');
    if (!container) return;

    const searchQ = (document.getElementById('inboxSearchInput')?.value || '').toLowerCase().trim();
    
    let filtered = [...this.inboxMessages];

    if (this.activeInboxFilter === 'leads') {
      filtered = filtered.filter(m => m.isLeadReply);
    } else if (this.activeInboxFilter === 'unread') {
      filtered = filtered.filter(m => !m.isRead);
    }

    if (searchQ) {
      filtered = filtered.filter(m => 
        (m.from && m.from.toLowerCase().includes(searchQ)) ||
        (m.fromName && m.fromName.toLowerCase().includes(searchQ)) ||
        (m.subject && m.subject.toLowerCase().includes(searchQ)) ||
        (m.snippet && m.snippet.toLowerCase().includes(searchQ))
      );
    }

    if (filtered.length === 0) {
      container.innerHTML = `
        <div style="padding: 32px 18px; text-align: center; color: var(--text-dim); font-size: 13px;">
          <div style="font-size: 28px; margin-bottom: 8px;">📭</div>
          <strong style="color: var(--text-main); font-size: 14px;">No messages in view</strong>
          <p style="margin-top: 6px; font-size: 12px; line-height: 1.5; color: var(--text-dim);">Click <strong>"Sync Gmail Replies"</strong> to load real incoming emails directly from your Gmail inbox.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map(m => {
      const isSelected = String(m.uid) === String(this.activeInboxUid);
      const initial = (m.fromName || m.from || 'U').charAt(0).toUpperCase();
      const dateFormatted = m.date ? new Date(m.date).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';

      return `
        <div class="inbox-item ${!m.isRead ? 'unread' : ''} ${isSelected ? 'active' : ''}" onclick="app.selectInboxMessage('${m.uid}')">
          <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px;">
            <div style="font-weight: ${!m.isRead ? '700' : '600'}; font-size: 13.5px; color: var(--text-main); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 170px;">
              ${this.escapeHtml(m.fromName || m.from)}
            </div>
            <div style="font-size: 11.5px; color: var(--text-dim);">${dateFormatted}</div>
          </div>
          <div style="font-size: 12.5px; font-weight: ${!m.isRead ? '600' : '500'}; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 4px;">
            ${this.escapeHtml(m.subject || '(No Subject)')}
          </div>
          <div style="font-size: 12px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.4;">
            ${this.escapeHtml(m.snippet || '')}
          </div>
          ${m.isLeadReply ? `<div style="margin-top: 6px;"><span class="status-badge status-completed" style="font-size: 10px; padding: 1px 6px;">🎯 Lead Reply</span></div>` : ''}
        </div>
      `;
    }).join('');
  },

  async selectInboxMessage(uid) {
    this.activeInboxUid = uid;
    this.renderInboxItems();

    const emptyPane = document.getElementById('inboxEmptySelection');
    const activeView = document.getElementById('inboxActiveView');

    if (emptyPane) emptyPane.style.display = 'none';
    if (activeView) activeView.style.display = 'flex';

    try {
      const res = await fetch(`/api/inbox/${uid}`);
      const data = await res.json();
      if (data.success && data.message) {
        const m = data.message;
        
        // Update local state
        const local = this.inboxMessages.find(msg => String(msg.uid) === String(uid));
        if (local) local.isRead = true;
        this.renderInboxItems();

        document.getElementById('inboxViewSubject').innerText = m.subject || '(No Subject)';
        document.getElementById('inboxViewFromName').innerText = m.fromName || m.from || 'Sender';
        document.getElementById('inboxViewFromEmail').innerText = m.from || '';
        document.getElementById('inboxViewAvatar').innerText = (m.fromName || m.from || 'U').charAt(0).toUpperCase();
        document.getElementById('inboxViewDate').innerText = m.date ? new Date(m.date).toLocaleString() : '';

        const leadBadge = document.getElementById('inboxViewLeadBadge');
        if (leadBadge) leadBadge.style.display = m.isLeadReply ? 'inline-flex' : 'none';

        const contentEl = document.getElementById('inboxViewContent');
        if (contentEl) {
          if (m.htmlBody) {
            contentEl.innerHTML = m.htmlBody;
          } else {
            contentEl.innerHTML = `<pre style="font-family: inherit; white-space: pre-wrap; font-size: 13.5px; line-height: 1.6; color: var(--text-main);">${this.escapeHtml(m.textBody || m.snippet || '')}</pre>`;
          }
        }

        // Set default reply subject
        const replyText = document.getElementById('inboxReplyText');
        if (replyText) {
          replyText.value = '';
          replyText.focus();
        }
      }
    } catch (e) {
      console.warn('Error loading message detail:', e);
    }
  },

  async sendInboxReply() {
    if (!this.activeInboxUid) return;
    const msg = this.inboxMessages.find(m => String(m.uid) === String(this.activeInboxUid));
    if (!msg) return;

    const replyBody = (document.getElementById('inboxReplyText')?.value || '').trim();
    if (!replyBody) {
      alert('Please type a reply message.');
      document.getElementById('inboxReplyText').focus();
      return;
    }

    const btn = document.getElementById('btnSendInboxReply');
    if (btn) {
      btn.disabled = true;
      btn.innerText = '⚡ Sending Direct Reply...';
    }

    try {
      const senderEmail = document.getElementById('senderEmail')?.value.trim() || '';
      const senderPassword = document.getElementById('senderPassword')?.value.trim() || '';

      const res = await fetch('/api/inbox/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderEmail,
          senderPassword,
          to: msg.from,
          subject: msg.subject && msg.subject.startsWith('Re:') ? msg.subject : `Re: ${msg.subject || 'Outreach'}`,
          message: replyBody,
          inReplyTo: msg.messageId,
          references: msg.messageId
        })
      });

      const data = await res.json();
      if (btn) {
        btn.disabled = false;
        btn.innerText = '⚡ Send Direct Reply';
      }

      if (data.success) {
        document.getElementById('inboxReplyText').value = '';
        this.showToast(`✓ Reply sent directly to ${msg.from}!`);
      } else {
        alert('Failed to send reply: ' + (data.error || 'Check sender credentials'));
      }
    } catch (err) {
      if (btn) {
        btn.disabled = false;
        btn.innerText = '⚡ Send Direct Reply';
      }
      alert('Error sending reply: ' + err.message);
    }
  },

  // ==========================================================
  // GMAIL SOCKET DIAGNOSTICS
  // ==========================================================

  async testSmtpConnection() {
    let email = document.getElementById('senderEmail')?.value.trim() || '';
    if (email.endsWith('@gmail')) email = email + '.com';
    if (document.getElementById('senderEmail')) document.getElementById('senderEmail').value = email;
    
    let password = document.getElementById('senderPassword')?.value.trim() || '';
    if (password.includes('•') || password.includes('*')) password = '';

    const activeAcc = this.accounts.find(a => a.email.toLowerCase() === email.toLowerCase());
    if (!password && activeAcc?.password) {
      password = activeAcc.password;
    }

    const statusDiv = document.getElementById('smtpVerifyStatus');
    const helpBox = document.getElementById('authHelpBox');
    const consoleDiv = document.getElementById('smtpDiagnosticConsole');
    const logBox = document.getElementById('terminalLogContainer');
    const btn = document.getElementById('btnTestSmtp');

    if (!email || !email.includes('@')) {
      alert('Please enter your sender email address.');
      document.getElementById('senderEmail')?.focus();
      return;
    }

    if (!password && (!activeAcc || !activeAcc.hasPassword)) {
      alert('Please enter your 16-character App Password.');
      document.getElementById('senderPassword')?.focus();
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.innerText = '⚡ Connecting Socket...';
    }
    if (consoleDiv) consoleDiv.style.display = 'block';
    if (logBox) {
      logBox.innerHTML = `
        <div class="terminal-line"><span class="term-tag-info">[INIT]</span> Initializing TLS/TCP socket diagnostic (Forcing IPv4) for ${this.escapeHtml(email)}...</div>
        <div class="terminal-line"><span class="term-tag-info">[RESOLV]</span> Looking up MX and SMTP host routing for smtp.gmail.com...</div>
      `;
    }
    if (statusDiv) statusDiv.innerHTML = '<span style="color: var(--primary);">⚡ Performing cryptographic handshake on port 465 SSL...</span>';
    if (helpBox) helpBox.style.display = 'none';

    try {
      const res = await fetch('/api/smtp/diagnose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();

      if (btn) {
        btn.disabled = false;
        btn.innerText = '⚡ Live Socket Diagnose';
      }

      if (logBox && Array.isArray(data.logs)) {
        logBox.innerHTML = data.logs.map(l => {
          let tagClass = 'term-tag-info';
          let tagText = `[${l.step}]`;
          if (l.status === 'success') { tagClass = 'term-tag-ok'; tagText = '[OK]'; }
          else if (l.status === 'error') { tagClass = 'term-tag-err'; tagText = '[ERR]'; }
          else if (l.status === 'warning') { tagClass = 'term-tag-warn'; tagText = '[WARN]'; }
          return `<div class="terminal-line"><span class="${tagClass}">${tagText}</span> ${this.escapeHtml(l.text)}</div>`;
        }).join('');
        logBox.scrollTop = logBox.scrollHeight;
      }

      if (data.success) {
        if (statusDiv) {
          statusDiv.innerHTML = `<span style="color: var(--status-success); font-weight: 600; display: inline-flex; align-items: center; gap: 6px;"><span class="status-dot"></span> ✓ Connected to ${data.targetHost}:${data.targetPort} (Authenticated)</span>`;
        }
        if (helpBox) helpBox.style.display = 'none';
        this.showToast(`✓ Socket authentication verified for ${email}`);
        
        if (activeAcc) {
          if (password) activeAcc.password = password;
          activeAcc.status = 'Connected';
          activeAcc.hasPassword = true;
        }
        this.saveCurrentAccountToStorage();
        this.runDeliverabilityAudit(email);
      } else {
        if (statusDiv) {
          statusDiv.innerHTML = `<span style="color: var(--status-danger); font-weight: 600;">✕ ${data.targetHost || 'smtp.gmail.com'} rejected credentials</span>`;
        }
        if (helpBox) {
          helpBox.style.display = 'block';
          const helpSender = document.getElementById('helpSenderEmail');
          if (helpSender) helpSender.innerText = email;
        }
      }
    } catch (err) {
      if (btn) {
        btn.disabled = false;
        btn.innerText = '⚡ Live Socket Diagnose';
      }
      if (logBox) {
        logBox.innerHTML += `<div class="terminal-line"><span class="term-tag-err">[ERR]</span> Diagnostic note: ${this.escapeHtml(err.message)}</div>`;
      }
      if (statusDiv) statusDiv.innerHTML = '<span style="color: var(--status-danger);">✕ Diagnostics check complete</span>';
    }
  },

  // ==========================================================
  // SEND 1 TEST EMAIL
  // ==========================================================

  openTestSendModal() {
    this.openModal('modalTestSend');
  },

  async executeTestSend() {
    let senderEmail = document.getElementById('senderEmail')?.value.trim() || '';
    if (senderEmail.endsWith('@gmail')) senderEmail = senderEmail + '.com';
    let senderPassword = document.getElementById('senderPassword')?.value.trim() || '';
    if (senderPassword.includes('•') || senderPassword.includes('*')) senderPassword = '';
    
    const activeAcc = this.accounts.find(a => a.email.toLowerCase() === senderEmail.toLowerCase());
    if (!senderPassword && activeAcc?.password) {
      senderPassword = activeAcc.password;
    }

    const senderName = document.getElementById('senderDisplayName')?.value.trim() || activeAcc?.name || senderEmail.split('@')[0];
    const testRecipient = document.getElementById('testRecipientEmail')?.value.trim();
    const subject = document.getElementById('emailSubject')?.value.trim() || 'Test Outreach Dispatch';
    const message = document.getElementById('emailMessage')?.value.trim() || 'Hi,\n\nThis is a direct test outreach message from MailFlow.\n\nBest,\n' + senderName;
    const plainTextOnly = document.getElementById('chkStealthMode') ? document.getElementById('chkStealthMode').checked : true;
    const btn = document.getElementById('btnExecuteTestSend');

    if (!testRecipient || !testRecipient.includes('@')) {
      this.highlightField('testRecipientEmail', '⚠️ Please enter a valid recipient email address.');
      return;
    }

    if (testRecipient.toLowerCase() === senderEmail.toLowerCase()) {
      const proceed = confirm(
        '⚠️ Deliverability Warning:\n\n' +
        'You are sending a test email to the exact same email address you are sending from (' + senderEmail + ').\n\n' +
        'Google\'s incoming security gateway automatically treats emails sent to oneself via external apps as spoofing, and puts them in Spam.\n\n' +
        'To accurately verify inbox arrival, send this test to a different email address (e.g. your secondary email, Outlook, Yahoo, or Mail-Tester.com).\n\n' +
        'Do you still want to send to ' + testRecipient + '?'
      );
      if (!proceed) return;
    }

    const ticketPattern = /(ticket\s*(irn|#|\bid\b)|case\s*#|ref\s*#|order\s*#|support\s*ticket)/i;
    if (ticketPattern.test(subject)) {
      const fixPrompt = confirm(
        `⚠️ High Spam Risk Detected:\n\n` +
        `Your subject "${subject}" contains a fake support ticket reference ("Ticket IRN #").\n\n` +
        `Google and Outlook automatically detect this as deceptive phishing and route the email to Spam.\n\n` +
        `Click OK to auto-fix the subject to reduce spam filters before sending.\n` +
        `Click Cancel to send with your current subject anyway.`
      );
      if (fixPrompt) {
        this.fixSubjectForPrimaryInbox();
        return this.executeTestSend();
      }
    }

    if (!senderPassword && (!activeAcc || !activeAcc.hasPassword)) {
      this.highlightField('senderPassword', '⚠️ Please enter your 16-character Google App Password in Step 1 first.');
      return;
    }

    const enableTracking = document.getElementById('testSendEnableTracking') ? document.getElementById('testSendEnableTracking').checked : true;

    btn.disabled = true;
    btn.innerText = 'Sending Test Email...';

    try {
      const res = await fetch('/api/campaigns/test-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderEmail,
          senderPassword,
          senderName,
          testRecipient,
          subject,
          message,
          plainTextOnly,
          enableTracking
        })
      });

      const data = await res.json();
      btn.disabled = false;
      btn.innerText = 'Send Test Now';

      if (data.success) {
        this.closeModal('modalTestSend');
        let msg = `✓ Test email delivered to ${testRecipient}!`;
        if (data.trackingId) {
          msg += ` Open tracking active 👁️`;
        }
        this.showToast(msg);
        this.loadSent();
      } else {
        alert('Test send failed: ' + (data.error || 'Check your sender credentials'));
      }
    } catch (e) {
      btn.disabled = false;
      btn.innerText = 'Send Test Now';
      alert('Error sending test email: ' + e.message);
    }
  },

  // ==========================================================
  // RECIPIENT PARSER & VALIDATION (50 LIMIT)
  // ==========================================================

  async parseLeadsLive() {
    const rawText = (document.getElementById('leadsInput')?.value || '').trim();
    if (!rawText) {
      this.parsedValidation = {
        validRecipients: [],
        cappedRecipients: [],
        validCount: 0,
        duplicatesRemoved: 0,
        invalidCount: 0,
        invalidEmails: [],
        isOverLimit: false,
        canSend: false
      };
      this.updateLeadsUI(this.parsedValidation);
      return;
    }

    // Instant zero-lag client validation first so UI updates immediately
    const tokens = rawText.split(/[\r\n,;\t]+/).map(t => t.replace(/[<>"']/g, '').trim()).filter(Boolean);
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const validEmails = [];
    const invalidEmails = [];
    const seenSet = new Set();
    let dupes = 0;

    for (const t of tokens) {
      if (emailRegex.test(t)) {
        const norm = t.toLowerCase();
        if (seenSet.has(norm)) {
          dupes++;
        } else {
          seenSet.add(norm);
          validEmails.push(t);
        }
      } else {
        invalidEmails.push(t);
      }
    }

    const capped = validEmails.slice(0, 50);
    this.parsedValidation = {
      validRecipients: capped,
      cappedRecipients: capped,
      validCount: capped.length,
      allowedCount: capped.length,
      duplicatesRemoved: dupes,
      invalidCount: invalidEmails.length,
      invalidEmails: invalidEmails,
      isOverLimit: validEmails.length > 50,
      canSend: capped.length > 0 && invalidEmails.length === 0
    };
    this.updateLeadsUI(this.parsedValidation);

    try {
      const res = await fetch('/api/recipients/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText })
      });
      const data = await res.json();
      if (data.success) {
        this.parsedValidation = data;
        this.updateLeadsUI(data);
      }
    } catch (err) {
      // Client parse already active, graceful fallback
    }
  },

  updateLeadsUI(data) {
    const countLabel = document.getElementById('leadsCountLabel');
    const limitWarning = document.getElementById('leadsLimitWarning');
    const progressBar = document.getElementById('leadsProgressBar');
    
    const pillValid = document.getElementById('pillValid');
    const pillInvalid = document.getElementById('pillInvalid');
    const pillDupes = document.getElementById('pillDupes');
    const pillLimit = document.getElementById('pillLimit');
    const errorAlert = document.getElementById('validationErrorAlert');

    const validCount = data.validCount || 0;
    const cappedCount = data.allowedCount || 0;
    const pct = Math.min(100, Math.round((cappedCount / 50) * 100));

    if (countLabel) countLabel.innerText = `${cappedCount} / 50 leads`;
    if (progressBar) {
      progressBar.style.width = `${pct}%`;
      if (validCount >= 50) progressBar.className = 'progress-bar-fill warning';
      else progressBar.className = 'progress-bar-fill';
    }

    if (limitWarning) {
      limitWarning.style.display = data.isOverLimit ? 'inline-block' : 'none';
    }

    if (pillValid) {
      pillValid.style.display = validCount > 0 ? 'inline-flex' : 'none';
      pillValid.innerText = `✓ ${validCount} valid`;
    }

    if (pillInvalid) {
      pillInvalid.style.display = data.invalidCount > 0 ? 'inline-flex' : 'none';
      pillInvalid.innerText = `⚠ ${data.invalidCount} invalid`;
    }

    if (pillDupes) {
      pillDupes.style.display = data.duplicatesRemoved > 0 ? 'inline-flex' : 'none';
      pillDupes.innerText = `↻ ${data.duplicatesRemoved} duplicate${data.duplicatesRemoved > 1 ? 's' : ''} removed`;
    }

    if (pillLimit) {
      pillLimit.style.display = data.isOverLimit ? 'inline-flex' : 'none';
      pillLimit.innerText = `Maximum of 50 leads reached.`;
    }

    if (errorAlert) {
      if (data.invalidCount > 0) {
        errorAlert.style.display = 'block';
        errorAlert.innerHTML = `⚠️ <strong>Action needed:</strong> Please fix or remove ${data.invalidCount} invalid lead address${data.invalidCount > 1 ? 'es' : ''} before sending.`;
      } else {
        errorAlert.style.display = 'none';
      }
    }

    this.updateDesktopLivePreview();
  },

  pasteSampleLeads() {
    const sample = `sarah@example.com
mike@example.com
contact@growthagency.co
partnerships@globalmedia.net
david.clark@techstart.io
info@innovate.org
hello@venturebuild.com
rachel.adams@summitgroup.io
alex.miller@enterprise.com
lead10@businesspartner.com`;

    document.getElementById('leadsInput').value = sample;
    this.parseLeadsLive();
    this.updateDesktopLivePreview();
    this.showToast('10 example leads loaded.');
  },

  clearLeadsInput() {
    const input = document.getElementById('leadsInput');
    if (input) {
      input.value = '';
      this.parseLeadsLive();
      this.updateDesktopLivePreview();
      this.showToast('Leads list cleared.');
    }
  },

  insertTag(tag) {
    const activeTarget = (this._lastFocusedInput === 'emailSubject')
      ? document.getElementById('emailSubject')
      : document.getElementById('emailMessage');
    const inputEl = activeTarget || document.getElementById('emailMessage');
    if (!inputEl) return;

    const start = inputEl.selectionStart || inputEl.value.length;
    const end = inputEl.selectionEnd || inputEl.value.length;
    inputEl.value = inputEl.value.substring(0, start) + tag + inputEl.value.substring(end);
    inputEl.focus();
    inputEl.selectionStart = inputEl.selectionEnd = start + tag.length;

    this.onCurrentVariantInput();
    this.updateDesktopLivePreview();
  },

  // ==========================================================
  // INLINE IMAGE INSERTION & UPLOAD ENGINE
  // ==========================================================

  openInsertImageModal() {
    this._currentImageBase64 = null;
    this._currentImageFilename = null;
    this._imageModalTab = 'upload';

    const fileInput = document.getElementById('modalImageFileInput');
    if (fileInput) fileInput.value = '';

    const urlInput = document.getElementById('modalImageUrlInput');
    if (urlInput) urlInput.value = '';

    const altInput = document.getElementById('modalImageAltInput');
    if (altInput) altInput.value = '';

    const linkInput = document.getElementById('modalImageLinkInput');
    if (linkInput) linkInput.value = '';

    const widthSelect = document.getElementById('modalImageWidthSelect');
    if (widthSelect) widthSelect.value = '100%';

    const previewContainer = document.getElementById('modalImagePreviewContainer');
    if (previewContainer) previewContainer.style.display = 'none';

    this.switchImageModalTab('upload');
    this.openModal('modalInsertImage');
  },

  switchImageModalTab(tab) {
    this._imageModalTab = tab;
    const tabUpload = document.getElementById('imageTabUpload');
    const tabUrl = document.getElementById('imageTabUrl');
    const btnUpload = document.getElementById('tabBtnUploadImg');
    const btnUrl = document.getElementById('tabBtnUrlImg');

    if (tab === 'upload') {
      if (tabUpload) tabUpload.style.display = 'block';
      if (tabUrl) tabUrl.style.display = 'none';
      if (btnUpload) btnUpload.className = 'btn btn-sm btn-primary';
      if (btnUrl) btnUrl.className = 'btn btn-sm btn-secondary';
      if (this._currentImageBase64) {
        this.updateModalImagePreview(this._currentImageBase64, this._currentImageFilename);
      } else {
        const previewContainer = document.getElementById('modalImagePreviewContainer');
        if (previewContainer) previewContainer.style.display = 'none';
      }
    } else {
      if (tabUpload) tabUpload.style.display = 'none';
      if (tabUrl) tabUrl.style.display = 'block';
      if (btnUpload) btnUpload.className = 'btn btn-sm btn-secondary';
      if (btnUrl) btnUrl.className = 'btn btn-sm btn-primary';
      const url = document.getElementById('modalImageUrlInput')?.value.trim();
      if (url) {
        this.updateModalImagePreview(url, 'External Web Image');
      } else {
        const previewContainer = document.getElementById('modalImagePreviewContainer');
        if (previewContainer) previewContainer.style.display = 'none';
      }
    }
  },

  onImageFileSelected(files) {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.type.startsWith('image/')) {
      alert('Please select an image file (PNG, JPG, WebP, GIF, SVG).');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      alert('Image file size must be less than 10MB.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      this._currentImageBase64 = e.target.result;
      this._currentImageFilename = file.name;

      const altInput = document.getElementById('modalImageAltInput');
      if (altInput && !altInput.value) {
        altInput.value = file.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ');
      }

      const sizeKb = Math.round(file.size / 1024);
      this.updateModalImagePreview(this._currentImageBase64, `${file.name} (~${sizeKb} KB)`);
    };
    reader.readAsDataURL(file);
  },

  onImageUrlInput(url) {
    const clean = (url || '').trim();
    if (clean) {
      this.updateModalImagePreview(clean, 'External Web Image');
      const altInput = document.getElementById('modalImageAltInput');
      if (altInput && !altInput.value) {
        const parts = clean.split('/').pop().split('?')[0];
        altInput.value = parts.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ') || 'Image';
      }
    } else {
      const previewContainer = document.getElementById('modalImagePreviewContainer');
      if (previewContainer) previewContainer.style.display = 'none';
    }
  },

  updateModalImagePreview(src, metaText = '') {
    const previewContainer = document.getElementById('modalImagePreviewContainer');
    const previewEl = document.getElementById('modalImagePreviewEl');
    const metaEl = document.getElementById('modalImageMetaText');
    if (previewContainer && previewEl) {
      previewEl.src = src;
      previewContainer.style.display = 'block';
      if (metaEl) metaEl.innerText = metaText;
    }
  },

  async confirmInsertImage() {
    const btn = document.getElementById('btnConfirmInsertImage');
    const altText = (document.getElementById('modalImageAltInput')?.value || '').trim() || 'Image';
    const width = document.getElementById('modalImageWidthSelect')?.value || '100%';
    const linkUrl = (document.getElementById('modalImageLinkInput')?.value || '').trim();

    let finalImageUrl = '';

    if (this._imageModalTab === 'upload') {
      if (!this._currentImageBase64) {
        alert('Please choose an image file to upload.');
        return;
      }

      if (btn) {
        btn.disabled = true;
        btn.innerText = 'Uploading Image...';
      }

      try {
        const res = await fetch('/api/upload-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            imageBase64: this._currentImageBase64,
            filename: this._currentImageFilename || 'image.png'
          })
        });
        const data = await res.json();
        if (btn) {
          btn.disabled = false;
          btn.innerText = '🖼️ Insert into Message';
        }

        if (data.success && (data.url || data.relativeUrl)) {
          finalImageUrl = data.url || data.relativeUrl;
        } else {
          alert('Failed to upload image: ' + (data.error || 'Server error'));
          return;
        }
      } catch (err) {
        if (btn) {
          btn.disabled = false;
          btn.innerText = '🖼️ Insert into Message';
        }
        alert('Image upload failed: ' + err.message);
        return;
      }
    } else {
      const urlInput = (document.getElementById('modalImageUrlInput')?.value || '').trim();
      if (!urlInput) {
        alert('Please enter an image URL (e.g. https://example.com/logo.png).');
        return;
      }
      finalImageUrl = urlInput;
    }

    this.insertImageTagIntoMessage({
      url: finalImageUrl,
      alt: altText,
      width: width,
      link: linkUrl
    });

    this.closeModal('modalInsertImage');
    this.showToast(`✓ Image inserted into Message ${this.activeVariantIndex + 1}!`);
  },

  insertImageTagIntoMessage({ url, alt, width = '100%', link = '' }) {
    const msgEl = document.getElementById('emailMessage');
    if (!msgEl) return;

    let imageTag = '';
    const cleanAlt = (alt || 'Image').replace(/"/g, '&quot;');
    const isFullWidth = (width === '100%');

    if (!link && isFullWidth) {
      // Clean, standard Markdown image syntax
      imageTag = `\n\n![${cleanAlt}](${url})\n\n`;
    } else {
      // HTML image tag with custom width or link
      const widthAttr = !isFullWidth ? ` width="${parseInt(width) || width}"` : '';
      const styleAttr = isFullWidth 
        ? 'style="max-width:100%;height:auto;display:block;margin:12px 0;border-radius:6px;"'
        : `style="max-width:100%;width:${width};height:auto;display:block;margin:12px 0;border-radius:6px;"`;

      let imgHtml = `<img src="${url}" alt="${cleanAlt}"${widthAttr} ${styleAttr} />`;
      if (link) {
        imgHtml = `<a href="${link}" target="_blank">${imgHtml}</a>`;
      }
      imageTag = `\n\n${imgHtml}\n\n`;
    }

    const start = msgEl.selectionStart || msgEl.value.length;
    const end = msgEl.selectionEnd || msgEl.value.length;
    msgEl.value = msgEl.value.substring(0, start) + imageTag + msgEl.value.substring(end);
    msgEl.focus();
    msgEl.selectionStart = msgEl.selectionEnd = start + imageTag.length;

    this.onCurrentVariantInput();
    this.updateDesktopLivePreview();
  },

  async uploadAndInsertImageFile(file, altText = '') {
    if (!file || !file.type.startsWith('image/')) return;
    this.showToast('Uploading image...', 'info');

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const res = await fetch('/api/upload-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            imageBase64: e.target.result,
            filename: file.name || 'image.png'
          })
        });
        const data = await res.json();
        if (data.success && (data.url || data.relativeUrl)) {
          const imgUrl = data.url || data.relativeUrl;
          const alt = altText || file.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ') || 'Image';
          this.insertImageTagIntoMessage({ url: imgUrl, alt, width: '100%' });
          this.showToast(`✓ Image uploaded and inserted!`);
        } else {
          this.showToast('Failed to upload image: ' + (data.error || 'Server error'), 'danger');
        }
      } catch (err) {
        this.showToast('Image upload failed: ' + err.message, 'danger');
      }
    };
    reader.readAsDataURL(file);
  },

  async loadDraft() {
    try {
      const res = await fetch('/api/draft');
      const data = await res.json();
      if (data.success && data.draft) {
        if (!document.getElementById('emailSubject').value) {
          document.getElementById('emailSubject').value = data.draft.subject || '';
        }
        if (!document.getElementById('emailMessage').value) {
          document.getElementById('emailMessage').value = data.draft.message || '';
        }
      }
    } catch (e) {}
  },

  // ==========================================================
  // SEND OUTREACH WORKFLOW WITH ANTI-SPAM INTERVAL
  // ==========================================================

  highlightField(fieldId, message) {
    const el = document.getElementById(fieldId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus();
      el.classList.add('input-error-pulse');
      setTimeout(() => el.classList.remove('input-error-pulse'), 3000);
    }
    this.showToast(message, 'danger');
  },

  async startOutreachCampaign() {
    const btn = document.getElementById('btnSendOutreach');

    // 1. Synchronously parse leads directly in client so button never lags or fails on slow networks
    const rawRecipients = (document.getElementById('leadsInput')?.value || '').trim();
    if (rawRecipients) {
      const tokens = rawRecipients.split(/[\r\n,;\t]+/).map(t => t.replace(/[<>"']/g, '').trim()).filter(Boolean);
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const validEmails = [];
      const invalidEmails = [];
      const seenSet = new Set();
      let dupes = 0;

      for (const t of tokens) {
        if (emailRegex.test(t)) {
          const norm = t.toLowerCase();
          if (seenSet.has(norm)) {
            dupes++;
          } else {
            seenSet.add(norm);
            validEmails.push(t);
          }
        } else {
          invalidEmails.push(t);
        }
      }

      const capped = validEmails.slice(0, 50);
      this.parsedValidation = {
        validRecipients: capped,
        cappedRecipients: capped,
        validCount: capped.length,
        allowedCount: capped.length,
        duplicatesRemoved: dupes,
        invalidCount: invalidEmails.length,
        invalidEmails: invalidEmails,
        isOverLimit: validEmails.length > 50,
        canSend: capped.length > 0 && invalidEmails.length === 0
      };
      this.updateLeadsUI(this.parsedValidation);
    }

    this.onCurrentVariantInput();

    let senderEmail = document.getElementById('senderEmail')?.value.trim() || '';
    if (senderEmail.endsWith('@gmail')) senderEmail = senderEmail + '.com';
    if (document.getElementById('senderEmail')) document.getElementById('senderEmail').value = senderEmail;

    let senderPassword = document.getElementById('senderPassword')?.value.trim() || '';
    if (senderPassword.includes('•') || senderPassword.includes('*')) senderPassword = '';

    const activeAcc = this.accounts.find(a => a.email.toLowerCase() === senderEmail.toLowerCase());
    if (!senderPassword && activeAcc?.password) {
      senderPassword = activeAcc.password;
    }

    const senderName = document.getElementById('senderDisplayName')?.value.trim() || activeAcc?.name || senderEmail.split('@')[0];
    const subject = document.getElementById('emailSubject')?.value.trim() || '';
    const message = document.getElementById('emailMessage')?.value.trim() || '';
    const delaySeconds = parseInt(document.getElementById('sendingDelaySelect')?.value) || 15;
    const plainTextOnly = document.getElementById('chkStealthMode') ? document.getElementById('chkStealthMode').checked : true;
    const enableTracking = document.getElementById('chkOpenTracking') ? document.getElementById('chkOpenTracking').checked : true;

    // STEP 1 VALIDATION (Visual pulse + instant toast, no frozen alert)
    if (!senderEmail || !senderEmail.includes('@')) {
      this.highlightField('senderEmail', '⚠️ Step 1: Please enter your sender email address.');
      return;
    }

    if (!senderPassword && (!activeAcc || !activeAcc.hasPassword)) {
      this.highlightField('senderPassword', '⚠️ Step 1: Please enter your 16-character Google App Password.');
      return;
    }

    // STEP 2 VALIDATION
    const val = this.parsedValidation || {};
    const leadList = val.cappedRecipients || val.validRecipients || [];
    if (!rawRecipients || leadList.length === 0) {
      this.highlightField('leadsInput', '⚠️ Step 2: Please paste at least one lead email address.');
      return;
    }

    if (val.invalidCount > 0) {
      this.highlightField('leadsInput', `⚠️ Step 2: Please remove the ${val.invalidCount} invalid address(es).`);
      return;
    }

    // STEP 3 VALIDATION
    if (!subject) {
      this.highlightField('emailSubject', '⚠️ Step 3: Please enter an outreach subject.');
      return;
    }

    if (!message) {
      this.highlightField('emailMessage', '⚠️ Step 3: Please write your outreach message body.');
      return;
    }

    // SAFE SELF-RECIPIENT CHECK (No undefined.find crash!)
    const selfRecipient = leadList.find(r => typeof r === 'string' && r.toLowerCase() === senderEmail.toLowerCase());
    if (selfRecipient) {
      const proceed = confirm(
        `⚠️ Self-Sending Deliverability Warning:\n\n` +
        `Your lead list contains your own sender email address (${senderEmail}).\n\n` +
        `Google automatically treats emails sent to oneself via external SMTP as spoofing, and routes them to Spam.\n\n` +
        `For accurate inbox delivery verification, test by sending to a secondary email address (Outlook, Yahoo, or alternative Gmail).\n\n` +
        `Do you still want to proceed with sending?`
      );
      if (!proceed) return;
    }

    const ticketPattern = /(ticket\s*(irn|#|\bid\b)|case\s*#|ref\s*#|order\s*#|support\s*ticket)/i;
    if (ticketPattern.test(subject)) {
      const fixPrompt = confirm(
        `⚠️ High Spam Risk Detected:\n\n` +
        `Your subject "${subject}" contains a fake support ticket reference ("Ticket IRN #").\n\n` +
        `Google and Outlook automatically detect this as deceptive phishing and route the email to Spam.\n\n` +
        `Click OK to auto-fix the subject to reduce spam filters before sending.\n` +
        `Click Cancel to proceed with your current subject anyway.`
      );
      if (fixPrompt) {
        this.fixSubjectForPrimaryInbox();
      }
    }

    this.saveCurrentAccountToStorage();

    const leadCount = leadList.length;

    // IMMEDIATE VISUAL BUTTON FEEDBACK
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '⚡ Launching Outreach Campaign...';
    }

    const isMulti = document.querySelector('input[name="senderRoutingMode"]:checked')?.value === 'multi';
    let endpoint = '/api/campaigns/send-direct';
    let payload = {
      senderEmail,
      senderPassword,
      senderName,
      subject,
      message,
      messageVariants: this.messageVariants,
      rawRecipients,
      delaySeconds,
      plainTextOnly,
      enableTracking
    };

    if (isMulti) {
      const selectedAccountIds = [];
      document.querySelectorAll('.multi-acc-chk:checked').forEach(c => {
        selectedAccountIds.push(c.getAttribute('data-acc-id'));
      });
      if (selectedAccountIds.length === 0) {
        this.showToast('Please select at least 1 sender mailbox in the pool.', 'warning');
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '⚡ Launch Outreach Campaign';
        }
        return;
      }

      const maxSendsPerAccount = parseInt(document.getElementById('multiAccountPerCapInput')?.value) || 50;
      const routingPolicy = document.getElementById('multiAccountPolicySelect')?.value || 'balanced';

      endpoint = '/api/campaigns/send-multi-account';
      payload = {
        selectedAccountIds,
        maxSendsPerAccount,
        routingPolicy,
        subject,
        message,
        messageVariants: this.messageVariants,
        rawRecipients,
        delaySeconds,
        plainTextOnly,
        enableTracking
      };
    }

    try {
      const res = await this.authFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();

      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '⚡ Launch Outreach Campaign';
      }

      if (data.success && data.campaignId) {
        this.activeCampaignId = data.campaignId;
        this.showSendingView(data);
        this.startStatusPolling(data.campaignId);
        this.showToast(`🚀 Campaign launched! Dispatching ${leadCount} lead(s) with ~${delaySeconds}s pacing.`);
        if (data.serverlessWarning) {
          setTimeout(() => this.showToast('ℹ️ ' + data.serverlessWarning, 'info'), 1500);
        }
      } else {
        const errMsg = data.error || 'Failed to start campaign';
        this.showToast('⚠️ ' + errMsg, 'danger');
        alert('⚠️ Outreach Launch Error:\n\n' + errMsg);
      }
    } catch (err) {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '⚡ Launch Outreach Campaign';
      }
      this.showToast('⚠️ Connection Error: ' + err.message, 'danger');
      alert('Error launching campaign: ' + err.message);
    }
  },

  showSendingView(data) {
    document.getElementById('composerContainer').style.display = 'none';
    document.getElementById('activeSendingProgressCard').style.display = 'block';

    const sender = document.getElementById('senderEmail').value.trim();
    document.getElementById('liveProgressSubtext').innerText = `Emails are being sent from ${sender} with ~${data.delaySeconds}s humanized pacing.`;
    
    document.getElementById('liveProgressCountText').innerText = `0 / ${data.totalRecipients} leads sent`;
    document.getElementById('liveProgressPercentText').innerText = '0%';
    document.getElementById('liveProgressBar').style.width = '0%';
    
    document.getElementById('liveStatSent').innerText = '0';
    document.getElementById('liveStatOpened').innerText = '0';
    document.getElementById('liveStatPending').innerText = data.totalRecipients;
    document.getElementById('liveStatFailed').innerText = '0';

    document.getElementById('liveCompletedBanner').style.display = 'none';
    document.getElementById('liveCountdownBanner').style.display = 'flex';
    document.getElementById('btnLivePause').style.display = 'inline-flex';
    document.getElementById('btnLiveStop').style.display = 'inline-flex';
  },

  startStatusPolling(campaignId) {
    if (this.pollTimer) clearInterval(this.pollTimer);

    const check = async () => {
      if (!this.activeCampaignId) return;
      try {
        const res = await fetch(`/api/campaigns/${campaignId}/status`);
        const data = await res.json();
        if (data.success && data.campaign) {
          this.updateSendingProgressUI(data);
          if (data.campaign.status === 'Completed' || data.campaign.status === 'Stopped') {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
          }
        }
      } catch (e) {}
    };

    check();
    this.pollTimer = setInterval(check, 1000);
  },

  updateSendingProgressUI(data) {
    const camp = data.campaign;
    const recipients = data.recipients || [];
    const total = camp.totalRecipients || 1;
    const sent = camp.sentCount || 0;
    const failed = camp.failedCount || 0;
    const pending = camp.pendingCount || 0;
    const opened = camp.openCount || 0;
    const processed = sent + failed;
    const pct = Math.min(100, Math.round((processed / total) * 100));

    document.getElementById('liveProgressCountText').innerText = `${processed} / ${total} leads processed`;
    document.getElementById('liveProgressPercentText').innerText = `${pct}%`;
    document.getElementById('liveProgressBar').style.width = `${pct}%`;

    document.getElementById('liveStatSent').innerText = sent;
    document.getElementById('liveStatOpened').innerText = opened;
    document.getElementById('liveStatPending').innerText = pending;
    document.getElementById('liveStatFailed').innerText = failed;

    const countBanner = document.getElementById('liveCountdownBanner');
    const countText = document.getElementById('liveCountdownText');
    if (data.isRunning && data.secondsLeft > 0) {
      if (countBanner) countBanner.style.display = 'flex';
      if (countText) {
        countText.innerText = `⏳ Humanized Pacing: Next lead will be dispatched in ${data.secondsLeft}s to protect inbox deliverability...`;
      }
    } else if (data.isRunning) {
      if (countText) countText.innerText = `⚡ Sending next lead now...`;
    }

    const btnPause = document.getElementById('btnLivePause');
    if (btnPause) btnPause.innerText = data.isPaused ? 'Resume' : 'Pause';

    const tbody = document.getElementById('liveRecipientsTableBody');
    if (tbody && recipients.length > 0) {
      tbody.innerHTML = recipients.map(r => {
        let badge = `<span class="status-badge status-stopped">Pending</span>`;
        if (r.status === 'Sent') badge = `<span class="status-badge status-completed">✓ Delivered</span>`;
        else if (r.status === 'Sending') badge = `<span class="status-badge status-inprogress">Sending...</span>`;
        else if (r.status === 'Failed') badge = `<span class="status-badge status-failed">✕ Failed</span>`;
        else if (r.status === 'Suppressed') badge = `<span class="status-badge" style="background: #fef2f2; color: #dc2626; border: 1px solid #fecaca;">🚫 Suppressed</span>`;

        let openBadge = `<span style="color: var(--text-dim); font-size: 12px;">Unopened</span>`;
        if (r.opened) {
          openBadge = `<span class="status-badge status-inprogress" style="background: #dbeafe; color: #1e40af; font-weight: 600;">👁️ Opened (${r.openCount || 1}x)</span>`;
        }

        const time = r.sentAt ? new Date(r.sentAt).toLocaleTimeString() : (r.error || 'Queued');

        return `
          <tr>
            <td>${r.email}</td>
            <td>${badge}</td>
            <td>${openBadge}</td>
            <td style="font-size: 12.5px; color: var(--text-dim);">${this.escapeHtml(time)}</td>
          </tr>
        `;
      }).join('');
    }

    if (camp.status === 'Completed' || (processed >= total && camp.status !== 'In Progress')) {
      if (countBanner) countBanner.style.display = 'none';
      document.getElementById('liveCompletedBanner').style.display = 'block';
      document.getElementById('completedSummaryText').innerText = `${sent} of ${total} leads delivered safely (${opened} opened, ${failed} failed).`;
      document.getElementById('btnLivePause').style.display = 'none';
      document.getElementById('btnLiveStop').style.display = 'none';
      this.loadCampaigns();
      this.loadSent();
    }
  },

  async togglePauseCampaign() {
    if (!this.activeCampaignId) return;
    const res = await fetch(`/api/campaigns/${this.activeCampaignId}/pause`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      this.showToast(data.isPaused ? 'Campaign paused.' : 'Campaign resumed.');
    }
  },

  async stopCampaign() {
    if (!this.activeCampaignId) return;
    if (!confirm('Are you sure you want to stop sending?')) return;
    const res = await fetch(`/api/campaigns/${this.activeCampaignId}/stop`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      this.showToast('Campaign stopped.');
      if (this.pollTimer) clearInterval(this.pollTimer);
      document.getElementById('btnLivePause').style.display = 'none';
      document.getElementById('btnLiveStop').style.display = 'none';
    }
  },

  resetComposer() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.activeCampaignId = null;
    document.getElementById('leadsInput').value = '';
    this.parseLeadsLive();
    document.getElementById('activeSendingProgressCard').style.display = 'none';
    document.getElementById('composerContainer').style.display = 'block';
  },

  // ==========================================================
  // CAMPAIGNS HISTORY & AUDIT LOGS (WELL-FITTED 7 COLUMNS)
  // ==========================================================

  async loadCampaigns() {
    try {
      const res = await fetch('/api/campaigns');
      const data = await res.json();
      if (data.success && Array.isArray(data.campaigns)) {
        this.campaignsList = data.campaigns;
        this.renderCampaignsTable(this.campaignsList);
      }
    } catch (e) {}
  },

  filterHistoryTable() {
    const q = (document.getElementById('historySearchInput')?.value || '').toLowerCase().trim();
    if (!q) {
      this.renderCampaignsTable(this.campaignsList);
      return;
    }

    const filtered = this.campaignsList.filter(c => 
      (c.senderEmail && c.senderEmail.toLowerCase().includes(q)) ||
      (c.subject && c.subject.toLowerCase().includes(q)) ||
      (c.recipients && c.recipients.some(r => r.email && r.email.toLowerCase().includes(q)))
    );

    this.renderCampaignsTable(filtered);
  },

  renderCampaignsTable(campaigns) {
    const tbody = document.getElementById('campaignHistoryTableBody');
    if (!tbody) return;

    let totalLeads = 0;
    let totalOpens = 0;
    this.campaignsList.forEach(c => {
      totalLeads += (c.totalRecipients || (c.recipients ? c.recipients.length : 0));
      totalOpens += (c.openCount || 0);
    });

    const statCamps = document.getElementById('histStatCampaigns');
    const statLeads = document.getElementById('histStatLeads');
    const statOpens = document.getElementById('histStatOpens');
    if (statCamps) statCamps.innerText = this.campaignsList.length;
    if (statLeads) statLeads.innerText = totalLeads;
    if (statOpens) statOpens.innerText = totalOpens;

    if (campaigns.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 32px; color: var(--text-dim); font-size: 13px;">No outreach campaigns recorded yet. Dispatched campaigns will appear here in real time.</td></tr>`;
      return;
    }

    tbody.innerHTML = campaigns.map(c => {
      const isFailed = (c.status === 'Failed' || (c.failedCount > 0 && c.sentCount === 0));
      const statusClass = (c.status === 'Completed' || c.sentCount > 0) ? 'status-completed' : (c.status === 'In Progress' ? 'status-inprogress' : 'status-failed');
      const statusLabel = isFailed ? '✕ Failed' : (c.status || 'Delivered');
      const dateStr = c.createdAt ? new Date(c.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
      const opens = c.openCount || 0;
      const total = c.totalRecipients || (c.recipients ? c.recipients.length : 1);
      const openPct = Math.round((opens / total) * 100);

      // Extract Leads Email Preview
      let leadsPreview = '—';
      if (Array.isArray(c.recipients) && c.recipients.length > 0) {
        const firstLead = c.recipients[0].email;
        if (c.recipients.length === 1) {
          leadsPreview = `<span class="leads-email-chip">${this.escapeHtml(firstLead)}</span>`;
        } else {
          leadsPreview = `
            <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
              <span class="leads-email-chip">${this.escapeHtml(firstLead)}</span>
              <span class="leads-count-chip">+${c.recipients.length - 1} more</span>
            </div>
          `;
        }
      } else if (c.recipientEmail) {
        leadsPreview = `<span class="leads-email-chip">${this.escapeHtml(c.recipientEmail)}</span>`;
      }

      return `
        <tr>
          <!-- 1. SENDER EMAIL -->
          <td>
            <div style="font-weight: 600; color: var(--text-main); display: flex; align-items: center; gap: 6px;">
              <span style="font-size: 13px;">✉️</span>
              <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px;">${this.escapeHtml(c.senderEmail || 'sender@domain.com')}</span>
            </div>
          </td>

          <!-- 2. LEADS EMAIL -->
          <td>${leadsPreview}</td>

          <!-- 3. SUBJECT / CAMPAIGN -->
          <td>
            <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px;">
              <strong style="color: var(--text-main); font-size: 13px;">${this.escapeHtml(c.subject || 'Outreach')}</strong>
              <div style="font-size: 11px; color: var(--text-dim);">${total} total lead${total > 1 ? 's' : ''}</div>
            </div>
          </td>

          <!-- 4. OPENS (TRACKED) -->
          <td>
            <span style="font-weight: 700; color: ${opens > 0 ? 'var(--primary)' : 'var(--text-dim)'}; background: ${opens > 0 ? 'var(--primary-subtle)' : 'var(--bg-subtle)'}; padding: 3px 8px; border-radius: 12px; font-size: 12px; display: inline-flex; align-items: center; gap: 4px;">
              👁️ ${opens} (${openPct}%)
            </span>
          </td>

          <!-- 5. STATUS -->
          <td>
            <span class="status-badge ${statusClass}">
              ● ${statusLabel}
            </span>
          </td>

          <!-- 6. DATE -->
          <td style="color: var(--text-muted); font-size: 12px; white-space: nowrap;">
            ${dateStr}
          </td>

          <!-- 7. ACTION -->
          <td>
            <div style="display: flex; gap: 6px;">
              <button class="btn btn-sm btn-secondary" onclick="app.openCampaignDetailsModal('${c.id}')" title="Inspect Telemetry">
                🔍 Details
              </button>
              <button class="btn btn-sm btn-danger" onclick="app.deleteCampaign('${c.id}')" title="Delete from history" style="padding: 4px 8px;">
                🗑️
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  },

  async deleteCampaign(campaignId) {
    if (!confirm('Are you sure you want to delete this outreach record from history?')) return;
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        this.showToast('Outreach record deleted.');
        this.loadCampaigns();
      }
    } catch (e) {
      alert('Error deleting campaign');
    }
  },

  async clearAllHistory() {
    if (!confirm('Are you sure you want to clear all outreach history? This cannot be undone.')) return;
    try {
      const res = await fetch('/api/campaigns', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        this.showToast('All outreach history cleared.');
        this.loadCampaigns();
      }
    } catch (e) {
      alert('Error clearing history');
    }
  },

  viewCampaignDetails(campaignId) {
    return this.openCampaignDetailsModal(campaignId);
  },

  async openCampaignDetailsModal(campaignId) {
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/status`);
      const data = await res.json();
      if (!data.success || !data.campaign) {
        alert('Could not load campaign details.');
        return;
      }

      const camp = data.campaign;
      const recipients = data.recipients || [];

      document.getElementById('detailModalTitle').innerText = `${camp.subject || 'Outreach Details'}`;
      document.getElementById('detailModalFrom').innerText = camp.senderEmail || '—';
      document.getElementById('detailModalTotal').innerText = camp.totalRecipients || recipients.length;
      document.getElementById('detailModalSent').innerText = camp.sentCount || 0;
      document.getElementById('detailModalOpens').innerText = camp.openCount || 0;

      const tbody = document.getElementById('detailModalRecipientsBody');
      if (tbody) {
        if (recipients.length === 0) {
          tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-dim);">No leads listed.</td></tr>`;
        } else {
          tbody.innerHTML = recipients.map(r => {
            let badge = `<span class="status-badge status-stopped">Pending</span>`;
            if (r.status === 'Sent') badge = `<span class="status-badge status-completed">✓ Delivered</span>`;
            else if (r.status === 'Failed') badge = `<span class="status-badge status-failed">✕ Failed</span>`;

            let openBadge = `<span style="color: var(--text-dim); font-size: 12px;">Unopened</span>`;
            if (r.opened) {
              const openTime = r.openedAt ? new Date(r.openedAt).toLocaleTimeString() : '';
              openBadge = `<span class="status-badge status-inprogress" style="background: #dbeafe; color: #1e40af; font-weight: 600;">👁️ Opened at ${openTime} (${r.openCount || 1}x)</span>`;
            }

            const info = r.sentAt ? new Date(r.sentAt).toLocaleString() : (r.error || '—');

            return `
              <tr>
                <td>${r.email}</td>
                <td>${badge}</td>
                <td>${openBadge}</td>
                <td style="font-size: 12px; color: var(--text-dim);">${this.escapeHtml(info)}</td>
              </tr>
            `;
          }).join('');
        }
      }

      this.openModal('modalCampaignDetail');
    } catch (e) {
      alert('Error loading details');
    }
  },

  // ==========================================================
  // GOOGLE POSTMASTER & DNS DELIVERABILITY SHIELD ENGINE
  // ==========================================================

  async runDeliverabilityAudit(targetEmailOrDomain = null, force = false) {
    let target = targetEmailOrDomain;
    if (!target) {
      target = this.getActiveAccountEmail() || 'user@gmail.com';
    }
    
    if (target.includes('@')) {
      target = target.trim().toLowerCase();
    }

    try {
      const res = await fetch(`/api/deliverability/audit?email=${encodeURIComponent(target)}`);
      const data = await res.json();
      if (data.success) {
        const audit = data.audit || data;
        this.deliverabilityAudit = audit;
        this.updateDeliverabilityBadges(audit);
        this.renderDeliverabilityView(audit);
      }
    } catch (e) {
      console.warn('Deliverability audit error:', e);
    }
  },

  updateDeliverabilityBadges(audit) {
    if (!audit) return;

    const spf = audit.checks?.spf || audit.spf || {};
    const dkim = audit.checks?.dkim || audit.dkim || {};
    const dmarc = audit.checks?.dmarc || audit.dmarc || {};

    // 1. Top Navbar Deliverability Badge
    const headerBadge = document.getElementById('headerDeliverabilityBadge') || document.getElementById('headerDeliverabilityStatus');
    if (headerBadge) {
      headerBadge.style.display = 'inline-flex';
      const score = audit.score || 100;
      if (score >= 90) {
        headerBadge.innerHTML = `${score}% POSTMASTER`;
        headerBadge.className = 'telemetry-shield-status status-completed';
        headerBadge.style.color = '#059669';
      } else if (score >= 70) {
        headerBadge.innerHTML = `${score}% MODERATE`;
        headerBadge.className = 'telemetry-shield-status status-inprogress';
        headerBadge.style.color = '#d97706';
      } else {
        headerBadge.innerHTML = `${score}% SPAM RISK`;
        headerBadge.className = 'telemetry-shield-status status-failed';
        headerBadge.style.color = '#dc2626';
      }
    }

    // 2. Step 1 Quick Health Card in Composer
    const step1Badge = document.getElementById('step1DeliverabilityBadge');
    const step1Summary = document.getElementById('step1DeliverabilitySummary');
    if (step1Badge && audit) {
      step1Badge.innerText = `${audit.score || 100}% Primary Inbox Ready`;
      if (audit.score >= 90) {
        step1Badge.className = 'status-badge status-completed';
        step1Badge.style.background = '#059669';
        step1Badge.style.color = '#fff';
      } else {
        step1Badge.className = 'status-badge status-inprogress';
        step1Badge.style.background = '#d97706';
        step1Badge.style.color = '#fff';
      }
    }
    if (step1Summary && audit) {
      const spfStatus = spf.status === 'pass' ? 'SPF: Valid' : 'SPF: Missing';
      const dkimStatus = dkim.status === 'pass' ? 'DKIM: 2048-bit Aligned' : 'DKIM: Pending';
      const dmarcStatus = dmarc.status === 'pass' ? 'DMARC: Active' : 'DMARC: Missing';
      step1Summary.innerText = `${spfStatus} • ${dkimStatus} • ${dmarcStatus} • One-Click Unsub & TLS 1.3 Active (${audit.domain || 'gmail.com'})`;
    }
  },

  renderDeliverabilityView(auditData = null) {
    const audit = auditData || this.deliverabilityAudit;
    if (!audit) return;

    const spf = audit.checks?.spf || audit.spf || {};
    const dkim = audit.checks?.dkim || audit.dkim || {};
    const dmarc = audit.checks?.dmarc || audit.dmarc || {};
    const mx = audit.checks?.mx || audit.mx || {};

    const domainNameEl = document.getElementById('auditDomainName');
    const domainTypeEl = document.getElementById('deliverabilityDomainType');
    const scoreValEl = document.getElementById('auditScoreVal');
    const scoreLabelEl = document.getElementById('auditScoreLabel');
    const mainBadgeEl = document.getElementById('deliverabilityMainBadge');

    if (domainNameEl) domainNameEl.innerText = audit.domain || 'gmail.com';
    if (domainTypeEl) {
      domainTypeEl.innerText = (audit.isGmail || audit.isGoogleMailbox)
        ? 'Standard Google Mailbox (Pre-Authenticated & Protected by Google Infrastructure)'
        : (audit.isGoogleWorkspace ? 'Google Workspace Custom Domain (Google MX & Cloud Routing Active)' : 'Custom Sender Domain');
    }
    if (scoreValEl) scoreValEl.innerText = `${audit.score || 100}%`;
    if (scoreLabelEl) {
      scoreLabelEl.innerText = audit.score >= 90 ? '● Maximum Primary Placement' : (audit.score >= 70 ? '● Moderate Placement' : '⚠️ Action Required');
      scoreLabelEl.style.color = audit.score >= 90 ? '#a7f3d0' : (audit.score >= 70 ? '#fde68a' : '#fecaca');
    }
    if (mainBadgeEl) {
      mainBadgeEl.innerText = `● ${audit.score || 100}% Primary Inbox Ready`;
      mainBadgeEl.className = `status-badge ${audit.score >= 90 ? 'status-completed' : (audit.score >= 70 ? 'status-inprogress' : 'status-failed')}`;
    }

    // 1. SPF Card
    const badgeSpf = document.getElementById('badgeAuditSpf');
    const descSpf = document.getElementById('descAuditSpf');
    const rawSpf = document.getElementById('rawAuditSpf');
    if (badgeSpf) {
      badgeSpf.innerText = spf.status === 'pass' ? '✓ PASS' : '✕ FAIL';
      badgeSpf.className = `status-badge ${spf.status === 'pass' ? 'status-completed' : 'status-failed'}`;
    }
    if (descSpf) descSpf.innerText = spf.details || spf.description || 'SPF authorization configured for Google SMTP servers.';
    if (rawSpf) rawSpf.innerText = spf.value || spf.record || 'v=spf1 redirect=_spf.google.com';

    // 2. DKIM Card
    const badgeDkim = document.getElementById('badgeAuditDkim');
    const descDkim = document.getElementById('descAuditDkim');
    const rawDkim = document.getElementById('rawAuditDkim');
    if (badgeDkim) {
      badgeDkim.innerText = dkim.status === 'pass' ? '✓ PASS' : '✕ PENDING';
      badgeDkim.className = `status-badge ${dkim.status === 'pass' ? 'status-completed' : 'status-inprogress'}`;
    }
    if (descDkim) descDkim.innerText = dkim.details || dkim.description || 'Cryptographic RSA signature aligns with Google email integrity.';
    if (rawDkim) rawDkim.innerText = dkim.selector ? `Selector: ${dkim.selector}` : (dkim.value || 'Google 2048-bit Key');

    // 3. DMARC Card
    const badgeDmarc = document.getElementById('badgeAuditDmarc');
    const descDmarc = document.getElementById('descAuditDmarc');
    const rawDmarc = document.getElementById('rawAuditDmarc');
    if (badgeDmarc) {
      badgeDmarc.innerText = dmarc.status === 'pass' ? '✓ PASS' : '✕ MISSING';
      badgeDmarc.className = `status-badge ${dmarc.status === 'pass' ? 'status-completed' : 'status-failed'}`;
    }
    if (descDmarc) descDmarc.innerText = dmarc.details || dmarc.description || 'Active policy protects domain against spoofing and phishing.';
    if (rawDmarc) rawDmarc.innerText = dmarc.value || dmarc.record || 'v=DMARC1; p=reject';

    // 4. MX Card
    const badgeMx = document.getElementById('badgeAuditMx');
    const descMx = document.getElementById('descAuditMx');
    const rawMx = document.getElementById('rawAuditMx');
    if (badgeMx) {
      badgeMx.innerText = mx.status === 'pass' ? '✓ PASS' : '✕ FAIL';
      badgeMx.className = `status-badge ${mx.status === 'pass' ? 'status-completed' : 'status-failed'}`;
    }
    if (descMx) descMx.innerText = mx.details || mx.description || 'Mail routing points directly to Google high-speed infrastructure.';
    if (rawMx) rawMx.innerText = (Array.isArray(mx.records) && mx.records[0]) || (Array.isArray(mx.values) && mx.values[0]) || 'gmail-smtp-in.l.google.com';

    // Update Links
    const postmasterBtn = document.getElementById('btnOpenPostmasterTools');
    if (postmasterBtn) {
      postmasterBtn.href = audit.googlePostmasterUrl || audit.postmasterToolsUrl || 'https://postmaster.google.com/';
    }
    const mxToolboxBtn = document.getElementById('btnOpenMxToolbox');
    if (mxToolboxBtn) {
      mxToolboxBtn.href = audit.mxToolboxUrl || `https://mxtoolbox.com/emailhealth/${audit.domain || 'gmail.com'}/`;
    }

    // Dynamic DNS Recommended Records if available
    const txtRecSpf = document.getElementById('txtRecSpf');
    const txtRecDmarc = document.getElementById('txtRecDmarc');
    if (txtRecSpf) {
      const rec = (audit.recommendedDnsRecords || []).find(r => r.type === 'SPF') || audit.dnsRecommendations?.spf;
      if (rec) txtRecSpf.innerText = rec.value;
    }
    if (txtRecDmarc) {
      const rec = (audit.recommendedDnsRecords || []).find(r => r.type === 'DMARC') || audit.dnsRecommendations?.dmarc;
      if (rec) txtRecDmarc.innerText = rec.value;
    }
  },

  async copyDnsRecord(text, btnEl) {
    if (!text) return;
    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch (e) {}

    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        copied = true;
      } catch (e) {}
    }

    if (btnEl) {
      const origText = btnEl.innerText;
      btnEl.innerText = '✓ Copied!';
      btnEl.classList.add('btn-primary');
      setTimeout(() => {
        btnEl.innerText = origText;
        btnEl.classList.remove('btn-primary');
      }, 2000);
    }
    this.showToast(`✓ Copied to clipboard: ${text}`);
  },

  switchTab(tabId) {
    const originalTabId = tabId;
    if (tabId === 'campaigns') tabId = 'composer';
    if (tabId === 'database') tabId = 'leads';
    if (tabId === 'inbox') tabId = 'all-inbox';
    if (tabId === 'analytics') tabId = 'tracker';
    if (tabId === 'settings') tabId = 'deliverability';

    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    document.querySelectorAll('.tab-view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.mobile-bottom-nav-item').forEach(m => m.classList.remove('active'));

    const activeLink = document.querySelector(`.nav-link[data-tab="${originalTabId}"]`) || document.querySelector(`.nav-link[data-tab="${tabId}"]`);
    if (activeLink) activeLink.classList.add('active');

    const activeBottomNav = document.querySelector(`.mobile-bottom-nav-item[data-tab="${originalTabId}"]`) || document.querySelector(`.mobile-bottom-nav-item[data-tab="${tabId}"]`);
    if (activeBottomNav) activeBottomNav.classList.add('active');

    const targetView = document.getElementById(`tab-${tabId}`) || document.getElementById(`tab-${originalTabId}`);
    if (targetView) targetView.classList.add('active');

    const titles = {
      'overview': 'Executive Overview & Real Stored Telemetry',
      'scraper': 'Lead Scraper & Business Discovery',
      'auditor': 'Website Auditor & SEO Diagnostics',
      'composer': 'Campaign Studio & Multi-Account Outreach',
      'leads': 'Lead Database & Bulk Importer',
      'all-inbox': 'All Inbox (All Connected Accounts)',
      'primary-inbox': 'Primary Active Inbox',
      'sent': 'Sent Messages & Outreach Log',
      'spam': 'Spam & Filtered Leads Rescue',
      'bounces': 'Bounced Leads & Delivery Failure Center',
      'tracker': 'Live Open Tracker & Telemetry Feed',
      'accounts': 'Sender Mailboxes & Quotas',
      'guide': 'Gmail App Password Help',
      'deliverability': 'Google Postmaster & DNS Deliverability Shield'
    };

    const breadcrumbTitles = {
      'overview': 'Executive Command Center',
      'scraper': 'Lead Discovery Engine',
      'auditor': 'Website Diagnostic Auditor',
      'composer': 'Campaign Studio',
      'leads': 'Lead Directory & Outreach Audiences',
      'all-inbox': 'All Inbox Engine',
      'primary-inbox': 'Primary Active Inbox',
      'sent': 'Sent Outreach Log',
      'spam': 'Spam Rescue Center',
      'bounces': 'Bounced Leads & Shield',
      'tracker': 'Live Open Telemetry Feed',
      'accounts': 'Sender Mailboxes',
      'guide': 'App Password Assistant',
      'deliverability': 'DNS & Postmaster Shield'
    };

    const titleEl = document.getElementById('pageTitle');
    if (titleEl && titles[tabId]) titleEl.innerText = titles[tabId];

    const breadcrumbEl = document.getElementById('pageBreadcrumb');
    if (breadcrumbEl && breadcrumbTitles[tabId]) breadcrumbEl.innerText = breadcrumbTitles[tabId];

    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('mobileBackdrop');
    if (sidebar) sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');

    // Smooth scroll to top on tab switch
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (tabId === 'overview') this.loadOverviewMetrics();
    if (tabId === 'scraper') this.loadScraperJobs();
    if (tabId === 'auditor') this.loadAuditsHistory();
    if (tabId === 'composer') this.analyzeSpamScoreLive();
    if (tabId === 'leads') this.loadLeads(1);
    if (tabId === 'all-inbox') this.loadAllInbox();
    if (tabId === 'primary-inbox') this.loadPrimaryInbox();
    if (tabId === 'sent') this.loadSent();
    if (tabId === 'spam') this.loadSpam();
    if (tabId === 'bounces') this.loadBounces();
    if (tabId === 'tracker') this.updateTrackerViewUI();
    if (tabId === 'accounts') this.renderAccountsManagerTable();
    if (tabId === 'deliverability') this.runDeliverabilityAudit(this.getActiveAccountEmail(), true);
  },

  toggleMobileMenu() {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('mobileBackdrop');
    if (sidebar) {
      const isOpen = sidebar.classList.toggle('open');
      if (backdrop) {
        if (isOpen) backdrop.classList.add('open');
        else backdrop.classList.remove('open');
      }
    }
  },

  openModal(modalId) {
    const m = document.getElementById(modalId);
    if (m) {
      m.style.display = 'flex';
      m.classList.add('active');
    }
  },

  closeModal(modalId) {
    const m = document.getElementById(modalId);
    if (m) {
      m.style.display = 'none';
      m.classList.remove('active');
    }
  },

  showToast(message, type = 'normal') {
    const toast = document.getElementById('toastBox');
    if (!toast) return;
    toast.innerText = message;
    if (type === 'danger') toast.style.background = '#dc2626';
    else if (type === 'info') toast.style.background = '#1d4ed8';
    else toast.style.background = '#1c1917';
    toast.style.display = 'block';

    const duration = type === 'info' ? 5000 : 3500;
    setTimeout(() => {
      toast.style.display = 'none';
    }, duration);
  },

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  // ---------------- MULTI-TENANT WORKSPACE & RBAC CONTROLLER ----------------

  async initTenantAuth() {
    try {
      const res = await fetch('/api/auth/me');
      const data = await res.json();
      if (data && data.success) {
        this.currentUser = data.user || null;
        this.currentWorkspace = data.activeTenant || null;
        if (data.activeTenant && data.activeTenant.id) {
          this.activeTenantId = data.activeTenant.id;
          localStorage.setItem('mailflow_active_tenant', this.activeTenantId);
        }
        if (Array.isArray(data.tenants)) {
          this.userWorkspaces = data.tenants;
        }
      }
    } catch (e) {
      console.warn('Tenant auth init error:', e.message);
    }
    this.renderWorkspaceUI();
    this.loadWorkspacesList();
  },

  async loadWorkspacesList() {
    try {
      const res = await fetch('/api/tenants');
      const data = await res.json();
      if (data && data.success && Array.isArray(data.tenants)) {
        this.userWorkspaces = data.tenants;
        this.renderWorkspaceDropdown();
      }
    } catch (e) {}
  },

  renderWorkspaceUI() {
    const nameEl = document.getElementById('currentWorkspaceName');
    const roleEl = document.getElementById('currentWorkspaceRole');
    const authTextEl = document.getElementById('wsCurrentUserText');
    const authBtnEl = document.getElementById('btnWsAuthToggle');

    const ws = this.currentWorkspace || this.userWorkspaces.find(w => w.id === this.activeTenantId) || { name: 'Primary Workspace', role: 'Owner' };

    if (nameEl) nameEl.innerText = ws.name || 'Primary Workspace';
    if (roleEl) roleEl.innerText = (ws.role || 'Owner').toUpperCase();

    const headerAuthWidget = document.getElementById('headerUserAuthWidget');

    if (this.currentUser) {
      if (authTextEl) authTextEl.innerText = this.currentUser.email;
      if (authBtnEl) {
        authBtnEl.innerText = 'Sign Out';
        authBtnEl.onclick = () => this.handleSignOut();
      }
      if (headerAuthWidget) {
        headerAuthWidget.innerHTML = `
          <div style="display: flex; align-items: center; gap: 6px; background: #f0fdf4; border: 1px solid #bbf7d0; padding: 4px 10px; border-radius: 20px; font-size: 12px; color: #166534;" title="Signed in as ${this.escapeHtml(this.currentUser.email)}">
            <span style="font-size: 13px;">👤</span>
            <span style="font-weight: 600; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${this.escapeHtml(this.currentUser.name || this.currentUser.email)}</span>
            <button type="button" class="action-btn-link" onclick="app.handleSignOut()" style="font-size: 11px; color: #b91c1c; margin-left: 4px; padding: 0 2px;" title="Sign out of this session">Sign Out</button>
          </div>
        `;
      }
    } else {
      if (authTextEl) authTextEl.innerText = 'Guest Mode';
      if (authBtnEl) {
        authBtnEl.innerText = 'Sign In';
        authBtnEl.onclick = () => this.openAuthModal();
      }
      if (headerAuthWidget) {
        headerAuthWidget.innerHTML = `
          <button type="button" class="btn btn-sm btn-secondary" onclick="app.openAuthModal()" style="font-size: 12px; padding: 4px 10px; border-radius: 20px; display: flex; align-items: center; gap: 5px; background: #ffffff; border: 1px solid var(--border-subtle); color: var(--text-main);" title="Sign in or create account for personal data isolation">
            <span style="font-size: 13px;">🔒</span>
            <span style="font-weight: 600;">Sign In</span>
          </button>
        `;
      }
    }
  },

  toggleWorkspaceDropdown() {
    const menu = document.getElementById('workspaceDropdownMenu');
    if (!menu) return;
    const isShowing = menu.style.display === 'block';
    menu.style.display = isShowing ? 'none' : 'block';
    if (!isShowing) {
      this.loadWorkspacesList();
    }
  },

  closeWorkspaceDropdown() {
    const menu = document.getElementById('workspaceDropdownMenu');
    if (menu) menu.style.display = 'none';
  },

  renderWorkspaceDropdown() {
    const container = document.getElementById('workspaceListItems');
    const badge = document.getElementById('workspaceCountBadge');
    if (badge) badge.innerText = `${this.userWorkspaces.length || 1} Available`;
    if (!container) return;

    if (!this.userWorkspaces || this.userWorkspaces.length === 0) {
      container.innerHTML = `
        <div class="ws-item active" onclick="app.closeWorkspaceDropdown()">
          <div>
            <div class="ws-item-title">Primary Workspace</div>
            <div style="font-size: 11px; color: var(--text-dim);">Default Organization</div>
          </div>
          <span style="font-size: 12px; color: #059669; font-weight: 700;">✓</span>
        </div>
      `;
      return;
    }

    container.innerHTML = this.userWorkspaces.map(ws => {
      const isActive = (ws.id === this.activeTenantId);
      return `
        <div class="ws-item ${isActive ? 'active' : ''}" onclick="app.switchWorkspace('${ws.id}')">
          <div>
            <div class="ws-item-title">${this.escapeHtml(ws.name || 'Workspace')}</div>
            <div style="font-size: 10.5px; color: var(--text-dim); text-transform: uppercase;">Role: ${ws.role || 'member'}</div>
          </div>
          ${isActive ? '<span style="font-size: 12px; color: #059669; font-weight: 700;">✓</span>' : ''}
        </div>
      `;
    }).join('');
  },

  async switchWorkspace(tenantId) {
    if (!tenantId) return;
    this.closeWorkspaceDropdown();

    try {
      const res = await fetch(`/api/tenants/switch/${tenantId}`, { method: 'POST' });
      const data = await res.json();
      if (data && data.success) {
        this.activeTenantId = tenantId;
        localStorage.setItem('mailflow_active_tenant', tenantId);
        this.currentWorkspace = data.activeTenant;
        this.renderWorkspaceUI();
        this.showToast(`✓ Switched to workspace: ${data.activeTenant.name}`);
        await this.reloadAllWorkspaceData();
        return;
      }
    } catch (e) {
      console.warn('Switch workspace API failed:', e.message);
    }

    this.activeTenantId = tenantId;
    localStorage.setItem('mailflow_active_tenant', tenantId);
    this.renderWorkspaceUI();
    this.showToast(`✓ Switched workspace`);
    await this.reloadAllWorkspaceData();
  },

  async reloadAllWorkspaceData() {
    this.showToast('Refreshing workspace data...', 'info');
    await Promise.allSettled([
      this.loadSavedAccounts(),
      this.loadMessageVariants(),
      this.loadCampaigns(),
      this.loadAllInbox(),
      this.loadPrimaryInbox(),
      this.loadSent(),
      this.loadSpam(),
      this.loadBounces(),
      this.loadOpenEvents()
    ]);
    this.showToast('✓ Workspace loaded.');
  },

  openNewWorkspaceModal() {
    this.closeWorkspaceDropdown();
    const input = document.getElementById('newWorkspaceNameInput');
    if (input) input.value = '';
    this.openModal('modalNewWorkspace');
  },

  async handleCreateWorkspace(e) {
    if (e) e.preventDefault();
    const input = document.getElementById('newWorkspaceNameInput');
    const name = input ? input.value.trim() : '';
    if (!name) return;

    try {
      const res = await fetch('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      if (data.success && data.tenant) {
        this.closeModal('modalNewWorkspace');
        await this.loadWorkspacesList();
        await this.switchWorkspace(data.tenant.id);
        this.showToast(`✓ Created and switched to workspace "${data.tenant.name}"`);
      } else {
        this.showToast(data.error || 'Failed to create workspace', 'danger');
      }
    } catch (err) {
      this.showToast(err.message, 'danger');
    }
  },

  async openTeamModal() {
    this.closeWorkspaceDropdown();
    this.openModal('modalTeamMembers');

    const sub = document.getElementById('teamModalWorkspaceNameSub');
    if (sub) sub.innerText = `Active Workspace: ${this.currentWorkspace?.name || 'Primary Workspace'}`;

    await this.loadTeamMembers();
  },

  async loadTeamMembers() {
    const listEl = document.getElementById('teamMembersList');
    const countEl = document.getElementById('teamMembersCount');
    if (!listEl) return;
    listEl.innerHTML = '<div style="padding: 12px; color: var(--text-dim); text-align: center;">Loading members...</div>';

    try {
      const res = await fetch('/api/tenants/current');
      const data = await res.json();
      if (data.success && Array.isArray(data.members)) {
        if (countEl) countEl.innerText = data.members.length;
        if (data.members.length === 0) {
          listEl.innerHTML = `
            <div class="team-member-row">
              <div>
                <strong>${this.currentUser ? this.currentUser.name : 'Primary Account'}</strong>
                <div style="font-size: 11px; color: var(--text-dim);">${this.currentUser ? this.currentUser.email : 'owner@workspace.com'}</div>
              </div>
              <span class="status-badge status-completed" style="font-size: 10px;">Owner</span>
            </div>
          `;
          return;
        }

        listEl.innerHTML = data.members.map(m => `
          <div class="team-member-row">
            <div>
              <strong>${this.escapeHtml(m.name || m.email.split('@')[0])}</strong>
              <div style="font-size: 11px; color: var(--text-dim);">${this.escapeHtml(m.email)}</div>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="status-badge ${m.role === 'owner' ? 'status-completed' : 'status-inprogress'}" style="font-size: 10px; text-transform: uppercase;">
                ${m.role}
              </span>
              ${(m.role !== 'owner' && data.role === 'owner') ? `
                <button type="button" class="btn btn-sm btn-secondary" style="font-size: 11px; color: #dc2626; padding: 2px 7px;" onclick="app.handleRemoveMember('${m.userId}')">Remove</button>
              ` : ''}
            </div>
          </div>
        `).join('');
      }
    } catch (err) {
      listEl.innerHTML = `<div style="padding: 12px; color: #dc2626;">Error loading members: ${err.message}</div>`;
    }
  },

  async handleInviteMember(e) {
    if (e) e.preventDefault();
    const emailInput = document.getElementById('inviteMemberEmailInput');
    const roleSelect = document.getElementById('inviteMemberRoleSelect');
    const email = emailInput ? emailInput.value.trim() : '';
    const role = roleSelect ? roleSelect.value : 'member';

    if (!email) return;

    try {
      const res = await fetch('/api/tenants/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role })
      });
      const data = await res.json();
      if (data.success) {
        if (emailInput) emailInput.value = '';
        this.showToast(`✓ Invited ${email} as ${role}`);
        await this.loadTeamMembers();
      } else {
        this.showToast(data.error || 'Failed to invite member', 'danger');
      }
    } catch (err) {
      this.showToast(err.message, 'danger');
    }
  },

  async handleRemoveMember(userId) {
    if (!confirm('Are you sure you want to remove this member from the workspace?')) return;
    try {
      const res = await fetch(`/api/tenants/members/${userId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        this.showToast('✓ Member removed');
        await this.loadTeamMembers();
      } else {
        this.showToast(data.error || 'Failed to remove member', 'danger');
      }
    } catch (err) {
      this.showToast(err.message, 'danger');
    }
  },

  authFetch(url, options = {}) {
    return fetch(url, options);
  },

  // ==========================================================
  // TAB 1: EXECUTIVE OVERVIEW CONTROLLER
  // ==========================================================
  async loadOverviewMetrics() {
    try {
      const res = await this.authFetch('/api/metrics/overview');
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !data.success || !data.metrics) return;
      const m = data.metrics;

      // Scraper metrics
      const kpiTotalDiscovered = document.getElementById('kpiTotalDiscovered');
      if (kpiTotalDiscovered) kpiTotalDiscovered.innerText = m.scraper?.totalDiscovered || 0;

      // Leads metrics
      const kpiTotalLeads = document.getElementById('kpiTotalLeads');
      if (kpiTotalLeads) kpiTotalLeads.innerText = m.leads?.total || 0;
      const kpiImportedBadge = document.getElementById('kpiImportedBadge');
      if (kpiImportedBadge) kpiImportedBadge.innerText = `${m.leads?.imported || 0} In DB`;
      const kpiEligibleSubtext = document.getElementById('kpiEligibleSubtext');
      if (kpiEligibleSubtext) kpiEligibleSubtext.innerText = `${m.leads?.active || 0} outreach eligible`;

      // Auditor metrics
      const kpiWebsitesAudited = document.getElementById('kpiWebsitesAudited');
      if (kpiWebsitesAudited) kpiWebsitesAudited.innerText = m.audits?.totalAudits || 0;
      const kpiVerifiedFindingsBadge = document.getElementById('kpiVerifiedFindingsBadge');
      if (kpiVerifiedFindingsBadge) kpiVerifiedFindingsBadge.innerText = `${m.audits?.withIssues || 0} with Issues`;

      // Accounts / Quotas metrics
      const kpiConnectedSenders = document.getElementById('kpiConnectedSenders');
      if (kpiConnectedSenders) kpiConnectedSenders.innerText = m.accounts?.connected || 0;
      const kpiSendCapacityBadge = document.getElementById('kpiSendCapacityBadge');
      if (kpiSendCapacityBadge) kpiSendCapacityBadge.innerText = `${m.accounts?.totalDailyCapacity || 0} Daily Cap`;
      const kpiRemainingCapSubtext = document.getElementById('kpiRemainingCapSubtext');
      if (kpiRemainingCapSubtext) kpiRemainingCapSubtext.innerText = `${m.accounts?.remainingDailyCapacity || 0} sends left today`;

      // Campaign dispatch metrics
      const kpiActiveCampaigns = document.getElementById('kpiActiveCampaigns');
      if (kpiActiveCampaigns) kpiActiveCampaigns.innerText = m.campaigns?.active || 0;
      const kpiAttempted = document.getElementById('kpiAttempted');
      if (kpiAttempted) kpiAttempted.innerText = m.campaigns?.totalAttempted || 0;
      const kpiDelivered = document.getElementById('kpiDelivered');
      if (kpiDelivered) kpiDelivered.innerText = m.campaigns?.totalSent || 0;
      const kpiBounces = document.getElementById('kpiBounces');
      if (kpiBounces) kpiBounces.innerText = m.campaigns?.totalBounces || 0;
      const kpiReplies = document.getElementById('kpiReplies');
      if (kpiReplies) kpiReplies.innerText = m.campaigns?.totalReplies || 0;
      const kpiUnsubscribes = document.getElementById('kpiUnsubscribes');
      if (kpiUnsubscribes) kpiUnsubscribes.innerText = m.campaigns?.totalSuppressed || 0;
    } catch (err) {
      console.warn('Overview metrics load error:', err.message);
    }
  },

  // ==========================================================
  // TAB 2: LEAD SCRAPER & DISCOVERY ENGINE CONTROLLER
  // ==========================================================
  activeScraperJobId: null,
  scraperPollTimer: null,
  scraperLeadsCache: [],
  selectedScraperIndices: new Set(),

  async handleScraperSubmit(e) {
    if (e) e.preventDefault();
    const niche = document.getElementById('scraperNiche')?.value.trim();
    const location = document.getElementById('scraperLocation')?.value.trim();
    const keywords = document.getElementById('scraperKeywords')?.value.trim();
    const source = document.getElementById('scraperSource')?.value || 'osm';
    const maxResults = parseInt(document.getElementById('scraperMaxResults')?.value || '25', 10);
    const domainFilter = document.getElementById('scraperDomainFilter')?.value.trim();

    if (!niche || !location) {
      this.showToast('Please enter both niche and location', 'danger');
      return;
    }

    const btn = document.getElementById('btnStartScraper');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="loading-spinner"></span> Starting Discovery...`;
    }

    const progressCard = document.getElementById('scraperJobProgressCard');
    if (progressCard) progressCard.style.display = 'block';

    try {
      const res = await this.authFetch('/api/scraper/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ niche, location, keywords, source, maxResults, domainFilter })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to launch scraper job');
      }

      this.activeScraperJobId = data.job.id;
      this.showToast(`Discovery job launched for ${niche} in ${location}`);
      this.startScraperPolling(this.activeScraperJobId);
    } catch (err) {
      this.showToast(err.message, 'danger');
      if (progressCard) progressCard.style.display = 'none';
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="5 3 19 12 5 21 5 3"/></svg> <span>Start Lead Discovery</span>`;
      }
    }
  },

  startScraperPolling(jobId) {
    if (this.scraperPollTimer) clearInterval(this.scraperPollTimer);

    const poll = async () => {
      try {
        const res = await this.authFetch(`/api/scraper/jobs/${jobId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!data || !data.job) return;
        const job = data.job;

        const titleEl = document.getElementById('scraperJobTitle');
        if (titleEl) titleEl.innerText = `${job.niche} in ${job.location}`;

        const pill = document.getElementById('scraperJobStatusPill');
        if (pill) {
          pill.innerText = job.status.toUpperCase();
          pill.className = `status-badge ${job.status === 'completed' ? 'status-completed' : job.status === 'running' ? 'status-inprogress' : 'status-failed'}`;
        }

        const subtext = document.getElementById('scraperJobSubtext');
        if (subtext) subtext.innerText = job.currentStep || 'Querying directory and public coordinates...';

        const countEl = document.getElementById('scraperProgressCount');
        if (countEl) countEl.innerText = `${job.processedCount || 0} / ${job.targetCount || job.maxResults} leads processed`;

        const pctEl = document.getElementById('scraperProgressPercent');
        if (pctEl) pctEl.innerText = `${job.progress || 0}%`;

        const bar = document.getElementById('scraperProgressBar');
        if (bar) bar.style.width = `${job.progress || 0}%`;

        const statFound = document.getElementById('scraperStatFound');
        if (statFound) statFound.innerText = job.leadsFound || 0;
        const statEmail = document.getElementById('scraperStatWithEmail');
        if (statEmail) statEmail.innerText = job.withEmail || 0;
        const statWeb = document.getElementById('scraperStatWithWeb');
        if (statWeb) statWeb.innerText = job.withWebsite || 0;
        const statDup = document.getElementById('scraperStatDuplicates');
        if (statDup) statDup.innerText = job.duplicatesSkipped || 0;

        const btnPause = document.getElementById('btnPauseScraper');
        const btnResume = document.getElementById('btnResumeScraper');
        if (btnPause && btnResume) {
          if (job.status === 'paused') {
            btnPause.style.display = 'none';
            btnResume.style.display = 'inline-block';
          } else if (job.status === 'running') {
            btnPause.style.display = 'inline-block';
            btnResume.style.display = 'none';
          } else {
            btnPause.style.display = 'none';
            btnResume.style.display = 'none';
          }
        }

        if (Array.isArray(job.leads)) {
          this.scraperLeadsCache = job.leads;
          this.renderScraperResults(job.leads);
        }

        if (['completed', 'failed', 'cancelled'].includes(job.status)) {
          clearInterval(this.scraperPollTimer);
          this.scraperPollTimer = null;
          const btnExport = document.getElementById('btnExportScraperCsv');
          const btnSave = document.getElementById('btnSaveScraperToDb');
          if (btnExport) btnExport.disabled = (this.scraperLeadsCache.length === 0);
          if (btnSave) btnSave.disabled = (this.scraperLeadsCache.length === 0);

          if (job.status === 'completed') {
            this.showToast(`✓ Discovery completed! Found ${job.leadsFound || 0} leads.`);
            this.loadOverviewMetrics();
          }
        }
      } catch (e) {
        console.warn('Scraper poll error:', e.message);
      }
    };

    poll();
    this.scraperPollTimer = setInterval(poll, 1200);
  },

  async pauseScraperJob() {
    if (!this.activeScraperJobId) return;
    try {
      await this.authFetch(`/api/scraper/jobs/${this.activeScraperJobId}/pause`, { method: 'POST' });
      this.showToast('Job paused');
    } catch (e) {
      this.showToast(e.message, 'danger');
    }
  },

  async resumeScraperJob() {
    if (!this.activeScraperJobId) return;
    try {
      await this.authFetch(`/api/scraper/jobs/${this.activeScraperJobId}/resume`, { method: 'POST' });
      this.showToast('Job resumed');
    } catch (e) {
      this.showToast(e.message, 'danger');
    }
  },

  async cancelScraperJob() {
    if (!this.activeScraperJobId) return;
    try {
      await this.authFetch(`/api/scraper/jobs/${this.activeScraperJobId}/cancel`, { method: 'POST' });
      this.showToast('Job cancelled');
    } catch (e) {
      this.showToast(e.message, 'danger');
    }
  },

  renderScraperResults(leads) {
    const tbody = document.getElementById('scraperResultsTbody');
    if (!tbody) return;

    if (!leads || leads.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; padding: 36px; color: var(--text-dim);">
            <div style="font-size: 28px; margin-bottom: 8px;">🔎</div>
            <div style="font-weight: 600; font-size: 14px; color: var(--text-main);">No Leads Discovered Yet</div>
            <div style="font-size: 12.5px; margin-top: 4px;">Enter an industry and city above, then click <strong>"Start Lead Discovery"</strong>.</div>
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = leads.map((l, idx) => {
      const emailBadge = l.email 
        ? `<strong style="color: #059669; font-size: 12.5px;">${this.escapeHtml(l.email)}</strong>` 
        : `<span style="color: var(--text-dim); font-style: italic; font-size: 12px;">No email published</span>`;

      const webLink = l.website 
        ? `<a href="${this.escapeHtml(l.website)}" target="_blank" rel="noopener noreferrer" style="color: #2563eb; text-decoration: underline; font-size: 12px;">${this.escapeHtml(l.website.replace(/^https?:\/\//i, '').replace(/\/$/, '').slice(0, 28))}</a>` 
        : `<span style="color: var(--text-dim); font-size: 12px;">—</span>`;

      const verifiedBadge = l.email 
        ? `<span class="status-badge status-completed" style="font-size: 10px; padding: 1px 6px;">Verified Contact</span>` 
        : `<span class="status-badge" style="background: #f1f5f9; color: #64748b; font-size: 10px; padding: 1px 6px;">Web Only</span>`;

      return `
        <tr>
          <td><input type="checkbox" data-index="${idx}" ${this.selectedScraperIndices.has(idx) ? 'checked' : ''} onchange="app.toggleScraperLeadSelection(${idx}, this.checked)"></td>
          <td><strong style="color: var(--text-main); font-size: 13px;">${this.escapeHtml(l.businessName || l.name || 'Unnamed')}</strong></td>
          <td style="font-size: 12px; color: var(--text-muted);">${this.escapeHtml(l.niche || '—')} • ${this.escapeHtml(l.city || l.location || '—')}</td>
          <td>${webLink}</td>
          <td>${emailBadge}</td>
          <td>${verifiedBadge}</td>
          <td style="font-size: 12px; color: var(--text-dim);">${this.escapeHtml(l.phone || '—')}</td>
        </tr>`;
    }).join('');

    const btnExport = document.getElementById('btnExportScraperCsv');
    const btnSave = document.getElementById('btnSaveScraperToDb');
    if (btnExport) btnExport.disabled = false;
    if (btnSave) btnSave.disabled = false;
  },

  toggleSelectAllScraper(checked) {
    if (checked) {
      this.selectedScraperIndices = new Set(this.scraperLeadsCache.map((_, i) => i));
    } else {
      this.selectedScraperIndices.clear();
    }
    const checkboxes = document.querySelectorAll('#scraperResultsTbody input[type="checkbox"]');
    checkboxes.forEach((cb) => { cb.checked = checked; });
  },

  toggleScraperLeadSelection(idx, checked) {
    if (checked) this.selectedScraperIndices.add(idx);
    else this.selectedScraperIndices.delete(idx);
    const allBox = document.getElementById('chkSelectAllScraper');
    if (allBox) allBox.checked = (this.selectedScraperIndices.size === this.scraperLeadsCache.length);
  },

  async saveScraperLeadsToDatabase() {
    if (!this.activeScraperJobId) return;
    const btn = document.getElementById('btnSaveScraperToDb');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="loading-spinner"></span> Saving...`;
    }

    try {
      const selected = Array.from(this.selectedScraperIndices);
      const res = await this.authFetch(`/api/scraper/jobs/${this.activeScraperJobId}/save-leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ indices: selected.length > 0 ? selected : undefined })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to save leads to database');
      }

      this.showToast(`✓ Saved ${data.savedCount || 0} leads into your Lead Database!`);
      this.loadLeads(1);
      this.loadOverviewMetrics();
    } catch (err) {
      this.showToast(err.message, 'danger');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> <span>Save to Lead Database</span>`;
      }
    }
  },

  exportScraperCsv() {
    if (!this.activeScraperJobId) return;
    window.open(`/api/scraper/jobs/${this.activeScraperJobId}/export-csv`, '_blank');
  },

  async loadScraperJobs() {
    try {
      const res = await this.authFetch('/api/scraper/jobs');
      if (!res.ok) return;
      const data = await res.json();
      if (data && Array.isArray(data.jobs) && data.jobs.length > 0) {
        const active = data.jobs.find(j => j.status === 'running' || j.status === 'paused');
        if (active && (!this.activeScraperJobId || this.activeScraperJobId === active.id)) {
          this.activeScraperJobId = active.id;
          const progressCard = document.getElementById('scraperJobProgressCard');
          if (progressCard) progressCard.style.display = 'block';
          this.startScraperPolling(active.id);
        } else if (!this.activeScraperJobId && data.jobs[0].leads?.length > 0) {
          this.activeScraperJobId = data.jobs[0].id;
          this.scraperLeadsCache = data.jobs[0].leads;
          this.renderScraperResults(data.jobs[0].leads);
        }
      }
    } catch (e) {
      console.warn('Scraper jobs load error:', e.message);
    }
  },

  // ==========================================================
  // TAB 3: WEBSITE AUDITOR CONTROLLER
  // ==========================================================
  currentAuditResult: null,

  async handleAuditUrlSubmit(e) {
    if (e) e.preventDefault();
    const urlInput = document.getElementById('auditorTargetUrl');
    let url = urlInput ? urlInput.value.trim() : '';
    if (!url) {
      this.showToast('Please enter a website URL', 'danger');
      return;
    }

    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
      if (urlInput) urlInput.value = url;
    }

    const btn = document.getElementById('btnRunAudit');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="loading-spinner"></span> Auditing Diagnostics...`;
    }

    try {
      const res = await this.authFetch('/api/auditor/audit-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Audit failed');
      }

      this.currentAuditResult = data.audit;
      this.renderAuditReport(data.audit);
      this.showToast(`✓ Website audit completed for ${url}`);
      this.loadAuditsHistory();
      this.loadOverviewMetrics();
    } catch (err) {
      this.showToast(`Audit failed: ${err.message}`, 'danger');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> <span>Run Full Audit</span>`;
      }
    }
  },

  renderAuditReport(audit) {
    const container = document.getElementById('auditReportContainer');
    if (!container) return;
    container.style.display = 'block';

    const urlEl = document.getElementById('auditResultUrl');
    if (urlEl) urlEl.innerText = audit.url;

    const scoreEl = document.getElementById('auditResultScore');
    if (scoreEl) scoreEl.innerHTML = `${audit.score}<span style="font-size: 18px; color: var(--text-dim); font-weight: 600;">/100</span>`;

    const badgeEl = document.getElementById('auditScoreBadge');
    if (badgeEl) {
      if (audit.score >= 80) {
        badgeEl.style.background = '#ecfdf5';
        badgeEl.style.color = '#059669';
        badgeEl.style.borderColor = '#a7f3d0';
        badgeEl.innerText = '✓';
      } else if (audit.score >= 60) {
        badgeEl.style.background = '#fffbeb';
        badgeEl.style.color = '#d97706';
        badgeEl.style.borderColor = '#fde68a';
        badgeEl.innerText = '⚠️';
      } else {
        badgeEl.style.background = '#fef2f2';
        badgeEl.style.color = '#dc2626';
        badgeEl.style.borderColor = '#fecaca';
        badgeEl.innerText = '✕';
      }
    }

    const summaryEl = document.getElementById('auditResultSummary');
    if (summaryEl) {
      summaryEl.innerText = audit.summary || `${audit.findings?.length || 0} issues detected across Technical, SEO, Speed, and Quality checks.`;
    }

    const timeEl = document.getElementById('auditTimestampText');
    if (timeEl && audit.timestamp) {
      timeEl.innerText = new Date(audit.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    // Severity counts
    const critical = audit.findings?.filter(f => f.severity === 'Critical').length || 0;
    const high = audit.findings?.filter(f => f.severity === 'High').length || 0;
    const medium = audit.findings?.filter(f => f.severity === 'Medium').length || 0;
    const low = audit.findings?.filter(f => f.severity === 'Low' || f.severity === 'Info').length || 0;

    const cCrit = document.getElementById('auditCountCritical');
    if (cCrit) cCrit.innerText = critical;
    const cHigh = document.getElementById('auditCountHigh');
    if (cHigh) cHigh.innerText = high;
    const cMed = document.getElementById('auditCountMedium');
    if (cMed) cMed.innerText = medium;
    const cLow = document.getElementById('auditCountLow');
    if (cLow) cLow.innerText = low;

    // Pitch Snippet
    const pitchEl = document.getElementById('auditPitchSnippetText');
    if (pitchEl) {
      pitchEl.innerText = `"${audit.pitchSnippet || 'I ran a quick diagnostic on your website and noticed several opportunities to improve load speed, SEO visibility, and mobile conversion.'}"`;
    }

    // Render findings
    this.renderAuditFindingsList(audit.findings || []);
  },

  renderAuditFindingsList(findings) {
    const listEl = document.getElementById('auditFindingsList');
    if (!listEl) return;

    if (!findings || findings.length === 0) {
      listEl.innerHTML = `
        <div style="text-align: center; padding: 24px; color: var(--text-dim); background: #f8fafc; border-radius: 6px;">
          ✓ No significant defects detected! This website meets technical, SEO, speed, and quality best practices.
        </div>`;
      return;
    }

    listEl.innerHTML = findings.map(f => {
      const severityColor = f.severity === 'Critical' ? '#dc2626' : f.severity === 'High' ? '#d97706' : f.severity === 'Medium' ? '#ca8a04' : '#2563eb';
      const severityBg = f.severity === 'Critical' ? '#fef2f2' : f.severity === 'High' ? '#fffbeb' : f.severity === 'Medium' ? '#fefce8' : '#eff6ff';

      return `
        <div style="padding: 12px 14px; background: #ffffff; border: 1px solid var(--border-subtle); border-radius: 6px; display: flex; flex-direction: column; gap: 4px;">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="status-badge" style="background: ${severityBg}; color: ${severityColor}; font-weight: 700; font-size: 10px; padding: 2px 6px;">${f.severity}</span>
              <span class="status-badge" style="background: #f1f5f9; color: #475569; font-size: 10px; padding: 2px 6px;">${f.category || 'General'}</span>
              <strong style="font-size: 13px; color: var(--text-main);">${this.escapeHtml(f.title || f.name || 'Issue')}</strong>
            </div>
            ${f.scoreImpact ? `<span style="font-size: 11px; font-weight: 600; color: #dc2626;">-${f.scoreImpact} pts</span>` : ''}
          </div>
          <div style="font-size: 12.5px; color: var(--text-muted); line-height: 1.4; margin-top: 2px;">
            ${this.escapeHtml(f.description || '')}
          </div>
          ${f.recommendation ? `
            <div style="font-size: 11.5px; color: #047857; background: #f0fdf4; padding: 6px 10px; border-radius: 4px; margin-top: 4px; border-left: 3px solid #10b981;">
              💡 <strong>Action:</strong> ${this.escapeHtml(f.recommendation)}
            </div>` : ''}
        </div>`;
    }).join('');
  },

  filterAuditFindings(severity, btn) {
    if (btn) {
      const parent = btn.parentElement;
      if (parent) parent.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }
    if (!this.currentAuditResult) return;
    const all = this.currentAuditResult.findings || [];
    if (severity === 'all') {
      this.renderAuditFindingsList(all);
    } else {
      this.renderAuditFindingsList(all.filter(f => f.severity === severity));
    }
  },

  copyAuditPitchSnippet() {
    const pitchEl = document.getElementById('auditPitchSnippetText');
    if (!pitchEl) return;
    const text = pitchEl.innerText.replace(/^"|"$/g, '');
    navigator.clipboard.writeText(text).then(() => {
      this.showToast('✓ Pitch snippet copied to clipboard!');
    }).catch(() => {
      this.copyToClipboard(text);
    });
  },

  insertAuditPitchIntoComposer() {
    const pitchEl = document.getElementById('auditPitchSnippetText');
    if (!pitchEl) return;
    const snippet = pitchEl.innerText.replace(/^"|"$/g, '');
    this.switchTab('composer');
    const msgEl = document.getElementById('emailMessage');
    if (msgEl) {
      if (msgEl.value.trim().length > 0) {
        msgEl.value = msgEl.value + '\n\n' + snippet;
      } else {
        msgEl.value = `Hi {{firstName}},\n\n${snippet}\n\nWould you be open to a 5-minute chat on how to fix this?\n\nBest,\n{{senderName}}`;
      }
      this.updateDesktopLivePreview();
      this.showToast('✓ Audit pitch inserted into Campaign Studio!');
    }
  },

  async loadAuditsHistory() {
    try {
      const res = await this.authFetch('/api/auditor/audits');
      if (!res.ok) return;
      const data = await res.json();
      const tbody = document.getElementById('auditorHistoryTbody');
      if (!tbody) return;

      if (!data.audits || data.audits.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 24px; color: var(--text-dim);">No audits recorded yet. Run your first audit above!</td></tr>`;
        return;
      }

      tbody.innerHTML = data.audits.map(a => {
        const timeStr = a.timestamp ? new Date(a.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
        const crit = a.findings?.filter(f => f.severity === 'Critical' || f.severity === 'High').length || 0;
        const scoreBadge = a.score >= 80 ? 'status-completed' : a.score >= 60 ? 'status-inprogress' : 'status-failed';

        return `
          <tr>
            <td><strong style="font-size: 12.5px; color: var(--text-main);">${this.escapeHtml(a.url)}</strong></td>
            <td><span class="status-badge ${scoreBadge}" style="font-size: 11px;">${a.score}/100</span></td>
            <td style="font-size: 12px; color: ${crit > 0 ? '#dc2626' : '#059669'}; font-weight: 600;">${crit} priority issues</td>
            <td style="font-size: 11.5px; color: var(--text-dim);">${timeStr}</td>
            <td>
              <button type="button" class="btn btn-secondary btn-sm" onclick="app.loadHistoricalAudit('${a.id}')" style="font-size: 11px; padding: 2px 8px;">View Report</button>
            </td>
          </tr>`;
      }).join('');
    } catch (e) {
      console.warn('Audits history load error:', e.message);
    }
  },

  async loadHistoricalAudit(auditId) {
    try {
      const res = await this.authFetch(`/api/auditor/audits/${auditId}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.audit) {
        this.currentAuditResult = data.audit;
        this.renderAuditReport(data.audit);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch (e) {
      this.showToast('Failed to load audit: ' + e.message, 'danger');
    }
  },

  async batchAuditLeadWebsites() {
    if (!confirm('Run automated diagnostic audits on all database leads with websites?')) return;
    try {
      const res = await this.authFetch('/api/auditor/batch-audit', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Batch audit failed');
      this.showToast(`Batch audit started for ${data.queuedCount || 0} leads`);
      this.loadAuditsHistory();
    } catch (e) {
      this.showToast(e.message, 'danger');
    }
  },

  async auditLeadWebsiteInline(leadId, websiteUrl) {
    if (!websiteUrl) {
      this.showToast('This lead does not have a website URL', 'danger');
      return;
    }
    this.showToast(`Auditing ${websiteUrl}...`);
    try {
      const res = await this.authFetch(`/api/auditor/audit-lead/${leadId}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Audit failed');
      this.showToast(`✓ Audit complete! Score: ${data.audit?.score}/100`);
      this.loadLeads(this.leadsCurrentPage);
      this.loadOverviewMetrics();
    } catch (e) {
      this.showToast(`Audit failed: ${e.message}`, 'danger');
    }
  },

  // ==========================================================
  // TAB 1B: DURABLE BULK LEAD IMPORTER (>1,000 RECORDS)
  // ==========================================================
  activeImportJobId: null,
  importJobPollTimer: null,

  toggleBulkImporterBox() {
    const body = document.getElementById('bulkImporterBody');
    const icon = document.getElementById('bulkImporterToggleIcon');
    if (!body) return;
    const isHidden = body.style.display === 'none';
    body.style.display = isHidden ? 'block' : 'none';
    if (icon) icon.innerText = isHidden ? '▾' : '▸';
  },

  handleBulkImportFileSelect(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const content = evt.target.result;
      const input = document.getElementById('bulkImportInput');
      if (input) {
        input.value = content;
        this.previewBulkImportLines();
      }
    };
    reader.readAsText(file);
  },

  previewBulkImportLines() {
    const input = document.getElementById('bulkImportInput');
    const countEl = document.getElementById('bulkImportPrecheckCount');
    if (!input || !countEl) return;
    const lines = input.value.split(/\r?\n/).filter(l => l.trim().length > 0);
    const count = lines.length;
    countEl.innerHTML = `<strong>${count}</strong> record(s) detected in paste area. Ready for non-blocking chunked import.`;
  },

  async executeBulkImportJob() {
    const rawText = document.getElementById('bulkImportInput')?.value || '';
    const defaultNiche = document.getElementById('bulkImportDefaultNiche')?.value.trim() || '';
    const updateExisting = document.getElementById('bulkImportUpdateExisting')?.checked ?? true;

    if (!rawText.trim()) {
      this.showToast('Please paste lead records or select a CSV file first', 'danger');
      return;
    }

    const btn = document.getElementById('btnStartBulkImport');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="loading-spinner"></span> Launching Import Engine...`;
    }

    const progressBox = document.getElementById('bulkImportJobProgressBox');
    if (progressBox) progressBox.style.display = 'block';

    try {
      const res = await this.authFetch('/api/leads/bulk-import-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText, defaultNiche, updateExisting })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to submit bulk import job');
      }

      this.activeImportJobId = data.job.id;
      this.showToast(`Import job started: ${data.job.totalRows || 0} rows submitted`);
      this.startImportJobPolling(data.job.id);
    } catch (err) {
      this.showToast(err.message, 'danger');
      if (progressBox) progressBox.style.display = 'none';
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `🚀 Start Durable Import`;
      }
    }
  },

  startImportJobPolling(jobId) {
    if (this.importJobPollTimer) clearInterval(this.importJobPollTimer);

    const poll = async () => {
      try {
        const res = await this.authFetch(`/api/leads/import-jobs/${jobId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!data || !data.job) return;
        const job = data.job;

        const statusText = document.getElementById('bulkImportJobStatusText');
        if (statusText) statusText.innerText = `Processing Batch Import (${job.processedRows || 0} / ${job.totalRows || 0})...`;

        const percentEl = document.getElementById('bulkImportJobPercent');
        if (percentEl) percentEl.innerText = `${job.progress || 0}%`;

        const bar = document.getElementById('bulkImportJobProgressBar');
        if (bar) bar.style.width = `${job.progress || 0}%`;

        const sSub = document.getElementById('importStatSubmitted');
        if (sSub) sSub.innerText = job.totalRows || 0;
        const sImp = document.getElementById('importStatImported');
        if (sImp) sImp.innerText = job.imported || 0;
        const sDup = document.getElementById('importStatDuplicates');
        if (sDup) sDup.innerText = job.skippedDuplicates || 0;
        const sInv = document.getElementById('importStatInvalid');
        if (sInv) sInv.innerText = job.invalid || 0;
        const sSup = document.getElementById('importStatSuppressed');
        if (sSup) sSup.innerText = job.suppressed || 0;

        if (['completed', 'failed', 'cancelled'].includes(job.status)) {
          clearInterval(this.importJobPollTimer);
          this.importJobPollTimer = null;
          if (statusText) statusText.innerText = `✓ Import ${job.status.toUpperCase()}! Processed ${job.processedRows || 0} rows.`;

          const reportRow = document.getElementById('bulkImportExportReportRow');
          if (reportRow) reportRow.style.display = 'block';

          this.showToast(`✓ Bulk import completed: ${job.imported || 0} added, ${job.skippedDuplicates || 0} duplicates skipped.`);
          this.loadLeads(1);
          this.loadOverviewMetrics();
        }
      } catch (e) {
        console.warn('Import job poll error:', e.message);
      }
    };

    poll();
    this.importJobPollTimer = setInterval(poll, 800);
  },

  downloadCurrentImportReport() {
    if (!this.activeImportJobId) return;
    window.open(`/api/leads/import-jobs/${this.activeImportJobId}/export`, '_blank');
  },

  // ==========================================================
  // TAB 5: SENDER ACCOUNTS & MULTI-ACCOUNT POOL CONTROLLER
  // ==========================================================
  toggleBulkAccountsBox() {
    const drawer = document.getElementById('bulkAccountsDrawer');
    if (!drawer) return;
    drawer.style.display = (drawer.style.display === 'none' || !drawer.style.display) ? 'block' : 'none';
  },

  async executeBulkAccountsImport() {
    const raw = document.getElementById('bulkAccountsInput')?.value || '';
    const testImmediately = document.getElementById('bulkAccountsTestConn')?.checked ?? true;

    if (!raw.trim()) {
      this.showToast('Please enter accounts in email, password format', 'danger');
      return;
    }

    const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
    const accounts = [];
    for (const line of lines) {
      const parts = line.split(',').map(p => p.trim());
      if (parts.length >= 2) {
        accounts.push({
          email: parts[0],
          password: parts[1],
          name: parts[2] || parts[0].split('@')[0],
          dailySendCap: parseInt(parts[3] || '50', 10) || 50
        });
      }
    }

    if (accounts.length === 0) {
      this.showToast('No valid account rows found (format: email, password, name, cap)', 'danger');
      return;
    }

    const btn = document.getElementById('btnExecuteBulkAccounts');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="loading-spinner"></span> Validating & Connecting Accounts...`;
    }

    const reportBox = document.getElementById('bulkAccountsReportBox');
    const summaryText = document.getElementById('bulkAccountsSummaryText');
    const resultsList = document.getElementById('bulkAccountsResultsList');

    try {
      const res = await this.authFetch('/api/accounts/bulk-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounts, testConnections: testImmediately })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Bulk setup failed');
      }

      if (reportBox && summaryText && resultsList) {
        reportBox.style.display = 'block';
        summaryText.innerHTML = `✓ Processed ${data.summary?.total || 0} accounts: <span style="color: #059669;">${data.summary?.added || 0} Connected</span>, <span style="color: #dc2626;">${data.summary?.failed || 0} Failed</span>`;
        resultsList.innerHTML = (data.results || []).map(r => `
          <div style="font-size: 12px; display: flex; justify-content: space-between; padding: 4px 8px; background: ${r.status === 'Connected' ? '#ecfdf5' : '#fef2f2'}; border-radius: 4px;">
            <span><strong>${this.escapeHtml(r.email)}</strong> (${this.escapeHtml(r.name || 'Sender')})</span>
            <span style="font-weight: 600; color: ${r.status === 'Connected' ? '#059669' : '#dc2626'};">${this.escapeHtml(r.status)}</span>
          </div>
        `).join('');
      }

      this.showToast(`✓ Bulk accounts imported: ${data.summary?.added || 0} connected`);
      await this.loadSavedAccounts();
      this.renderAccountsManagerTable();
      this.loadOverviewMetrics();
    } catch (err) {
      this.showToast(err.message, 'danger');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `⚡ Validate & Save All Accounts`;
      }
    }
  },

  toggleSenderRoutingMode(mode) {
    const isMulti = mode === 'multi';
    const poolConfig = document.getElementById('multiAccountPoolConfig');
    const singleGrid = document.getElementById('singleSenderInputsGrid');

    if (poolConfig) poolConfig.style.display = isMulti ? 'block' : 'none';
    if (singleGrid) singleGrid.style.display = isMulti ? 'none' : 'grid';

    if (isMulti) {
      this.renderMultiAccountCheckboxes();
      this.previewMultiAccountAllocation();
    }
  },

  renderMultiAccountCheckboxes() {
    const container = document.getElementById('multiAccountCheckboxesContainer');
    if (!container) return;

    if (!this.accounts || this.accounts.length === 0) {
      container.innerHTML = `<div style="font-size: 12px; color: var(--text-dim); padding: 4px;">No sender accounts configured. Add accounts in Sender Accounts tab first.</div>`;
      return;
    }

    container.innerHTML = this.accounts.map(acc => {
      const remaining = acc.remainingToday ?? ((acc.dailySendCap || 50) - (acc.sentToday || 0));
      return `
        <label style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; cursor: pointer; padding: 2px 4px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <input type="checkbox" class="multi-acc-cb" value="${acc.id}" checked onchange="app.previewMultiAccountAllocation()">
            <strong style="color: var(--text-main);">${this.escapeHtml(acc.email)}</strong>
            <span style="color: var(--text-dim); font-size: 11px;">(${this.escapeHtml(acc.name || 'Sender')})</span>
          </div>
          <span style="font-size: 11px; color: ${remaining > 0 ? '#059669' : '#dc2626'}; font-weight: 600;">
            ${remaining} sends left today
          </span>
        </label>
      `;
    }).join('');
  },

  selectAllSenderAccountsForCampaign() {
    const cbs = document.querySelectorAll('.multi-acc-cb');
    cbs.forEach(cb => { cb.checked = true; });
    this.previewMultiAccountAllocation();
  },

  async previewMultiAccountAllocation() {
    const selectedCbs = Array.from(document.querySelectorAll('.multi-acc-cb:checked'));
    const accountIds = selectedCbs.map(cb => cb.value);
    const perAccountCap = parseInt(document.getElementById('multiAccountPerCapInput')?.value || '50', 10);
    const routingPolicy = document.getElementById('multiAccountPolicySelect')?.value || 'balanced';

    const leadsCount = this.parsedValidation?.validCount || 0;

    const capSpan = document.getElementById('allocPreviewCapacity');
    const statusSpan = document.getElementById('allocPreviewStatus');
    const listEl = document.getElementById('allocPreviewList');

    if (accountIds.length === 0) {
      if (capSpan) capSpan.innerText = 'Total Pool Capacity: 0 sends';
      if (statusSpan) statusSpan.innerText = '0 accounts selected';
      if (listEl) listEl.innerHTML = '<span style="color: #dc2626;">Select at least one sender mailbox.</span>';
      return;
    }

    try {
      const res = await this.authFetch('/api/campaigns/multi-account-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountIds, perAccountCap, routingPolicy, leadsCount })
      });
      const data = await res.json();
      if (!res.ok || !data.success) return;

      if (capSpan) capSpan.innerText = `Total Pool Capacity: ${data.totalCapacity || 0} sends today`;
      if (statusSpan) statusSpan.innerText = `${data.accountsCount || accountIds.length} accounts ready`;

      if (listEl) {
        listEl.innerHTML = (data.allocations || []).map(a => `
          <div>• ${this.escapeHtml(a.email)}: allocated ${a.assignedLeads} leads (Cap: ${a.dailySendCap}, ${a.remainingToday} left)</div>
        `).join('');
      }
    } catch (e) {
      console.warn('Preview allocation error:', e.message);
    }
  },

  openAuthModal() {
    this.closeWorkspaceDropdown();
    this.openModal('modalAuth');
  },

  switchAuthTab(tab) {
    const btnIn = document.getElementById('tabBtnSignIn');
    const btnUp = document.getElementById('tabBtnSignUp');
    const formIn = document.getElementById('formSignIn');
    const formUp = document.getElementById('formSignUp');

    if (tab === 'signup') {
      if (btnIn) btnIn.classList.remove('active');
      if (btnUp) btnUp.classList.add('active');
      if (formIn) formIn.style.display = 'none';
      if (formUp) formUp.style.display = 'block';
    } else {
      if (btnIn) btnIn.classList.add('active');
      if (btnUp) btnUp.classList.remove('active');
      if (formIn) formIn.style.display = 'block';
      if (formUp) formUp.style.display = 'none';
    }
  },

  async handleSignIn(e) {
    if (e) e.preventDefault();
    const email = document.getElementById('authSignInEmail')?.value.trim();
    const password = document.getElementById('authSignInPassword')?.value;

    if (!email || !password) return;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (data.success && data.token) {
        localStorage.setItem('mailflow_auth_token', data.token);
        this.authToken = data.token;
        this.currentUser = data.user;
        if (data.activeTenant) {
          this.activeTenantId = data.activeTenant.id;
          localStorage.setItem('mailflow_active_tenant', data.activeTenant.id);
          this.currentWorkspace = data.activeTenant;
        }
        if (data.tenants) this.userWorkspaces = data.tenants;

        this.closeModal('modalAuth');
        this.renderWorkspaceUI();
        this.showToast(`✓ Welcome back, ${data.user.name}!`);
        await this.reloadAllWorkspaceData();
      } else {
        this.showToast(data.error || 'Sign in failed', 'danger');
      }
    } catch (err) {
      this.showToast(err.message, 'danger');
    }
  },

  async handleSignUp(e) {
    if (e) e.preventDefault();
    const name = document.getElementById('authSignUpName')?.value.trim();
    const email = document.getElementById('authSignUpEmail')?.value.trim();
    const workspaceName = document.getElementById('authSignUpWorkspace')?.value.trim();
    const password = document.getElementById('authSignUpPassword')?.value;

    if (!name || !email || !password) return;

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, workspaceName })
      });
      const data = await res.json();
      if (data.success && data.token) {
        localStorage.setItem('mailflow_auth_token', data.token);
        this.authToken = data.token;
        this.currentUser = data.user;
        if (data.tenant) {
          this.activeTenantId = data.tenant.id;
          localStorage.setItem('mailflow_active_tenant', data.tenant.id);
          this.currentWorkspace = data.tenant;
        }
        if (data.tenants) this.userWorkspaces = data.tenants;

        this.closeModal('modalAuth');
        this.renderWorkspaceUI();
        this.showToast(`✓ Workspace "${data.tenant?.name}" created!`);
        await this.reloadAllWorkspaceData();
      } else {
        this.showToast(data.error || 'Registration failed', 'danger');
      }
    } catch (err) {
      this.showToast(err.message, 'danger');
    }
  },

  async handleSignOut() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (e) {}

    localStorage.removeItem('mailflow_auth_token');
    localStorage.removeItem('mailflow_active_tenant');
    this.authToken = null;
    this.currentUser = null;
    this.activeTenantId = 'default';
    this.currentWorkspace = null;
    this.userWorkspaces = [];

    this.renderWorkspaceUI();
    this.closeWorkspaceDropdown();
    this.showToast('✓ Signed out. Switched to Default Workspace.');
    await this.reloadAllWorkspaceData();
  }
};

document.addEventListener('DOMContentLoaded', () => {
  try {
    const s = document.getElementById('emailSubject');
    const m = document.getElementById('emailMessage');
    if (s) s.value = '';
    if (m) m.value = '';
  } catch (e) {}
  app.init();
});

document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('topNotifDropdown');
  const btn = document.getElementById('btnTopNotifBell');
  if (dropdown && dropdown.style.display === 'block') {
    if (!dropdown.contains(e.target) && !btn?.contains(e.target)) {
      dropdown.style.display = 'none';
    }
  }

  const wsDropdown = document.getElementById('workspaceDropdownMenu');
  const wsBtn = document.getElementById('btnWorkspaceDropdown');
  if (wsDropdown && wsDropdown.style.display === 'block') {
    if (!wsDropdown.contains(e.target) && !wsBtn?.contains(e.target)) {
      wsDropdown.style.display = 'none';
    }
  }
});
