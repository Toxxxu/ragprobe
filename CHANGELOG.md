# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.1] - 2026-11-01

### Added

- Package metadata (repository, homepage, issue tracker) and a `prepublishOnly` check that cleans, type-checks, tests, and builds before every publish.
- End-to-end tests for the CLI: exit codes, report files, the quality gate, and `compare`.
- Issue templates for bug reports and feature requests.

### Changed

- Retrieval metric functions accept relevant IDs as an array as well as a `Set`.
- The README starts with installing from the package registry instead of cloning the repository.

## [0.3.0] - 2026-11-01

### Added

- OpenAI example server that works with the OpenAI API or any OpenAI-compatible server, including Ollama.

### Changed

- `ragprobe generate` writes questions the way users ask them instead of copying the documents' wording, and every second question describes only the user's situation. On the demo documents, keyword search now finds 56–63% of them instead of 100%.
- The judge scores a true answer to a different question as not relevant, and scores hedged answers on the answer they give.
- `compare` lists each changed case once, with all of its changes.

### Fixed

- The LlamaIndex example no longer crashes Ollama by requesting the model's full context window.
- CI no longer hangs while waiting for the demo server, and every job has a 10-minute timeout.

## [0.2.0] - 2026-11-01

### Added

- `ragprobe generate` drafts a test set from a folder of `.md`, `.mdx`, and `.txt` documents.
- `ragprobe compare` and `run --baseline` show which metrics and cases got better or worse; `--max-drop` fails the run on a regression.
- GitHub Action (`uses: Toxxxu/ragprobe@<version>`) that runs an evaluation as a CI step.
- LangChain and LlamaIndex example servers.
- Relevance column in the weakest-cases table.

### Changed

- The judge scores faithfulness and relevance independently: an incomplete but correct answer is faithful, and "I don't know" is not relevant.
- The judge model is loaded before the run starts, so a cold start no longer times out every judge call.
- Network failures name the URL and the cause (for example `ECONNREFUSED`) instead of "fetch failed".

### Fixed

- A `--` forwarded by `pnpm run` no longer causes quality-gate flags to be ignored.

## 0.1.0 - 2026-11-01

### Added

- `ragprobe run`: retrieval metrics (recall, precision, hit rate, MRR, nDCG), an optional local LLM judge for faithfulness and relevance, a quality gate, and Markdown and JSON reports.
- HTTP pipeline adapter and an in-process `RagPipeline` interface.
- Demo RAG server, example dataset, and Docker Compose setup for Ollama.

[Unreleased]: https://github.com/Toxxxu/ragprobe/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/Toxxxu/ragprobe/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Toxxxu/ragprobe/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Toxxxu/ragprobe/releases/tag/v0.2.0
