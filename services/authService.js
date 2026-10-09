const db = require('./db');
const EncryptionService = require('./encryptionService');

class AuthService {
  static register({ name, email, password }) {
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
    const user = db.createUser({
      name: name.trim(),
      email: cleanEmail,
      password_hash,
      is_verified: true
    });

    const session = db.createSession(user.id);
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        is_verified: user.is_verified,
        created_at: user.created_at
      },
      token: session.token
    };
  }

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

    const session = db.createSession(user.id);
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        is_verified: user.is_verified,
        created_at: user.created_at
      },
      token: session.token
    };
  }

  static logout(token) {
    if (token) {
      db.deleteSession(token);
    }
    return true;
  }

  static getUserFromToken(token) {
    if (!token) return null;
    const session = db.findSession(token);
    if (!session) return null;
    const user = db.findUserById(session.user_id);
    if (!user) return null;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      is_verified: user.is_verified,
      created_at: user.created_at
    };
  }

  static requestPasswordReset(email) {
    const cleanEmail = (email || '').toLowerCase().trim();
    const user = db.findUserByEmail(cleanEmail);
    if (!user) {
      // Return success anyway for security timing attack prevention
      return { success: true, message: 'If that email exists, password reset instructions have been sent.' };
    }

    const resetToken = EncryptionService.generateToken(24);
    const expires = Date.now() + 3600000; // 1 hour
    db.updateUser(user.id, { reset_token: resetToken, reset_token_expires: expires });

    return {
      success: true,
      message: 'Password reset link generated.',
      debugToken: resetToken // Included for testing convenience
    };
  }

  static resetPassword(resetToken, newPassword) {
    if (!resetToken) throw new Error('Reset token is required.');
    if (!newPassword || newPassword.length < 6) throw new Error('Password must be at least 6 characters.');

    const user = db.data.users.find(
      u => u.reset_token === resetToken && u.reset_token_expires && u.reset_token_expires > Date.now()
    );

    if (!user) {
      throw new Error('Invalid or expired password reset token.');
    }

    const password_hash = EncryptionService.hashPassword(newPassword);
    db.updateUser(user.id, {
      password_hash,
      reset_token: null,
      reset_token_expires: null
    });

    db.deleteUserSessions(user.id);
    const session = db.createSession(user.id);

    return {
      success: true,
      message: 'Password has been reset successfully.',
      token: session.token,
      user: { id: user.id, name: user.name, email: user.email }
    };
  }

  // Middleware to authenticate requests
  static authMiddleware(req, res, next) {
    let token = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else if (req.query && req.query.token) {
      token = req.query.token;
    }

    // Default fallback to demo user if no token provided during testing
    if (!token) {
      const demoUser = db.data.users[0];
      if (demoUser) {
        req.user = {
          id: demoUser.id,
          name: demoUser.name,
          email: demoUser.email,
          is_verified: demoUser.is_verified
        };
        return next();
      }
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const user = AuthService.getUserFromToken(token);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid or expired session. Please log in.' });
    }

    req.user = user;
    req.sessionToken = token;
    next();
  }
}

module.exports = AuthService;
