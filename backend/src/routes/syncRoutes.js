const { Router } = require("express");
const { body, query } = require("express-validator");
const { requireAuth } = require("../middleware/auth");
const validate = require("../middleware/validate");
const syncController = require("../controllers/syncController");

const router = Router();

router.use(requireAuth);

router.post(
  "/",
  [
    body("records").isArray({ min: 1, max: 200 }),
    body("records.*.table_name").isIn(syncController.SUPPORTED_TABLES),
    body("records.*.record_id").exists(),
    body("records.*.payload").isObject(),
    body("records.*.client_updated_at").isISO8601(),
  ],
  validate,
  syncController.batchSync
);

router.get("/status", syncController.status);

router.get(
  "/changes",
  [query("since_symptoms").optional(), query("since_patients").optional()],
  validate,
  syncController.changes
);

module.exports = router;
