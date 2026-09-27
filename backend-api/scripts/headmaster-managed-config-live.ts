// @ts-nocheck
// Destructive only to a fresh, explicitly named disposable fixture database.
// No production credentials, provider calls, or container deletion.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
if (
  process.env.DB_NAME !== "hm_managed_config_test" ||
  process.env.NORA_AGENT_NETWORK !== "hm-managed-config-test"
) {
  throw new Error("This harness requires its isolated database and Docker network");
}
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
const db = require("../db");
const app = require("../server");
const Docker = require("dockerode");
const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const { encrypt } = require("../crypto");
const { syncAuthToUserAgents } = require("../authSync");
const { waitForAgentReadiness } = require("../healthChecks");
const owner = crypto.randomUUID();
const account = crypto.randomUUID();
const workspace = crypto.randomUUID();
const agentId = crypto.randomUUID();
const providerKey = `fixture-${crypto.randomBytes(32).toString("hex")}`;
let runtime;
let server;

async function main() {
  await db.query(fs.readFileSync(require.resolve("../db_schema.sql"), "utf8"));
  await app.__test.migrateDB();
  await app.__test.migrateDB(); // append-only migration replay is a no-op
  await db.query("INSERT INTO users(id,email,role) VALUES($1,$2,'user')", [
    account,
    `${account}@fixture.invalid`,
  ]);
  await db.query(
    "INSERT INTO llm_providers(user_id,provider,api_key,model,is_default) VALUES($1,'openai',$2,'gpt-5.5',true)",
    [account, encrypt(providerKey)],
  );

  // Use a cached real runtime image. Construct a fresh container with no host
  // ports and no production volumes. The real Nora adapter handles every env
  // replacement/restart below, not a mocked Docker client.
  const apiKey = crypto.randomBytes(32).toString("hex");
  runtime = await docker.createContainer({
    name: `hm-managed-test-${agentId}`,
    Image: process.env.HEADMASTER_TEST_IMAGE,
    Env: Object.entries({
      HERMES_HOME: "/opt/data",
      HOME: "/opt/data/home",
      API_SERVER_ENABLED: "true",
      API_SERVER_HOST: "0.0.0.0",
      API_SERVER_PORT: "8642",
      API_SERVER_KEY: apiKey,
      AWS_EC2_METADATA_DISABLED: "true",
      HERMES_DISABLE_LAZY_INSTALLS: "1",
      HERMES_NONINTERACTIVE: "1",
      OPENAI_API_KEY: providerKey,
      HERMES_DASHBOARD: "0",
    }).map(([key, value]) => `${key}=${value}`),
    Cmd: [
      "/bin/sh",
      "-lc",
      "if [ -r /opt/nora-managed-env/apply.sh ]; then . /opt/nora-managed-env/apply.sh; fi; exec /opt/hermes/.venv/bin/hermes gateway run",
    ],
    HostConfig: { NetworkMode: "hm-managed-config-test", Memory: 2147483648, NanoCpus: 1000000000 },
    Labels: { "headmaster.test": "managed-config" },
  });
  await runtime.start();
  let info = await runtime.inspect();
  const host = info.NetworkSettings.Networks["hm-managed-config-test"].IPAddress;
  await db.query(
    `INSERT INTO agents(id,user_id,name,status,runtime_family,backend_type,container_id,container_name,host,runtime_host,runtime_port,gateway_token,
    external_namespace,external_id,external_owner_uuid) VALUES($1,$2,'managed-config-fixture','running','hermes','docker',$3,$4,$5,$5,8642,$6,'headmaster',$7,$8)`,
    [agentId, account, runtime.id, info.Name.slice(1), host, apiKey, workspace, owner],
  );
  assert.equal(
    (
      await waitForAgentReadiness({
        host,
        runtimeHost: host,
        runtimePort: 8642,
        checkGateway: false,
      })
    ).ok,
    true,
    "initial runtime readiness",
  );
  console.log("PASS real Docker runtime ready with existing provider credential");
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const token = require("jsonwebtoken").sign(
    { id: account, role: "user", email: `${account}@fixture.invalid` },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );
  async function call(method, path, body) {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/agents/${agentId}/${path}`,
      {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    assert.equal(response.status, 200, `${method} ${path}`);
    return response.json();
  }
  assert.equal((await call("GET", "managed-config")).desired_revision, 0);
  const body = {
    expected_revision: 0,
    owner_uuid: owner,
    workspace_uuid: workspace,
    memory_bank_id: `hermes-u-${owner.replace(/-/g, "_")}`,
    memory_gateway_url: "http://memory.fixture:8888",
  };
  const before = (await runtime.inspect()).State.StartedAt;
  const patched = await call("PATCH", "integrations/headmaster", body);
  assert.equal(patched.deployment_status, "applied");
  assert.equal(patched.applied_revision, 1);
  assert.equal(patched.integration_key_names.length, 4);
  info = await runtime.inspect();
  assert.equal(info.State.Running, true);
  assert.notEqual(info.State.StartedAt, before);
  async function checkRuntime(key) {
    // Compare inside the container and print only PASS/FAIL, never env values.
    const expected = {
      HEADMASTER_OWNER_ID: owner,
      HEADMASTER_WORKSPACE_ID: workspace,
      HEADMASTER_MEMORY_BANK_ID: body.memory_bank_id,
      HEADMASTER_MEMORY_GATEWAY_URL: body.memory_gateway_url,
      OPENAI_API_KEY: key,
    };
    const python = `import os,json\ne=json.loads(${JSON.stringify(JSON.stringify(expected))})\nfound=False\nfor pid in os.listdir('/proc'):\n if not pid.isdigit(): continue\n try:\n  raw=open('/proc/'+pid+'/environ','rb').read().split(b'\\0')\n  env=dict(item.decode().split('=',1) for item in raw if b'=' in item)\n  if all(env.get(k)==v for k,v in e.items()): found=True\n except (OSError,ValueError,UnicodeError): pass\nassert found, 'no runtime process contains complete managed environment'\nprint('PASS process environment retains provider and all four Headmaster variables')`;
    const exec = await runtime.exec({
      Cmd: ["python3", "-c", python],
      User: "hermes",
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({});
    await new Promise((resolve, reject) => {
      stream.resume();
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    assert.equal(
      (await exec.inspect()).ExitCode,
      0,
      "provider and identity environment preserved inside runtime",
    );
    console.log("PASS process environment retains provider and all four Headmaster variables");
  }
  await checkRuntime(providerKey);
  const started = info.State.StartedAt;
  assert.deepEqual(await call("PATCH", "integrations/headmaster", body), patched);
  assert.deepEqual(await call("POST", "managed-config/retry"), patched);
  assert.equal((await runtime.inspect()).State.StartedAt, started);
  console.log("PASS identical PATCH and applied retry are no-ops");
  const rotatedKey = `fixture-${crypto.randomBytes(32).toString("hex")}`;
  await db.query("UPDATE llm_providers SET api_key=$1 WHERE user_id=$2", [
    encrypt(rotatedKey),
    account,
  ]);
  const sync = await syncAuthToUserAgents(account, agentId);
  assert.equal(sync[0]?.status, "synced");
  await checkRuntime(rotatedKey);
  console.log("PASS unrelated provider rotation preserves Headmaster config");
  await db.query(
    "UPDATE agents SET headmaster_integration_applied_revision=0,headmaster_integration_deployment_status='failed', status='stopped', paused_reason='provider_auth_reconciliation_failed' WHERE id=$1",
    [agentId],
  );
  await runtime.stop();
  assert.equal((await call("POST", "managed-config/retry")).applied_revision, 1);
  await checkRuntime(rotatedKey);
  console.log("PASS retry converges without a new desired revision; migrations replay safely");
}
main().then(
  () => finish(0),
  (error) => {
    console.error(
      "FAIL isolated managed-config live test (details withheld to protect credentials)",
    );
    console.error(
      String(error.stack || "")
        .split("\n")
        .filter((line) => line.trim().startsWith("at "))
        .join("\n"),
    );
    return finish(1);
  },
);
async function finish(code) {
  if (server) server.close();
  if (runtime) {
    await runtime.stop().catch(() => {});
    console.log("Fixture runtime stopped and preserved for inspection");
  }
  await db.end();
  process.exit(code);
}
