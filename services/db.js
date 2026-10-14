const path = require('path');
const EncryptionService = require('./encryptionService');
const storage = require('./storageService');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');

class Database {
  constructor() {
    this.data = {
      users: [],
      tenants: [],
      tenant_members: [],
      sessions: [],
      email_connections: [],
      campaigns: [],
      campaign_recipients: []
    };
    this.load();
  }

  load() {
    const rawData = storage.readJSON(DB_FILE, null);
    if (rawData && typeof rawData === 'object') {
      this.data = rawData;
      if (!this.data.users) this.data.users = [];
      if (!this.data.tenants) this.data.tenants = [];
      if (!this.data.tenant_members) this.data.tenant_members = [];
      if (!this.data.sessions) this.data.sessions = [];
      if (!this.data.email_connections) this.data.email_connections = [];
      if (!this.data.campaigns) this.data.campaigns = [];
      if (!this.data.campaign_recipients) this.data.campaign_recipients = [];
    } else {
      this.seedInitialData();
    }

    // Always ensure a default tenant exists for frictionless operation
    this.ensureDefaultTenant();
  }

  save() {
    storage.writeJSON(DB_FILE, this.data);
  }

  seedInitialData() {
    this.data = {
      users: [],
      tenants: [],
      tenant_members: [],
      sessions: [],
      email_connections: [],
      campaigns: [],
      campaign_recipients: []
    };
    this.save();
  }

