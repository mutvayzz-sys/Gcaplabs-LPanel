import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSIGNMENT_MAX_BODY_BYTES,
  ASSIGNMENT_TTL_MAX_MS,
  ASSIGNMENT_TTL_MIN_MS,
  clampAssignmentTtl,
  createSupabaseAssignmentResolver,
  defaultAssignmentFromEnv,
  resolveAssignmentConfiguration,
  validateSupabaseOrigin,
} from "./assignments.mjs";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "99999999-9999-4999-8999-999999999999";
const NORA_USER = "33333333-3333-4333-8333-333333333333";
const PROVIDER = "44444444-4444-4444-8444-444444444444";
const SUPABASE_ORIGIN = "https://headmaster.supabase.invalid";
const KEY = "test-service-role-key-never-logged";
const NOW = 1_800_000_000_000;
const EXPECTED_QUERY = `owner_id=eq.${OWNER}&limit=2&select=owner_id,nora_user_id,provider_id,enabled,revision`;

function assignmentRow(overrides = {}) {
  return {
    owner_id: OWNER,
    nora_user_id: NORA_USER,
    provider_id: PROVIDER,
    enabled: true,
    revision: 4,
    ...overrides,
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeResolver(responder, { now = () => NOW, ttlMs, timeoutMs, logger } = {}) {
  const calls = [];
  let current = responder;
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return current(url, options);
  };
  const resolver = createSupabaseAssignmentResolver({
    supabaseUrl: SUPABASE_ORIGIN,
    serviceRoleKey: KEY,
    fetchImpl,
    now,
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(logger === undefined ? {} : { logger }),
  });
  return {
    resolver,
    calls,
    setResponder: (next) => {
      current = next;
    },
  };
}

function captureLogger() {
  const warnings = [];
  return {
    warnings,
    logger: { info() {}, warn: (...args) => warnings.push(args), error() {} },
  };
}

test("a valid assignment resolves to a reference-only mapping with the required read shape", async () => {
  const { resolver, calls } = makeResolver(async () => jsonResponse([assignmentRow()]));
  const mapping = await resolver.resolveAssignment(OWNER.toUpperCase());
  assert.deepEqual(mapping, { noraUserId: NORA_USER, providerId: PROVIDER });
  assert.equal("provider" in mapping, false);
  assert.equal("models" in mapping, false);
  assert.equal(Object.isFrozen(mapping), true);

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `${SUPABASE_ORIGIN}/rest/v1/headmaster_inference_assignments?${EXPECTED_QUERY}`,
  );
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.apikey, KEY);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].options.headers.accept, "application/json");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test("a disabled assignment denies access and logs the revocation distinctly", async () => {
  const { warnings, logger } = captureLogger();
  const { resolver } = makeResolver(async () => jsonResponse([assignmentRow({ enabled: false })]), {
    logger,
  });
  assert.equal(await resolver.resolveAssignment(OWNER), null);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], "headmaster-inference assignment revoked");
  assert.equal(warnings[0][1].ownerId, OWNER);
  assert.equal(warnings[0][1].revision, 4);
});

test("an absent assignment resolves to null, is cached within the TTL, and is re-checked after it", async () => {
  let clock = NOW;
  let fetches = 0;
  const { resolver } = makeResolver(
    () => {
      fetches += 1;
      return jsonResponse([]);
    },
    { now: () => clock, ttlMs: 1_000 },
  );
  assert.equal(await resolver.resolveAssignment(OWNER), null);
  assert.equal(await resolver.resolveAssignment(OWNER), null);
  assert.equal(fetches, 1);
  clock = NOW + 1_000;
  assert.equal(await resolver.resolveAssignment(OWNER), null);
  assert.equal(fetches, 2);
});

test("duplicate rows are an anomaly and fail closed", async () => {
  const { resolver } = makeResolver(async () => jsonResponse([assignmentRow(), assignmentRow()]));
  await assert.rejects(
    resolver.resolveAssignment(OWNER),
    (error) => error.code === "assignment_lookup_anomaly",
  );
});

