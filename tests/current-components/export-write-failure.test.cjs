"use strict";
// Regression: a failed export write must surface the real operating-system
// error and must not leave an incomplete read-only bundle behind.
//
// The failure is injected with RLIMIT_FSIZE (`ulimit -f`) plus an ignored
// SIGXFSZ, which is the portable way to reach the EFBIG write error instead of
// letting the limit signal kill the child. The previous implementation
// registered an output file only after its write returned, so a part-way write
// left an unregistered file, the directory removal failed with ENOTEMPTY, and
// that cleanup error replaced the real one.
const test = require("node:test"), assert = require("node:assert/strict"), { spawn } = require("node:child_process");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const base = path.resolve(process.env.STUDIO_TEST_PACKAGE_ROOT || path.resolve(__dirname, "../..")), bin = path.join(base, "bin/kdna-studio.js");
const root = path.resolve(process.env.STUDIO_TEST_ARTIFACT_ROOT || path.join(__dirname, ".artifacts", String(process.pid)));

const alternative = {
  localKey: "preserve", title: "Observed signal", subject: "A synthetic observation",
  scope: "Missing observations only", statement: "Retain unknown when an observation is absent.",
  formationRule: { conditions: [] }, rationale: "No observation does not establish a negative finding.", materials: [1],
  method: { method: { term: "feeling" }, components: [{ localKey: "states", type: "taxonomy", method: { term: "feeling" }, role: "个人感受", statement: "The authored preference rests on an actual felt priority.", content: { items: [{ key: "known", title: "Observed", meaning: "Input observation is present." }, { key: "unknown", title: "Unobserved", meaning: "Input observation is absent." }], broader: [] } }] }
};

function driveWithFileSizeLimit(bundle, source, limitBlocks) {
  return new Promise((resolve, reject) => {
    const argv = ["session", "--out", bundle, "--text", source, "--synthetic-fixture", "--human-fd", "3"];
    const child = spawn("/bin/sh", ["-c", 'trap "" XFSZ; ulimit -f ' + limitBlocks + '; exec "$0" "$@"', process.execPath, bin, ...argv],
      { cwd: base, stdio: ["pipe", "pipe", "pipe", "pipe"] });
    let out = "", err = "", buffer = "";
    const send = (id, op, data) => child.stdin.write(JSON.stringify({ id, op, data }) + "\n");
    child.stdout.on("data", (chunk) => {
      out += chunk; buffer += chunk; let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, index); buffer = buffer.slice(index + 1); let event;
        try { event = JSON.parse(raw); } catch { continue; }
        if (event.event === "ready") send("brief", "brief", { title: "Write-failure fixture", scope: "Independent process synthetic integration.", highest_question: "Which choice preserves honest uncertainty?" });
        else if (event.id === "brief") send("proposal", "propose", { localKey: "signal", alternatives: [alternative, { ...alternative, localKey: "infer", statement: "Treat missing input as a negative." }] });
        else if (event.id === "proposal") { send("select-review", "review", {}); child.stdio[3].write("Select the preserve alternative.\n"); }
        else if (event.event === "adoption_reply") send("interpret-" + event.replyTo, "interpret", { replyTo: event.replyTo, kind: event.review.preview ? "confirm" : "select", ...(event.review.preview ? {} : { choices: [{ judgmentLocalKey: "signal", alternativeLocalKey: "preserve" }] }) });
        else if (event.id === "select-review") send("preview", "preview", {});
        else if (event.id === "preview") { send("confirm-review", "review", {}); child.stdio[3].write("Confirm this exact current preview.\n"); }
        else if (event.id === "confirm-review") send("export", "export", {});
      }
    });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.stdin.on("error", () => {}); child.stdio[3].on("error", () => {});
    child.on("error", reject);
    const timer = setTimeout(() => child.kill("SIGTERM"), 20000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

test("a failed export write surfaces the real error and leaves no bundle behind", async (t) => {
  fs.mkdirSync(root, { recursive: true });
  const folder = fs.mkdtempSync(path.join(root, "write-failure-"));
  const source = path.join(folder, "material.txt");
  fs.writeFileSync(source, "PRIVATE_CLI_SOURCE_TEXT_WRITE_FAILURE");
  const bundle = path.join(folder, "bundle");
  const result = await driveWithFileSizeLimit(bundle, source, 2);
  if (result.code === 0) {
    t.skip("this filesystem does not enforce RLIMIT_FSIZE; the injected write failure did not occur");
    return;
  }
  assert.equal(fs.existsSync(bundle), false, "an incomplete bundle must not survive a failed export");
  assert.match(result.err, /(EFBIG|ENOSPC|EIO|EDQUOT)/, result.err);
  assert.doesNotMatch(result.err, /ENOTEMPTY/, "cleanup must not replace the original write error with ENOTEMPTY");
  assert.equal(result.err.includes("Residual export path was not fully removed"), false, result.err);
  assert.equal(result.out.includes("Residual export path"), false);
  fs.rmSync(folder, { recursive: true, force: true });
});
