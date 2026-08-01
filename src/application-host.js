'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_AGENT_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_AGENT_SCHEMA_BYTES = 512 * 1024;
const MAX_AGENT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_AUTH_BYTES = 2 * 1024 * 1024;
const DISABLED_CODEX_FEATURES = Object.freeze([
  'apps',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'code_mode_host',
  'computer_use',
  'enable_fanout',
  'enable_mcp_apps',
  'hooks',
  'image_generation',
  'in_app_browser',
  'multi_agent',
  'multi_agent_v2',
  'plugins',
  'remote_plugin',
  'shell_snapshot',
  'shell_tool',
  'shell_zsh_fork',
  'standalone_web_search',
  'tool_suggest',
  'unified_exec',
  'unified_exec_zsh_fork',
  'workspace_dependencies',
]);

class ApplicationHostError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function sha256(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(value)
    .digest('hex')}`;
}

function sandboxLiteral(value) {
  return JSON.stringify(path.resolve(value));
}

function sandboxProfile({ nativeCommand, roleRoot, deniedPaths }) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const explicitDenies = [...new Set(
    deniedPaths
      .filter(Boolean)
      .map((entry) => path.resolve(entry))
      .filter((entry) => !entry.startsWith(`${roleRoot}${path.sep}`)),
  )].map((entry) => (
    `(deny file-read* (subpath ${sandboxLiteral(entry)}))`
  ));
  return [
    '(version 1)',
    '(deny default)',
    // A model-generated subprocess cannot start. Only the already selected
    // native Codex host executable may execute.
    `(allow process-exec (literal ${sandboxLiteral(nativeCommand)}))`,
    `(allow file-read* (literal ${sandboxLiteral(nativeCommand)}))`,
    // The dynamic linker and system frameworks required to load the selected
    // native executable.
    '(allow file-read* (subpath "/usr/lib"))',
    '(allow file-read* (subpath "/System/Library"))',
    '(allow file-read* (subpath "/Library/Apple/System/Library"))',
    '(allow file-read* (subpath "/opt/homebrew"))',
    '(allow file-read-metadata)',
    // The host resolves the filesystem root; only that root node is readable.
    '(allow file-read-data (literal "/"))',
    // Standard device and system configuration nodes the host may touch.
    '(allow file-read* (subpath "/dev"))',
    '(allow file-read* (subpath "/private/dev"))',
    '(allow file-read* (subpath "/private/etc"))',
    '(allow file-read* (subpath "/etc"))',
    // The adapter may read and write only inside this role's disposable 0700
    // root.
    `(allow file-read* (subpath ${sandboxLiteral(roleRoot)}))`,
    `(allow file-write* (subpath ${sandboxLiteral(roleRoot)}))`,
    // The selected Host runtime writes transient session state under the
    // system temporary directories; user data, project files, and credentials
    // remain outside the write namespace.
    '(allow file-write* (subpath "/private/var/folders"))',
    '(allow file-write* (subpath "/private/tmp"))',
    '(allow file-write* (subpath "/var"))',
    // Process, system, network, IPC and logging primitives the isolated host
    // needs to reach its declared service.
    '(allow process-fork)',
    '(allow sysctl-read)',
    '(allow network-outbound)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow ipc-posix-sem)',
    '(allow signal)',
    // User data, credentials, project files, and unrelated temporary runs are
    // outside the role's readable namespace.
    '(deny file-read* (subpath "/Users"))',
    '(deny file-read* (subpath "/private/tmp"))',
    `(deny file-read-data (require-all (subpath ${sandboxLiteral(temporaryRoot)}) (require-not (subpath ${sandboxLiteral(roleRoot)}))))`,
    ...explicitDenies,
  ].join('\n');
}

function makePrivateRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(root, 0o700);
  return fs.realpathSync(root);
}

function writePrivateBytes(target, bytes) {
  const descriptor = fs.openSync(
    target,
    fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_WRONLY,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, bytes);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writePrivateJson(target, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  try {
    writePrivateBytes(target, bytes);
  } finally {
    bytes.fill(0);
  }
}

function createPrivateOutput(target) {
  const descriptor = fs.openSync(
    target,
    fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_WRONLY,
    0o600,
  );
  fs.closeSync(descriptor);
}

function readPrivateJson(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ApplicationHostError(
      'application_host_output_invalid',
      'The isolated Host did not produce a regular structured output file.',
    );
  }
  if ((stat.mode & 0o077) !== 0 || stat.size > MAX_AGENT_OUTPUT_BYTES) {
    throw new ApplicationHostError(
      'application_host_output_invalid',
      'The isolated Host output permissions or size are invalid.',
    );
  }
  const bytes = fs.readFileSync(target);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ApplicationHostError(
      'application_host_output_invalid',
      'The isolated Host did not return the required structured JSON.',
    );
  } finally {
    bytes.fill(0);
  }
}

function executableFromPath(command, environmentPath = process.env.PATH) {
  if (path.isAbsolute(command)) return path.resolve(command);
  for (const directory of String(environmentPath || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Continue through PATH without invoking a shell.
    }
  }
  throw new ApplicationHostError(
    'application_host_unavailable',
    'The Codex Host adapter is not installed.',
  );
}

function nativeCodexExecutable(command) {
  const executable = executableFromPath(command);
  const stat = fs.lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ApplicationHostError(
      'application_host_unavailable',
      'The Codex Host command is not a regular executable.',
    );
  }
  const prefix = Buffer.alloc(4);
  let descriptor;
  try {
    descriptor = fs.openSync(executable, 'r');
    fs.readSync(descriptor, prefix, 0, prefix.length, 0);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  const isMachO = [
    'feedface',
    'cefaedfe',
    'feedfacf',
    'cffaedfe',
    'cafebabe',
    'bebafeca',
  ].includes(prefix.toString('hex'));
  prefix.fill(0);
  if (isMachO) return executable;

  // The official npm command is a small JS launcher. Resolve its packaged
  // native binary once, then execute only that binary inside the sandbox.
  const packageRoot = path.resolve(path.dirname(executable), '..');
  const modulesRoot = path.join(packageRoot, 'node_modules', '@openai');
  let packages;
  try {
    packages = fs.readdirSync(modulesRoot);
  } catch {
    throw new ApplicationHostError(
      'application_host_unavailable',
      'The installed Codex command does not expose a packaged native executable.',
    );
  }
  const candidates = [];
  for (const packageName of packages) {
    if (!packageName.startsWith('codex-')) continue;
    const vendor = path.join(modulesRoot, packageName, 'vendor');
    let triples = [];
    try {
      triples = fs.readdirSync(vendor);
    } catch {
      continue;
    }
    for (const triple of triples) {
      const candidate = path.join(vendor, triple, 'bin', 'codex');
      try {
        const candidateStat = fs.lstatSync(candidate);
        fs.accessSync(candidate, fs.constants.X_OK);
        if (candidateStat.isFile() && !candidateStat.isSymbolicLink()) {
          candidates.push(fs.realpathSync(candidate));
        }
      } catch {
        // Ignore packages for another platform.
      }
    }
  }
  if (candidates.length !== 1) {
    throw new ApplicationHostError(
      'application_host_unavailable',
      'The installed Codex command does not resolve to one native executable for this Host.',
    );
  }
  return candidates[0];
}

function authSourcePath(options) {
  if (options.authPath) return path.resolve(options.authPath);
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'auth.json');
}

function installEphemeralAuth(roleRoot, options) {
  const source = authSourcePath(options);
  let stat;
  try {
    stat = fs.lstatSync(source);
  } catch {
    throw new ApplicationHostError(
      'application_host_auth_unavailable',
      'The exact Codex Host has no installed authentication substrate.',
    );
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size <= 0 ||
    stat.size > MAX_AUTH_BYTES
  ) {
    throw new ApplicationHostError(
      'application_host_auth_unavailable',
      'The installed Codex authentication substrate is not a bounded regular file.',
    );
  }
  const codexHome = path.join(roleRoot, 'codex-home');
  fs.mkdirSync(codexHome, { mode: 0o700 });
  const bytes = fs.readFileSync(source);
  try {
    writePrivateBytes(path.join(codexHome, 'auth.json'), bytes);
  } finally {
    bytes.fill(0);
  }
  return codexHome;
}

function codexCoordinate(nativeCommand, run = spawnSync) {
  const result = run(nativeCommand, ['--version'], {
    encoding: null,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: {
      HOME: os.tmpdir(),
      PATH: '/usr/bin:/bin',
      NO_COLOR: '1',
    },
  });
  const stdout = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout || '');
  const stderr = Buffer.isBuffer(result.stderr)
    ? result.stderr
    : Buffer.from(result.stderr || '');
  try {
    if (result.status !== 0) {
      throw new ApplicationHostError(
        'application_host_unavailable',
        'The Codex Host adapter could not report its version.',
      );
    }
    return {
      adapter: 'kdna.studio.application-host/codex-exec',
      host: stdout.toString('utf8').trim(),
      isolation: 'macos-sandbox-tool-less-role-root',
    };
  } finally {
    stdout.fill(0);
    stderr.fill(0);
  }
}

function createCodexApplicationHost(options = {}) {
  if (process.platform !== 'darwin') {
    throw new ApplicationHostError(
      'application_host_capability_isolation_unavailable',
      'This Codex application adapter currently requires the macOS capability sandbox.',
    );
  }
  const command = options.command || 'codex';
  const run = options.spawnSync || spawnSync;
  const nativeCommand =
    options.nativeCommand || nativeCodexExecutable(command);
  const deniedPaths = Array.isArray(options.deniedPaths)
    ? options.deniedPaths
    : [];
  const coordinate = codexCoordinate(nativeCommand, run);
  const isolationPolicy = {
    schema: 'kdna.studio.application-host-isolation/0.1.0',
    tool_features_disabled: DISABLED_CODEX_FEATURES,
    child_processes: 'deny',
    role_filesystem: 'disposable-role-root-only',
    inherited_environment: 'deny',
  };
  const runnerDigest = sha256(JSON.stringify({
    coordinate,
    isolation_policy_digest: sha256(JSON.stringify(isolationPolicy)),
  }));

  function runStructured({ role, prompt, schema }) {
    const promptBytes = Buffer.from(prompt, 'utf8');
    const schemaBytes = Buffer.from(JSON.stringify(schema), 'utf8');
    if (
      promptBytes.length > MAX_AGENT_INPUT_BYTES ||
      schemaBytes.length > MAX_AGENT_SCHEMA_BYTES
    ) {
      promptBytes.fill(0);
      schemaBytes.fill(0);
      throw new ApplicationHostError(
        'application_host_input_too_large',
        'The exact Runtime Capsule and task envelope exceed this Host adapter input budget; no input was truncated.',
      );
    }
    const root = makePrivateRoot(`kdna-${role}-`);
    const schemaPath = path.join(root, 'output.schema.json');
    const outputPath = path.join(root, 'output.json');
    let result = null;
    try {
      const roleHome = path.join(root, 'home');
      const roleTmp = path.join(root, 'tmp');
      fs.mkdirSync(roleHome, { mode: 0o700 });
      fs.mkdirSync(roleTmp, { mode: 0o700 });
      const codexHome = installEphemeralAuth(root, options);
      writePrivateBytes(schemaPath, schemaBytes);
      createPrivateOutput(outputPath);
      const profile = sandboxProfile({
        nativeCommand,
        roleRoot: root,
        deniedPaths: [
          ...deniedPaths,
          options.workspacePath,
          options.projectPath,
        ],
      });
      const args = [
        'exec',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--cd',
        root,
        '--output-schema',
        schemaPath,
        '--output-last-message',
        outputPath,
        '--color',
        'never',
        ...DISABLED_CODEX_FEATURES.flatMap(
          (feature) => ['--disable', feature],
        ),
        '-',
      ];
      result = run(
        '/usr/bin/sandbox-exec',
        ['-p', profile, nativeCommand, ...args],
        {
          cwd: root,
          input: promptBytes,
          encoding: null,
          timeout: options.timeoutMs || 300_000,
          maxBuffer: MAX_AGENT_OUTPUT_BYTES,
          env: {
            HOME: roleHome,
            CODEX_HOME: codexHome,
            TMPDIR: roleTmp,
            PATH: '/usr/bin:/bin',
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
            NO_COLOR: '1',
          },
        },
      );
      if (
        result.status !== 0 ||
        result.signal ||
        !fs.existsSync(outputPath)
      ) {
        if (typeof options.onDiagnostic === 'function') {
          const stderrText = Buffer.isBuffer(result.stderr)
            ? result.stderr.toString('utf8')
            : '';
          options.onDiagnostic({
            phase: role,
            status: result.status,
            signal: result.signal || null,
            failure_class: /operation not permitted|permission denied|deny\(/i.test(
              stderrText,
            )
              ? 'capability-sandbox'
              : (
                  /output schema|schema/i.test(stderrText)
                    ? 'structured-output'
                    : (
                  /auth|login|credential/i.test(stderrText)
                    ? 'host-authentication'
                    : (
                        /config|feature|unknown field/i.test(stderrText)
                          ? 'host-configuration'
                          : (
                              /network|connect|tls|http/i.test(stderrText)
                                ? 'host-network'
                                : 'host-execution'
                            )
                      )
                    )
                ),
            stdout_digest: Buffer.isBuffer(result.stdout)
              ? sha256(result.stdout)
              : null,
            stderr_digest: Buffer.isBuffer(result.stderr)
              ? sha256(result.stderr)
              : null,
          });
        }
        throw new ApplicationHostError(
          'application_host_execution_failed',
          `The isolated ${role} Host execution did not complete.`,
        );
      }
      const output = readPrivateJson(outputPath);
      const outputBytes = Buffer.from(JSON.stringify(output));
      try {
        return {
          output,
          output_digest: sha256(outputBytes),
          run_digest: sha256(Buffer.concat([
            Buffer.from(`${role}\0`),
            promptBytes,
            Buffer.from('\0'),
            outputBytes,
          ])),
          runner_digest: runnerDigest,
          coordinate,
          isolation_policy_digest:
            sha256(JSON.stringify(isolationPolicy)),
        };
      } finally {
        outputBytes.fill(0);
      }
    } finally {
      promptBytes.fill(0);
      schemaBytes.fill(0);
      if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0);
      if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  return Object.freeze({
    coordinate,
    runner_digest: runnerDigest,
    isolation_policy_digest: sha256(JSON.stringify(isolationPolicy)),
    generateOracle(input) {
      return runStructured({
        role: 'application-oracle',
        prompt: input.prompt,
        schema: input.schema,
      });
    },
    runConsumer(input) {
      return runStructured({
        role: 'application-consumer',
        prompt: input.prompt,
        schema: input.schema,
      });
    },
    runEvaluator(input) {
      return runStructured({
        role: 'application-evaluator',
        prompt: input.prompt,
        schema: input.schema,
      });
    },
  });
}

module.exports = {
  ApplicationHostError,
  createCodexApplicationHost,
};