test("malformed rows, invalid types, non-2xx responses, and outages fail closed", async () => {
  const cases = [
    ["non-array body", async () => jsonResponse({ owner_id: OWNER })],
    ["invalid JSON body", async () => new Response("not-json", { status: 200 })],
    ["invalid owner uuid", async () => jsonResponse([assignmentRow({ owner_id: "not-a-uuid" })])],
    ["owner mismatch", async () => jsonResponse([assignmentRow({ owner_id: OTHER_OWNER })])],
    [
      "invalid nora user uuid",
      async () => jsonResponse([assignmentRow({ nora_user_id: "not-a-uuid" })]),
    ],
    ["invalid provider uuid", async () => jsonResponse([assignmentRow({ provider_id: "12345" })])],
    ["enabled not boolean", async () => jsonResponse([assignmentRow({ enabled: "true" })])],
    ["revision zero", async () => jsonResponse([assignmentRow({ revision: 0 })])],
    ["revision not a number", async () => jsonResponse([assignmentRow({ revision: "4" })])],
    ["server error", async () => jsonResponse({ message: "boom" }, 500)],
    ["unauthorized", async () => jsonResponse({ message: "denied" }, 401)],
    [
      "network outage",
      async () => {
        throw new Error("ECONNREFUSED");
      },
    ],
  ];
  for (const [name, responder] of cases) {
    const { resolver } = makeResolver(responder);
    await assert.rejects(resolver.resolveAssignment(OWNER), `expected ${name} to fail closed`);
  }
  const { resolver } = makeResolver(async () => jsonResponse([assignmentRow()]));
  await assert.rejects(
    resolver.resolveAssignment("not-a-uuid"),
    (error) => error.code === "assignment_owner_invalid",
  );
});

test("TTL expiry re-fetches and reflects revocation; nothing is served beyond the TTL", async () => {
  let clock = NOW;
  let fetches = 0;
  let payload = [assignmentRow()];
  const { resolver } = makeResolver(
    () => {
      fetches += 1;
      return jsonResponse(payload);
    },
    { now: () => clock, ttlMs: 5_000 },
  );
  assert.deepEqual(await resolver.resolveAssignment(OWNER), {
    noraUserId: NORA_USER,
    providerId: PROVIDER,
  });

  payload = [assignmentRow({ enabled: false, revision: 5 })];
  clock = NOW + 4_999;
  assert.deepEqual(await resolver.resolveAssignment(OWNER), {
    noraUserId: NORA_USER,
    providerId: PROVIDER,
  });
  assert.equal(fetches, 1);

  clock = NOW + 5_000;
  assert.equal(await resolver.resolveAssignment(OWNER), null);
  assert.equal(fetches, 2);
});

test("a lookup outage at TTL expiry denies instead of serving the expired entry", async () => {
  let clock = NOW;
  const { resolver, calls, setResponder } = makeResolver(
    async () => jsonResponse([assignmentRow()]),
    { now: () => clock, ttlMs: 1_000 },
  );
  assert.deepEqual(await resolver.resolveAssignment(OWNER), {
    noraUserId: NORA_USER,
    providerId: PROVIDER,
  });
  setResponder(async () => {
    throw new Error("headmaster Supabase unreachable");
  });
  clock = NOW + 1_000;
  await assert.rejects(
    resolver.resolveAssignment(OWNER),
    (error) => error.code === "assignment_lookup_failed",
  );
  assert.equal(calls.length, 2);
});

test("a lookup that stalls aborts after the configured timeout and fails closed", async () => {
  const { resolver } = makeResolver(
    (url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
      }),
    { timeoutMs: 20 },
  );
  await assert.rejects(
    resolver.resolveAssignment(OWNER),
    (error) => error.code === "assignment_lookup_timeout",
  );
});

