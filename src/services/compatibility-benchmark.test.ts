import fetch from 'node-fetch';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { AnthropicMessage, AnthropicMessageRequest, TextBlock, ToolUseBlock } from '../types/anthropic.js';

// Opt in explicitly; model IDs and credentials are validated only inside the live test.
const benchmark = process.env.RUN_COMPATIBILITY_BENCHMARK === 'true' ? describe : describe.skip;
const MAX_SAMPLES = 10;
const MAX_TIMEOUT_MS = 30_000;
const DIRECT_URL = 'https://api.anthropic.com/v1/messages';
const MAX_BODY_BYTES = 1024 * 1024;
type EndpointName = 'direct' | 'proxy';
type Scenario = 'text' | 'tool_loop';
type Block = TextBlock | ToolUseBlock;
type FailureCode = 'timeout' | 'transport' | 'http_status' | 'content_type'
  | 'invalid_sse' | 'invalid_contract' | 'upstream_error' | 'body_limit';

class BenchmarkFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
  }
}

function check(condition: unknown): asserts condition {
  if (!condition) throw new BenchmarkFailure('invalid_contract');
}

function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new BenchmarkFailure('invalid_sse');
  }
}

function tokenCount(value: unknown): number {
  check(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
  return value;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Benchmark configuration requires ${name}`);
  return value;
}

function boundedInteger(name: string, fallback: number, max: number, min = 1): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Benchmark configuration requires ${name} between ${min} and ${max}`);
  }
  return value;
}

