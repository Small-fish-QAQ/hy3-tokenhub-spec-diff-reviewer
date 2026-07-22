#!/usr/bin/env node
'use strict';

const { formatEvaluation, runOfflineEvaluation } = require('../lib/evaluation');

runOfflineEvaluation()
  .then((result) => {
    process.stdout.write(formatEvaluation(result));
    if (!result.ok) process.exitCode = 1;
  })
  .catch((error) => {
    process.stderr.write(`Offline evaluation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
