// @ts-nocheck
// The relay image copies a hand-picked set of files. A file that one of them requires at load time but the Dockerfile does not
// copy only shows up as a crash when the container starts (it did: agent-runtime/lib/headmasterInference.ts). Walk the load-time
// relative requires of every copied file and demand each target is copied too.
const fs = require("fs");
const path = require("path");

const repo = path.resolve(__dirname, "../..");
const dockerfile = fs.readFileSync(path.join(repo, "services/headmaster-inference/Dockerfile"), "utf8");
const copied = new Set();
for (const m of dockerfile.matchAll(/^COPY\s+(\S+)\s+(\S+)\s*$/gm)) {
  if (m[1].startsWith("--")) continue;
  if (m[1].endsWith("/")) {
    // a directory copy: every file under it is copied
    const walk = (d) =>
      fs.readdirSync(path.join(repo, d), { withFileTypes: true }).forEach((e) => {
        if (e.name === "node_modules") return;
        e.isDirectory() ? walk(path.join(d, e.name)) : copied.add(path.join(d, e.name));
      });
    walk(m[1]);
  } else copied.add(m[1]);
}

// Only load-time requires: a top-level `const x = require("./y")` (column 0). Requires inside functions are indented and lazy.
function loadTimeRequires(file) {
  const src = fs.readFileSync(path.join(repo, file), "utf8");
  const out = [];
  for (const m of src.matchAll(/^(?:const|let|var)\s[^\n]*?require\((["'])(\.{1,2}\/[^"']+)\1\)/gm)) out.push(m[2]);
  for (const m of src.matchAll(/^import\s[^\n]*?from\s+(["'])(\.{1,2}\/[^"']+)\1/gm)) out.push(m[2]);
  for (const m of src.matchAll(/^(?:const|let|var)\s+\{[^}]*\}\s*=\s*require\((["'])(\.{1,2}\/[^"']+)\1\)/gm)) out.push(m[2]);
  return out;
}

function resolveTarget(fromFile, spec) {
  const base = path.normalize(path.join(path.dirname(fromFile), spec));
  for (const cand of [base, base + ".ts", base + ".js", base + ".mjs", base + ".json"]) {
    if (fs.existsSync(path.join(repo, cand)) && fs.statSync(path.join(repo, cand)).isFile()) return cand;
  }
  return null;
}

describe("headmaster-inference image", () => {
  test("ships every file its copied sources require at load time", () => {
    const missing = [];
    const queue = [...copied].filter((f) => /\.(ts|js|mjs)$/.test(f) && !f.includes("node_modules"));
    const seen = new Set();
    while (queue.length) {
      const file = queue.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of loadTimeRequires(file)) {
        const target = resolveTarget(file, spec);
        if (!target) {
          missing.push(`${file} requires ${spec} (not found in the repo)`);
          continue;
        }
        if (!copied.has(target)) missing.push(`${file} requires ${target} but the Dockerfile does not COPY it`);
        else queue.push(target);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the guard sees the file that broke the image", () => {
    expect(copied.has("agent-runtime/lib/headmasterInference.ts")).toBe(true);
  });
});
