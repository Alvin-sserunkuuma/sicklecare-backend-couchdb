const { Router } = require("express");
const { body, query } = require("express-validator");
const { requireAuth } = require("../middleware/auth");
const validate = require("../middleware/validate");
const predictionsController = require("../controllers/predictionsController");

const router = Router();

router.use(requireAuth);

const wearableValidators = [
  body("wearable.avg_spo2").optional().isFloat({ min: 0, max: 100 }),
  body("wearable.avg_heart_rate").optional().isFloat({ min: 0, max: 300 }),
  body("wearable.skin_temp_c").optional().isFloat({ min: 25, max: 45 }),
  body("wearable.steps_today").optional().isInt({ min: 0 }),
  body("wearable.sleep_hours").optional().isFloat({ min: 0, max: 24 }),
];

const manualLogValidators = [
  body("manual_log.pain_today").optional().isInt({ min: 0, max: 10 }),
  body("manual_log.sleep_quality").optional().isInt({ min: 0, max: 3 }),
  body("manual_log.hydration_ok").optional().isBoolean(),
  body("manual_log.mood").optional().isInt({ min: 0, max: 3 }),
  body("manual_log.activity_level").optional().isInt({ min: 0, max: 3 }),
];

router.post(
  "/",
  [body("log_id").optional().isString(), ...wearableValidators, ...manualLogValidators],
  validate,
  predictionsController.create
);

router.get(
  "/",
  [query("limit").optional().isInt({ min: 1, max: 100 })],
  validate,
  predictionsController.list
);

router.get("/latest", predictionsController.latest);

module.exports = router;
