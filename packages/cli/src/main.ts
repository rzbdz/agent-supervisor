#!/usr/bin/env node
import { buildProgram } from './commands.ts';

await buildProgram().parseAsync(process.argv);
