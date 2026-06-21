const { Router } = require("express");
const authRoutes = require("./authRoutes");
const patientRoutes = require("./patientRoutes");
const symptomRoutes = require("./symptomRoutes");
const predictionRoutes = require("./predictionRoutes");
const wearableRoutes = require("./wearableRoutes");
const syncRoutes = require("./syncRoutes");
const clinicianRoutes = require("./clinicianRoutes");
const crisisRoutes = require("./crisisRoutes");
const caregiverRoutes = require("./caregiverRoutes");
const caregiverViewRoutes = require("./caregiverViewRoutes");

const router = Router();

router.get("/health", (req, res) => res.json({ status: "ok" }));

router.use("/auth", authRoutes);
router.use("/patients", patientRoutes);
router.use("/symptoms", symptomRoutes);
router.use("/predictions", predictionRoutes);
router.use("/wearable", wearableRoutes);
router.use("/sync", syncRoutes);
router.use("/clinician", clinicianRoutes);
router.use("/crises", crisisRoutes);
router.use("/caregivers", caregiverRoutes);
router.use("/caregiver", caregiverViewRoutes);

module.exports = router;