  ensureDefaultTenant() {
    let defaultTenant = this.data.tenants.find(t => t.id === 'default' || t.slug === 'default');
    if (!defaultTenant) {
      defaultTenant = {
        id: 'default',
        name: 'Primary Workspace',
        slug: 'default',
        owner_id: 'usr-default',
        plan: 'pro',
        settings: {
          daily_limit: 500,
          delay_seconds: 60,
          plain_text_only: true,
          enable_tracking: false
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      this.data.tenants.unshift(defaultTenant);
      this.save();
    }
    return defaultTenant;
  }

  // --- TENANTS / WORKSPACES ---
  createTenant({ id, name, slug, owner_id, plan = 'pro', settings = {} }) {
    const tenantId = id || `org-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const cleanSlug = slug || (name ? name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').substr(0, 30) : tenantId);

    const newTenant = {
      id: tenantId,
      name: name || 'Outreach Workspace',
      slug: cleanSlug,
      owner_id: owner_id || null,
      plan: plan || 'pro',
      settings: {
        daily_limit: settings.daily_limit || 500,
        delay_seconds: settings.delay_seconds || 60,
        plain_text_only: settings.plain_text_only !== false,
        enable_tracking: !!settings.enable_tracking
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    this.data.tenants.push(newTenant);

    if (owner_id) {
      this.addTenantMember({
        tenant_id: tenantId,
        user_id: owner_id,
        role: 'owner'
      });
    }

    this.save();
    return newTenant;
  }

  findTenantById(id) {
    if (!id) return null;
    return this.data.tenants.find(t => t.id === id) || null;
  }

  getAllTenants() {
    return [...this.data.tenants];
  }

  findTenantBySlug(slug) {
    if (!slug) return null;
    return this.data.tenants.find(t => t.slug === slug.toLowerCase().trim()) || null;
  }

  updateTenant(id, updates) {
    const tenant = this.findTenantById(id);
    if (!tenant) return null;

    if (updates.name) tenant.name = updates.name.trim();
    if (updates.plan) tenant.plan = updates.plan;
    if (updates.settings) tenant.settings = { ...tenant.settings, ...updates.settings };
    tenant.updated_at = new Date().toISOString();

    this.save();
    return tenant;
  }

  deleteTenant(id) {
    if (id === 'default') return false; // Prevent deleting default workspace
    const beforeCount = this.data.tenants.length;
    this.data.tenants = this.data.tenants.filter(t => t.id !== id);
    this.data.tenant_members = this.data.tenant_members.filter(m => m.tenant_id !== id);
    this.save();
    return this.data.tenants.length < beforeCount;
  }

  // --- TENANT MEMBERSHIP & RBAC ---
  addTenantMember({ tenant_id, user_id, role = 'member' }) {
    if (!tenant_id || !user_id) return null;

    // Check if already a member
    let member = this.data.tenant_members.find(m => m.tenant_id === tenant_id && m.user_id === user_id);
    if (member) {
      member.role = role;
      this.save();
      return member;
    }

    member = {
      id: `mem-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      tenant_id,
      user_id,
      role: role || 'member', // 'owner', 'admin', 'member'
      joined_at: new Date().toISOString()
    };

    this.data.tenant_members.push(member);
    this.save();
    return member;
  }

  getTenantMembership(tenant_id, user_id) {
    if (!tenant_id || !user_id) return null;
    return this.data.tenant_members.find(m => m.tenant_id === tenant_id && m.user_id === user_id) || null;
  }

  getTenantMembers(tenant_id) {
    if (!tenant_id) return [];
    const memberships = this.data.tenant_members.filter(m => m.tenant_id === tenant_id);
    return memberships.map(m => {
      const user = this.findUserById(m.user_id);
      return {
        membershipId: m.id,
        userId: m.user_id,
        role: m.role,
        joinedAt: m.joined_at,
        name: user ? user.name : 'Unknown User',
        email: user ? user.email : 'unknown@domain.com'
      };
    });
  }

  removeTenantMember(tenant_id, user_id) {
    const tenant = this.findTenantById(tenant_id);
    if (tenant && tenant.owner_id === user_id) {
      throw new Error('Cannot remove the owner of the workspace.');
    }

    const beforeCount = this.data.tenant_members.length;
    this.data.tenant_members = this.data.tenant_members.filter(m => !(m.tenant_id === tenant_id && m.user_id === user_id));
    this.save();
    return this.data.tenant_members.length < beforeCount;
  }

  getTenantsByUserId(userId) {
    if (!userId) return [];
    // User is either direct owner or has an entry in tenant_members
    const memberTenantIds = new Set(
      this.data.tenant_members.filter(m => m.user_id === userId).map(m => m.tenant_id)
    );

    // Also include tenants where user is owner_id
    this.data.tenants.forEach(t => {
      if (t.owner_id === userId) memberTenantIds.add(t.id);
    });

    const tenants = this.data.tenants.filter(t => memberTenantIds.has(t.id));
    return tenants.map(t => {
      const mem = this.data.tenant_members.find(m => m.tenant_id === t.id && m.user_id === userId);
      return {
        ...t,
        role: mem ? mem.role : (t.owner_id === userId ? 'owner' : 'member')
      };
    });
  }

  // --- USERS ---
  findUserByEmail(email) {
    if (!email) return null;
    return this.data.users.find(u => u.email.toLowerCase() === email.toLowerCase().trim()) || null;
  }

  findUserById(id) {
    if (!id) return null;
    return this.data.users.find(u => u.id === id) || null;
  }

  createUser(user) {
    const newUser = {
      id: user.id || `usr-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      name: user.name,
      email: user.email.toLowerCase().trim(),
      password_hash: user.password_hash,
      is_verified: user.is_verified ?? true,
      default_tenant_id: user.default_tenant_id || 'default',
      reset_token: user.reset_token || null,
      reset_token_expires: user.reset_token_expires || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    this.data.users.push(newUser);
    this.save();
    return newUser;
  }

  updateUser(id, updates) {
    const user = this.findUserById(id);
    if (!user) return null;
    Object.assign(user, updates, { updated_at: new Date().toISOString() });
    this.save();
    return user;
  }

  // --- SESSIONS ---
  createSession(userId, activeTenantId = 'default') {
    const token = EncryptionService.generateToken(32);
    const session = {
      token,
      user_id: userId,
      active_tenant_id: activeTenantId,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
    };
    this.data.sessions.push(session);
    this.save();
    return session;
  }

  findSession(token) {
    if (!token) return null;
    const session = this.data.sessions.find(s => s.token === token);
    if (!session) return null;
    if (new Date(session.expires_at) < new Date()) {
      this.deleteSession(token);
      return null;
    }
    return session;
  }

  updateSessionActiveTenant(token, tenantId) {
    const session = this.findSession(token);
    if (!session) return null;
    session.active_tenant_id = tenantId;
    this.save();
    return session;
  }

  deleteSession(token) {
    this.data.sessions = this.data.sessions.filter(s => s.token !== token);
    this.save();
  }

  deleteUserSessions(userId) {
    this.data.sessions = this.data.sessions.filter(s => s.user_id !== userId);
    this.save();
  }

  // --- EMAIL CONNECTIONS ---
  saveEmailConnection({ user_id, provider = 'gmail', email_address, encrypted_access_token, encrypted_refresh_token, status = 'Connected', is_default = false, daily_limit = 50 }) {
    if (!this.data.email_connections) this.data.email_connections = [];
    const cleanEmail = (email_address || '').toLowerCase().trim();
    let conn = this.data.email_connections.find(c => c.user_id === user_id && c.email_address === cleanEmail);

    if (conn) {
      conn.encrypted_access_token = encrypted_access_token || conn.encrypted_access_token;
      if (encrypted_refresh_token) conn.encrypted_refresh_token = encrypted_refresh_token;
      conn.status = status || conn.status;
      conn.daily_limit = daily_limit || conn.daily_limit || 50;
      conn.updated_at = new Date().toISOString();
      if (is_default) {
        this.data.email_connections.forEach(c => {
          if (c.user_id === user_id) c.is_default = (c.id === conn.id);
        });
      }
    } else {
      const id = `conn-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
      conn = {
        id,
        user_id,
        provider: provider || 'gmail',
        email_address: cleanEmail,
        encrypted_access_token,
        encrypted_refresh_token: encrypted_refresh_token || null,
        status: status || 'Connected',
        is_default: !!is_default || this.getEmailConnections(user_id).length === 0,
        daily_limit: daily_limit || 50,
        sent_today: 0,
        last_sent_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      if (conn.is_default) {
        this.data.email_connections.forEach(c => {
          if (c.user_id === user_id) c.is_default = false;
        });
      }
      this.data.email_connections.push(conn);
    }
    this.save();
    return conn;
  }

  getEmailConnections(userId) {
    if (!this.data.email_connections) this.data.email_connections = [];
    if (!userId) return [...this.data.email_connections];
    return this.data.email_connections.filter(c => c.user_id === userId);
  }

  getEmailConnectionById(id, userId = null) {
    if (!this.data.email_connections) this.data.email_connections = [];
    return this.data.email_connections.find(c => c.id === id && (!userId || c.user_id === userId)) || null;
  }

  getDefaultEmailConnection(userId) {
    const list = this.getEmailConnections(userId);
    return list.find(c => c.is_default) || list[0] || null;
  }

  setDefaultEmailConnection(userId, connectionId) {
    if (!this.data.email_connections) this.data.email_connections = [];
    let updated = false;
    this.data.email_connections.forEach(c => {
      if (c.user_id === userId) {
        c.is_default = (c.id === connectionId);
        if (c.is_default) updated = true;
      }
    });
    this.save();
    return updated;
  }

  deleteEmailConnection(userId, connectionId) {
    if (!this.data.email_connections) this.data.email_connections = [];
    const prev = this.data.email_connections.length;
    this.data.email_connections = this.data.email_connections.filter(c => !(c.id === connectionId && (!userId || c.user_id === userId)));
    this.save();
    return this.data.email_connections.length < prev;
  }

  resetConnectionSentToday(userId, connectionId) {
    const conn = this.getEmailConnectionById(connectionId, userId);
    if (conn) {
      conn.sent_today = 0;
      this.save();
      return true;
    }
    return false;
  }

  incrementConnectionSentToday(connectionId) {
    const conn = this.getEmailConnectionById(connectionId);
    if (conn) {
      conn.sent_today = (conn.sent_today || 0) + 1;
      conn.last_sent_at = new Date().toISOString();
      this.save();
      return conn.sent_today;
    }
    return 0;
  }
}

const db = new Database();
module.exports = db;
