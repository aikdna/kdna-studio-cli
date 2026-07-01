#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const cbor = require('cbor-x');
const { execFileSync } = require('child_process');

function loadStudioCore() {
  const publishedCore = require('@aikdna/kdna-studio-core');
  if (publishedCore.exportRuntime) return publishedCore;
  try {
    return require('../../kdna-studio-core/src');
  } catch (_) {
    return publishedCore;
  }
}

const {
  project: projectApi,
  cards: cardApi,
  evidence: evidenceApi,
  compile: compileApi,
  quality,
  creator: creatorApi,
  distillation: distillationApi,
  exportRuntime,
} = loadStudioCore();

const llm = require('../src/llm');

// Bug (#1 UX): the LLM-requiring commands (distill, interview, feynman,
// test) silently fail with a stack trace when no LLM is configured.
// First-time users hit this and have no way to know what to do. The
// fix routes every LLM call through this helper, which:
//   1. Checks whether an LLM is configured at all
//   2. If not and --no-llm is given, returns a static / synthesised
//      result so the command can still be useful (5-minute path)
//   3. If not and --no-llm is absent, exits with a clear
//      "configure LLM with: kdna-studio llm config" message
function cmdNeedsLlm(args, cmdName) {
  const cfg = llm.config();
  const hasLlm = cfg && cfg.provider && cfg.apiKey && cfg.model;
  if (hasLlm) return { hasLlm: true, cfg };
  if (args.includes('--no-llm')) {
    return {
      hasLlm: false,
      cfg,
      noLlm: true,
      message: `${cmdName} invoked with --no-llm. Output will be static / synthesised; configure an LLM with \`kdna-studio llm config\` to enable real evaluation.`,
    };
  }
  fail(
    `${cmdName} requires an LLM. Configure one with:\n` +
    `  kdna-studio llm config --provider openai --key <api-key> --model <model>\n` +
    `Or set env vars: KDNA_LLM_PROVIDER, KDNA_LLM_API_KEY, KDNA_LLM_MODEL.\n` +
    `Or run with --no-llm to get a static / synthesised result.`,
  );
}
const ai = require('../src/ai');

const EXIT = { OK: 0, INPUT_ERROR: 2, HUMAN_LOCK_REQUIRED: 4, TRUST_FAILED: 5 };

function usage() {
  console.log(`kdna-studio — Studio-compatible KDNA authoring CLI

LLM (AI-powered authoring; every AI command accepts --no-llm for a static result):
  kdna-studio llm config [--provider <name>] [--model <name>] [--key-pipe] [--url <base-url>]
  kdna-studio llm show
  (run 'kdna-studio llm config --provider openai --key <key> --model gpt-4' to enable
   feynman, distill --ai, interview, and test. With --no-llm these commands
   still produce a structured but unsynthesised result.)

Identity:
  kdna-studio identity init [--name <display-name>]
  kdna-studio identity show

Create (three entry paths):
  kdna-studio create <project-dir> --name <@scope/name> [--author <name>]                        # blank
  kdna-studio create <project-dir> --from-kdna <file.kdna> --name <@scope/name>
  kdna-studio create <project-dir> --from-folder <source-dir> --name <@scope/name>

Migrate (dev source or Studio project → canonical .kdna in one command):
  kdna-studio migrate <source-dir|project> --format v1 --out <file.kdna> --name <@scope/name> --by <id> --statement <text> [--allow-incomplete] [--sign] [--passphrase <pw>|--passphrase-stdin]
  kdna-studio migrate <source-dir> --check --name <@scope/name>   # pre-flight: report which fields would block the export without writing the .kdna
  kdna-studio audit-locks <project> [--type axiom|risk|stance|...] [--json]   # list cards with missing Human Lock fields (per-card-type, per-field)

Authoring:
  kdna-studio import <project> <source-file-or-dir>               # import evidence (txt/md/json/yaml/csv/log/srt/vtt/html)
  kdna-studio filter <project>                                    # check evidence for sensitive content
  kdna-studio source <project>                                    # classify imported evidence against declared target
  kdna-studio card list <project>
  kdna-studio card add <project> <type> --field key=value [--field key=value] [--template <name>] [--no-strict]
  kdna-studio card update <project> <card-id> --field key=value
  kdna-studio card remove <project> <card-id>
  kdna-studio card approve <project> <card-id|--all> --by <id> --statement <text> [--sign] [--passphrase <pass>]
  kdna-studio card unlock <project> <card-id> --by <id> --statement <text>
  kdna-studio compile <project> --out <dir>
  kdna-studio export <project> --format v1 --out <file.kdna> [--allow-incomplete] [--password <pw>|--password-stdin]

AI Authoring (requires LLM config: kdna-studio llm config):
  kdna-studio distill <project> --ai                             # AI-driven candidate extraction from evidence
  kdna-studio distill <project> --candidates <file.json>          # load pre-generated AI candidates
  kdna-studio interview <project> [--stage <name>]               # 4-stage guided AI interview
  kdna-studio feynman <project> <card-id>                        # AI Feynman evaluation (5-dimension)
  kdna-studio test <project> --input "<text>" [--preset baseline|edge|contradiction]

Distillation:
  kdna-studio target declare <project>                           # declare distillation target interactively
  kdna-studio target declare <project> --category <cat> --scope <scope> --granularity <gran> --task <task> [--include <area,area>] [--exclude <area,area>] [--load-condition <condition>]
  kdna-studio target show <project>                              # show current distillation target
  kdna-studio candidate list <project>                           # list candidates with scope and status
  kdna-studio candidate accept <project> <candidate-id>
  kdna-studio candidate reject <project> <candidate-id>
  kdna-studio candidate override <project> <candidate-id>        # override scope gate
  kdna-studio candidate promote <project>                        # promote accepted+scope_fit → cards
  kdna-studio report <project>
  kdna-studio audit-locks <project>            # list all axioms/risk/stance missing Human Lock fields

Project may be a directory containing studio.project.json or a project JSON file.`);
}

function fail(message, code = EXIT.INPUT_ERROR) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

// Bug (#65): `fail()` calls `process.exit`, which skips `finally`
// blocks in the same call stack. Any tmpDir that a `try { ... }
// finally { fs.rmSync(tmpDir) }` block is in the middle of running
// will leak. The fix tracks every temporary directory the process
// creates and removes it on process exit (including the exit path
// triggered by `fail()`).
const _tempDirs = new Set();
function trackTempDir(dir) {
  if (dir) _tempDirs.add(dir);
  return dir;
}
function cleanupTempDirs() {
  for (const dir of _tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  _tempDirs.clear();
}
process.on('exit', cleanupTempDirs);
process.on('SIGINT', () => { cleanupTempDirs(); process.exit(130); });
process.on('SIGTERM', () => { cleanupTempDirs(); process.exit(143); });

function option(args, name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx < 0) return fallback;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) fail(`Missing value for ${name}`);
  return value;
}

/**
 * Resolve a passphrase from CLI flags, environment, or stdin.
 *
 * SECURITY: passing a passphrase as `--passphrase <value>` exposes it in
 * `ps aux` output and shell history. The recommended path is one of:
 *   1. --passphrase-stdin  — read from stdin (pipe-friendly, no TTY hang)
 *   2. KDNA_PASSPHRASE env var (less secure but no process-list leak)
 *   3. --passphrase <pw>   — fallback only; prints a warning
 *
 * Returns the passphrase string, or null if none was provided.
 */
function resolvePassphrase(args) {
  if (args.includes('--passphrase-stdin')) {
    if (process.stdin.isTTY) {
      fail(
        '--passphrase-stdin requires the passphrase to be piped in on stdin.\n' +
        'Example:  read -s PW && echo "$PW" | kdna-studio export ... --sign --passphrase-stdin'
      );
    }
    try {
      return fs.readFileSync(0, 'utf8').trim();
    } catch (e) {
      fail(`Could not read passphrase from stdin: ${e.message}`);
    }
  }
  if (process.env.KDNA_PASSPHRASE) return process.env.KDNA_PASSPHRASE;
  const fromFlag = option(args, '--passphrase');
  if (fromFlag) {
    console.error('Warning: --passphrase <value> exposes the secret in `ps aux` and shell history. Prefer --passphrase-stdin or KDNA_PASSPHRASE env var.');
    return fromFlag;
  }
  return null;
}

