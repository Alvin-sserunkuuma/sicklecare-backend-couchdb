# SickleCare Backend (CouchDB edition)

This is an alternate implementation of the SickleCare backend that swaps
**PostgreSQL** for **Apache CouchDB** as the data store. It re-implements the
same REST API contract as [`../sicklecare-backend`](../sicklecare-backend)
(Layers 2-5 of the architecture: API Gateway, Controllers, Services + ML
Engine, Data + External Services) so the two can be run side by side and
compared. See [`../COMPARISON.md`](../COMPARISON.md) for that comparison.

## Structure

```
sicklecare-backend-couchdb/
├── docker-compose.yml      # couchdb + ml-service + backend
├── backend/                # Node.js / Express API (Layers 2-3)
│   ├── src/
│   │   ├── server.js
│   │   ├── db/
│   │   │   ├── couch.js        # nano connection + per-table db handles
│   │   │   └── setup.js        # creates CouchDB databases + Mango indexes
│   │   ├── routes/
│   │   ├── controllers/
│   │   └── middleware/
│   ├── test/
│   │   ├── mock-couchdb-server.js  # in-memory CouchDB API emulator (test-only)
│   │   └── run_e2e_couch.sh        # end-to-end smoke test
│   ├── package.json
│   ├── .env.example
│   └── Dockerfile
└── ml-service/             # Python / FastAPI ML microservice (Layer 4)
    └── (identical copy of ../sicklecare-backend/ml-service)
```

## Document model

CouchDB has no tables, joins, or multi-document transactions, so each
Postgres table becomes its own CouchDB database, with deterministic `_id`s
used wherever Postgres relied on `UNIQUE` constraints, `ON CONFLICT` upserts,
or 1:1 foreign keys. The full model is documented in
[`backend/src/db/setup.js`](backend/src/db/setup.js); summary:

| Database | `_id` scheme | Replaces (Postgres) |
| --- | --- | --- |
| `sicklecare_users` | lowercased email | `UNIQUE(email)` - a PUT to an existing `_id` is rejected with 409, giving free atomic uniqueness |
| `sicklecare_patients` | uuid | `patients` table; Mango index on `user_id` for the 1:1 user->patient lookup |
| `sicklecare_symptom_logs` | `<patient_id>::<log_date>::<source>` | `UNIQUE(patient_id, log_date, source)` + `ON CONFLICT` upsert - "PUT this `_id`" *is* the upsert |
| `sicklecare_risk_assessments` | uuid | `risk_assessments` table; Mango index on `(patient_id, created_at)` |
| `sicklecare_wearable_connections` | `wearable::<patient_id>` | 1:1 `wearable_connections` row per patient |
| `sicklecare_sync_log` | uuid | `sync_queue` audit table; Mango index on `(patient_id, status, created_at)` |

Other notable deviations from the Postgres version:

- **Engineered features** (`complication_score`, `treatment_intensity`) are
  recomputed in application code (`withEngineeredFeatures` in
  `patientsController.js`) on every patient write, replacing the Postgres
  `BEFORE INSERT/UPDATE` trigger.
- **No cross-document transactions.** Registration creates a `users` doc and
  a `patients` doc as two separate writes; if the second fails, the handler
  performs a compensating delete of the first (`authController.js`).
- **Mango query limits.** CouchDB's default `_find` limit is 25 and sorting
  requires a matching index, so list endpoints over-fetch (`limit: 1000`) and
  sort/filter in application code.

## Running locally

### Option A: Docker (recommended)

```bash
docker compose up --build
```

Brings up CouchDB (port 5984), the ML service (port 8001), and the Express
API (port 4001). The backend container runs `node src/db/setup.js` on start
to create the databases and indexes.

### Option B: Manual

```bash
cd backend
npm install
cp .env.example .env   # edit COUCHDB_URL, JWT_SECRET, ML_SERVICE_URL
npm run setup           # creates databases + Mango indexes
npm run dev
```

