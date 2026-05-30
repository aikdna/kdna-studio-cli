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
  creator: creatorApi,
} = require('@aikdna/kdna-studio-core');

const EXIT = { OK: 0, INPUT_ERROR: 2, HUMAN_LOCK_REQUIRED: 4, TRUST_FAILED: 5 };

function usage() {
  console.log(`kdna-studio — Studio-compatible KDNA authoring CLI

Identity:
  kdna-studio identity init [--name <display-name>]
  kdna-studio identity show

Create (three entry paths):
  kdna-studio create <project-dir> --name <@scope/name>                       # blank
  kdna-studio create <project-dir> --from-kdna <file.kdna> --name <@scope/name>
  kdna-studio create <project-dir> --from-folder <source-dir> --name <@scope/name>

Authoring:
  kdna-studio import <project> <source-file>
  kdna-studio card list <project>
  kdna-studio card add <project> <type> --field key=value [--field key=value]
  kdna-studio card approve <project> <card-id> --by <id> --statement <text> [--sign] [--passphrase <pass>]
  kdna-studio lock <project>
  kdna-studio compile <project> --out <dir>
  kdna-studio export <project> --out <file.kdna> [--sign]
  kdna-studio report <project>
  kdna-studio install <@scope/name|file.kdna> [--trusted]
  kdna-studio update <@scope/name>

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
  if (!dir) fail('Usage: kdna-studio create <project-dir> --name <name> [--from-kdna <file> | --from-folder <dir>]');
  const abs = path.resolve(dir);
  if (fs.existsSync(abs)) fail(`Directory already exists: ${abs}`);

  const name = option(args, '--name', path.basename(abs));
  const fromKdna = option(args, '--from-kdna');
  const fromFolder = option(args, '--from-folder');

  let sourceMode = 'blank';
  let lineage = null;
  let creatorIdentity = null;

  // Load creator identity if available
  try { creatorIdentity = creatorApi.loadIdentity(); } catch { /* no identity yet */ }

  if (fromKdna) {
    sourceMode = 'kdna_asset';
    const kdnaData = importFromKdna(fromKdna);
    lineage = kdnaData.lineage;
    if (kdnaData.cards) {
      const project = projectApi.createProject(name, 'domain', {
        author: { name: option(args, '--author-name', ''), id: option(args, '--author-id', '') },
        sourceMode,
        creatorIdentity,
        lineage,
      });
      project.cards = kdnaData.cards;
      if (project.stages?.judgment_cards) {
        project.stages.judgment_cards.total = kdnaData.cards.length;
        project.stages.judgment_cards.status = 'in_progress';
      }
      fs.mkdirSync(abs, { recursive: true });
      writeProject(path.join(abs, 'studio.project.json'), project);
      console.log(`Created Studio project (source_mode: ${sourceMode}, imported: ${kdnaData.cards.length} cards): ${abs}`);
      return;
    }
  } else if (fromFolder) {
    sourceMode = 'source_folder';
    importFromFolder(fromFolder, abs, name);
    return;
  }

  const project = projectApi.createProject(name, 'domain', {
    author: { name: option(args, '--author-name', ''), id: option(args, '--author-id', '') },
    sourceMode,
    creatorIdentity,
    lineage,
    sourcePath: fromFolder ? path.resolve(fromFolder) : null,
  });

  if (fromKdna || fromFolder) {
    fs.mkdirSync(abs, { recursive: true });
    writeProject(path.join(abs, 'studio.project.json'), project);
    if (fromFolder) {
      // Cards were already added by importFromFolder
    }
    console.log(`Created Studio project (source_mode: ${sourceMode}): ${abs}`);
    return;
  }

  fs.mkdirSync(abs, { recursive: true });
  writeProject(path.join(abs, 'studio.project.json'), project);
  console.log(`Created Studio project: ${abs}`);
}

/**
 * Import cards from an existing .kdna asset into a new Studio project.
 * Cards are imported as draft — they do NOT inherit trust from the source.
 */
function importFromKdna(kdnaPath) {
  const absKdna = path.resolve(kdnaPath);
  if (!fs.existsSync(absKdna)) fail(`KDNA asset not found: ${absKdna}`);
  if (!absKdna.endsWith('.kdna')) fail('--from-kdna requires a .kdna file');

  const zipBuf = fs.readFileSync(absKdna);
  const entries = readZipEntries(zipBuf);
  if (!entries.has('kdna.json')) fail('Not a valid .kdna asset: missing kdna.json');

  const manifest = JSON.parse(entries.get('kdna.json').toString());
  const lineage = {
    type: 'fork',
    parent_name: manifest.name || null,
    parent_asset_uid: manifest.asset_uid || null,
    parent_version: manifest.version || null,
    parent_asset_digest: manifest.content_digest || null,
  };

  // Extract cards from KDNA files
  const importedCards = [];
  if (entries.has('KDNA_Core.json')) {
    const core = JSON.parse(entries.get('KDNA_Core.json').toString());
    for (const ax of (core.axioms || [])) {
      const fields = {};
      for (const k of ['one_sentence','full_statement','why','applies_when','does_not_apply_when','failure_risk']) {
        if (k in ax) fields[k] = ax[k];
      }
      importedCards.push(cardApi.createCard('axiom', fields));
    }
    for (const ont of (core.ontology || [])) {
      importedCards.push(cardApi.createCard('ontology', {
        one_sentence: ont.one_sentence || ont.essence || '',
        essence: ont.essence || '', boundary: ont.boundary || '',
        trigger_signal: ont.trigger_signal || '',
      }));
    }
    for (const b of (core.boundaries || [])) {
      importedCards.push(cardApi.createCard('boundary', {
        scope: b.scope || '', out_of_scope: b.out_of_scope || '',
        acceptable_exceptions: b.acceptable_exceptions || [],
      }));
    }
  }
  if (entries.has('KDNA_Patterns.json')) {
    const pat = JSON.parse(entries.get('KDNA_Patterns.json').toString());
    for (const ms of (pat.misunderstandings || [])) {
      importedCards.push(cardApi.createCard('misunderstanding', {
        wrong: ms.wrong || '', correct: ms.correct || '',
        key_distinction: ms.key_distinction || '', why: ms.why || '',
      }));
    }
    for (const sc of (pat.self_check || [])) {
      const q = typeof sc === 'string' ? sc : sc.question || '';
      importedCards.push(cardApi.createCard('self_check', { question: q }));
    }
  }

  return { lineage, cards: importedCards };
}

/**
 * Import cards from a legacy source folder into a new Studio project.
 * Reads KDNA_*.json files and converts entries to draft judgment cards.
 * Outputs a schema audit report.
 */
function importFromFolder(sourceDir, projectDir, projectName) {
  const absSource = path.resolve(sourceDir);
  if (!fs.existsSync(absSource)) fail(`Source folder not found: ${absSource}`);
  if (!fs.statSync(absSource).isDirectory()) fail('--from-folder requires a directory');

  const audit = { filesFound: [], cardsImported: 0, missingFields: [], schemaWarnings: [] };
  const importedCards = [];

  function loadJson(filename) {
    const p = path.join(absSource, filename);
    if (!fs.existsSync(p)) return null;
    audit.filesFound.push(filename);
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch { audit.schemaWarnings.push(`${filename}: invalid JSON`); return null; }
  }

  const core = loadJson('KDNA_Core.json');
  const patterns = loadJson('KDNA_Patterns.json');
  const scenarios = loadJson('KDNA_Scenarios.json');
  const cases = loadJson('KDNA_Cases.json');
  const reasoning = loadJson('KDNA_Reasoning.json');
  const evolution = loadJson('KDNA_Evolution.json');

  if (core) {
    for (const ax of (core.axioms || [])) {
      const fields = {};
      for (const key of ['one_sentence', 'full_statement', 'why', 'applies_when', 'does_not_apply_when', 'failure_risk']) {
        if (key in ax) fields[key] = ax[key];
        else audit.missingFields.push(`axiom.${ax.id || '?'}.${key}`);
      }
      importedCards.push(cardApi.createCard('axiom', fields));
    }
    for (const ont of (core.ontology || [])) {
      importedCards.push(cardApi.createCard('ontology', {
        one_sentence: ont.one_sentence || ont.essence || '',
        essence: ont.essence || '', boundary: ont.boundary || '',
        trigger_signal: ont.trigger_signal || '',
      }));
    }
    for (const b of (core.boundaries || [])) {
      importedCards.push(cardApi.createCard('boundary', {
        scope: b.scope || '', out_of_scope: b.out_of_scope || '',
        acceptable_exceptions: b.acceptable_exceptions || [],
      }));
    }
    for (const r of (core.risks || core.risk_model || [])) {
      importedCards.push(cardApi.createCard('risk', r.fields || r));
    }
  }

  if (patterns) {
    for (const ms of (patterns.misunderstandings || [])) {
      importedCards.push(cardApi.createCard('misunderstanding', {
        wrong: ms.wrong || '', correct: ms.correct || '',
        key_distinction: ms.key_distinction || '', why: ms.why || '',
      }));
    }
    for (const sc of (patterns.self_check || [])) {
      const q = typeof sc === 'string' ? sc : sc.question || '';
      importedCards.push(cardApi.createCard('self_check', { question: q }));
    }
  }

  audit.cardsImported = importedCards.length;

  const project = projectApi.createProject(projectName, 'domain', {
    sourceMode: 'source_folder',
    sourcePath: absSource,
    creatorIdentity: null,
    lineage: { type: 'migrated', parent_name: null, parent_asset_uid: null, parent_version: null, parent_asset_digest: null },
  });
  project.cards = importedCards;
  if (project.stages?.judgment_cards) {
    project.stages.judgment_cards.total = importedCards.length;
    project.stages.judgment_cards.status = 'in_progress';
  }

  fs.mkdirSync(projectDir, { recursive: true });
  writeProject(path.join(projectDir, 'studio.project.json'), project);
  console.log(JSON.stringify({ audit, imported: importedCards.length, source_mode: 'source_folder' }, null, 2));
}

/**
 * Minimal ZIP central directory parser — reads entries into a Map.
 */
function readZipEntries(buf) {
  const entries = new Map();
  // Find end-of-central-directory record
  let eocdOffset = buf.length - 22;
  while (eocdOffset >= 0) {
    if (buf.readUInt32LE(eocdOffset) === 0x06054b50) break;
    eocdOffset--;
  }
  if (eocdOffset < 0) throw new Error('Not a valid ZIP file');

  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);
  let offset = centralDirOffset;

  while (offset < eocdOffset) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const compMethod = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const uncompSize = buf.readUInt32LE(offset + 24);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    // Read local file header to get data
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;

    if (compMethod === 0) {
      entries.set(name, buf.subarray(dataStart, dataStart + uncompSize));
    } else if (compMethod === 8) {
      entries.set(name, zlib.inflateRawSync(buf.subarray(dataStart, dataStart + compSize)));
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
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
      fail('Usage: kdna-studio card approve <project> <card-id> --by <id> --statement <text> [--sign]');
    }
    const by = option(args, '--by');
    const statement = option(args, '--statement');
    if (!by || !statement) fail('card approve requires --by and --statement');
    const { projectPath, project } = readProject(projectInput);
    const idx = (project.cards || []).findIndex((c) => c.id === cardId);
    if (idx < 0) fail(`Card not found: ${cardId}`);
    let card = project.cards[idx];
    if (card.status === 'draft') card = cardApi.transitionCard(card, 'revised', { by });

    const lockPayload = {
      by,
      statement,
      checked: { applies_when: true, does_not_apply_when: true, failure_risk: true },
    };

    // Sign Human Lock with creator identity if --sign is passed
    if (args.includes('--sign')) {
      const identity = creatorApi.loadIdentity();
      if (!identity) fail('No creator identity. Run: kdna-studio identity init --name "Your Name"', EXIT.TRUST_FAILED);
      lockPayload.creator_id = identity.creator_id;
      const passphrase = option(args, '--passphrase');
      try {
        if (identity.encrypted && !passphrase) {
          fail('Private key is encrypted — provide --passphrase to sign.', EXIT.TRUST_FAILED);
        }
        lockPayload.signature = creatorApi.signHumanLock(
          cardId, statement, cardApi.cardJudgmentFingerprint(card), null, passphrase,
        );
      } catch (e) {
        fail(`Failed to sign Human Lock: ${e.message}`, EXIT.TRUST_FAILED);
      }
    }

    project.cards[idx] = cardApi.lockCard(card, lockPayload);
    if (project.stages?.judgment_cards) {
      project.stages.judgment_cards.locked = project.cards.filter((c) => c.locked).length;
      project.stages.judgment_cards.total = project.cards.length;
    }
    writeProject(projectPath, project);
    const signed = lockPayload.signature ? ' (signed)' : '';
    console.log(`Approved and Human Locked: ${cardId}${signed}`);
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
  let privateKeyPem = fs.readFileSync(paths.privateKey, 'utf8');
  const cid = require('@aikdna/kdna-studio-core').creator;
  if (cid.isEncryptedKey(privateKeyPem)) {
    const p = require('./kdna-studio.js').__passphrase || '';
    if (!p) throw new Error('Private key is encrypted. Use --passphrase to sign exports.');
    privateKeyPem = cid.decryptPrivateKey(privateKeyPem, p);
  }
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
  files.mimetype = 'application/vnd.aikdna.kdna+zip';

  // Recompute content_digest after README.md / LICENSE / mimetype are added
  // so that manifest, receipt, and provenance report all agree with the final ZIP contents.
  const finalDigest = compileApi.computeContentDigest(files);
  result.identity.content_digest = finalDigest;

  // Update kdna.json manifest with final digest
  const manifest = JSON.parse(files['kdna.json']);
  manifest.content_digest = finalDigest;
  if (manifest.authoring) manifest.authoring.content_digest = finalDigest;
  files['kdna.json'] = JSON.stringify(manifest, null, 2);

  // Update build-receipt.json
  let receiptData = JSON.parse(files['build-receipt.json']);
  receiptData.content_digest = finalDigest;
  files['build-receipt.json'] = JSON.stringify(receiptData, null, 2);

  // Update provenance report
  const provenance = JSON.parse(files['reports/provenance-report.json']);
  provenance.content_digest = finalDigest;
  provenance.content_fingerprint = finalDigest;
  files['reports/provenance-report.json'] = JSON.stringify(provenance, null, 2);

  if (args.includes('--sign')) applySignature(files);

  const entries = [['mimetype', files.mimetype]];
  for (const name of Object.keys(files).filter(k => k !== 'mimetype').sort()) {
    entries.push([name, files[name]]);
  }
  const zip = buildZip(entries);
  const outPath = path.resolve(out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, zip);

  const assetDigest = `sha256:${crypto.createHash('sha256').update(zip).digest('hex')}`;
  receiptData = JSON.parse(files['build-receipt.json']);
  receiptData.asset_path = outPath;
  receiptData.asset_digest = assetDigest;
  receiptData.signature_status = args.includes('--sign') ? 'signed' : 'unsigned';
  fs.writeFileSync(path.join(path.dirname(outPath), 'build-receipt.json'), JSON.stringify(receiptData, null, 2));
  fs.writeFileSync(path.join(path.dirname(outPath), 'kdna.json'), files['kdna.json']);
  fs.writeFileSync(path.join(path.dirname(outPath), 'provenance-report.json'), files['reports/provenance-report.json']);
  fs.writeFileSync(path.join(path.dirname(outPath), 'quality-gate-report.json'), files['reports/quality-gate-report.json']);
  fs.writeFileSync(path.join(path.dirname(outPath), 'human-lock-report.json'), files['reports/human-lock-report.json']);
  fs.writeFileSync(path.join(path.dirname(outPath), 'eval-report.json'), files['reports/eval-report.json']);
  console.log(`Exported canonical .kdna asset: ${outPath}`);
  console.log(`Asset digest: ${assetDigest}`);
  console.log(`Build ID: ${result.identity.build_id}`);
}

function cmdStudioInstall(args) {
  // Delegate to kdna CLI for runtime install operations
  const target = args[0];
  if (!target) fail('Usage: kdna-studio install <@scope/name|file.kdna>');
  try {
    const kdnaArgs = ['install', target, '--yes'];
    if (args.includes('--trusted')) kdnaArgs.push('--trusted');
    const result = require('child_process').spawnSync('kdna', kdnaArgs, {
      stdio: 'inherit', encoding: 'utf8',
    });
    if (result.status !== 0) process.exit(result.status);
  } catch {
    fail('kdna CLI not found. Install with: npm install -g @aikdna/kdna-cli');
  }
}

function cmdStudioUpdate(args) {
  const target = args[0];
  if (!target) fail('Usage: kdna-studio update <@scope/name>');
  try {
    const result = require('child_process').spawnSync('kdna', ['update', target], {
      stdio: 'inherit', encoding: 'utf8',
    });
    if (result.status !== 0) process.exit(result.status);
  } catch {
    fail('kdna CLI not found. Install with: npm install -g @aikdna/kdna-cli');
  }
}

function cmdIdentity(args) {
  const sub = args[0];
  if (sub === 'init') {
    const name = option(args, '--name', process.env.USER || process.env.USERNAME || '');
    const passphrase = option(args, '--passphrase');
    try {
      const identity = creatorApi.initIdentity(name, null, passphrase);
      console.log(`Creator identity initialized:`);
      console.log(`  creator_id: ${identity.creator_id}`);
      console.log(`  display_name: ${identity.display_name}`);
      console.log(`  identity_dir: ${identity.identity_dir}`);
      console.log(`  public_key saved: ${identity.public_key_path}`);
      console.log(`  encrypted: ${identity.encrypted}`);
      console.log(`\nBack up your private key at: ${creatorApi.privateKeyPath()}`);
      if (identity.encrypted) {
        console.log(`  Private key is encrypted — keep your passphrase safe.`);
      }
    } catch (err) {
      fail(`Identity already exists. Use 'kdna-studio identity show' to view. ${err.message}`);
    }
    return;
  }
  if (sub === 'show') {
    const identity = creatorApi.loadIdentity();
    if (!identity) fail('No identity found. Run: kdna-studio identity init --name "Your Name"');
    console.log(JSON.stringify({
      creator_id: identity.creator_id,
      display_name: identity.display_name,
      verified: identity.verified || false,
      created_at: identity.created_at,
    }, null, 2));
    return;
  }
  fail('Usage: kdna-studio identity <init|show>');
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
  else if (cmd === 'identity') cmdIdentity(args.slice(1));
  else if (cmd === 'report') cmdReport(args.slice(1));
  else if (cmd === 'install') cmdStudioInstall(args.slice(1));
  else if (cmd === 'update') cmdStudioUpdate(args.slice(1));
  else {
    usage();
    fail(`Unknown command: ${cmd}`);
  }
} catch (err) {
  fail(err.message || String(err));
}
