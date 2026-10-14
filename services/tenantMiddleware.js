const db = require('./db');
const tenantManager = require('./tenantManager');

/**
 * Tenant Context Middleware
 * Extracts authentication, validates tenant membership, and attaches
 * tenant-isolated services to req.tenantServices.
 */
function tenantContextMiddleware(req, res, next) {
  try {
    // 1. Extract session token
    let token = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (req.headers['x-session-token']) {
      token = req.headers['x-session-token'];
    } else if (req.query && req.query.auth_token) {
      token = req.query.auth_token;
    }

    // 2. Resolve authenticated user & session
    let user = null;
    let session = null;
    if (token) {
      session = db.findSession(token);
      if (session) {
        user = db.findUserById(session.user_id);
      }
    }

    // 3. Determine target tenant
    const requestedTenantId = req.headers['x-tenant-id'] || 
                              (req.query && (req.query.tenant_id || req.query.tenant)) ||
                              (req.body && (req.body.tenantId || req.body.tenant));
    let tenantId = 'default';
    let role = 'owner';

    if (user) {
      req.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        default_tenant_id: user.default_tenant_id
      };

      if (requestedTenantId) {
        // Enforce data isolation: verify user has access to requested tenant
        const membership = db.getTenantMembership(requestedTenantId, user.id);
        const tenantRecord = db.findTenantById(requestedTenantId);

        if (!membership && (!tenantRecord || tenantRecord.owner_id !== user.id)) {
          return res.status(403).json({
            success: false,
            error: 'Access denied: You do not have permission to access this workspace.'
          });
        }

        tenantId = requestedTenantId;
        role = membership ? membership.role : (tenantRecord && tenantRecord.owner_id === user.id ? 'owner' : 'member');
      } else if (session && session.active_tenant_id) {
        tenantId = session.active_tenant_id;
        const membership = db.getTenantMembership(tenantId, user.id);
        role = membership ? membership.role : 'member';
      } else if (user.default_tenant_id) {
        tenantId = user.default_tenant_id;
        const membership = db.getTenantMembership(tenantId, user.id);
        role = membership ? membership.role : 'owner';
      }
    } else {
      // Unauthenticated / guest session
      // For private API access to a registered owner's tenant, enforce authentication
      const p = (req.originalUrl || req.path || '').toLowerCase();
      const isPublicPath = p.includes('/unsubscribe') ||
                           p.includes('/leads/submit') ||
                           p.includes('/track') ||
                           p.includes('/auth/') ||
                           p.includes('/health');

      if (!isPublicPath && requestedTenantId && requestedTenantId !== 'default') {
        const existingTenant = db.findTenantById(requestedTenantId);
        if (existingTenant && existingTenant.owner_id && existingTenant.owner_id !== 'usr-default') {
          return res.status(401).json({
            success: false,
            error: 'Authentication required: You must sign in with a valid account to access this workspace.'
          });
        }
      }
      tenantId = requestedTenantId || 'default';
      role = 'owner';
    }

    // 4. Fetch or ensure tenant record
    let tenant = db.findTenantById(tenantId);
    if (!tenant) {
      if (tenantId === 'default') {
        tenant = db.ensureDefaultTenant();
      } else {
        // Only allow creating unowned tenants for guest partitions
        const isGuest = tenantId.startsWith('guest_');
        tenant = db.createTenant({
          id: tenantId,
          name: isGuest ? 'Guest Workspace' : 'Workspace ' + tenantId.slice(0, 8),
          owner_id: user ? user.id : (isGuest ? null : null)
        });
      }
    }

    req.tenant = tenant;
    req.tenantId = tenant.id;
    req.tenantRole = role;

    // 5. Attach tenant-isolated service instances
    req.tenantServices = tenantManager.getTenantServices(tenant.id);

    next();
  } catch (err) {
    console.error('[tenantContextMiddleware] Error initializing tenant context:', err.message);
    // Safe fallback to default tenant so app remains resilient
    req.tenantId = 'default';
    req.tenant = { id: 'default', name: 'Primary Workspace' };
    req.tenantRole = 'owner';
    req.tenantServices = tenantManager.getTenantServices('default');
    next();
  }
}

/**
 * Enforce authentication for protected actions
 */
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required. Please sign in to perform this action.'
    });
  }
  next();
}

/**
 * Enforce minimum tenant role (e.g. owner or admin)
 */
function requireTenantRole(allowedRoles = ['owner']) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required.' });
    }

    if (!allowedRoles.includes(req.tenantRole)) {
      return res.status(403).json({
        success: false,
        error: `Insufficient permissions. Requires one of: ${allowedRoles.join(', ')} (Your role: ${req.tenantRole})`
      });
    }

    next();
  };
}

module.exports = {
  tenantContextMiddleware,
  requireAuth,
  requireTenantRole
};
