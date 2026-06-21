const AppError = require("../utils/AppError");

/**
 * Centralized error handler. AppError instances carry their own status code;
 * anything else (driver errors, bugs) is logged and returned as a 500
 * without leaking internals to the client.
 */
function notFound(req, res, next) {
  next(new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.message,
      details: err.details || undefined,
    });
  }

  // nano/CouchDB errors carry a statusCode mirroring the CouchDB HTTP response.
  if (err.statusCode === 409) {
    return res.status(409).json({ error: "Resource already exists or was updated concurrently (revision conflict)" });
  }
  if (err.statusCode === 404) {
    return res.status(404).json({ error: "Resource not found" });
  }
  if (err.statusCode === 400) {
    return res.status(400).json({ error: "Invalid request", detail: err.description || err.reason });
  }

  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}

module.exports = { notFound, errorHandler };
