const crypto = require("crypto");
const axios = require("axios");
const { db } = require("../db/couch");
const AppError = require("../utils/AppError");
const { logId } = require("./symptomsController");

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || "http://localhost:8000";
const ML_TIMEOUT_MS = 10000;

function ensurePatient(req) {
  if (!req.user.patientId) {
    throw new AppError(404, "No patient profile for this account");
  }
  return req.user.patientId;
}

function toApi(doc) {
  // eslint-disable-next-line no-unused-vars
  const { _id, _rev, type, ...rest } = doc;
  return { id: _id, ...rest };
}

async function getPatientProfile(patientId) {
  try {
    return await db.patients.get(patientId);
  } catch (err) {
    if (err.statusCode === 404) throw new AppError(404, "Patient profile not found");
    throw err;
  }
}

/** Maps a `patients` document onto the ML service's PatientProfile schema. */
function profileToMlPayload(p) {
  return {
    genotype: p.genotype,
    on_hydroxyurea: p.on_hydroxyurea,
    stroke_occurred: p.stroke_occurred,
    splenic_sequestration_history: p.splenic_sequestration_history,
    acs_episodes_per_year: Number(p.acs_episodes_per_year),
    penicillin_prophylaxis: p.penicillin_prophylaxis,
    has_regular_pain_medications: p.has_regular_pain_medications,
    chronic_transfusions: p.chronic_transfusions,
    malaria_episodes_per_year: Number(p.malaria_episodes_per_year),
  };
}

/** Maps a wearable-sourced symptom_log document onto the ML WearableReading schema. */
function logToWearablePayload(log) {
  const out = {};
  if (log.spo2 != null) out.avg_spo2 = Number(log.spo2);
  if (log.heart_rate != null) out.avg_heart_rate = Number(log.heart_rate);
  if (log.skin_temp_c != null) out.skin_temp_c = Number(log.skin_temp_c);
  if (log.steps_today != null) out.steps_today = Number(log.steps_today);
  if (log.sleep_hours != null) out.sleep_hours = Number(log.sleep_hours);
  return out;
}

/**
 * Maps a manual symptom_log document onto the ML ManualLog schema.
 * Only pain_score is required (it's a slider so always present). Other
 * fields default to neutral values when absent so partial logs still
 * contribute to the daily modifier instead of falling back to profile_only.
 */
function logToManualPayload(log) {
  if (log.pain_score == null) return null;
  return {
    pain_today: log.pain_score,
    sleep_quality: log.sleep_quality ?? 1,   // default: OK
    hydration_ok: log.hydration_ok ?? false, // default: assume not hydrated (conservative)
    mood: log.mood ?? 1,                     // default: OK
    activity_level: log.activity_level ?? 1, // default: OK
  };
}

async function getLog(id) {
  try {
    return await db.symptomLogs.get(id);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

/**
 * Resolves which (wearable | manual_log) data to send to the ML service,
 * based on the request body or, failing that, today's symptom logs.
 * Returns { wearable, manual_log, logId }.
 *
 * Because symptom_logs use the deterministic _id
 * "<patient_id>::<log_date>::<source>" (see symptomsController.logId),
 * "today's wearable/manual log" can be fetched with two direct document
 * GETs instead of the ORDER BY ... LIMIT query the Postgres version needed.
 */
async function resolveDailyInput(req, patientId) {
  if (req.body.wearable) {
    return { wearable: req.body.wearable, manual_log: undefined, logId: null };
  }
  if (req.body.manual_log) {
    return { wearable: undefined, manual_log: req.body.manual_log, logId: null };
  }
  if (req.body.log_id) {
    const log = await getLog(req.body.log_id);
    if (!log || log.patient_id !== patientId) throw new AppError(404, "Symptom log not found");
    if (log.source === "wearable") {
      return { wearable: logToWearablePayload(log), manual_log: undefined, logId: log._id };
    }
    return { wearable: undefined, manual_log: logToManualPayload(log) || undefined, logId: log._id };
  }

  const today = new Date().toISOString().slice(0, 10);

  const wearableLog = await getLog(logId(patientId, today, "wearable"));
  if (wearableLog) {
    return { wearable: logToWearablePayload(wearableLog), manual_log: undefined, logId: wearableLog._id };
  }

  const manualLog = await getLog(logId(patientId, today, "manual"));
  if (manualLog) {
    const manual_log = logToManualPayload(manualLog);
    if (manual_log) return { wearable: undefined, manual_log, logId: manualLog._id };
  }

  return { wearable: undefined, manual_log: undefined, logId: null };
}

async function callMlService(payload) {
  try {
    const { data } = await axios.post(`${ML_SERVICE_URL}/predict`, payload, { timeout: ML_TIMEOUT_MS });
    return data;
  } catch (err) {
    if (err.response) {
      throw new AppError(502, "Prediction service rejected the request", err.response.data);
    }
    throw new AppError(503, "Prediction service unavailable");
  }
}

/**
 * POST /api/predictions (FR-04/05/06)
 * Body (all optional): { log_id } | { wearable: {...} } | { manual_log: {...} }
 * Runs the two-layer model and persists the result to risk_assessments.
 */
async function create(req, res, next) {
  try {
    const patientId = ensurePatient(req);
    const profile = await getPatientProfile(patientId);
    const { wearable, manual_log, logId: resolvedLogId } = await resolveDailyInput(req, patientId);

    const result = await callMlService({
      profile: profileToMlPayload(profile),
      wearable,
      manual_log,
    });

    const doc = {
      _id: crypto.randomUUID(),
      type: "risk_assessment",
      patient_id: patientId,
      log_id: resolvedLogId,
      baseline_risk: result.risk_class,
      class_proba: result.class_proba,
      baseline_annual_rate: result.baseline_annual_rate,
      daily_modifier: result.daily_modifier,
      voc_probability_30d: result.voc_probability_30d,
      data_source: result.data_source,
      advice: result.advice,
      explanation: result.explanation,
      reasons: Array.isArray(result.reasons) ? result.reasons : [],
      recommendations: Array.isArray(result.tips) ? result.tips : [],
      created_at: new Date().toISOString(),
    };
    const inserted = await db.riskAssessments.insert(doc);
    doc._rev = inserted.rev;

    res.status(201).json(toApi(doc));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/predictions (FR-05)
 * History of past risk assessments, most recent first.
 */
async function list(req, res, next) {
  try {
    const patientId = ensurePatient(req);
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);

    const result = await db.riskAssessments.find({ selector: { patient_id: patientId }, limit: 1000 });
    const docs = result.docs.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

    res.json(docs.slice(0, limit).map(toApi));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/predictions/latest (FR-06)
 */
async function latest(req, res, next) {
  try {
    const patientId = ensurePatient(req);
    const result = await db.riskAssessments.find({ selector: { patient_id: patientId }, limit: 1000 });
    if (result.docs.length === 0) throw new AppError(404, "No risk assessments yet");

    const docs = result.docs.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    res.json(toApi(docs[0]));
  } catch (err) {
    next(err);
  }
}

module.exports = { create, list, latest };
