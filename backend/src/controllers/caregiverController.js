const { db } = require("../db/couch");
const AppError = require("../utils/AppError");

/** Shapes a caregiver_link document for the patient-side API responses. */
function toApi(doc) {
  return {
    id: doc._id,
    caregiver_email: doc.caregiver_email,
    status: doc.status,
    invited_at: doc.invited_at,
    accepted_at: doc.accepted_at || null,
  };
}

function ensurePatient(req) {
  if (!req.user.patientId) {
    throw new AppError(404, "No patient profile for this account");
  }
  return req.user.patientId;
}

/**
 * Deterministic document _id for a (patient, caregiver_email) link. Replaces
 * the Postgres UNIQUE (patient_id, caregiver_email) constraint: "PUT to this
 * _id" is the upsert used by invite().
 */
function linkId(patientId, caregiverEmail) {
  return `${patientId}::${caregiverEmail}`;
}

/**
 * GET /api/caregivers
 * Lists everyone the authenticated patient has invited as a caregiver.
 */
async function list(req, res, next) {
  try {
    const patientId = ensurePatient(req);
    const result = await db.caregiverLinks.find({ selector: { patient_id: patientId }, limit: 1000 });
    const docs = result.docs.sort((a, b) => (a.invited_at < b.invited_at ? 1 : -1));
    res.json(docs.map(toApi));
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/caregivers
 * Invites a caregiver by email. If a `role: "caregiver"` account with that
 * email already exists, the link is activated immediately; otherwise it
 * stays "pending" until that person registers with the caregiver role
 * (see authController.register).
 */
async function invite(req, res, next) {
  try {
    const patientId = ensurePatient(req);
    const email = (req.body.email || "").toLowerCase().trim();

    if (!email) throw new AppError(400, "email is required");
    if (email === req.user.email) throw new AppError(400, "You can't invite yourself");

    let isActive = false;
    try {
      const caregiverUser = await db.users.get(email);
      isActive = caregiverUser.role === "caregiver";
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }

    const _id = linkId(patientId, email);
    const now = new Date().toISOString();

    let doc;
    try {
      doc = await db.caregiverLinks.get(_id);
    } catch (err) {
      if (err.statusCode !== 404) throw err;
      doc = {
        _id,
        type: "caregiver_link",
        patient_id: patientId,
        caregiver_email: email,
        invited_at: now,
        caregiver_user_id: null,
        accepted_at: null,
      };
    }

    if (isActive) {
      doc.caregiver_user_id = email;
      doc.status = "active";
      doc.accepted_at = now;
    } else if (doc.status !== "active") {
      doc.status = "pending";
    }

    const result = await db.caregiverLinks.insert(doc);
    doc._rev = result.rev;

    res.status(201).json(toApi(doc));
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/caregivers/:id
 * Revokes (removes) a caregiver link.
 */
async function remove(req, res, next) {
  try {
    const patientId = ensurePatient(req);

    let doc;
    try {
      doc = await db.caregiverLinks.get(req.params.id);
    } catch (err) {
      if (err.statusCode === 404) throw new AppError(404, "Caregiver link not found");
      throw err;
    }
    if (doc.patient_id !== patientId) throw new AppError(404, "Caregiver link not found");

    await db.caregiverLinks.destroy(doc._id, doc._rev);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = { list, invite, remove, toApi, linkId };
