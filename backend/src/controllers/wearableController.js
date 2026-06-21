const axios = require("axios");
const { db } = require("../db/couch");
const AppError = require("../utils/AppError");
const { logId } = require("./symptomsController");

const GOOGLE_FIT_BASE = "https://www.googleapis.com/fitness/v1/users/me";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

function ensurePatient(req) {
  if (!req.user.patientId) {
    throw new AppError(404, "No patient profile for this account");
  }
  return req.user.patientId;
}

/** Deterministic _id: one wearable connection per patient (1:1). */
function connectionId(patientId) {
  return `wearable::${patientId}`;
}

async function getConnection(patientId) {
  try {
    return await db.wearableConnections.get(connectionId(patientId));
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

/**
 * POST /api/wearable/connect (FR-10)
 * Stores (or replaces) the Google Fit OAuth tokens for the patient.
 * The mobile app performs the OAuth consent flow and hands the resulting
 * tokens to this endpoint.
 */
async function connect(req, res, next) {
  try {
    const patientId = await ensurePatient(req);
    const { access_token, refresh_token, expires_in, provider } = req.body;

    const expires_at = expires_in
      ? new Date(Date.now() + Number(expires_in) * 1000).toISOString()
      : null;

    const now = new Date().toISOString();
    const existing = await getConnection(patientId);

    const doc = existing || {
      _id: connectionId(patientId),
      type: "wearable_connection",
      patient_id: patientId,
      connected_at: now,
    };

    doc.provider = provider || "google_fit";
    doc.access_token = access_token;
    doc.refresh_token = refresh_token || (existing ? existing.refresh_token : null) || null;
    doc.expires_at = expires_at;
    doc.updated_at = now;

    const result = await db.wearableConnections.insert(doc);

    res.status(201).json({
      id: doc._id,
      patient_id: doc.patient_id,
      provider: doc.provider,
      expires_at: doc.expires_at,
      connected_at: doc.connected_at,
      updated_at: doc.updated_at,
      _rev: result.rev,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/wearable/status (FR-10)
 * Reports whether a wearable is connected, without leaking tokens.
 */
async function status(req, res, next) {
  try {
    const patientId = await ensurePatient(req);
    const doc = await getConnection(patientId);
    if (!doc) return res.json({ connected: false });
    res.json({
      connected: true,
      provider: doc.provider,
      expires_at: doc.expires_at,
      connected_at: doc.connected_at,
      updated_at: doc.updated_at,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/wearable/disconnect (FR-10)
 */
async function disconnect(req, res, next) {
  try {
    const patientId = await ensurePatient(req);
    const doc = await getConnection(patientId);
    if (doc) await db.wearableConnections.destroy(doc._id, doc._rev);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

/** Refreshes an expired Google access token using the stored refresh token. */
async function refreshAccessToken(connection) {
  if (!connection.refresh_token) {
    throw new AppError(401, "Wearable connection expired - reconnect required");
  }
  try {
    const { data } = await axios.post(GOOGLE_TOKEN_URL, {
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: connection.refresh_token,
      grant_type: "refresh_token",
    });
    const expires_at = data.expires_in
      ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString()
      : null;

    connection.access_token = data.access_token;
    connection.expires_at = expires_at;
    connection.updated_at = new Date().toISOString();
    const result = await db.wearableConnections.insert(connection);
    connection._rev = result.rev;

    return data.access_token;
  } catch (err) {
    throw new AppError(502, "Failed to refresh Google Fit token");
  }
}

/**
 * Pulls today's aggregated metrics (heart rate, SpO2, steps, sleep) from the
 * Google Fit REST API for the given access token.
 */
async function fetchGoogleFitSummary(accessToken) {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const body = {
    aggregateBy: [
      { dataTypeName: "com.google.heart_rate.bpm" },
      { dataTypeName: "com.google.oxygen_saturation" },
      { dataTypeName: "com.google.step_count.delta" },
      { dataTypeName: "com.google.sleep.segment" },
    ],
    bucketByTime: { durationMillis: 24 * 60 * 60 * 1000 },
    startTimeMillis: startOfDay.getTime(),
    endTimeMillis: now.getTime(),
  };

  const { data } = await axios.post(`${GOOGLE_FIT_BASE}/dataset:aggregate`, body, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 10000,
  });

  const summary = {};
  for (const bucket of data.bucket || []) {
    for (const dataset of bucket.dataset || []) {
      for (const point of dataset.point || []) {
        const value = point.value?.[0];
        if (!value) continue;
        if (point.dataTypeName === "com.google.heart_rate.bpm" && value.fpVal != null) {
          summary.heart_rate = value.fpVal;
        } else if (point.dataTypeName === "com.google.oxygen_saturation" && value.fpVal != null) {
          summary.spo2 = value.fpVal;
        } else if (point.dataTypeName === "com.google.step_count.delta" && value.intVal != null) {
          summary.steps_today = (summary.steps_today || 0) + value.intVal;
        }
      }
    }
  }
  return summary;
}

/**
 * POST /api/wearable/sync (FR-11)
 * Pulls today's metrics from Google Fit and upserts them into symptom_logs
 * (source='wearable'), so they feed the predictions endpoint as FR-04 data.
 */
async function sync(req, res, next) {
  try {
    const patientId = await ensurePatient(req);

    const connection = await getConnection(patientId);
    if (!connection) throw new AppError(400, "No wearable connected");

    let summary;
    try {
      summary = await fetchGoogleFitSummary(connection.access_token);
    } catch (err) {
      if (err.response && err.response.status === 401) {
        const newToken = await refreshAccessToken(connection);
        summary = await fetchGoogleFitSummary(newToken);
      } else if (err instanceof AppError) {
        throw err;
      } else {
        throw new AppError(502, "Failed to fetch data from Google Fit");
      }
    }

    if (Object.keys(summary).length === 0) {
      return res.json({ synced: false, message: "No new wearable data available" });
    }

    const today = new Date().toISOString().slice(0, 10);
    const _id = logId(patientId, today, "wearable");

    let logDoc;
    try {
      logDoc = await db.symptomLogs.get(_id);
    } catch (err) {
      if (err.statusCode !== 404) throw err;
      logDoc = {
        _id,
        type: "symptom_log",
        patient_id: patientId,
        log_date: today,
        source: "wearable",
        infection_present: false,
        created_at: new Date().toISOString(),
      };
    }

    Object.assign(logDoc, summary);
    logDoc.synced = true;

    const result = await db.symptomLogs.insert(logDoc);
    logDoc._rev = result.rev;

    // eslint-disable-next-line no-unused-vars
    const { _id: id, _rev, type, ...rest } = logDoc;
    res.json({ synced: true, log: { id, ...rest } });
  } catch (err) {
    next(err);
  }
}

module.exports = { connect, status, disconnect, sync };
