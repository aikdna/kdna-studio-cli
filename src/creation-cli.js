'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const INPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const MATERIAL_LIMIT_BYTES = 50 * 1024 * 1024;
const MATERIAL_TOTAL_LIMIT_BYTES = 50 * 1024 * 1024;
const MATERIAL_TEXT_LIMIT_BYTES = 2 * 1024 * 1024;
const MATERIAL_FILE_LIMIT = 256;
const CREATION_COMMANDS = new Set([
  'create-agent',
  'resume',
  'status',
  'answer',
  'review',
  'try',
  'repair',
  'export-agent',
]);
const TEXT_EXTENSIONS = new Set([
  '.csv',
  '.html',
  '.json',
  '.log',
  '.md',
  '.srt',
  '.text',
  '.txt',
  '.vtt',
  '.yaml',
  '.yml',
]);

class CreationCliError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function valueOption(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new CreationCliError('input_invalid', `${name} requires a value.`);
  }
  return value;
}

function allValueOptions(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new CreationCliError('input_invalid', `${name} requires a value.`);
    }
    values.push(value);
    index += 1;
  }
  return values;
}

function rejectNaturalLanguageArgv(args) {
  for (const forbidden of ['--answer', '--purpose', '--statement', '--objective']) {
    if (
      args.includes(forbidden) ||
      args.some((argument) => argument.startsWith(`${forbidden}=`))
    ) {
      throw new CreationCliError(
        'private_input_in_argv',
        `${forbidden} is not accepted in process arguments. Use --input-file or --input-stdin.`,
      );
    }
  }
}

function readBoundedFile(file, maximum = INPUT_LIMIT_BYTES) {
  const absolute = path.resolve(file);
  const flags =
    fs.constants.O_RDONLY |
    (typeof fs.constants.O_NOFOLLOW === 'number'
      ? fs.constants.O_NOFOLLOW
      : 0);
  let descriptor;
  try {
    descriptor = fs.openSync(absolute, flags);
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new CreationCliError('input_invalid', 'Input must be a regular file.');
    }
    throw new CreationCliError(
      'input_unavailable',
      'The requested input file is unavailable.',
    );
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new CreationCliError('input_invalid', 'Input must be a regular file.');
    }
    if (before.size > BigInt(maximum)) {
      throw new CreationCliError(
        'input_too_large',
        `Input exceeds the ${maximum}-byte limit.`,
      );
    }
    // O_NOFOLLOW rejects a path symlink at open time. The lstat check keeps
    // that property on platforms where O_NOFOLLOW is unavailable, while the
    // descriptor remains the sole source of bytes.
    let pathStat;
    try {
      pathStat = fs.lstatSync(absolute, { bigint: true });
    } catch {
      throw new CreationCliError(
        'input_changed',
        'The requested input changed while it was being opened.',
      );
    }
    if (
      pathStat.isSymbolicLink() ||
      pathStat.dev !== before.dev ||
      pathStat.ino !== before.ino
    ) {
      throw new CreationCliError(
        'input_changed',
        'The requested input changed while it was being opened.',
      );
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      bytes.length > maximum ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      throw new CreationCliError(
        'input_changed',
        'The requested input changed while it was being read.',
      );
    }
    const modifiedAt = Number(before.mtimeMs);
    return {
      absolute,
      bytes,
      fileMetadata: {
        source_created_at: null,
        source_updated_at:
          Number.isFinite(modifiedAt) && modifiedAt > 0
            ? new Date(modifiedAt).toISOString()
            : null,
        time_basis: 'file-metadata',
      },
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function consumeMaterialBudget(budget, byteLength) {
  budget.used += byteLength;
  if (budget.used > budget.maximum) {
    throw new CreationCliError(
      'material_total_limit_exceeded',
      `Material input exceeds the cumulative ${budget.maximum}-byte limit.`,
    );
  }
}

function parseStructuredInput(bytes, allowPlainText = false) {
  const text = bytes.toString('utf8');
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CreationCliError('input_invalid', 'Structured input must be a JSON object.');
    }
    return parsed;
  } catch (error) {
    if (error instanceof CreationCliError) throw error;
    if (allowPlainText) return { text };
    throw new CreationCliError('input_invalid', 'Input is not valid JSON.');
  }
}

function forbiddenStructuredSecret(value, pathParts = []) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    const currentPath = [...pathParts, key];
    if (
      /(?:^|_)(?:password|passphrase|private_key|secret|token|credential)(?:$|_)/i
        .test(key)
    ) {
      return currentPath.join('.');
    }
    const nested = forbiddenStructuredSecret(child, currentPath);
    if (nested) return nested;
  }
  return null;
}

function readCommandInput(args, options = {}) {
  rejectNaturalLanguageArgv(args);
  const inputFile = valueOption(args, '--input-file');
  const fromStdin = args.includes('--input-stdin');
  if (inputFile && fromStdin) {
    throw new CreationCliError(
      'input_invalid',
      'Use only one of --input-file or --input-stdin.',
    );
  }
  if (fromStdin && args.includes('--password-stdin')) {
    throw new CreationCliError(
      'input_invalid',
      '--input-stdin and --password-stdin cannot share one stdin stream.',
    );
  }
  if (inputFile) {
    const parsed = parseStructuredInput(
      readBoundedFile(inputFile).bytes,
      options.allowPlainText === true,
    );
    const forbidden = forbiddenStructuredSecret(parsed);
    if (forbidden) {
      throw new CreationCliError(
        'secret_in_input',
        `Secret-bearing field ${forbidden} is not accepted in structured input.`,
      );
    }
    return parsed;
  }
  if (fromStdin) {
    if (process.stdin.isTTY) {
      throw new CreationCliError(
        'input_unavailable',
        '--input-stdin requires piped input.',
      );
    }
    const bytes = fs.readFileSync(0);
    if (bytes.length > INPUT_LIMIT_BYTES) {
      throw new CreationCliError('input_too_large', 'Piped input is too large.');
    }
    const parsed = parseStructuredInput(
      bytes,
      options.allowPlainText === true,
    );
    const forbidden = forbiddenStructuredSecret(parsed);
    if (forbidden) {
      throw new CreationCliError(
        'secret_in_input',
        `Secret-bearing field ${forbidden} is not accepted in structured input.`,
      );
    }
    return parsed;
  }
  return {};
}

function readPassword(args) {
  if (
    args.includes('--password') ||
    args.some((argument) => argument.startsWith('--password='))
  ) {
    throw new CreationCliError(
      'secret_in_argv',
      'Password values are not accepted in process arguments. Use --password-stdin.',
    );
  }
  if (!args.includes('--password-stdin')) return null;
  if (process.stdin.isTTY) {
    throw new CreationCliError(
      'secret_unavailable',
      '--password-stdin requires a password piped on stdin.',
    );
  }
  const password = fs.readFileSync(0, 'utf8').trim();
  if (!password) {
    throw new CreationCliError('secret_unavailable', 'The piped password is empty.');
  }
  return password;
}

function applicationExecutionInput(input, args) {
  const requiresAsset = Boolean(
    input.application_attempt || input.application_observation,
  );
  const assetPath = valueOption(args, '--asset');
  if (!requiresAsset) {
    if (assetPath || args.includes('--password-stdin')) {
      throw new CreationCliError(
        'application_asset_unexpected',
        '--asset and --password-stdin are accepted only for application attempt or Consumer observation requests.',
      );
    }
    return null;
  }
  if (!assetPath) {
    throw new CreationCliError(
      'application_asset_required',
      'Application attempt and Consumer observation requests require --asset <final.kdna>.',
    );
  }
  if (path.extname(assetPath).toLowerCase() !== '.kdna') {
    throw new CreationCliError(
      'application_asset_invalid',
      'The application asset must end in .kdna.',
    );
  }
  const read = readBoundedFile(assetPath, MATERIAL_LIMIT_BYTES);
  const password = readPassword(args);
  return {
    bytes: read.bytes,
    password,
    operation_effects: {
      asset_digest: sha256Bytes(read.bytes),
      asset_filename: path.basename(assetPath),
      authorization_supplied: Boolean(password),
    },
  };
}

function mapApplicationExecutionError(error) {
  const authorizationCodes = new Map([
    [
      'APPLICATION_AUTHORIZATION_REQUIRED',
      [
        'application_authorization_required',
        'The exact protected application asset requires password authorization.',
      ],
    ],
    [
      'APPLICATION_AUTHORIZATION_FAILED',
      [
        'application_authorization_failed',
        'The exact protected application asset could not be authorized.',
      ],
    ],
    [
      'APPLICATION_AUTHORIZATION_MISMATCH',
      [
        'application_authorization_mismatch',
        'The supplied authorization does not match the exact application asset.',
      ],
    ],
  ]);
  if (authorizationCodes.has(error?.code)) {
    const [code, message] = authorizationCodes.get(error.code);
    return new CreationCliError(code, message, 4);
  }
  const technicalCodes = new Map([
    [
      'APPLICATION_ASSET_REQUIRED',
      'The exact final application asset bytes were not supplied.',
    ],
    [
      'APPLICATION_FORMAT_INVALID',
      'The exact application asset failed KDNA Core format verification.',
    ],
    [
      'APPLICATION_RUNTIME_UNAVAILABLE',
      'The pinned KDNA Core authorized loader is unavailable.',
    ],
    [
      'APPLICATION_RUNTIME_LOAD_FAILED',
      'The exact application asset failed KDNA Core Runtime loading.',
    ],
    [
      'APPLICATION_ASSET_DIGEST_MISMATCH',
      'The loaded application asset does not match the current FORMAT_VALID asset.',
    ],
    [
      'APPLICATION_ASSET_CHANGED',
      'The application asset snapshot changed during verification.',
    ],
  ]);
  if (technicalCodes.has(error?.code)) {
    return new CreationCliError(
      error.code.toLowerCase(),
      technicalCodes.get(error.code),
      5,
    );
  }
  return error;
}

function requireCreationEngine(engine) {
  const required = [
    'createWorkspace',
    'loadWorkspace',
    'saveWorkspace',
    'setPurpose',
    'ingestMaterial',
    'reviewMaterial',
    'addCandidate',
    'recordInterviewAnswer',
    'promoteCandidate',
    'analyzeRelations',
    'recordConfirmation',
    'addSemanticTest',
    'freezeSemanticTestPlan',
    'recordSemanticTestResult',
    'freezeApplicationTestPlan',
    'issueApplicationAttempt',
    'recordApplicationAssetObservation',
    'abandonApplicationAttempt',
    'recordApplicationReceipt',
    'buildRepairPlan',
    'applyRepair',
    'assessReadiness',
    'compileProject',
    'recordBuildReceipt',
    'nextAction',
    'canonicalOperationRequestDigest',
    'operationCoordinate',
    'resolveOperation',
    'completeOperation',
    'prepareExportOperation',
    'verifyExportOperation',
    'completeExportOperation',
  ];
  const missing = required.filter((name) => typeof engine?.[name] !== 'function');
  if (missing.length > 0) {
    throw new CreationCliError(
      'creation_engine_unavailable',
      'The installed Studio Core does not provide the complete Creation Engine.',
      5,
    );
  }
}

function safeMaterialKind(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.pdf') return 'pdf';
  if (extension === '.doc' || extension === '.docx') return 'document';
  if (extension === '.srt' || extension === '.vtt') return 'transcript';
  if (extension === '.json') return 'json';
  return 'text';
}

