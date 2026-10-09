'use strict';

// The candidate coordinate is decided by scripts/release-policy.js
// isCanonicalCandidateVersion(). It replaced one regular expression whose
// prerelease alternative nested overlapping [0-9A-Za-z-] quantifiers inside a
// repeated dot-separated group, so a string such as `0.0.0-0.` followed by
// repeated `--.` could be split in exponentially many ways (CodeQL
// js/polynomial-redos). A scanner red is not a reason to weaken the gate: this
// suite proves the replacement accepts exactly the same coordinates, and that
// it stays linear on the very input the old expression blew up on.
//
// The reference below is an independent transliteration of the replaced
// expression's three alternations. It is written with string operations rather
// than a copy of the offending regex, so the two implementations share no
// backtracking behaviour that could hide a difference.

const test = require('node:test');
const assert = require('node:assert/strict');
const { isCanonicalCandidateVersion } = require('../scripts/release-policy');

function isAsciiDigits(value) {
  return value.length > 0 && [...value].every((c) => c >= '0' && c <= '9');
}

function isAsciiAlphanumericOrDash(value) {
  return value.length > 0 && [...value].every((c) =>
    (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '-');
}

function containsLetterOrDash(value) {
  return [...value].some((c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '-');
}

// `0` | `[1-9]\d*` | `[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*`
function legacyIdentifierAccepts(identifier) {
  if (identifier === '0') return true;
  if (identifier.length > 0 && identifier[0] >= '1' && identifier[0] <= '9'
      && isAsciiDigits(identifier)) return true;
  if (isAsciiAlphanumericOrDash(identifier) && containsLetterOrDash(identifier)) return true;
  return false;
}

function legacyCoreAccepts(core) {
  const parts = core.split('.');
  if (parts.length !== 3) return false;
  return parts.every((part) => part === '0'
    || (part.length > 0 && part[0] >= '1' && part[0] <= '9' && isAsciiDigits(part)));
}

function legacyCandidateAccepts(value) {
  if (typeof value !== 'string') return false;
  const separator = value.indexOf('-');
  if (separator < 0) return false;
  if (!legacyCoreAccepts(value.slice(0, separator))) return false;
  return value.slice(separator + 1).split('.').every(legacyIdentifierAccepts);
}

function acceptedStrings() {
  const corpus = [
    '1.2.3-rc.1', '1.2.3-alpha.0', '0.37.1-rc.browser.1', '0.11.2-rc.browser.1',
    '4.0.0-rc.components.2', '10.20.30-0', '0.0.0-0.0.0', '1.2.3-x', '1.2.3-X.9',
    '1.2.3--', '1.2.3-a-', '1.2.3-0a', '1.2.3-a0.00a', '1.2.3-0.1.0',
  ];
  const rejected = [
    '1.2.3', '0.0.0', '>=1.2.3-rc.1', '^1.2.3', '~1.2.3', '*', 'latest', 'next',
    '1.2.3 - 2.0.0', '1.2.x', '1.2', '1', '1.2.3-', '1.2.3-.', '1.2.3-rc..1',
    '1.2.3-rc.1.', '1.2.3-rc.01', '1.2.3-00', '01.2.3-rc.1', '1.02.3-rc.1',
    '1.2.03-rc.1', '1.2.3.4-rc.1', '1.2-rc.1', '1.2.3+rc.1', 'x1.2.3-rc.1',
    '1.2.3-rc.1 ', ' 1.2.3-rc.1', 'file:vendor/a.tgz', '', '-', '-rc.1',
  ];
  return { corpus, rejected };
}

test('the candidate validator accepts exactly the coordinates the replaced expression accepted', () => {
  const { corpus, rejected } = acceptedStrings();
  for (const value of corpus) {
    assert.equal(isCanonicalCandidateVersion(value), true, `must accept ${value}`);
    assert.equal(legacyCandidateAccepts(value), true, `reference must accept ${value}`);
  }
  for (const value of rejected) {
    assert.equal(isCanonicalCandidateVersion(value), false, `must reject ${value}`);
    assert.equal(legacyCandidateAccepts(value), false, `reference must reject ${value}`);
  }
  for (const value of [undefined, null, 123, {}, [], Symbol('rc')]) {
    assert.equal(isCanonicalCandidateVersion(value), false, `must reject ${String(value)}`);
    assert.equal(legacyCandidateAccepts(value), false, `reference must reject ${String(value)}`);
  }
});

test('the two implementations agree on every string over a small alphabet', () => {
  const alphabet = ['a', '-', '0', '1', '.'];
  let compared = 0;
  for (let length = 0; length <= 7; length += 1) {
    const total = alphabet.length ** length;
    for (let index = 0; index < total; index += 1) {
      let suffix = '';
      let rest = index;
      for (let position = 0; position < length; position += 1) {
        suffix += alphabet[rest % alphabet.length];
        rest = Math.floor(rest / alphabet.length);
      }
      for (const prefix of ['1.2.3-', '0.0.0-', '0.37.1-', '01.2.3-', '1.2.3', '1.2-', '']) {
        const value = prefix + suffix;
        assert.equal(
          isCanonicalCandidateVersion(value),
          legacyCandidateAccepts(value),
          `disagreement on ${JSON.stringify(value)}`,
        );
        compared += 1;
      }
    }
  }
  assert.ok(compared > 90_000, `expected an exhaustive corpus, compared ${compared}`);
});

test('the candidate validator stays linear on the input the replaced expression backtracked on', () => {
  // The dotted runs of `--` are exactly the strings the replaced expression
  // could split in exponentially many ways. Measured against that expression,
  // the non-matching form below costs roughly 16x per four extra repeats
  // (14 repeats 1ms, 18 repeats 9ms, 22 repeats 136ms, 26 repeats 2146ms for
  // an 87-character string) while the replacement answers in under a
  // millisecond. The bounds here are deliberately loose so a loaded machine
  // cannot make them flaky, but a reintroduced blow-up still cannot pass.
  const dottedRuns = (repeats, terminator) => `0.0.0-0.${'--.'.repeat(repeats)}${terminator}`;
  const measure = (value) => {
    const started = process.hrtime.bigint();
    const verdict = isCanonicalCandidateVersion(value);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    return { verdict, elapsedMs };
  };

  measure(dottedRuns(256, '--')); // warm-up so the first measurement is not charged a cold start

  // A matching coordinate: every `--` is a non-numeric prerelease identifier.
  const matchingSmall = measure(dottedRuns(2048, '--'));
  const matchingLarge = measure(dottedRuns(4096, '--'));
  assert.equal(matchingSmall.verdict, true, 'the long matching coordinate must still be accepted');
  assert.equal(matchingLarge.verdict, true, 'the long matching coordinate must still be accepted');
  assert.ok(matchingSmall.elapsedMs < 1000, `2048 repeats took ${matchingSmall.elapsedMs}ms`);
  assert.ok(matchingLarge.elapsedMs < 1000, `4096 repeats took ${matchingLarge.elapsedMs}ms`);

  // A non-matching coordinate: the invalid terminator forces the whole shape to
  // be rejected, which is where the replaced expression spent its time.
  const rejected = measure(dottedRuns(4096, '@'));
  assert.equal(rejected.verdict, false, 'the invalid terminator must be refused');
  assert.ok(rejected.elapsedMs < 1000, `the refused 4096-repeat coordinate took ${rejected.elapsedMs}ms`);

  // Doubling the input must not multiply the cost. The additive slack keeps the
  // ratio meaningful even when both measurements are sub-millisecond.
  assert.ok(
    matchingLarge.elapsedMs <= 8 * matchingSmall.elapsedMs + 100,
    `2048 repeats ${matchingSmall.elapsedMs}ms vs 4096 repeats ${matchingLarge.elapsedMs}ms is not linear`,
  );

  // A trailing separator is not a coordinate either, and must be refused fast.
  const trailing = measure(dottedRuns(4096, ''));
  assert.equal(trailing.verdict, false, 'a trailing separator must be refused');
  assert.ok(trailing.elapsedMs < 1000, `trailing separator took ${trailing.elapsedMs}ms`);
});
