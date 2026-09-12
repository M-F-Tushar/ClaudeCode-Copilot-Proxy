#!/usr/bin/env node

/**
 * CLI entry point for claudecode-copilot-proxy
 * Usage: claudecode-copilot-proxy [start|--help|--version]
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
const command = args[0] || 'start';

// Read package.json for version
const packageJsonPath = join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

if (command === '--version' || command === '-v') {
  console.log(`claudecode-copilot-proxy v${packageJson.version}`);
  process.exit(0);
}

if (command === '--help' || command === '-h') {
  console.log(`
claudecode-copilot-proxy v${packageJson.version}

A proxy server that enables Claude Code and Cursor IDE to use GitHub Copilot's AI models.

Usage:
  claudecode-copilot-proxy [command]

Commands:
  start       Start the proxy server (default)
  --version   Show version number
  --help      Show this help message

Configuration:
  PORT        Server port (default: 3000)

Example:
  claudecode-copilot-proxy start
  PORT=8080 claudecode-copilot-proxy

After starting, visit http://localhost:3000 to authenticate with GitHub.

Documentation: ${packageJson.homepage}
`);
  process.exit(0);
}

if (command === 'start' || !command.startsWith('-')) {
  // Import and start the server
  const serverPath = join(__dirname, '..', 'dist', 'index.js');
  await import(pathToFileURL(serverPath).href);
}
