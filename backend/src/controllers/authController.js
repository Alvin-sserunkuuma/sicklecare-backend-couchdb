const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { db } = require("../db/couch");
const AppError = require("../utils/AppError");
const { signToken } = require("../utils/jwt");

const SALT_ROUNDS = 10;

function toAuthResponse(user, patient) {
  return {
    token: signToken({ sub: user.id, role: user.role }),
    user: { id: user.id, email: user.email, role: user.role },
    patient: patient
      ? { id: patient.id, display_name: patient.display_name, genotype: patient.genotype }
      : null,
  };
}

/**
 * POST /api/auth/register (FR-01)
 * Creates a user account and, for patients, an associated (initially
 * minimal) patient profile that can be completed later via PATCH /api/patients/me.
 *
 * The user document's _id is the lowercased email: a CouchDB PUT/insert to
 * an existing _id is rejected with 409, which gives us atomic "email already
 * registered" uniqueness without a separate index or transaction (CouchDB
 * has no multi-document transactions, unlike the Postgres BEGIN/COMMIT used
 * in the original implementation).
 */
async function register(req, res, next) {
  try {
    const { email, password, role = "patient", display_name, genotype } = req.body;
    const userId = email.toLowerCase();

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const now = new Date().toISOString();

    let userDoc;
    try {
      const result = await db.users.insert(
        {
          type: "user",
          email: userId,
          password_hash,
          role,
          created_at: now,
          updated_at: now,
        },
        userId
      );
      userDoc = { _id: result.id, _rev: result.rev };
    } catch (err) {
      if (err.statusCode === 409) {
        return next(new AppError(409, "An account with this email already exists"));
      }
      return next(err);
    }

    const user = { id: userDoc._id, email: userId, role };

    let patient = null;
    if (role === "patient") {
      try {
        const patientId = crypto.randomUUID();
        const complication_score = 0;
        const treatment_intensity = 0;
        await db.patients.insert({
          _id: patientId,
          type: "patient",
          user_id: userId,
          display_name: display_name || null,
          age: null,
          sex: null,
          genotype: genotype || "HbSS",
          on_hydroxyurea: false,
          stroke_occurred: false,
          splenic_sequestration_history: false,
          acs_episodes_per_year: 0,
          penicillin_prophylaxis: false,
          has_regular_pain_medications: false,
          chronic_transfusions: false,
          malaria_episodes_per_year: 0,
          complication_score,
          treatment_intensity,
          created_at: now,
          updated_at: now,
        });
        patient = { id: patientId, display_name: display_name || null, genotype: genotype || "HbSS" };
      } catch (err) {
        try {
          await db.users.destroy(userDoc._id, userDoc._rev);
        } catch (cleanupErr) {
          // best-effort cleanup
        }
        return next(err);
      }
    }

    if (role === "caregiver") {
      // Activate any pending caregiver_links a patient already created for
      // this email address, so access works immediately on first login.
      const pending = await db.caregiverLinks.find({
        selector: { caregiver_email: userId, status: "pending" },
        limit: 1000,
      });
      const acceptedAt = new Date().toISOString();
      for (const link of pending.docs) {
        link.caregiver_user_id = userId;
        link.status = "active";
        link.accepted_at = acceptedAt;
        await db.caregiverLinks.insert(link);
      }
    }

    res.status(201).json(toAuthResponse(user, patient));
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/auth/login (FR-01)
 */
async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const userId = email.toLowerCase();

    let userDoc;
    try {
      userDoc = await db.users.get(userId);
    } catch (err) {
      if (err.statusCode === 404) throw new AppError(401, "Invalid email or password");
      throw err;
    }

    const ok = await bcrypt.compare(password, userDoc.password_hash);
    if (!ok) {
      throw new AppError(401, "Invalid email or password");
    }

    const user = { id: userDoc._id, email: userDoc.email, role: userDoc.role };

    // Activate any pending caregiver links on login too, not just on
    // registration - handles the case where the patient sent the invite after
    // the caregiver already had an account.
    if (userDoc.role === "caregiver") {
      const pending = await db.caregiverLinks.find({
        selector: { caregiver_email: userId, status: "pending" },
        limit: 1000,
      });
      const acceptedAt = new Date().toISOString();
      for (const link of pending.docs) {
        link.caregiver_user_id = userId;
        link.status = "active";
        link.accepted_at = acceptedAt;
        await db.caregiverLinks.insert(link);
      }
    }

    let patient = null;
    const found = await db.patients.find({ selector: { user_id: userDoc._id }, limit: 1 });
    if (found.docs.length > 0) {
      const p = found.docs[0];
      patient = { id: p._id, display_name: p.display_name, genotype: p.genotype };
    }

    res.json(toAuthResponse(user, patient));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/auth/me
 */
async function me(req, res, next) {
  try {
    res.json({ user: req.user });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, me };
