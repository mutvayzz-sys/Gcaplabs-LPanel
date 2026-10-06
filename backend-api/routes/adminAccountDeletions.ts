// @ts-nocheck
// Admin "Account deletions" tab (decision 31).
//   GET  /admin/account-deletions                      list requests (newest first)
//   POST /admin/account-deletions                      { ownerId, confirm: "DELETE" } delete an account
//   POST /admin/account-deletions/:id/steps/:step      mark an operator step done
// Admin session only (requireSession + requireAdmin); API keys never reach it.

const express = require("express");
const { requireAdmin, requireSession } = require("../middleware/auth");
const { createDeletionClient } = require("../headmasterAccountDeletions");

function buildRouter({ clientFactory = () => createDeletionClient() } = {}) {
  const router = express.Router();
  router.use(requireSession, requireAdmin);

  function client(res) {
    const c = clientFactory();
    if (!c) res.status(503).json({ error: "Headmaster account store is not configured." });
    return c;
  }
  const actorOf = (req) => req.user?.email || req.user?.id || "admin";

  router.get("/", async (_req, res) => {
    const c = client(res); if (!c) return;
    try { res.json(await c.list()); } catch { res.status(503).json({ error: "Could not load account deletions." }); }
  });

  router.post("/", express.json({ limit: "4kb" }), async (req, res) => {
    const c = client(res); if (!c) return;
    if (req.body?.confirm !== "DELETE") return res.status(400).json({ error: "Type DELETE to confirm." });
    try {
      res.json(await c.deleteAccount(String(req.body?.ownerId || "").trim(), actorOf(req)));
    } catch (error) {
      const code = error?.message === "owner_invalid" ? 400 : 503;
      res.status(code).json({ error: code === 400 ? "Enter the account's user id." : "The account could not be deleted." });
    }
  });

  router.post("/:id/steps/:step", async (req, res) => {
    const c = client(res); if (!c) return;
    try {
      res.json(await c.completeStep(req.params.id, req.params.step, actorOf(req)));
    } catch (error) {
      const msg = error?.message;
      res.status(msg === "step_invalid" ? 400 : msg === "not_found" ? 404 : 503).json({ error: "Could not update the step." });
    }
  });
  return router;
}

module.exports = buildRouter();
module.exports.buildRouter = buildRouter;
