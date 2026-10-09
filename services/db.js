const fs = require('fs');
const path = require('path');
const EncryptionService = require('./encryptionService');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

class Database {
  constructor() {
    this.data = {
      users: [],
      email_connections: [],
      campaigns: [],
      campaign_recipients: [],
      sessions: []
    };
    this.load();
  }

  load() {
    if (fs.existsSync(DB_FILE)) {
      try {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        this.data = JSON.parse(raw);
        if (!this.data.users) this.data.users = [];
        if (!this.data.email_connections) this.data.email_connections = [];
        if (!this.data.campaigns) this.data.campaigns = [];
        if (!this.data.campaign_recipients) this.data.campaign_recipients = [];
        if (!this.data.sessions) this.data.sessions = [];
      } catch (err) {
        console.error('Error loading database.json:', err.message);
        this.seedInitialData();
      }
    } else {
      this.seedInitialData();
    }
  }

  save() {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('Error saving database.json:', err.message);
    }
  }

  seedInitialData() {
    this.data = {
      users: [],
      email_connections: [],
      campaigns: [],
      campaign_recipients: [],
      sessions: []
    };
    this.save();
  }

  // --- USERS ---
  findUserByEmail(email) {
    if (!email) return null;
    return this.data.users.find(u => u.email.toLowerCase() === email.toLowerCase().trim()) || null;
  }

  findUserById(id) {
    return this.data.users.find(u => u.id === id) || null;
  }

  createUser(user) {
    const newUser = {
      id: user.id || `usr-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      name: user.name,
      email: user.email.toLowerCase().trim(),
      password_hash: user.password_hash,
      is_verified: user.is_verified ?? true,
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
  createSession(userId) {
    const token = EncryptionService.generateToken(32);
    const session = {
      token,
      user_id: userId,
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

  deleteSession(token) {
    this.data.sessions = this.data.sessions.filter(s => s.token !== token);
    this.save();
  }

  deleteUserSessions(userId) {
    this.data.sessions = this.data.sessions.filter(s => s.user_id !== userId);
    this.save();
  }

  // --- EMAIL CONNECTIONS ---
  getEmailConnections(userId) {
    return this.data.email_connections.filter(c => c.user_id === userId);
  }

  getEmailConnectionById(id, userId = null) {
    return this.data.email_connections.find(c => c.id === id && (!userId || c.user_id === userId)) || null;
  }

  getDefaultEmailConnection(userId) {
    const connections = this.getEmailConnections(userId);
    return connections.find(c => c.is_default && c.status === 'Connected') || connections.find(c => c.status === 'Connected') || null;
  }

  saveEmailConnection(connectionData) {
    let connection = this.data.email_connections.find(
      c => c.user_id === connectionData.user_id && c.email_address.toLowerCase() === connectionData.email_address.toLowerCase()
    );

    const now = new Date().toISOString();
    if (connection) {
      Object.assign(connection, {
        provider: connectionData.provider || connection.provider,
        encrypted_access_token: connectionData.encrypted_access_token || connection.encrypted_access_token,
        encrypted_refresh_token: connectionData.encrypted_refresh_token || connection.encrypted_refresh_token,
        status: connectionData.status || 'Connected',
        updated_at: now
      });
    } else {
      const userConnections = this.getEmailConnections(connectionData.user_id);
      connection = {
        id: connectionData.id || `conn-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        user_id: connectionData.user_id,
        provider: connectionData.provider || 'gmail',
        email_address: connectionData.email_address.toLowerCase().trim(),
        encrypted_access_token: connectionData.encrypted_access_token || null,
        encrypted_refresh_token: connectionData.encrypted_refresh_token || null,
        status: connectionData.status || 'Connected',
        is_default: userConnections.length === 0 || !!connectionData.is_default,
        daily_limit: connectionData.daily_limit || 50,
        sent_today: 0,
        created_at: now,
        updated_at: now
      };
      this.data.email_connections.push(connection);
    }

    this.save();
    return connection;
  }

  setDefaultEmailConnection(userId, connectionId) {
    const userConnections = this.getEmailConnections(userId);
    userConnections.forEach(c => {
      c.is_default = (c.id === connectionId);
    });
    this.save();
    return true;
  }

  deleteEmailConnection(userId, connectionId) {
    const beforeCount = this.data.email_connections.length;
    this.data.email_connections = this.data.email_connections.filter(c => !(c.id === connectionId && c.user_id === userId));
    const userConns = this.getEmailConnections(userId);
    if (userConns.length > 0 && !userConns.some(c => c.is_default)) {
      userConns[0].is_default = true;
    }
    this.save();
    return this.data.email_connections.length < beforeCount;
  }

  incrementConnectionSentToday(connectionId) {
    const conn = this.data.email_connections.find(c => c.id === connectionId);
    if (conn) {
      conn.sent_today = (conn.sent_today || 0) + 1;
      this.save();
    }
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

  // --- CAMPAIGNS ---
  getCampaigns(userId) {
    return this.data.campaigns
      .filter(c => c.user_id === userId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  getCampaignById(id, userId = null) {
    return this.data.campaigns.find(c => c.id === id && (!userId || c.user_id === userId)) || null;
  }

  createCampaign(campaignData) {
    const newCamp = {
      id: campaignData.id || `camp-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      user_id: campaignData.user_id,
      email_connection_id: campaignData.email_connection_id,
      subject: campaignData.subject,
      message: campaignData.message,
      recipient_count: campaignData.recipient_count || 0,
      sent_count: campaignData.sent_count || 0,
      failed_count: campaignData.failed_count || 0,
      pending_count: campaignData.pending_count || 0,
      status: campaignData.status || 'Draft',
      created_at: new Date().toISOString(),
      completed_at: null
    };
    this.data.campaigns.unshift(newCamp);
    this.save();
    return newCamp;
  }

  updateCampaign(id, updates) {
    const camp = this.data.campaigns.find(c => c.id === id);
    if (!camp) return null;
    Object.assign(camp, updates);
    this.save();
    return camp;
  }

  // --- CAMPAIGN RECIPIENTS ---
  createCampaignRecipients(recipientsList) {
    recipientsList.forEach(r => {
      this.data.campaign_recipients.push({
        id: r.id || `rec-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
        campaign_id: r.campaign_id,
        recipient_email: r.recipient_email.toLowerCase().trim(),
        status: r.status || 'Pending',
        provider_message_id: r.provider_message_id || null,
        error_message: r.error_message || null,
        sent_at: r.sent_at || null
      });
    });
    this.save();
  }

  getCampaignRecipients(campaignId) {
    return this.data.campaign_recipients.filter(r => r.campaign_id === campaignId);
  }

  updateCampaignRecipient(id, updates) {
    const rec = this.data.campaign_recipients.find(r => r.id === id);
    if (!rec) return null;
    Object.assign(rec, updates);
    this.save();
    return rec;
  }
}

const db = new Database();
module.exports = db;
