// ════════════════════════════════════════════════════════════════════════
// Minimal in-memory CouchDB-API emulator, for running the e2e test suite in
// environments without Docker/Apache CouchDB (and where installing
// pouchdb-server's native leveldown dependency isn't practical).
//
// Implements just the subset of the CouchDB HTTP API used by `nano` in this
// project: db create, doc PUT/POST/GET/DELETE with _rev conflict checks,
// POST _index (no-op), POST _find (a small Mango subset: equality and
// $gte/$lte range on one field, plus `limit`), and GET _changes.
//
// For real local development, use real CouchDB via `docker compose up`
// (see ../../docker-compose.yml) or `pouchdb-server`. This file is test-only.
// ════════════════════════════════════════════════════════════════════════
const express = require("express");
const crypto = require("crypto");

function newRev(prevRevNum = 0) {
  const num = prevRevNum + 1;
  return `${num}-${crypto.randomBytes(16).toString("hex")}`;
}

function revNum(rev) {
  return rev ? parseInt(rev.split("-")[0], 10) : 0;
}

function matchesSelector(doc, selector) {
  for (const [key, cond] of Object.entries(selector)) {
    const value = doc[key];
    if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
      for (const [op, opVal] of Object.entries(cond)) {
        if (op === "$gte" && !(value >= opVal)) return false;
        if (op === "$lte" && !(value <= opVal)) return false;
        if (op === "$eq" && value !== opVal) return false;
        if (op === "$ne" && value === opVal) return false;
      }
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

function createApp() {
  // dbName -> { docs: Map<id, doc>, changes: [{seq, id, rev, deleted, doc}], seq }
  const databases = new Map();

  const app = express();
  app.use(express.json({ limit: "5mb" }));

  app.get("/", (req, res) => res.json({ couchdb: "mock", version: "0.0.0-test" }));
  app.get("/_up", (req, res) => res.json({ status: "ok" }));

  app.put("/:db", (req, res) => {
    const { db } = req.params;
    if (databases.has(db)) {
      return res.status(412).json({ error: "file_exists", reason: "The database could not be created, the file already exists." });
    }
    databases.set(db, { docs: new Map(), changes: [], seq: 0 });
    res.status(201).json({ ok: true });
  });

  app.get("/:db", (req, res) => {
    const database = databases.get(req.params.db);
    if (!database) return res.status(404).json({ error: "not_found", reason: "Database does not exist." });
    res.json({ db_name: req.params.db, doc_count: database.docs.size, update_seq: database.seq });
  });

  function recordChange(database, id, rev, deleted, doc) {
    database.seq += 1;
    database.changes.push({ seq: database.seq, id, rev, deleted, doc: deleted ? undefined : doc });
  }

  function upsert(req, res, id) {
    const database = databases.get(req.params.db);
    if (!database) return res.status(404).json({ error: "not_found", reason: "Database does not exist." });

    const incoming = req.body;
    const existing = database.docs.get(id);

    if (existing && incoming._rev !== existing._rev) {
      return res.status(409).json({ error: "conflict", reason: "Document update conflict." });
    }
    if (!existing && incoming._rev) {
      return res.status(409).json({ error: "conflict", reason: "Document update conflict." });
    }

    const rev = newRev(existing ? revNum(existing._rev) : 0);
    const stored = { ...incoming, _id: id, _rev: rev };
    database.docs.set(id, stored);
    recordChange(database, id, rev, false, stored);

    res.status(existing ? 201 : 201).json({ ok: true, id, rev });
  }

  // POST /:db  (create doc, server-generated id)
  app.post("/:db/_find", (req, res) => {
    const database = databases.get(req.params.db);
    if (!database) return res.status(404).json({ error: "not_found", reason: "Database does not exist." });

    const { selector = {}, limit = 25 } = req.body;
    const docs = [];
    for (const doc of database.docs.values()) {
      if (matchesSelector(doc, selector)) {
        docs.push(doc);
        if (docs.length >= limit) break;
      }
    }
    res.json({ docs, bookmark: "", warning: undefined });
  });

  app.post("/:db/_index", (req, res) => {
    const database = databases.get(req.params.db);
    if (!database) return res.status(404).json({ error: "not_found", reason: "Database does not exist." });
    res.status(200).json({ result: "created", id: "_design/mock", name: req.body.name || "mock-index" });
  });

  app.get("/:db/_changes", (req, res) => {
    const database = databases.get(req.params.db);
    if (!database) return res.status(404).json({ error: "not_found", reason: "Database does not exist." });

    const since = parseInt(req.query.since, 10) || 0;
    const includeDocs = req.query.include_docs === "true";

    const results = database.changes
      .filter((c) => c.seq > since)
      .map((c) => ({
        seq: c.seq,
        id: c.id,
        changes: [{ rev: c.rev }],
        deleted: c.deleted || undefined,
        doc: includeDocs ? c.doc || database.docs.get(c.id) : undefined,
      }));

    res.json({ results, last_seq: database.seq, pending: 0 });
  });

  app.post("/:db", (req, res) => {
    const id = req.body._id || crypto.randomUUID();
    upsert(req, res, id);
  });

  app.put("/:db/:id", (req, res) => {
    upsert(req, res, decodeURIComponent(req.params.id));
  });

  app.get("/:db/:id", (req, res) => {
    const database = databases.get(req.params.db);
    if (!database) return res.status(404).json({ error: "not_found", reason: "Database does not exist." });

    const id = decodeURIComponent(req.params.id);
    const doc = database.docs.get(id);
    if (!doc) return res.status(404).json({ error: "not_found", reason: "missing" });
    res.json(doc);
  });

  app.delete("/:db/:id", (req, res) => {
    const database = databases.get(req.params.db);
    if (!database) return res.status(404).json({ error: "not_found", reason: "Database does not exist." });

    const id = decodeURIComponent(req.params.id);
    const doc = database.docs.get(id);
    if (!doc) return res.status(404).json({ error: "not_found", reason: "missing" });
    if (req.query.rev !== doc._rev) {
      return res.status(409).json({ error: "conflict", reason: "Document update conflict." });
    }

    const rev = newRev(revNum(doc._rev));
    database.docs.delete(id);
    recordChange(database, id, rev, true, null);
    res.json({ ok: true, id, rev });
  });

  return app;
}

if (require.main === module) {
  const port = process.env.PORT || 5984;
  createApp().listen(port, () => console.log(`mock CouchDB listening on ${port}`));
}

module.exports = { createApp };