function extractedText(file, bytes) {
  const extension = path.extname(file).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension) || extension === '') {
    if (bytes.includes(0)) {
      throw new CreationCliError(
        'material_unsupported',
        `Material is not recognized as text: ${path.basename(file)}`,
      );
    }
    return bytes.subarray(0, MATERIAL_TEXT_LIMIT_BYTES).toString('utf8');
  }
  if (extension === '.pdf') {
    try {
      return execFileSync('pdftotext', ['-', '-'], {
        encoding: 'utf8',
        input: bytes,
        maxBuffer: MATERIAL_TEXT_LIMIT_BYTES,
        shell: false,
        timeout: 30_000,
      });
    } catch {
      throw new CreationCliError(
        'material_extraction_failed',
        `Could not extract PDF text from ${path.basename(file)}.`,
      );
    }
  }
  if (extension === '.doc' || extension === '.docx') {
    try {
      return execFileSync(
        'textutil',
        ['-convert', 'txt', '-stdin', '-stdout'],
        {
          encoding: 'utf8',
          input: bytes,
          maxBuffer: MATERIAL_TEXT_LIMIT_BYTES,
          shell: false,
          timeout: 30_000,
        },
      );
    } catch {
      throw new CreationCliError(
        'material_extraction_failed',
        `Could not extract document text from ${path.basename(file)}.`,
      );
    }
  }
  throw new CreationCliError(
    'material_unsupported',
    `Unsupported material type: ${path.basename(file)}`,
  );
}

function collectMaterialFiles(inputPaths) {
  const files = [];
  function visit(candidate) {
    const absolute = path.resolve(candidate);
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch {
      throw new CreationCliError(
        'material_unavailable',
        `Material is unavailable: ${path.basename(candidate)}`,
      );
    }
    if (stat.isSymbolicLink()) {
      throw new CreationCliError(
        'material_invalid',
        `Material symlinks are not accepted: ${path.basename(candidate)}`,
      );
    }
    if (stat.isFile()) {
      files.push(absolute);
      if (files.length > MATERIAL_FILE_LIMIT) {
        throw new CreationCliError(
          'material_limit_exceeded',
          `A creation operation accepts at most ${MATERIAL_FILE_LIMIT} material files.`,
        );
      }
      return;
    }
    if (!stat.isDirectory()) {
      throw new CreationCliError('material_invalid', 'Material must be a file or directory.');
    }
    for (const entry of fs.readdirSync(absolute).sort()) {
      visit(path.join(absolute, entry));
    }
  }
  for (const candidate of inputPaths) visit(candidate);
  return files;
}

function descriptorForMaterial(value, budget) {
  const descriptor =
    typeof value === 'string' ? { path: value } : { ...(value || {}) };
  if (descriptor.content !== undefined) {
    if (typeof descriptor.content !== 'string') {
      throw new CreationCliError('material_invalid', 'Inline material content must be text.');
    }
    consumeMaterialBudget(budget, Buffer.byteLength(descriptor.content));
    const inline = {
      ...descriptor,
      kind: descriptor.kind || 'text',
      title: descriptor.title || 'Provided material',
      content_hash:
        descriptor.content_hash ||
        `sha256:${crypto.createHash('sha256').update(descriptor.content).digest('hex')}`,
      authority: descriptor.authority || 'unknown',
      currentness: descriptor.currentness || 'unknown',
      sensitivity: descriptor.sensitivity || 'private',
      in_scope: descriptor.in_scope ?? 'unknown',
      source_created_at: descriptor.source_created_at ?? null,
      source_updated_at: descriptor.source_updated_at ?? null,
      time_basis: descriptor.time_basis || 'unknown',
    };
    delete inline.path;
    delete inline.reference;
    delete inline.opaque_reference;
    inline.reference = descriptor.opaque_reference || null;
    return inline;
  }
  const materialPath = descriptor.path || descriptor.reference;
  if (!materialPath) {
    throw new CreationCliError(
      'material_invalid',
      'Each material requires a path, reference, or inline content.',
    );
  }
  const {
    absolute,
    bytes,
    fileMetadata,
  } = readBoundedFile(materialPath, MATERIAL_LIMIT_BYTES);
  consumeMaterialBudget(budget, bytes.length);
  const content = extractedText(absolute, bytes);
  delete descriptor.path;
  delete descriptor.reference;
  delete descriptor.opaque_reference;
  return {
    ...descriptor,
    kind: descriptor.kind || safeMaterialKind(absolute),
    title: descriptor.title || path.basename(absolute),
    bytes,
    content,
    content_hash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    reference: value?.opaque_reference || path.basename(absolute),
    authority: descriptor.authority || 'unknown',
    currentness: descriptor.currentness || 'unknown',
    sensitivity: descriptor.sensitivity || 'private',
    in_scope: descriptor.in_scope ?? 'unknown',
    source_created_at:
      descriptor.source_created_at ?? fileMetadata.source_created_at,
    source_updated_at:
      descriptor.source_updated_at ?? fileMetadata.source_updated_at,
    time_basis: descriptor.time_basis || fileMetadata.time_basis,
  };
}

function candidateFromImportedCard(card, sourceId, index) {
  const fields = card?.fields || {};
  const statement =
    fields.one_sentence ||
    fields.statement ||
    fields.position ||
    fields.scope ||
    fields.name ||
    fields.question ||
    fields.title ||
    '';
  const rationale =
    fields.rationale ||
    fields.why ||
    fields.description ||
    fields.full_statement ||
    fields.lesson ||
    '';
  const appliesWhen = Array.isArray(fields.applies_when)
    ? fields.applies_when.filter(Boolean).map(String)
    : [];
  const doesNotApplyWhen = Array.isArray(fields.does_not_apply_when)
    ? fields.does_not_apply_when.filter(Boolean).map(String)
    : [];
  const misuseRisk =
    fields.misuse_risk ||
    fields.failure_risk ||
    '';
  if (
    !String(statement).trim() ||
    !String(rationale).trim() ||
    appliesWhen.length === 0 ||
    doesNotApplyWhen.length === 0 ||
    !String(misuseRisk).trim()
  ) {
    return null;
  }
  const stableCardId = String(card.id || `${card.type || 'judgment'}-${index + 1}`)
    .replace(/[^a-zA-Z0-9_.-]+/g, '-');
  return {
    id: `candidate-from-${stableCardId}`,
    statement: String(statement),
    rationale: String(rationale),
    applies_when: appliesWhen,
    does_not_apply_when: doesNotApplyWhen,
    misuse_risk: String(misuseRisk),
    source_refs: [sourceId],
    contrary_evidence: [
      'The imported asset may be outdated, differently scoped, or governed by another authority; derivation review must resolve that possibility.',
    ],
    confidence: fields.confidence || 'unknown',
    agent_inference: false,
    card_type: card.type || 'axiom',
    fields: JSON.parse(JSON.stringify(fields)),
  };
}

function currentKdnaMaterial(value, deps, password, budget = {
  used: 0,
  maximum: MATERIAL_TOTAL_LIMIT_BYTES,
}) {
  const descriptor = { ...(value || {}) };
  const materialPath = descriptor.path || descriptor.reference;
  if (!materialPath) {
    throw new CreationCliError(
      'material_invalid',
      'A KDNA material requires a packaged .kdna path.',
    );
  }
  if (
    !deps?.runtimeCore ||
    typeof deps.runtimeCore.validate !== 'function' ||
    typeof deps.runtimeCore.inspect !== 'function' ||
    typeof deps.runtimeCore.planLoad !== 'function' ||
    typeof deps.reimportCapsule !== 'function'
  ) {
    throw new CreationCliError(
      'runtime_unavailable',
      'Current KDNA material requires Runtime Core and Studio re-import support.',
      5,
    );
  }
  const { absolute, bytes } = readBoundedFile(materialPath, MATERIAL_LIMIT_BYTES);
  consumeMaterialBudget(budget, bytes.length);
  if (path.extname(absolute).toLowerCase() !== '.kdna') {
    throw new CreationCliError(
      'material_invalid',
      'KDNA material must be a packaged .kdna file.',
    );
  }
  // Every trust decision below is bound to the one bounded read above.
  // Runtime Core accepts Buffer input, so the path can no longer diverge
  // between the recorded digest, validation, inspection, and authorized load.
  const validation = deps.runtimeCore.validate(bytes);
  if (validation.overall_valid !== true) {
    throw new CreationCliError(
      'material_kdna_invalid',
      'The KDNA material does not satisfy the current Runtime contract.',
    );
  }
  const inspection = deps.runtimeCore.inspect(bytes);
  if (!inspection) {
    throw new CreationCliError(
      'material_kdna_invalid',
      'The KDNA material could not be inspected.',
    );
  }
  const loadPlan = deps.runtimeCore.planLoad(
    bytes,
    password ? { password } : {},
  );
  const authorizationRequired = Boolean(
    loadPlan.state === 'needs_password' &&
    Array.isArray(loadPlan.issues) &&
    loadPlan.issues.some(
      (issue) =>
        issue.code === 'KDNA_AUTH_PASSWORD_UNVERIFIED' ||
        issue.code === 'KDNA_AUTH_PASSWORD_REQUIRED',
    ),
  );
  if (authorizationRequired && !password) {
    throw new CreationCliError(
      'material_authorization_required',
      'The protected KDNA material requires --password-stdin.',
      4,
    );
  }
  if (!authorizationRequired && loadPlan.can_load_now !== true) {
    throw new CreationCliError(
      'material_load_blocked',
      'The KDNA material is valid but is not authorized for local loading.',
      4,
    );
  }
  const loadRuntime =
    deps.runtimeCore.loadAuthorized || deps.runtimeCore.load;
  if (typeof loadRuntime !== 'function') {
    throw new CreationCliError(
      'runtime_loader_unavailable',
      'Runtime Core does not provide an authorized KDNA loader.',
      5,
    );
  }
  let capsule;
  try {
    capsule = loadRuntime.call(deps.runtimeCore, bytes, {
      profile: 'full',
      as: 'json',
      password: password || undefined,
      hasPassword: Boolean(password),
    });
  } catch {
    throw new CreationCliError(
      'material_authorization_failed',
      'The KDNA material could not be authorized and loaded.',
      4,
    );
  }
  if (capsule?.type !== 'kdna.runtime-capsule') {
    throw new CreationCliError(
      'material_load_failed',
      'The KDNA material did not load as a full Runtime Capsule.',
      5,
    );
  }
  let imported;
  try {
    imported = deps.reimportCapsule(capsule);
  } catch {
    throw new CreationCliError(
      'material_reimport_failed',
      'Studio could not re-import current judgment semantics from the KDNA material.',
      5,
    );
  }
  const manifest = capsule.context?.manifest || {};
  const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  const sourceId =
    descriptor.id ||
    `source_kdna_${digest.slice('sha256:'.length, 'sha256:'.length + 16)}`;
  const externalConstraints = [
    ...(Array.isArray(descriptor.external_constraints)
      ? descriptor.external_constraints
      : []),
    'Imported as a current Runtime asset for derivation; source trust and current authority remain review decisions.',
  ];
  const material = {
    id: sourceId,
    kind: 'kdna',
    title: descriptor.title || manifest.title || manifest.asset_id || path.basename(absolute),
    content_hash: digest,
    reference:
      descriptor.opaque_reference ||
      manifest.asset_id ||
      path.basename(absolute),
    source_subject_id:
      descriptor.source_subject_id || manifest.asset_uid || manifest.asset_id || null,
    belongs_to_subject: descriptor.belongs_to_subject ?? 'unknown',
    represents_current_judgment:
      descriptor.represents_current_judgment ?? 'unknown',
    authority: descriptor.authority || 'supporting',
    currentness: descriptor.currentness || 'unknown',
    sensitivity: descriptor.sensitivity || 'private',
    external_constraints: externalConstraints,
    in_scope: descriptor.in_scope ?? 'unknown',
    source_created_at:
      descriptor.source_created_at ?? manifest.created_at ?? null,
    source_updated_at:
      descriptor.source_updated_at ?? manifest.updated_at ?? null,
    time_basis:
      descriptor.time_basis ||
      (manifest.created_at || manifest.updated_at
        ? 'asset-manifest'
        : 'unknown'),
  };
  const candidates = descriptor.derive_candidates === false
    ? []
    : (imported.cards || [])
        .map((card, index) => candidateFromImportedCard(card, sourceId, index))
        .filter(Boolean);
  const lineage = {
    type: 'fork',
    parent_asset_id: manifest.asset_id,
    parent_asset_uid: manifest.asset_uid,
    parent_version: manifest.version,
    parent_asset_digest: digest,
  };
  return { material, candidates, lineage };
}

