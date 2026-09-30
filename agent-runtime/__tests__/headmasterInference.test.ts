import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "tsx/cjs";

const headmasterInference = require("../lib/headmasterInference.ts");
const hermesRuntimeBootstrap = require("../lib/hermesRuntimeBootstrap.ts");

const {
  HEADMASTER_DEFAULT_TIER,
  HEADMASTER_INFERENCE_DEFAULT_BASE_URL,
  HEADMASTER_INFERENCE_KEY_REF,
  HEADMASTER_PROVIDER_ID,
  HEADMASTER_TIER_MODELS,
  buildHeadmasterModelConfig,
  buildHeadmasterProviderEntry,
  buildHeadmasterProviderRow,
  deriveHeadmasterInferenceKey,
  headmasterInferenceBaseUrl,
  headmasterInferenceContainerEnv,
} = headmasterInference;
const { buildHermesRuntimeBootstrapEnv, buildHermesRuntimeConfigBootstrapCommand } =
  hermesRuntimeBootstrap;

describe("Headmaster tier definition", () => {
  it("is exactly Lite, Pro and Max in that order", () => {
    // The desktop (apps/desktop/electron/headmaster-trial-provider.ts) and the
    // relay (services/headmaster-inference/policy.mjs) carry the same three ids.
    expect([...HEADMASTER_TIER_MODELS]).toEqual([
      "headmaster-lite",
      "headmaster-pro",
      "headmaster-max",
    ]);
    expect(HEADMASTER_DEFAULT_TIER).toBe("headmaster-lite");
  });

  it("registers the tiers as a fixed list with no live discovery and no inline credential", () => {
    const entry = buildHeadmasterProviderEntry({});
    expect(entry.name).toBe("Headmaster");
    expect(entry.discover_models).toBe(false);
    expect(Object.keys(entry.models)).toEqual([...HEADMASTER_TIER_MODELS]);
    expect(entry.key_env).toBe("HEADMASTER_INFERENCE_KEY");
    expect(entry).not.toHaveProperty("api_key");
    expect(entry.base_url).toBe(HEADMASTER_INFERENCE_DEFAULT_BASE_URL);
  });

  it("points the main model at the provider by env reference, never a literal key", () => {
    const config = buildHeadmasterModelConfig({});
    expect(config).toMatchObject({
      provider: HEADMASTER_PROVIDER_ID,
      defaultModel: "headmaster-lite",
      apiKey: HEADMASTER_INFERENCE_KEY_REF,
    });
    expect(JSON.stringify(config)).not.toMatch(/[0-9a-f]{64}/);
    expect(buildHeadmasterProviderRow({}).provider).toBe(HEADMASTER_PROVIDER_ID);
  });
});

describe("relay endpoint and credential", () => {
  it("derives a stable key that differs from the gateway key", () => {
    const key = deriveHeadmasterInferenceKey("gateway-key");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(deriveHeadmasterInferenceKey("gateway-key"));
    expect(key).not.toBe(deriveHeadmasterInferenceKey("other-gateway-key"));
    expect(key).not.toBe("gateway-key");
    expect(() => deriveHeadmasterInferenceKey("")).toThrow();
  });

  it("accepts only a plain https base URL override", () => {
    expect(headmasterInferenceBaseUrl({ HEADMASTER_INFERENCE_BASE_URL: "https://relay.example/v1/" })).toBe(
      "https://relay.example/v1",
    );
    for (const bad of ["http://relay.example/v1", "https://u:p@relay.example/v1", "https://r.example/v1?x=1", "nonsense"]) {
      expect(() => headmasterInferenceBaseUrl({ HEADMASTER_INFERENCE_BASE_URL: bad })).toThrow();
    }
  });

  it("gives the container the derived key and the endpoint", () => {
    expect(headmasterInferenceContainerEnv("gateway-key", {})).toEqual({
      HEADMASTER_INFERENCE_KEY: deriveHeadmasterInferenceKey("gateway-key"),
      HEADMASTER_INFERENCE_BASE_URL: HEADMASTER_INFERENCE_DEFAULT_BASE_URL,
    });
  });
});

// Runs the real bootstrap script under sh against a stand-in for hermes_cli.config
// that keeps the config as JSON, so the model block it writes can be read back.
describe("container bootstrap writes the managed model block", () => {
  let home: string;
  let stub: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "headmaster-bootstrap-"));
    stub = mkdtempSync(join(tmpdir(), "headmaster-stub-"));
    mkdirSync(join(stub, "hermes_cli"));
    writeFileSync(join(stub, "hermes_cli", "__init__.py"), "");
    writeFileSync(
      join(stub, "hermes_cli", "config.py"),
      [
        "import json, os",
        "from pathlib import Path",
        "def get_config_path():",
        '    return Path(os.environ["HERMES_HOME"]) / "config.json"',
        "def load_config():",
        "    path = get_config_path()",
        "    return json.loads(path.read_text()) if path.exists() else {}",
        "def save_config(config):",
        "    get_config_path().write_text(json.dumps(config))",
        "",
      ].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(stub, { recursive: true, force: true });
  });

  function runBootstrap(modelConfig: object, existing?: object) {
    if (existing) writeFileSync(join(home, "config.json"), JSON.stringify(existing));
    const env = buildHermesRuntimeBootstrapEnv({ modelConfig });
    const result = spawnSync("sh", ["-c", buildHermesRuntimeConfigBootstrapCommand()], {
      env: { PATH: process.env.PATH, HERMES_HOME: home, PYTHONPATH: stub, ...env },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  }

  it("seeds a fresh runtime with the provider entry and the default tier", () => {
    const config = runBootstrap(buildHeadmasterModelConfig({}));
    expect(config.model).toEqual({
      provider: "headmaster",
      default: "headmaster-lite",
      base_url: HEADMASTER_INFERENCE_DEFAULT_BASE_URL,
      api_key: HEADMASTER_INFERENCE_KEY_REF,
    });
    expect(config.providers.headmaster.discover_models).toBe(false);
    expect(Object.keys(config.providers.headmaster.models)).toEqual([...HEADMASTER_TIER_MODELS]);
    expect(config.providers.headmaster.key_env).toBe("HEADMASTER_INFERENCE_KEY");
  });

  it("replaces an operator provider left in the config by an older image", () => {
    const config = runBootstrap(buildHeadmasterModelConfig({}), {
      model: { provider: "openrouter", default: "some/model", api_key: "sk-operator-secret" },
      memory: { provider: "hindsight" },
    });
    expect(config.model.provider).toBe("headmaster");
    expect(JSON.stringify(config)).not.toContain("sk-operator-secret");
    expect(config.memory).toEqual({ provider: "hindsight" });
  });

  it("keeps the tier the user already chose", () => {
    const config = runBootstrap(buildHeadmasterModelConfig({}), {
      model: { provider: "headmaster", default: "headmaster-max" },
    });
    expect(config.model.default).toBe("headmaster-max");
  });

  it("leaves other providers' generic model blocks working as before", () => {
    const config = runBootstrap({
      provider: "custom",
      defaultModel: "local-model",
      baseUrl: "https://models.example/v1",
      apiKey: "user-key",
    });
    expect(config.model).toEqual({
      provider: "custom",
      default: "local-model",
      base_url: "https://models.example/v1",
      api_key: "user-key",
    });
    expect(config).not.toHaveProperty("providers");
  });
});