function proxyMessagesUrl(base: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error('BENCHMARK_PROXY_URL must be an absolute HTTPS URL or loopback HTTP URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
    || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash) {
    throw new Error('BENCHMARK_PROXY_URL requires HTTPS (except loopback HTTP), without credentials, query or fragment');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/messages`;
  return url.toString();
}

interface Endpoint {
  name: EndpointName;
  url: string;
  key: string;
  model: string;
}

interface RequestSummary {
  phase: 'text' | 'tool_call' | 'tool_result';
  httpStatus: number | null;
  contractSuccess: boolean;
  failure: FailureCode | null;
  returnedModel: string | null;
  messageStartMs: number | null;
  firstFragmentMs: number | null;
  firstFragmentKind: 'text' | 'tool' | null;
  totalLatencyMs: number;
  outputTokens: number | null;
  endToEndOutputTokensPerSecond: number | null;
}

// Only the small text/tool subset exercised here is accepted. No response content is logged.
class MessageCollector {
  readonly blocks: Block[] = [];
  model: string | null = null;
  messageStartMs: number | null = null;
  firstFragmentMs: number | null = null;
  firstFragmentKind: 'text' | 'tool' | null = null;
  outputTokens: number | null = null;
  stopReason: string | null = null;
  complete = false;
  private active: number | null = null;
  private arguments = '';
  private receivedDelta = false;

  constructor(private readonly start: number) {}

  private fragment(kind: 'text' | 'tool', value: string): void {
    if (value.length && this.firstFragmentMs === null) {
      this.firstFragmentMs = performance.now() - this.start;
      this.firstFragmentKind = kind;
    }
  }

  accept(eventName: string, value: unknown): void {
    const event = object(value);
    check(event.type === eventName);
    if (eventName === 'error') throw new BenchmarkFailure('upstream_error');
    if (eventName === 'ping') return;
    check(!this.complete);
    if (eventName === 'message_start') {
      check(this.model === null);
      const message = object(event.message);
      check(message.type === 'message' && message.role === 'assistant');
      check(typeof message.id === 'string' && message.id.length > 0);
      check(typeof message.model === 'string' && message.model.length > 0);
      check(Array.isArray(message.content) && message.content.length === 0);
      tokenCount(object(message.usage).output_tokens);
      this.model = message.model;
      this.messageStartMs = performance.now() - this.start;
      return;
    }
    check(this.model !== null);
    if (eventName === 'content_block_start') {
      check(!this.receivedDelta && this.active === null && event.index === this.blocks.length);
      const block = object(event.content_block);
      if (block.type === 'text') {
        check(typeof block.text === 'string');
        this.blocks.push({ type: 'text', text: block.text });
        this.fragment('text', block.text);
      } else {
        check(block.type === 'tool_use');
        check(typeof block.id === 'string' && block.id.length > 0);
        check(typeof block.name === 'string' && block.name.length > 0);
        check(!this.blocks.some(previous => previous.type === 'tool_use' && previous.id === block.id));
        const input = object(block.input);
        this.blocks.push({ type: 'tool_use', id: block.id, name: block.name, input });
        if (Object.keys(input).length) this.fragment('tool', JSON.stringify(input));
      }
      this.active = this.blocks.length - 1;
      this.arguments = '';
    } else if (eventName === 'content_block_delta') {
      check(this.active !== null && event.index === this.active && !this.receivedDelta);
      const block = this.blocks[this.active];
      const delta = object(event.delta);
      if (block.type === 'text') {
        check(delta.type === 'text_delta' && typeof delta.text === 'string');
        block.text += delta.text;
        this.fragment('text', delta.text);
      } else {
        check(delta.type === 'input_json_delta' && typeof delta.partial_json === 'string');
        this.arguments += delta.partial_json;
        this.fragment('tool', delta.partial_json);
      }
    } else if (eventName === 'content_block_stop') {
      check(this.active !== null && event.index === this.active);
      const block = this.blocks[this.active];
      if (block.type === 'tool_use' && this.arguments.length) {
        check(Object.keys(block.input).length === 0);
        block.input = object(json(this.arguments));
      }
      this.active = null;
    } else if (eventName === 'message_delta') {
      check(this.active === null);
      const delta = object(event.delta);
      check(typeof delta.stop_reason === 'string' && [
        'end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal',
      ].includes(delta.stop_reason));
      this.stopReason = delta.stop_reason;
      const outputTokens = tokenCount(object(event.usage).output_tokens);
      check(this.outputTokens === null || outputTokens >= this.outputTokens);
      this.outputTokens = outputTokens;
      this.receivedDelta = true;
    } else if (eventName === 'message_stop') {
      check(this.active === null && this.receivedDelta);
      this.complete = true;
    } else {
      throw new BenchmarkFailure('invalid_contract');
    }
  }
}

async function consumeSse(body: Readable, collector: MessageCollector): Promise<void> {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let bytes = 0;
  let pendingCR = false;
  let eventName = '';
  let data: string[] = [];

  const line = (value: string): void => {
    if (!value) {
      if (data.length) collector.accept(eventName || 'message', json(data.join('\n')));
      eventName = '';
      data = [];
    } else if (!value.startsWith(':')) {
      const colon = value.indexOf(':');
      const field = colon < 0 ? value : value.slice(0, colon);
      const fieldValue = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') eventName = fieldValue;
      if (field === 'data') data.push(fieldValue);
    }
  };

  const append = (text: string): void => {
    // Normalize CR, LF and split CRLF without damaging UTF-8 across byte chunks.
    for (const char of text) {
      if (pendingCR && char === '\n') {
        pendingCR = false;
        continue;
      }
      pendingCR = char === '\r';
      if (char === '\r' || char === '\n') {
        line(buffer);
        buffer = '';
      } else {
        buffer += char;
      }
    }
  };

  for await (const chunk of body) {
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += chunkBuffer.length;
    if (bytes > MAX_BODY_BYTES) throw new BenchmarkFailure('body_limit');
    append(decoder.write(chunkBuffer));
    if (collector.complete) return;
  }
  append(decoder.end());
  check(collector.complete);
}

async function withDeadline<T>(
  timeoutMs: number,
  cancel: () => void,
  work: () => Promise<T>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new BenchmarkFailure('timeout'));
          cancel();
        }, timeoutMs);
      }),
      work(),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function safeModel(model: string | null, secrets: string[]): string | null {
  if (model === null) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)
    && !secrets.some(secret => model.includes(secret)) ? model : '[redacted]';
}

async function request(
  endpoint: Endpoint,
  payload: Omit<AnthropicMessageRequest, 'model'>,
  phase: RequestSummary['phase'],
  timeoutMs: number,
  secrets: string[]
): Promise<{ summary: RequestSummary; reply?: MessageCollector }> {
  const start = performance.now();
  const collector = new MessageCollector(start);
  const controller = new AbortController();
  let body: Readable | undefined;
  let httpStatus: number | null = null;
  let failure: FailureCode | null = null;
  try {
    await withDeadline(timeoutMs, () => {
      controller.abort();
      body?.destroy();
    }, async () => {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'anthropic-version': '2023-06-01',
          'x-api-key': endpoint.key,
        },
        body: JSON.stringify({ ...payload, model: endpoint.model, stream: true }),
      });
      httpStatus = response.status;
      body = response.body as Readable | undefined;
      if (!response.ok) throw new BenchmarkFailure('http_status');
      if (response.headers.get('content-type')?.split(';')[0].trim() !== 'text/event-stream') {
        throw new BenchmarkFailure('content_type');
      }
      if (!body) throw new BenchmarkFailure('invalid_sse');
      await consumeSse(body, collector);
    });
  } catch (error) {
    // Never expose fetch exceptions, URLs, credentials, generated text or upstream error bodies.
    failure = error instanceof BenchmarkFailure ? error.code : 'transport';
  } finally {
    body?.destroy();
    controller.abort();
  }
  const totalLatencyMs = performance.now() - start;
  const success = failure === null && collector.complete;
  const outputTokens = success ? collector.outputTokens : null;
  return {
    summary: {
      phase,
      httpStatus,
      contractSuccess: success,
      failure,
      returnedModel: safeModel(collector.model, secrets),
      messageStartMs: collector.messageStartMs,
      firstFragmentMs: collector.firstFragmentMs,
      firstFragmentKind: collector.firstFragmentKind,
      totalLatencyMs,
      outputTokens,
      endToEndOutputTokensPerSecond: outputTokens === null || totalLatencyMs <= 0
        ? null : outputTokens * 1000 / totalLatencyMs,
    },
    reply: success ? collector : undefined,
  };
}

interface Sample {
  endpoint: EndpointName;
  scenario: Scenario;
  sample: number;
  taskSuccess: boolean;
  toolSuccess: boolean | null;
  totalTaskLatencyMs: number;
  requests: RequestSummary[];
}

function textMatches(reply: MessageCollector | undefined, expected: string): boolean {
  return reply?.stopReason === 'end_turn'
    && reply.blocks.every(block => block.type === 'text')
    && reply.blocks.map(block => (block as TextBlock).text).join('').trim() === expected;
}

async function runSample(
  endpoint: Endpoint, scenario: Scenario, sample: number, timeoutMs: number, secrets: string[]
): Promise<Sample> {
  const start = performance.now();
  const result: Sample = {
    endpoint: endpoint.name, scenario, sample, taskSuccess: false,
    toolSuccess: scenario === 'text' ? null : false, totalTaskLatencyMs: 0, requests: [],
  };
  const common = { max_tokens: 128, temperature: 0 };
  if (scenario === 'text') {
    const response = await request(endpoint, {
      ...common, messages: [{ role: 'user', content: 'Reply with exactly COMPATIBILITY_OK and no other text.' }],
    }, 'text', timeoutMs, secrets);
    result.requests.push(response.summary);
    result.taskSuccess = textMatches(response.reply, 'COMPATIBILITY_OK');
  } else {
    const messages: AnthropicMessage[] = [{
      role: 'user', content: 'Use add_integers to add 19 and 23, then reply with only the decimal result.',
    }];
    const tools: AnthropicMessageRequest['tools'] = [{
      name: 'add_integers',
      description: 'Return the sum of two integers.',
      input_schema: {
        type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } },
        required: ['a', 'b'], additionalProperties: false,
      },
    }];
    const first = await request(endpoint, {
      ...common, messages, tools, tool_choice: { type: 'tool', name: 'add_integers' },
    }, 'tool_call', timeoutMs, secrets);
    result.requests.push(first.summary);
    const calls = first.reply?.blocks.filter((block): block is ToolUseBlock => block.type === 'tool_use') ?? [];
    const call = calls[0];
    if (first.reply?.stopReason === 'tool_use' && calls.length === 1
      && call.name === 'add_integers' && call.input.a === 19 && call.input.b === 23
      && Object.keys(call.input).length === 2) {
      result.toolSuccess = true;
      const sum = (call.input.a as number) + (call.input.b as number);
      const followup = await request(endpoint, {
        ...common, tools, tool_choice: { type: 'none' },
        messages: [
          ...messages,
          { role: 'assistant', content: first.reply.blocks },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: String(sum) }] },
        ],
      }, 'tool_result', timeoutMs, secrets);
      result.requests.push(followup.summary);
      result.taskSuccess = textMatches(followup.reply, String(sum));
    }
  }
  result.totalTaskLatencyMs = performance.now() - start;
  return result;
}

function distribution(values: Array<number | null>) {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  return {
    count: sorted.length,
    mean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
    p50: sorted.length ? sorted[Math.ceil(sorted.length * 0.5) - 1] : null,
    p95: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
  };
}

function aggregate(samples: Sample[]) {
  return (['direct', 'proxy'] as const).flatMap(endpoint => (['text', 'tool_loop'] as const).map(scenario => {
    const group = samples.filter(sample => sample.endpoint === endpoint && sample.scenario === scenario);
    const requests = group.flatMap(sample => sample.requests);
    const valid = requests.filter(entry => entry.contractSuccess);
    const status429 = requests.filter(entry => entry.httpStatus === 429).length;
    const status5xx = requests.filter(entry => entry.httpStatus !== null && entry.httpStatus >= 500
      && entry.httpStatus < 600).length;
    return {
      endpoint, scenario, samples: group.length, attempts: requests.length,
      httpResponses: requests.filter(entry => entry.httpStatus !== null).length,
      taskSuccessRate: group.filter(entry => entry.taskSuccess).length / group.length,
      toolSuccessRate: scenario === 'text' ? null : group.filter(entry => entry.toolSuccess).length / group.length,
      contractSuccessRate: valid.length / requests.length,
      status429, status5xx,
      http429RatePerAttempt: status429 / requests.length,
      http5xxRatePerAttempt: status5xx / requests.length,
      returnedModels: [...new Set(requests.map(entry => entry.returnedModel).filter(Boolean))],
      totalTaskLatencyMs: distribution(group.map(entry => entry.totalTaskLatencyMs)),
      successfulRequestMetrics: {
        messageStartMs: distribution(valid.map(entry => entry.messageStartMs)),
        firstFragmentMs: distribution(valid.map(entry => entry.firstFragmentMs)),
        totalLatencyMs: distribution(valid.map(entry => entry.totalLatencyMs)),
        endToEndOutputTokensPerSecond: distribution(valid.map(entry => entry.endToEndOutputTokensPerSecond)),
      },
    };
  }));
}

benchmark('opt-in compatibility benchmark', () => {
  test('live A/B text and tool-loop contracts and timings', async () => {
    const samples = boundedInteger('BENCHMARK_SAMPLES', 3, MAX_SAMPLES);
    const timeoutMs = boundedInteger('BENCHMARK_TIMEOUT_MS', 15_000, MAX_TIMEOUT_MS, 1000);
    const endpoints: Endpoint[] = [
      { name: 'direct', url: DIRECT_URL, key: required('ANTHROPIC_API_KEY'), model: required('BENCHMARK_ANTHROPIC_MODEL') },
      {
        name: 'proxy', url: proxyMessagesUrl(process.env.BENCHMARK_PROXY_URL ?? 'http://localhost:3000'),
        key: required('PROXY_AUTH_TOKEN'), model: required('BENCHMARK_PROXY_MODEL'),
      },
    ];
    const secrets = endpoints.map(endpoint => endpoint.key);
    const results: Sample[] = [];
    for (let sample = 1; sample <= samples; sample++) {
      const order = sample % 2 ? endpoints : [...endpoints].reverse();
      for (const scenario of ['text', 'tool_loop'] as const) {
        for (const endpoint of order) results.push(await runSample(endpoint, scenario, sample, timeoutMs, secrets));
      }
    }
    const report = {
      benchmark: 'anthropic-proxy-compatibility', version: 1,
      configuration: {
        samplesPerEndpointPerScenario: samples, timeoutMsPerRequest: timeoutMs,
        maximumRequests: samples * 6, maxTokensPerRequest: 128, temperature: 0,
        requestedModels: Object.fromEntries(endpoints.map(endpoint => [endpoint.name, safeModel(endpoint.model, secrets)])),
        ordering: 'sequential paired scenarios; endpoint order alternates per sample; no retries or warmup',
      },
      definitions: {
        firstFragmentMs: 'Request start to first nonempty text or tool-input fragment; excludes message_start and empty tool start.',
        totalLatencyMs: 'Request start through validated message_stop, or failure; body reads share the request deadline.',
        throughput: 'Final cumulative output_tokens / total request seconds, only for contract-valid requests; not decoding-only speed.',
        toolSuccess: 'Exactly one expected tool call with exact arguments, reconstructed and executed locally.',
        taskSuccess: 'Exact trimmed expected text and end_turn; tool_loop also requires sending tool_result and a valid final reply.',
        rates: 'HTTP 429/5xx rates divide observed statuses by all attempted requests; no retries.',
        quantiles: 'Nearest-rank p50/p95; successful request metrics pool tool-call and followup phases.',
      },
      limitations: [
        'Synthetic text/tool subset only; temperature zero is not a determinism guarantee or evidence of quality parity.',
        'Explicit models may differ; returned IDs do not prove identical weights, routing or model versions.',
        'Small sequential samples include network, queueing, cold starts and provider-specific usage accounting.',
        'Failures and task mismatches are reported, not asserted against either provider; inspect the report manually.',
        'No thinking, images, cache semantics or stop-sequence parity is measured; unsupported stream blocks fail this subset contract.',
        'Live calls consume direct API/Copilot quota; tool execution is local arithmetic only.',
      ],
      aggregates: aggregate(results),
      samples: results,
    };
    // This allowlisted report intentionally excludes endpoints, headers, prompts and response content.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
    expect(results).toHaveLength(samples * 4);
  }, MAX_SAMPLES * 6 * MAX_TIMEOUT_MS + 10_000);
});

describe('offline compatibility benchmark checks', () => {
  function frame(type: string, fields: Record<string, unknown> = {}): string {
    return `event: ${type}\r\ndata: ${JSON.stringify({ type, ...fields })}\r\n\r\n`;
  }
  const start = () => frame('message_start', {
    message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'test-model', content: [], usage: { output_tokens: 1 } },
  });
  const end = () => frame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } })
    + frame('message_stop');

  test('handles byte-split UTF-8 and CRLF; message_start is not TTFT', async () => {
    const collector = new MessageCollector(performance.now());
    collector.accept('message_start', json(start().split('data: ')[1].trim()));
    expect(collector.messageStartMs).not.toBeNull();
    expect(collector.firstFragmentMs).toBeNull();
    const text = frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      + frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'é' } })
      + frame('content_block_stop', { index: 0 }) + end();
    await consumeSse(Readable.from([...Buffer.from(text)].map(byte => Buffer.from([byte]))), collector);
    expect(collector.blocks).toEqual([{ type: 'text', text: 'é' }]);
    expect(collector.firstFragmentKind).toBe('text');
    expect(collector.outputTokens).toBe(4);
  });

  test('reconstructs fragmented tool arguments before tool_result replay', async () => {
    const collector = new MessageCollector(performance.now());
    const text = start()
      + frame('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'tool_1', name: 'add_integers', input: {} } })
      + frame('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":19,' } })
      + frame('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '"b":23}' } })
      + frame('content_block_stop', { index: 0 })
      + frame('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } })
      + frame('message_stop');
    await consumeSse(Readable.from([text]), collector);
    expect(collector.blocks).toEqual([{ type: 'tool_use', id: 'tool_1', name: 'add_integers', input: { a: 19, b: 23 } }]);
    expect(collector.firstFragmentKind).toBe('tool');
  });

  test.each([
    ['missing message_stop', start()],
    ['delta before block start', start() + frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'x' } })],
    ['unclosed block', start() + frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + end()],
    ['duplicate message_start', start() + start()],
    ['wrong block index', start() + frame('content_block_start', { index: 1, content_block: { type: 'text', text: '' } })],
    ['OpenAI terminator', 'data: [DONE]\n\n'],
  ])('rejects invalid lifecycle: %s', async (_label, text) => {
    await expect(consumeSse(Readable.from([text]), new MessageCollector(performance.now()))).rejects.toBeInstanceOf(BenchmarkFailure);
  });

  test('deadline covers a stalled SSE body, not just response headers', async () => {
    const body = new Readable({ read() {} });
    await expect(withDeadline(20, () => body.destroy(), () =>
      consumeSse(body, new MessageCollector(performance.now()))
    )).rejects.toMatchObject({ code: 'timeout' });
    expect(body.destroyed).toBe(true);
  });

  test('restricts proxy transport and redacts unsafe model identifiers', () => {
    expect(proxyMessagesUrl('http://localhost:3000')).toBe('http://localhost:3000/v1/messages');
    expect(proxyMessagesUrl('http://[::1]:3000')).toBe('http://[::1]:3000/v1/messages');
    expect(proxyMessagesUrl('https://proxy.example/prefix/')).toBe('https://proxy.example/prefix/v1/messages');
    for (const url of ['http://remote.example', '******proxy.example', 'https://proxy.example?key=secret', 'file:///etc/passwd']) {
      expect(() => proxyMessagesUrl(url)).toThrow('BENCHMARK_PROXY_URL');
    }
    expect(safeModel('test-model', ['credential'])).toBe('test-model');
    expect(safeModel('echo-credential', ['credential'])).toBe('[redacted]');
    expect(safeModel('untrusted\ncontent', ['credential'])).toBe('[redacted]');
  });
});
