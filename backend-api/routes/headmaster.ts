// @ts-nocheck
// Headmaster internal routes (server-to-server only).
//
// Consumed exclusively by the Headmaster site's server functions through the
// nginx-scoped /api/internal/headmaster/* path with an Authorization: Bearer
// HEADMASTER_S2S_TOKEN credential (constant-time compared). Browsers never
// call these routes; operator management of identity links lives in
// routes/admin.ts under the normal admin-session surface.
//
// Everything here 404s (feature-disabled) unless HEADMASTER_S2S_TOKEN and
// HEADMASTER_PARENT_ORIGIN are both configured.

const express = require("express");
const headmaster = require("../headmasterLaunch");

const router = express.Router();

router.use((req, res, next) => {
  if (!headmaster.isEnabled()) {
    return res.status(404).json({ error: "Not found" });
  }
  next();
});

function requireS2S(req, res, next) {
  const header = req.headers?.authorization;
  if (typeof header !== "string") {
    return res.status(401).json({ error: "Unauthorized", code: "s2s_unauthorized" });
  }
  const match = header.match(/^Bearer\s+(\S+)$/i);
  if (!match || !headmaster.timingSafeEqual(match[1], headmaster.requireS2SToken())) {
    return res.status(401).json({ error: "Unauthorized", code: "s2s_unauthorized" });
  }
  next();
}

// Launch code issuance. The Headmaster server calls this only after it has
// freshly verified the GCAP session, its admin role, and suspension state.
router.post("/launch-codes", requireS2S, async (req, res, next) => {
  try {
    const { gcapUserId, gcapSessionId, browserNonce, parentOrigin } = req.body || {};
    const result = await headmaster.createLaunchCode({
      gcapUserId,
      gcapSessionId,
      browserNonce,
      parentOrigin,
    });
    res.json({
      code: result.code,
      expiresInSeconds: result.expiresInSeconds,
      noraUserId: result.noraUserId,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    next(error);
  }
});

// Revocation: by GCAP session id (logout/account switch), GCAP user id
// (suspension), or Nora user id (demotion/link removal).
router.post("/revoke", requireS2S, async (req, res, next) => {
  try {
    const { gcapSessionId, gcapUserId, noraUserId, reason } = req.body || {};
    if (!gcapSessionId && !gcapUserId && !noraUserId) {
      return res
        .status(400)
        .json({ error: "One of gcapSessionId, gcapUserId, or noraUserId is required." });
    }
    const revoked = await headmaster.revokeHeadmasterSessions({
      gcapSessionId,
      gcapUserId,
      noraUserId,
      reason: reason ? `s2s:${reason}` : "s2s",
    });
    res.json({ revoked });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    next(error);
  }
});

// Deployment-time provisioning and listing of the explicit identity links.
router.get("/admin-links", requireS2S, async (_req, res, next) => {
  try {
    res.json({ links: await headmaster.listHeadmasterLinks() });
  } catch (error) {
    next(error);
  }
});

router.post("/admin-links", requireS2S, async (req, res, next) => {
  try {
    const { gcapUserId, noraUserId } = req.body || {};
    const link = await headmaster.createHeadmasterLink({
      gcapUserId,
      noraUserId,
      actor: "s2s",
    });
    res.json(link);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    next(error);
  }
});

module.exports = router;