function resolveApiKey(args) {
  // 1. KDNA_API_KEY environment variable (preferred)
  if (process.env.KDNA_API_KEY) return process.env.KDNA_API_KEY;

  // 2. Read from stdin via --key-pipe flag
  if (args.includes('--key-pipe')) {
    if (process.stdin.isTTY) {
      console.error('Error: --key-pipe requires stdin to be piped. Example: echo $KDNA_API_KEY | kdna-studio llm config --key-pipe');
      return null;
    }
    try {
      return fs.readFileSync(0, 'utf8').trim();
    } catch (e) {
      console.error('Error reading API key from stdin:', e.message);
      return null;
    }
  }

  // 3. Deprecated --key / -k flag (backward compat)
  const key = option(args, '--key', null) || option(args, '-k', null);
  if (key) {
    console.error('Warning: --key is deprecated and exposes secrets in shell history and ps output. Use KDNA_API_KEY env var or pipe via stdin (--key-pipe).');
    return key;
  }

  return null;
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

const ARRAY_FIELD_NAMES = new Set([
  'applies_when',
  'does_not_apply_when',
  'acceptable_exceptions',
]);

function parseFields(args) {
  const fields = {};
  for (const pair of optionsAll(args, '--field')) {
    const eq = pair.indexOf('=');
    if (eq < 1) fail(`Invalid --field "${pair}". Use key=value.`);
    let key = pair.slice(0, eq);
    const appendArray = key.endsWith('[]');
    if (appendArray) key = key.slice(0, -2);
    const raw = pair.slice(eq + 1);
    let value;
    if (raw.startsWith('[') || raw.startsWith('{')) {
      try {
        value = JSON.parse(raw);
      } catch (_) {
        value = raw;
      }
    } else if (raw.includes('|')) {
      value = raw.split('|').map((s) => s.trim()).filter(Boolean);
    } else {
      value = raw;
    }

    if (appendArray) {
      const values = Array.isArray(value) ? value : [value];
      fields[key] = [...(Array.isArray(fields[key]) ? fields[key] : []), ...values];
    } else if (ARRAY_FIELD_NAMES.has(key) && typeof value === 'string') {
      fields[key] = value.trim() ? [value.trim()] : [];
    } else {
      fields[key] = value;
    }
  }
  return fields;
}

function semverValue(value, fallback = '1.0.0') {
  const raw = String(value || '').trim();
  if (/^[0-9]+\.[0-9]+\.[0-9]+([+-].+)?$/.test(raw)) return raw;
  const twoPart = raw.match(/^([0-9]+)\.([0-9]+)$/);
  if (twoPart) return `${twoPart[1]}.${twoPart[2]}.0`;
  return fallback;
}

function isoDateTime(value) {
  if (!value) return new Date().toISOString();
  const raw = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00.000Z`;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function slugSegment(value, fallback = 'asset') {
  const s = String(value || fallback)
    .trim()
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || fallback;
}

function assetIdFromName(name) {
  const raw = String(name || '').trim();
  if (/^[a-zA-Z][a-zA-Z0-9_-]*(:[a-zA-Z0-9_.-]+)+$/.test(raw)) return raw;
  const scoped = raw.match(/^@?([^/:\s]+)\/([^/:\s]+)$/);
  if (scoped) return `kdna:${slugSegment(scoped[1], 'scope')}:${slugSegment(scoped[2], 'asset')}`;
  const parts = raw.split(':').filter(Boolean);
  if (parts.length >= 2) return `kdna:${parts.map((p) => slugSegment(p)).join(':')}`;
  return `kdna:studio:${slugSegment(raw, 'asset')}`;
}

function titleFromName(name, assetId) {
  const raw = String(name || '').trim();
  if (raw) return raw.replace(/^@/, '').replace('/', ' / ');
  return assetId;
}

function publicManifestMetadata(raw = {}) {
  const copy = { ...raw };
  delete copy.registry;
  delete copy.quality_badge;
  delete copy.signature;
  delete copy.media_type;
  return copy;
}

function cleanFields(fields = {}) {
  const cleaned = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (value !== undefined && value !== null) cleaned[key] = value;
  }
  return cleaned;
}

function importedCard(type, fields = {}, id = null) {
  try {
    return cardApi.createCard(type, cleanFields(fields), id || null);
  } catch (_) {
    return null;
  }
}

// Bug (#3 + #4 UX): payload.kdnab intentionally carries the same
// misunderstanding card in two places — `patterns[]` (the v1 schema's
// primary card list) and `reasoning.failure_modes[]` (the v1 schema's
// "what bad judgment looks like" view). Both share the same `id`.
// Prior version imported both, doubling every misunderstanding on
// re-import. The dedup is by id: when a card with the same id is
// pushed twice, the second push merges fields (the failure_modes
// entry carries a different field shape than patterns; merging
// keeps the richer failure_risk / applies_when / does_not_apply_when
// from the patterns entry).
const _importedIds = new Set();
function pushImportedCard(cards, type, fields = {}, id = null) {
  if (id && _importedIds.has(id)) {
    // Already imported — merge richer fields into the existing card.
    const existing = cards.find(c => c.id === id);
    if (existing) {
      existing.fields = existing.fields || {};
      for (const [k, v] of Object.entries(fields || {})) {
        if (v !== undefined && v !== null && v !== '' &&
            (existing.fields[k] === undefined || existing.fields[k] === '' ||
             (Array.isArray(existing.fields[k]) && existing.fields[k].length === 0))) {
          existing.fields[k] = v;
        }
      }
    }
    return;
  }
  if (id) _importedIds.add(id);
  const card = importedCard(type, fields, id);
  if (card) cards.push(card);
}

function resetImportedIds() { _importedIds.clear(); }

function decodePayload(bytes, manifest = {}) {
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const encoding = manifest.payload?.encoding || manifest.container?.payload_encoding || null;
  if (encoding === 'json' || raw[0] === 0x7b || raw[0] === 0x5b) {
    return JSON.parse(raw.toString('utf8'));
  }
  return cbor.decode(raw);
}

// V1 path: trust the producer (export-runtime) to have already shaped
// each card's fields. The v1 producer normalises everything into a
// canonical shape, so we just round-trip the raw object. Bug (#57):
// the legacy path below explicitly constructs each field. The two
// paths cannot be unified without losing either v1's per-field
// guarantees or legacy's defensive defaults — the asymmetry is
// intentional. Documented here so a future reader does not "fix" it
// by collapsing one path into the other.
function cardsFromV1Payload(payload) {
  resetImportedIds();
  const cards = [];
  for (const sourceCard of (Array.isArray(payload.source_cards) ? payload.source_cards : [])) {
    pushImportedCard(cards, sourceCard.type, sourceCard.fields || {}, sourceCard.id || null);
  }
  if (cards.length > 0) return cards;

  for (const ax of (Array.isArray(payload.core?.axioms) ? payload.core?.axioms : [])) {
    pushImportedCard(cards, 'axiom', {
      one_sentence: ax.one_sentence || '',
      full_statement: ax.full_statement || '',
      why: ax.why || '',
      applies_when: ax.applies_when || [],
      does_not_apply_when: ax.does_not_apply_when || [],
      failure_risk: ax.failure_risk || '',
      confidence: ax.confidence || '',
      evidence_type: ax.evidence_type || '',
    }, ax.id || null);
  }
  for (const ont of (Array.isArray(payload.core?.ontology) ? payload.core?.ontology : [])) {
    pushImportedCard(cards, 'ontology', ont, ont.id || null);
  }
  for (const fw of (Array.isArray(payload.core?.frameworks) ? payload.core?.frameworks : [])) {
    pushImportedCard(cards, 'framework', fw, fw.id || null);
  }
  for (const stance of (Array.isArray(payload.core?.stances) ? payload.core?.stances : [])) {
    pushImportedCard(cards, 'stance', stance, stance.id || null);
  }
  for (const aesthetic of (Array.isArray(payload.core?.aesthetics) ? payload.core?.aesthetics : [])) {
    pushImportedCard(cards, 'aesthetic', aesthetic, aesthetic.id || null);
  }
  for (const boundary of (Array.isArray(payload.core?.boundaries) ? payload.core?.boundaries : [])) {
    pushImportedCard(cards, 'boundary', boundary, boundary.id || null);
  }
  // risk_model may be either an array of risk items (legacy) or
  // `{risks: [...]}` (current). Treat both shapes; ignore everything else
  // rather than crashing with "object is not iterable".
  const riskModel = payload.core?.risk_model;
  const riskItems = Array.isArray(riskModel) ? riskModel : (riskModel?.risks || []);
  for (const risk of riskItems) {
    pushImportedCard(cards, 'risk', risk, risk.id || null);
  }
  for (const pattern of (Array.isArray(payload.patterns) ? payload.patterns : [])) {
    // Bug (#146): prior version dropped any payload.patterns entry
    // that lacked an explicit `type` field. The v1 schema lists
    // misunderstandings in patterns[] without a `type` discriminator
    // (their shape is `{wrong, correct, key_distinction, why}`),
    // and several exporters omit `type` to keep the on-the-wire
    // shape compact. The fix infers a type from the field set when
    // `type` is missing, and only falls through to "skip" when the
    // entry truly cannot be classified.
    let type = pattern.type;
    let fields = pattern;
    if (!type) {
      // Heuristics, in priority order — most specific to most general.
      if ('logic' in pattern && ('so_what' in pattern || 'conclusion' in pattern)) type = 'reasoning';
      else if ('wrong' in pattern && 'correct' in pattern) type = 'misunderstanding';
      else if ('term' in pattern && 'definition' in pattern) type = 'term';
      else if ('term' in pattern && 'why' in pattern && 'replace_with' in pattern) type = 'banned_term';
      else if ('what_it_looks_like' in pattern && 'how_to_fix' in pattern) type = 'pattern';
      else if ('name' in pattern && ('description' in pattern || 'one_sentence' in pattern)) type = 'aesthetic';
      else {
        // Truly unclassifiable. Log a one-line warning and skip
        // rather than crash, so the rest of the asset still imports.
        console.warn(
          `Skipping payload.patterns entry with no recognisable type ` +
          `(id=${pattern.id || '?'}, keys=${Object.keys(pattern).join(',') || '<empty>'})`
        );
        continue;
      }
      fields = { ...pattern };
      delete fields.type;
    } else {
      const { type: _stripped, ...rest } = pattern;
      fields = rest;
    }
    pushImportedCard(cards, type, fields, pattern.id || null);
  }
  for (const scenario of (Array.isArray(payload.scenarios) ? payload.scenarios : [])) {
    pushImportedCard(cards, 'scenario', scenario, scenario.id || null);
  }
  for (const item of (Array.isArray(payload.cases) ? payload.cases : [])) {
    pushImportedCard(cards, 'case', item, item.id || null);
  }
  // Accept both `self_check` (canonical) and `self_checks` (legacy schema
  // name) so we round-trip assets written by either version of the
  // payload-profile schema. Bug (#53): prior version used
  // `arr || []`, which would crash with "object is not iterable" if
  // the field was a truthy non-array (e.g. a single `{question: ...}`
  // object instead of an array). The fix guards with Array.isArray.
  const rawSelfCheck = payload.reasoning?.self_check
    || payload.reasoning?.self_checks;
  const selfCheckArr = Array.isArray(rawSelfCheck) ? rawSelfCheck : [];
  for (const selfCheck of selfCheckArr) {
    const fields = typeof selfCheck === 'string' ? { question: selfCheck } : selfCheck;
    pushImportedCard(cards, 'self_check', fields, fields.id || null);
  }
  for (const failureMode of (Array.isArray(payload.reasoning?.failure_modes) ? payload.reasoning?.failure_modes : [])) {
    // Bug (#145 follow-up): the prior version dropped three
    // judgment fields (failure_risk, applies_when, does_not_apply_when)
    // when reading failure_modes back out of a v1 asset. A Studio
    // project that round-tripped through `migrate --format v1` lost
    // these fields every time. The fix reads them through, matching
    // the export-side map in kdna-studio-core's buildPayload.
    pushImportedCard(cards, 'misunderstanding', {
      wrong: failureMode.mode || failureMode.wrong || '',
      correct: failureMode.correct || '',
      key_distinction: failureMode.key_distinction || '',
      why: failureMode.why || '',
      failure_risk: failureMode.failure_risk || '',
      applies_when: Array.isArray(failureMode.applies_when) ? failureMode.applies_when : [],
      does_not_apply_when: Array.isArray(failureMode.does_not_apply_when) ? failureMode.does_not_apply_when : [],
    }, failureMode.id || null);
  }
  for (const chain of (Array.isArray(payload.reasoning?.reasoning_chains) ? payload.reasoning?.reasoning_chains : [])) {
    // Bug (#4 UX): compile/index.js synthesises one reasoning chain
    // per locked axiom (the legacy 1.0.0 path) and tags it
    // `source_authored: false`. Importing those synthesised chains
    // doubled the card count on round-trip. The fix skips chains
    // that the producer explicitly marked as synthesised.
    if (chain.source_authored === false) continue;
    pushImportedCard(cards, 'reasoning', chain, chain.id || null);
  }
  for (const stage of (Array.isArray(payload.evolution?.stages) ? payload.evolution?.stages : [])) {
    // Distinguish source-authored stages (preserved identity) from
    // audit-log-derived stages (synthesised). The compile path tags
    // source_authored: true; import those verbatim and skip the rest
    // so the importer doesn't double-count what was already in the
    // locked judgment cards.
    if (stage.source_authored === true) {
      pushImportedCard(cards, 'evolution_stage', stage, stage.id || null);
    }
  }
  return cards;
}

function cardsFromLegacyPayload(payload) {
  resetImportedIds();
  const cards = [];
  const judgment = payload.judgment || {};
  const core = judgment.core || {};
  const patterns = judgment.patterns || {};

  for (const ax of (Array.isArray(core.axioms) ? core.axioms : [])) {
    pushImportedCard(cards, 'axiom', {
      one_sentence: ax.one_sentence || '',
      full_statement: ax.full_statement || '',
      why: ax.why || '',
      applies_when: ax.applies_when || [],
      does_not_apply_when: ax.does_not_apply_when || [],
      failure_risk: ax.failure_risk || '',
    }, ax.id || null);
  }
  for (const ont of (Array.isArray(core.ontology) ? core.ontology : [])) {
    pushImportedCard(cards, 'ontology', {
      one_sentence: ont.one_sentence || ont.essence || '',
      essence: ont.essence || '',
      boundary: ont.boundary || '',
      trigger_signal: ont.trigger_signal || '',
    }, ont.id || null);
  }
  for (const boundary of (Array.isArray(core.boundaries) ? core.boundaries : [])) {
    pushImportedCard(cards, 'boundary', {
      scope: boundary.scope || '',
      out_of_scope: boundary.out_of_scope || '',
      acceptable_exceptions: boundary.acceptable_exceptions || [],
    }, boundary.id || null);
  }
  for (const risk of (Array.isArray(core.risks) ? core.risks : [])) {
    pushImportedCard(cards, 'risk', risk, risk.id || null);
  }
  // Bug (#63): prior version skipped `core.stances` and
  // `core.frameworks`, so a legacy asset that authored either type
  // round-tripped out as zero cards. The fix adds both loops.
  for (const stance of (Array.isArray(core.stances) ? core.stances : [])) {
    pushImportedCard(cards, 'stance', stance, stance.id || null);
  }
  for (const fw of (Array.isArray(core.frameworks) ? core.frameworks : [])) {
    pushImportedCard(cards, 'framework', fw, fw.id || null);
  }
  for (const term of (Array.isArray(patterns.terminology?.standard_terms) ? patterns.terminology?.standard_terms : [])) {
    pushImportedCard(cards, 'term', term, term.id || null);
  }
  for (const banned of (Array.isArray(patterns.terminology?.banned_terms) ? patterns.terminology?.banned_terms : [])) {
    pushImportedCard(cards, 'banned_term', banned, banned.id || null);
  }
  for (const ms of (Array.isArray(patterns.misunderstandings) ? patterns.misunderstandings : [])) {
    pushImportedCard(cards, 'misunderstanding', {
      wrong: ms.wrong || '',
      correct: ms.correct || '',
      key_distinction: ms.key_distinction || '',
      why: ms.why || '',
      applies_when: ms.applies_when || [],
      does_not_apply_when: ms.does_not_apply_when || [],
      failure_risk: ms.failure_risk || '',
    }, ms.id || null);
  }
  for (const sc of (Array.isArray(patterns.self_check) ? patterns.self_check : [])) {
    const question = typeof sc === 'string' ? sc : sc.question || '';
    pushImportedCard(cards, 'self_check', { question }, sc.id || null);
  }
  for (const aesthetic of (Array.isArray(patterns.aesthetics) ? patterns.aesthetics : [])) {
    pushImportedCard(cards, 'aesthetic', aesthetic, aesthetic.id || null);
  }
  for (const scene of (Array.isArray(judgment.scenarios?.scenes) ? judgment.scenarios?.scenes : [])) {
    pushImportedCard(cards, 'scenario', scene, scene.id || null);
  }
  for (const item of (Array.isArray(judgment.cases?.cases) ? judgment.cases?.cases : [])) {
    pushImportedCard(cards, 'case', item, item.id || null);
  }
  for (const chain of (Array.isArray(judgment.reasoning?.reasoning_chains) ? judgment.reasoning?.reasoning_chains : [])) {
    pushImportedCard(cards, 'reasoning', chain, chain.id || null);
  }
  for (const stage of (Array.isArray(judgment.evolution?.stages) ? judgment.evolution?.stages : [])) {
    pushImportedCard(cards, 'evolution_stage', stage, stage.id || null);
  }
  return cards;
}

function cardsFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (payload.profile === 'judgment-profile-v1' || payload.core || payload.source_cards) {
    return cardsFromV1Payload(payload);
  }
  if (payload.kind === 'kdna.payload' || payload.judgment) {
    return cardsFromLegacyPayload(payload);
  }
  return [];
}

function buildV1Manifest(project, name) {
  // Bug (#58): prior version was a hand-rolled manifest builder that
  // shared zero logic with the canonical buildManifest in
  // @aikdna/kdna-studio-core/src/export-runtime. The two paths
  // diverged on every field added since 1.0 (lineage, load_contract,
  // authoring block, etc.). The fix delegates the manifest shape to
  // kdna-studio-core's buildManifest so the v1 path is the single
  // source of truth.
  //
  // We still need a default manifest here (the exportRuntimeAsset
  // path uses buildManifest internally; this function supplies the
  // defaults that pass-through into the runtime options). The actual
  // manifest the runtime ships is the one buildManifest produces, so
  // keeping these defaults in sync matters less than it used to.
  const source = project.source_manifest || {};
  const assetId = assetIdFromName(name || source.name || project.name);
  const author = source.author || project.author || {};
  return {
    kdna_version: '1.0',
    asset_id: assetId,
    asset_uid: project.asset_uid || 'urn:uuid:' + crypto.randomUUID(),
    asset_type: project.type === 'cluster' ? 'cluster' : 'domain',
    source_asset_type: source.asset_type || null,
    title: titleFromName(source.name || name || project.name, assetId),
    version: semverValue(project.release?.version || source.version, '1.0.0'),
    judgment_version: semverValue(project.release?.judgment_version || source.judgment_version || source.version, '1.0.0'),
    created_at: isoDateTime(source.created || project.created),
    updated_at: isoDateTime(source.updated || project.updated),
    creator: {
      name: author.name || project.author?.name || 'Studio Export',
      id: author.id || project.author?.id || undefined,
    },
    compatibility: { min_loader_version: '1.0.0', profile: 'judgment-profile-v1' },
    payload: { path: 'payload.kdnab', encoding: 'json', encrypted: false },
    summary: source.core_insight || project.release?.description || source.description || '',
    description: source.description || project.release?.description || '',
    language: source.default_language || project.default_language || (Array.isArray(source.languages) ? source.languages[0] : undefined),
    languages: source.languages || project.languages || undefined,
    license: source.license || project.license || undefined,
    keywords: source.keywords || [],
    lineage: {
      type: project.lineage?.type === 'migrated' ? 'adaptation' : (project.lineage?.type || 'original'),
      fork_of: null,
      derived_from: source.name || project.lineage?.parent_name || null,
      source_lineage_type: project.lineage?.type || null,
    },
    load_contract: {
      default_profile: 'compact',
      profiles: {
        index: { requires_decryption: false, max_tokens_hint: 500, selection: 'manifest metadata', intended_for: ['discovery'] },
        compact: { requires_decryption: false, max_tokens_hint: 2000, selection: 'core judgment summary', intended_for: ['agent prompt'] },
        scenario: { requires_decryption: false, max_tokens_hint: 3000, selection: 'scenario cards', intended_for: ['situational loading'] },
        full: { requires_decryption: false, max_tokens_hint: 12000, selection: 'full manifest and payload', intended_for: ['audit', 'migration'] },
      },
    },
    source_manifest: publicManifestMetadata(source),
  };
}

function cmdCreate(args) {
  const dir = args[0];
  if (!dir) fail('Usage: kdna-studio create <project-dir> --name <name> [--author <name>] [--from-kdna <file> | --from-folder <dir>]');
  const abs = path.resolve(dir);
  if (fs.existsSync(abs)) fail(`Directory already exists: ${abs}`);

  const name = option(args, '--name', path.basename(abs));
  const authorName = option(args, '--author', '');
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
      const sourceAuthor = kdnaData.source_manifest?.author || {};
      const project = projectApi.createProject(name, 'domain', {
        author: {
          name: authorName || option(args, '--author-name', sourceAuthor.name || ''),
          id: option(args, '--author-id', sourceAuthor.id || ''),
        },
        sourceMode,
        creatorIdentity,
        lineage,
      });
      project.cards = kdnaData.cards;
      // Bug #15 / #28 follow-up: store the source KDNA_* files on the
      // project so a later export through exportRuntimeAsset can
      // forward them to compileDomain (which then preserves
      // changelog / version_notes / reasoning_chains / banned_terms
      // through the round-trip).
      if (kdnaData.source_patterns) project.source_patterns = kdnaData.source_patterns;
      if (kdnaData.source_reasoning) project.source_reasoning = kdnaData.source_reasoning;
      if (kdnaData.source_evolution) project.source_evolution = kdnaData.source_evolution;
      if (kdnaData.source_manifest) project.source_manifest = publicManifestMetadata(kdnaData.source_manifest);
      if (kdnaData.source_manifest?.version) {
        if (!project.release) project.release = {};
        project.release.version = kdnaData.source_manifest.version;
      }
      if (kdnaData.source_manifest?.judgment_version) {
        if (!project.release) project.release = {};
        project.release.judgment_version = kdnaData.source_manifest.judgment_version;
      }
      if (kdnaData.source_manifest?.description) {
        if (!project.release) project.release = {};
        project.release.description = kdnaData.source_manifest.description;
      }
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
    importFromFolder(fromFolder, abs, name, creatorIdentity);
    return;
  }

  const project = projectApi.createProject(name, 'domain', {
    author: { name: authorName || option(args, '--author-name', ''), id: option(args, '--author-id', '') },
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
  resetImportedIds();
  const absKdna = path.resolve(kdnaPath);
  if (!fs.existsSync(absKdna)) fail(`KDNA asset not found: ${absKdna}`);
  if (!absKdna.endsWith('.kdna')) fail('--from-kdna requires a .kdna file');

  const stats = fs.statSync(absKdna);
  if (stats.size > 50 * 1024 * 1024) {
    fail(`KDNA file too large (${(stats.size / (1024 * 1024)).toFixed(1)} MiB, max 50 MiB): ${absKdna}`);
  }
  const zipBuf = fs.readFileSync(absKdna);
  const entries = readZipEntries(zipBuf);
  if (!entries.has('kdna.json')) fail('Not a valid .kdna asset: missing kdna.json');

  const manifest = JSON.parse(entries.get('kdna.json').toString());
  const lineage = {
    type: 'fork',
    parent_name: manifest.name || manifest.title || manifest.asset_id || null,
    parent_asset_uid: manifest.asset_uid || null,
    parent_version: manifest.version || null,
    parent_asset_digest: manifest.content_digest || manifest.asset_digest || null,
  };

  // Extract cards. Modern v1 packages carry `kdna.json` + `payload.kdnab`
  // and use the unified judgment profile. Legacy packages split content
  // across KDNA_*.json files. Prefer payload.kdnab when present — it
  // covers all 8+ card types (axiom / boundary / risk / aesthetic /
  // ontology / misunderstanding / self_check / scenario / case /
  // reasoning / evolution_stage / stance / framework / term / banned_term)
  // via cardsFromPayload / cardsFromV1Payload.
  const importedCards = [];
  if (entries.has('payload.kdnab')) {
    try {
      const payload = decodePayload(entries.get('payload.kdnab'), manifest);
      importedCards.push(...cardsFromPayload(payload));
    } catch (e) {
      fail(`Could not import cards from payload.kdnab: ${e.message}`);
    }
  } else if (entries.has('KDNA_Core.json') || entries.has('KDNA_Patterns.json')) {
    // Legacy fallback — used when the v1 asset has no payload.kdnab
    // (i.e. the asset predates the 0.7 split). Bug (#67): prior
    // version only handled axiom / ontology / boundary / misunderstanding
    // / self_check — 5 of the 14 card types — so every other type
    // (risk / stance / framework / term / banned_term / aesthetic /
    // scenario / case / reasoning / evolution_stage) round-tripped
    // out as zero cards. The fix threads every type this CLI can
    // import through, and prefers the same field-shape rules as
    // cardsFromLegacyPayload so the round-trip is symmetric.
    if (entries.has('KDNA_Core.json')) {
      const core = JSON.parse(entries.get('KDNA_Core.json').toString());
      for (const ax of (Array.isArray(core.axioms) ? core.axioms : [])) {
        const fields = {};
        for (const k of ['one_sentence','full_statement','why','applies_when','does_not_apply_when','failure_risk','confidence','evidence_type']) {
          if (k in ax) fields[k] = ax[k];
        }
        importedCards.push(cardApi.createCard('axiom', fields));
      }
      for (const ont of (Array.isArray(core.ontology) ? core.ontology : [])) {
        importedCards.push(cardApi.createCard('ontology', {
          one_sentence: ont.one_sentence || ont.essence || '',
          essence: ont.essence || '', boundary: ont.boundary || '',
          trigger_signal: ont.trigger_signal || '',
        }));
      }
      for (const b of (Array.isArray(core.boundaries) ? core.boundaries : [])) {
        importedCards.push(cardApi.createCard('boundary', {
          scope: b.scope || '', out_of_scope: b.out_of_scope || '',
          acceptable_exceptions: b.acceptable_exceptions || [],
        }));
      }
      // Accept risks as a top-level array (`risks`) or wrapped in `risk_model`
      // (either as `{risks: [...]}` or as an array itself). Uses the same
      // Array.isArray ladder pattern as the safe path at lines 1033-1040.
      let risksSource = core.risks;
      if (!Array.isArray(risksSource)) {
        if (Array.isArray(core.risk_model)) risksSource = core.risk_model;
        else if (Array.isArray(core.risk_model?.risks)) risksSource = core.risk_model.risks;
        else risksSource = [];
      }
      for (const risk of risksSource) {
        importedCards.push(cardApi.createCard('risk', risk.fields || risk));
      }
      for (const stance of (Array.isArray(core.stances) ? core.stances : [])) {
        importedCards.push(cardApi.createCard('stance', stance.fields || stance));
      }
      for (const fw of (Array.isArray(core.frameworks) ? core.frameworks : [])) {
        importedCards.push(cardApi.createCard('framework', fw.fields || fw));
      }
    }
    if (entries.has('KDNA_Patterns.json')) {
      const pat = JSON.parse(entries.get('KDNA_Patterns.json').toString());
      for (const ms of (Array.isArray(pat.misunderstandings) ? pat.misunderstandings : [])) {
        importedCards.push(cardApi.createCard('misunderstanding', {
          wrong: ms.wrong || '', correct: ms.correct || '',
          key_distinction: ms.key_distinction || '', why: ms.why || '',
        }));
      }
      for (const sc of (Array.isArray(pat.self_check) ? pat.self_check : [])) {
        const q = typeof sc === 'string' ? sc : sc.question || '';
        importedCards.push(cardApi.createCard('self_check', { question: q }));
      }
      for (const aesthetic of (Array.isArray(pat.aesthetics) ? pat.aesthetics : [])) {
        importedCards.push(cardApi.createCard('aesthetic', aesthetic.fields || aesthetic));
      }
      for (const term of (Array.isArray(pat.terminology?.standard_terms) ? pat.terminology?.standard_terms : [])) {
        importedCards.push(cardApi.createCard('term', term));
      }
      for (const banned of (Array.isArray(pat.terminology?.banned_terms) ? pat.terminology?.banned_terms : [])) {
        importedCards.push(cardApi.createCard('banned_term', banned));
      }
    }
    if (entries.has('KDNA_Scenarios.json')) {
      const scen = JSON.parse(entries.get('KDNA_Scenarios.json').toString());
      for (const s of (Array.isArray(scen.scenes) ? scen.scenes : [])) {
        importedCards.push(cardApi.createCard('scenario', s));
      }
    }
    if (entries.has('KDNA_Cases.json')) {
      const cases = JSON.parse(entries.get('KDNA_Cases.json').toString());
      for (const c of (Array.isArray(cases.cases) ? cases.cases : [])) {
        importedCards.push(cardApi.createCard('case', c));
      }
    }
    if (entries.has('KDNA_Reasoning.json')) {
      const reasoning = JSON.parse(entries.get('KDNA_Reasoning.json').toString());
      for (const chain of (Array.isArray(reasoning.reasoning_chains) ? reasoning.reasoning_chains : [])) {
        importedCards.push(cardApi.createCard('reasoning', chain));
      }
    }
    if (entries.has('KDNA_Evolution.json')) {
      const evolution = JSON.parse(entries.get('KDNA_Evolution.json').toString());
      for (const stage of (Array.isArray(evolution.stages) ? evolution.stages : [])) {
        importedCards.push(cardApi.createCard('evolution_stage', stage));
      }
    }
  }

  if (importedCards.length === 0) {
    fail(`No cards could be extracted from ${absKdna}. Expected payload.kdnab (v1) or KDNA_Core.json + KDNA_Patterns.json (legacy).`);
  }

  // Bug #15 / #28 follow-up: surface the source's KDNA_Patterns /
  // KDNA_Reasoning / KDNA_Evolution entries so cmdCreate can store
  // them on the project. The next export then forwards them to
  // compileDomain via exportRuntimeAsset, which preserves
  // changelog / version_notes / reasoning_chains / banned_terms
  // through the round-trip.
  const sourcePatterns = entries.has('KDNA_Patterns.json')
    ? JSON.parse(entries.get('KDNA_Patterns.json').toString())
    : null;
  const sourceReasoning = entries.has('KDNA_Reasoning.json')
    ? JSON.parse(entries.get('KDNA_Reasoning.json').toString())
    : null;
  const sourceEvolution = entries.has('KDNA_Evolution.json')
    ? JSON.parse(entries.get('KDNA_Evolution.json').toString())
    : null;

  return {
    lineage,
    cards: importedCards,
    source_manifest: manifest,
    source_patterns: sourcePatterns,
    source_reasoning: sourceReasoning,
    source_evolution: sourceEvolution,
  };
}

/**
 * Import cards from a legacy source folder into a new Studio project.
 * Reads KDNA_*.json files and converts entries to draft judgment cards.
 * Outputs a schema audit report.
 */
function importFromFolder(sourceDir, projectDir, projectName, creatorIdentity, opts = {}) {
  resetImportedIds();
  const absSource = path.resolve(sourceDir);
  if (!fs.existsSync(absSource)) fail(`Source folder not found: ${absSource}`);
  if (!fs.statSync(absSource).isDirectory()) fail('--from-folder requires a directory');

  const audit = { filesFound: [], cardsImported: 0, missingFields: [], schemaWarnings: [] };
  const importedCards = [];
  const manifestData = {};

  function loadJson(filename) {
    const p = path.join(absSource, filename);
    if (!fs.existsSync(p)) return null;
    audit.filesFound.push(filename);
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch { audit.schemaWarnings.push(`${filename}: invalid JSON`); return null; }
  }

  // Load manifest for version/languages/description
  const manifest = loadJson('kdna.json');
  if (manifest) {
    manifestData.raw = manifest;
    if (manifest.version) manifestData.version = manifest.version;
    if (manifest.judgment_version) manifestData.judgment_version = manifest.judgment_version;
    if (manifest.languages) manifestData.languages = manifest.languages;
    if (manifest.default_language) manifestData.default_language = manifest.default_language;
    if (manifest.description) manifestData.description = manifest.description;
    if (manifest.name) manifestData.name = manifest.name;
    if (manifest.keywords) manifestData.keywords = manifest.keywords;
    if (manifest.license) manifestData.license = manifest.license;
    if (manifest.author) manifestData.author = manifest.author;
    if (manifest.asset_type) manifestData.asset_type = manifest.asset_type;
    if (manifest.core_insight) manifestData.core_insight = manifest.core_insight;
    if (manifest.created) manifestData.created = manifest.created;
    if (manifest.updated) manifestData.updated = manifest.updated;
    if (manifest.risk_level) manifestData.risk_level = manifest.risk_level;
    if (manifest.fitness_for_purpose) manifestData.fitness_for_purpose = manifest.fitness_for_purpose;
  }

  const core = loadJson('KDNA_Core.json');
  const patterns = loadJson('KDNA_Patterns.json');
  const scenarios = loadJson('KDNA_Scenarios.json');
  const cases = loadJson('KDNA_Cases.json');
  const reasoning = loadJson('KDNA_Reasoning.json');
  const evolution = loadJson('KDNA_Evolution.json');

  // If none of the standard KDNA_*.json files were found, that almost
  // always means the user pointed at the wrong directory or the source uses
  // a non-standard filename. Report what was *actually* present so they can
  // rename or move their files.
  const expectedFiles = ['KDNA_Core.json', 'KDNA_Patterns.json', 'KDNA_Scenarios.json',
    'KDNA_Cases.json', 'KDNA_Reasoning.json', 'KDNA_Evolution.json', 'kdna.json'];
  const loadedCount = audit.filesFound.length;
  if (loadedCount === 0) {
    let dirContents = [];
    try { dirContents = fs.readdirSync(absSource); } catch { /* ignore */ }
    fail(
      `No KDNA source files found in ${absSource}.\n` +
      `Expected one of: ${expectedFiles.join(', ')}\n` +
      `Directory contains ${dirContents.length} entr${dirContents.length === 1 ? 'y' : 'ies'}: ` +
      (dirContents.length > 0 ? dirContents.slice(0, 20).join(', ') + (dirContents.length > 20 ? ', ...' : '') : '(empty)')
    );
  }

  if (core) {
    for (const ax of (Array.isArray(core.axioms) ? core.axioms : [])) {
      const fields = {};
      for (const key of ['one_sentence', 'full_statement', 'why', 'applies_when', 'does_not_apply_when', 'failure_risk', 'confidence', 'evidence_type']) {
        if (key in ax) fields[key] = ax[key];
        else audit.missingFields.push(`axiom.${ax.id || '?'}.${key}`);
      }
      importedCards.push(cardApi.createCard('axiom', fields));
    }
    for (const ont of (Array.isArray(core.ontology) ? core.ontology : [])) {
      importedCards.push(cardApi.createCard('ontology', {
        one_sentence: ont.one_sentence || ont.essence || '',
        essence: ont.essence || '', boundary: ont.boundary || '',
        trigger_signal: ont.trigger_signal || '',
      }));
    }
    for (const b of (Array.isArray(core.boundaries) ? core.boundaries : [])) {
      importedCards.push(cardApi.createCard('boundary', {
        scope: b.scope || '', out_of_scope: b.out_of_scope || '',
        acceptable_exceptions: b.acceptable_exceptions || [],
      }));
    }
    // Accept risks as a top-level array (`risks`) or wrapped in `risk_model`
    // (either as `{risks: [...]}` or as an array itself).
    let risksSource = core.risks;
    if (!Array.isArray(risksSource)) {
      if (Array.isArray(core.risk_model)) risksSource = core.risk_model;
      else if (Array.isArray(core.risk_model?.risks)) risksSource = core.risk_model.risks;
      else risksSource = [];
    }
    for (const r of risksSource) {
      importedCards.push(cardApi.createCard('risk', r.fields || r));
    }
    // NEW: import stances
    for (const s of (Array.isArray(core.stances) ? core.stances : [])) {
      const text = typeof s === 'string' ? s : s.statement || s.stance || '';
      importedCards.push(cardApi.createCard('stance', {
        statement: text,
        applies_when: s.applies_when || [],
        does_not_apply_when: s.does_not_apply_when || [],
      }));
    }
    // NEW: import frameworks
    for (const fw of (Array.isArray(core.frameworks) ? core.frameworks : [])) {
      importedCards.push(cardApi.createCard('framework', {
        name: fw.name || '', when_to_use: fw.when_to_use || '',
        steps: fw.steps || [],
      }));
    }
  }

  if (patterns) {
    // NEW: import terminology
    if (patterns.terminology) {
      for (const t of (Array.isArray(patterns.terminology.standard_terms) ? patterns.terminology.standard_terms : [])) {
        importedCards.push(cardApi.createCard('term', {
          term: t.term || '', definition: t.definition || '',
        }));
      }
      for (const bt of (Array.isArray(patterns.terminology.banned_terms) ? patterns.terminology.banned_terms : [])) {
        importedCards.push(cardApi.createCard('banned_term', {
          term: bt.term || '', why: bt.why || '', replace_with: bt.replace_with || '',
        }));
      }
    }
    for (const ms of (Array.isArray(patterns.misunderstandings) ? patterns.misunderstandings : [])) {
      importedCards.push(cardApi.createCard('misunderstanding', {
        wrong: ms.wrong || '', correct: ms.correct || '',
        key_distinction: ms.key_distinction || '', why: ms.why || '',
      }));
    }
    for (const sc of (Array.isArray(patterns.self_check) ? patterns.self_check : [])) {
      const q = typeof sc === 'string' ? sc : sc.question || '';
      importedCards.push(cardApi.createCard('self_check', { question: q }));
    }
    // Bug (aesthetic round-trip): prior version dropped
    // `patterns.aesthetics` on import. `cardsFromV1Payload` and
    // `cardsFromLegacyPayload` both read the field, so a domain
    // that authored aesthetic cards in either format would lose
    // them when imported through `create --from-folder`. The fix
    // adds the missing loop here.
    for (const aesthetic of (Array.isArray(patterns.aesthetics) ? patterns.aesthetics : [])) {
      importedCards.push(cardApi.createCard('aesthetic', aesthetic.fields || aesthetic));
    }
  }

  // NEW: import scenarios
  if (scenarios && Array.isArray(scenarios.scenes)) {
    for (const scene of scenarios.scenes) {
      importedCards.push(cardApi.createCard('scenario', {
        name: scene.name || scene.id || '',
        trigger: scene.trigger || '', action: scene.action || '',
      }));
    }
  }

  // NEW: import cases
  if (cases && Array.isArray(cases.cases)) {
    for (const c of cases.cases) {
      importedCards.push(cardApi.createCard('case', {
        title: c.title || c.id || '',
        scenario: c.scenario || '', expected: c.expected || '',
      }));
    }
  }

  // NEW: import reasoning chains. Field names must match what compileReasoning
  // reads (chain/principle/concrete_action/axiom/one_sentence) so the
  // round-trip preserves the source's structure. Bug: prior code stored
  // {name, conclusion, so_what}, none of which the compile path recognised,
  // so the cards were silently rewritten as axiom-derived fallback chains
  // — looking identical to misunderstanding cards and losing the source's
  // identity.
  if (reasoning && Array.isArray(reasoning.reasoning_chains)) {
    for (const rc of reasoning.reasoning_chains) {
      importedCards.push(cardApi.createCard('reasoning', {
        axiom: rc.axiom || '',
        one_sentence: rc.one_sentence || rc.conclusion || '',
        chain: Array.isArray(rc.chain) ? rc.chain : (rc.logic || []),
        principle: rc.principle || rc.name || '',
        concrete_action: rc.concrete_action || rc.so_what || '',
        so_what: rc.so_what || rc.concrete_action || '',
        conclusion: rc.conclusion || '',
      }));
    }
  }

  // NEW: import evolution stages
  if (evolution && Array.isArray(evolution.stages)) {
    for (const stage of evolution.stages) {
      importedCards.push(cardApi.createCard('evolution_stage', {
        name: stage.name || stage.id || '',
        level: stage.level || '', description: stage.description || '',
      }));
    }
  }

  audit.cardsImported = importedCards.length;

  const project = projectApi.createProject(projectName, 'domain', {
    sourceMode: 'source_folder',
    sourcePath: absSource,
    creatorIdentity: creatorIdentity || null,
    lineage: { type: 'migrated', parent_name: manifestData.name || null, parent_asset_uid: null, parent_version: manifestData.version || null, parent_asset_digest: null },
  });
  // Preserve manifest metadata
  if (manifestData.version) {
    if (!project.release) project.release = {};
    project.release.version = manifestData.version;
  }
  if (manifestData.judgment_version) {
    if (!project.release) project.release = {};
    project.release.judgment_version = manifestData.judgment_version;
  }
  if (manifestData.description) {
    if (!project.release) project.release = {};
    project.release.description = manifestData.description;
  }
  if (manifestData.license) project.license = manifestData.license;
  if (manifestData.author) project.author = manifestData.author;
  if (manifestData.languages) project.languages = manifestData.languages;
  if (manifestData.default_language) project.default_language = manifestData.default_language;
  if (manifestData.raw) project.source_manifest = publicManifestMetadata(manifestData.raw);

  project.cards = importedCards;
  if (project.stages?.judgment_cards) {
    project.stages.judgment_cards.total = importedCards.length;
    project.stages.judgment_cards.status = 'in_progress';
  }

  fs.mkdirSync(projectDir, { recursive: true });
  writeProject(path.join(projectDir, 'studio.project.json'), project);
  if (!opts.silent) {
    console.log(JSON.stringify({ audit, imported: importedCards.length, source_mode: 'source_folder' }, null, 2));
  }
  return { project, projectPath: path.join(projectDir, 'studio.project.json'), audit };
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

const aiFilter = require('../src/ai/filter');

function cmdImport(args) {
  const [projectInput, source] = args;
  if (!projectInput || !source) fail('Usage: kdna-studio import <project> <source-file-or-dir>');
  const { projectPath, project } = readProject(projectInput);

  const sourcePath = path.resolve(source);
  if (!fs.existsSync(sourcePath)) fail(`Source not found: ${sourcePath}`);

  const TEXT_EXTS = new Set(['.txt', '.md', '.json', '.jsonl', '.yaml', '.yml', '.csv', '.log', '.srt', '.vtt', '.html', '.xml', '.rst']);
  const BINARY_EXTS = new Set(['.pdf', '.docx', '.rtf']);
  let imported = 0;
  let skipped = 0;

  function extractBinaryText(filePath, ext) {
    try {
      if (ext === '.pdf') {
        const result = execFileSync('pdftotext', ['-raw', filePath, '-'], {
          encoding: 'utf8',
          timeout: 30000,
          maxBuffer: 5 * 1024 * 1024,
        });
        return { text: result, error: null };
      }
      if (ext === '.docx' || ext === '.rtf') {
        const result = execFileSync('textutil', ['-convert', 'txt', '-stdout', filePath], {
          encoding: 'utf8',
          timeout: 30000,
          maxBuffer: 5 * 1024 * 1024,
        });
        return { text: result, error: null };
      }
    } catch (e) {
      // Tool not installed or extraction failed — report distinguishably
      if (e.code === 'ENOENT') {
        return { text: null, error: 'tool_missing' };
      }
      return { text: null, error: 'extraction_failed', detail: e.message };
    }
    return { text: null, error: 'unsupported_format' };
  }

  function importFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath);

    if (BINARY_EXTS.has(ext)) {
      const extracted = extractBinaryText(filePath, ext);
      if (!extracted.text || extracted.text.trim().length === 0) {
        const tool = ext === '.pdf' ? 'pdftotext (poppler-utils)' : 'textutil (macOS built-in)';
        if (extracted.error === 'tool_missing') {
          console.warn(`Skipping ${ext} file (${tool} not installed): ${name}`);
        } else if (extracted.error === 'extraction_failed') {
          console.warn(`Skipping ${ext} file (extraction failed: ${extracted.detail}): ${name}`);
        } else {
          console.warn(`Skipping ${ext} file (empty or unsupported): ${name}`);
        }
        skipped++;
        return;
      }
      if (extracted.text.length > 120000) {
        console.warn(`Extracted text too large (${extracted.text.length} chars, max 120000): ${name}`);
        skipped++;
        return;
      }
      const evidence = evidenceApi.createEvidenceEntry('text', name, extracted.text.substring(0, 120000), filePath);
      evidenceApi.addEvidence(project, evidence);
      imported++;
      return;
    }

    // Detect binary content: try reading first 4KB as utf8; if it contains
    // null bytes or too many non-printable chars, it's likely binary.
    const buf = fs.readFileSync(filePath);
    if (buf.length === 0) { console.warn(`Empty file: ${name}`); skipped++; return; }
    const sample = buf.subarray(0, Math.min(buf.length, 4096));
    const nulls = sample.filter(b => b === 0).length;
    const nonPrintable = sample.filter(b => b !== 0 && (b < 0x20 || b === 0x7F) && b !== 0x0A && b !== 0x0D && b !== 0x09).length;
    if (nulls > 0 || nonPrintable > sample.length * 0.1) {
      console.warn(`Binary or non-text file skipped: ${name}`);
      skipped++;
      return;
    }
    let content;
    let fd = null;
    try {
      fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(120000);
      const bytesRead = fs.readSync(fd, buf, 0, 120000, 0);
      content = buf.toString('utf8', 0, bytesRead);
    } catch { console.warn(`Cannot read: ${name}`); skipped++; return; }
    finally {
      // Bug (#51): prior version called fs.closeSync only on the
      // success path, so any readSync failure left the file descriptor
      // open. Under bulk import (300 files), a single error mid-loop
      // could exhaust the per-process fd limit and silently break
      // later imports.
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* best effort */ }
      }
    }

    const evidence = evidenceApi.createEvidenceEntry('text', name, content, filePath);
    evidenceApi.addEvidence(project, evidence);
    imported++;
  }

  if (fs.statSync(sourcePath).isDirectory()) {
    const files = fs.readdirSync(sourcePath).map(f => path.join(sourcePath, f)).filter(f => fs.statSync(f).isFile());
    for (const f of files) {
      if (imported >= 300) { console.warn('Reached 300 file limit.'); break; }
      importFile(f);
    }
  } else {
    importFile(sourcePath);
  }

  writeProject(projectPath, project);

  // Check for sensitive content
  const evidenceList = project.evidence_materials || [];
  const flagged = aiFilter.checkEvidence(evidenceList);
  if (flagged.length > 0) {
    console.warn(`\nSensitive content detected in ${flagged.length} file(s):`);
    for (const f of flagged) console.warn(`  ${f.filename}: ${f.flagged.join(', ')}`);
  }

  console.log(`Imported: ${imported} file(s)${skipped > 0 ? `, ${skipped} skipped` : ''}`);
}

function cmdFilter(args) {
  const projectInput = args[0];
  if (!projectInput) fail('Usage: kdna-studio filter <project>');
  const { project } = readProject(projectInput);
  const evidenceList = project.evidence_materials || [];
  if (evidenceList.length === 0) { console.log('No evidence to filter.'); return; }

  const flagged = aiFilter.checkEvidence(evidenceList);
  if (flagged.length === 0) {
    console.log(`All ${evidenceList.length} evidence file(s) passed sensitive content filter.`);
  } else {
    console.log(`Sensitive content detected in ${flagged.length}/${evidenceList.length} file(s):`);
    for (const f of flagged) {
      console.log(`  ${f.filename}: ${f.flagged.join(', ')}`);
      for (const [domain, match] of Object.entries(f.matches)) console.log(`    ${domain}: "${match}"`);
    }
  }
}

const CARD_REQUIRED_FIELDS = {
  axiom: [
    'one_sentence', 'full_statement', 'why',
    'applies_when', 'does_not_apply_when', 'failure_risk',
    'confidence', 'evidence_type',
  ],
  boundary: ['scope', 'out_of_scope'],
  misunderstanding: ['wrong', 'correct', 'key_distinction', 'why'],
  self_check: ['question'],
  scenario: ['name', 'trigger', 'action', 'expected'],
  case: ['title', 'scenario', 'input', 'expected'],
  risk: ['name', 'description', 'mitigation'],
  stance: ['statement'],
  pattern: ['type', 'name', 'one_sentence', 'what_it_looks_like', 'how_to_fix', 'failure_risk'],
};

const CARD_FIELD_RULES = {
  axiom: {
    applies_when: { type: 'array' },
    does_not_apply_when: { type: 'array' },
    confidence: { allowed: ['low', 'medium', 'high'] },
    evidence_type: { allowed: ['case_observation', 'theoretical', 'empirical', 'analogy', 'principle', 'practice'] },
  },
  boundary: {
    acceptable_exceptions: { type: 'array', optional: true },
  },
  stance: {
    applies_when: { type: 'array', optional: true },
  },
  misunderstanding: {
    applies_when: { type: 'array', optional: true },
    does_not_apply_when: { type: 'array', optional: true },
  },
};

function fieldIssue(fields, name, rule = {}) {
  const val = fields[name];
  if (val === undefined || val === null || val === '' ||
      (Array.isArray(val) && val.length === 0)) {
    return rule.optional ? null : { field: name, issue: 'missing' };
  }
  if (rule.type === 'array' && !Array.isArray(val)) {
    return { field: name, issue: 'wrong_type', have_type: typeof val, need_type: 'array' };
  }
  if (rule.allowed && !rule.allowed.includes(val)) {
    return { field: name, issue: 'invalid_value', have: val, allowed: rule.allowed };
  }
  return null;
}

function formatFieldIssue(issue) {
  if (issue.issue === 'missing') return issue.field;
  if (issue.issue === 'wrong_type') return `${issue.field} (must be ${issue.need_type})`;
  if (issue.issue === 'invalid_value') return `${issue.field} (must be one of: ${issue.allowed.join('|')})`;
  return `${issue.field} (${issue.issue})`;
}

function checkRequiredFields(type, fields) {
  const required = CARD_REQUIRED_FIELDS[type];
  if (!required) return [];
  const issues = [];
  for (const f of required) {
    const issue = fieldIssue(fields, f, CARD_FIELD_RULES[type]?.[f] || {});
    if (issue) issues.push(formatFieldIssue(issue));
  }
  for (const [name, rule] of Object.entries(CARD_FIELD_RULES[type] || {})) {
    if (required.includes(name)) continue;
    const issue = fieldIssue(fields, name, rule);
    if (issue) issues.push(formatFieldIssue(issue));
  }
  return issues;
}

function criticalAxiomIssues(project) {
  const issues = [];
  for (const card of (Array.isArray(project.cards) ? project.cards : [])) {
    if (card.type !== 'axiom') continue;
    const fields = card.fields || {};
    for (const field of ['applies_when', 'does_not_apply_when', 'failure_risk']) {
      const issue = fieldIssue(fields, field, CARD_FIELD_RULES.axiom[field] || {});
      if (issue) issues.push(`${card.id}: ${formatFieldIssue(issue)}`);
    }
  }
  return issues;
}

function cardStrictTemplate(type, fields) {
  const required = CARD_REQUIRED_FIELDS[type];
  if (!required) return fields;
  const filled = { ...fields };
  for (const f of required) {
    const val = filled[f];
    if (val === undefined || val === null || val === '' ||
        (Array.isArray(val) && val.length === 0)) {
      filled[f] = `<TBD: ${f}>`;
    }
  }
  return filled;
}

function cmdCard(args) {
  const sub = args[0];
  if (sub === 'list') {
    const { project } = readProject(args[1]);
    // Bug (#2 UX): the --json flag was accepted but ignored — the
    // command printed the same TSV either way. A script consumer
    // that wanted to pipe the result into `jq` or a downstream
    // tool got garbage. The fix respects --json and emits a real
    // JSON document.
    const useJson = args.includes('--json');
    const rows = (project.cards || []).map(card => ({
      id: card.id,
      type: card.type,
      status: card.status,
      locked: !!card.locked,
      fields: card.fields || {},
    }));
    if (useJson) {
      console.log(JSON.stringify({ count: rows.length, cards: rows }, null, 2));
    } else {
      for (const r of rows) {
        console.log(`${r.id}\t${r.type}\t${r.status}\t${r.locked ? 'locked' : 'unlocked'}`);
      }
    }
    return;
  }
  if (sub === 'add') {
    const projectInput = args[1];
    const type = args[2];
    if (!projectInput || !type) fail('Usage: kdna-studio card add <project> <type> --field key=value [--template <name>] [--no-strict]');
    const { projectPath, project } = readProject(projectInput);
    let fields = parseFields(args.slice(3));

    const useTemplate = option(args, '--template');
    if (useTemplate === 'axiom-strict') {
      if (type !== 'axiom') fail('--template axiom-strict only applies to axiom cards');
      fields = cardStrictTemplate('axiom', fields);
    }

    const isNoStrict = args.includes('--no-strict');
    if (!isNoStrict) {
      const missing = checkRequiredFields(type, fields);
      if (missing.length > 0) {
        fail(
          `Missing required fields for ${type}: ${missing.join(', ')}\n` +
          `Use --no-strict to add a partial card.`
        );
      }
    }

    // Warn: one_sentence is the compact profile display field
    if (type === 'axiom') {
      const oneSentence = fields.one_sentence;
      if (!oneSentence || String(oneSentence).startsWith('<TBD')) {
        console.warn('Warning: one_sentence is used by kdna load --profile=compact.');
        console.warn('Without it, the compact output may show a placeholder or truncated full_statement.');
        console.warn('Add --field one_sentence="..." for best results.\n');
      }
    }

    const card = cardApi.createCard(type, fields);
    project.cards.push(card);
    if (project.stages?.judgment_cards) {
      project.stages.judgment_cards.total = project.cards.length;
      project.stages.judgment_cards.status = 'in_progress';
    }
    writeProject(projectPath, project);
    if (args.includes('--json')) {
      console.log(JSON.stringify({ added: true, card }, null, 2));
    } else {
      console.log(`Added card: ${card.id}`);
    }
    return;
  }
  if (sub === 'update') {
    const projectInput = args[1];
    const cardId = args[2];
    if (!projectInput || !cardId) fail('Usage: kdna-studio card update <project> <card-id> --field key=value  OR  kdna-studio card update <project> <card-id> --from-file <path.json>');
    const { projectPath, project } = readProject(projectInput);
    const idx = (project.cards || []).findIndex((c) => c.id === cardId);
    if (idx < 0) fail(`Card not found: ${cardId}`);
    const card = project.cards[idx];
    if (card.locked) fail(`Cannot update locked card: ${cardId}. Unlock first with card unlock.`);
    // Bug (UX pro-20 migration): prior version only accepted
    // --field key=value, so an author migrating 20 source-tree
    // assets had to run one CLI invocation per field. With
    // confidence + evidence_type as 8th / 9th required fields on
    // axiom, a 99-axiom asset became 99 * 2 = 198 invocations.
    // The fix accepts --from-file <path.json> so an author can
    // write a single JSON file per card (or per project) and
    // apply it in one call. JSON shape: {field: value, ...}.
    //   kdna-studio card update . ax_xxx --from-file ./fills/ax_xxx.json
    // For batched updates across many cards, see the
    // --from-file-projects variant below, which reads a list
    // of {id, fields} records.
    const fromFileIdx = args.indexOf('--from-file');
    if (fromFileIdx >= 0) {
      const filePath = args[fromFileIdx + 1];
      if (!filePath) fail('--from-file requires a path');
      if (!fs.existsSync(filePath)) fail(`--from-file: file not found: ${filePath}`);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (typeof data !== 'object' || Array.isArray(data) || data === null) {
        fail(`--from-file: expected a JSON object mapping field names to values`);
      }
      for (const [k, v] of Object.entries(data)) {
        if (k === 'id' || k === 'type' || k === 'status' || k === 'locked') {
          fail(`--from-file: cannot edit reserved field "${k}"`);
        }
        if (card.fields) card.fields[k] = v;
      }
    } else {
      const updates = parseFields(args.slice(3));
      for (const [k, v] of Object.entries(updates)) {
        if (card.fields) card.fields[k] = v;
      }
    }
    project.cards[idx] = card;
    writeProject(projectPath, project);
    console.log(`Updated card: ${cardId}`);
    return;
  }
  if (sub === 'remove') {
    const projectInput = args[1];
    const cardId = args[2];
    if (!projectInput || !cardId) fail('Usage: kdna-studio card remove <project> <card-id>');
    const { projectPath, project } = readProject(projectInput);
    const idx = (project.cards || []).findIndex((c) => c.id === cardId);
    if (idx < 0) fail(`Card not found: ${cardId}`);
    if (project.cards[idx].locked) fail(`Cannot remove locked card: ${cardId}. Unlock first with card unlock.`);
    project.cards.splice(idx, 1);
    if (project.stages?.judgment_cards) {
      project.stages.judgment_cards.total = project.cards.length;
    }
    writeProject(projectPath, project);
    console.log(`Removed card: ${cardId}`);
    return;
  }
  if (sub === 'approve') {
    const projectInput = args[1];
    const approveAll = args.includes('--all');
    const cardId = approveAll ? null : args[2];
    if (!projectInput || (!cardId && !approveAll)) {
      fail('Usage: kdna-studio card approve <project> <card-id|--all> --by <id> --statement <text> [--sign]');
    }
    const by = option(args, '--by');
    const statement = option(args, '--statement');
    if (!by || !statement) fail('card approve requires --by and --statement');
    const { projectPath, project } = readProject(projectInput);
    const errors = [];

    const lockOneCard = (card) => {
      if (card.status === 'draft') card = cardApi.transitionCard(card, 'revised', { by });
      const lockPayload = {
        by,
        statement,
        checked: { applies_when: true, does_not_apply_when: true, failure_risk: true },
      };
      if (args.includes('--sign')) {
        const identity = creatorApi.loadIdentity();
        if (!identity) {
          errors.push(`${card.id}: No creator identity. Run: kdna-studio identity init`);
          return null;
        }
        lockPayload.creator_id = identity.creator_id;
        const passphrase = resolvePassphrase(args);
        try {
          if (identity.encrypted && !passphrase) {
            errors.push(`${card.id}: Private key is encrypted — provide --passphrase-stdin or KDNA_PASSPHRASE`);
            return null;
          }
          lockPayload.signature = creatorApi.signHumanLock(
            card.id, statement, cardApi.cardJudgmentFingerprint(card), null, passphrase,
          );
        } catch (e) {
          errors.push(`${card.id}: Signing failed: ${e.message}`);
          return null;
        }
      }
      return cardApi.lockCard(card, lockPayload);
    };

    if (cardId) {
      const idx = (project.cards || []).findIndex((c) => c.id === cardId);
      if (idx < 0) fail(`Card not found: ${cardId}`);
      if (project.cards[idx].locked) fail(`Card already locked: ${cardId}`);
      const locked = lockOneCard(project.cards[idx]);
      if (!locked) fail(errors[0]);
      project.cards[idx] = locked;
      const signed = args.includes('--sign') ? ' (signed)' : '';
      console.log(`Approved and Human Locked: ${cardId}${signed}`);
    } else {
      let approved = 0;
      let skipped = 0;
      for (let i = 0; i < (project.cards || []).length; i++) {
        const card = project.cards[i];
        if (card.locked) { skipped++; continue; }
        const locked = lockOneCard(card);
        if (!locked) continue;
        project.cards[i] = locked;
        approved++;
      }
      if (errors.length > 0) {
        fail(`Failed to approve ${errors.length} card(s):\n  ${errors.join('\n  ')}`);
      }
      if (approved === 0) {
        if (skipped > 0) fail(`No unlocked cards to approve (${skipped} already locked).`);
        fail('No unlocked cards to approve.');
      }
      const signed = args.includes('--sign') ? ' (signed)' : '';
      console.log(`Approved and Human Locked: ${approved} cards${signed}${skipped > 0 ? ` (${skipped} already locked)` : ''}`);
    }
    if (project.stages?.judgment_cards) {
      project.stages.judgment_cards.locked = project.cards.filter((c) => c.locked).length;
      project.stages.judgment_cards.total = project.cards.length;
    }
    writeProject(projectPath, project);
    return;
  }
  if (sub === 'unlock') {
    const projectInput = args[1];
    const cardId = args[2];
    if (!projectInput || !cardId) fail('Usage: kdna-studio card unlock <project> <card-id> --by <id> --statement <text>');
    const by = option(args, '--by');
    const statement = option(args, '--statement');
    if (!by || !statement) fail('card unlock requires --by and --statement');
    const { projectPath, project } = readProject(projectInput);
    const idx = (project.cards || []).findIndex((c) => c.id === cardId);
    if (idx < 0) fail(`Card not found: ${cardId}`);
    const card = project.cards[idx];
    if (!card.locked) fail(`Card is not locked: ${cardId}`);
    card.locked = false;
    card.status = 'draft';
    delete card.human_lock;
    if (!card.audit_log) card.audit_log = [];
    card.audit_log.push({
      action: 'unlocked',
      by,
      statement,
      timestamp: new Date().toISOString(),
    });
    project.cards[idx] = card;
    if (project.stages?.judgment_cards) {
      project.stages.judgment_cards.locked = project.cards.filter((c) => c.locked).length;
    }
    writeProject(projectPath, project);
    console.log(`Unlocked card: ${cardId}`);
    return;
  }
  fail('Usage: kdna-studio card <list|add|update|remove|approve|unlock> ...');
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

function cmdMigrate(args) {
  // Bug (UX pro-20 migration): prior version of `migrate` always
  // attempted the full pipeline — read source folder, import to
  // Studio project, lock all cards, then export. An author migrating
  // 20 source-tree assets had no way to know in advance whether
  // the assets would pass the v1.7.2+ Human Lock gate. The fix
  // adds `--check` which runs the import + the critical-missing
  // check + the lock-gate check, then prints a report and exits
  // without writing the .kdna file. Pair with `audit-locks` for
  // the full pre-migration report.
  //
  // Usage:
  //   kdna-studio migrate <source-dir> --check --name <@scope/name>
  //
  // Exit codes:
  //   0 — would succeed
  //   2 — INPUT_ERROR (missing args)
  //   4 — would fail (Human Lock gate or critical axiom field)
  const checkOnly = args.includes('--check');
  const sourceDir = args[0];
  const out = option(args, '--out');
  const by = option(args, '--by');
  const statement = option(args, '--statement');
  const requestedName = option(args, '--name');
  let name = requestedName || path.basename(path.resolve(sourceDir || '.'));
  if (!sourceDir || (!out && !checkOnly) || (!by && !checkOnly) || (!statement && !checkOnly)) {
    fail('Usage: kdna-studio migrate <source-dir> --out <file.kdna> --name <@scope/name> --by <id> --statement <text> [--check] [--sign] [--passphrase <pw>|--passphrase-stdin]');
  }

  const sourcePath = path.resolve(sourceDir);
  const format = option(args, '--format');
  const isStudioProject = fs.existsSync(path.join(sourcePath, 'studio.project.json'));
  let tmpDir = null;
  let projectPath = null;
  let project = null;

  // Wrap everything in try / finally so a mid-migrate failure (e.g. missing
  // critical fields, gate blocked, signing error) still cleans up tmpDir.
  // Bug: prior code only cleaned up on the v1 and v2 success paths; any
  // non-v1 export path that threw leaked `/tmp/kdna-migrate-*` entries
  // indefinitely.
  try {
  // Step 1: import dev source, or use an existing Studio project directly.
  let creatorIdentity = null;
  try { creatorIdentity = creatorApi.loadIdentity(); } catch { /* proceed without */ }
  if (format === 'v1' && isStudioProject) {
    const loaded = readProject(sourcePath);
    project = loaded.project;
    projectPath = loaded.projectPath;
    if (!requestedName && project.name) name = project.name;
  } else {
    tmpDir = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-migrate-')));
    const imported = importFromFolder(sourceDir, tmpDir, name, creatorIdentity, { silent: true });
    project = imported.project;
    projectPath = path.join(tmpDir, 'studio.project.json');
  }

  // Bug (#54): --allow-incomplete used to be read AFTER the critical
  // fields check, so a caller asking to bypass the gate was rejected
  // for the wrong reason. Resolve the flag here so the critical-missing
  // check honours it (and reports the bypass correctly) instead of
  // always failing.
  const allowIncompleteEarly = args.includes('--allow-incomplete');

  // Reject if critical judgment fields are missing or malformed on axioms.
  const criticalMissing = criticalAxiomIssues(project);
  if (criticalMissing.length > 0) {
    if (allowIncompleteEarly) {
      console.warn(
        `--allow-incomplete: bypassing ${criticalMissing.length} critical axiom-field check(s). ` +
        `The exported .kdna will load but kdna-loader may not match this domain on those signals.`,
      );
    } else {
      fail(
        `Cannot migrate: ${criticalMissing.length} critical fields missing from axioms.\n` +
        `  These fields are required for domain routing (kdna-loader uses them to\n` +
        `  decide when to load this domain). Add them to your source files first,\n` +
        `  or pass --allow-incomplete to bypass.\n` +
        `  Missing:\n    ` + criticalMissing.slice(0, 10).join('\n    ') +
        (criticalMissing.length > 10 ? `\n    ... and ${criticalMissing.length - 10} more` : '')
      );
    }
  }

  // --check branch: print a pre-migration report and exit. The
  // project object already has every card from the source tree
  // imported, so we can run the same audit-locks logic here
  // without re-reading the source. This is the single-call
  // equivalent of `kdna-studio create --from-folder <src> &&
  // kdna-studio audit-locks .` — but it requires no
  // intermediate write.
  if (checkOnly) {
    const REQUIRED = {
      axiom: ['confidence', 'evidence_type', 'one_sentence', 'full_statement', 'why',
              'applies_when', 'does_not_apply_when', 'failure_risk'],
      risk: ['name', 'description', 'mitigation'],
      stance: ['statement', 'applies_when'],
      misunderstanding: ['wrong', 'correct', 'key_distinction', 'why'],
      boundary: ['scope', 'out_of_scope'],
    };
    const summary = { project: name, source: sourceDir, total: project.cards.length, by_type: {}, would_block: false };
    for (const card of (project.cards || [])) {
      const req = REQUIRED[card.type];
      if (!req) continue;
      const missing = [];
      for (const f of req) {
        const issue = fieldIssue(card.fields || {}, f, CARD_FIELD_RULES[card.type]?.[f] || {});
        if (issue) missing.push(formatFieldIssue(issue));
      }
      if (missing.length > 0) {
        if (!summary.by_type[card.type]) summary.by_type[card.type] = [];
        summary.by_type[card.type].push({ id: card.id, missing });
        summary.would_block = true;
      }
    }
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.would_block ? EXIT.HUMAN_LOCK_REQUIRED : EXIT.OK);
  }

  // Step 2: approve and Human Lock all cards
  let locked = 0;
  for (let i = 0; i < (project.cards || []).length; i++) {
    let card = project.cards[i];
    if (card.locked) { locked++; continue; }
    if (card.status === 'draft') card = cardApi.transitionCard(card, 'revised', { by });
    const lockPayload = {
      by,
      statement,
      checked: { applies_when: true, does_not_apply_when: true, failure_risk: true },
    };
    if (args.includes('--sign')) {
      const identity = creatorApi.loadIdentity();
      if (!identity) fail('No creator identity. Run: kdna-studio identity init --name "Your Name"', EXIT.TRUST_FAILED);
      lockPayload.creator_id = identity.creator_id;
      const passphrase = resolvePassphrase(args);
      try {
        lockPayload.signature = creatorApi.signHumanLock(
          card.id, statement, cardApi.cardJudgmentFingerprint(card), null, passphrase,
        );
      } catch (e) {
        fail(`Failed to sign Human Lock for ${card.id}: ${e.message}`, EXIT.TRUST_FAILED);
      }
    }
    project.cards[i] = cardApi.lockCard(card, lockPayload);
    locked++;
  }
  if (project.stages?.judgment_cards) {
    project.stages.judgment_cards.locked = locked;
    project.stages.judgment_cards.total = project.cards.length;
  }
  writeProject(projectPath, project);
  console.log(`Approved and Human Locked: ${locked} cards`);

  // Step 3: verify Human Lock gate
  const gate = projectApi.checkHumanLockGate(project);
  if (gate.blocked) {
    const reasons = gate.issues.map((i) => `${i.cardId}: ${i.reason}`).join('\n  - ');
    fail(`Human Lock Gate blocked: ${reasons}`, EXIT.HUMAN_LOCK_REQUIRED);
  }

  const absOut = path.resolve(out);
  const allowIncomplete = args.includes('--allow-incomplete');
  // Step 4: v1 export or v2 compile + export
  if (format === 'v1') {
    exportProjectV1(project, name, absOut, { allowIncomplete });
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* cleanup */ }
    }
    return;
  }
  const { result } = compileProject(tmpDir);
  const files = { ...result.files };
  files['README.md'] = compileApi.generateReadme(project);
  files.LICENSE = project.license?.type || 'UNSPECIFIED';
  files.mimetype = 'application/vnd.aikdna.kdna+zip';

  const entries = [['mimetype', files.mimetype]];
  for (const name of Object.keys(files).filter(k => k !== 'mimetype').sort()) {
    entries.push([name, files[name]]);
  }
  const zip = buildZip(entries);
  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  fs.writeFileSync(absOut, zip);
  console.log(`Exported: ${absOut}`);
  console.log(`  Name: ${name}`);
  console.log(`  Cards: ${project.cards.length} (${locked} locked)`);
  console.log(`  Files: ${Object.keys(files).length}`);
  console.log(`  Build ID: ${result.identity.build_id}`);

  // Cleanup temp
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* best effort */ }
    tmpDir = null;
  }
  } finally {
    // Single, guaranteed cleanup point for tmpDir even when an earlier
    // step (critical-missing check, gate block, signing failure) bails
    // out via `fail()`. `fail()` ultimately calls process.exit, but
    // if a future caller swallows that or the runtime traps the throw,
    // we still leave the filesystem clean.
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* best effort */ }
    }
  }
}

