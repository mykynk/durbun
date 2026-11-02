#!/usr/bin/env node
/** `npm run app`: run the Mac app from the checkout (uses <repo>/dist/server.mjs and dist/ui). */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { appDir, buildApp, ensureBundles, ensureDeps } from './prepare.mjs';

ensureDeps();
ensureBundles();
buildApp();

const require = createRequire(import.meta.url);
const electron = require('electron'); // path of the Electron binary (downloaded on first use)
const child = spawn(electron, ['.', ...process.argv.slice(2)], { cwd: appDir, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
