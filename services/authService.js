const db = require('./db');
const EncryptionService = require('./encryptionService');
const tenantManager = require('./tenantManager');

class AuthService {
  /**
   * Register a new user and create their isolated primary workspace/tenant
   */
  static register({ name, email, password, workspaceName }) {
    if (!email || !email.includes('@')) {
      throw new Error('A valid email address is required.');
    }
    if (!password || password.length < 6) {
      throw new Error('Password must be at least 6 characters.');
    }
    if (!name || !name.trim()) {
      throw new Error('Name is required.');
    }

    const cleanEmail = email.toLowerCase().trim();
    const existing = db.findUserByEmail(cleanEmail);
    if (existing) {
      throw new Error('An account with this email address already exists.');
    }

    const password_hash = EncryptionService.hashPassword(password);
    
    // 1. Create User
    const user = db.createUser({
      name: name.trim(),
      email: cleanEmail,
      password_hash,
      is_verified: true
    });

    // 2. Create Isolated Tenant/Workspace for this user
    const tenantName = (workspaceName && workspaceName.trim()) 
      ? workspaceName.trim() 
      : `${name.trim()}'s Workspace`;

    const tenant = db.createTenant({
      name: tenantName,
      owner_id: user.id
    });

    // 3. Update User's default tenant
    db.updateUser(user.id, { default_tenant_id: tenant.id });

    // 4. Pre-initialize isolated filesystem partition for this tenant
    tenantManager.getTenantServices(tenant.id);

    // 5. Create Session
    const session = db.createSession(user.id, tenant.id);

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        default_tenant_id: tenant.id,
        created_at: user.created_at
      },
      token: session.token,
      tenant,
      tenants: [{ ...tenant, role: 'owner' }]
    };
  }

  /**
   * Login user and resolve their accessible tenants
   */
  static login({ email, password }) {
    if (!email || !password) {
      throw new Error('Email and password are required.');
    }

    const cleanEmail = email.toLowerCase().trim();
    const user = db.findUserByEmail(cleanEmail);
    if (!user) {
      throw new Error('Invalid email or password.');
    }

    const isValid = EncryptionService.verifyPassword(password, user.password_hash);
    if (!isValid) {
      throw new Error('Invalid email or password.');
    }

    // Resolve user's accessible tenants
    let tenants = db.getTenantsByUserId(user.id);
    if (tenants.length === 0) {
      // Ensure user has at least one workspace
      const newTenant = db.createTenant({
        name: `${user.name}'s Workspace`,
        owner_id: user.id
      });
      db.updateUser(user.id, { default_tenant_id: newTenant.id });
      tenants = [{ ...newTenant, role: 'owner' }];
    }

    // Determine active tenant
    const activeTenantId = (user.default_tenant_id && tenants.some(t => t.id === user.default_tenant_id))
      ? user.default_tenant_id
      : tenants[0].id;

    const activeTenant = tenants.find(t => t.id === activeTenantId) || tenants[0];

    // Pre-initialize isolated services
    tenantManager.getTenantServices(activeTenant.id);

    const session = db.createSession(user.id, activeTenant.id);

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        default_tenant_id: activeTenant.id,
        created_at: user.created_at
      },
      token: session.token,
      activeTenant,
      tenants
    };
  }

  /**
   * Get current authenticated user profile and workspaces
   */
  static getMe(token) {
    if (!token) return null;
    const session = db.findSession(token);
    if (!session) return null;

    const user = db.findUserById(session.user_id);
    if (!user) return null;

    const tenants = db.getTenantsByUserId(user.id);
    const activeTenantId = session.active_tenant_id || user.default_tenant_id || (tenants[0] ? tenants[0].id : 'default');
    const activeTenant = db.findTenantById(activeTenantId) || (tenants[0] || db.ensureDefaultTenant());

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        default_tenant_id: user.default_tenant_id,
        created_at: user.created_at
      },
      activeTenant,
      tenants
    };
  }

  /**
   * Switch the active workspace for the current session
   */
  static switchTenant(userId, token, targetTenantId) {
    if (!userId || !token || !targetTenantId) {
      throw new Error('User, token, and target workspace ID are required.');
    }

    const membership = db.getTenantMembership(targetTenantId, userId);
    const tenant = db.findTenantById(targetTenantId);

    if (!membership && (!tenant || tenant.owner_id !== userId)) {
      throw new Error('Access denied: You are not a member of this workspace.');
    }

    db.updateSessionActiveTenant(token, targetTenantId);
    db.updateUser(userId, { default_tenant_id: targetTenantId });

    // Ensure services initialized
    tenantManager.getTenantServices(targetTenantId);

    return {
      success: true,
      activeTenant: {
        ...tenant,
        role: membership ? membership.role : 'owner'
      }
    };
  }

  /**
   * Create a new workspace for an existing user
   */
  static createWorkspace(userId, workspaceName) {
    if (!userId) throw new Error('User ID is required.');
    if (!workspaceName || !workspaceName.trim()) {
      throw new Error('Workspace name is required.');
    }

    const user = db.findUserById(userId);
    if (!user) throw new Error('User not found.');

    const tenant = db.createTenant({
      name: workspaceName.trim(),
      owner_id: userId
    });

    // Ensure isolated filesystem partition
    tenantManager.getTenantServices(tenant.id);

    return {
      ...tenant,
      role: 'owner'
    };
  }

  /**
   * Invite or add a member to a workspace
   */
  static inviteMember(tenantId, inviterUserId, { email, role = 'member' }) {
    if (!email || !email.includes('@')) {
      throw new Error('A valid email address is required.');
    }

    const cleanEmail = email.toLowerCase().trim();
    let targetUser = db.findUserByEmail(cleanEmail);

    if (!targetUser) {
      // Create user placeholder for invited member
      targetUser = db.createUser({
        name: cleanEmail.split('@')[0],
        email: cleanEmail,
        password_hash: EncryptionService.hashPassword(EncryptionService.generateToken(12)),
        is_verified: true,
        default_tenant_id: tenantId
      });
    }

    const member = db.addTenantMember({
      tenant_id: tenantId,
      user_id: targetUser.id,
      role: role || 'member'
    });

    return {
      membershipId: member.id,
      userId: targetUser.id,
      name: targetUser.name,
      email: targetUser.email,
      role: member.role,
      joinedAt: member.joined_at
    };
  }

  static logout(token) {
    if (token) {
      db.deleteSession(token);
    }
    return true;
  }
}

module.exports = AuthService;
