export {
  StepSchema, InstructionSetSchema, BrowserCrawlerConfigSchema,
  DEFAULT_BROWSER_CRAWLER_CONFIG, BROWSER_CRAWLER_ERROR_CODES,
  type Step, type InstructionSet, type BrowserCrawlerConfig,
  type Target, type BrowserCrawlerErrorCode,
} from "./contracts";

export { loadConfig, deepMerge } from "./config/loader";

export { validateInstructionSet, parseInstructionInput, sha256Of } from "./instructions/validate";

export { runInstructions, StepError, type RunReport, type StepResult, type RenderSection, type BrowserCrawlerCapabilities } from "./runner/runner";

export { PolitenessGate } from "./runner/gate";
export {
  ADVISOR_DECISION_GATES, AdvisorProposalSchema, GoalSpecSchema,
  evaluateGoal, validateGoalSpec, validateAdvisorProposal, applyPatch, summarizeReport,
  type RecipeAdvisor, type AdvisorQuestion, type AdvisorAnswer,
  type AdvisorObservation, type AdvisorProposal, type RecipePatch,
  type GoalSpec, type GoalValidation, type RunReportSummary, type DomHint,
} from "./advisor/contracts";
