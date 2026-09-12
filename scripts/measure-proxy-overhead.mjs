#!/usr/bin/env node
/**
 * Measure the latency the proxy adds on top of GitHub Copilot's native
 * Anthropic endpoint, using the same account, model and prompts for both.
 *
 * Usage (proxy running and authenticated, `npm run build` done):
 *   node scripts/measure-proxy-overhead.mjs
 * Environment:
 *   PROXY_URL         default http://localhost:3000
 *   PROXY_AUTH_TOKEN  proxy secret, if configured
 *   BENCHMARK_MODEL   default claude-sonnet-5 (must be a live catalog ID)
 *   SAMPLES           paired samples per scenario, 1-20 (default 5)
 *
 * The report contains timings only: no prompts, responses or credentials.
 * "Direct" means Copilot's own /v1/messages, not api.anthropic.com. Each
 * scenario costs one Copilot request per endpoint per sample.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const proxyUrl = new URL(process.env.PROXY_URL ?? 'http://localhost:3000');
const model = process.env.BENCHMARK_MODEL ?? 'claude-sonnet-5';
const samples = Math.min(20, Math.max(1, Number(process.env.SAMPLES ?? 5) || 5));

const token = JSON.parse(await readFile(join(homedir(), '.github-copilot-proxy', 'copilot-token.json'), 'utf8'));
const api = new URL(token.endpoints?.api ?? 'https://api.githubcopilot.com');
if (api.protocol !== 'https:') throw new Error('Refusing to send the Copilot token over plain HTTP');
const { buildCopilotHeaders } = await import(pathToFileURL(join(process.cwd(), 'dist', 'utils', 'copilot-headers.js')));

const endpoints = [
  {
    name: 'direct',
    base: api.origin,
    headers: (stream) => ({ ...buildCopilotHeaders(token.token, { stream, hasImages: false }), 'anthropic-version': '2023-06-01' }),
  },
  {
    name: 'proxy',
    base: proxyUrl.origin,
    headers: (stream) => ({
      'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json',
      'anthropic-version': '2023-06-01',
      ...(process.env.PROXY_AUTH_TOKEN ? { 'x-api-key': process.env.PROXY_AUTH_TOKEN } : {}),
    }),
  },
];

const records = 'Read the following synthetic records. Reply with only the value for record 731.\n'
  + Array.from({ length: 1000 }, (_, i) => `record ${i}: value_${i}`).join('\n');
const scenarios = {
  count_tokens: { path: '/v1/messages/count_tokens', body: { model, messages: [{ role: 'user', content: records }] } },
  buffered_message: {
    path: '/v1/messages',
    body: { model, max_tokens: 32, temperature: 0, messages: [{ role: 'user', content: 'Reply with exactly BENCHMARK_OK.' }] },
  },
  streamed_message: {
    path: '/v1/messages',
    body: { model, max_tokens: 32, temperature: 0, stream: true, messages: [{ role: 'user', content: 'Reply with exactly BENCHMARK_OK.' }] },
  },
};

async function measure(endpoint, scenario) {
  const start = performance.now();
  const stream = scenario.body.stream === true;
  const response = await fetch(endpoint.base + scenario.path, {
    method: 'POST', headers: endpoint.headers(stream), body: JSON.stringify(scenario.body),
    signal: AbortSignal.timeout(60_000),
  });
  const headersMs = performance.now() - start;
  let firstEventMs = null;
  if (stream && response.body) {
    // First complete SSE frame (not first bytes), so both endpoints are compared alike.
    let seen = '';
    for await (const chunk of response.body) {
      if (firstEventMs === null) {
        seen += Buffer.from(chunk).toString('utf8');
        if (/\r\n\r\n|\n\n/.test(seen)) firstEventMs = performance.now() - start;
      }
    }
  } else {
    await response.arrayBuffer();
  }
  return { ok: response.ok, status: response.status, headersMs, firstEventMs, totalMs: performance.now() - start };
}

function stats(values) {
  const sorted = values.filter((v) => v !== null).sort((a, b) => a - b);
  const pick = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] : null);
  return {
    n: sorted.length,
    p50: pick(0.5) === null ? null : Math.round(pick(0.5)),
    mean: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
    max: sorted.length ? Math.round(sorted.at(-1)) : null,
  };
}

const results = [];
for (let sample = 1; sample <= samples; sample++) {
  const order = sample % 2 ? endpoints : [...endpoints].reverse();
  for (const [name, scenario] of Object.entries(scenarios)) {
    for (const endpoint of order) {
      try {
        results.push({ sample, scenario: name, endpoint: endpoint.name, ...(await measure(endpoint, scenario)) });
      } catch (error) {
        results.push({ sample, scenario: name, endpoint: endpoint.name, ok: false, error: error.name });
      }
    }
  }
}

const report = {
  model, samplesPerScenario: samples, baseline: 'GitHub Copilot native /v1/messages (same account); not api.anthropic.com',
  scenarios: Object.fromEntries(Object.keys(scenarios).map((name) => {
    const rows = results.filter((r) => r.scenario === name && r.ok);
    const byEndpoint = Object.fromEntries(endpoints.map((e) => {
      const own = rows.filter((r) => r.endpoint === e.name);
      return [e.name, {
        failures: results.filter((r) => r.scenario === name && r.endpoint === e.name && !r.ok).length,
        totalMs: stats(own.map((r) => r.totalMs)),
        firstEventMs: name === 'streamed_message' ? stats(own.map((r) => r.firstEventMs)) : undefined,
      }];
    }));
    const paired = results.filter((r) => r.scenario === name && r.endpoint === 'proxy' && r.ok).map((proxy) => {
      const direct = results.find((r) => r.scenario === name && r.endpoint === 'direct' && r.sample === proxy.sample && r.ok);
      return direct ? proxy.totalMs - direct.totalMs : null;
    });
    return [name, { ...byEndpoint, pairedOverheadMs: stats(paired) }];
  })),
  note: 'Overhead = proxy total minus direct total for the same sample; network jitter dominates small samples.',
};
console.log(JSON.stringify(report, null, 2));
