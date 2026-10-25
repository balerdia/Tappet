/**
 * Provider-neutral model interface. Adapters for specific providers implement
 * this; nothing else in the app talks to a model SDK directly. Approved
 * workflows never need a model to run, so swapping or removing a provider
 * can't stop them.
 */
export type ModelMessage = { role: "user" | "assistant"; content: string };

export type CompletionRequest = {
  system?: string;
  messages: ModelMessage[];
  maxTokens: number;
  /** Ask for a single JSON object in the reply. */
  json?: boolean;
};

export type CompletionResult = {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
};

export interface ModelProvider {
  readonly id: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

/** Replays fixed replies. For tests and offline development. */
export function createScriptedProvider(replies: string[]): ModelProvider {
  let i = 0;
  return {
    id: "scripted",
    async complete() {
      const text = replies[Math.min(i++, replies.length - 1)] ?? "";
      return { text, usage: { inputTokens: 0, outputTokens: 0 }, model: "scripted" };
    },
  };
}
