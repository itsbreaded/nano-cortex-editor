'use strict';

// Runs Electron with ELECTRON_RUN_AS_NODE cleared (VS Code's terminal sets it, which makes `electron` behave like
// `node`), on every platform: npm start, npm run test:ux, build:icon, docs:screenshots.
const { spawn } = require('node:child_process');

const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, process.argv.slice(2), {
  env,
  stdio: 'inherit',
});

// Ctrl+C or a kill reaches Electron too, instead of leaving it running without this launcher.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { if (child.exitCode === null && !child.killed) child.kill(signal); });
}

child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
