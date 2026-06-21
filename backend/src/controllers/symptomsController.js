const { db } = require("../db/couch");
const AppError = require("../utils/AppError");

const LOG_FIELDS = [
  "log_date",
  "pain_score",
  "fatigue_score",
  "water_intake_litres",
  "sleep_hours",
  "sleep_quality",
  "hydration_ok",
  "mood",
  "activity_level",
  "infection_present",
  "heart_rate",
  "spo2",
  "skin_temp_c",
  "steps_today",
  "source",
];

/** Strips CouchDB-internal fields and renames _id -> id for API responses. */
function toApi(doc) {
  // eslint-disable-next-line no-unused-vars
  const { _id, _rev, type, ...rest } = doc;
  return { id: _id, ...rest };
}

function ensurePatient(req) {
  if (!req.user.patientId) {
    throw new AppError(404, "No patient profile for this account");
  }
  return req.user.patientId;
}

/**
 * Deterministic document _id for a (patient, log_date, source) symptom log.
 * Replaces the Postgres UNIQUE (patient_id, log_date, source) constraint:
 * "PUT to this _id" is the upsert.
 */
function logId(patientId, logDate, source) {
  return `${patientId}::${logDate}::${source}`;
}

/**
 * GET /api/symptoms (FR-02)
 * Lists the authenticated patient's symptom logs, most recent first.
 * Query params: from, to (YYYY-MM-DD), source ('manual'|'wearable'), limit (default 30, max 100).
 */
async function list(req, res, next) {
  try {
    const patientId = ensurePatient(req);
    const { from, to, source } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);

    const selector = { patient_id: patientId };
    if (from || to) {
      selector.log_date = {};
      if (from) selector.log_date.$gte = from;
      if (to) selector.log_date.$lte = to;
    }

    // Mango find() defaults to 25 results and doesn't support the
    // ORDER BY log_date DESC, created_at DESC + LIMIT used in the Postgres
    // version without a matching compound index, so we over-fetch and
    // sort/paginate in application code.
    const result = await db.symptomLogs.find({ selector, limit: 1000 });

    let docs = result.docs;
    if (source) docs = docs.filter((d) => d.source === source);
    docs.sort((a, b) => {
      if (a.log_date !== b.log_date) return a.log_date < b.log_date ? 1 : -1;
      return a.created_at < b.created_at ? 1 : -1;
    });

    res.json(docs.slice(0, limit).map(toApi));
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/symptoms (FR-02/03)
 * Creates or updates the log for (patient, log_date, source) - the
 * deterministic _id makes this an idempotent upsert, so offline clients can
 * safely resend the same day's entry.
 */
async function create(req, res, next) {
  try {
    const patientId = ensurePatient(req);

    const data = {};
    for (const field of LOG_FIELDS) {
      if (req.body[field] !== undefined) data[field] = req.body[field];
    }
    data.log_date = data.log_date || new Date().toISOString().slice(0, 10);
    data.source = data.source || "manual";

    const _id = logId(patientId, data.log_date, data.source);

    let doc;
    try {
      doc = await db.symptomLogs.get(_id);
    } catch (err) {
      if (err.statusCode !== 404) throw err;
      doc = {
        _id,
        type: "symptom_log",
        patient_id: patientId,
        infection_present: false,
        created_at: new Date().toISOString(),
      };
    }

    Object.assign(doc, data);
    doc.synced = true;

    const result = await db.symptomLogs.insert(doc);
    doc._rev = result.rev;

    res.status(201).json(toApi(doc));
  } catch (err) {
    next(err);
  }
}

async function getDoc(id, patientId) {
  let doc;
  try {
    doc = await db.symptomLogs.get(id);
  } catch (err) {
    if (err.statusCode === 404) throw new AppError(404, "Symptom log not found");
    throw err;
  }
  if (doc.patient_id !== patientId) throw new AppError(404, "Symptom log not found");
  return doc;
}

/**
 * GET /api/symptoms/:id
 */
async function getOne(req, res, next) {
  try {
    const patientId = ensurePatient(req);
    const doc = await getDoc(req.params.id, patientId);
    res.json(toApi(doc));
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/symptoms/:id
 */
async function update(req, res, next) {
  try {
    const patientId = ensurePatient(req);

    const updates = {};
    for (const field of LOG_FIELDS) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (Object.keys(updates).length === 0) throw new AppError(400, "No valid fields provided");

    const doc = await getDoc(req.params.id, patientId);

    // log_date / source are baked into _id - changing them would require a
    // new document (delete + recreate), which we don't support via PATCH.
    delete updates.log_date;
    delete updates.source;

    Object.assign(doc, updates);
    const result = await db.symptomLogs.insert(doc);
    doc._rev = result.rev;

    res.json(toApi(doc));
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/symptoms/:id
 */
async function remove(req, res, next) {
  try {
    const patientId = ensurePatient(req);
    const doc = await getDoc(req.params.id, patientId);
    await db.symptomLogs.destroy(doc._id, doc._rev);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, getOne, update, remove, LOG_FIELDS, logId, toApi };
