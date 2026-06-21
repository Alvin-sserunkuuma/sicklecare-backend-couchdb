const { validationResult } = require("express-validator");
const AppError = require("../utils/AppError");

/**
 * Runs after express-validator check(...) middlewares; converts validation
 * failures into a 400 AppError with field-level details.
 */
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new AppError(400, "Validation failed", errors.array()));
  }
  next();
}

module.exports = validate;
