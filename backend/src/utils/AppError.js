/**
 * Lightweight error class for expected/handled errors (validation, auth,
 * not-found, etc.) so the central error handler can map them to the right
 * HTTP status code instead of returning a generic 500.
 */
class AppError extends Error {
  constructor(statusCode, message, details = null) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

module.exports = AppError;
