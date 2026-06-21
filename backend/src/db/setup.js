// ════════════════════════════════════════════════════════════════════════
// SickleCare CouchDB setup (Layer 5 - Data and External Services)
//
// CouchDB equivalent of schema.sql / migrate.js from the Postgres version.
// Creates one database per "table" and the Mango indexes the controllers
// rely on. Run with `npm run setup` (or automatically via docker-compose).
//
// ── Document model ─────────────────────────────────────────────────────
//
// sicklecare_users            { _id: <lowercased email>, type: "user",
//                                email, password_hash, role,
//                                created_at, updated_at }
//   _id = email gives free, atomic uniqueness (CouchDB rejects a PUT to an
//   existing _id with 409) - no UNIQUE constraint / index needed.
//
// sicklecare_patients         { _id: <uuid>, type: "patient", user_id,
//                                display_name, age, sex, genotype,
//                                on_hydroxyurea, stroke_occurred,
//                                splenic_sequestration_history,
//                                acs_episodes_per_year, penicillin_prophylaxis,
//                                has_regular_pain_medications,
//                                chronic_transfusions, malaria_episodes_per_year,
//                                complication_score, treatment_intensity,
//                                created_at, updated_at }
//   Mango index on `user_id` (1 user -> 1 patient profile lookup).
//   complication_score / treatment_intensity are recomputed in application
//   code on every write (no DB trigger equivalent in CouchDB).
//
// sicklecare_symptom_logs     { _id: "<patient_id>::<log_date>::<source>",
//                                type: "symptom_log", patient_id, log_date,
//                                pain_score, fatigue_score, water_intake_litres,
//                                sleep_hours, sleep_quality, hydration_ok, mood,
//                                activity_level, infection_present, heart_rate,
//                                spo2, skin_temp_c, steps_today, source,
//                                synced, created_at }
//   The deterministic _id replaces the Postgres
//   UNIQUE (patient_id, log_date, source) constraint + ON CONFLICT upsert:
//   "PUT this _id" IS the upsert. Mango index on (patient_id, log_date) for
//   range queries (GET /api/symptoms?from=&to=).
//
// sicklecare_risk_assessments { _id: <uuid>, type: "risk_assessment",
//                                patient_id, log_id, baseline_risk,
//                                class_proba, daily_modifier,
//                                voc_probability_30d, data_source,
//                                recommendations, created_at }
//   Mango index on (patient_id, created_at) for history/latest queries.
//
// sicklecare_wearable_connections { _id: "wearable::<patient_id>",
//                                type: "wearable_connection", patient_id,
//                                provider, access_token, refresh_token,
//                                expires_at, connected_at, updated_at }
//   Deterministic _id gives the 1:1 patient<->connection relationship for free.
//
// sicklecare_sync_log         { _id: <uuid>, type: "sync_record", patient_id,
//                                table_name, record_id, payload,
//                                client_updated_at, status, error, applied_id,
//                                created_at, processed_at }
//   CouchDB equivalent of the sync_queue audit table. Mango index on
//   (patient_id, status, created_at).
//
// sicklecare_pain_crises       { _id: <uuid>, type: "pain_crisis", patient_id,
//                                started_at, ended_at, severity, locations,
//                                triggers, actions_taken, medications_taken,
//                                notes, resolved, created_at }
//   Mango index on (patient_id, started_at) for history queries
//   (GET /api/crises?from=&to=).
//
// sicklecare_caregiver_links   { _id: "<patient_id>::<caregiver_email>",
//                                type: "caregiver_link", patient_id,
//                                caregiver_email, caregiver_user_id,
//                                status: "pending"|"active"|"revoked",
//                                invited_at, accepted_at }
//   The deterministic _id replaces the Postgres
//   UNIQUE (patient_id, caregiver_email) constraint + ON CONFLICT upsert.
//   Mango indexes on `patient_id` (patient-side list), and on
//   (caregiver_user_id, status) / (caregiver_email, status) for the
//   caregiver-side lookup and for activating pending links on registration.
//
// NOTE on "native" CouchDB sync: a production CouchDB deployment would
// typically skip this audit-log + REST batch endpoint altogether and instead
// give each mobile client a filtered/per-user database that PouchDB
// replicates against directly via `pouchDB.sync(remote, {live: true})`,
// using CouchDB's built-in _changes feed + revision-based conflict
// detection. /api/sync here is kept for API parity with the Postgres
// version (and so the same mobile client code can target either backend),
// but see ../../README.md and ../../../COMPARISON.md for the native-sync
// alternative.
// ════════════════════════════════════════════════════════════════════════

require("dotenv").config();
const { couch, DB_NAMES, db } = require("./couch");

async function ensureDb(name) {
  try {
    await couch.db.create(name);
    console.log(`✓ created database ${name}`);
  } catch (err) {
    if (err.statusCode === 412) {
      console.log(`- database ${name} already exists`);
    } else {
      throw err;
    }
  }
}

async function ensureIndex(database, label, index) {
  await database.createIndex(index);
  console.log(`✓ ensured index ${label}`);
}

async function setup() {
  for (const name of Object.values(DB_NAMES)) {
    await ensureDb(name);
  }

  await ensureIndex(db.patients, "patients(user_id)", {
    index: { fields: ["user_id"] },
    name: "by_user_id",
  });

  // Used by GET /api/clinician/patients (FR-08) to list every patient
  // profile for the roster view.
  await ensureIndex(db.patients, "patients(type)", {
    index: { fields: ["type"] },
    name: "by_type",
  });

  // Used by GET /api/clinician/patients (FR-08) to compute each patient's
  // most recent risk assessment for the roster/alerts views.
  await ensureIndex(db.riskAssessments, "risk_assessments(type)", {
    index: { fields: ["type"] },
    name: "by_type",
  });

  await ensureIndex(db.symptomLogs, "symptom_logs(patient_id, log_date)", {
    index: { fields: ["patient_id", "log_date"] },
    name: "by_patient_date",
  });

  await ensureIndex(db.riskAssessments, "risk_assessments(patient_id, created_at)", {
    index: { fields: ["patient_id", "created_at"] },
    name: "by_patient_created",
  });

  await ensureIndex(db.syncLog, "sync_log(patient_id, status, created_at)", {
    index: { fields: ["patient_id", "status", "created_at"] },
    name: "by_patient_status_created",
  });

  await ensureIndex(db.painCrises, "pain_crises(patient_id, started_at)", {
    index: { fields: ["patient_id", "started_at"] },
    name: "by_patient_started",
  });

  await ensureIndex(db.caregiverLinks, "caregiver_links(patient_id)", {
    index: { fields: ["patient_id"] },
    name: "by_patient",
  });

  await ensureIndex(db.caregiverLinks, "caregiver_links(caregiver_user_id, status)", {
    index: { fields: ["caregiver_user_id", "status"] },
    name: "by_caregiver_user_status",
  });

  await ensureIndex(db.caregiverLinks, "caregiver_links(caregiver_email, status)", {
    index: { fields: ["caregiver_email", "status"] },
    name: "by_caregiver_email_status",
  });

  console.log("✓ CouchDB setup complete");
}

if (require.main === module) {
  setup().catch((err) => {
    console.error("Setup failed:", err.message);
    process.exitCode = 1;
  });
}

module.exports = { setup };
