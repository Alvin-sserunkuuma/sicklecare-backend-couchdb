const { Router } = require("express");
const { body } = require("express-validator");
const validate = require("../middleware/validate");
const { requireAuth } = require("../middleware/auth");
const { getMe, updateMe } = require("../controllers/patientsController");

const router = Router();

router.use(requireAuth);

router.get("/me", getMe);

router.patch(
  "/me",
  [
    body("display_name").optional().isString().trim().isLength({ max: 100 }),
    body("age").optional().isInt({ min: 0, max: 120 }),
    body("sex").optional().isIn(["male", "female"]),
    body("genotype").optional().isIn(["HbSS", "HbSC", "HbS-β+ thalassemia", "HbS-β0 thalassemia"]),
    body("on_hydroxyurea").optional().isBoolean(),
    body("stroke_occurred").optional().isBoolean(),
    body("splenic_sequestration_history").optional().isBoolean(),
    body("acs_episodes_per_year").optional().isFloat({ min: 0 }),
    body("penicillin_prophylaxis").optional().isBoolean(),
    body("has_regular_pain_medications").optional().isBoolean(),
    body("chronic_transfusions").optional().isBoolean(),
    body("malaria_episodes_per_year").optional().isFloat({ min: 0 }),
  ],
  validate,
  updateMe
);

module.exports = router;
