const { Router } = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { listPatients, getPatient } = require("../controllers/clinicianController");

const router = Router();

// Clinician-only: every route here requires a valid token AND role === 'clinician'.
// No per-patient assignment yet (see db/setup.js notes) - any clinician can
// view any patient's profile, logs, and risk history.
router.use(requireAuth, requireRole("clinician"));

router.get("/patients", listPatients);
router.get("/patients/:id", getPatient);

module.exports = router;
