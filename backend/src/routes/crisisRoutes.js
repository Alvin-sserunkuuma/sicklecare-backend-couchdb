const { Router } = require("express");
const { body, param, query } = require("express-validator");
const validate = require("../middleware/validate");
const { requireAuth } = require("../middleware/auth");
const { list, create, getOne, update, remove } = require("../controllers/crisisController");

const router = Router();

router.use(requireAuth);

const commonCrisisValidators = [
  body("started_at").optional().isISO8601().withMessage("started_at must be an ISO timestamp"),
  body("ended_at").optional().isISO8601().withMessage("ended_at must be an ISO timestamp"),
  body("locations").optional().isArray(),
  body("locations.*").optional().isString(),
  body("triggers").optional().isArray(),
  body("triggers.*").optional().isString(),
  body("actions_taken").optional().isArray(),
  body("actions_taken.*").optional().isString(),
  body("medications_taken").optional().isString(),
  body("notes").optional().isString(),
  body("resolved").optional().isBoolean(),
];

// IDs are CouchDB-generated UUID strings (crypto.randomUUID()), so just
// require a non-empty value rather than validating UUID format strictly.
const idParamValidator = param("id").isString().notEmpty();

router.get(
  "/",
  [
    query("from").optional().isISO8601(),
    query("to").optional().isISO8601(),
    query("limit").optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  list
);

router.post(
  "/",
  [body("severity").isInt({ min: 0, max: 10 }).withMessage("severity must be 0-10"), ...commonCrisisValidators],
  validate,
  create
);

router.get("/:id", [idParamValidator], validate, getOne);

router.patch(
  "/:id",
  [idParamValidator, body("severity").optional().isInt({ min: 0, max: 10 }), ...commonCrisisValidators],
  validate,
  update
);

router.delete("/:id", [idParamValidator], validate, remove);

module.exports = router;