test("a response that stalls mid-body (headers arrive, body never completes) aborts after the timeout and fails closed", async () => {
  const { resolver } = makeResolver(
    () =>
      new Response(
        new ReadableStream({
          pull() {
            /* never enqueues or closes */
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    { timeoutMs: 20 },
  );
  await assert.rejects(
    resolver.resolveAssignment(OWNER),
    (error) => error.code === "assignment_lookup_timeout",
  );
});

test("an oversized response body is rejected without buffering it in full", async () => {
  const oversized = new ReadableStream({
    start(controller) {
      const chunk = new Uint8Array(8192).fill(97);
      const chunksNeeded = Math.ceil((ASSIGNMENT_MAX_BODY_BYTES + 1) / chunk.byteLength);
      for (let i = 0; i < chunksNeeded; i += 1) controller.enqueue(chunk);
      controller.close();
    },
  });
  const { resolver } = makeResolver(
    () => new Response(oversized, { status: 200, headers: { "content-type": "application/json" } }),
  );
  await assert.rejects(
    resolver.resolveAssignment(OWNER),
    (error) => error.code === "assignment_lookup_invalid",
  );
});

test("assignment TTL clamps to the documented window and the origin must be a bare https URL", () => {
  assert.equal(clampAssignmentTtl(undefined), 30_000);
  assert.equal(clampAssignmentTtl(""), 30_000);
  assert.equal(clampAssignmentTtl("45000"), 45_000);
  assert.equal(clampAssignmentTtl("500"), ASSIGNMENT_TTL_MIN_MS);
  assert.equal(clampAssignmentTtl(999_999), ASSIGNMENT_TTL_MAX_MS);
  assert.equal(clampAssignmentTtl("nonsense"), 30_000);

  assert.equal(
    validateSupabaseOrigin("https://project.supabase.co/"),
    "https://project.supabase.co",
  );
  for (const bad of [
    "http://project.supabase.co",
    "https://user:pw@project.supabase.co",
    "https://project.supabase.co/rest/v1",
    "https://project.supabase.co/?redirect=1",
    "https://project.supabase.co/#fragment",
    "not a url",
  ]) {
    assert.throws(() => validateSupabaseOrigin(bad), `expected ${bad} to be rejected`);
  }

  assert.throws(() =>
    createSupabaseAssignmentResolver({
      supabaseUrl: "http://project.supabase.co",
      serviceRoleKey: KEY,
    }),
  );
  assert.throws(() =>
    createSupabaseAssignmentResolver({ supabaseUrl: SUPABASE_ORIGIN, serviceRoleKey: "" }),
  );
  assert.throws(() =>
    createSupabaseAssignmentResolver({
      supabaseUrl: SUPABASE_ORIGIN,
      serviceRoleKey: KEY,
      ttlMs: 0,
    }),
  );
});

test("assignment configuration selects supabase, env, or fails closed without mixing sources", () => {
  const mapJson = JSON.stringify({
    [OWNER]: { noraUserId: NORA_USER, providerId: PROVIDER, provider: "openai" },
  });
  const supabaseEnv = {
    HEADMASTER_INFERENCE_SUPABASE_URL: SUPABASE_ORIGIN,
    HEADMASTER_INFERENCE_SUPABASE_SERVICE_ROLE_KEY: KEY,
  };

  const autoSupabase = resolveAssignmentConfiguration({ ...supabaseEnv });
  assert.equal(autoSupabase.mode, "supabase");
  assert.equal(typeof autoSupabase.resolveAssignment, "function");
  assert.equal(autoSupabase.accountProviderMap, undefined);
  assert.equal(autoSupabase.warning, undefined);

  const explicitEnv = resolveAssignmentConfiguration({
    HEADMASTER_INFERENCE_ASSIGNMENT_SOURCE: "env",
    HEADMASTER_INFERENCE_ACCOUNT_MAP: mapJson,
  });
  assert.equal(explicitEnv.mode, "env");
  assert.ok(explicitEnv.accountProviderMap instanceof Map);
  assert.match(explicitEnv.warning, /LEGACY/);
  assert.equal(explicitEnv.resolveAssignment, undefined);

  const autoEnv = resolveAssignmentConfiguration({ HEADMASTER_INFERENCE_ACCOUNT_MAP: mapJson });
  assert.equal(autoEnv.mode, "env");
  assert.match(autoEnv.warning, /LEGACY/);

  const envWins = resolveAssignmentConfiguration({
    ...supabaseEnv,
    HEADMASTER_INFERENCE_ASSIGNMENT_SOURCE: "env",
    HEADMASTER_INFERENCE_ACCOUNT_MAP: mapJson,
  });
  assert.equal(envWins.mode, "env");

  assert.throws(() =>
    resolveAssignmentConfiguration({ HEADMASTER_INFERENCE_ASSIGNMENT_SOURCE: "supabase" }),
  );
  assert.throws(() =>
    resolveAssignmentConfiguration({ HEADMASTER_INFERENCE_ASSIGNMENT_SOURCE: "legacy" }),
  );
  assert.throws(() =>
    resolveAssignmentConfiguration({ HEADMASTER_INFERENCE_ASSIGNMENT_SOURCE: "env" }),
  );
  assert.throws(() => resolveAssignmentConfiguration({}));
});

const DEFAULT_ASSIGNMENT = {
  noraUserId: "55555555-5555-4555-8555-555555555555",
  providerId: "66666666-6666-4666-8666-666666666666",
};

function makeResolverWithDefault(responder, defaultAssignment, logger) {
  return createSupabaseAssignmentResolver({
    supabaseUrl: SUPABASE_ORIGIN,
    serviceRoleKey: KEY,
    fetchImpl: async (url, options) => responder(url, options),
    now: () => NOW,
    defaultAssignment,
    ...(logger ? { logger } : {}),
  });
}

test("an owner with no assignment row gets the configured default; an explicit row wins; a disabled row still denies", async () => {
  const absent = makeResolverWithDefault(async () => jsonResponse([]), DEFAULT_ASSIGNMENT);
  assert.deepEqual(await absent.resolveAssignment(OWNER), DEFAULT_ASSIGNMENT);

  const explicit = makeResolverWithDefault(async () => jsonResponse([assignmentRow()]), DEFAULT_ASSIGNMENT);
  assert.deepEqual(await explicit.resolveAssignment(OWNER), { noraUserId: NORA_USER, providerId: PROVIDER });

  const disabled = makeResolverWithDefault(
    async () => jsonResponse([assignmentRow({ enabled: false })]),
    DEFAULT_ASSIGNMENT,
    captureLogger().logger,
  );
  assert.equal(await disabled.resolveAssignment(OWNER), null);
});

test("without a default an absent row still denies, and lookup failures never fall back to the default", async () => {
  const none = makeResolverWithDefault(async () => jsonResponse([]), null);
  assert.equal(await none.resolveAssignment(OWNER), null);

  const down = makeResolverWithDefault(async () => jsonResponse({}, 503), DEFAULT_ASSIGNMENT);
  await assert.rejects(down.resolveAssignment(OWNER), { code: "assignment_lookup_failed" });
  const anomaly = makeResolverWithDefault(
    async () => jsonResponse([assignmentRow(), assignmentRow()]),
    DEFAULT_ASSIGNMENT,
  );
  await assert.rejects(anomaly.resolveAssignment(OWNER), { code: "assignment_lookup_anomaly" });
});

test("the default assignment comes from two env settings that must be set together and be UUIDs", () => {
  assert.equal(defaultAssignmentFromEnv({}), null);
  assert.deepEqual(
    defaultAssignmentFromEnv({
      HEADMASTER_INFERENCE_DEFAULT_NORA_USER_ID: DEFAULT_ASSIGNMENT.noraUserId,
      HEADMASTER_INFERENCE_DEFAULT_PROVIDER_ID: DEFAULT_ASSIGNMENT.providerId,
    }),
    DEFAULT_ASSIGNMENT,
  );
  assert.throws(
    () => defaultAssignmentFromEnv({ HEADMASTER_INFERENCE_DEFAULT_PROVIDER_ID: DEFAULT_ASSIGNMENT.providerId }),
    { code: "assignment_config_invalid" },
  );
  assert.throws(
    () =>
      createSupabaseAssignmentResolver({
        supabaseUrl: SUPABASE_ORIGIN,
        serviceRoleKey: KEY,
        defaultAssignment: { noraUserId: "nope", providerId: DEFAULT_ASSIGNMENT.providerId },
      }),
    { code: "assignment_config_invalid" },
  );
  const configured = resolveAssignmentConfiguration({
    HEADMASTER_INFERENCE_SUPABASE_URL: SUPABASE_ORIGIN,
    HEADMASTER_INFERENCE_SUPABASE_SERVICE_ROLE_KEY: KEY,
    HEADMASTER_INFERENCE_DEFAULT_NORA_USER_ID: DEFAULT_ASSIGNMENT.noraUserId,
    HEADMASTER_INFERENCE_DEFAULT_PROVIDER_ID: DEFAULT_ASSIGNMENT.providerId,
  });
  assert.equal(configured.mode, "supabase");
});
