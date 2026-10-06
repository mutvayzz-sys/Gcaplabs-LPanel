// @ts-nocheck
const { createDeletionClient } = require("../headmasterAccountDeletions");

const ENV = { HEADMASTER_SUPABASE_URL: "https://project.example", HEADMASTER_SUPABASE_SERVICE_ROLE_KEY: "test-service-key" };
const OWNER = "11111111-2222-3333-4444-555555555555";
const ok = (body = {}) => ({ ok: true, status: 200, json: async () => body });
const fail = (status = 500) => ({ ok: false, status, json: async () => ({}) });

describe("headmaster account deletions", () => {
  test("not configured without env", () => {
    expect(createDeletionClient({ env: {} })).toBeNull();
  });

  test("admin deletion revokes, removes push, then deletes the user", async () => {
    const calls = [];
    const fetchImpl = jest.fn(async (url, init = {}) => {
      calls.push(`${init.method || "GET"} ${url.replace(ENV.HEADMASTER_SUPABASE_URL, "")}`);
      if (url.endsWith("/rest/v1/headmaster_account_deletion_requests")) return ok([{ id: "r1" }]);
      return ok();
    });
    const client = createDeletionClient({ env: ENV, fetchImpl });
    const row = await client.deleteAccount(OWNER, "ops@example.com");
    expect(row.status).toBe("needs_operator");
    expect(row.steps).toMatchObject({ revoke_sessions: "done", push_registrations: "done", auth_user: "done", memory_bank: "pending_operator" });
    expect(calls).toEqual([
      "POST /rest/v1/headmaster_account_deletion_requests",
      "POST /rest/v1/rpc/headmaster_bump_account_revocation",
      `DELETE /rest/v1/headmaster_push_registrations?owner_id=eq.${OWNER}`,
      `DELETE /auth/v1/admin/users/${OWNER}`,
      "PATCH /rest/v1/headmaster_account_deletion_requests?id=eq.r1",
    ]);
  });

  test("user is kept when sessions could not be revoked", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.endsWith("/rest/v1/headmaster_account_deletion_requests")) return ok([{ id: "r1" }]);
      if (url.includes("rpc/")) return fail();
      return ok();
    });
    const row = await createDeletionClient({ env: ENV, fetchImpl }).deleteAccount(OWNER, "a");
    expect(row.steps.auth_user).toBe("skipped");
    expect(row.status).toBe("failed");
    expect(fetchImpl.mock.calls.some(([u]) => u.includes("/auth/v1/admin/users/"))).toBe(false);
  });

  test("rejects a non-uuid owner", async () => {
    await expect(createDeletionClient({ env: ENV, fetchImpl: jest.fn() }).deleteAccount("x", "a")).rejects.toThrow("owner_invalid");
  });

  test("completing the last operator step completes the request", async () => {
    const steps = { revoke_sessions: "done", push_registrations: "done", auth_user: "done",
      cloud_runtime: "done", memory_bank: "done", relay_usage: "pending_operator" };
    const fetchImpl = jest.fn(async (_url, init = {}) => init.method === "PATCH" ? ok() : ok([{ id: "r1", status: "needs_operator", steps }]));
    const row = await createDeletionClient({ env: ENV, fetchImpl }).completeStep("r1", "relay_usage", "ops");
    expect(row.status).toBe("completed");
    expect(row.completed_by).toBe("ops");
    await expect(createDeletionClient({ env: ENV, fetchImpl }).completeStep("r1", "auth_user", "ops")).rejects.toThrow("step_invalid");
  });
});