Requires a real CouchDB instance reachable at `COUCHDB_URL` (e.g.
`docker run -p 5984:5984 -e COUCHDB_USER=sicklecare -e COUCHDB_PASSWORD=sicklecare couchdb:3.3`).

### Testing without CouchDB

`backend/test/mock-couchdb-server.js` is a lightweight in-memory Express app
that implements the subset of the CouchDB HTTP API `nano` needs (db create,
doc CRUD with `_rev` conflict checks, `_find`, `_index`, `_changes`). It's
useful for running the test suite or the e2e script without Docker:

```bash
npm run couchdb:mock &        # starts a fake CouchDB on :5984
npm run setup
npm run dev &
bash test/run_e2e_couch.sh
```

This is test-only - for real development or deployment, use Docker (Option A)
or a real CouchDB instance.

## API endpoints

Identical contract to the Postgres version, with two differences noted below.
All endpoints except `/health`, `/auth/register`, and `/auth/login` require
`Authorization: Bearer <token>`.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Liveness check |
| POST | `/api/auth/register` | Create account (+ patient profile if `role=patient`) |
| POST | `/api/auth/login` | Returns JWT + user/patient |
| GET | `/api/auth/me` | Current user/patient |
| GET | `/api/patients/me` | Get clinical profile |
| PATCH | `/api/patients/me` | Update clinical profile (engineered features auto-recomputed) |
| GET | `/api/symptoms` | List symptom logs (`from`, `to`, `source`, `limit`) |
| POST | `/api/symptoms` | Create/upsert today's (or `log_date`'s) log |
| GET/PATCH/DELETE | `/api/symptoms/:id` | Manage a single log. **`:id` is now the deterministic `<patient_id>::<log_date>::<source>` string, not a UUID.** |
| POST | `/api/predictions` | Run the two-layer model (optional `log_id` / `wearable` / `manual_log`); stores a `risk_assessments` doc |
| GET | `/api/predictions` | Risk assessment history (`limit`) |
| GET | `/api/predictions/latest` | Most recent risk assessment |
| POST | `/api/wearable/connect` | Store Google Fit OAuth tokens |
| GET | `/api/wearable/status` | Connection status (no tokens returned) |
| DELETE | `/api/wearable/disconnect` | Remove the stored connection |
| POST | `/api/wearable/sync` | Pull today's Google Fit metrics into `symptom_logs` (source=`wearable`) |
| POST | `/api/sync` | Batch-apply offline records (`symptom_logs`, `patients`) with last-write-wins; logs every record to `sicklecare_sync_log` |
| GET | `/api/sync/status` | Sync log counts + recent failures |
| GET | `/api/sync/changes` | **New.** CouchDB-native `_changes`-feed-based alternative to `/api/sync` - see below |
| GET | `/api/caregiver/patient` | Caregiver-side read-only snapshot of the linked patient (profile, latest risk, recent symptom logs, recent crises) |
| PATCH | `/api/caregiver/crises/:id` | **New.** Caregiver fills in/edits the qualitative details (`locations`, `triggers`, `actions_taken`, `medications_taken`, `notes`) of one of the linked patient's crisis logs. Severity/timestamps stay patient-owned and aren't editable here. |

### `GET /api/sync/changes` (new endpoint)

```
GET /api/sync/changes?since_symptoms=<seq>&since_patients=<seq>
```

Returns the raw CouchDB `_changes` feed entries (since the given
`update_seq`) for the authenticated patient's symptom logs and patient
profile. This demonstrates the primitive that `pouchDB.sync(remote, {live:
true})` is built on, as an alternative to the polling `/api/sync` batch
endpoint. See [`../COMPARISON.md`](../COMPARISON.md) for the full discussion
of when you'd use one vs. the other.

## ML microservice

Identical to the Postgres version's `ml-service` - see
[`../sicklecare-backend/README.md`](../sicklecare-backend/README.md#ml-microservice-layer-4)
for training/running instructions.
