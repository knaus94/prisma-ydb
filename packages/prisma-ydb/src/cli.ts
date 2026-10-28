#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { generateYql } from './control/yql-generate.js';

try {
  const { values, positionals } = parseArgs({
    options: {
      config: { type: 'string' },
      dir: { type: 'string' },
      output: { type: 'string' },
      check: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  if (
    positionals.length !== 2 ||
    positionals[0] !== 'yql' ||
    positionals[1] !== 'generate'
  )
    throw new Error(
      'Usage: prisma-ydb yql generate [--config <path>] [--dir <dir>] [--output <file>] [--check]',
    );
  const result = await generateYql(values);
  console.log(
    `${values.check ? 'Checked' : 'Generated'} ${result.files} YQL functions: ${result.output}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
