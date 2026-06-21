const { db } = require("../db/couch");
const AppError = require("../utils/AppError");

/** Strips CouchDB-internal fields and renames _id -> id for API responses. */
function toApi(doc) {
  // eslint-disable-next-line no-unused-vars
  const { _id, _rev, type, ...rest } = doc;
  return { id: _id, ...rest };
}

/** Shape of the "latest risk" summary embedded in roster/detail responses. */
function toRiskSummary(assessment) {
  if (!assessment) return null;
  return {
    id: assessment._id,
    risk_class: assessment.baseline_risk,
    class_proba: assessment.class_proba,
    voc_probability_30d: assessment.voc_probability_30d,
    daily_modifier: assessment.daily_modifier,
    data_source: assessment.data_source,
    created_at: assessment.created_at,
  };
}

/**
 * Fetches every risk_assessment document and groups the most recent one per
 * patient_id. Mirrors the over-fetch-and-sort approach used in
 * predictionsController (Mango find() over risk_assessments has no
 * per-patient "top 1" query without a view/index per patient).
 */
async function latestRiskByPatient() {
  const result = await db.riskAssessments.find({ selector: { type: "risk_assessment" }, limit: 10000 });
  const latest = new Map();
  for (const doc of result.docs) {
    const existing = latest.get(doc.patient_id);
    if (!existing || doc.created_at > existing.created_at) {
      latest.set(doc.patient_id, doc);
    }
  }
  return latest;
}

/**
 * GET /api/clinician/patients
 * Roster of every patient in the system (clinician role - no per-patient
 * assignment yet, see db/setup.js notes), each annotated with their most
 * recent risk assessment so the list can be sorted/flagged by risk.
 */
async function listPatients(req, res, next) {
  try {
    const result = await db.patients.find({ selector: { type: "patient" }, limit: 10000 });
    const latestRisk = await latestRiskByPatient();

    const patients = result.docs.map((doc) => ({
      ...toApi(doc),
      latest_risk: toRiskSummary(latestRisk.get(doc._id)),
    }));

    // HIGH risk first, then MEDIUM, then LOW/unknown - then by name for
    // a stable, scannable order.
    const RISK_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    patients.sort((a, b) => {
      const ra = RISK_ORDER[a.latest_risk?.risk_class] ?? 3;
      const rb = RISK_ORDER[b.latest_risk?.risk_class] ?? 3;
      if (ra !== rb) return ra - rb;
      return (a.display_name || "").localeCompare(b.display_name || "");
    });

    res.json(patients);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/clinician/patients/:id
 * Full picture for one patient: clinical profile, recent symptom logs, and
 * risk assessment history - everything a clinician needs to review before
 * an appointment or to triage an alert.
 */
async function getPatient(req, res, next) {
  try {
    const { id } = req.params;

    let patientDoc;
    try {
      patientDoc = await db.patients.get(id);
    } catch (err) {
      if (err.statusCode === 404) throw new AppError(404, "Patient not found");
      throw err;
    }
    if (patientDoc.type !== "patient") throw new AppError(404, "Patient not found");

    const [logsResult, riskResult] = await Promise.all([
      db.symptomLogs.find({ selector: { patient_id: id }, limit: 1000 }),
      db.riskAssessments.find({ selector: { patient_id: id }, limit: 1000 }),
    ]);

    const symptomLogs = logsResult.docs
      .sort((a, b) => {
        if (a.log_date !== b.log_date) return a.log_date < b.log_date ? 1 : -1;
        return (a.created_at || "") < (b.created_at || "") ? 1 : -1;
      })
      .slice(0, 30)
      .map(toApi);

    const riskHistory = riskResult.docs
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, 30)
      .map(toApi);

    const latestRisk = riskHistory.length
      ? { ...riskHistory[0], risk_class: riskHistory[0].baseline_risk }
      : null;

    res.json({
      patient: toApi(patientDoc),
      latest_risk: latestRisk,
      symptom_logs: symptomLogs,
      risk_history: riskHistory,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { listPatients, getPatient };
