// @ts-nocheck
// N3 runtime-identity resolver for the Headmaster memory gateway.
//
// Consumed exclusively by the Headmaster memory-gateway service via
// POST /api/integrations/headmaster/runtime-identity with an
// Authorization: Bearer HEADMASTER_RUNTIME_IDENTITY_SERVICE_TOKEN credential
// (constant-time compared). See gcaplabs-webapp's
// services/admission/nora-runtime-identity.mjs for the exact request/response
// contract this must satisfy -- it validates the response strictly and throws
// if this ever drifts from it. This route 404s (feature-disabled) unless
// HEADMASTER_RUNTIME_IDENTITY_SERVICE_TOKEN is configured, matching the
// project's fail-closed convention for optional integrations.
//
// Nora hands each Hermes runtime its own API_SERVER_KEY at provision time
// (agent-runtime/lib/hermesRuntimeBootstrap.ts); that same value is stored,
// encrypted at rest, as agents.gateway_token (see backend-api/runtimeAuth.ts).
// There is no indexed digest column for it -- adding one means updating every
// gateway_token write site across workers/provisioner/backends/* (a
// shared-blast-radius zone per this repo's CLAUDE.md), which is a larger,
// separately-reviewed change. Decrypting and hashing the (small, per-VPS)
// set of Headmaster-adopted agents on each lookup is a reasonable
// low-blast-radius cost at that scale; revisit with an indexed column if the
// adopted-agent count ever grows large enough for this to matter. The
// gateway's own client already keeps a bounded cache in front of this call.

const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { decrypt } = require("../crypto");
const { deriveHeadmasterInferenceKey } = require("../../agent-runtime/lib/headmasterInference");

const router = express.Router();

const DIGEST_RE = /^[0-9a-f]{64}$/i;

function serviceToken() {
  return process.env.HEADMASTER_RUNTIME_IDENTITY_SERVICE_TOKEN || "";
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

router.use((req, res, next) => {
  if (!serviceToken()) {
    return res.status(404).json({ error: "Not found" });
  }
  next();
});

router.use((req, res, next) => {
  const header = req.headers?.authorization;
  const match = typeof header === "string" ? header.match(/^Bearer\s+(\S+)$/i) : null;
  if (!match || !timingSafeEqual(match[1], serviceToken())) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// Machine-to-machine (admission calls this, with its own bounded cache in
// front), so the ceiling is generous; it exists to cap the per-call cost of
// decrypting every adopted agent's token if the service token ever leaks or a
// caller loops. Runs after auth so unauthenticated traffic cannot spend the
// legitimate caller's quota. Keyed by client IP (trust proxy is set).
function positiveIntEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const runtimeIdentityLimiter = rateLimit({
  windowMs: positiveIntEnv("HEADMASTER_RUNTIME_IDENTITY_RATE_LIMIT_WINDOW_MS", 60 * 1000),
  max: positiveIntEnv("HEADMASTER_RUNTIME_IDENTITY_RATE_LIMIT_MAX", 1200),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

router.use(runtimeIdentityLimiter);

router.post("/runtime-identity", async (req, res) => {
  const digest = String(req.body?.runtime_key_sha256 || "").toLowerCase();
  if (!DIGEST_RE.test(digest)) {
    return res.status(400).json({ error: "runtime_key_sha256 must be a SHA-256 hex digest" });
  }

  // `runtime_key_kind: "inference"` looks the digest up against the credential a
  // runtime presents to the managed inference relay, which is derived from its
  // gateway key. The default kind is the gateway key itself (memory gateway).
  const kind = req.body?.runtime_key_kind ?? "gateway";
  if (kind !== "gateway" && kind !== "inference") {
    return res.status(400).json({ error: 'runtime_key_kind must be "gateway" or "inference"' });
  }

  const { rows } = await db.query(
    `SELECT id, gateway_token, external_id, external_owner_uuid
       FROM agents
      WHERE external_namespace = 'headmaster'
        AND gateway_token IS NOT NULL
        AND external_id IS NOT NULL
        AND external_owner_uuid IS NOT NULL`,
  );

  for (const row of rows) {
    let plaintext;
    try {
      plaintext = decrypt(row.gateway_token);
    } catch {
      continue; // corrupted/undecryptable row -- never a match, never a 500
    }
    if (!plaintext) continue;
    const presented = kind === "inference" ? deriveHeadmasterInferenceKey(plaintext) : plaintext;
    const candidate = crypto.createHash("sha256").update(presented).digest("hex");
    if (timingSafeEqual(candidate, digest)) {
      return res.json({
        agent_id: row.id,
        external_identity: {
          namespace: "headmaster",
          external_id: row.external_id,
          owner_uuid: row.external_owner_uuid,
        },
        // The external identity is immutable for an agent's lifetime (the
        // /adopt route 409s on any rebind attempt), and a rotated
        // gateway_token simply stops matching any digest here -- there is no
        // rotation event distinct from that to count yet, so this is fixed
        // until a real generation concept is needed.
        credential_generation: "1",
        active: true,
      });
    }
  }

  return res.status(404).json({ error: "Not found" });
});

module.exports = router;
