#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const {
  project: projectApi,
  cards: cardApi,
  evidence: evidenceApi,
  compile: compileApi,
  quality,
} = require('@aikdna/kdna-studio-core');

const EXIT = { OK: 0, INPUT_ERROR: 2, HUMAN_LOCK_REQUIRED: 4, TRUST_FAILED: 5 };

function usage() {
  console.log(`kdna-studio — Studio-compatible KDNA authoring CLI

Usage:
  kdna-studio create <project-dir> [--name <@scope/name|name>]
  kdna-studio import <project> <source-file>
  kdna-studio card list <project>
  kdna-studio card add <project> <type> --field key=value [--field key=value]
  kdna-studio card approve <project> <card-id> --by <id> --statement <text>
  kdna-studio lock <project>
  kdna-studio compile <project> --out <dir>
  kdna-studio export <project> --out <file.kdna> [--sign]
  kdna-studio report <project>

Project may be a directory containing studio.project.json or a project JSON file.`);
}

function fail(message, code = EXIT.INPUT_ERROR) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function option(args, name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx < 0) return fallback;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) fail(`Missing value for ${name}`);
  return value;
}

function optionsAll(args, name) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) fail(`Missing value for ${name}`);
      values.push(value);
      i++;
    }
  }
  return values;
}

function resolveProjectPath(input) {
  if (!input) fail('Project path required');
  const abs = path.resolve(input);
  return fs.existsSync(abs) && fs.statSync(abs).isDirectory()
    ? path.join(abs, 'studio.project.json')
    : abs;
}

function readProject(input) {
  const projectPath = resolveProjectPath(input);
  if (!fs.existsSync(projectPath)) fail(`Project not found: ${projectPath}`);
  return { projectPath, project: projectApi.loadProject(fs.readFileSync(projectPath, 'utf8')) };
}

function writeProject(projectPath, project) {
  fs.mkdirSync(path.dirname(projectPath), { recursive: true });
  fs.writeFileSync(projectPath, projectApi.saveProject(project));
}

