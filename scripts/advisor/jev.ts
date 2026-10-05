/**
 * JEV advisors (host layer): the local open decision model — calibrated
 * choice/noul/score answers, nothing generated. Two transports:
 *
 *  - embedded: lazy dynamic import of the open-jev npm package (env-gated,
 *    OFF by default; graceful null on platform failure — the native runtime
 *    has no darwin/x64 builds). kev-0.6b: ~383MB first download (q4).
 *  - http: POST /ai/jev/decide against a backend that exposes the generic
 *    decide route (same env gate as the existing pilot surface).
 *
 * Confidence gates mirror the decision gates; low/out-of-option/invalid ⇒
 * ABSTAIN (no signal, never permission).
 */

import type {
  AdvisorAnswer,
  AdvisorQuestion,
  RecipeAdvisor,
} from "../../src/advisor/contracts";
import { ADVISOR_DECISION_GATES } from "../../src/advisor/contracts";

interface JevLikeRuntime {
  decide(state: string, questions: readonly unknown[]): Promise<unknown[]>;
}

interface JevLikeAnswer {
  kind?: string;
  id?: string;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  answer?: boolean;
  probability?: number;
  score?: number;
  normalized?: number;
  level?: string;
}

function gateAnswer(question: AdvisorQuestion, raw: JevLikeAnswer | undefined): AdvisorAnswer {
  if (!raw || typeof raw !== "object") {
    return { kind: "abstain", id: question.id, reason: "no answer" };
  }

  if (question.kind === "choice") {
    const gate = ADVISOR_DECISION_GATES.choice;
    const choice = raw.choice;

    if (typeof choice === "string" && question.options.includes(choice) && (raw.confidence ?? 0) >= gate) {
      return { kind: "choice", id: question.id, choice, confidence: raw.confidence ?? 0, probabilities: raw.probabilities ?? {} };
    }

    return { kind: "abstain", id: question.id, reason: `below gate ${gate} or out-of-options` };
  }

  if (question.kind === "noul") {
    const gate = ADVISOR_DECISION_GATES.noul;

    if (typeof raw.answer === "boolean" && (raw.confidence ?? 0) >= gate) {
      return { kind: "noul", id: question.id, answer: raw.answer, probability: raw.probability ?? raw.confidence ?? 0, confidence: raw.confidence ?? 0 };
    }

    return { kind: "abstain", id: question.id, reason: `below gate ${gate}` };
  }

  const gate = ADVISOR_DECISION_GATES.score;

  if (typeof raw.score === "number" && typeof raw.level === "string" && (raw.confidence ?? 0) >= gate) {
    return { kind: "score", id: question.id, score: raw.score, normalized: raw.normalized ?? 0, level: raw.level, confidence: raw.confidence ?? 0 };
  }

  return { kind: "abstain", id: question.id, reason: `below gate ${gate}` };
}

export function createEmbeddedJevAdvisor(): RecipeAdvisor {
  let runtime: JevLikeRuntime | null | undefined;

  const load = async (): Promise<JevLikeRuntime | null> => {
    if (runtime !== undefined) return runtime;

    if (process.env.BROWSER_CRAWLER_JEV_ENABLED !== "1") {
      runtime = null;

      return null;
    }

    try {
      // Lazy dynamic import: the native runtime chain must never break boot.
      // SAFETY: the module is the open decision-model runtime; its outputs
      // are gated into ABSTAIN below regardless of shape.
      const mod = (await import("open-jev")) as { OpenJev?: { load: (options: unknown) => Promise<JevLikeRuntime> } };
      const model = process.env.JEV_MODEL ?? "kev-0.6b";
      const dtype = process.env.JEV_DTYPE ?? "q4";

      runtime = await mod.OpenJev!.load({ model, device: "cpu", dtype });
    } catch (error) {
      process.stderr.write(`[jev-embedded] unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
      runtime = null;
    }

    return runtime;
  };

  return {
    id: `jev-embedded:${process.env.JEV_MODEL ?? "kev-0.6b"}`,
    capabilities: { propose: false, decide: true },

    async decide(state: string, questions: readonly AdvisorQuestion[]): Promise<AdvisorAnswer[]> {
      const rt = await load();

      if (!rt) return questions.map((q) => ({ kind: "abstain" as const, id: q.id, reason: "jev unavailable" }));

      // SAFETY: raw answers are gated; malformed entries become ABSTAIN.
      const answers = (await rt.decide(state.slice(0, 4000), questions)) as JevLikeAnswer[];

      return questions.map((question, i) => gateAnswer(question, answers[i]));
    },
  };
}

export function createHttpJevAdvisor(baseUrl: string, fetchImpl: typeof fetch = fetch): RecipeAdvisor {
  return {
    id: `jev-http:${baseUrl}`,
    capabilities: { propose: false, decide: true },

    async decide(state: string, questions: readonly AdvisorQuestion[]): Promise<AdvisorAnswer[]> {
      try {
        const response = await fetchImpl(`${baseUrl}/ai/jev/decide`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state: state.slice(0, 4000), questions }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          return questions.map((q) => ({ kind: "abstain" as const, id: q.id, reason: `http ${response.status}` }));
        }

        // SAFETY: gated below; shape failures become ABSTAIN.
        const parsed = (await response.json()) as { answers?: JevLikeAnswer[] };

        return questions.map((question, i) => gateAnswer(question, parsed.answers?.[i]));
      } catch (error) {
        return questions.map((q) => ({ kind: "abstain" as const, id: q.id, reason: error instanceof Error ? error.message.slice(0, 60) : "fetch failed" }));
      }
    },
  };
}
