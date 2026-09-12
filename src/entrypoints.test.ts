import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = process.cwd();
let fixture: string;

beforeAll(async () => {
  fixture = await mkdtemp(path.join(os.tmpdir(), 'copilot-entrypoint-test-'));
  await mkdir(path.join(fixture, 'bin'));
  await mkdir(path.join(fixture, 'dist'));
  await writeFile(path.join(fixture, 'package.json'), JSON.stringify({
    type: 'module', version: '1.2.3', homepage: 'https://example.com',
  }));
  await writeFile(
    path.join(fixture, 'bin', 'claudecode-copilot-proxy.js'),
    await readFile(path.join(root, 'bin', 'claudecode-copilot-proxy.js'))
  );
  await writeFile(path.join(fixture, 'dist', 'index.js'), 'console.log("ENTRYPOINT_STARTED");\n');
});

afterAll(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

it.each([
  ['--version', 'claudecode-copilot-proxy v1.2.3'],
  ['--help', 'Usage:'],
  ['start', 'ENTRYPOINT_STARTED'],
])('runs the packaged CLI %s with an absolute platform-native entrypoint', async (command, expected) => {
  const { stdout } = await execute(process.execPath, [
    path.join(fixture, 'bin', 'claudecode-copilot-proxy.js'), command,
  ], { cwd: fixture, timeout: 10000 });
  expect(stdout).toContain(expected);
});

it('starts the configured source launcher in ESM mode without existing credentials', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
    scripts: { dev: string };
  };
  const [executable, ...args] = pkg.scripts.dev.split(' ');
  expect(executable).toBe('node');
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: {
      ...process.env,
      HOME: fixture,
      USERPROFILE: fixture,
      NODE_ENV: 'production',
      NODE_OPTIONS: '--max-old-space-size=512 --max-semi-space-size=8',
      HOST: '127.0.0.1',
      PORT: '0',
      LOG_LEVEL: 'info',
      PROXY_AUTH_TOKEN: 'isolated-entrypoint-test-token',
      PROXY_ALLOWED_ORIGINS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timer: NodeJS.Timeout | undefined;
  const closed = once(child, 'close');
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(
        `Source launcher did not start. stdout: ${stdout.slice(-1000)} stderr: ${stderr.slice(-1000)}`
      )), 20000);
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Source launcher exited (${code}): ${stderr}`)));
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.stdout.on('data', chunk => {
        stdout += chunk.toString();
        if (stdout.includes('Server running at http://127.0.0.1:0/')) resolve();
      });
    });
    expect(stdout).not.toContain('Loaded GitHub token');
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await closed;
  }
}, 30000);
