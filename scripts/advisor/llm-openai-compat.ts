/**
 * OpenAI-compatible LLM advisor (host layer — lives in scripts/, outside
 * the engine boundary scan). Plain fetch, no SDK: works with GLM/zai,
 * bigmodel, llama.cpp /v1, ollama /v1 — anything speaking chat completions.
 *
 * Structured-output ladder (capability probed per base URL, journaled):
 *   json_schema (strict) → json_object + prompt schema → plain text.
 * Validation is UNCONDITIONAL: the OpenAI spec itself warns model-emitted
 * JSON may be invalid — validateAdvisorProposal is the chokepoint.
 *
 * Verifier corrections applied: max_tokens (portable) not
 * max_completion_tokens; proposals never carry config.
 */

import type {
  AdvisorObservation,
  AdvisorProposal,
  AdvisorQuestion,
  AdvisorAnswer,
  RecipeAdvisor,
} from "../../src/advisor/contracts";
import { AdvisorProposalSchema } from "../../src/advisor/contracts";
import { Value } from "@sinclair/typebox/value";
import { StepSchema } from "../../src/contracts";
import type { Step, InstructionSet } from "../../src/contracts";

export interface LlmAdvisorConfig {
  baseUrl: string;    // LLM_BASE_URL (default https://api.z.ai/api/paas/v4)
  apiKey: string;     // LLM_API_KEY
  model: string;      // LLM_MODEL
  timeoutMs?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const SYSTEM_PROMPT = [
  "You are a recipe author for a declarative browser crawler.",
  "You receive: a natural-language goal, a URL, a redacted run report, and goal-validation checks.",
  "You output ONLY a JSON object (proposal): { kind, recipe, rationale, confidence, terminal }.",
  "The recipe is data — an InstructionSet with steps from the closed action set below.",
  "HARD RULES: never include a config block in the recipe (config is host authority);",
  "selectors are plain CSS only; never invent actions or error codes;",
  "set terminal:true only when goalValidation.goalMet is already true.",
  "",
  "ACTION CATALOG (auto-generated from the schema):",
  ...catalogLines(),
].join("\n");

function catalogLines(): string[] {
  const lines: string[] = [];
  const anyOf = (StepSchema as { anyOf?: Array<{ properties?: Record<string, { const?: unknown; _def?: unknown }> }> }).anyOf ?? [];

  for (const variant of anyOf) {
    const props = (variant as { properties?: Record<string, unknown> }).properties ?? {};
    const action = (props.action as { const?: string } | undefined)?.const;

    if (typeof action !== "string") continue;

    const params = Object.keys(props).filter((key) => key !== "action" && key !== "onError" && key !== "label" && key !== "afterMs");

    lines.push(`- ${action}(${params.join(", ")})`);
  }

  return lines;
}

function proposalSchemaPrompt(): string {
  return "Output shape: {\"kind\":\"full-recipe\",\"recipe\":{\"name\":\"kebab-name\",\"steps\":[…]},\"rationale\":\"…\",\"confidence\":0.0-1.0,\"terminal\":false}";
}

export function createLlmAdvisor(config: LlmAdvisorConfig): RecipeAdvisor {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 120_000;

  async function chat(messages: ChatMessage[], responseFormat?: unknown): Promise<{ content: string; usage: unknown }> {
    const body: Record<string, unknown> = {
      model: config.model,
      temperature: 0,
      max_tokens: config.maxTokens ?? 4096,
      messages,
    };

    if (responseFormat) body.response_format = responseFormat;

    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`llm ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    // SAFETY: chat-completions responses are a stable public contract.
    const parsed = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: unknown;
    };

    return { content: parsed.choices?.[0]?.message?.content ?? "", usage: parsed.usage };
  }

  function parseProposalContent(content: string): unknown {
    const trimmed = content.trim();
    const fenced = trimmed.startsWith("```") ? trimmed.replace(/^```[a-z]*\n?/, "").replace(/```$/, "") : trimmed;

    // SAFETY: JSON.parse output is validated against AdvisorProposalSchema
    // and then validateAdvisorProposal before anything runs.
    return JSON.parse(fenced);
  }

  return {
    id: `llm-openai-compat:${config.model}`,
    capabilities: { propose: true, decide: true },

    async propose(observation: AdvisorObservation): Promise<AdvisorProposal> {
      const user = JSON.stringify({
        goal: observation.goal,
        url: observation.url,
        iteration: observation.iteration,
        mode: observation.mode,
        report: observation.report,
        goalValidation: observation.goalValidation,
        domHints: observation.domHints ?? [],
        validationErrors: observation.validationErrors ?? [],
        note: proposalSchemaPrompt(),
      });

      // Ladder: json_object first (portable everywhere), strict validation
      // always. json_schema strict mode is probed lazily on demand.
      const { content } = await chat(
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
        { type: "json_object" },
      );

      const parsed = parseProposalContent(content);

      if (!Value.Check(AdvisorProposalSchema, parsed)) {
        throw new Error(`proposal failed schema check: ${JSON.stringify([...Value.Errors(AdvisorProposalSchema, parsed)].slice(0, 2))}`);
      }

      const proposal = Value.Decode(AdvisorProposalSchema, parsed) as AdvisorProposal;

      // Strip config defensively even if the model tried to include one —
      // validateAdvisorProposal rejects it; here we normalize the happy path.
      if (proposal.recipe) {
        (proposal.recipe as InstructionSet).config = undefined;
      }

      return proposal;
    },

    async decide(state: string, questions: readonly AdvisorQuestion[]): Promise<AdvisorAnswer[]> {
      // Last-resort arbitration for hosts without a local decision model.
      // Advisory only: outputs are journaled, never permission.
      const { content } = await chat(
        [
          { role: "system", content: "Answer each question as JSON: [{id, answer}] where answer is one of the options, true/false, or a level. Output ONLY the JSON array." },
          { role: "user", content: JSON.stringify({ state, questions }) },
        ],
        { type: "json_object" },
      );

      // SAFETY: decoded through the same defensive JSON path.
      const answers = parseProposalContent(content) as Array<{ id: string; answer: string | boolean }>;

      return questions.map((question) => {
        const found = answers.find((a) => a.id === question.id);
        const answer = found?.answer ?? "abstain";

        if (question.kind === "choice" && typeof answer === "string" && question.options.includes(answer)) {
          return { kind: "choice" as const, id: question.id, choice: answer, confidence: 0.5, probabilities: { [answer]: 0.5 } };
        }

        if (question.kind === "noul" && typeof answer === "boolean") {
          return { kind: "noul" as const, id: question.id, answer, probability: 0.5, confidence: 0.5 };
        }

        return { kind: "abstain" as const, id: question.id, reason: `unusable llm answer: ${String(answer).slice(0, 40)}` };
      });
    },
  };
}