function exportProjectV1(project, name, outPath, opts = {}) {
  let core;
  try { core = require('@aikdna/kdna-core'); } catch (e) {
    fail('@aikdna/kdna-core@0.11.0+ is required for v1 export.', 2);
  }
  if (!exportRuntime || typeof exportRuntime.exportRuntimeAsset !== 'function') {
    fail('@aikdna/kdna-studio-core with exportRuntime.exportRuntimeAsset is required for v1 export.', 2);
  }
  const criticalIssues = criticalAxiomIssues(project);
  if (criticalIssues.length > 0) {
    if (opts.allowIncomplete) {
      console.warn(
        `--allow-incomplete: bypassing ${criticalIssues.length} critical axiom-field check(s). ` +
        `The exported .kdna will load but kdna-loader may not match this domain on those signals.`,
      );
    } else {
      fail(
        `Cannot export v1: ${criticalIssues.length} critical axiom field issue(s).\n` +
        `  These fields are required for domain routing (kdna-loader uses them to\n` +
        `  decide when to load this domain). Fix them first, or pass\n` +
        `  --allow-incomplete to bypass.\n` +
        `  Issues:\n    ` + criticalIssues.slice(0, 10).join('\n    ') +
        (criticalIssues.length > 10 ? `\n    ... and ${criticalIssues.length - 10} more` : ''),
        EXIT.HUMAN_LOCK_REQUIRED,
      );
    }
  }
  const gate = projectApi.checkHumanLockGate(project);
  if (gate.blocked) {
    if (opts.allowIncomplete) {
      console.warn('Human Lock Gate bypassed (--allow-incomplete):');
      for (const issue of gate.issues) console.warn(`  - ${issue.cardId}: ${issue.reason}`);
    } else {
      const reasons = gate.issues.map((i) => `${i.cardId}: ${i.reason}`).join('\n  - ');
      fail(`Human Lock Gate blocked v1 export:\n  - ${reasons}\nUse --allow-incomplete to bypass.`, EXIT.HUMAN_LOCK_REQUIRED);
    }
  }
  const lockedCards = (project.cards || []).filter(c => c.locked);
  const v1Dir = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-v1-')));
  try {
    const manifestDefaults = buildV1Manifest(project, name);
    const runtimeAsset = exportRuntime.exportRuntimeAsset(project, {
      asset_id: manifestDefaults.asset_id,
      asset_uid: manifestDefaults.asset_uid,
      title: manifestDefaults.title,
      created_at: manifestDefaults.created_at,
      updated_at: manifestDefaults.updated_at,
      access: project.release?.access || project.source_manifest?.access || 'public',
      password: opts.password || undefined,
    });
    writeFiles(v1Dir, runtimeAsset.files);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    core.pack(v1Dir, outPath);
    const vr = core.validate(outPath);
    if (!vr.overall_valid) fail('v1 export validation failed: ' + (vr.problems || []).join('; '));
    console.log('Exported (v1): ' + outPath);
    console.log('  Name: ' + name + '  Cards: ' + lockedCards.length + '  Validated: all gates pass');
  } finally {
    try { fs.rmSync(v1Dir, { recursive: true }); } catch { /* cleanup */ }
  }
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
  // Mirrors the kdna-core implementation in
  // packages/kdna-core/src/asset-reader.js#manifestForSignature /
  // manifestForDigest. Anything not stripped here will end up in the
  // signing payload, and a mismatch between producer (this CLI) and
  // verifier (kdna-core) will cause the signature check to fail.
  //
  // Bug: prior version did not strip `_source` (only set by eval/loader
  // helpers) and did not recursively strip `authoring.content_digest`,
  // so a payload with either field would diverge from kdna-core's
  // canonicalisation and report a false-positive verification failure.
  const copy = { ...(manifest || {}) };
  delete copy.signature;
  delete copy.asset_digest;
  delete copy.container_sha256;
  delete copy.content_digest;
  delete copy._source;
  if (copy.authoring && typeof copy.authoring === 'object') {
    const auth = { ...copy.authoring };
    delete auth.content_digest;
    copy.authoring = auth;
  }
  return copy;
}

