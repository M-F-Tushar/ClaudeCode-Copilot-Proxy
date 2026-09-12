/**
 * Types for GitHub Copilot's chat completions API.
 *
 * The endpoint (`https://api.githubcopilot.com/chat/completions`) speaks the
 * OpenAI chat completions dialect, including tool calling and SSE streaming,
 * for every model family it exposes (Claude, GPT, Gemini).
 */

/** A text part of a multimodal user message. */
export interface CopilotTextPart {
  type: 'text';
  text: string;
}

/** An image part of a multimodal user message. */
export interface CopilotImagePart {
  type: 'image_url';
  image_url: {
    /** Either an https URL or a `data:<media-type>;base64,<data>` URI. */
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export type CopilotContentPart = CopilotTextPart | CopilotImagePart;

/** A tool call emitted by the model. */
export interface CopilotToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON-encoded arguments. */
    arguments: string;
  };
}

/** A partial tool call as received in a streaming delta. */
export interface CopilotToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface CopilotChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | CopilotContentPart[] | null;
  /** Present on assistant messages that requested tools. */
  tool_calls?: CopilotToolCall[];
  /** Required on `tool` messages, links the result to the originating call. */
  tool_call_id?: string;
}

export interface CopilotTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export type CopilotToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface CopilotChatRequest {
  model: string;
  messages: CopilotChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream?: boolean;
  tools?: CopilotTool[];
  tool_choice?: CopilotToolChoice;
  parallel_tool_calls?: boolean;
}

export interface CopilotChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface CopilotChatChoice {
  index?: number;
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: CopilotToolCall[];
  };
  finish_reason?: string | null;
}

export interface CopilotChatResponse {
  error?: unknown;
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: CopilotChatChoice[];
  usage?: CopilotChatUsage;
}

export interface CopilotChatStreamChoice {
  index?: number;
  delta?: {
    role?: string;
    content?: string | null;
    tool_calls?: CopilotToolCallDelta[];
  };
  finish_reason?: string | null;
}

export interface CopilotChatStreamChunk {
  error?: unknown;
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: CopilotChatStreamChoice[];
  usage?: CopilotChatUsage;
}