function writeFiles(outDir, files) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(outDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function parseFields(args) {
  const fields = {};
  for (const pair of optionsAll(args, '--field')) {
    const eq = pair.indexOf('=');
    if (eq < 1) fail(`Invalid --field "${pair}". Use key=value.`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    if (raw.startsWith('[') || raw.startsWith('{')) {
      try {
        fields[key] = JSON.parse(raw);
      } catch (_) {
        fields[key] = raw;
      }
    } else if (raw.includes('|')) {
      fields[key] = raw.split('|').map((s) => s.trim()).filter(Boolean);
    } else {
      fields[key] = raw;
    }
  }
  return fields;
}

function cmdCreate(args) {
  const dir = args[0];
  if (!dir) fail('Usage: kdna-studio create <project-dir> [--name <name>]');
  const abs = path.resolve(dir);
  if (fs.existsSync(abs)) fail(`Directory already exists: ${abs}`);
  const name = option(args, '--name', path.basename(abs));
  const project = projectApi.createProject(name, 'domain', {
    author: { name: option(args, '--author-name', ''), id: option(args, '--author-id', '') },
  });
  fs.mkdirSync(abs, { recursive: true });
  writeProject(path.join(abs, 'studio.project.json'), project);
  console.log(`Created Studio project: ${abs}`);
}

function cmdImport(args) {
  const [projectInput, source] = args;
  if (!projectInput || !source) fail('Usage: kdna-studio import <project> <source-file>');
  const { projectPath, project } = readProject(projectInput);
  const sourcePath = path.resolve(source);
  if (!fs.existsSync(sourcePath)) fail(`Source file not found: ${sourcePath}`);
  const content = fs.readFileSync(sourcePath, 'utf8');
  const evidence = evidenceApi.createEvidenceEntry('text', path.basename(sourcePath), content, sourcePath);
  evidenceApi.addEvidence(project, evidence);
  writeProject(projectPath, project);
  console.log(`Imported evidence: ${evidence.id}`);
}

function cmdCard(args) {
  const sub = args[0];
  if (sub === 'list') {
    const { project } = readProject(args[1]);
    for (const card of project.cards || []) {
      console.log(`${card.id}\t${card.type}\t${card.status}\t${card.locked ? 'locked' : 'unlocked'}`);
    }
    return;
  }
  if (sub === 'add') {
    const projectInput = args[1];
    const type = args[2];
    if (!projectInput || !type) fail('Usage: kdna-studio card add <project> <type> --field key=value');
    const { projectPath, project } = readProject(projectInput);
    const card = cardApi.createCard(type, parseFields(args.slice(3)));
    project.cards.push(card);
    if (project.stages?.judgment_cards) {
      project.stages.judgment_cards.total = project.cards.length;
      project.stages.judgment_cards.status = 'in_progress';
    }
    writeProject(projectPath, project);
    console.log(`Added card: ${card.id}`);
    return;
  }
  if (sub === 'approve') {
    const projectInput = args[1];
    const cardId = args[2];
    if (!projectInput || !cardId) {
      fail('Usage: kdna-studio card approve <project> <card-id> --by <id> --statement <text>');
    }
    const by = option(args, '--by');
    const statement = option(args, '--statement');
    if (!by || !statement) fail('card approve requires --by and --statement');
    const { projectPath, project } = readProject(projectInput);
    const idx = (project.cards || []).findIndex((c) => c.id === cardId);
    if (idx < 0) fail(`Card not found: ${cardId}`);
    let card = project.cards[idx];
    if (card.status === 'draft') card = cardApi.transitionCard(card, 'revised', { by });
    project.cards[idx] = cardApi.lockCard(card, {
      by,
      statement,
      checked: { applies_when: true, does_not_apply_when: true, failure_risk: true },
    });
    if (project.stages?.judgment_cards) {
      project.stages.judgment_cards.locked = project.cards.filter((c) => c.locked).length;
      project.stages.judgment_cards.total = project.cards.length;
    }
    writeProject(projectPath, project);
    console.log(`Approved and Human Locked: ${cardId}`);
    return;
  }
  fail('Usage: kdna-studio card <list|add|approve> ...');
}

function cmdLock(args) {
  const { project } = readProject(args[0]);
  const gate = projectApi.checkHumanLockGate(project);
  if (gate.blocked) {
    console.error('Human Lock Gate blocked export:');
    for (const issue of gate.issues) console.error(`  - ${issue.cardId}: ${issue.reason}`);
    process.exit(EXIT.HUMAN_LOCK_REQUIRED);
  }
  console.log(`Human Lock Gate passed: ${gate.lockedJudgmentCards} locked judgment cards`);
}

function compileProject(projectInput) {
  const { project } = readProject(projectInput);
  const gate = projectApi.checkHumanLockGate(project);
  if (gate.blocked) {
    const reasons = gate.issues.map((i) => `${i.cardId}: ${i.reason}`).join('\n  - ');
    fail(`Human Lock Gate blocked compile:\n  - ${reasons}`, EXIT.HUMAN_LOCK_REQUIRED);
  }
  return { project, result: compileApi.compileDomain(project) };
}

function cmdCompile(args) {
  const projectInput = args[0];
  const out = option(args, '--out', './dist/studio-build');
  if (!projectInput) fail('Usage: kdna-studio compile <project> --out <dir>');
  const { result } = compileProject(projectInput);
  writeFiles(path.resolve(out), result.files);
  console.log(`Compiled Studio build output: ${path.resolve(out)}`);
  console.log(`Build ID: ${result.identity.build_id}`);
}

function crc32(data) {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

function u16(parts, n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  parts.push(b);
}

function u32(parts, n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  parts.push(b);
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name);
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    const compressed = name === 'mimetype' ? raw : zlib.deflateRawSync(raw);
    const method = name === 'mimetype' ? 0 : 8;
    const crc = crc32(raw);
    const local = [];
    u32(local, 0x04034b50);
    u16(local, 20);
    u16(local, 0x0800);
    u16(local, method);
    u16(local, 0);
    u16(local, 0);
    u32(local, crc);
    u32(local, compressed.length);
    u32(local, raw.length);
    u16(local, nameBuf.length);
    u16(local, 0);
    local.push(nameBuf, compressed);
    const localBuf = Buffer.concat(local);
    chunks.push(localBuf);
    central.push({ nameBuf, method, crc, compressedSize: compressed.length, size: raw.length, offset });
    offset += localBuf.length;
  }
  const centralStart = offset;
  for (const entry of central) {
    const cd = [];
    u32(cd, 0x02014b50);
    u16(cd, 20);
    u16(cd, 20);
    u16(cd, 0x0800);
    u16(cd, entry.method);
    u16(cd, 0);
    u16(cd, 0);
    u32(cd, entry.crc);
    u32(cd, entry.compressedSize);
    u32(cd, entry.size);
    u16(cd, entry.nameBuf.length);
    u16(cd, 0);
    u16(cd, 0);
    u16(cd, 0);
    u16(cd, 0);
    u32(cd, 0);
    u32(cd, entry.offset);
    cd.push(entry.nameBuf);
    const cdBuf = Buffer.concat(cd);
    chunks.push(cdBuf);
    offset += cdBuf.length;
  }
  const eocd = [];
  u32(eocd, 0x06054b50);
  u16(eocd, 0);
  u16(eocd, 0);
  u16(eocd, central.length);
  u16(eocd, central.length);
  u32(eocd, offset - centralStart);
  u32(eocd, centralStart);
  u16(eocd, 0);
  chunks.push(Buffer.concat(eocd));
  return Buffer.concat(chunks);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function manifestForSigning(manifest) {
  const copy = { ...manifest };
  delete copy.signature;
  delete copy.asset_digest;
  delete copy.container_sha256;
  delete copy.content_digest;
  return copy;
}

function canonicalPayload(files) {
  return ['mimetype', ...Object.keys(files).filter((k) => k !== 'mimetype').sort()]
    .filter((name) => name !== 'signature.json' && name !== '.DS_Store')
    .map((name) => {
      let content = name === 'mimetype' ? 'application/vnd.aikdna.kdna+zip' : files[name];
      if (name.endsWith('.json')) {
        const json = JSON.parse(content);
        content = stableStringify(name === 'kdna.json' ? manifestForSigning(json) : json);
      }
      return `${name}:${crypto.createHash('sha256').update(Buffer.from(content)).digest('hex')}`;
    })
    .join('\n');
}

function identityPaths() {
  const dir = process.env.KDNA_IDENTITY_DIR || path.join(os.homedir(), '.kdna', 'identity');
  return { privateKey: path.join(dir, 'kdna.key'), publicKey: path.join(dir, 'kdna.pub') };
}

function publicKeyFingerprint(publicKeyPem) {
  return `ed25519:${crypto.createHash('sha256').update(publicKeyPem).digest('hex')}`;
}

function applySignature(files) {
  const paths = identityPaths();
  if (!fs.existsSync(paths.privateKey) || !fs.existsSync(paths.publicKey)) {
    fail('Signing requires KDNA identity keys. Run: kdna identity init', EXIT.TRUST_FAILED);
  }
  const manifest = JSON.parse(files['kdna.json']);
  const publicKeyPem = fs.readFileSync(paths.publicKey, 'utf8');
  manifest.author = manifest.author || {};
  manifest.author.pubkey = publicKeyFingerprint(publicKeyPem);
  manifest.author.public_key_pem = publicKeyPem;
  files['kdna.json'] = JSON.stringify(manifest, null, 2);

  const payload = canonicalPayload(files);
  const privateKeyPem = fs.readFileSync(paths.privateKey, 'utf8');
  manifest.signature = `ed25519:${crypto.sign(null, Buffer.from(payload), privateKeyPem).toString('hex')}`;
  files['kdna.json'] = JSON.stringify(manifest, null, 2);
}

function cmdExport(args) {
  const projectInput = args[0];
  const out = option(args, '--out');
  if (!projectInput || !out) fail('Usage: kdna-studio export <project> --out <file.kdna> [--sign]');
  const { project, result } = compileProject(projectInput);
  const files = { ...result.files };
  files['README.md'] = compileApi.generateReadme(project);
  files.LICENSE = project.license?.type || 'UNSPECIFIED';
  if (args.includes('--sign')) applySignature(files);

  const entries = [['mimetype', 'application/vnd.aikdna.kdna+zip']];
  for (const name of Object.keys(files).sort()) entries.push([name, files[name]]);
  const zip = buildZip(entries);
  const outPath = path.resolve(out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, zip);

  const assetDigest = `sha256:${crypto.createHash('sha256').update(zip).digest('hex')}`;
  const receipt = JSON.parse(files['build-receipt.json']);
  receipt.asset_path = outPath;
  receipt.asset_digest = assetDigest;
  receipt.signature_status = args.includes('--sign') ? 'signed' : 'unsigned';
  fs.writeFileSync(path.join(path.dirname(outPath), 'build-receipt.json'), JSON.stringify(receipt, null, 2));
  fs.writeFileSync(path.join(path.dirname(outPath), 'provenance-report.json'), files['reports/provenance-report.json']);
  fs.writeFileSync(path.join(path.dirname(outPath), 'quality-gate-report.json'), files['reports/quality-gate-report.json']);
  fs.writeFileSync(path.join(path.dirname(outPath), 'human-lock-report.json'), files['reports/human-lock-report.json']);
  fs.writeFileSync(path.join(path.dirname(outPath), 'eval-report.json'), files['reports/eval-report.json']);
  console.log(`Exported canonical .kdna asset: ${outPath}`);
  console.log(`Asset digest: ${assetDigest}`);
  console.log(`Build ID: ${result.identity.build_id}`);
}

function cmdReport(args) {
  const { project } = readProject(args[0]);
  const readiness = quality.computeReadiness(project);
  const gate = projectApi.checkHumanLockGate(project);
  console.log(JSON.stringify({ readiness, human_lock_gate: gate }, null, 2));
  process.exit(gate.blocked ? EXIT.HUMAN_LOCK_REQUIRED : EXIT.OK);
}

const args = process.argv.slice(2);
const cmd = args[0];
if (!cmd || cmd === '--help' || cmd === '-h') {
  usage();
  process.exit(EXIT.OK);
}

try {
  if (cmd === 'create') cmdCreate(args.slice(1));
  else if (cmd === 'import') cmdImport(args.slice(1));
  else if (cmd === 'card') cmdCard(args.slice(1));
  else if (cmd === 'lock') cmdLock(args.slice(1));
  else if (cmd === 'compile') cmdCompile(args.slice(1));
  else if (cmd === 'export') cmdExport(args.slice(1));
  else if (cmd === 'report') cmdReport(args.slice(1));
  else {
    usage();
    fail(`Unknown command: ${cmd}`);
  }
} catch (err) {
  fail(err.message || String(err));
}
