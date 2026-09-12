#!/usr/bin/env node
'use strict';
require('../src/terminal-workspace.js').main(process.argv.slice(2)).catch(error => {
  const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code) ? error.code : 'CLI_FAILURE';
  process.stderr.write(JSON.stringify({ status: 'rejected', code }) + '\n');
  process.exitCode = 2;
});
