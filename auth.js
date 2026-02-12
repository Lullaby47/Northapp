// auth.js
const jwt = require("jsonwebtoken");
const db = require("./db");

function clearAuthCookie(res) {
  res.clearCookie("auth", { path: "/" });
}

function requireAuth(req, res, next) {
  const cookieToken = req.cookies?.auth;

  const allowHeader = String(process.env.ALLOW_AUTH_HEADER || "false").toLowerCase() === "true";
  const header = req.headers.authorization || "";
  const headerToken = allowHeader && header.startsWith("Bearer ") ? header.slice(7) : null;

  const token = cookieToken || headerToken;
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload || typeof payload.sub !== "number" || !payload.username) {
      clearAuthCookie(res);
      return res.status(401).json({ error: "Invalid session" });
    }
    
    // Check if user is banned
    const user = db.prepare("SELECT is_banned FROM users WHERE id = ?").get(payload.sub);
    if (user && user.is_banned) {
      clearAuthCookie(res);
      return res.status(403).json({ error: "Account is banned" });
    }
    
    req.user = payload;
    next();
  } catch {
    clearAuthCookie(res);
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

function requireAdmin(req, res, next) {
  // First check authentication
  requireAuth(req, res, () => {
    const userId = req.user.sub;
    
    // Get user from database to check role
    const user = db.prepare("SELECT id, role, is_banned FROM users WHERE id = ?").get(userId);
    
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Check if banned
    if (user.is_banned) {
      return res.status(403).json({ error: "Account is banned" });
    }
    
    // Admin is id=1 OR role='admin'
    if (user.id !== 1 && user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    
    req.adminUser = user;
    next();
  });
}

function requireAnyRole(...allowedRoles) {
  return (req, res, next) => {
    requireAuth(req, res, () => {
      const userId = req.user.sub;
      
      // Get user from database to check role
      const user = db.prepare("SELECT id, role, is_banned FROM users WHERE id = ?").get(userId);
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Check if banned
      if (user.is_banned) {
        return res.status(403).json({ error: "Account is banned" });
      }
      
      // Check if user has one of the allowed roles
      // Admin (id=1) always has access
      const hasAccess = user.id === 1 || allowedRoles.includes(user.role);
      
      if (!hasAccess) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
      
      req.userRole = user.role;
      next();
    });
  };
}

module.exports = { requireAuth, requireAdmin, requireAnyRole };
