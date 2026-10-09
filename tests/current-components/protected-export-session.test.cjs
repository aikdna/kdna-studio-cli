"use strict";
// S-J2: protected export through a dedicated password fd, end to end.
// Positive: bundle delivered as a protected container; both slots unlock via
// Core protected admission; recovery code displayed exactly once on stderr;
// no plaintext at the delivery position; isolated intermediate cleaned.
// Negative matrix (each fail-closed, no bundle):
//   argv value / fd collision / invalid fd number / empty / oversize / bad UTF-8.
const test = require("node:test"), assert = require("node:assert/strict"), { spawn } = require("node:child_process");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const base = path.resolve(process.env.STUDIO_TEST_PACKAGE_ROOT || path.resolve(__dirname, "../..")), bin = path.join(base, "bin/kdna-studio.js");
const packageRequire = require("node:module").createRequire(path.join(base, "package.json"));
const root = path.resolve(process.env.STUDIO_TEST_ARTIFACT_ROOT || path.join(__dirname, ".artifacts", String(process.pid)));
fs.mkdirSync(root, { recursive: true });
let serial = 0;
const PASSWORD = "correct horse battery staple";

function run(argv, label, { passwordBytes = null } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [bin, ...argv], { cwd: base, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] });
    let out = "", err = "", partial = "";
    const events = [];
    const record = { pid: p.pid, start: new Date().toISOString(), argv };
    p.stdout.on("data", b => { out += b; partial += b; let k; while ((k = partial.indexOf("\n")) >= 0) { const line = partial.slice(0, k); partial = partial.slice(k + 1); try { events.push(JSON.parse(line)); } catch { } } });
    p.stderr.on("data", b => { err += b; });
    p.stdin.on("error", () => { }); p.stdio[3].on("error", () => { }); p.stdio[4].on("error", () => { });
    p.on("error", reject);
    p.on("close", (code, signal) => {
      clearTimeout(timer);
      record.end = new Date().toISOString(); record.exit = code; record.signal = signal;
      fs.writeFileSync(path.join(root, label + ".execution.json"), JSON.stringify({ ...record, stdout: out, stderr: err, events }, null, 2), { flag: "wx" });
      resolve({ ...record, out, err, events });
    });
    const timer = setTimeout(() => { p.kill("SIGTERM"); }, 15000);
    run.last = p;
    if (passwordBytes !== null) { p.stdio[4].write(passwordBytes); p.stdio[4].end(); }
  });
}

const alternative = {
  localKey: "preserve", title: "Observed signal", subject: "A synthetic observation",
  scope: "Missing observations only", statement: "Retain unknown when an observation is absent.",
  formationRule: { conditions: [] }, rationale: "No observation does not establish a negative finding.", materials: [1],
  method: { method: { term: "feeling" }, components: [{ localKey: "states", type: "taxonomy", method: { term: "feeling" }, role: "个人感受", statement: "The authored preference rests on an actual felt priority.", content: { items: [{ key: "known", title: "Observed é", meaning: "Input observation is present." }, { key: "unknown", title: "Unobserved é", meaning: "Input observation is absent." }], broader: [] } }] }
};

async function driveProtected(label, { passwordBytes = null, passwordFd = 4, extraArgv = [] } = {}) {
  const folder = path.join(root, label); fs.mkdirSync(folder);
  const source = path.join(folder, "material.txt"); fs.writeFileSync(source, "PRIVATE_CLI_SOURCE_TEXT_" + label);
  const bundle = path.join(folder, "bundle");
  const argv = ["session", "--out", bundle, "--text", source, "--synthetic-fixture", "--human-fd", "3", "--password-fd", String(passwordFd), ...extraArgv];
  const promise = run(argv, label, { passwordBytes: passwordBytes === null ? Buffer.from(PASSWORD + "\n") : passwordBytes });
  const p = run.last; let buffer = "";
  const send = (id, op, data) => p.stdin.write(JSON.stringify({ id, op, data }) + "\n");
  p.stdout.on("data", b => {
    buffer += b; let k;
    while ((k = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, k); buffer = buffer.slice(k + 1); let e;
      try { e = JSON.parse(raw); } catch { continue; }
      if (e.event === "ready") send("brief", "brief", { title: "CLI protected fixture", scope: "Independent process synthetic integration.", highest_question: "Which choice preserves honest uncertainty?" });
      else if (e.id === "brief") send("proposal", "propose", { localKey: "signal", alternatives: [alternative, { ...alternative, localKey: "infer", statement: "Treat missing input as a negative." }] });
      else if (e.id === "proposal") { send("select-review", "review", {}); p.stdio[3].write("Select the preserve alternative.\n"); }
      else if (e.event === "adoption_reply") send("interpret-" + e.replyTo, "interpret", { replyTo: e.replyTo, kind: e.review.preview ? "confirm" : "select", ...(e.review.preview ? {} : { choices: [{ judgmentLocalKey: "signal", alternativeLocalKey: "preserve" }] }) });
      else if (e.id === "select-review") send("preview", "preview", {});
      else if (e.id === "preview") { send("confirm-review", "review", {}); p.stdio[3].write("Confirm this exact current preview.\n"); }
      else if (e.id === "confirm-review") send("export", "export", {});
    }
  });
  return { result: await promise, bundle };
}

