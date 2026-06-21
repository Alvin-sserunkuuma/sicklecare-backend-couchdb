const crypto = require("crypto");
const { db } = require("../db/couch");
const AppError = require("../utils/AppError");
const { LOG_FIELDS, logId } = require("./symptomsController");
const { PATIENT_FIELDS, withEngineeredFeatures } = require("./patientsController");

const SUPPORTED_TABLES = ["symptom_logs", "patients"];

function ensurePatient(req) {
  if (!req.user.patientId) {
    throw new AppError(404, "No patient profile for this account");
  }
  return req.user.patientId;
}

/**
 * Applies a queued symptom_logs record. Same upsert as
 * symptomsController.create, keyed on the deterministic
 * "<patient_id>::<log_date>::<source>" _id (replaces the Postgres
 * ON CONFLICT (patient_id, log_date, source) upsert).
 */
async function applySymptomLog(patientId, payload) {
  const data = {};
  for (const field of LOG_FIELDS) {
    if (payload[field] !== undefined) data[field] = payload[field];
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

  await db.symptomLogs.insert(doc);
  return doc._id;
}

/** Applies a queued patients profile update (subset of PATIENT_FIELDS). */
async function applyPatientUpdate(patientId, payload) {
  const updates = {};
  for (const field of PATIENT_FIELDS) {
    if (payload[field] !== undefined) updates[field] = payload[field];
  }
  if (Object.keys(updates).length === 0) return patientId;

  let doc;
  try {
    doc = await db.patients.get(patientId);
  } catch (err) {
    if (err.statusCode === 404) throw new AppError(404, "Patient profile not found");
    throw err;
  }

  Object.assign(doc, updates);
  doc.updated_at = new Date().toISOString();
  withEngineeredFeatures(doc);

  await db.patients.insert(doc);
  return patientId;
}

async function applyRecord(patientId, table_name, payload) {
  if (table_name === "symptom_logs") return applySymptomLog(patientId, payload);
  if (table_name === "patients") return applyPatientUpdate(patientId, payload);
  throw new AppError(400, `Unsupported table_name: ${table_name}`);
}

/**
 * POST /api/sync (FR-03/FR-11)
 * Accepts a batch of queued offline records from the mobile app and applies
 * them with last-write-wins semantics (same API contract as the Postgres
 * version's /api/sync, for client compatibility). Each record is logged as
 * a document in sicklecare_sync_log regardless of outcome, so failures are
 * auditable and retryable - the CouchDB equivalent of the sync_queue table.
 *
 * NOTE: this REST batch endpoint is kept for API parity. A CouchDB-native
 * mobile client would more idiomatically skip it entirely and call
 * `pouchDB.sync(remoteCouchDB, {live: true, retry: true})` against a
 * per-patient database, letting CouchDB's replication protocol (the
 * _changes feed + revision trees) handle batching, retries and conflict
 * detection. See GET /api/sync/changes below for a thin demonstration of
 * that primitive, and ../../README.md / ../../../COMPARISON.md for the
 * full discussion.
 */
async function batchSync(req, res, next) {
  try {
    const patientId = ensurePatient(req);
    const records = req.body.records;

    const results = [];
    for (const record of records) {
      const { table_name, record_id, payload, client_updated_at } = record;

      const queueDoc = {
        _id: crypto.randomUUID(),
        type: "sync_record",
        patient_id: patientId,
        table_name,
        record_id: String(record_id),
        payload: payload || {},
        client_updated_at,
        status: "pending",
        error: null,
        applied_id: null,
        created_at: new Date().toISOString(),
        processed_at: null,
      };

      try {
        const appliedId = await applyRecord(patientId, table_name, payload || {});
        queueDoc.status = "applied";
        queueDoc.applied_id = appliedId;
        queueDoc.processed_at = new Date().toISOString();
        await db.syncLog.insert(queueDoc);
        results.push({
          queue_id: queueDoc._id,
          table_name,
          record_id,
          status: "applied",
          applied_id: appliedId,
        });
      } catch (err) {
        const message = err instanceof AppError ? err.message : "Failed to apply record";
        queueDoc.status = "failed";
        queueDoc.error = message;
        queueDoc.processed_at = new Date().toISOString();
        await db.syncLog.insert(queueDoc);
        results.push({ queue_id: queueDoc._id, table_name, record_id, status: "failed", error: message });
      }
    }

    const applied = results.filter((r) => r.status === "applied").length;
    const failed = results.length - applied;
    res.status(207).json({ processed: results.length, applied, failed, results });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/sync/status (FR-03)
 * Summary counts plus the most recent failed entries for troubleshooting.
 */
async function status(req, res, next) {
  try {
    const patientId = ensurePatient(req);

    const result = await db.syncLog.find({ selector: { patient_id: patientId }, limit: 1000 });

    const summary = { pending: 0, applied: 0, failed: 0 };
    for (const doc of result.docs) {
      if (summary[doc.status] !== undefined) summary[doc.status] += 1;
    }

    const recentFailures = result.docs
      .filter((d) => d.status === "failed")
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, 10)
      .map((d) => ({
        id: d._id,
        table_name: d.table_name,
        record_id: d.record_id,
        error: d.error,
        created_at: d.created_at,
        processed_at: d.processed_at,
      }));

    res.json({ ...summary, recent_failures: recentFailures });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/sync/changes (CouchDB-native alternative to /api/sync)
 * Query params: since_symptoms, since_patients (CouchDB update_seq values,
 * default 0 = "from the beginning").
 *
 * Demonstrates the primitive that `pouchDB.sync()` is built on: CouchDB's
 * `_changes` feed. A real PouchDB<->CouchDB deployment would replicate a
 * per-patient (or filtered) database directly and wouldn't need this
 * endpoint at all - this exists so the comparison write-up has something
 * concrete to point at.
 */
async function changes(req, res, next) {
  try {
    const patientId = ensurePatient(req);

    const sinceSymptoms = req.query.since_symptoms || 0;
    const sincePatients = req.query.since_patients || 0;

    const symptomChanges = await db.symptomLogs.changes({
      since: sinceSymptoms,
      include_docs: true,
    });
    const patientChanges = await db.patients.changes({
      since: sincePatients,
      include_docs: true,
    });

    const symptomResults = symptomChanges.results
      .filter((c) => c.doc && c.doc.patient_id === patientId)
      .map((c) => ({ seq: c.seq, id: c.id, deleted: !!c.deleted, doc: c.doc }));

    const patientResults = patientChanges.results
      .filter((c) => c.id === patientId)
      .map((c) => ({ seq: c.seq, id: c.id, deleted: !!c.deleted, doc: c.doc }));

    res.json({
      symptom_logs: { results: symptomResults, last_seq: symptomChanges.last_seq },
      patients: { results: patientResults, last_seq: patientChanges.last_seq },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { batchSync, status, changes, SUPPORTED_TABLES };
