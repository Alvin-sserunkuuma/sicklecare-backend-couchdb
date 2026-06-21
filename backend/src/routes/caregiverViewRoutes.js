const { Router } = require("express");
const { body, param } = require("express-validator");
const validate = require("../middleware/validate");
const { requireAuth, requireRole } = require("../middleware/auth");
const { getMyPatient, updateCrisisDetails } = require("../controllers/caregiverViewController");

const router = Router();

router.use(requireAuth, requireRole("caregiver"));

router.get("/patient", getMyPatient);

router.patch(
  "/crises/:id",
  [
    param("id").isString().notEmpty(),
    body("locations").optional().isArray(),
    body("locations.*").optional().isString(),
    body("triggers").optional().isArray(),
    body("triggers.*").optional().isString(),
    body("actions_taken").optional().isArray(),
    body("actions_taken.*").optional().isString(),
    body("medications_taken").optional().isString(),
    body("notes").optional().isString(),
  ],
  validate,
  updateCrisisDetails
);

module.exports = router;
