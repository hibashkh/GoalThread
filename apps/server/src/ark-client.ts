import type { AppConfig } from "./config.js";

/**
 * Minimal direct client for the Ark (BytePlus ModelArk / Volcengine Ark)
 * OpenAI-compatible Chat Completions endpoint.
 *
 * The rest of this platform never talks to Ark directly — the CodexRunner
 * shells out to the `codex` CLI, which owns its own HTTP connection to Ark
 * via `codex-home/config.toml`. GoalThread's Tier 2 classification needs a
 * single structured-JSON call rather than a full agentic coding turn, so
 * this client speaks to the same Ark deployment directly instead, reusing
 * the same ARK_API_KEY / ARK_MODEL / ARK_BASE_URL config — no new provider
 * or credential.
 */

export interface ArkStructuredCallOptions {
  /** Static content first: system instructions, schema, decision rules. */
  systemPrompt: string;
  /** Dynamic content last: thread summaries, the new task text. */
  userPrompt: string;
  schemaName: string;
  schema: Record<string, unknown>;
  timeoutMs?: number;
}

export class ArkCallError extends Error {}

/**
 * Calls Ark's Chat Completions API with `response_format: json_schema` and
 * `strict: true`, and returns the parsed JSON object. Throws ArkCallError on
 * any failure (network, non-2xx, malformed JSON) — callers must treat this
 * as a Tier 2 outage and fall back to Tier 1 signals; this function never
 * retries and never throws anything else.
 */
export async function callArkStructured<T>(
  config: AppConfig,
  options: ArkStructuredCallOptions,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 15_000,
  );
  try {
    const response = await fetch(config.arkBaseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + config.arkApiKey,
      },
      body: JSON.stringify({
        model: config.arkModel,
        messages: [
          { role: "system", content: options.systemPrompt },
          { role: "user", content: options.userPrompt },
        ],
        // json_schema (not json_object) is BytePlus ModelArk's recommended,
        // schema-conformant structured output mode.
        response_format: {
          type: "json_schema",
          json_schema: {
            name: options.schemaName,
            strict: true,
            schema: options.schema,
          },
        },
        // Deliberately no frequency_penalty / presence_penalty: ModelArk's
        // docs flag combining those with json_schema as causing abnormal
        // output.
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ArkCallError(
        "Ark structured call failed with status " + response.status + ": " + detail,
      );
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new ArkCallError("Ark structured call returned no message content");
    }
    try {
      return JSON.parse(content) as T;
    } catch {
      throw new ArkCallError("Ark structured call returned malformed JSON");
    }
  } catch (error) {
    if (error instanceof ArkCallError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ArkCallError("Ark structured call failed: " + message);
  } finally {
    clearTimeout(timeout);
  }
}
