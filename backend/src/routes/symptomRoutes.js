const { Router } = require("express");
const { body, param, query } = require("express-validator");
const validate = require("../middleware/validate");
const { requireAuth } = require("../middleware/auth");
const { list, create, getOne, update, remove } = require("../controllers/symptomsController");

const router = Router();

router.use(requireAuth);

const logBodyValidators = [
  body("log_date").optional().isISO8601().withMessage("log_date must be YYYY-MM-DD"),
  body("pain_score").optional().isInt({ min: 0, max: 10 }),
  body("fatigue_score").optional().isInt({ min: 0, max: 10 }),
  body("water_intake_litres").optional().isFloat({ min: 0 }),
  body("sleep_hours").optional().isFloat({ min: 0, max: 24 }),
  body("sleep_quality").optional().isInt({ min: 0, max: 2 }),
  body("hydration_ok").optional().isBoolean(),
  body("mood").optional().isInt({ min: 0, max: 2 }),
  body("activity_level").optional().isInt({ min: 0, max: 2 }),
  body("infection_present").optional().isBoolean(),
  body("heart_rate").optional().isFloat({ min: 0 }),
  body("spo2").optional().isFloat({ min: 0, max: 100 }),
  body("skin_temp_c").optional().isFloat(),
  body("steps_today").optional().isInt({ min: 0 }),
  body("source").optional().isIn(["manual", "wearable"]),
];

// IDs are deterministic strings "<patient_id>::<log_date>::<source>" rather
// than UUIDs (see symptomsController.logId), so just require a non-empty value.
const idParamValidator = param("id").isString().notEmpty();

router.get(
  "/",
  [
    query("from").optional().isISO8601(),
    query("to").optional().isISO8601(),
    query("source").optional().isIn(["manual", "wearable"]),
    query("limit").optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  list
);

router.post("/", logBodyValidators, validate, create);

router.get("/:id", [idParamValidator], validate, getOne);

router.patch("/:id", [idParamValidator, ...logBodyValidators], validate, update);

router.delete("/:id", [idParamValidator], validate, remove);

module.exports = router;
