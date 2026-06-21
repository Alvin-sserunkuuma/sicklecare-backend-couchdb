const { Router } = require("express");
const { body, param } = require("express-validator");
const validate = require("../middleware/validate");
const { requireAuth } = require("../middleware/auth");
const { list, invite, remove } = require("../controllers/caregiverController");

const router = Router();

router.use(requireAuth);

router.get("/", list);

router.post(
  "/",
  [body("email").isEmail().withMessage("Valid email is required").normalizeEmail()],
  validate,
  invite
);

// IDs are deterministic strings "<patient_id>::<caregiver_email>" rather
// than UUIDs (see caregiverController.linkId), so just require a non-empty
// value. The frontend URL-encodes this id since it contains "::".
router.delete("/:id", [param("id").isString().notEmpty()], validate, remove);

module.exports = router;
