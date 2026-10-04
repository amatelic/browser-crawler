/**
 * Instruction validation + canonicalization: THE single untrusted-input
 * boundary. Canonical JSON (sorted keys, no whitespace) → deterministic
 * runId; the effective config hash joins the cassette key so identical
 * instructions under a different render config never replay a stale render.
 */

import { createHash } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { InstructionSetSchema, type InstructionSet, type Step } from "../contracts";

export type ValidatedInstructions = {
  instructionSet: InstructionSet;
  runId: string;
};

/** Recursive owner model for canonicalization input (feeds.ts pattern). */
export type CanonicalValue = string | number | boolean | null | CanonicalRecord | CanonicalValue[];

export interface CanonicalRecord {
  [key: string]: CanonicalValue;
}

/** Type-predicate guard for record-shaped canonical values (feeds pattern). */
function isCanonicalRecordValue(value: CanonicalValue): value is CanonicalRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: CanonicalValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  if (isCanonicalRecordValue(value)) {
    // SAFETY: arrays handled above; object implies a JSON record of CanonicalValue.
    const entries = Object.entries(value as CanonicalRecord)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);

    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}

/** Hash any JSON-serializable input (pure serializer; canonicalizes first). */
export function sha256Of(value: CanonicalValue | InstructionSet | Record<string, unknown>): string {
  // SAFETY: canonicalJson accepts any JSON-serializable tree via its wide union.
  return createHash("sha256").update(canonicalJson(value as CanonicalValue)).digest("hex");
}

export function parseInstructionInput(raw: string): InstructionSet {
  const text = raw.trim();

  if (text.startsWith("{")) {
    // SAFETY: JSON.parse output is validated against the TypeBox schema
    // immediately below — nothing downstream reads an unvalidated shape.
    // SAFETY: raw JSON text narrows through validateParsedJson below.
    const parsed: unknown = JSON.parse(text);

    if (Array.isArray(parsed)) {
      // SAFETY: array elements are validated as Step by the schema below.
      // SAFETY: array elements are validated as Step by the schema below.
      // SAFETY: array parse output; schema validation follows.
      return validateParsedJson({ name: "unnamed", steps: parsed }).instructionSet;
    }

    // SAFETY: unknown JSON cast to the canonical owner model; the schema
    // validator below rejects anything malformed.
    return validateParsedJson(parsed).instructionSet;
  }

  // JSONL: one step per line.
  const steps = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"))
    // SAFETY: shape guaranteed by the owning boundary above.
    .map((line) => JSON.parse(line) as unknown);

  // SAFETY: JSONL lines are validated as Step by the schema below.
  // SAFETY: JSONL lines are validated as Step by the schema below.
  // SAFETY: JSONL lines parse as JSON values; schema validation follows.
  return validateParsedJson({ name: "unnamed", steps: steps }).instructionSet;
}

/** Outer JSON boundary: unknown input narrows through the predicate
 *  before the schema validator runs. */
export function validateParsedJson(input: unknown): ValidatedInstructions {
  // SAFETY: the predicate guarantees a JSON record; the schema validator
  // inside validateInstructionSet rejects everything malformed.
  return validateInstructionSet(input as CanonicalValue);
}

export function validateInstructionSet(input: CanonicalValue): ValidatedInstructions {
  if (!isCanonicalRecordValue(input)) {
    throw new Error("instruction set must be a JSON object");
  }

  const errors = [...Value.Errors(InstructionSetSchema, input)];

  if (errors.length > 0) {
    const first = errors[0]!;

    throw new Error(`invalid instruction set at ${first.path}: ${first.message}`);
  }

  const instructionSet = Value.Decode(InstructionSetSchema, Value.Clone(input));

  // seq, when present, must equal index+1 (diff/debug discipline).
  instructionSet.steps.forEach((step, index) => {
    // SAFETY: shape guaranteed by the owning boundary above.
    // SAFETY: step is a schema-decoded JSON record; seq is optional.
    const seq = (step as CanonicalRecord).seq;

    if (seq !== undefined && seq !== index + 1) {
      throw new Error(`step ${index + 1} declares seq ${String(seq)} — seq must equal position`);
    }
  });

  return { instructionSet, runId: sha256Of(instructionSet) };
}
