const { verifyToken } = require("../utils/jwt");
const AppError = require("../utils/AppError");
const { db } = require("../db/couch");

/**
 * Verifies the Bearer JWT and attaches { id, email, role, patientId } to req.user.
 * The token payload only carries the user id / role (NFR-04: no PII in the
 * token); patientId is looked up so downstream controllers can scope queries.
 *
 * `id` (and the JWT `sub`) is the user document's _id, which in this
 * implementation is the lowercased email (see authController.register) -
 * CouchDB's natural-key uniqueness trick in place of a SQL UNIQUE constraint.
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) {
      throw new AppError(401, "Missing or malformed Authorization header");
    }

    let payload;
    try {
      payload = verifyToken(token);
    } catch (err) {
      throw new AppError(401, "Invalid or expired token");
    }

    let user;
    try {
      user = await db.users.get(payload.sub);
    } catch (err) {
      if (err.statusCode === 404) {
        throw new AppError(401, "User no longer exists");
      }
      throw err;
    }

    let patientId = null;
    const found = await db.patients.find({ selector: { user_id: user._id }, limit: 1 });
    if (found.docs.length > 0) {
      patientId = found.docs[0]._id;
    }

    req.user = {
      id: user._id,
      email: user.email,
      role: user.role,
      patientId,
    };

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Restricts a route to one or more roles, e.g. requireRole('clinician', 'admin').
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError(403, "Insufficient permissions"));
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
