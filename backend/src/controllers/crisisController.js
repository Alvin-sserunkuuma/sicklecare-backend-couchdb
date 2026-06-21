const crypto = require("crypto");
const { db } = require("../db/couch");
const AppError = require("../utils/AppError");

const CRISIS_FIELDS = [
  "started_at",
  "ended_at",
  "severity",
  "locations",
  "triggers",
  "actions_taken",
  "medications_taken",
  "notes",
  "resolved",
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
 * GET /api/crises
 * Lists the authenticated patient's pain crisis logs, most recent first.
 * Query params: from, to (ISO timestamps), limit (default 10, max 100).
 */
async function list(req, res, next) {
  try {
    const patientId = ensurePatient(req);
    const { from, to } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 100);

    const selector = { patient_id: patientId };
    if (from || to) {
      selector.started_at = {};
      if (from) selector.started_at.$gte = from;
      if (to) selector.started_at.$lte = to;
    }

    const result = await db.painCrises.find({ selector, limit: 1000 });
    const docs = result.docs.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));

    res.json(docs.slice(0, limit).map(toApi));
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/crises
 * Logs a new pain crisis episode.
 */
async function create(req, res, next) {
  try {
    const patientId = ensurePatient(req);

    if (req.body.severity === undefined) {
      throw new AppError(400, "severity is required");
    }

    const data = {};
    for (const field of CRISIS_FIELDS) {
      if (req.body[field] !== undefined) data[field] = req.body[field];
    }
    data.started_at = data.started_at || new Date().toISOString();
    if (data.resolved === undefined) data.resolved = false;

    const doc = {
      _id: crypto.randomUUID(),
      type: "pain_crisis",
      patient_id: patientId,
      created_at: new Date().toISOString(),
      ...data,
    };

    const result = await db.painCrises.insert(doc);
    doc._rev = result.rev;

    res.status(201).json(toApi(doc));
  } catch (err) {
    next(err);
  }
}

async function getDoc(id, patientId) {
  let doc;
  try {
    doc = await db.painCrises.get(id);
  } catch (err) {
    if (err.statusCode === 404) throw new AppError(404, "Crisis log not found");
    throw err;
  }
  if (doc.patient_id !== patientId) throw new AppError(404, "Crisis log not found");
  return doc;
}

/**
 * GET /api/crises/:id
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
 * PATCH /api/crises/:id
 * Used to update severity/notes, mark resolved, or record an end time.
 */
async function update(req, res, next) {
  try {
    const patientId = ensurePatient(req);

    const updates = {};
    for (const field of CRISIS_FIELDS) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (Object.keys(updates).length === 0) throw new AppError(400, "No valid fields provided");

    const doc = await getDoc(req.params.id, patientId);
    Object.assign(doc, updates);

    const result = await db.painCrises.insert(doc);
    doc._rev = result.rev;

    res.json(toApi(doc));
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/crises/:id
 */
async function remove(req, res, next) {
  try {
    const patientId = ensurePatient(req);
    const doc = await getDoc(req.params.id, patientId);
    await db.painCrises.destroy(doc._id, doc._rev);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, getOne, update, remove, CRISIS_FIELDS, toApi };
