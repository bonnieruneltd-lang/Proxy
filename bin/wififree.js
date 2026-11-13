#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli');

main(process.argv.slice(2)).then(
  (code) => {
    if (typeof code === 'number' && code !== 0) process.exitCode = code;
  },
  (err) => {
    console.error(`wififree: ${err.stack || err.message}`);
    process.exitCode = 1;
  }
);
