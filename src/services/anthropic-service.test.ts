import { Readable } from 'stream';
import {
  applyStopSequences,
  buildCopilotChatRequest,
  convertCopilotStreamToAnthropicEvents,
  buildToolNameMap,
  convertAnthropicMessagesToCopilot,
  convertAnthropicToolChoiceToCopilot,
  convertAnthropicToolsToCopilot,
  convertCopilotToAnthropicResponse,
  estimateInputTokens,
  extractTextContent,
  flattenToolResultContent,
  mapFinishReasonToStopReason,
  mapStatusToAnthropicErrorType,
  normalizeSystemPrompt,
  parseCopilotSseStream,
  parseToolArguments,
  pendingStopSequenceLength,
  requestHasImages,
  sanitizeToolName,
} from './anthropic-service.js';
import {
  AnthropicMessage, AnthropicMessageRequest, AnthropicStreamEvent, AnthropicTool,
} from '../types/anthropic.js';
import { CopilotChatStreamChunk } from '../types/copilot-chat.js';

describe('Anthropic Service', () => {
  describe('normalizeSystemPrompt', () => {
    it('returns an empty string when no system prompt is given', () => {
      expect(normalizeSystemPrompt(undefined)).toBe('');
    });

    it('passes through a string system prompt', () => {
      expect(normalizeSystemPrompt('be brief')).toBe('be brief');
    });

    it('flattens the array form Claude Code sends', () => {
      expect(
        normalizeSystemPrompt([
          { type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'Follow the repo conventions.' },
        ])
      ).toBe('You are Claude Code.\n\nFollow the repo conventions.');
    });
  });

  describe('extractTextContent', () => {
    it('handles strings, blocks and invalid input', () => {
      expect(extractTextContent('hello')).toBe('hello');
      expect(
        extractTextContent([
          { type: 'text', text: 'a' },
          { type: 'tool_use', id: 't1', name: 'Read', input: {} },
          { type: 'text', text: 'b' },
        ])
      ).toBe('a\nb');
      expect(extractTextContent(undefined)).toBe('');
    });
  });

  describe('convertAnthropicMessagesToCopilot', () => {
    it('prepends the system prompt as a system message', () => {
      const result = convertAnthropicMessagesToCopilot(
        [{ role: 'user', content: 'hi' }],
        'be brief'
      );

      expect(result).toEqual([
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ]);
    });

    it('keeps mid-conversation system messages as system messages', () => {
      const messages: AnthropicMessage[] = [
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'extra instructions' },
        { role: 'system', content: [{ type: 'text', text: 'block form' }] },
      ];

      expect(convertAnthropicMessagesToCopilot(messages)).toEqual([
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'extra instructions' },
        { role: 'system', content: 'block form' },
      ]);
    });

    it('drops empty system messages', () => {
      const messages: AnthropicMessage[] = [
        { role: 'system', content: '' },
        { role: 'system', content: [] },
        { role: 'user', content: 'hi' },
      ];

      expect(convertAnthropicMessagesToCopilot(messages)).toEqual([
        { role: 'user', content: 'hi' },
      ]);
    });

    it('converts assistant tool_use blocks into tool_calls', () => {
      const messages: AnthropicMessage[] = [
        { role: 'user', content: 'read the file' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me look.' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.ts' } },
          ],
        },
      ];

      const result = convertAnthropicMessagesToCopilot(messages);

      expect(result[1]).toEqual({
        role: 'assistant',
        content: 'Let me look.',
        tool_calls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: { name: 'Read', arguments: JSON.stringify({ path: 'a.ts' }) },
          },
        ],
      });
    });

    it('re-orders tool_result blocks into standalone tool messages', () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' },
            { type: 'text', text: 'now summarise it' },
          ],
        },
      ];

      const result = convertAnthropicMessagesToCopilot(messages);

      expect(result.map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
      expect(result[1]).toEqual({
        role: 'tool',
        tool_call_id: 'toolu_1',
        content: 'file contents',
      });
      expect(result[2]).toEqual({ role: 'user', content: 'now summarise it' });
    });

    it('marks failed tool results and never sends empty tool content', () => {
      const result = convertAnthropicMessagesToCopilot([
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true },
            { type: 'tool_result', tool_use_id: 't2', content: '' },
            { type: 'text', text: 'ok' },
          ],
        },
      ]);

      expect(result[0]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'Error: boom' });
      expect(result[1]).toEqual({ role: 'tool', tool_call_id: 't2', content: '(no output)' });
    });

    it('converts base64 images into data URIs', () => {
      const result = convertAnthropicMessagesToCopilot([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
            },
          ],
        },
      ]);

      expect(result[0].content).toEqual([
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ]);
    });

    it('drops empty assistant turns and thinking blocks', () => {
      const result = convertAnthropicMessagesToCopilot([
        { role: 'assistant', content: '' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] },
        { role: 'user', content: 'hi' },
      ]);

      expect(result).toEqual([{ role: 'user', content: 'hi' }]);
    });
  });

  describe('tool definitions', () => {
    const tools: AnthropicTool[] = [
      {
        name: 'mcp__github__list:issues',
        description: 'List issues',
        input_schema: { type: 'object', properties: { repo: { type: 'string' } } },
      },
    ];

    it('sanitizes names that the upstream API rejects', () => {
      expect(sanitizeToolName('mcp__github__list:issues')).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(sanitizeToolName('a'.repeat(100))).toHaveLength(64);
      expect(sanitizeToolName('Read')).toBe('Read');
    });

    it('avoids replacement, truncation and reserved-namespace collisions deterministically', () => {
      const names = ['a:b', 'a?b', 'a_b', 'a'.repeat(100), 'a'.repeat(99) + 'b', ''];
      names.push(sanitizeToolName('a:b'));
      const sanitized = names.map(sanitizeToolName);
      expect(new Set(sanitized).size).toBe(names.length);
      expect(names.map(sanitizeToolName)).toEqual(sanitized);
      for (const name of sanitized) {
        expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      }
    });

    it('uses the same names in definitions, history and tool_choice and restores history names', () => {
      const name = 'mcp:Read';
      const messages: AnthropicMessage[] = [{
        role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name, input: {} }],
      }];
      const toolChoice = { type: 'tool' as const, name };
      const expected = sanitizeToolName(name);
      expect(convertAnthropicMessagesToCopilot(messages)[0].tool_calls?.[0].function.name)
        .toBe(expected);
      expect(convertAnthropicToolChoiceToCopilot(toolChoice))
        .toEqual({ type: 'function', function: { name: expected } });
      expect(buildToolNameMap(undefined, messages, toolChoice).get(expected)).toBe(name);
    });

    it('converts tools into OpenAI function tools', () => {
      expect(convertAnthropicToolsToCopilot(tools)).toEqual([
        {
          type: 'function',
          function: {
            name: sanitizeToolName(tools[0].name),
            description: 'List issues',
            parameters: { type: 'object', properties: { repo: { type: 'string' } } },
          },
        },
      ]);
      expect(convertAnthropicToolsToCopilot([])).toBeUndefined();
    });

    it('maps sanitized names back to the original names', () => {
      expect(buildToolNameMap(tools).get(sanitizeToolName(tools[0].name))).toBe(
        'mcp__github__list:issues'
      );
    });

    it('converts tool_choice', () => {
      expect(convertAnthropicToolChoiceToCopilot({ type: 'auto' })).toBe('auto');
      expect(convertAnthropicToolChoiceToCopilot({ type: 'any' })).toBe('required');
      expect(convertAnthropicToolChoiceToCopilot({ type: 'none' })).toBe('none');
      expect(convertAnthropicToolChoiceToCopilot({ type: 'tool', name: 'Read' })).toEqual({
        type: 'function',
        function: { name: 'Read' },
      });
      expect(convertAnthropicToolChoiceToCopilot(undefined)).toBeUndefined();
    });
  });

  describe('buildCopilotChatRequest', () => {
    const base: AnthropicMessageRequest = {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1024,
    };

    it('maps the model and forwards sampling parameters', () => {
      const body = buildCopilotChatRequest(
        { ...base, temperature: 0.2, top_p: 0.9, stop_sequences: ['</done>'] },
        { stream: true }
      );

      expect(body.model).toBe('claude-sonnet-5');
      expect(body.stream).toBe(true);
      expect(body.max_tokens).toBe(1024);
      expect(body.temperature).toBe(0.2);
      expect(body.top_p).toBe(0.9);
      expect(body.stop).toEqual(['</done>']);
    });

    it('omits sampling parameters that were not supplied', () => {
      const body = buildCopilotChatRequest(base, { stream: false });

      expect(body.temperature).toBeUndefined();
      expect(body.top_p).toBeUndefined();
      expect(body.stop).toBeUndefined();
      expect(body.tools).toBeUndefined();
    });

    it('only sends tool_choice alongside tools', () => {
      const withoutTools = buildCopilotChatRequest(
        { ...base, tool_choice: { type: 'any' } },
        { stream: false }
      );
      expect(withoutTools.tool_choice).toBeUndefined();

      const withTools = buildCopilotChatRequest(
        {
          ...base,
          tool_choice: { type: 'any' },
          tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} } }],
        },
        { stream: false }
      );
      expect(withTools.tool_choice).toBe('required');
    });

    it('clamps max_tokens to the configured ceiling', () => {
      const body = buildCopilotChatRequest({ ...base, max_tokens: 10_000_000 }, { stream: false });
      expect(body.max_tokens).toBe(64000);
    });

    it.each([true, false])('maps disable_parallel_tool_use=%s', (disabled) => {
      const body = buildCopilotChatRequest({
        ...base,
        tools: [{ name: 'Read', input_schema: { type: 'object' } }],
        tool_choice: { type: 'auto', disable_parallel_tool_use: disabled },
      }, { stream: true });
      expect(body.parallel_tool_calls).toBe(!disabled);
    });
  });

  describe('requestHasImages', () => {
    it('detects image blocks', () => {
      expect(requestHasImages([{ role: 'user', content: 'text only' }])).toBe(false);
      expect(
        requestHasImages([
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }],
          },
        ])
      ).toBe(true);
    });
  });

  describe('convertCopilotToAnthropicResponse', () => {
    it('converts a plain text completion', () => {
      const result = convertCopilotToAnthropicResponse(
        {
          choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        },
        'claude-sonnet-4-5'
      );

      expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
      expect(result.stop_reason).toBe('end_turn');
      expect(result.model).toBe('claude-sonnet-4-5');
      expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
      expect(result.id).toMatch(/^msg_/);
    });

    it('converts tool calls into tool_use blocks and restores tool names', () => {
      const result = convertCopilotToAnthropicResponse(
        {
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'mcp__x_y', arguments: '{"a":1}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        'claude-sonnet-4-5',
        new Map([['mcp__x_y', 'mcp__x:y']])
      );

      expect(result.stop_reason).toBe('tool_use');
      expect(result.content).toEqual([
        { type: 'tool_use', id: 'call_1', name: 'mcp__x:y', input: { a: 1 } },
      ]);
    });

    it('merges text and tool calls that Copilot splits across separate choices', () => {
      // Copilot's Anthropic models return the assistant text in one choice and
      // the tool_calls in another; reading only choices[0] drops the tool call.
      const result = convertCopilotToAnthropicResponse(
        {
          choices: [
            {
              message: { role: 'assistant', content: "I'll check the weather." },
              finish_reason: 'tool_calls',
            },
            {
              message: {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'toolu_abc',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"location":"Paris"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        'claude-opus-5'
      );

      expect(result.stop_reason).toBe('tool_use');
      expect(result.content).toEqual([
        { type: 'text', text: "I'll check the weather." },
        { type: 'tool_use', id: 'toolu_abc', name: 'get_weather', input: { location: 'Paris' } },
      ]);
    });

    it('always returns at least one content block', () => {
      const result = convertCopilotToAnthropicResponse({ choices: [] }, 'claude-sonnet-4-5');
      expect(result.content).toEqual([{ type: 'text', text: '' }]);
    });

    it('reports the actual provider model instead of the requested alias or family', () => {
      const result = convertCopilotToAnthropicResponse({
        model: 'gpt-upstream',
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      }, 'claude-request-alias');
      expect(result.model).toBe('gpt-upstream');
    });

    it('uses the resolved request model when upstream omits model metadata', () => {
      expect(convertCopilotToAnthropicResponse({ choices: [] }, 'resolved-copilot-model').model)
        .toBe('resolved-copilot-model');
    });

    it.each(['{"incomplete":', '[]', '', 'null'])('rejects invalid buffered tool input %s', (raw) => {
      expect(() => convertCopilotToAnthropicResponse({
        choices: [{ message: { tool_calls: [{
          id: 'call_1', type: 'function', function: { name: 'Read', arguments: raw },
        }] }, finish_reason: 'length' }],
      }, 'claude-sonnet-5')).toThrow('tool arguments');
    });

    it('rejects buffered tool calls without an upstream ID', () => {
      expect(() => convertCopilotToAnthropicResponse({
        choices: [{ message: { tool_calls: [{
          id: '', type: 'function', function: { name: 'Read', arguments: '{}' },
        }] } }],
      }, 'claude-sonnet-5')).toThrow('incomplete tool call');
    });

    it('truncates at a stop sequence, which Copilot ignores upstream', () => {
      const result = convertCopilotToAnthropicResponse(
        {
          choices: [
            { message: { role: 'assistant', content: '1, 2, 3, 4, 5, 6' }, finish_reason: 'stop' },
          ],
        },
        'claude-sonnet-5',
        new Map(),
        ['4']
      );

      expect(result.content).toEqual([{ type: 'text', text: '1, 2, 3, ' }]);
      expect(result.stop_reason).toBe('stop_sequence');
      expect(result.stop_sequence).toBe('4');
    });
  });

  describe('stop sequence helpers', () => {
    it('cuts at the earliest matching sequence', () => {
      expect(applyStopSequences('abcXdefY', ['Y', 'X'])).toEqual({ text: 'abc', matched: 'X' });
      expect(applyStopSequences('no match here', ['ZZ'])).toEqual({
        text: 'no match here',
        matched: null,
      });
      expect(applyStopSequences('text', undefined)).toEqual({ text: 'text', matched: null });
    });

    it('reports how much text must be withheld mid-stream', () => {
      // 'ST' could still become 'STOP' once the next chunk arrives.
      expect(pendingStopSequenceLength('some ST', ['STOP'])).toBe(2);
      expect(pendingStopSequenceLength('done', ['STOP'])).toBe(0);
      expect(pendingStopSequenceLength('anything', undefined)).toBe(0);
    });
  });

  describe('mapFinishReasonToStopReason', () => {
    it('maps the OpenAI finish reasons', () => {
      expect(mapFinishReasonToStopReason('stop', false)).toBe('end_turn');
      expect(mapFinishReasonToStopReason('length', false)).toBe('max_tokens');
      expect(mapFinishReasonToStopReason('tool_calls', false)).toBe('tool_use');
      expect(mapFinishReasonToStopReason('content_filter', false)).toBe('refusal');
      expect(mapFinishReasonToStopReason(null, false)).toBe('end_turn');
      expect(mapFinishReasonToStopReason('stop', true)).toBe('tool_use');
    });
  });

  describe('parseToolArguments', () => {
    it('parses JSON objects without inventing fallback arguments', () => {
      expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
      expect(parseToolArguments('{}')).toEqual({});
      for (const raw of ['', undefined, 'not json', '[1,2]', 'null', '1', '{"x":']) {
        expect(() => parseToolArguments(raw)).toThrow('invalid or incomplete tool arguments');
      }
    });
  });

  describe('flattenToolResultContent', () => {
    it('flattens nested block content', () => {
      expect(flattenToolResultContent('plain')).toBe('plain');
      expect(flattenToolResultContent(undefined)).toBe('');
      expect(
        flattenToolResultContent([
          { type: 'text', text: 'line 1' },
          { type: 'image', source: { type: 'base64', data: 'AAAA' } },
          { type: 'text', text: 'line 2' },
        ])
      ).toBe('line 1\n[image omitted]\nline 2');
    });
  });

  describe('mapStatusToAnthropicErrorType', () => {
    it('mirrors upstream statuses', () => {
      expect(mapStatusToAnthropicErrorType(400)).toBe('invalid_request_error');
      expect(mapStatusToAnthropicErrorType(401)).toBe('authentication_error');
      expect(mapStatusToAnthropicErrorType(403)).toBe('permission_error');
      expect(mapStatusToAnthropicErrorType(404)).toBe('not_found_error');
      expect(mapStatusToAnthropicErrorType(429)).toBe('rate_limit_error');
      expect(mapStatusToAnthropicErrorType(503)).toBe('overloaded_error');
      expect(mapStatusToAnthropicErrorType(500)).toBe('api_error');
    });
  });

  describe('parseCopilotSseStream', () => {
    async function collect(raw: string | (string | Buffer)[]): Promise<CopilotChatStreamChunk[]> {
      const chunks: CopilotChatStreamChunk[] = [];
      for await (const chunk of parseCopilotSseStream(Readable.from(
        typeof raw === 'string' ? [raw] : raw
      ))) {
        chunks.push(chunk);
      }
      return chunks;
    }

    it('parses data frames and terminates at [DONE]', async () => {
      const raw =
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"b"}}]}\n\n' +
        'data: [DONE]\n\ndata: {"choices":[{"delta":{"content":"ignored"}}]}\n\n';

      const chunks = await collect(raw);

      expect(chunks).toHaveLength(2);
      expect(chunks[0].choices?.[0].delta?.content).toBe('a');
    });

    it('handles CRLF frames and events split across network chunks', async () => {
      const chunks: CopilotChatStreamChunk[] = [];
      const source = Readable.from([
        'data: {"choices":[{"delta":{"con',
        'tent":"split"}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
      ]);

      for await (const chunk of parseCopilotSseStream(source)) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0].choices?.[0].delta?.content).toBe('split');
    });

    it('preserves UTF-8 when every byte arrives in a separate network chunk', async () => {
      const raw = Buffer.from('data: {"choices":[{"delta":{"content":"你好👋"}}]}\n\n' +
        'data: [DONE]\n\n');
      const chunks = await collect([...raw].map((byte) => Buffer.from([byte])));
      expect(chunks[0].choices?.[0].delta?.content).toBe('你好👋');
    });

    it('joins multiline data and accepts comments and bare-CR line endings', async () => {
      const chunks = await collect(': heartbeat\rdata: {"choices":\r' +
        'data: [{"delta":{"content":"hello"}}]}\r\rdata: [DONE]\r\r');
      expect(chunks[0].choices?.[0].delta?.content).toBe('hello');
    });

    it.each([
      'data: {oops\n\ndata: [DONE]\n\n',
      'data: {"choices":[]}',
      'data: {"choices":[]}\n\n',
      'data: {"error":{"message":"private upstream detail"}}\n\n',
      'event: error\ndata: {"message":"private upstream detail"}\n\n',
      'data: null\n\n',
    ])('rejects malformed, errored or truncated SSE without exposing its body', async (raw) => {
      await expect(collect(raw)).rejects.toThrow('Copilot');
      await expect(collect(raw)).rejects.not.toThrow('private upstream detail');
    });

    it('rejects invalid and truncated UTF-8', async () => {
      await expect(collect([Buffer.from([0xff])])).rejects.toThrow('invalid UTF-8');
      await expect(collect([Buffer.from([0xf0, 0x9f])])).rejects.toThrow('incomplete UTF-8');
    });

    it('bounds unterminated events', async () => {
      await expect(collect('data: ' + 'x'.repeat(1024 * 1024))).rejects.toThrow('buffer limit');
    });

    it('destroys the readable after [DONE] or downstream cancellation', async () => {
      const body = Readable.from(['data: {"id":"1"}\n\ndata: [DONE]\n\n']);
      const parser = parseCopilotSseStream(body);
      expect((await parser.next()).value).toEqual({ id: '1' });
      await parser.return(undefined);
      expect(body.destroyed).toBe(true);
      const doneBody = Readable.from(['data: [DONE]\n\n']);
      expect((await parseCopilotSseStream(doneBody).next()).done).toBe(true);
      expect(doneBody.destroyed).toBe(true);
    });
  });

  describe('convertCopilotStreamToAnthropicEvents', () => {
    async function* source(chunks: CopilotChatStreamChunk[]): AsyncGenerator<CopilotChatStreamChunk> {
      for (const chunk of chunks) {
        yield chunk;
      }
    }

    async function collectEvents(chunks: CopilotChatStreamChunk[], toolNameMap?: Map<string, string>) {
      const events: AnthropicStreamEvent[] = [];
      for await (const event of convertCopilotStreamToAnthropicEvents(source(chunks), {
        messageId: 'msg_test',
        model: 'claude-sonnet-5',
        toolNameMap,
      })) {
        events.push(event);
      }
      let openBlock: number | null = null;
      let nextIndex = 0;
      for (const event of events) {
        if (event.type === 'content_block_start') {
          expect(openBlock).toBeNull();
          expect(event.index).toBe(nextIndex++);
          openBlock = event.index;
        } else if (event.type === 'content_block_delta') {
          expect(event.index).toBe(openBlock);
        } else if (event.type === 'content_block_stop') {
          expect(event.index).toBe(openBlock);
          openBlock = null;
        }
      }
      expect(openBlock).toBeNull();
      expect(events[0].type).toBe('message_start');
      expect(events.at(-1)?.type).toBe('message_stop');
      return events;
    }

    it('applies stop sequences split across chunk boundaries', async () => {
      const events = [];
      for await (const event of convertCopilotStreamToAnthropicEvents(
        source([
          { choices: [{ delta: { content: 'keep this ST' } }] },
          { choices: [{ delta: { content: 'OP drop this' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
        { messageId: 'msg_test', model: 'claude-sonnet-5', stopSequences: ['STOP'] }
      )) {
        events.push(event);
      }

      const text = events
        .filter(
          (e): e is Extract<typeof e, { type: 'content_block_delta' }> =>
            e.type === 'content_block_delta'
        )
        .map((d) => ('text' in d.delta ? d.delta.text : ''))
        .join('');

      // 'ST' must be withheld until the next chunk proves it is 'STOP'.
      expect(text).toBe('keep this ');

      const messageDelta = events.find(
        (e): e is Extract<typeof e, { type: 'message_delta' }> => e.type === 'message_delta'
      );
      expect(messageDelta?.delta.stop_reason).toBe('stop_sequence');
      expect(messageDelta?.delta.stop_sequence).toBe('STOP');
    });

    it('flushes withheld text when no stop sequence arrives', async () => {
      const events = [];
      for await (const event of convertCopilotStreamToAnthropicEvents(
        source([
          { choices: [{ delta: { content: 'ends with ST' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
        { messageId: 'msg_test', model: 'claude-sonnet-5', stopSequences: ['STOP'] }
      )) {
        events.push(event);
      }

      const text = events
        .filter(
          (e): e is Extract<typeof e, { type: 'content_block_delta' }> =>
            e.type === 'content_block_delta'
        )
        .map((d) => ('text' in d.delta ? d.delta.text : ''))
        .join('');

      expect(text).toBe('ends with ST');
    });

    it('emits a well-formed text stream', async () => {
      const events = await collectEvents([
        { choices: [{ delta: { role: 'assistant' } }] },
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } },
      ]);

      expect(events.map((e) => e.type)).toEqual([
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);

      const deltas = events.filter(
        (e): e is Extract<typeof e, { type: 'content_block_delta' }> =>
          e.type === 'content_block_delta'
      );
      expect(deltas.map((d) => 'text' in d.delta && d.delta.text)).toEqual(['Hel', 'lo']);

      const messageDelta = events.find(
        (e): e is Extract<typeof e, { type: 'message_delta' }> => e.type === 'message_delta'
      );
      expect(messageDelta?.delta.stop_reason).toBe('end_turn');
      expect(messageDelta?.usage.input_tokens).toBe(7);
    });

    it('streams tool calls as tool_use blocks with input_json_delta', async () => {
      const events = await collectEvents(
        [
          { choices: [{ delta: { content: 'Reading' } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_1', function: { name: 'mcp__x_y', arguments: '{"pa' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ],
        new Map([['mcp__x_y', 'mcp__x:y']])
      );

      // The text block must be closed before the tool block opens.
      expect(events.map((e) => e.type)).toEqual([
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);

      const toolStart = events[4];
      expect(toolStart).toEqual({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'call_1', name: 'mcp__x:y', input: {} },
      });

      const jsonDeltas = events
        .filter(
          (e): e is Extract<typeof e, { type: 'content_block_delta' }> =>
            e.type === 'content_block_delta' && 'partial_json' in e.delta
        )
        .map((e) => ('partial_json' in e.delta ? e.delta.partial_json : ''));
      expect(jsonDeltas.join('')).toBe('{"path":"a.ts"}');

      const messageDelta = events.find(
        (e): e is Extract<typeof e, { type: 'message_delta' }> => e.type === 'message_delta'
      );
      expect(messageDelta?.delta.stop_reason).toBe('tool_use');
    });

    it('emits an empty text block when the model returns nothing', async () => {
      const events = await collectEvents([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);

      expect(events.map((e) => e.type)).toEqual([
        'message_start',
        'content_block_start',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);
    });

    it('maps a truncated completion to max_tokens', async () => {
      const events = await collectEvents([
        { choices: [{ delta: { content: 'partial' } }] },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
      ]);

      const messageDelta = events.find(
        (e): e is Extract<typeof e, { type: 'message_delta' }> => e.type === 'message_delta'
      );
      expect(messageDelta?.delta.stop_reason).toBe('max_tokens');
    });

    it('merges every choice and serializes interleaved tools with choice-scoped indices', async () => {
      const events = await collectEvents([
        { choices: [{ index: 0, delta: { content: 'before' }, finish_reason: 'stop' }] },
        { choices: [
          { index: 1, delta: { tool_calls: [
            { index: 0, id: 'call_', function: { name: 'Re', arguments: '{"a":' } },
          ] } },
          { index: 2, delta: { tool_calls: [
            { index: 0, id: 'call_b', function: { name: 'Other', arguments: '{"b":2}' } },
          ] }, finish_reason: 'tool_calls' },
        ] },
        { choices: [{ index: 3, delta: { content: 'between' }, finish_reason: 'stop' }] },
        { choices: [{ index: 1, delta: { tool_calls: [
          { index: 1, id: 'call_c', function: { name: 'Third', arguments: '{}' } },
          { index: 0, id: 'a', function: { name: 'ad', arguments: '1}' } },
        ] }, finish_reason: 'tool_calls' }] },
        { choices: [{ index: 4, delta: { content: 'after' }, finish_reason: 'stop' }] },
      ]);
      const starts = events.filter((event) => event.type === 'content_block_start');
      expect(starts.map((event) => event.content_block.type)).toEqual([
        'text', 'tool_use', 'tool_use', 'text', 'tool_use', 'text',
      ]);
      expect(starts.filter((event) => event.content_block.type === 'tool_use')
        .map((event) => event.content_block)).toEqual([
        { type: 'tool_use', id: 'call_a', name: 'Read', input: {} },
        { type: 'tool_use', id: 'call_b', name: 'Other', input: {} },
        { type: 'tool_use', id: 'call_c', name: 'Third', input: {} },
      ]);
      expect(events.filter((event) => event.type === 'content_block_delta')
        .map((event) => 'text' in event.delta ? event.delta.text : event.delta.partial_json))
        .toEqual(['before', '{"a":1}', '{"b":2}', 'between', '{}', 'after']);
    });

    it('emits text without reading ahead and closes upstream when the consumer stops', async () => {
      let reads = 0;
      let closed = false;
      async function* incrementalSource(): AsyncGenerator<CopilotChatStreamChunk> {
        try {
          reads++;
          yield { choices: [{ delta: { content: 'first' } }] };
          reads++;
          yield { choices: [{ delta: { content: 'second' }, finish_reason: 'stop' }] };
        } finally {
          closed = true;
        }
      }
      const events = convertCopilotStreamToAnthropicEvents(incrementalSource(), {
        messageId: 'msg_test', model: 'claude-sonnet-5',
      });
      expect((await events.next()).value?.type).toBe('message_start');
      expect((await events.next()).value?.type).toBe('content_block_start');
      expect((await events.next()).value).toMatchObject({
        type: 'content_block_delta', delta: { text: 'first' },
      });
      expect(reads).toBe(1);
      await events.return(undefined);
      expect(closed).toBe(true);
    });

    it('closes the upstream iterator immediately on a local stop', async () => {
      let closed = false;
      let readAfterStop = false;
      async function* stoppedSource(): AsyncGenerator<CopilotChatStreamChunk> {
        try {
          yield { choices: [{ delta: { content: 'ok STOP never' } }] };
          readAfterStop = true;
          yield { choices: [{ finish_reason: 'stop' }] };
        } finally {
          closed = true;
        }
      }
      const events: AnthropicStreamEvent[] = [];
      for await (const event of convertCopilotStreamToAnthropicEvents(stoppedSource(), {
        messageId: 'msg_test', model: 'claude-sonnet-5', stopSequences: ['STOP'],
      })) {
        events.push(event);
      }
      expect(readAfterStop).toBe(false);
      expect(closed).toBe(true);
      expect(events.at(-1)?.type).toBe('message_stop');
    });

    it('preserves withheld text before a tool block', async () => {
      const events: AnthropicStreamEvent[] = [];
      for await (const event of convertCopilotStreamToAnthropicEvents(source([
        { choices: [{ delta: { content: 'keep ST' } }] },
        { choices: [{ delta: { tool_calls: [
          { index: 0, id: 'call_1', function: { name: 'Read', arguments: '{}' } },
        ] }, finish_reason: 'tool_calls' }] },
      ]), { messageId: 'msg_test', model: 'claude-sonnet-5', stopSequences: ['STOP'] })) {
        events.push(event);
      }
      expect(events.filter((event) => event.type === 'content_block_delta')
        .map((event) => 'text' in event.delta ? event.delta.text : '').join('')).toBe('keep ST');
    });

    it.each(['', '{"x":', '[1]', 'null'])('rejects malformed/truncated streamed arguments %s', async (raw) => {
      await expect(collectEvents([
        { choices: [{ delta: { tool_calls: [
          { index: 0, id: 'call_1', function: { name: 'Read', arguments: raw } },
        ] }, finish_reason: 'length' }] },
      ])).rejects.toThrow('tool arguments');
    });

    it('rejects missing tool metadata, duplicate IDs, and unfinished choices', async () => {
      await expect(collectEvents([
        { choices: [{ delta: { tool_calls: [
          { index: 0, function: { arguments: '{}' } },
        ] }, finish_reason: 'tool_calls' }] },
      ])).rejects.toThrow('tool metadata');
      await expect(collectEvents([
        { choices: [{ delta: { tool_calls: [
          { index: 0, id: 'same', function: { name: 'Read', arguments: '{}' } },
          { index: 1, id: 'same', function: { name: 'Read', arguments: '{}' } },
        ] }, finish_reason: 'tool_calls' }] },
      ])).rejects.toThrow('duplicate tool metadata');
      await expect(collectEvents([{ choices: [{ delta: { content: 'cut off' } }] }]))
        .rejects.toThrow('incomplete choice');
      await expect(collectEvents([
        { choices: [{ index: 1, delta: { tool_calls: [
          { index: 0, id: 'c1', function: { name: 'Read', arguments: '{}' } },
        ] } }] },
        { choices: [{ index: 0, finish_reason: 'stop' }] },
      ])).rejects.toThrow('incomplete choice');
    });

    it('bounds argument and deferred-text buffering', async () => {
      const tool: CopilotChatStreamChunk = { choices: [{ delta: { tool_calls: [
        { index: 0, id: 'c1', function: { name: 'Read', arguments: '{' } },
      ] } }] };
      await expect(collectEvents([tool, { choices: [{ delta: { tool_calls: [
        { index: 0, function: { arguments: 'x'.repeat(4 * 1024 * 1024) } },
      ] } }] }])).rejects.toThrow('buffer limit');
      await expect(collectEvents([tool,
        ...Array.from({ length: 5 }, () => ({
          choices: [{ delta: { content: 'x'.repeat(1024 * 1024) } }],
        })),
      ])).rejects.toThrow('buffer limit');
    });

    it('reports the upstream model and otherwise the mapped request model', async () => {
      const upstream = await collectEvents([
        { model: 'gpt-actual', choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] },
      ]);
      expect(upstream[0]).toMatchObject({ message: { model: 'gpt-actual' } });
      const fallback = await collectEvents([{ choices: [{ finish_reason: 'stop' }] }]);
      expect(fallback[0]).toMatchObject({ message: { model: 'claude-sonnet-5' } });
    });

    it('never adds estimates to authoritative usage, even when it arrives before later text', async () => {
      const events = await collectEvents([
        { choices: [{ delta: { content: 'abc' } }],
          usage: { prompt_tokens: 13, completion_tokens: 0 } },
        { choices: [{ delta: { content: 'def' }, finish_reason: 'stop' }] },
      ]);
      expect(events.find((event) => event.type === 'message_delta')?.usage)
        .toEqual({ input_tokens: 13, output_tokens: 0 });
    });

    it('estimates output independently of chunk boundaries and preserves trailing usage', async () => {
      const text = 'const x = "你好👋";';
      const whole = await collectEvents([
        { choices: [{ delta: { content: text }, finish_reason: 'stop' }] },
      ]);
      const fragmented = await collectEvents([
        ...text.split('').map((content) => ({ choices: [{ delta: { content } }] })),
        { choices: [{ finish_reason: 'stop' }] },
      ]);
      expect(whole.find((event) => event.type === 'message_delta')?.usage)
        .toEqual(fragmented.find((event) => event.type === 'message_delta')?.usage);
      const authoritative = await collectEvents([
        { choices: [{ delta: { content: text }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 14, completion_tokens: 8 } },
      ]);
      expect(authoritative.find((event) => event.type === 'message_delta')?.usage)
        .toEqual({ input_tokens: 14, output_tokens: 8 });
    });
  });

  describe('estimateInputTokens', () => {
    it('grows with content and never returns zero', () => {
      expect(estimateInputTokens([], undefined)).toBe(1);

      const small = estimateInputTokens([{ role: 'user', content: 'hi' }]);
      const large = estimateInputTokens([{ role: 'user', content: 'x'.repeat(4000) }]);
      expect(large).toBeGreaterThan(small);
    });

    it('counts the system prompt, tool traffic and tool schemas', () => {
      const withSystem = estimateInputTokens(
        [{ role: 'user', content: 'hi' }],
        [{ type: 'text', text: 'y'.repeat(400) }]
      );
      expect(withSystem).toBeGreaterThan(estimateInputTokens([{ role: 'user', content: 'hi' }]));

      const withTools = estimateInputTokens(
        [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'z'.repeat(400) }],
          },
        ],
        undefined,
        [{ name: 'Read', description: 'd', input_schema: { type: 'object', properties: {} } }]
      );
      expect(withTools).toBeGreaterThan(100);
    });

    it('uses conservative Unicode and code heuristics instead of characters divided by four', () => {
      const unicode = '你好👋'.repeat(100);
      const code = '{}[]();=><'.repeat(100);
      expect(estimateInputTokens([{ role: 'user', content: unicode }]))
        .toBeGreaterThanOrEqual(Buffer.byteLength(unicode));
      expect(estimateInputTokens([{ role: 'user', content: code }]))
        .toBeGreaterThanOrEqual(code.length);
    });
  });
});