function canonicalPayload(files) {
  return ['mimetype', ...Object.keys(files).filter((k) => k !== 'mimetype').sort()]
    .filter((name) => name !== 'signature.json' && name !== '.DS_Store' && name !== 'build-receipt.json' && !name.startsWith('reports/'))
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

function applySignature(files, passphrase = null) {
  const paths = identityPaths();
  if (!fs.existsSync(paths.privateKey) || !fs.existsSync(paths.publicKey)) {
    fail('Signing requires KDNA identity keys. Run: kdna-studio identity init', EXIT.TRUST_FAILED);
  }
  const manifest = JSON.parse(files['kdna.json']);
  const publicKeyPem = fs.readFileSync(paths.publicKey, 'utf8');
  manifest.author = manifest.author || {};
  manifest.author.pubkey = publicKeyFingerprint(publicKeyPem);
  manifest.author.public_key_pem = publicKeyPem;
  files['kdna.json'] = JSON.stringify(manifest, null, 2);

  const payload = canonicalPayload(files);
  let privateKeyPem = fs.readFileSync(paths.privateKey, 'utf8');
  if (creatorApi.isEncryptedKey(privateKeyPem)) {
    if (!passphrase) {
      fail('Private key is encrypted. Export with: kdna-studio export ... --sign --passphrase <your-passphrase>', EXIT.TRUST_FAILED);
    }
    privateKeyPem = creatorApi.decryptPrivateKey(privateKeyPem, passphrase);
  }
  manifest.signature = `ed25519:${crypto.sign(null, Buffer.from(payload), privateKeyPem).toString('hex')}`;
  files['kdna.json'] = JSON.stringify(manifest, null, 2);
}

function cmdExport(args) {
  const projectInput = args[0];
  const out = option(args, '--out');
  if (!projectInput || !out) fail('Usage: kdna-studio export <project> --out <file.kdna> [--format v1] [--sign] [--allow-incomplete]');
  if (option(args, '--format') === 'v1') {
    const { project } = readProject(projectInput);
    // BUG-11 (2026-06-27): previous logic required --password to be set
    // before --password-stdin would take effect. That meant callers using
    // `--password-stdin` alone (the recommended path) got `password = null`
    // and the export ran unencrypted. Resolve the two flags independently:
    //   - --password-stdin  → read password from stdin (preferred)
    //   - --password <pw>   → take password from the flag (insecure)
    //   - --passphrase <pw> → legacy alias for --password
    // If both are given, --password-stdin wins (it is the explicit intent).
    // Use args.includes() for --password-stdin since it is a boolean flag
    // (option() rejects it for "missing value").
    const useStdin = args.includes('--password-stdin');
    let password;
    if (useStdin) {
      // fs.readFileSync(0) on a TTY waits forever for input and never
      // returns — the export appears to hang. Refuse up front with a
      // clear pointer to the right invocation.
      if (process.stdin.isTTY) {
        fail(
          '--password-stdin requires the password to be piped in on stdin.\n' +
          'Example:  echo "$KDNA_PASSWORD" | kdna-studio export <project> --format v1 --out <file.kdna> --password-stdin\n' +
          'If you are running interactively, omit --password-stdin and you will be prompted.'
        );
      }
      try {
        password = fs.readFileSync(0, 'utf8').trim();
      } catch (e) {
        fail(`Could not read password from stdin: ${e.message}`);
      }
    } else {
      // Bug (#55): prior version only consulted --password / --passphrase
      // here, so a caller who set KDNA_PASSPHRASE for the signing path
      // (works via resolvePassphrase) found that the v1 encryption
      // password was silently null. Resolve from the same sources as
      // the signing path so the two stay in sync.
      password = process.env.KDNA_PASSPHRASE
        || process.env.KDNA_PASSWORD
        || option(args, '--password')
        || option(args, '--passphrase');
    }
    exportProjectV1(project, option(args, '--name') || project.name, path.resolve(out), {
      allowIncomplete: args.includes('--allow-incomplete'),
      password,
    });
    return;
  }
  const { project, result } = compileProject(projectInput);
  const criticalIssues = criticalAxiomIssues(project);
  if (criticalIssues.length > 0) {
    if (args.includes('--allow-incomplete')) {
      console.warn(
        `--allow-incomplete: bypassing ${criticalIssues.length} critical axiom-field check(s). ` +
        `The exported .kdna will load but kdna-loader may not match this domain on those signals.`,
      );
    } else {
      fail(
        `Cannot export: ${criticalIssues.length} critical axiom field issue(s).\n` +
        `  These fields are required for domain routing (kdna-loader uses them to\n` +
        `  decide when to load this domain). Fix them first, or pass\n` +
        `  --allow-incomplete to bypass.\n` +
        `  Issues:\n    ` + criticalIssues.slice(0, 10).join('\n    ') +
        (criticalIssues.length > 10 ? `\n    ... and ${criticalIssues.length - 10} more` : ''),
        EXIT.HUMAN_LOCK_REQUIRED,
      );
    }
  }
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

  if (args.includes('--sign')) applySignature(files, resolvePassphrase(args));

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
  } catch (e) {
    console.error('Error spawning kdna CLI:', e.message);
    fail('kdna CLI not found. Install with: npm install -g @aikdna/kdna-cli');
  }
}