function materialDescriptors(
  input,
  args,
  deps,
  password,
  totalLimit = MATERIAL_TOTAL_LIMIT_BYTES,
) {
  const supplied = [];
  for (const value of Array.isArray(input.materials) ? input.materials : []) {
    const materialPath =
      typeof value === 'string' ? value : value?.path;
    if (materialPath) {
      let directoryInput = false;
      try {
        directoryInput = fs.lstatSync(path.resolve(materialPath)).isDirectory();
      } catch {
        // collectMaterialFiles emits the stable unavailable-material error.
      }
      const files = collectMaterialFiles([materialPath]);
      for (const file of files) {
        const base =
          typeof value === 'string'
            ? {}
            : { ...value };
        supplied.push(
          directoryInput
            ? {
                ...base,
                path: file,
                external_constraints: [
                  ...(Array.isArray(base.external_constraints)
                    ? base.external_constraints
                    : []),
                  'Directory ingestion preserves migration provenance and does not establish current authority.',
                ],
              }
            : { ...base, path: file },
        );
      }
    } else {
      supplied.push(value);
    }
  }
  for (const materialPath of allValueOptions(args, '--material')) {
    let directoryInput = false;
    try {
      directoryInput = fs.lstatSync(path.resolve(materialPath)).isDirectory();
    } catch {
      // collectMaterialFiles emits the stable unavailable-material error.
    }
    for (const file of collectMaterialFiles([materialPath])) {
      supplied.push({
        path: file,
        ...(directoryInput
          ? {
              external_constraints: [
                'Directory ingestion preserves migration provenance and does not establish current authority.',
              ],
            }
          : {}),
      });
    }
  }
  for (const value of asList(input.from_kdna)) {
    supplied.push(
      typeof value === 'string'
        ? { path: value, derive_candidates: true }
        : { ...value, derive_candidates: value.derive_candidates !== false },
    );
  }
  if (supplied.length > MATERIAL_FILE_LIMIT) {
    throw new CreationCliError(
      'material_limit_exceeded',
      `A creation operation accepts at most ${MATERIAL_FILE_LIMIT} material files.`,
    );
  }
  const materials = [];
  const candidates = [];
  const lineages = [];
  const budget = { used: 0, maximum: totalLimit };
  for (const descriptor of supplied) {
    const materialPath = descriptor?.path || descriptor?.reference;
    if (
      materialPath &&
      path.extname(String(materialPath)).toLowerCase() === '.kdna'
    ) {
      const current = currentKdnaMaterial(descriptor, deps, password, budget);
      materials.push(current.material);
      candidates.push(...current.candidates);
      lineages.push(current.lineage);
    } else {
      materials.push(descriptorForMaterial(descriptor, budget));
    }
  }
  return { materials, candidates, lineages };
}

function matchingSourceLineage(explicit, derived) {
  if (!explicit || typeof explicit !== 'object') return false;
  return (
    explicit.parent_asset_id === derived.parent_asset_id &&
    explicit.parent_asset_uid === derived.parent_asset_uid &&
    explicit.parent_version === derived.parent_version &&
    explicit.parent_asset_digest === derived.parent_asset_digest
  );
}

function creationLineage(explicit, derivedLineages) {
  if (derivedLineages.length === 0) return explicit || undefined;
  if (!explicit) {
    if (derivedLineages.length > 1) {
      throw new CreationCliError(
        'primary_lineage_required',
        'Creating from multiple KDNA assets requires one explicit matching lineage.',
      );
    }
    return derivedLineages[0];
  }
  const matches = derivedLineages.filter((derived) =>
    matchingSourceLineage(explicit, derived));
  if (matches.length !== 1) {
    throw new CreationCliError(
      'lineage_mismatch',
      'The explicit lineage must exactly match one authorized KDNA source asset.',
    );
  }
  return explicit;
}