test("protected export delivers a dual-slot container and displays the recovery code exactly once", async () => {
  const residueBefore = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith("kdna-studio-protected-export-"));
  const { result, bundle } = await driveProtected("protected-ok");
  assert.equal(result.exit, 0, result.err);
  // saved-byte completion ran on the unprotected bytes (named semantics)
  const verification = JSON.parse(fs.readFileSync(path.join(bundle, "verification.json")));
  assert.equal(verification.status, "accepted_with_live_context");
  const complete = JSON.parse(fs.readFileSync(path.join(bundle, "complete.json")));
  assert.equal(complete.version, 2);
  assert.deepEqual(complete.protection, { profile: "kdna.envelope.aead", slots: ["password", "recovery"], verification_basis: "pre_protection_plaintext" });
  // delivery position carries the protected container, not a plain ZIP
  const delivered = fs.readFileSync(path.join(bundle, "asset.kdna"));
  const { openSourceBytes } = packageRequire("@aikdna/kdna-core/authoring-node");
  assert.notEqual(openSourceBytes(delivered).status, "accepted");
  assert.equal(delivered.includes(Buffer.from("PRIVATE_CLI_SOURCE_TEXT_")), false);
  // recovery code: exactly once, on stderr, never on stdout
  const codes = result.err.match(/kdna-recover-[0-9A-F-]+/g) || [];
  assert.equal(codes.length, 1, result.err);
  const recoveryCode = codes[0];
  assert.match(recoveryCode, /^kdna-recover-(?:[0-9A-F]{4}-){15}[0-9A-F]{4}$/);
  assert.equal(result.out.includes(recoveryCode), false);
  // both slots unlock via Core protected admission; wrong credential rejects
  const { admitProtectedNode } = packageRequire("@aikdna/kdna-core/protection-node");
  const policy = { signaturePolicy: { requireSignature: false, expectedPublicKeyHex: null } };
  const provider = { kind: "local", clock: () => Date.now() };
  const slot0 = await admitProtectedNode(delivered, { credential: { kind: "password", password: Buffer.from(PASSWORD), slotIndex: 0 }, ...policy }, provider);
  assert.equal(slot0.status, "accepted");
  const slot1 = await admitProtectedNode(delivered, { credential: { kind: "password", password: Buffer.from(recoveryCode), slotIndex: 1 }, ...policy }, provider);
  assert.equal(slot1.status, "accepted");
  const wrong = await admitProtectedNode(delivered, { credential: { kind: "password", password: Buffer.from("wrong-password"), slotIndex: 0 }, ...policy }, provider);
  assert.equal(wrong.status, "protection_failed");
  // the unlocked plaintext is the original packed container
  const unlocked = slot0.plaintext ?? slot0.payload ?? null;
  if (unlocked) assert.equal(Buffer.from(unlocked).subarray(0, 2).toString("latin1"), "PK");
  // isolated intermediate is gone
  const residueAfter = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith("kdna-studio-protected-export-"));
  assert.deepEqual(residueAfter, residueBefore);
});

test("password values are refused in process arguments", async () => {
  const result = await run(["session", "--out", path.join(root, "never-argv"), "--password=secret-must-not-surface"], "argv-value");
  assert.equal(result.exit, 2);
  assert.match(result.err, /CLI_PASSWORD_ARGV_FORBIDDEN/);
  assert.equal(result.err.includes("secret-must-not-surface"), false);
  const bare = await run(["session", "--out", path.join(root, "never-argv2"), "--password"], "argv-bare");
  assert.equal(bare.exit, 2);
  assert.match(bare.err, /CLI_PASSWORD_ARGV_FORBIDDEN/);
});

test("the password fd must be a distinct pipe channel", async () => {
  const collide = await run(["session", "--out", path.join(root, "never-collide"), "--human-fd", "3", "--password-fd", "3"], "fd-collide");
  assert.equal(collide.exit, 2);
  assert.match(collide.err, /CLI_PASSWORD_FD_INVALID/);
  const low = await run(["session", "--out", path.join(root, "never-low"), "--password-fd", "2"], "fd-low");
  assert.equal(low.exit, 2);
  assert.match(low.err, /CLI_PASSWORD_FD_INVALID/);
});

test("empty, oversize and non-UTF-8 passwords fail closed without a bundle", async () => {
  const empty = await driveProtected("password-empty", { passwordBytes: Buffer.alloc(0) });
  assert.equal(empty.result.exit, 2); assert.match(empty.result.err, /CLI_PASSWORD_UNAVAILABLE/);
  assert.equal(fs.existsSync(empty.bundle), false);

  const oversize = await driveProtected("password-oversize", { passwordBytes: Buffer.concat([Buffer.alloc(64 * 1024 + 1, 0x61)]) });
  assert.equal(oversize.result.exit, 2); assert.match(oversize.result.err, /CLI_PASSWORD_TOO_LARGE/);
  assert.equal(fs.existsSync(oversize.bundle), false);

  const badUtf8 = await driveProtected("password-bad-utf8", { passwordBytes: Buffer.from([0xff, 0xfe, 0xfd]) });
  assert.equal(badUtf8.result.exit, 2); assert.match(badUtf8.result.err, /CLI_PASSWORD_ENCODING_INVALID/);
  assert.equal(fs.existsSync(badUtf8.bundle), false);
});
