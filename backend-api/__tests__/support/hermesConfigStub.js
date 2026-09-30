// @ts-nocheck
// Stand-in for the runtime's `hermes_cli.config` module so tests can execute the
// Python that Nora sends into a Hermes container. The config is kept as JSON in
// $HERMES_HOME/config.json; only the calls those scripts make are implemented.
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STUB = [
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
].join("\n");

function createHermesConfigSandbox(existingConfig = null) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-home-"));
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-stub-"));
  fs.mkdirSync(path.join(stub, "hermes_cli"));
  fs.writeFileSync(path.join(stub, "hermes_cli", "__init__.py"), "");
  fs.writeFileSync(path.join(stub, "hermes_cli", "config.py"), STUB);
  if (existingConfig) fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(existingConfig));
  return {
    home,
    // Runs a python script (stdin) or a shell command against the stub.
    runPython(script) {
      const result = spawnSync("python3", ["-"], {
        input: script,
        env: { PATH: process.env.PATH, HERMES_HOME: home, PYTHONPATH: stub },
        encoding: "utf8",
      });
      if (result.status !== 0) throw new Error(result.stderr || "python failed");
      return result.stdout;
    },
    runShell(command) {
      const result = spawnSync("sh", ["-c", command], {
        env: { PATH: process.env.PATH, HERMES_HOME: home, PYTHONPATH: stub },
        encoding: "utf8",
      });
      if (result.status !== 0) throw new Error(result.stderr || "shell failed");
      return result.stdout;
    },
    readConfig() {
      return JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    },
    cleanup() {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(stub, { recursive: true, force: true });
    },
  };
}

module.exports = { createHermesConfigSandbox };
