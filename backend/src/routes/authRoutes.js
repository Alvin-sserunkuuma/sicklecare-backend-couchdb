const { Router } = require("express");
const { body } = require("express-validator");
const validate = require("../middleware/validate");
const { requireAuth } = require("../middleware/auth");
const { register, login, me } = require("../controllers/authController");

const router = Router();

router.post(
  "/register",
  [
    body("email").isEmail().withMessage("Valid email is required").normalizeEmail(),
    body("password").isLength({ min: 8 }).withMessage("Password must be at least 8 characters"),
    body("role").optional().isIn(["patient", "clinician", "admin", "caregiver"]),
    body("display_name").optional().isString().trim(),
    body("genotype")
      .optional()
      .isIn(["HbSS", "HbSC", "HbS-β+ thalassemia", "HbS-β0 thalassemia"]),
  ],
  validate,
  register
);

router.post(
  "/login",
  [
    body("email").isEmail().withMessage("Valid email is required").normalizeEmail(),
    body("password").notEmpty().withMessage("Password is required"),
  ],
  validate,
  login
);

router.get("/me", requireAuth, me);

module.exports = router;
