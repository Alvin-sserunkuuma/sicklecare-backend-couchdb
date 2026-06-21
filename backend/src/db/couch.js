// CouchDB connection (Layer 5 - Data and External Services).
//
// Each "table" from the Postgres version becomes its own CouchDB database.
// Documents that need upsert / uniqueness semantics use deterministic _ids
// instead of SQL UNIQUE constraints + ON CONFLICT (see db/setup.js for the
// full data-model notes).
const nano = require('nano');

const COUCHDB_URL =
	process.env.COUCHDB_URL || 'http://sicklecare:sicklecare@localhost:5984';
const PREFIX = process.env.COUCHDB_DB_PREFIX || 'sicklecare_';

const couch = nano(COUCHDB_URL);

const DB_NAMES = {
	users: `${PREFIX}users`,
	patients: `${PREFIX}patients`,
	symptomLogs: `${PREFIX}symptom_logs`,
	riskAssessments: `${PREFIX}risk_assessments`,
	wearableConnections: `${PREFIX}wearable_connections`,
	syncLog: `${PREFIX}sync_log`,
	painCrises: `${PREFIX}pain_crises`,
	caregiverLinks: `${PREFIX}caregiver_links`,
};

const db = {
	users: couch.db.use(DB_NAMES.users),
	patients: couch.db.use(DB_NAMES.patients),
	symptomLogs: couch.db.use(DB_NAMES.symptomLogs),
	riskAssessments: couch.db.use(DB_NAMES.riskAssessments),
	wearableConnections: couch.db.use(DB_NAMES.wearableConnections),
	syncLog: couch.db.use(DB_NAMES.syncLog),
	painCrises: couch.db.use(DB_NAMES.painCrises),
	caregiverLinks: couch.db.use(DB_NAMES.caregiverLinks),
};

module.exports = { couch, db, DB_NAMES };
