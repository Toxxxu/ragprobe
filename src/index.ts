export type * from './core/types.js';
export { RagprobeError, DatasetError, PipelineError, JudgeError } from './core/errors.js';
export { loadDataset, parseDataset } from './dataset/load.js';
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
export { writeReports } from './report/write.js';
export { VERSION } from './version.js';
