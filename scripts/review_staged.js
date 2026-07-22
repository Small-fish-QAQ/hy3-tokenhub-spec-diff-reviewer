#!/usr/bin/env node
'use strict';

const { handleTopLevelError, main } = require('../hy3_showcase');

function run(args = process.argv.slice(2), dependencies = {}) {
  return (dependencies.main || main)(['diff-review', '--git', ...args], dependencies);
}

if (require.main === module) {
  run()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => { process.exitCode = handleTopLevelError(error); });
}

module.exports = { run };
