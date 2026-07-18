/**
 * Kimi K3 integration via Cloudflare Workers AI.
 *
 * The model `moonshotai/kimi-k3` is a hosted Workers AI text-generation model
 * (Chat Completions format, 1M-token context). It is invoked through the
 * `AI` binding declared in wrangler.toml:
 *
 *   [ai]
 *   binding = "AI"
 *
 * and surfaced on Env as `env.AI` (typed by @cloudflare/workers-types `Ai`).
 */

export const KIMI_K3_MODEL = "moonshotai/kimi-k3";

export interface KimiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface KimiChatOptions {
  messages: KimiMessage[];
  /** Optional system prompt prepended to the conversation. */
  system?: string;
  /** Sampling temperature (0–1). Lower = more deterministic. */
  temperature?: number;
  max_tokens?: number;
}

export interface KimiChatResult {
  model: string;
  response: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

/**
 * Send a chat request to Kimi K3 through the Workers AI binding.
 *
 * @param ai  The `AI` binding from the Worker environment (`env.AI`).
 * @param options  Messages + optional sampling controls.
 */
export async function chatWithKimiK3(
  ai: Ai,
  options: KimiChatOptions,
): Promise<KimiChatResult> {
  const messages: KimiMessage[] = [];
  if (options.system) {
    messages.push({ role: "system", content: options.system });
  }
  messages.push(...options.messages);

  const result = (await ai.run(KIMI_K3_MODEL, {
    messages,
    temperature: options.temperature,
    max_tokens: options.max_tokens,
  })) as {
    response?: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  } & Record<string, unknown>;

  return {
    model: KIMI_K3_MODEL,
    response: result.response ?? (typeof result === "object" ? JSON.stringify(result) : String(result)),
    usage: result.usage ?? null,
  };
}