function cmdStudioUpdate(args) {
  const target = args[0];
  if (!target) fail('Usage: kdna-studio update <@scope/name>');
  // kdna update does not exist in kdna-cli v0.28.x. The correct
  // path is to re-install via npm or use kdna install to pull
  // the latest published version of the asset.
  console.log(`To update ${target}, run:`);
  console.log(`  npm install -g @aikdna/kdna-cli@latest`);
  console.log(`  kdna install ${target}`);
  console.log(``);
  console.log(`Or for a project-local install:`);
  console.log(`  cd <project-dir> && npm install @aikdna/kdna-cli@latest`);
  process.exit(0);
}

function cmdLlm(args) {
  const sub = args[0];
  if (sub === 'show') {
    const cfg = llm.config();
    console.log(`Provider : ${cfg.provider || '(not set)'}`);
    console.log(`Model    : ${cfg.model || '(not set)'}`);
    console.log(`Base URL : ${cfg.baseURL || '(not set)'}`);
    console.log(`API Key  : ${cfg.apiKey ? '********' + cfg.apiKey.slice(-4) : '(not set)'}`);
    return;
  }
  if (sub === 'config') {
    const provider = option(args, '--provider') || option(args, '-p');
    const model = option(args, '--model') || option(args, '-m');
    const apiKey = resolveApiKey(args);
    const baseURL = option(args, '--url') || option(args, '-u');
    const updates = {};
    if (provider) updates.provider = provider;
    if (model) updates.model = model;
    if (apiKey) updates.apiKey = apiKey;
    if (baseURL) updates.baseURL = baseURL;
    if (Object.keys(updates).length === 0) fail('Usage: kdna-studio llm config --provider <name> [--model <name>] [--key-pipe] [--url <base-url>]');
    const cfg = llm.configure(updates);
    console.log(JSON.stringify({ provider: cfg.provider, model: cfg.model, baseURL: cfg.baseURL }, null, 2));
    return;
  }
  fail('Usage: kdna-studio llm <config|show>');
}

