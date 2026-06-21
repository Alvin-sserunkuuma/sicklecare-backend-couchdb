const { Router } = require("express");
const { body } = require("express-validator");
const { requireAuth } = require("../middleware/auth");
const validate = require("../middleware/validate");
const wearableController = require("../controllers/wearableController");

const router = Router();

router.use(requireAuth);

router.post(
  "/connect",
  [
    body("access_token").isString().notEmpty(),
    body("refresh_token").optional().isString(),
    body("expires_in").optional().isInt({ min: 0 }),
    body("provider").optional().isString(),
  ],
  validate,
  wearableController.connect
);

router.get("/status", wearableController.status);
router.delete("/disconnect", wearableController.disconnect);
router.post("/sync", wearableController.sync);

module.exports = router;