function asList(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function inputBindsUserAcceptance(input) {
  return (
    asList(input.confirmations).length > 0 ||
    Boolean(input.test_plan) ||
    Boolean(input.export_plan) ||
    asList(input.test_results).some((result) => Boolean(result?.acceptance))
  );
}

function assertExportPlanUpdateIsIsolated(input) {
  if (!input.export_plan) return;
  const allowedInputFields = new Set([
    'operation_id',
    'expected_revision',
    'export_plan',
  ]);
  const mixedFields = Object.keys(input).filter(
    (field) => !allowedInputFields.has(field),
  );
  if (mixedFields.length > 0) {
    throw new CreationCliError(
      'export_plan_update_mixed',
      'A private export-plan update must be the only workspace change in one resume operation.',
    );
  }
  if (
    typeof input.export_plan !== 'object' ||
    input.export_plan === null ||
    Array.isArray(input.export_plan) ||
    Object.keys(input.export_plan).length !== 1 ||
    !Object.hasOwn(input.export_plan, 'version')
  ) {
    throw new CreationCliError(
      'export_plan_update_invalid',
      'A resume export-plan update accepts only one distributed version.',
    );
  }
}

function assertExpectedRevision(workspace, input) {
  if (!inputBindsUserAcceptance(input)) return;
  if (!Number.isInteger(input.expected_revision)) {
    throw new CreationCliError(
      'expected_revision_required',
      'Confirmation, acceptance, plan freezing, and export-plan input must include the expected_revision returned by status.',
    );
  }
  if (input.expected_revision !== workspace.state?.semantic_revision) {
    throw new CreationCliError(
      'revision_conflict',
      'The creation workspace changed after review. Run status and review the current revision before confirming.',
      4,
    );
  }
}

function assertConsentRevisionCurrent(workspace, input) {
  if (input.expected_revision !== workspace.state?.semantic_revision) {
    throw new CreationCliError(
      'revision_conflict',
      'The creation workspace changed after review. Run status and review the current revision before confirming.',
      4,
    );
  }
}

function assertTestAcceptanceIsFinal(input) {
  const results = asList(input.test_results);
  const acceptanceIndexes = results
    .map((result, index) => (result?.acceptance ? index : -1))
    .filter((index) => index >= 0);
  if (
    acceptanceIndexes.length > 1 ||
    (acceptanceIndexes.length === 1 &&
      acceptanceIndexes[0] !== results.length - 1)
  ) {
    throw new CreationCliError(
      'test_acceptance_order_invalid',
      'Semantic-test acceptance must appear once, on the final submitted evaluation.',
    );
  }
}

function applyWorkspaceInput(
  engine,
  initialWorkspace,
  input,
  args,
  deps,
  materialPassword,
  preparedMaterials = null,
) {
  let workspace = initialWorkspace;
  assertExportPlanUpdateIsIsolated(input);
  assertExpectedRevision(initialWorkspace, input);
  assertTestAcceptanceIsFinal(input);
  if (input.export_plan) {
    workspace = engine.updateExportPlan(workspace, input.export_plan);
  }
  if (input.purpose) workspace = engine.setPurpose(workspace, input.purpose);
  const described =
    preparedMaterials ||
    materialDescriptors(input, args, deps, materialPassword);
  for (const material of described.materials) {
    workspace = engine.ingestMaterial(workspace, material);
  }
  for (const candidate of [
    ...asList(input.candidates),
    ...described.candidates,
  ]) {
    workspace = engine.addCandidate(workspace, candidate);
  }
  for (const answer of asList(input.interview_answers || input.interview_answer)) {
    workspace = engine.recordInterviewAnswer(workspace, answer);
  }
  if (
    input.relations ||
    input.split_recommendations ||
    input.resolve_conflicts ||
    input.relation_decisions
  ) {
    workspace = engine.analyzeRelations(workspace, {
      relations: input.relations || [],
      split_recommendations: input.split_recommendations || [],
      resolve_conflicts: input.resolve_conflicts || [],
      relation_decisions: input.relation_decisions || [],
    });
  }
  for (const confirmation of asList(input.confirmations)) {
    // A purpose, candidate, relation, or promotion earlier in this same
    // request changes the semantic revision. The pre-edit token must never
    // authorize consent over those unseen semantics.
    assertConsentRevisionCurrent(workspace, input);
    workspace = engine.recordConfirmation(workspace, confirmation);
  }
  for (const testCase of asList(input.tests)) {
    workspace = engine.addSemanticTest(workspace, testCase);
  }
  for (const result of asList(input.test_results)) {
    const testId = result.test_id || result.id;
    if (!testId) {
      throw new CreationCliError('input_invalid', 'A semantic test result requires test_id.');
    }
    const details = { ...result };
    delete details.test_id;
    delete details.id;
    if (details.acceptance) {
      assertConsentRevisionCurrent(workspace, input);
    }
    workspace = engine.recordSemanticTestResult(workspace, testId, details);
  }
  return workspace;
}

function plainConfidence(confidence) {
  if (typeof confidence === 'string') return confidence;
  return confidence?.status || 'unknown';
}

function creationLanguage(value) {
  return String(value || '')
    .replace(/semantic digest/gi, 'current judgment revision')
    .replace(/workspace schema/gi, 'workspace contract');
}

function publicReadinessItems(items) {
  return (items || []).map((item) => {
    if (!item || typeof item !== 'object') return creationLanguage(item);
    return {
      ...(item.code ? { code: item.code } : {}),
      message: creationLanguage(item.message),
      ...(item.target_id ? { target_id: item.target_id } : {}),
    };
  });
}

function workspaceSummary(engine, workspace) {
  const readiness = engine.assessReadiness(workspace);
  const action = engine.nextAction(workspace);
  const completionGates = readiness.completion_gates || {
    format_valid: false,
    judgment_accepted: readiness.creation_accepted === true,
    application_verified: false,
    creation_complete: false,
    semantic_digest: workspace.state?.semantic_digest || null,
    asset_digest: null,
    application_plan_id: null,
    application_attempt_id: null,
    application_observation_id: null,
    application_receipt_id: null,
    application_failure_class: null,
  };
  const purpose = workspace.purposeBrief
    ? {
        title: workspace.purposeBrief.title || null,
        objective: workspace.purposeBrief.objective,
        scope: workspace.purposeBrief.scope,
        non_goals: workspace.purposeBrief.non_goals,
        loading_condition: workspace.purposeBrief.loading_condition,
        highest_question: workspace.purposeBrief.highest_question,
        represented_subject: workspace.purposeBrief.represented_subject || null,
      }
    : null;
  return {
    document_type: 'kdna.creation-command-result',
    contract_version: '0.1.0',
    workspace: {
      path: workspace.root,
      mode: workspace.state?.mode,
      workflow_mode: workspace.state?.workflow_mode,
      state: workspace.state?.status,
      revision: workspace.state?.semantic_revision,
    },
    purpose,
    materials: (workspace.materials || []).map((material) => ({
      id: material.id,
      title: material.title,
      kind: material.kind,
      authority: material.authority,
      currentness: material.currentness,
      sensitivity: material.sensitivity,
      in_scope: material.in_scope,
      content_hash: material.content_hash,
      source_subject_id: material.source_subject_id,
      belongs_to_subject: material.belongs_to_subject,
      represents_current_judgment: material.represents_current_judgment,
      external_constraints: material.external_constraints,
      split_domain: material.split_domain,
      expired: material.expired,
      review_receipts: material.review_receipts || [],
    })),
    judgments: [
      ...(workspace.candidates || [])
        .filter((candidate) => candidate.status !== 'promoted')
        .map((candidate) => ({
          id: candidate.id,
          statement: candidate.statement,
          rationale: candidate.rationale,
          applies_when: candidate.applies_when,
          does_not_apply_when: candidate.does_not_apply_when,
          misuse_risk: candidate.misuse_risk,
          contrary_evidence: candidate.contrary_evidence,
          source_refs: candidate.source_refs,
          agent_inference: candidate.agent_inference,
          confidence: plainConfidence(candidate.confidence),
          confirmation_state: candidate.confirmation_state,
          review_state: candidate.status,
        })),
      ...(workspace.judgmentModel?.units || []).map((unit) => ({
        id: unit.id,
        candidate_id: unit.candidate_id,
        statement: unit.statement,
        rationale: unit.rationale,
        applies_when: unit.applies_when,
        does_not_apply_when: unit.does_not_apply_when,
        misuse_risk: unit.misuse_risk,
        contrary_evidence: unit.contrary_evidence,
        source_refs: unit.source_refs,
        agent_inference: unit.agent_inference,
        confidence: plainConfidence(unit.confidence),
        confirmation_state: unit.confirmation_state,
        review_state: 'promoted',
      })),
    ],
    candidate_reviews: (workspace.candidates || [])
      .filter((candidate) => candidate.review_receipt)
      .map((candidate) => candidate.review_receipt),
    boundaries: workspace.judgmentModel?.global_boundaries || [],
    relations: (workspace.judgmentModel?.relations || []).map((relation) => ({
      id: relation.id,
      from: relation.from,
      to: relation.to,
      type: relation.type,
      rationale: relation.rationale,
      status: relation.status,
      resolution: relation.resolution,
    })),
    split_recommendations:
      workspace.judgmentModel?.split_recommendations || [],
    examples: (workspace.semanticTestReport?.cases || []).map((testCase) => ({
      id: testCase.id,
      kind: testCase.kind,
      input: testCase.input,
      expected: testCase.expected,
      expected_creator_label: testCase.expected_creator_label,
      observed_creator_label: testCase.observed_creator_label,
      status: testCase.status,
      result: testCase.result || null,
      evaluated_by: testCase.evaluated_by,
    })),
    test_plans: (workspace.semanticTestReport?.plans || []).map((plan) => ({
      id: plan.id,
      status: plan.status,
      actor: plan.actor,
      semantic_revision: plan.semantic_revision,
      semantic_digest: plan.semantic_digest,
      definition_digest: plan.definition_digest,
      test_ids: plan.test_ids,
      frozen_at: plan.frozen_at,
    })),
    application_plans: (workspace.applicationVerification?.plans || []).map(
      (plan) => ({
        id: plan.id,
        status: plan.status,
        frozen_by: plan.frozen_by,
        semantic_revision: plan.semantic_revision,
        semantic_digest: plan.semantic_digest,
        judgment_evidence_digest: plan.judgment_evidence_digest,
        plan_digest: plan.plan_digest,
        task_count: plan.tasks.length,
        consumer_fingerprint: plan.consumer_identity.fingerprint,
        evaluator_fingerprint: plan.evaluator_identity.fingerprint,
        thresholds: plan.thresholds,
        frozen_at: plan.frozen_at,
      }),
    ),
    application_attempts:
      (workspace.applicationVerification?.attempts || []).map((attempt) => ({
        id: attempt.id,
        status: attempt.status,
        requested_by: attempt.requested_by,
        plan_id: attempt.plan_id,
        plan_digest: attempt.plan_digest,
        attempt_digest: attempt.attempt_digest,
        challenge_digest: attempt.challenge_digest,
        semantic_revision: attempt.semantic_revision,
        semantic_digest: attempt.semantic_digest,
        judgment_evidence_digest: attempt.judgment_evidence_digest,
        build_receipt_digest: attempt.build_receipt_digest,
        asset_digest: attempt.asset_digest,
        asset_load_receipt_digest: attempt.asset_load_receipt_digest,
        authorization_outcome:
          attempt.asset_load_receipt.authorization_outcome,
        issued_at: attempt.issued_at,
        consumed_at: attempt.consumed_at,
        receipt_id: attempt.receipt_id,
        invalidated_at: attempt.invalidated_at,
        abandonment_id: attempt.abandonment_id || null,
      })),
    application_observations:
      (workspace.applicationVerification?.observations || []).map(
        (observation) => ({
          id: observation.id,
          status: observation.status,
          observed_by: observation.observed_by,
          attempt_id: observation.attempt_id,
          attempt_digest: observation.attempt_digest,
          challenge_digest: observation.challenge_digest,
          plan_id: observation.plan_id,
          plan_digest: observation.plan_digest,
          observation_digest: observation.observation_digest,
          semantic_revision: observation.semantic_revision,
          semantic_digest: observation.semantic_digest,
          judgment_evidence_digest:
            observation.judgment_evidence_digest,
          build_receipt_digest: observation.build_receipt_digest,
          asset_digest: observation.asset_digest,
          consumer_run_digest: observation.consumer_run_digest,
          runner_digest: observation.runner_digest,
          asset_load_receipt_digest:
            observation.asset_load_receipt_digest,
          authorization_outcome:
            observation.asset_load_receipt.authorization_outcome,
          observed_at: observation.observed_at,
          consumed_at: observation.consumed_at,
          receipt_id: observation.receipt_id,
          invalidated_at: observation.invalidated_at,
          abandonment_id: observation.abandonment_id || null,
        }),
      ),
    application_abandonments:
      (workspace.applicationVerification?.abandonments || []).map(
        (abandonment) => ({
          id: abandonment.id,
          abandoned_by: abandonment.abandoned_by,
          plan_id: abandonment.plan_id,
          plan_digest: abandonment.plan_digest,
          semantic_revision: abandonment.semantic_revision,
          semantic_digest: abandonment.semantic_digest,
          judgment_evidence_digest:
            abandonment.judgment_evidence_digest,
          build_receipt_digest: abandonment.build_receipt_digest,
          asset_digest: abandonment.asset_digest,
          attempt_id: abandonment.attempt_id,
          attempt_digest: abandonment.attempt_digest,
          challenge_digest: abandonment.challenge_digest,
          observation_id: abandonment.observation_id,
          observation_digest: abandonment.observation_digest,
          consumer_run_digest: abandonment.consumer_run_digest,
          runner_digest: abandonment.runner_digest,
          reason_code: abandonment.reason_code,
          reason: abandonment.reason,
          runner_failure_evidence_digest:
            abandonment.runner_failure_evidence_digest,
          abandonment_digest: abandonment.abandonment_digest,
          abandoned_at: abandonment.abandoned_at,
        }),
      ),
    application_receipts:
      (workspace.applicationVerification?.receipts || []).map((receipt) => ({
        id: receipt.id,
        attempt_id: receipt.attempt_id,
        attempt_digest: receipt.attempt_digest,
        challenge_digest: receipt.challenge_digest,
        plan_id: receipt.plan_id,
        plan_digest: receipt.plan_digest,
        semantic_revision: receipt.semantic_revision,
        semantic_digest: receipt.semantic_digest,
        judgment_evidence_digest: receipt.judgment_evidence_digest,
        build_receipt_digest: receipt.build_receipt_digest,
        asset_digest: receipt.asset_digest,
        asset_load_receipt_digest: receipt.asset_load_receipt_digest,
        consumer_asset_observation_id:
          receipt.consumer_asset_observation_id,
        consumer_asset_observation_digest:
          receipt.consumer_asset_observation_digest,
        consumer_asset_load_receipt_digest:
          receipt.consumer_asset_load_receipt_digest,
        consumer: receipt.consumer,
        evaluated_by: receipt.evaluated_by,
        consumer_run_digest: receipt.consumer_run_digest,
        runner_digest: receipt.runner_digest,
        evaluator_run_digest: receipt.evaluator_run_digest,
        evaluator_runner_digest: receipt.evaluator_runner_digest,
        consumer_execution_digest: receipt.consumer_execution_digest,
        metrics: receipt.metrics,
        status: receipt.status,
        failure_class: receipt.failure_class,
        recorded_at: receipt.recorded_at,
      })),
    interview_answers: (workspace.interviewAnswers || []).map((answer) => ({
      id: answer.id,
      question_id: answer.question_id,
      question: answer.question,
      answer: answer.answer,
      by: answer.by,
      source_refs: answer.source_refs,
      recorded_at: answer.recorded_at,
    })),
    incomplete_operations: (workspace.operations || [])
      .filter((operation) => operation.status !== 'completed')
      .map((operation) => ({
        operation_id: operation.operation_id,
        command: operation.command,
        status: operation.status,
        request_digest: operation.request_digest,
        before: operation.before,
        recovery_target: operation.output_reference
          ? {
              base: 'workspace-parent',
              relative_path: operation.output_reference,
              output_filename: operation.output_filename,
              candidate_filename: operation.candidate_filename,
              backup_filename: operation.backup_filename,
            }
          : null,
        asset_digest: operation.asset_digest,
        updated_at: operation.updated_at,
      })),
    confirmations: (workspace.confirmationReceipts || []).map((receipt) => ({
      id: receipt.id,
      actor: receipt.actor,
      subject: receipt.subject,
      scope: receipt.scope,
      accepted: receipt.accepted,
    })),
    readiness: {
      compile_ready: readiness.compile_ready,
      format_ready: readiness.format_ready,
      creation_accepted: readiness.creation_accepted,
      completion_gates: completionGates,
      blocking: publicReadinessItems(readiness.blocking),
      warnings: (readiness.warnings || []).map(creationLanguage),
    },
    next_action: {
      action: action.action,
      state: action.state,
      reason: creationLanguage(action.reason),
      requires_user: action.requires_user,
      unresolved_ids: action.unresolved_ids || [],
    },
  };
}

function humanLines(result) {
  const lines = [
    `Creation workspace: ${result.workspace.path}`,
    `State: ${result.workspace.state}`,
    `Mode: ${result.workspace.mode}`,
    `Workflow: ${result.workspace.workflow_mode}`,
  ];
  if (result.purpose) {
    lines.push(`Purpose: ${result.purpose.objective}`);
    lines.push(`Scope: ${result.purpose.scope}`);
  }
  lines.push(`Materials: ${result.materials.length}`);
  lines.push(`Judgments: ${result.judgments.length}`);
  lines.push(`Boundaries: ${result.boundaries.length}`);
  lines.push(`Examples: ${result.examples.length}`);
  lines.push(`Interview answers: ${result.interview_answers.length}`);
  lines.push(`Incomplete operations: ${result.incomplete_operations.length}`);
  lines.push(`Confirmations: ${result.confirmations.length}`);
  lines.push(
    `Judgment accepted: ${result.readiness.completion_gates.judgment_accepted === true ? 'yes' : 'not yet'}`,
  );
  lines.push(
    `Format valid: ${result.readiness.completion_gates.format_valid === true ? 'yes' : 'not yet'}`,
  );
  lines.push(
    `Application verified: ${result.readiness.completion_gates.application_verified === true ? 'yes' : 'not yet'}`,
  );
  lines.push(
    `Creation complete: ${result.readiness.completion_gates.creation_complete === true ? 'yes' : 'not yet'}`,
  );
  if (result.next_action.reason) lines.push(`Next: ${result.next_action.reason}`);
  return lines;
}

function writeResult(result, useJson) {
  if (useJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${humanLines(result).join('\n')}\n`);
}

function writeFailure(error, useJson) {
  const operationConflict =
    !(error instanceof CreationCliError) &&
    error?.code === 'CREATION_OPERATION_CONFLICT';
  const safe = {
    document_type: 'kdna.creation-command-error',
    contract_version: '0.1.0',
    error: {
      code:
        error instanceof CreationCliError
          ? error.code
          : (operationConflict ? 'operation_id_conflict' : 'creation_failed'),
      message:
        error instanceof CreationCliError
          ? error.message
          : (
              operationConflict
                ? 'The operation_id was already used for a different request.'
                : 'The Creation Engine could not complete the request.'
            ),
    },
  };
  if (useJson) {
    process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
  } else {
    process.stderr.write(`Error: ${safe.error.message}\n`);
  }
  process.exitCode =
    error instanceof CreationCliError
      ? error.exitCode
      : (operationConflict ? 4 : 5);
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

function candidateRuntimeTreeDigest(runtimeRoot) {
  const entries = [];
  const visit = (relative = '') => {
    const target = relative ? path.join(runtimeRoot, relative) : runtimeRoot;
    const before = fs.lstatSync(target, { bigint: true });
    if (before.isSymbolicLink()) {
      throw new CreationCliError(
        'candidate_runtime_invalid',
        'The WP0 candidate runtime contains a symbolic link.',
        5,
      );
    }
    if ((before.mode & 0o222n) !== 0n) {
      throw new CreationCliError(
        'candidate_runtime_invalid',
        'The WP0 candidate runtime contains a writable entry.',
        5,
      );
    }
    if (before.isDirectory()) {
      entries.push({
        path: relative || '.',
        type: 'directory',
        mode: Number(before.mode & 0o777n),
      });
      for (const name of fs.readdirSync(target).sort()) {
        visit(path.join(relative, name));
      }
      const after = fs.lstatSync(target, { bigint: true });
      if (
        !after.isDirectory() ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      ) {
        throw new CreationCliError(
          'candidate_runtime_invalid',
          'The WP0 candidate runtime changed during tree verification.',
          5,
        );
      }
      return;
    }
    if (!before.isFile()) {
      throw new CreationCliError(
        'candidate_runtime_invalid',
        'The WP0 candidate runtime contains a special file.',
        5,
      );
    }
    const bytes = fs.readFileSync(target);
    const after = fs.lstatSync(target, { bigint: true });
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      throw new CreationCliError(
        'candidate_runtime_invalid',
        'The WP0 candidate runtime changed during tree verification.',
        5,
      );
    }
    entries.push({
      path: relative,
      type: 'file',
      mode: Number(before.mode & 0o777n),
      size: bytes.length,
      sha256: sha256Bytes(bytes),
    });
  };
  visit();
  return sha256Bytes(
    Buffer.from(
      canonical(
        entries.filter(
          (entry) => entry.path !== 'wp0-runtime-receipt.json',
        ),
      ),
      'utf8',
    ),
  );
}

function candidateRuntimeAuthority(packageRoot) {
  const absolutePackageRoot = path.resolve(packageRoot);
  if (path.basename(absolutePackageRoot) !== 'package') return null;
  const receiptPath = path.join(
    path.dirname(absolutePackageRoot),
    'wp0-runtime-receipt.json',
  );
  let receiptBytes;
  try {
    const stat = fs.lstatSync(receiptPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > INPUT_LIMIT_BYTES) {
      throw new Error('not a bounded regular receipt');
    }
    receiptBytes = fs.readFileSync(receiptPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new CreationCliError(
      'candidate_runtime_invalid',
      'The adjacent WP0 candidate runtime receipt is invalid.',
      5,
    );
  }
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString('utf8'));
  } catch {
    throw new CreationCliError(
      'candidate_runtime_invalid',
      'The adjacent WP0 candidate runtime receipt is invalid JSON.',
      5,
    );
  }
  const unsigned = { ...receipt };
  delete unsigned.receipt_sha256;
  const expectedReceiptDigest = sha256Bytes(
    Buffer.from(canonical(unsigned), 'utf8'),
  );
  const baseline = receipt.development_baseline;
  if (
    receipt.schema !== 'aikdna.creation-engine.wp0-candidate-runtime/1.0' ||
    receipt.evidence_class !==
      'IMMUTABLE_WP0_CANDIDATE_ARTIFACT_RUNTIME' ||
    receipt.release_authorized !== false ||
    receipt.receipt_sha256 !== expectedReceiptDigest ||
    !/^sha256:[0-9a-f]{64}$/.test(
      String(receipt.runtime_tree_sha256 || ''),
    ) ||
    !/^sha256:[0-9a-f]{64}$/.test(
      String(baseline?.bom_semantic_digest || ''),
    ) ||
    !/^sha256:[0-9a-f]{64}$/.test(
      String(baseline?.bom_file_digest || ''),
    )
  ) {
    throw new CreationCliError(
      'candidate_runtime_invalid',
      'The adjacent WP0 candidate runtime receipt failed self-validation.',
      5,
    );
  }
  if (
    candidateRuntimeTreeDigest(path.dirname(absolutePackageRoot)) !==
    receipt.runtime_tree_sha256
  ) {
    throw new CreationCliError(
      'candidate_runtime_invalid',
      'The adjacent WP0 candidate runtime tree failed exact verification.',
      5,
    );
  }
  const entrypointPath = path.join(
    absolutePackageRoot,
    'bin',
    'kdna-studio.js',
  );
  let entrypointBytes;
  try {
    const stat = fs.lstatSync(entrypointPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('not a regular entrypoint');
    }
    entrypointBytes = fs.readFileSync(entrypointPath);
  } catch {
    throw new CreationCliError(
      'candidate_runtime_invalid',
      'The WP0 candidate runtime CLI entrypoint is unavailable.',
      5,
    );
  }
  return {
    development_runtime: {
      schema: 'aikdna.creation-build-runtime/0.1.0',
      evidence_class: receipt.evidence_class,
      candidate_runtime_receipt_sha256: receipt.receipt_sha256,
      candidate_runtime_tree_sha256: receipt.runtime_tree_sha256,
      cli_entrypoint_sha256: sha256Bytes(entrypointBytes),
      bom_semantic_digest: baseline.bom_semantic_digest,
      bom_file_digest: baseline.bom_file_digest,
    },
    development_baseline: JSON.parse(JSON.stringify(baseline)),
  };
}

function candidateRuntimeCoordinate(packageRoot) {
  return candidateRuntimeAuthority(packageRoot)?.development_runtime || null;
}

function resolveDevelopmentBaseline(deps, requestedBaseline = null) {
  const runtime = deps.developmentRuntime || null;
  const boundBaseline = deps.developmentBaseline || null;
  if (runtime && !boundBaseline) {
    throw new CreationCliError(
      'candidate_runtime_invalid',
      'The WP0 candidate runtime does not provide its exact development baseline.',
      5,
    );
  }
  if (boundBaseline) {
    if (
      requestedBaseline &&
      canonical(requestedBaseline) !== canonical(boundBaseline)
    ) {
      throw new CreationCliError(
        'candidate_runtime_invalid',
        'The requested development baseline does not match the adjacent WP0 candidate runtime receipt.',
        5,
      );
    }
    return JSON.parse(JSON.stringify(boundBaseline));
  }
  if (requestedBaseline) {
    throw new CreationCliError(
      'candidate_runtime_invalid',
      'A caller-supplied development baseline cannot establish candidate evidence without an adjacent immutable WP0 runtime receipt.',
      5,
    );
  }
  return null;
}

function operationIdOption(input, args) {
  const fromInput =
    typeof input.operation_id === 'string'
      ? input.operation_id.trim()
      : '';
  const fromArgv = valueOption(args, '--operation-id', '');
  if (fromInput && fromArgv && fromInput !== fromArgv) {
    throw new CreationCliError(
      'operation_id_conflict',
      'JSON operation_id and --operation-id must match.',
      4,
    );
  }
  const selected = fromInput || fromArgv;
  if (
    selected &&
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(selected)
  ) {
    throw new CreationCliError(
      'input_invalid',
      'operation_id must contain 1-128 safe identifier characters.',
    );
  }
  return selected || null;
}

function operationPayload(input) {
  const payload = JSON.parse(JSON.stringify(input || {}));
  delete payload.operation_id;
  return payload;
}

function operationMaterialSnapshot(prepared) {
  if (!prepared) return { materials: [], candidates: [], lineages: [] };
  return {
    materials: prepared.materials.map((material) => {
      const snapshot = { ...material };
      delete snapshot.bytes;
      delete snapshot.content;
      delete snapshot.reference;
      return snapshot;
    }),
    candidates: prepared.candidates,
    lineages: prepared.lineages,
  };
}

function creationOperationRequest(
  engine,
  command,
  workspaceIdentity,
  input,
  args,
  prepared,
  extra = {},
) {
  const developmentRuntime = extra.development_runtime || null;
  const ioEffects = { ...extra };
  delete ioEffects.development_runtime;
  const requestDigest = engine.canonicalOperationRequestDigest({
    command,
    workspace: workspaceIdentity,
    payload: operationPayload(input),
    material_snapshots: operationMaterialSnapshot(prepared),
    io_effects: ioEffects,
    development_runtime: developmentRuntime,
  });
  return {
    operation_id:
      operationIdOption(input, args) ||
      `auto:${requestDigest.slice('sha256:'.length, 'sha256:'.length + 32)}`,
    command,
    request_digest: requestDigest,
    development_runtime: developmentRuntime,
  };
}

function replayedExport(engine, workspace, output, receipt) {
  const readiness = engine.assessReadiness(workspace);
  const gates = readiness.completion_gates || {};
  if (
    readiness.creation_accepted !== true ||
    gates.format_valid !== true ||
    workspace.buildReceipt?.asset_digest !== receipt.asset_digest ||
    workspace.buildReceipt?.semantic_revision !==
      workspace.state.semantic_revision ||
    workspace.buildReceipt?.semantic_digest !== workspace.state.semantic_digest
  ) {
    throw new CreationCliError(
      'operation_id_conflict',
      'The completed export is not the current accepted workspace build.',
      4,
    );
  }
  let bytes;
  try {
    const stat = fs.lstatSync(output);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not regular');
    bytes = fs.readFileSync(output);
  } catch {
    throw new CreationCliError(
      'operation_replay_output_invalid',
      'The completed export output is missing or is no longer the exact regular file.',
      4,
    );
  }
  const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  if (
    digest !== receipt.asset_digest ||
    path.basename(output) !== receipt.output_filename
  ) {
    throw new CreationCliError(
      'operation_replay_output_invalid',
      'The completed export output no longer matches its verified operation receipt.',
      4,
    );
  }
  cleanupCompletedExport(
    path.join(path.dirname(output), receipt.candidate_filename),
    path.join(path.dirname(output), receipt.backup_filename),
    receipt,
  );
  return {
    workspace,
    export: {
      path: output,
      format_valid: gates.format_valid === true,
      judgment_accepted: readiness.creation_accepted === true,
      creation_accepted: true,
      application_verified: gates.application_verified === true,
      creation_complete: gates.creation_complete === true,
      verification: workspace.buildReceipt?.results || {},
    },
  };
}

function semanticCardFields(value) {
  const fields = { ...(value || {}) };
  // Runtime reasoning chains use `logic`/`so_what` as wire aliases for the
  // authored `chain`/`concrete_action` fields. Re-import can therefore carry
  // both names. Ignore only byte-for-byte semantic duplicates; a changed
  // alias remains visible and still fails the round-trip comparison.
  if (
    Array.isArray(fields.chain) &&
    Array.isArray(fields.logic) &&
    canonical(fields.chain) === canonical(fields.logic)
  ) {
    delete fields.logic;
  }
  if (
    typeof fields.concrete_action === 'string' &&
    fields.so_what === fields.concrete_action
  ) {
    delete fields.so_what;
  }
  return fields;
}

function semanticProjectProjection(value) {
  const project = value?.project || value;
  const cards = (project?.cards || value?.cards || [])
    .filter((card) => card.status !== 'deprecated')
    .map((card) => ({
      id: card.id,
      type: card.type,
      fields: semanticCardFields(card.fields),
    }))
    .sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));
  const boundaryFields = cards
    .filter((card) => card.type === 'boundary')
    .map((card) => card.fields || {});
  const target = project?.distillation_target || value?.distillation_target || {};
  const boundaryScopes = Array.from(new Set(
    boundaryFields
      .map((fields) => fields.scope)
      .filter((scope) => typeof scope === 'string' && scope.trim().length > 0),
  ));
  const taskScope =
    target.task_scope ||
    (boundaryScopes.length === 1 ? boundaryScopes[0] : null);
  const includeAreas = Array.isArray(target.include_areas)
    ? target.include_areas
    : boundaryScopes;
  const excludeAreas = Array.isArray(target.exclude_areas)
    ? target.exclude_areas
    : boundaryFields
        .map((fields) => fields.out_of_scope)
        .filter((area) => typeof area === 'string' && area.trim().length > 0);
  const manifest =
    project?.source_manifest ||
    value?.source_manifest ||
    {};
  const creatorInput = project?.author || manifest.creator || null;
  const creator = creatorInput && typeof creatorInput === 'object'
    ? {
        ...(creatorInput.name ? { name: creatorInput.name } : {}),
        ...(creatorInput.id ? { id: creatorInput.id } : {}),
      }
    : null;
  return {
    purpose: {
      task_scope: taskScope,
      include_areas: [...includeAreas].sort(),
      exclude_areas: [...excludeAreas].sort(),
    },
    judgment_core: project?.judgment_core || value?.judgment_core || {},
    relations:
      project?.source_core_structure ||
      project?.source?.core_structure ||
      value?.source_core_structure ||
      [],
    creator,
    lineage: project?.lineage || manifest.lineage || { type: 'original' },
    cards,
  };
}

function writeRuntimeFiles(directory, files) {
  const names = Object.keys(files).sort();
  const expected = ['checksums.json', 'kdna.json', 'mimetype', 'payload.kdnab'];
  if (canonical(names) !== canonical(expected)) {
    throw new CreationCliError(
      'runtime_entries_invalid',
      'The Creation Engine did not produce the required four-entry Runtime asset.',
      5,
    );
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), content, { mode: 0o600 });
  }
}

function assertOutputReplaceable(output, force) {
  if (!fs.existsSync(output)) return;
  const stat = fs.lstatSync(output);
  if (!force) {
    throw new CreationCliError(
      'output_exists',
      'The export target already exists. Use --force to replace that exact regular file.',
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new CreationCliError(
      'output_invalid',
      '--force may replace only the exact existing regular file.',
    );
  }
}

function sameFile(pathname, expected) {
  try {
    const actual = fs.lstatSync(pathname);
    return actual.isFile() &&
      !actual.isSymbolicLink() &&
      actual.dev === expected.dev &&
      actual.ino === expected.ino;
  } catch {
    return false;
  }
}

function fsyncFile(pathname) {
  const descriptor = fs.openSync(pathname, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncParentDirectory(pathname) {
  const descriptor = fs.openSync(path.dirname(pathname), 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function commitVerifiedExport(options) {
  const {
    candidate,
    output,
    force,
    recordReceipt,
    rollbackReceipt,
  } = options;
  assertOutputReplaceable(output, force);
  const existed = fs.existsSync(output);
  const backup = path.join(
    path.dirname(output),
    `.${path.basename(output)}.previous-${process.pid}-${crypto
      .randomBytes(6)
      .toString('hex')}`,
  );
  let oldMoved = false;
  let published = null;
  try {
    if (existed) {
      fs.renameSync(output, backup);
      oldMoved = true;
    }
    try {
      fs.renameSync(candidate, output);
      published = fs.lstatSync(output);
      fsyncFile(output);
      fsyncParentDirectory(output);
    } catch (error) {
      if (published && sameFile(output, published)) fs.unlinkSync(output);
      if (oldMoved && !fs.existsSync(output) && fs.existsSync(backup)) {
        fs.renameSync(backup, output);
        oldMoved = false;
      }
      fsyncParentDirectory(output);
      throw new CreationCliError(
        'output_publish_failed',
        'The verified Runtime asset could not be installed at the requested output.',
        5,
      );
    }

    try {
      const saved = recordReceipt();
      if (oldMoved && fs.existsSync(backup)) {
        fs.unlinkSync(backup);
        oldMoved = false;
        fsyncParentDirectory(output);
      }
      return saved;
    } catch (error) {
      // Remove only the exact inode this function installed. A concurrent
      // replacement is never deleted as part of rollback.
      if (published && sameFile(output, published)) fs.unlinkSync(output);
      if (oldMoved && !fs.existsSync(output) && fs.existsSync(backup)) {
        fs.renameSync(backup, output);
        oldMoved = false;
      }
      if (fs.existsSync(output)) fsyncFile(output);
      fsyncParentDirectory(output);
      try {
        if (typeof rollbackReceipt === 'function') rollbackReceipt();
      } catch {
        throw new CreationCliError(
          'export_transaction_rollback_failed',
          'Export receipt persistence failed and the prior workspace could not be restored.',
          5,
        );
      }
      throw error;
    }
  } finally {
    // A retained backup means restoration could not be completed safely.
    // Never erase the caller's previous output in that state.
    if (!oldMoved && fs.existsSync(backup)) fs.unlinkSync(backup);
  }
}

function sha256Bytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function readRecoverySnapshot(pathname, label, allowMissing = true) {
  let stat;
  try {
    stat = fs.lstatSync(pathname);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw new CreationCliError(
      'export_recovery_invalid',
      `${label} is missing from the recorded export recovery transaction.`,
      5,
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new CreationCliError(
      'export_recovery_invalid',
      `${label} must be the exact recorded regular file.`,
      5,
    );
  }
  return readBoundedFile(pathname, MATERIAL_LIMIT_BYTES).bytes;
}

function digestOrNull(bytes) {
  return bytes === null ? null : sha256Bytes(bytes);
}

function writeDurableSnapshot(pathname, bytes) {
  let descriptor;
  try {
    descriptor = fs.openSync(pathname, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } catch (error) {
    throw new CreationCliError(
      'export_recovery_invalid',
      'The durable export candidate could not be created exclusively.',
      5,
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  fsyncParentDirectory(pathname);
}

function exportRecoveryNames(output, operationRequest) {
  const token = crypto
    .createHash('sha256')
    .update(`${operationRequest.operation_id}\0${operationRequest.request_digest}`)
    .digest('hex')
    .slice(0, 24);
  const basename = path.basename(output);
  return {
    candidate: `.${basename}.creation-${token}.candidate`,
    backup: `.${basename}.creation-${token}.previous`,
  };
}

function maybeInjectExportCrash(phase) {
  if (
    process.env.NODE_ENV === 'test' &&
    process.env.KDNA_TEST_EXPORT_SIGKILL_PHASE === phase
  ) {
    process.kill(process.pid, 'SIGKILL');
  }
}

function generatePackedRuntimeSnapshot(compiled, password, output, deps) {
  const temporary = fs.mkdtempSync(
    path.join(path.dirname(output), '.kdna-export-build-'),
  );
  fs.chmodSync(temporary, 0o700);
  try {
    const finalAsset = deps.exportRuntime.exportRuntimeAsset(compiled.project, {
      password: password || undefined,
    });
    const finalDirectory = path.join(temporary, 'runtime');
    const packed = path.join(temporary, 'candidate.kdna');
    writeRuntimeFiles(finalDirectory, finalAsset.files);
    deps.runtimeCore.pack(finalDirectory, packed);
    return readBoundedFile(packed, MATERIAL_LIMIT_BYTES).bytes;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function verifyRuntimeSnapshot(candidateBytes, compiled, password, deps) {
  const validation = deps.runtimeCore.validate(candidateBytes);
  if (validation.overall_valid !== true) {
    throw new CreationCliError(
      'runtime_validation_failed',
      'The exported Runtime asset failed Core validation.',
      5,
    );
  }
  const inspection = deps.runtimeCore.inspect(candidateBytes);
  if (!inspection) {
    throw new CreationCliError(
      'runtime_inspection_failed',
      'The exported Runtime asset could not be inspected.',
      5,
    );
  }
  if (
    inspection.version !== compiled.project.release?.version ||
    inspection.judgment_version !==
      compiled.project.release?.judgment_version
  ) {
    throw new CreationCliError(
      'runtime_release_coordinate_mismatch',
      'The exact Runtime asset does not match the current distributed and judgment versions.',
      5,
    );
  }
  const loadPlan = deps.runtimeCore.planLoad(
    candidateBytes,
    password ? { password } : {},
  );
  const expectedAuthorizationPlan = Boolean(
    password &&
    loadPlan.can_load_now === false &&
    loadPlan.state === 'needs_password' &&
    Array.isArray(loadPlan.issues) &&
    loadPlan.issues.some(
      (issue) => issue.code === 'KDNA_AUTH_PASSWORD_UNVERIFIED',
    ),
  );
  if (
    (!password && loadPlan.can_load_now !== true) ||
    (password && !expectedAuthorizationPlan)
  ) {
    throw new CreationCliError(
      'runtime_plan_blocked',
      password
        ? 'The protected Runtime asset did not return the expected authorization-required load plan.'
        : 'The exported Runtime asset is not ready to load.',
      5,
    );
  }
  const loadRuntime = deps.runtimeCore.loadAuthorized || deps.runtimeCore.load;
  if (typeof loadRuntime !== 'function') {
    throw new CreationCliError(
      'runtime_loader_unavailable',
      'The installed Runtime Core does not provide an authorized loader.',
      5,
    );
  }
  const compact = loadRuntime.call(deps.runtimeCore, candidateBytes, {
    profile: 'compact',
    as: 'json',
    password: password || undefined,
    hasPassword: Boolean(password),
  });
  const full = loadRuntime.call(deps.runtimeCore, candidateBytes, {
    profile: 'full',
    as: 'json',
    password: password || undefined,
    hasPassword: Boolean(password),
  });
  if (
    compact?.type !== 'kdna.runtime-capsule' ||
    full?.type !== 'kdna.runtime-capsule'
  ) {
    throw new CreationCliError(
      'runtime_load_failed',
      'The exported Runtime asset did not load as compact and full Runtime Capsules.',
      5,
    );
  }
  const reimported = deps.reimportCapsule(full);
  const expectedSemantics = semanticProjectProjection(compiled.project);
  const actualSemantics = semanticProjectProjection(reimported);
  if (canonical(expectedSemantics) !== canonical(actualSemantics)) {
    throw new CreationCliError(
      'semantic_round_trip_failed',
      'Runtime re-import changed authored judgment semantics.',
      5,
    );
  }
  return {
    artifactSha256: sha256Bytes(candidateBytes),
    results: {
      validate: { status: 'pass' },
      inspect: { status: 'pass' },
      plan_load: {
        status: 'pass',
        outcome: expectedAuthorizationPlan
          ? 'authorization_required_then_verified'
          : 'loadable_now',
        state: loadPlan.state,
        can_load_now: loadPlan.can_load_now === true,
        authorization_supplied: Boolean(password),
        issue_codes: Array.isArray(loadPlan.issues)
          ? loadPlan.issues.map((issue) => issue.code).filter(Boolean)
          : [],
      },
      load_compact: {
        status: 'pass',
        authorized: Boolean(password),
      },
      load_full: {
        status: 'pass',
        authorized: Boolean(password),
      },
      reimport: { status: 'pass' },
      semantic_round_trip: { status: 'pass' },
    },
  };
}

function creationBuildReceipt(
  workspace,
  output,
  verification,
  deps,
  developmentBaseline = null,
) {
  return {
    document_type: 'kdna.creation-build-receipt',
    contract_version: '0.1.0',
    created_at: new Date().toISOString(),
    version: workspace.exportPlan.version,
    judgment_version: workspace.exportPlan.judgment_version,
    asset_digest: verification.artifactSha256,
    semantic_revision: workspace.state?.semantic_revision,
    semantic_digest: workspace.state?.semantic_digest,
    output: {
      filename: path.basename(output),
      artifact_sha256: verification.artifactSha256,
    },
    tool_coordinates: {
      studio_cli: deps.cliVersion,
      studio_core: deps.studioCoreVersion,
      core: deps.runtimeCoreVersion,
    },
    ...(developmentBaseline
      ? { development_baseline: developmentBaseline }
      : {}),
    ...(deps.developmentRuntime
      ? { development_runtime: deps.developmentRuntime }
      : {}),
    results: verification.results,
  };
}

function assertExportOperationCurrent(engine, workspace, receipt) {
  const currentCoordinate = engine.operationCoordinate(workspace);
  if (
    receipt.before.semantic_revision !== workspace.state.semantic_revision ||
    receipt.before.semantic_digest !== workspace.state.semantic_digest ||
    receipt.before.export_plan_digest !==
      currentCoordinate.export_plan_digest
  ) {
    throw new CreationCliError(
      'operation_id_conflict',
      'The interrupted export no longer applies to the current workspace semantics or export plan.',
      4,
    );
  }
}

function assertPreparedRecoveryLayout(output, candidate, backup, receipt) {
  const outputDigest = digestOrNull(
    readRecoverySnapshot(output, 'export output', true),
  );
  const backupDigest = digestOrNull(
    readRecoverySnapshot(backup, 'export backup', true),
  );
  if (
    backupDigest !== null ||
    outputDigest !== receipt.prior_output_digest
  ) {
    throw new CreationCliError(
      'export_recovery_invalid',
      'The prepared export output no longer matches its recorded prior state.',
      5,
    );
  }
  const candidateBytes = readRecoverySnapshot(
    candidate,
    'durable export candidate',
    true,
  );
  return candidateBytes;
}

function publishVerifiedRecovery(output, candidate, backup, receipt) {
  const outputBytes = readRecoverySnapshot(output, 'export output', true);
  const candidateBytes = readRecoverySnapshot(
    candidate,
    'durable export candidate',
    true,
  );
  const backupBytes = readRecoverySnapshot(backup, 'export backup', true);
  const outputDigest = digestOrNull(outputBytes);
  const candidateDigest = digestOrNull(candidateBytes);
  const backupDigest = digestOrNull(backupBytes);
  if (outputDigest === receipt.asset_digest) {
    if (
      candidateDigest !== null ||
      backupDigest !== receipt.prior_output_digest
    ) {
      throw new CreationCliError(
        'export_recovery_invalid',
        'The published export is accompanied by an unexpected recovery file.',
        5,
      );
    }
    return outputBytes;
  }
  if (candidateDigest !== receipt.asset_digest) {
    throw new CreationCliError(
      'export_recovery_invalid',
      'Neither the output nor durable candidate matches the verified asset.',
      5,
    );
  }
  if (receipt.prior_output_digest === null) {
    if (outputDigest !== null || backupDigest !== null) {
      throw new CreationCliError(
        'export_recovery_invalid',
        'A new export target changed after the transaction was prepared.',
        5,
      );
    }
  } else if (
    outputDigest === receipt.prior_output_digest &&
    backupDigest === null
  ) {
    fs.renameSync(output, backup);
    fsyncParentDirectory(output);
    maybeInjectExportCrash('after-backup');
  } else if (
    outputDigest !== null ||
    backupDigest !== receipt.prior_output_digest
  ) {
    throw new CreationCliError(
      'export_recovery_invalid',
      'The replace transaction no longer matches its recorded prior output.',
      5,
    );
  }
  fs.renameSync(candidate, output);
  fsyncFile(output);
  fsyncParentDirectory(output);
  maybeInjectExportCrash('after-publish');
  return readRecoverySnapshot(output, 'published export output', false);
}

function cleanupCompletedExport(candidate, backup, receipt) {
  const candidateBytes = readRecoverySnapshot(
    candidate,
    'durable export candidate',
    true,
  );
  if (candidateBytes !== null) {
    throw new CreationCliError(
      'export_recovery_invalid',
      'A completed export retained an unexpected candidate file.',
      5,
    );
  }
  const backupBytes = readRecoverySnapshot(backup, 'export backup', true);
  if (backupBytes === null) return;
  if (sha256Bytes(backupBytes) !== receipt.prior_output_digest) {
    throw new CreationCliError(
      'export_recovery_invalid',
      'The completed export backup no longer matches the recorded prior output.',
      5,
    );
  }
  fs.unlinkSync(backup);
  fsyncParentDirectory(backup);
}

function exportAgentWorkspace(
  engine,
  workspacePath,
  workspace,
  args,
  deps,
  operationRequest = null,
  operationBefore = null,
  developmentBaseline = null,
) {
  if (!operationRequest) {
    throw new CreationCliError(
      'operation_id_required',
      'export-agent requires a private operation receipt.',
      5,
    );
  }
  const out = valueOption(args, '--out');
  if (!out) {
    throw new CreationCliError(
      'input_invalid',
      'Usage: kdna-studio export-agent <workspace> --out <file.kdna>',
    );
  }
  const password = readPassword(args);
  const resolvedDevelopmentBaseline = resolveDevelopmentBaseline(
    deps,
    developmentBaseline,
  );
  const readiness = engine.assessReadiness(workspace);
  if (readiness.creation_accepted !== true) {
    throw new CreationCliError(
      'creation_not_accepted',
      'Creation acceptance is incomplete. Run status or resume and resolve the remaining decisions.',
      4,
    );
  }
  if (workspace.exportPlan?.access === 'licensed' && !password) {
    throw new CreationCliError(
      'authorization_required',
      'Licensed export requires authorization through --password-stdin before an export transaction can be prepared.',
      4,
    );
  }
  const compiled = engine.compileProject(workspace);
  if (!compiled?.project) {
    throw new CreationCliError(
      'compile_failed',
      'Studio Core did not return a compiled project.',
      5,
    );
  }
  const output = path.resolve(out);
  if (path.extname(output).toLowerCase() !== '.kdna') {
    throw new CreationCliError('output_invalid', 'The export target must end in .kdna.');
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const workspaceParent = path.dirname(path.resolve(workspacePath));
  const outputReference = path
    .relative(workspaceParent, output)
    .split(path.sep)
    .join('/');
  if (
    !outputReference ||
    path.posix.isAbsolute(outputReference) ||
    path.posix.normalize(outputReference) !== outputReference
  ) {
    throw new CreationCliError(
      'output_invalid',
      'The export target could not be represented as a recoverable workspace-relative path.',
    );
  }
  let operation = engine.resolveOperation(workspace, operationRequest);
  if (!operation) {
    assertOutputReplaceable(output, args.includes('--force'));
    const priorBytes = readRecoverySnapshot(output, 'export output', true);
    const names = exportRecoveryNames(output, operationRequest);
    const candidate = path.join(path.dirname(output), names.candidate);
    const backup = path.join(path.dirname(output), names.backup);
    if (
      readRecoverySnapshot(candidate, 'durable export candidate', true) !== null ||
      readRecoverySnapshot(backup, 'export backup', true) !== null
    ) {
      throw new CreationCliError(
        'export_recovery_invalid',
        'Recovery files already exist for a new export operation.',
        5,
      );
    }
    workspace = engine.prepareExportOperation(workspace, {
      ...operationRequest,
      before: operationBefore,
      output_reference: outputReference,
      output_filename: path.basename(output),
      candidate_filename: names.candidate,
      backup_filename: names.backup,
      prior_output_digest: digestOrNull(priorBytes),
    });
    workspace = engine.saveWorkspace(workspacePath, workspace);
    operation = engine.resolveOperation(workspace, operationRequest);
  }
  assertExportOperationCurrent(engine, workspace, operation);
  if (operation.output_reference !== outputReference) {
    throw new CreationCliError(
      'export_recovery_invalid',
      'The export request does not match its recorded recovery target.',
      5,
    );
  }
  const candidate = path.join(
    path.dirname(output),
    operation.candidate_filename,
  );
  const backup = path.join(path.dirname(output), operation.backup_filename);
  if (
    operation.output_filename !== path.basename(output) ||
    path.dirname(candidate) !== path.dirname(output) ||
    path.dirname(backup) !== path.dirname(output)
  ) {
    throw new CreationCliError(
      'export_recovery_invalid',
      'The export request does not match its recorded recovery target.',
      5,
    );
  }

  if (operation.status === 'prepared') {
    let candidateBytes = assertPreparedRecoveryLayout(
      output,
      candidate,
      backup,
      operation,
    );
    if (candidateBytes === null) {
      candidateBytes = generatePackedRuntimeSnapshot(
        compiled,
        password,
        output,
        deps,
      );
      writeDurableSnapshot(candidate, candidateBytes);
    }
    const verification = verifyRuntimeSnapshot(
      candidateBytes,
      compiled,
      password,
      deps,
    );
    workspace = engine.verifyExportOperation(workspace, {
      ...operationRequest,
      asset_digest: verification.artifactSha256,
    });
    workspace = engine.saveWorkspace(workspacePath, workspace);
    operation = engine.resolveOperation(workspace, operationRequest);
    maybeInjectExportCrash('after-verification');
  }

  if (operation.status !== 'verified') {
    throw new CreationCliError(
      'export_recovery_invalid',
      'The export transaction is not in a resumable verified phase.',
      5,
    );
  }
  assertExportOperationCurrent(engine, workspace, operation);
  const publishedBytes = publishVerifiedRecovery(
    output,
    candidate,
    backup,
    operation,
  );
  const verification = verifyRuntimeSnapshot(
    publishedBytes,
    compiled,
    password,
    deps,
  );
  if (verification.artifactSha256 !== operation.asset_digest) {
    throw new CreationCliError(
      'export_recovery_invalid',
      'The published export differs from the exact verified asset.',
      5,
    );
  }
  const receipt = creationBuildReceipt(
    workspace,
    output,
    verification,
    deps,
    resolvedDevelopmentBaseline,
  );
  workspace = engine.recordBuildReceipt(workspace, receipt, {
    asset_bytes: publishedBytes,
    ...(password ? { password } : {}),
  });
  workspace = engine.completeExportOperation(workspace, {
    ...operationRequest,
    asset_digest: verification.artifactSha256,
  });
  workspace = engine.saveWorkspace(workspacePath, workspace);
  operation = engine.resolveOperation(workspace, operationRequest);
  maybeInjectExportCrash('after-completion');
  cleanupCompletedExport(candidate, backup, operation);
  return {
    workspace,
    export: {
      path: output,
      format_valid: true,
      judgment_accepted: true,
      creation_accepted: true,
      application_verified: false,
      creation_complete: false,
      verification: receipt.results,
    },
  };
}

function outputExportResult(engine, exported, useJson) {
  const summary = workspaceSummary(engine, exported.workspace);
  const result = { ...summary, export: exported.export };
  if (useJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `Exported: ${exported.export.path}`,
      `Format valid: ${exported.export.format_valid === true ? 'yes' : 'not yet'}`,
      `Judgment accepted: ${exported.export.judgment_accepted === true ? 'yes' : 'not yet'}`,
      `Application verified: ${exported.export.application_verified === true ? 'yes' : 'not yet'}`,
      `Creation complete: ${exported.export.creation_complete === true ? 'yes' : 'not yet'}`,
      'Verification: validate, inspect, plan-load, compact, full, re-import, semantic comparison',
    ].join('\n') + '\n',
  );
}

async function executeCreationCommand(command, args, deps) {
  const useJson = args.includes('--json');
  try {
    requireCreationEngine(deps.creationEngine);
    const engine = deps.creationEngine;
    const workspaceInput = args[0];
    if (!workspaceInput) {
      throw new CreationCliError(
        'input_invalid',
        `Usage: kdna-studio ${command} <workspace> [--input-file <json> | --input-stdin] [--json]`,
      );
    }
    const workspacePath = path.resolve(workspaceInput);
    const input = readCommandInput(args, {
      allowPlainText: command === 'answer',
    });
    const materialPassword =
      ['create-agent', 'resume'].includes(command)
        ? readPassword(args)
        : null;

    if (command === 'create-agent') {
      const creationInput =
        input.name && input.purpose && !input.purpose.title
          ? {
              ...input,
              purpose: {
                ...input.purpose,
                title: input.name,
              },
            }
          : input;
      const preparedMaterials = materialDescriptors(
        creationInput,
        args,
        deps,
        materialPassword,
      );
      const resolvedLineage = creationLineage(
        input.lineage,
        preparedMaterials.lineages,
      );
      const operationRequest = creationOperationRequest(
        engine,
        command,
        { resolved_workspace_path: workspacePath },
        creationInput,
        args,
        preparedMaterials,
        {
          development_runtime: deps.developmentRuntime || null,
        },
      );
      if (fs.existsSync(path.join(workspacePath, 'creation-state.json'))) {
        const existing = engine.loadWorkspace(workspacePath);
        const replay = engine.resolveOperation(existing, operationRequest);
        if (replay) {
          writeResult(workspaceSummary(engine, existing), useJson);
          return;
        }
        throw new CreationCliError(
          'workspace_exists',
          'A Creation Engine workspace already exists at the requested path.',
        );
      }
      const options = {
        mode: input.mode || 'human-assisted',
        workflowMode: input.workflow_mode || 'collaborative',
        ...(input.created_by
          ? { createdBy: input.created_by }
          : {}),
        ...(input.workspace_id ? { workspaceId: input.workspace_id } : {}),
        ...(input.version ? { version: input.version } : {}),
        ...(input.judgment_version
          ? { judgmentVersion: input.judgment_version }
          : {}),
        ...(input.access ? { access: input.access } : {}),
        ...(resolvedLineage ? { lineage: resolvedLineage } : {}),
      };
      let workspace = engine.createWorkspace(workspacePath, options);
      const operationBefore = engine.operationCoordinate(workspace);
      workspace = applyWorkspaceInput(
        engine,
        workspace,
        creationInput,
        args,
        deps,
        materialPassword,
        preparedMaterials,
      );
      workspace = engine.completeOperation(workspace, {
        ...operationRequest,
        before: operationBefore,
      });
      workspace = engine.saveWorkspace(workspacePath, workspace);
      writeResult(workspaceSummary(engine, workspace), useJson);
      return;
    }

    let workspace = engine.loadWorkspace(workspacePath);
    if (command === 'status') {
      writeResult(workspaceSummary(engine, workspace), useJson);
      return;
    }
    const preparedMaterials =
      command === 'resume'
        ? materialDescriptors(input, args, deps, materialPassword)
        : null;
    const applicationExecution =
      command === 'try'
        ? applicationExecutionInput(input, args)
        : null;
    const operationRequest = creationOperationRequest(
      engine,
      command,
      { workspace_id: workspace.state.workspace_id },
      input,
      args,
      preparedMaterials,
      command === 'export-agent'
        ? {
            output_path: path.resolve(valueOption(args, '--out') || ''),
            force: args.includes('--force'),
            protected: args.includes('--password-stdin'),
            export_plan_digest:
              engine.operationCoordinate(workspace).export_plan_digest,
            development_runtime: deps.developmentRuntime || null,
          }
        : {
            ...(applicationExecution?.operation_effects || {}),
            development_runtime: deps.developmentRuntime || null,
          },
    );
    const replay = engine.resolveOperation(workspace, operationRequest);
    if (replay) {
      if (command === 'export-agent') {
        if (replay.status === 'completed') {
          const output = path.resolve(valueOption(args, '--out'));
          outputExportResult(
            engine,
            replayedExport(engine, workspace, output, replay),
            useJson,
          );
        } else {
          const exported = exportAgentWorkspace(
            engine,
            workspacePath,
            workspace,
            args,
            deps,
            operationRequest,
            replay.before,
            input.development_baseline,
          );
          outputExportResult(engine, exported, useJson);
        }
      } else {
        writeResult(workspaceSummary(engine, workspace), useJson);
      }
      return;
    }
    const operationBefore = engine.operationCoordinate(workspace);
    if (command === 'resume') {
      if (input.lineage) {
        throw new CreationCliError(
          'lineage_immutable',
          'Creation lineage is fixed by create-agent; resume may add KDNA sources only as supporting material.',
        );
      }
      workspace = applyWorkspaceInput(
        engine,
        workspace,
        input,
        args,
        deps,
        materialPassword,
        preparedMaterials,
      );
    } else if (command === 'answer') {
      const current = engine.nextAction(workspace);
      const answer = input.interview_answer || {
        question_id: input.question_id || current.unresolved_ids?.[0],
        question: input.question || current.reason || 'Creation Engine question',
        answer: input.answer || input.text,
        by: input.by || 'user',
        source_refs: input.source_refs || [],
      };
      if (!answer.answer || typeof answer.answer !== 'string') {
        throw new CreationCliError(
          'input_invalid',
          'answer requires natural-language input through --input-file or --input-stdin.',
        );
      }
      workspace = engine.recordInterviewAnswer(workspace, answer);
    } else if (command === 'review') {
      assertExpectedRevision(workspace, input);
      for (const decision of asList(input.material_decisions)) {
        if (!decision.id) {
          throw new CreationCliError(
            'input_invalid',
            'Each material decision requires an id.',
          );
        }
        try {
          workspace = engine.reviewMaterial(workspace, decision.id, {
            changes: decision.changes,
            reviewed_by: decision.reviewed_by || decision.by,
            review_reason: decision.review_reason || decision.reason,
          });
        } catch (error) {
          throw new CreationCliError(
            'input_invalid',
            creationLanguage(error.message),
          );
        }
      }
      for (const decision of asList(input.candidate_decisions)) {
        if (!decision.id) {
          throw new CreationCliError(
            'input_invalid',
            'Each candidate decision requires an id.',
          );
        }
        if (decision.decision === 'reject') {
          workspace = engine.promoteCandidate(workspace, decision.id, {
            decision: 'reject',
            reason: decision.reason,
            reviewed_by: decision.reviewed_by || decision.by,
            review_reason: decision.review_reason || decision.reason,
          });
        } else {
          workspace = engine.promoteCandidate(workspace, decision.id, {
            ...(decision.changes || {}),
            decision: 'promote',
            reviewed_by: decision.reviewed_by || decision.by,
            review_reason: decision.review_reason || decision.reason,
          });
        }
      }
      if (
        input.relations ||
        input.split_recommendations ||
        input.resolve_conflicts ||
        input.relation_decisions
      ) {
        workspace = engine.analyzeRelations(workspace, {
          relations: input.relations || [],
          split_recommendations: input.split_recommendations || [],
          resolve_conflicts: input.resolve_conflicts || [],
          relation_decisions: input.relation_decisions || [],
        });
      }
      for (const confirmation of asList(input.confirmations)) {
        assertConsentRevisionCurrent(workspace, input);
        workspace = engine.recordConfirmation(workspace, confirmation);
      }
    } else if (command === 'try') {
      assertExpectedRevision(workspace, input);
      assertTestAcceptanceIsFinal(input);
      if (input.test_plan && asList(input.test_results).length > 0) {
        throw new CreationCliError(
          'test_plan_order_invalid',
          'Freeze the semantic test plan in a separate request before recording any results.',
        );
      }
      const applicationActions = [
        input.application_plan,
        input.application_attempt,
        input.application_observation,
        input.application_attempt_abandonment,
        input.application_receipt,
      ].filter(Boolean);
      if (applicationActions.length > 1) {
        throw new CreationCliError(
          'application_plan_order_invalid',
          'Freeze the application plan, issue or abandon the attempt, record the Consumer asset observation, and record the signed receipt in separate requests.',
        );
      }
      if (
        input.application_plan &&
        (
          asList(input.tests).length > 0 ||
          input.test_plan ||
          asList(input.test_results).length > 0
        )
      ) {
        throw new CreationCliError(
          'application_plan_order_invalid',
          'Freeze the independent application plan only after judgment testing and acceptance complete in an earlier request.',
        );
      }
      for (const testCase of asList(input.tests)) {
        workspace = engine.addSemanticTest(workspace, testCase);
      }
      if (input.test_plan) {
        workspace = engine.freezeSemanticTestPlan(workspace, input.test_plan);
      }
      for (const result of asList(input.test_results)) {
        const testId = result.test_id || result.id;
        if (!testId) {
          throw new CreationCliError(
            'input_invalid',
            'Each semantic test result requires test_id.',
          );
        }
        const details = { ...result };
        delete details.test_id;
        delete details.id;
        if (details.acceptance) {
          assertConsentRevisionCurrent(workspace, input);
        }
        workspace = engine.recordSemanticTestResult(workspace, testId, details);
      }
      if (input.application_plan) {
        workspace = engine.freezeApplicationTestPlan(
          workspace,
          input.application_plan,
        );
      }
      if (input.application_attempt) {
        try {
          workspace = engine.issueApplicationAttempt(
            workspace,
            input.application_attempt,
            {
              asset_bytes: applicationExecution.bytes,
              password: applicationExecution.password,
            },
          );
        } catch (error) {
          throw mapApplicationExecutionError(error);
        }
      }
      if (input.application_observation) {
        try {
          workspace = engine.recordApplicationAssetObservation(
            workspace,
            input.application_observation,
            {
              asset_bytes: applicationExecution.bytes,
              password: applicationExecution.password,
            },
          );
        } catch (error) {
          throw mapApplicationExecutionError(error);
        }
      }
      if (input.application_attempt_abandonment) {
        workspace = engine.abandonApplicationAttempt(
          workspace,
          input.application_attempt_abandonment,
        );
      }
      if (input.application_receipt) {
        workspace = engine.recordApplicationReceipt(
          workspace,
          input.application_receipt,
        );
      }
    } else if (command === 'repair') {
      workspace = engine.buildRepairPlan(workspace, input.diagnostics || {});
      for (const repair of asList(input.repairs)) {
        if (!repair.id) {
          throw new CreationCliError('input_invalid', 'Each repair requires an id.');
        }
        const application = { ...repair };
        delete application.id;
        workspace = engine.applyRepair(workspace, repair.id, application);
      }
    } else if (command === 'export-agent') {
      const exported = exportAgentWorkspace(
        engine,
        workspacePath,
        workspace,
        args,
        deps,
        operationRequest,
        operationBefore,
        input.development_baseline,
      );
      outputExportResult(engine, exported, useJson);
      return;
    }
    workspace = engine.completeOperation(workspace, {
      ...operationRequest,
      before: operationBefore,
    });
    workspace = engine.saveWorkspace(workspacePath, workspace);
    writeResult(workspaceSummary(engine, workspace), useJson);
  } catch (error) {
    writeFailure(error, useJson);
  }
}

module.exports = {
  CREATION_COMMANDS,
  CreationCliError,
  candidateRuntimeAuthority,
  candidateRuntimeCoordinate,
  commitVerifiedExport,
  currentKdnaMaterial,
  executeCreationCommand,
  exportAgentWorkspace,
  materialDescriptors,
  readBoundedFile,
  resolveDevelopmentBaseline,
  semanticProjectProjection,
  verifyRuntimeSnapshot,
  workspaceSummary,
};
