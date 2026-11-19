#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { Runtime } from './runtime.ts';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '4700' },
      host: { type: 'string', default: '127.0.0.1' },
      root: { type: 'string', default: process.cwd() },
      model: { type: 'string' },
      'orchestrator-name': { type: 'string', default: 'main' },
      'web-root': { type: 'string' },
    },
    allowPositionals: false,
  });

  const runtime = new Runtime({
    projectRoot: resolve(values.root!),
    port: Number(values.port),
    host: values.host!,
    model: values.model,
    orchestratorName: values['orchestrator-name'],
    webRoot: values['web-root'] ? resolve(values['web-root']) : undefined,
  });
  await runtime.start();

  console.log(`supervisor listening on http://${values.host}:${runtime.port}`);
  console.log(`state: ${resolve(values.root!, '.supervisor')}`);

  const shutdown = async (signal: string) => {
    console.log(`\n${signal}: shutting down`);
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