function cmdIdentity(args) {
  const sub = args[0];
  if (sub === 'init') {
    const name = option(args, '--name', process.env.USER || process.env.USERNAME || '');
    const passphrase = resolvePassphrase(args);
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

// Audit-locks: list every card that would fail the v1.7.2+ Human Lock
// gate because of missing or empty fields. Used during the
// pre-migration review of source-tree assets (e.g. pro-20) so an
// author can fill in the missing confidence / evidence_type / risk
// description / stance statement BEFORE running `migrate --format v1`.
//
// Bug (UX pro-20 migration): prior version of `kdna-studio report`
// returned a flat human_lock_gate.issues list, which mixed card
// types and field names. An author migrating 20 source-tree
// assets with 99 axioms + 140 risk cards + 70 stance cards had no
// way to see, for a single asset, "which axioms are missing
// confidence?" — they had to grep the project JSON. The fix adds
// a per-type, per-field breakdown.
function cmdAuditLocks(args) {
  const { project } = readProject(args[0]);
  const useJson = args.includes('--json');
  const onlyType = option(args, '--type');  // 'axiom' | 'risk' | 'stance' | 'misunderstanding' | null

  const cards = project.cards || [];
  const findings = {
    project: project.name,
    card_count: cards.length,
    locked_count: cards.filter(c => c.locked).length,
    by_type: {},
  };

  // Per-card-type required field lists. Mirrors the v1.7.2+ lockCard
  // gate (kdna-studio-core/src/cards/index.js) so the output is
  // exactly the field set the gate will reject.
  const REQUIRED = {
    axiom: ['one_sentence', 'full_statement', 'why', 'applies_when',
            'does_not_apply_when', 'failure_risk', 'confidence', 'evidence_type'],
    risk: ['name', 'description', 'mitigation'],
    stance: ['statement', 'applies_when'],
    misunderstanding: ['wrong', 'correct', 'key_distinction', 'why'],
    boundary: ['scope', 'out_of_scope'],
    self_check: ['question'],
  };
  const THRESHOLDS = {
    axiom: {
      one_sentence: { min: 5, type: 'string' },
      full_statement: { min: 20, type: 'string' },
      why: { min: 20, type: 'string' },
      applies_when: { type: 'array', minLength: 1 },
      does_not_apply_when: { type: 'array', minLength: 1 },
      failure_risk: { min: 1, type: 'string' },
      confidence: { allowed: ['low', 'medium', 'high'] },
      evidence_type: { allowed: ['case_observation', 'theoretical', 'empirical', 'analogy', 'principle', 'practice'] },
    },
    risk: {
      name: { min: 1, type: 'string' },
      description: { min: 20, type: 'string' },
      mitigation: { min: 1, type: 'string' },
    },
    stance: {
      statement: { min: 1, type: 'string' },
      applies_when: { type: 'array', minLength: 0 },
    },
  };

  function checkField(type, fields, name, rule) {
    const value = fields[name];
    if (value === undefined || value === null || value === '') {
      return { field: name, issue: 'missing' };
    }
    if (rule.type === 'string' && rule.min && String(value).length < rule.min) {
      return { field: name, issue: 'too_short', have_length: String(value).length, need_min: rule.min };
    }
    if (rule.allowed && !rule.allowed.includes(value)) {
      return { field: name, issue: 'invalid_value', have: value, allowed: rule.allowed };
    }
    if (rule.type === 'array' && !Array.isArray(value)) {
      return { field: name, issue: 'wrong_type', have_type: typeof value, need_type: 'array' };
    }
    if (rule.type === 'array' && rule.minLength && value.length < rule.minLength) {
      return { field: name, issue: 'too_short', have_length: value.length, need_min: rule.minLength };
    }
    return null;
  }

  for (const card of cards) {
    const req = REQUIRED[card.type];
    if (!req) continue;
    if (onlyType && card.type !== onlyType) continue;
    const rule = THRESHOLDS[card.type] || {};
    const missing = [];
    for (const name of req) {
      const issue = checkField(card.type, card.fields || {}, name, rule[name] || {});
      if (issue) missing.push(issue);
    }
    if (missing.length > 0) {
      if (!findings.by_type[card.type]) {
        findings.by_type[card.type] = { missing_count: 0, cards: [] };
      }
      findings.by_type[card.type].missing_count += 1;
      findings.by_type[card.type].cards.push({
        id: card.id,
        one_sentence: card.fields?.one_sentence || card.fields?.statement || card.fields?.question || '',
        missing,
      });
    }
  }

  if (useJson) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    console.log(`Project: ${findings.project}`);
    console.log(`Cards: ${findings.card_count} (locked: ${findings.locked_count})`);
    const types = Object.keys(findings.by_type);
    if (types.length === 0) {
      console.log('\nAll cards pass the v1.7.2+ Human Lock gate. Ready to migrate.');
      return;
    }
    for (const t of types) {
      const block = findings.by_type[t];
      console.log(`\n${t}: ${block.missing_count} card(s) with missing fields`);
      for (const card of block.cards) {
        console.log(`  ${card.id}  ${(card.one_sentence || '').slice(0, 60)}`);
        for (const m of card.missing) {
          if (m.issue === 'missing') {
            console.log(`    - ${m.field}: missing`);
          } else if (m.issue === 'too_short') {
            console.log(`    - ${m.field}: too short (have ${m.have_length}, need ≥ ${m.need_min})`);
          } else if (m.issue === 'invalid_value') {
            console.log(`    - ${m.field}: invalid value "${m.have}", allowed: ${m.allowed.join('|')}`);
          } else {
            console.log(`    - ${m.field}: ${m.issue}`);
          }
        }
      }
    }
  }
}

// ─── Distillation Commands ──────────────────────────────────────────

function cmdTarget(args) {
  const sub = args[0];
  if (sub === 'declare') {
    const projectInput = args[1];
    if (!projectInput) fail('Usage: kdna-studio target declare <project> --category <cat> --scope <scope> --granularity <gran> --task <task>');
    const { projectPath, project } = readProject(projectInput);
    const category = option(args, '--category', 'expression_writing');
    const scope = option(args, '--scope', 'personal');
    const granularity = option(args, '--granularity', 'core_principles');
    const taskScope = option(args, '--task', 'general content creation');
    const include = option(args, '--include');
    const exclude = option(args, '--exclude');
    const loadCondition = option(args, '--load-condition');
    const domainName = project.name || path.basename(path.dirname(projectPath), '.json');

    const target = distillationApi.createDistillationTarget({
      domainName,
      domainCategory: category,
      ownerScope: scope,
      granularity,
      taskScope,
      includeAreas: include ? include.split(',').map(s => s.trim()).filter(Boolean) : [],
      excludeAreas: exclude ? exclude.split(',').map(s => s.trim()).filter(Boolean) : [],
      loadCondition: loadCondition || '',
    });

    const validation = distillationApi.validateDistillationTarget(target);
    if (!validation.valid) fail(`Invalid target: ${validation.errors.join('; ')}`);

    project.distillation_target = target;
    writeProject(projectPath, project);
    console.log(JSON.stringify({ declared: true, target }, null, 2));
    return;
  }
  if (sub === 'show') {
    const { project } = readProject(args[1]);
    const target = project.distillation_target;
    if (!target) fail('No distillation target declared. Run: kdna-studio target declare <project>');
    console.log(JSON.stringify(target, null, 2));
    return;
  }
  fail('Usage: kdna-studio target <declare|show>');
}

function cmdSourceClassify(args) {
  const projectInput = args[0];
  if (!projectInput) fail('Usage: kdna-studio source <project>');
  const { projectPath, project } = readProject(projectInput);
  const target = project.distillation_target;
  if (!target) fail('Declare a distillation target first: kdna-studio target declare <project>');

  // Bug (#66 + #69): the previous version of this comment claimed
  // `evidence_materials` was canonical and `evidence` was the legacy
  // fallback. The reality was the opposite — `addEvidence` in
  // @aikdna/kdna-studio-core wrote only to `project.evidence`, so
  // every consumer that read `project.evidence_materials` (this
  // command, cmdFilter, cmdDistill) saw an empty list. The fix in
  // studio-core 1.7.5 makes `addEvidence` write to BOTH fields; the
  // canonical name is now the one this comment names, not the one
  // it used to name. The fallback `|| project.evidence` stays so
  // legacy projects (pre-1.7.5) still classify correctly.
  const evidence = project.evidence_materials || project.evidence || [];
  const results = evidence.map(e => {
    const text = (e.content || e.title || '').toLowerCase();
    const domainWords = (target.include_areas || []).concat([target.domain_category, target.task_scope]);
    const hitCount = domainWords.filter(w => text.includes(w.toLowerCase())).length;
    let relevance;
    if (hitCount >= 2) relevance = 'relevant';
    else if (hitCount === 1) relevance = 'weakly_relevant';
    else {
      const otherHits = Object.keys(distillationApi.DOMAIN_CATEGORIES)
        .filter(k => k !== target.domain_category)
        .filter(k => text.includes(k)).length;
      relevance = otherHits > 0 ? 'split_domain' : 'weakly_relevant';
    }
    return { id: e.id, title: e.title, relevance };
  });

  const summary = {};
  for (const r of results) { summary[r.relevance] = (summary[r.relevance] || 0) + 1; }

  project.distillation_evidence_relevance = results;
  writeProject(projectPath, project);
  console.log(JSON.stringify({ summary, results }, null, 2));
}

async function cmdDistill(args) {
  const projectInput = args[0];
  const candidatesFile = option(args, '--candidates');
  const useAI = args.includes('--ai');
  // Bug (#1 UX): prior version called resolveApiKey(args)
  // unconditionally, which is fine when --candidates is set (the
  // call is a no-op) but it also surfaced the env-var resolution
  // on every run, so a caller that never asked for the LLM was
  // still at the mercy of `resolveApiKey` warnings. Defer the
  // LLM-key resolution to the --ai branch.
  const provider = useAI ? option(args, '--provider') : null;
  const model = useAI ? option(args, '--model') : null;
  const apiKey = useAI ? resolveApiKey(args) : null;
  if (!projectInput) fail('Usage: kdna-studio distill <project> [--ai] [--candidates <file.json>]');
  if (!candidatesFile && !useAI) fail('Either --ai or --candidates <file.json> required.');

  const { projectPath, project } = readProject(projectInput);
  const target = project.distillation_target;
  if (!target) fail('Declare a distillation target first: kdna-studio target declare <project>');

  let rawCandidates;
  if (useAI) {
    const evidence = (project.evidence_materials || []).map(e => ({ filename: e.filename || e.name, content: e.raw_text || e.content || '' }));
    if (evidence.length === 0) console.warn('No evidence materials found. AI distillation works best with imported evidence. Run: kdna-studio import <project> <file>');

    console.log('Running AI distillation...');
    rawCandidates = await ai.distill(llm.config(), evidence, target, { provider, model, apiKey });
    console.log(`AI extracted ${rawCandidates.length} candidates.`);
  } else {
    const rawPath = path.resolve(candidatesFile);
    if (!fs.existsSync(rawPath)) fail(`Candidates file not found: ${rawPath}`);
    const stats = fs.statSync(rawPath);
    if (stats.size > 50 * 1024 * 1024) {
      fail(`Candidates file too large (${(stats.size / (1024 * 1024)).toFixed(1)} MiB, max 50 MiB): ${rawPath}`);
    }
    rawCandidates = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
    if (!Array.isArray(rawCandidates)) fail('Candidates file must contain a JSON array');
  }

  const candidates = rawCandidates.map(c => {
    const base = {
      id: c.candidate_id || c.id || `cand_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      one_sentence: c.one_sentence || c.oneSentence || '',
      full_statement: c.full_statement || c.fullStatement || '',
      suggested_card_type: c.type || c.suggested_card_type || 'axiom',
      supporting_evidence_ids: (c.evidence_ids || c.evidenceIds || c.supporting_evidence_ids || []).map(String),
      confidence: c.confidence || 'medium',
      candidate_status: 'proposed',
      scope_fit: c.scope_fit ?? c.scopeFit ?? true,
    };
    return distillationApi.applyScopeGate(base, target);
  });

  const summary = distillationApi.candidateStatusSummary(candidates);
  project.distillation_candidates = candidates;
  writeProject(projectPath, project);
  console.log(JSON.stringify({ summary, count: candidates.length }, null, 2));
}

function cmdCandidate(args) {
  const sub = args[0];
  const projectInput = args[1];
  if (!sub || !projectInput) fail('Usage: kdna-studio candidate <list|accept|reject|override|promote>');

  const { projectPath, project } = readProject(projectInput);
  const candidates = project.distillation_candidates || [];

  if (sub === 'list') {
    for (const c of candidates) {
      const scopeMarker = c.scope_fit ? '' : ' [OUT_OF_SCOPE]';
      const split = c.suggested_split_domain ? ` → ${c.suggested_split_domain}` : '';
      console.log(`${c.id}\t${c.candidate_status}\t${c.suggested_card_type}\t${c.confidence}\t${c.one_sentence.substring(0,60)}${scopeMarker}${split}`);
    }
    console.log(JSON.stringify(distillationApi.candidateStatusSummary(candidates), null, 2));
    return;
  }

  if (sub === 'accept' || sub === 'reject') {
    const candId = args[2];
    if (!candId) fail(`Usage: kdna-studio candidate ${sub} <project> <candidate-id>`);
    const idx = candidates.findIndex(c => c.id === candId);
    if (idx < 0) fail(`Candidate not found: ${candId}`);
    candidates[idx].candidate_status = sub === 'accept' ? 'accepted' : 'rejected';
    project.distillation_candidates = candidates;
    writeProject(projectPath, project);
    console.log(`${sub === 'accept' ? 'Accepted' : 'Rejected'}: ${candId}`);
    return;
  }

  if (sub === 'override') {
    const candId = args[2];
    if (!candId) fail('Usage: kdna-studio candidate override <project> <candidate-id>');
    const idx = candidates.findIndex(c => c.id === candId);
    if (idx < 0) fail(`Candidate not found: ${candId}`);
    candidates[idx].scope_fit = true;
    candidates[idx].domain_relevance_score = 50;
    candidates[idx].relevance_evidence = 'User explicitly overrode scope gate via CLI';
    candidates[idx].suggested_split_domain = null;
    project.distillation_candidates = candidates;
    writeProject(projectPath, project);
    console.log(`Scope gate overridden: ${candId}`);
    return;
  }

  if (sub === 'promote') {
    const accepted = candidates.filter(c => c.candidate_status === 'accepted' && c.scope_fit !== false);
    if (accepted.length === 0) fail('No candidates to promote. Accept some candidates first.');

    for (const c of accepted) {
      // Promote candidates to draft cards. For axioms we must populate every
      // field the Human Lock gate and migrate path require — empty strings
      // cause migrate to fail ("critical fields missing from axioms"). When
      // a candidate lacks the field, fall back to the candidate's own
      // one_sentence/full_statement so the lock gate at least has substance
      // to verify. Authors are expected to enrich these fields before
      // locking.
      const fields = {};
      if (c.suggested_card_type === 'axiom') {
        fields.one_sentence = c.one_sentence || '';
        fields.full_statement = c.full_statement || c.one_sentence || '<TBD: full_statement>';
        fields.why = c.why || '<TBD: why>';
        // applies_when / does_not_apply_when are arrays, not strings.
        // Empty string is invalid; emit an empty array so checkRequiredFields
        // (which treats `length === 0` as missing) correctly reports them.
        fields.applies_when = Array.isArray(c.applies_when) ? c.applies_when : [];
        fields.does_not_apply_when = Array.isArray(c.does_not_apply_when) ? c.does_not_apply_when : [];
        fields.failure_risk = c.failure_risk || '<TBD: failure_risk>';
      } else {
        fields.one_sentence = c.one_sentence || '';
        fields.full_statement = c.full_statement || c.one_sentence || '';
      }
      const card = cardApi.createCard(c.suggested_card_type, fields);
      card.evidence_refs = c.supporting_evidence_ids;
      project.cards = project.cards || [];
      project.cards.push(card);
    }
    if (project.stages?.judgment_cards) {
      project.stages.judgment_cards.total = project.cards.length;
      project.stages.judgment_cards.status = 'in_progress';
    }
    writeProject(projectPath, project);
    console.log(`Promoted ${accepted.length} candidates → ${accepted.length} Studio cards`);
    return;
  }

  fail('Usage: kdna-studio candidate <list|accept|reject|override|promote>');
}

async function cmdInterview(args) {
  const projectInput = args[0];
  const stage = option(args, '--stage');
  if (!projectInput) fail('Usage: kdna-studio interview <project> [--stage distill|clarify|correct|replay]');
  const { project } = readProject(projectInput);

  if (stage) {
    const result = await ai.interview.runInterview(llm.config(), project, stage, '', {});
    console.log(`\n=== ${result.label} ===\n${result.content}`);
  } else {
    await ai.interview.runInterviewInteractive(llm.config(), project, {});
  }
}

async function cmdFeynman(args) {
  const projectInput = args[0];
  const cardId = args[1];
  if (!projectInput || !cardId) fail('Usage: kdna-studio feynman <project> <card-id>');
  const useJson = args.includes('--json');
  const { projectPath, project } = readProject(projectInput);
  const cardIdx = (project.cards || []).findIndex(c => c.id === cardId);
  if (cardIdx < 0) fail(`Card not found: ${cardId}`);
  const card = project.cards[cardIdx];

  // Canonical field name in the card schema is `feynman_restatement`, not
  // `feynman_text`. The old check was dead code (nothing writes the wrong
  // field) and made this command fail on every card.
  //
  // Bug (#62 + #68 follow-up): the prior `if (!card.feynman_restatement)
  // fail(...)` block rejected every card that had no human-written
  // restatement, even when the AI evaluator in feynman.js was
  // prepared to auto-synthesise one. A caller without a configured
  // LLM (no `KDNA_API_KEY`, no `kdna-studio llm config`) would
  // get a `fail` instead of a structured note. The fix removes the
  // guard: a missing restatement is now handed off to the evaluator
  // (which either asks the LLM to evaluate a synthesised one or,
  // without an LLM, returns a structured `synthesised_restatement`
  // for the caller to use as a starting point). The error message
  // is kept as a secondary path: only if the evaluator itself fails
  // does the command exit non-zero, and only then with a clear
  // pointer to the manual `card update` path.
  //
  // We do still need a restatement-shaped object to feed the
  // evaluator, so we synthesise one in-memory when the card has
  // none. This does NOT persist the synthesised restatement to the
  // project (so the user still has to opt in via `card update` to
  // keep one across runs), but it lets the no-LLM path return a
  // useful result instead of a hard fail.
  if (!card.feynman_restatement) {
    const synthesised = ai.feynman.synthFeynmanRestatement(card.fields || {});
    card.feynman_restatement = { text: synthesised, synthesised: true };
    console.warn(`No feynman_restatement on ${cardId}; using synthesised:\n  "${synthesised}"`);
  }

  if (!useJson) console.log(`Evaluating Feynman restatement for card: ${cardId}`);

  // Bug (#1 UX follow-up): if no LLM is configured and the caller
  // did not pass --no-llm, route through cmdNeedsLlm which either
  // gives a clear "configure LLM" error or accepts the --no-llm
  // path. Without this branch, the no-LLM caller would fall
  // through to the LLM call below and get a stack trace.
  const llmGate = cmdNeedsLlm(args, 'feynmann');

  let result;
  if (llmGate.noLlm) {
    // Static evaluation: every criterion is "unsure" (✗), score 0,
    // but the command still produces a useful structured result and
    // saves the synthesised restatement to the card.
    result = {
      score: 0,
      criteria: Object.fromEntries(Object.keys(ai.feynman.CRITERIA).map(k => [k, false])),
      explanations: { noLlm: llmGate.message },
      suggestions: [
        'No LLM configured — every criterion shows ✗. Run `kdna-studio llm config` and re-evaluate for a real score.',
        'Or set the synthesised restatement via: kdna-studio card update <project> ' + cardId + ' --field feynman_restatement=\'{"text":"<your own restatement>"}\'',
      ],
    };
  } else {
    result = await ai.feynman.evaluate(llmGate.cfg, card, {});
  }
  const score = result.score || 0;
  const passed = score >= 4;

  if (useJson) {
    console.log(JSON.stringify({
      card_id: cardId,
      score,
      passed,
      no_llm: !!llmGate.noLlm,
      criteria: result.criteria || {},
      suggestions: result.suggestions || [],
      feynman_restatement: card.feynman_restatement,
    }, null, 2));
  } else {
    console.log(`Score: ${score}/5 ${passed ? '✓ publishable' : '✗ below threshold (need 4/5)'}${llmGate.noLlm ? '  (--no-llm: static result)' : ''}`);
    for (const [criterion, desc] of Object.entries(ai.feynman.CRITERIA)) {
      const r = (result.criteria || {})[criterion] ? '✓' : '✗';
      console.log(`  ${r} ${criterion}`);
    }
    if (result.suggestions && result.suggestions.length > 0) {
      console.log('\nSuggestions:');
      result.suggestions.forEach(s => console.log(`  - ${s}`));
    }
  }

  card.feynman_evaluation = { score, criteria: result.criteria, suggestions: result.suggestions, evaluated_at: new Date().toISOString() };
  project.cards[cardIdx] = card;
  writeProject(projectPath, project);
}

async function cmdTest(args) {
  const projectInput = args[0];
  const input = option(args, '--input');
  const preset = option(args, '--preset', 'baseline');
  if (!projectInput || !input) fail('Usage: kdna-studio test <project> --input "<text>" [--preset baseline|edge|contradiction]');
  const { project } = readProject(projectInput);
  const domainName = project.name || 'Untitled Project';
  const domainPrompt = `Domain: ${domainName}\n${project.description || ''}`;

  // Bug (#50): prior version hand-rolled the prompt for the 3 preset
  // names and bypassed ai.testlab.testPreset entirely. The exported
  // testPreset function was dead code, and the help text advertised
  // names (baseline / edge / contradiction) that did not match the
  // actual preset keys in testlab.js (baseline / edge_case /
  // contradiction). Result: --preset edge silently ran the
  // contradiction branch, and any caller that asked for "edge_case"
  // fell through to the contradiction branch too.
  //
  // The fix routes the call through testPreset when a known preset is
  // given, and accepts both help-text names (baseline / edge /
  // contradiction) and the canonical testlab names (baseline / edge_case
  // / contradiction).
  const PRESET_ALIASES = {
    baseline: 'baseline',
    edge: 'edge_case',
    edge_case: 'edge_case',
    contradiction: 'contradiction',
  };
  const canonical = PRESET_ALIASES[preset] || 'baseline';
  console.log(`Testing: ${domainName} [${preset}]`);

  // Bug (#1 UX): gate LLM-requiring paths through cmdNeedsLlm.
  // The test command always needs an LLM (it compares without/with
  // the loaded domain). --no-llm gives a static "no-op" comparison
  // that lists the cards that *would* be applied.
  const llmGate = cmdNeedsLlm(args, 'test');
  const cfg = llmGate.noLlm ? null : llmGate.cfg;

  if (canonical === 'baseline') {
    // Baseline is a single comparison: keep the prior single-result
    // shape so existing parsers / consumers see the same output.
    const prompt = `Test the core judgment: ${input}`;
    if (cfg === null) {
      // No-LLM static result
      const cards = (project.cards || []).filter(c => c.locked).map(c => ({ type: c.type, id: c.id, one_sentence: c.fields?.one_sentence || c.fields?.question || '' }));
      console.log(JSON.stringify({ no_llm: true, message: llmGate.message, would_apply: cards }, null, 2));
      return;
    }
    const result = await ai.testlab.compare(cfg, domainName, prompt, domainPrompt, {});
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  // For non-baseline presets, run the preset + the baseline so the user
  // can see both side by side. The preset prompt is the one in
  // ai/testlab.js — that's the code path that was dead before.
  if (cfg === null) {
    console.log(JSON.stringify({ no_llm: true, message: llmGate.message }, null, 2));
    return;
  }
  const result = await ai.testlab.testPreset(cfg, domainName, input, domainPrompt, {});
  console.log(JSON.stringify(result[canonical] || result, null, 2));
}

const args = process.argv.slice(2);
const cmd = args[0];
if (!cmd || cmd === '--help' || cmd === '-h') {
  usage();
  process.exit(EXIT.OK);
}
if (cmd === '--version' || cmd === '-v') {
  console.log(require('../package.json').version);
  process.exit(EXIT.OK);
}

(async () => {
try {
  if (cmd === 'create') cmdCreate(args.slice(1));
  else if (cmd === 'migrate') cmdMigrate(args.slice(1));
  else if (cmd === 'import') cmdImport(args.slice(1));
  else if (cmd === 'filter') cmdFilter(args.slice(1));
  else if (cmd === 'target') cmdTarget(args.slice(1));
  else if (cmd === 'source') cmdSourceClassify(args.slice(1));
  else if (cmd === 'distill') await cmdDistill(args.slice(1));
  else if (cmd === 'candidate') cmdCandidate(args.slice(1));
  else if (cmd === 'interview') await cmdInterview(args.slice(1));
  else if (cmd === 'feynman') await cmdFeynman(args.slice(1));
  else if (cmd === 'test') await cmdTest(args.slice(1));
  else if (cmd === 'card') cmdCard(args.slice(1));
  else if (cmd === 'lock') cmdLock(args.slice(1));
  else if (cmd === 'compile') cmdCompile(args.slice(1));
  else if (cmd === 'export') cmdExport(args.slice(1));
  else if (cmd === 'llm') cmdLlm(args.slice(1));
  else if (cmd === 'identity') cmdIdentity(args.slice(1));
  else if (cmd === 'report') cmdReport(args.slice(1));
  else if (cmd === 'audit-locks') cmdAuditLocks(args.slice(1));
  else if (cmd === 'install') cmdStudioInstall(args.slice(1));
  else if (cmd === 'update') cmdStudioUpdate(args.slice(1));
  else {
    usage();
    fail(`Unknown command: ${cmd}`);
  }
} catch (err) {
  fail(err.message || String(err));
}
})();
