const { db } = require("../db/couch");
const AppError = require("../utils/AppError");

const PATIENT_FIELDS = [
  "display_name",
  "age",
  "sex",
  "genotype",
  "on_hydroxyurea",
  "stroke_occurred",
  "splenic_sequestration_history",
  "acs_episodes_per_year",
  "penicillin_prophylaxis",
  "has_regular_pain_medications",
  "chronic_transfusions",
  "malaria_episodes_per_year",
];

/**
 * Recomputes the engineered features (report 4.7.1) from a patient document.
 * Postgres did this via a BEFORE INSERT/UPDATE trigger; CouchDB has no
 * trigger equivalent, so it's recomputed in application code on every write.
 *
 * complication_score (0-3) = stroke + splenic sequestration + (ACS episodes > 0)
 * treatment_intensity (0-4) = hydroxyurea + penicillin + pain meds + transfusions
 */
function withEngineeredFeatures(doc) {
  doc.complication_score =
    (doc.stroke_occurred ? 1 : 0) +
    (doc.splenic_sequestration_history ? 1 : 0) +
    (Number(doc.acs_episodes_per_year) > 0 ? 1 : 0);

  doc.treatment_intensity =
    (doc.on_hydroxyurea ? 1 : 0) +
    (doc.penicillin_prophylaxis ? 1 : 0) +
    (doc.has_regular_pain_medications ? 1 : 0) +
    (doc.chronic_transfusions ? 1 : 0);

  return doc;
}

/** Strips CouchDB-internal fields and renames _id -> id for API responses. */
function toApi(doc) {
  // eslint-disable-next-line no-unused-vars
  const { _id, _rev, type, ...rest } = doc;
  return { id: _id, ...rest };
}

/**
 * GET /api/patients/me (FR-01)
 * Returns the clinical profile for the authenticated patient.
 */
async function getMe(req, res, next) {
  try {
    if (!req.user.patientId) {
      throw new AppError(404, "No patient profile for this account");
    }

    let doc;
    try {
      doc = await db.patients.get(req.user.patientId);
    } catch (err) {
      if (err.statusCode === 404) throw new AppError(404, "Patient profile not found");
      throw err;
    }

    res.json(toApi(doc));
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/patients/me (FR-01)
 * Partially updates the patient's clinical profile. complication_score and
 * treatment_intensity are recomputed automatically (see withEngineeredFeatures).
 */
async function updateMe(req, res, next) {
  try {
    if (!req.user.patientId) {
      throw new AppError(404, "No patient profile for this account");
    }

    const updates = {};
    for (const field of PATIENT_FIELDS) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      throw new AppError(400, "No valid fields provided");
    }

    let doc;
    try {
      doc = await db.patients.get(req.user.patientId);
    } catch (err) {
      if (err.statusCode === 404) throw new AppError(404, "Patient profile not found");
      throw err;
    }

    Object.assign(doc, updates);
    doc.updated_at = new Date().toISOString();
    withEngineeredFeatures(doc);

    const result = await db.patients.insert(doc);
    doc._rev = result.rev;

    res.json(toApi(doc));
  } catch (err) {
    next(err);
  }
}

module.exports = { getMe, updateMe, PATIENT_FIELDS, withEngineeredFeatures, toApi };
