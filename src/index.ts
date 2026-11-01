export type * from './core/types.js';
export { RagprobeError, DatasetError, PipelineError, JudgeError } from './core/errors.js';
export { loadDataset, parseDataset } from './dataset/load.js';
export {
  generateTestCases,
  loadDocuments,
  toJsonl,
  type GenerateOptions,
  type GenerateResult,
  type SourceDocument,
} from './dataset/generate.js';
export { OllamaClient, type OllamaClientOptions, type OllamaChatRequest } from './llm/ollama.js';
export {
  scoreRetrieval,
  recallAtK,
  precisionAtK,
  hitRateAtK,
  reciprocalRank,
  ndcgAtK,
} from './metrics/retrieval.js';
export type { RagPipeline } from './pipeline/types.js';
export { HttpPipeline, type HttpPipelineOptions } from './pipeline/http.js';
export type { Judge, JudgeInput } from './judge/types.js';
export { OllamaJudge, type OllamaJudgeOptions } from './judge/ollama.js';
export { runEvaluation, summarize, type RunOptions } from './runner/runner.js';
export { checkGate, type Thresholds, type GateResult } from './runner/gate.js';
export { renderMarkdown } from './report/markdown.js';
export { writeReports, type ReportExtras, type WrittenReports } from './report/write.js';
export {
  compareReports,
  loadReport,
  renderComparison,
  type Comparison,
  type CompareOptions,
  type MetricChange,
  type CaseChange,
} from './report/compare.js';
export { VERSION } from './version.js';
