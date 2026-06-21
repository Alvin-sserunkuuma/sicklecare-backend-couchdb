const { db } = require("../db/couch");
const AppError = require("../utils/AppError");

function toPatientApi(p) {
  return {
    id: p._id,
    display_name: p.display_name,
    genotype: p.genotype,
    on_hydroxyurea: p.on_hydroxyurea,
    complication_score: p.complication_score,
    treatment_intensity: p.treatment_intensity,
  };
}

function toRiskApi(r) {
  return {
    baseline_risk: r.baseline_risk,
    class_proba: r.class_proba,
    daily_modifier: r.daily_modifier,
    voc_probability_30d: r.voc_probability_30d,
    recommendations: r.recommendations,
    created_at: r.created_at,
  };
}

function toSymptomApi(l) {
  return {
    log_date: l.log_date,
    pain_score: l.pain_score,
    fatigue_score: l.fatigue_score,
    water_intake_litres: l.water_intake_litres,
    sleep_hours: l.sleep_hours,
    mood: l.mood,
    heart_rate: l.heart_rate,
    spo2: l.spo2,
    source: l.source,
  };
}

function toCrisisApi(c) {
  return {
    id: c._id,
    started_at: c.started_at,
    ended_at: c.ended_at,
    severity: c.severity,
    locations: c.locations,
    triggers: c.triggers,
    actions_taken: c.actions_taken,
    medications_taken: c.medications_taken,
    notes: c.notes,
    resolved: c.resolved,
  };
}

// Fields a caregiver is allowed to fill in/edit on a patient's crisis log.
// Deliberately excludes severity/started_at/ended_at/resolved - those stay
// patient-owned (severity is the one thing the patient logs themselves
// during the crisis).
const CAREGIVER_EDITABLE_CRISIS_FIELDS = ["locations", "triggers", "actions_taken", "medications_taken", "notes"];

// Looks up the active caregiver link for req.user and returns the linked
// patient_id, or throws a 404 AppError if none exists. Shared by
// getMyPatient and updateCrisisDetails.
async function getLinkedPatientId(caregiverUserId) {
  const linkResult = await db.caregiverLinks.find({
    selector: { caregiver_user_id: caregiverUserId, status: "active" },
    limit: 1000,
  });
  if (linkResult.docs.length === 0) {
    throw new AppError(404, "No patient has shared access with you yet");
  }
  const links = linkResult.docs.sort((a, b) => ((a.accepted_at || "") < (b.accepted_at || "") ? 1 : -1));
  return links[0].patient_id;
}

/**
 * GET /api/caregiver/patient
 * Read-only snapshot of the patient who has shared access with the
 * authenticated caregiver: profile basics, latest risk assessment, recent
 * pain crises, and recent symptom check-ins.
 */
async function getMyPatient(req, res, next) {
  try {
    const patientId = await getLinkedPatientId(req.user.id);

    let patient;
    try {
      patient = await db.patients.get(patientId);
    } catch (err) {
      if (err.statusCode === 404) throw new AppError(404, "Patient profile not found");
      throw err;
    }

    const [riskResult, symptomResult, crisisResult] = await Promise.all([
      db.riskAssessments.find({ selector: { patient_id: patientId }, limit: 1000 }),
      db.symptomLogs.find({ selector: { patient_id: patientId }, limit: 1000 }),
      db.painCrises.find({ selector: { patient_id: patientId }, limit: 1000 }),
    ]);

    const risks = riskResult.docs.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const latest_risk = risks.length > 0 ? toRiskApi(risks[0]) : null;

    const symptom_logs = symptomResult.docs
      .sort((a, b) => {
        if (a.log_date !== b.log_date) return a.log_date < b.log_date ? 1 : -1;
        return (a.created_at || "") < (b.created_at || "") ? 1 : -1;
      })
      .slice(0, 7)
      .map(toSymptomApi);

    const crises = crisisResult.docs
      .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
      .slice(0, 5)
      .map(toCrisisApi);

    res.json({ patient: toPatientApi(patient), latest_risk, symptom_logs, crises });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/caregiver/crises/:id
 * Lets a caregiver fill in or edit the qualitative details (locations,
 * triggers, actions taken, medications, notes) of a crisis log belonging to
 * their linked patient. Severity, timestamps, and resolution stay
 * patient-owned and cannot be changed here.
 */
async function updateCrisisDetails(req, res, next) {
  try {
    const patientId = await getLinkedPatientId(req.user.id);

    let doc;
    try {
      doc = await db.painCrises.get(req.params.id);
    } catch (err) {
      if (err.statusCode === 404) throw new AppError(404, "Crisis log not found");
      throw err;
    }
    if (doc.patient_id !== patientId) {
      throw new AppError(404, "Crisis log not found");
    }

    const updates = {};
    for (const field of CAREGIVER_EDITABLE_CRISIS_FIELDS) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (Object.keys(updates).length === 0) {
      throw new AppError(400, "No valid fields provided");
    }

    Object.assign(doc, updates);
    const result = await db.painCrises.insert(doc);
    doc._rev = result.rev;

    res.json(toCrisisApi(doc));
  } catch (err) {
    next(err);
  }
}

module.exports = { getMyPatient, updateCrisisDetails };
