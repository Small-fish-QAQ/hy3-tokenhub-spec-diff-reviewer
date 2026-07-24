#!/usr/bin/env node
'use strict';

const { handleTopLevelError } = require('../hy3_showcase');
const { runStagedReviewConsole } = require('../lib/staged_web');

function run(args = process.argv.slice(2), dependencies = {}) {
  return (dependencies.runStagedReviewConsole || runStagedReviewConsole)(args, dependencies);
}

if (require.main === module) {
  run().catch((error) => { process.exitCode = handleTopLevelError(error); });
}

module.exports = { run };
