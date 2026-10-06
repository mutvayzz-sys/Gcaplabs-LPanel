const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

const { createHermesConfigSandbox } = require("../../backend-api/__tests__/support/hermesConfigStub");
const {
  HEADMASTER_PROVIDER_ID,
  buildHeadmasterModelConfig,
  buildHeadmasterProviderRow,
} = require("../../agent-runtime/lib/headmasterInference.ts");

// Managed agents are found by this row; the stub pool answers only that lookup.
let agentRow = null;
const queries = [];

function loadWorker() {
  const originalLoad = Module._load;
  const originalLog = console.log;
  const workerSuffix = "/workers/provisioner/worker.ts";
  const silent = () => undefined;
  // Helpers the worker reaches for but these tests do not exercise return an
  // empty, iterable value.
  const noop = () => [];
  const genericModule = new Proxy({}, { get: () => noop });

  class StubPool {
    async query(sql) {
      queries.push(String(sql));
      if (/FROM agents WHERE id = \$1/.test(String(sql))) return { rows: agentRow ? [agentRow] : [] };
      return { rows: [] };
    }
  }

  Module._load = function loadWorkerDependency(request, parent) {
    if (parent?.filename?.replaceAll("\\", "/").endsWith(workerSuffix)) {
      if (request === "bullmq") {
        return {
          Worker: class {
            on() {}
            isRunning() {
              return true;
            }
          },
          UnrecoverableError: class UnrecoverableError extends Error {},
        };
      }
      if (request === "crypto") return originalLoad.apply(this, arguments);
      if (request === "ioredis") return function StubRedis() {};
      if (request === "pg") return { Pool: StubPool, Client: class {} };
      if (request === "http") return { createServer: () => ({ listen() {} }) };
      if (request === "../../backend-api/lib/connectionConfig") {
        return { buildPostgresConfig: () => ({}), createRedisClient: () => ({}) };
      }
      if (request === "../../agent-runtime/lib/backendCatalog") {
        return {
          getDefaultBackend: () => "docker",
          getEnabledBackends: () => ["docker"],
          isKnownBackend: () => true,
          normalizeBackendName: (value) => value,
        };
      }
      if (request === "../../agent-runtime/lib/headmasterInference") {
        return originalLoad.apply(this, arguments);
      }
      if (request === "../../agent-runtime/lib/containerCommand") {
        return originalLoad.apply(this, arguments);
      }
      if (request === "../../backend-api/redisQueue") return { ALERT_DELIVERY_ATTEMPTS: 1 };
      if (request === "../../backend-api/llmProviders") {
        return new Proxy(
          { getManagedProviderEnvNames: () => [], PROVIDERS: [] },
          { get: (target, key) => (key in target ? target[key] : noop) },
        );
      }
      if (request.startsWith(".")) return genericModule;
    }
    return originalLoad.apply(this, arguments);
  };

  console.log = silent;
  try {
    return require("./worker.ts");
  } finally {
    console.log = originalLog;
    Module._load = originalLoad;
  }
}

const worker = loadWorker();

test("a Headmaster-managed Hermes agent gets the relay provider and none of the operator's keys", async () => {
  agentRow = { external_namespace: "headmaster", headmaster_owner_id: "owner" };
  queries.length = 0;
  const state = await worker.fetchEffectiveProviderState("operator", null, "agent-1", {
    runtimeFamily: "hermes",
  });
  assert.equal(state.defaultProvider.provider, HEADMASTER_PROVIDER_ID);
  assert.deepEqual(state.envVars, {});
  assert.ok(
    !queries.some((sql) => /llm_providers/.test(sql)),
    "operator provider rows are never read for a managed runtime",
  );
  assert.deepEqual(
    worker.buildHermesModelConfig(state.defaultProvider, state.envVars),
    buildHeadmasterModelConfig(),
  );
});

test("an ordinary Hermes agent still reads the account's provider state", async () => {
  agentRow = { external_namespace: null };
  queries.length = 0;
  const state = await worker.fetchEffectiveProviderState("operator", null, "agent-2", {
    runtimeFamily: "hermes",
  });
  assert.notEqual(state.defaultProvider?.provider, HEADMASTER_PROVIDER_ID);
  assert.ok(queries.some((sql) => /llm_providers/.test(sql)));
});

test("the exec writer applies the managed block and drops a leftover operator key", () => {
  const sandbox = createHermesConfigSandbox({
    model: { provider: "openrouter", default: "x/y", api_key: "sk-operator-secret" },
  });
  try {
    sandbox.runShell(worker.buildHermesModelConfigWriteCommand(buildHeadmasterModelConfig()));
    const config = sandbox.readConfig();
    assert.equal(config.model.provider, "headmaster");
    assert.equal(config.model.api_key, "${HEADMASTER_INFERENCE_KEY}");
    assert.deepEqual(Object.keys(config.providers.headmaster.models), [
      "headmaster-lite",
      "headmaster-pro",
    ]);
    assert.ok(!JSON.stringify(config).includes("sk-operator-secret"));
  } finally {
    sandbox.cleanup();
  }
});

test("the exec writer leaves ordinary provider blocks as before", () => {
  const sandbox = createHermesConfigSandbox();
  try {
    sandbox.runShell(
      worker.buildHermesModelConfigWriteCommand({
        provider: "custom",
        defaultModel: "local",
        baseUrl: "https://models.example/v1",
        apiKey: "user-key",
      }),
    );
    assert.deepEqual(sandbox.readConfig().model, {
      provider: "custom",
      default: "local",
      base_url: "https://models.example/v1",
      api_key: "user-key",
    });
  } finally {
    sandbox.cleanup();
  }
});

test("the relay provider row carries the relay endpoint", () => {
  assert.equal(buildHeadmasterProviderRow({}).config.base_url, "https://inference.gcaplabs.com/v1");
});
