/**
 * Anthropic API Types for Claude Code Compatibility
 * Based on Anthropic Messages API specification
 */

// ============================================================================
// Content Block Types
// ============================================================================

/**
 * Prompt-caching marker, preserved by native routing. The chat translator
 * warns about or rejects it because it cannot preserve cache boundaries.
 */
export interface CacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}

/**
 * Text content block in a message
 */
export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl | null;
}

/**
 * Image content block (base64 or URL)
 */
export interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type?: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data?: string;  // base64 encoded image data
    url?: string;   // URL to image
  };
  cache_control?: CacheControl | null;
}

/**
 * Tool use block - when Claude wants to use a tool
 */
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: CacheControl | null;
}

/**
 * Tool result block - result from a tool execution
 */
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
  cache_control?: CacheControl | null;
}

/**
 * Extended thinking block emitted by reasoning models
 */
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

/**
 * Redacted thinking block
 */
export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

/**
 * Union type for all content block types
 */
export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock;

/**
 * System prompt: either a plain string or an array of text blocks.
 * Claude Code sends an array of text blocks (with cache_control markers).
 */
export type AnthropicSystemPrompt = string | TextBlock[];

// ============================================================================
// Message Types
// ============================================================================

/**
 * A message in the conversation.
 *
 * `system` is only valid under the `mid-conversation-system-2026-04-07` beta,
 * which Claude Code uses to append instructions after the initial user turn.
 */
export interface AnthropicMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

/**
 * Tool definition for function calling
 */
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  cache_control?: CacheControl | null;
}

/**
 * How the model should decide to use tools
 */
export type AnthropicToolChoice =
  | { type: 'auto'; disable_parallel_tool_use?: boolean }
  | { type: 'any'; disable_parallel_tool_use?: boolean }
  | { type: 'none' }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean };

/**
 * Extended thinking configuration
 */
export interface AnthropicThinkingConfig {
  type: 'enabled' | 'disabled' | 'adaptive';
  budget_tokens?: number;
}

// ============================================================================
// Request Types
// ============================================================================

/**
 * Request body for POST /v1/messages
 */
export interface AnthropicMessageRequest {
  /** The model to use (e.g., claude-opus-4-5-20250514) */
  model: string;
  
  /** Array of messages in the conversation */
  messages: AnthropicMessage[];
  
  /** Maximum tokens to generate */
  max_tokens: number;
  
  /** System prompt (optional) - string or array of text blocks */
  system?: AnthropicSystemPrompt;
  
  /** Sampling temperature (0-1) */
  temperature?: number;
  
  /** Top-p sampling */
  top_p?: number;
  
  /** Top-k sampling */
  top_k?: number;
  
  /** Stop sequences */
  stop_sequences?: string[];
  
  /** Whether to stream the response */
  stream?: boolean;
  
  /** Tools available for the model to use */
  tools?: AnthropicTool[];
  
  /** How to handle tool use */
  tool_choice?: AnthropicToolChoice;
  
  /** Preserved by native routing; warned/rejected in chat translation. */
  thinking?: AnthropicThinkingConfig;

  /** Preserved natively; no verified equivalent in the chat translator. */
  cache_control?: CacheControl;
  output_config?: Record<string, unknown>;
  
  /** Metadata for the request */
  metadata?: {
    user_id?: string;
  };
}

/**
 * Request body for POST /v1/messages/count_tokens
 */
export interface AnthropicCountTokensRequest {
  /** Optional for compatibility; the configured default model is used when absent. */
  model?: string;
  messages: AnthropicMessage[];
  system?: AnthropicSystemPrompt;
  tools?: AnthropicTool[];
  thinking?: AnthropicThinkingConfig;
  tool_choice?: AnthropicToolChoice;
}

/**
 * Response body for POST /v1/messages/count_tokens
 */
export interface AnthropicCountTokensResponse {
  input_tokens: number;
}

// ============================================================================
// Response Types
// ============================================================================

/**
 * Reason the model stopped generating
 */
export type AnthropicStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal';

/**
 * Usage statistics for the request
 */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Response from POST /v1/messages (non-streaming)
 */
export interface AnthropicMessageResponse {
  /** Unique message ID */
  id: string;
  
  /** Always "message" */
  type: 'message';
  
  /** Role is always "assistant" for responses */
  role: 'assistant';
  
  /** Content blocks in the response */
  content: ContentBlock[];
  
  /** The model that generated the response */
  model: string;
  
  /** Reason the model stopped generating */
  stop_reason: AnthropicStopReason | null;
  
  /** Stop sequence that was hit, if any */
  stop_sequence: string | null;
  
  /** Token usage statistics */
  usage: AnthropicUsage;
}

// ============================================================================
// Chat translator event types; native routing forwards opaque provider frames.
// ============================================================================

/**
 * Message start event - first event in a stream
 */
export interface MessageStartEvent {
  type: 'message_start';
  message: {
    id: string;
    type: 'message';
    role: 'assistant';
    content: [];
    model: string;
    stop_reason: null;
    stop_sequence: null;
    usage: AnthropicUsage;
  };
}

/**
 * Content block start event
 */
export interface ContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block:
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, never> };
}

/**
 * Content block delta event - incremental text updates
 */
export interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: {
    type: 'text_delta';
    text: string;
  } | {
    type: 'input_json_delta';
    partial_json: string;
  };
}

/**
 * Content block stop event
 */
export interface ContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

/**
 * Message delta event - updates to message metadata
 */
export interface MessageDeltaEvent {
  type: 'message_delta';
  delta: {
    stop_reason: AnthropicStopReason;
    stop_sequence: string | null;
  };
  usage: {
    input_tokens?: number;
    output_tokens: number;
  };
}

/**
 * Message stop event - final event in a stream
 */
export interface MessageStopEvent {
  type: 'message_stop';
}

/**
 * Ping event - keep-alive
 */
export interface PingEvent {
  type: 'ping';
}

/**
 * Error event in stream
 */
export interface StreamErrorEvent {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}

/**
 * Union type for all streaming events
 */
export type AnthropicStreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | PingEvent
  | StreamErrorEvent;

// ============================================================================
// Error Types
// ============================================================================

/**
 * Anthropic API error response
 */
export interface AnthropicError {
  type: 'error';
  error: {
    type: 'invalid_request_error' | 'authentication_error' | 'permission_error' | 
          'not_found_error' | 'rate_limit_error' | 'api_error' | 'overloaded_error';
    message: string;
  };
}

// ============================================================================
// Model Types
// ============================================================================

/**
 * Model information for /v1/models endpoint
 */
export interface AnthropicModel {
  /** Always "model" in the Anthropic API */
  type: 'model';
  id: string;
  display_name: string;
  /** RFC 3339 creation timestamp */
  created_at: string;
}

/**
 * Response from GET /v1/models (Anthropic pagination envelope)
 */
export interface AnthropicModelList {
  data: AnthropicModel[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}
