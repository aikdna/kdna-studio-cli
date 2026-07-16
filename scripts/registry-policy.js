'use strict';

const { validateEvidence } = require('./release-evidence');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectedE404(evidence) {
  const spec = `${evidence.package.name}@${evidence.package.version}`;
  return {
    code: 'E404',
    summary: `No match found for version ${evidence.package.version}`,
    detail:
      `The requested resource '${spec}' could not be found or you do not have permission to access it.` +
      '\n\nNote that you can also install from a\ntarball, folder, http url, or git url.',
  };
}

function exactKeys(value, expected, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
    `${label} fields are not exact`,
  );
}

function parseJson(text, label) {
  assert(typeof text === 'string' && text.trim(), `${label} must contain JSON`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} must be one JSON document`);
  }
}

function evaluateRegistryResult(result, rawEvidence) {
  const evidence = validateEvidence(rawEvidence);
  assert(result && !result.error, `registry lookup failed: ${result?.error?.message || 'unknown error'}`);
  assert(Number.isInteger(result.status), 'registry lookup did not return an exit status');
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  assert(typeof stdout === 'string' && typeof stderr === 'string', 'registry output must be text');
  assert(stderr === '', 'registry lookup wrote unexpected stderr');

  if (result.status === 1) {
    const document = parseJson(stdout, 'registry E404 stdout');
    exactKeys(document, ['error'], 'registry E404 document');
    exactKeys(document.error, ['code', 'summary', 'detail'], 'registry E404 error');
    const expected = expectedE404(evidence);
    assert(document.error.code === expected.code, 'registry E404 code mismatch');
    assert(document.error.summary === expected.summary, 'registry E404 summary mismatch');
    assert(document.error.detail === expected.detail, 'registry E404 detail mismatch');
    return Object.freeze({ decision: 'publish', shouldPublish: true });
  }

  assert(result.status === 0, `registry lookup exited ${String(result.status)}`);
  const metadata = parseJson(stdout, 'registry metadata stdout');
  exactKeys(metadata, ['name', 'version', 'dist.integrity', 'dist.shasum'], 'registry metadata');
  assert(metadata.name === evidence.package.name, 'published package name mismatch');
  assert(metadata.version === evidence.package.version, 'published package version mismatch');
  assert(metadata['dist.integrity'] === evidence.artifact.integrity, 'published integrity collision');
  assert(metadata['dist.shasum'] === evidence.artifact.shasum, 'published shasum collision');
  return Object.freeze({ decision: 'skip-identical', shouldPublish: false });
}

module.exports = { evaluateRegistryResult, expectedE404 };
