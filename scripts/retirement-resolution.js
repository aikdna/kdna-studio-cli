#!/usr/bin/env node
'use strict';

// Independent report for the auxiliary leg of the retirement criterion.
//
// `verify-retirement-registry.js` runs each retired file from the path it was
// retired from and reports that as an auxiliary observation - it never accepts an
// entry on its own, because the retirement rewrites the file's relative requires
// to the new depth, so the current bytes re-run from the old path die on a
// `Cannot find module` the move itself created. This script prints the fact the
// gate depends on, so it can be checked without reading the gate:
//
//   for every relative specifier in the retired file, does it still resolve from
//   the path the file was retired from?
//
// A file whose specifiers no longer resolve from the retired path had its
// requires rewritten by the retirement; the auxiliary leg is inadmissible for it
// and the run from the old path proves nothing.
//
// usage: node scripts/retirement-resolution.js [--root <tree>]

const fs = require('node:fs');
const path = require('node:path');

const LEGACY_PREFIX = 'tests/legacy/';
const RELATIVE_SPECIFIER_RE = /(?:require\(\s*|from\s+|import\(\s*)(['"])(\.[^'"]*)\1/gu;

function relativeSpecifiers(file) {
  const source = fs.readFileSync(file, 'utf8');
  const found = new Set();
  for (const match of source.matchAll(RELATIVE_SPECIFIER_RE)) found.add(match[2]);
  return [...found];
}

function resolvesFrom(specifier, directory) {
  try {
    require.resolve(specifier, { paths: [directory] });
    return true;
  } catch {
    return false;
  }
}

function survey(root) {
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'retired.json'), 'utf8'));
  const rows = [];
  for (const entry of registry.entries ?? []) {
    if (typeof entry.file !== 'string' || !entry.file.startsWith(LEGACY_PREFIX)) continue;
    const source = path.join(root, entry.file);
    if (!fs.existsSync(source)) continue;
    const original = `tests/${entry.file.slice(LEGACY_PREFIX.length)}`;
    const originalDirectory = path.dirname(path.join(root, original));
    const legacyDirectory = path.dirname(source);
    const specifiers = relativeSpecifiers(source);
    const fromRetiredPath = specifiers.filter((specifier) => resolvesFrom(specifier, originalDirectory));
    rows.push({
      file: entry.file,
      original,
      specifiers: specifiers.length,
      resolvableFromRetiredPath: fromRetiredPath.length,
      unresolvedFromRetiredPath: specifiers.length - fromRetiredPath.length,
      resolvableFromRegisteredPath: specifiers.filter((specifier) => resolvesFrom(specifier, legacyDirectory)).length,
      // The auxiliary leg is only admissible when *every* relative specifier
      // still resolves from the retired path, i.e. none was rewritten to the new
      // depth. An entry with no relative specifier at all cannot be judged this
      // way and is marked inadmissible too.
      auxiliaryLegAdmissible: specifiers.length > 0 && fromRetiredPath.length === specifiers.length,
    });
  }
  return rows;
}

function main(argv) {
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1 ? path.resolve(__dirname, '..') : path.resolve(argv[rootIndex + 1]);
  const rows = survey(root);
  console.log(`KDNA-RETIREMENT-RESOLUTION: root=${root} entries=${rows.length}`);
  console.log('file\tspecifiers\tresolve_from_retired_path\tresolve_from_registered_path\taux_leg_a');
  for (const row of rows) {
    console.log(
      `${row.file}\t${row.specifiers}\t${row.resolvableFromRetiredPath}/${row.specifiers}\t` +
        `${row.resolvableFromRegisteredPath}/${row.specifiers}\t` +
        `${row.auxiliaryLegAdmissible ? 'admissible' : 'inadmissible'}`,
    );
  }
  const admissible = rows.filter((row) => row.auxiliaryLegAdmissible).length;
  console.log(`KDNA-RETIREMENT-RESOLUTION: ok entries=${rows.length} aux_leg_a_admissible=${admissible}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { relativeSpecifiers, survey };
