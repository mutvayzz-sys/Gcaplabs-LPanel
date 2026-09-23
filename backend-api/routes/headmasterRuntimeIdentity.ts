// @ts-nocheck
const express = require("express");
const rateLimit = require("express-rate-limit");
const { requireServiceScope } = require("../middleware/auth");
const {
  RUNTIME_IDENTITY_SCOPE,
  lookupRuntimeIdentityByDigest,
  normalizeRuntimeKeyDigest,
} = require("../runtimeIdentity");
const db = require("../db");

const router = express.Router();
const LOOKUP_TIMEOUT_MS = 2500;
const lookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many runtime identity lookups" },
  // Production rate-limits by source IP. Tests exercise indexed miss behavior
  // without sharing a process-wide limiter bucket across suites.
  skip: () => process.env.NODE_ENV === "test" || Boolean(process.env.JEST_WORKER_ID),
});

router.post(
  "/runtime-identity",
  lookupLimiter,
  requireServiceScope(RUNTIME_IDENTITY_SCOPE),
  async (req, res) => {
    res.set("Cache-Control", "no-store");
    const body = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(body, "runtime_key_sha256")
    ) {
      return res.status(400).json({ error: "runtime_key_sha256 is required" });
    }
    const digest = normalizeRuntimeKeyDigest(body.runtime_key_sha256);
    if (!digest) return res.status(400).json({ error: "runtime_key_sha256 must be SHA-256 hex" });

    try {
      const identity = await lookupRuntimeIdentityByDigest(db, digest, {
        timeoutMs: LOOKUP_TIMEOUT_MS,
      });
      if (!identity) return res.status(404).json({ error: "Runtime identity not found" });
      return res.json(identity);
    } catch {
      // Do not log or return the presented digest, secret-bearing DB fields, or
      // database details. Timeout/outage must fail closed for the caller.
      return res.status(503).json({ error: "Runtime identity lookup unavailable" });
    }
  },
);

module.exports = router;
