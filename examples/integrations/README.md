# Integrations

ragprobe tests any RAG service that answers one HTTP request:

```http
POST /query  {"question": "..."}
→ {"answer": "...", "contexts": [{"id": "refund-policy", "content": "...", "score": 0.82}]}
```

If your app is built with a framework, wrap it in a small server that returns this shape. The servers here index `examples/docs`, and all of them can run fully offline with Ollama.

| File | Framework |
| --- | --- |
| [langchain_server.py](langchain_server.py) | LangChain retriever + chat model |
| [llamaindex_server.py](llamaindex_server.py) | LlamaIndex query engine |
| [openai_server.py](openai_server.py) | OpenAI SDK, no framework (any OpenAI-compatible API) |

## Run an example

Pull the embedding and chat models, install the dependencies for the server you want, and start it on port 4010 from this folder:

```bash
ollama pull nomic-embed-text
ollama pull llama3.2:3b

# LangChain
pip install fastapi uvicorn langchain-core langchain-ollama
uvicorn langchain_server:app --port 4010

# LlamaIndex
pip install fastapi uvicorn llama-index-core llama-index-llms-ollama llama-index-embeddings-ollama
uvicorn llamaindex_server:app --port 4010
```

The OpenAI example uses the official `openai` package. With an OpenAI account, set your key; the models default to `text-embedding-3-small` and `gpt-4o-mini` and can be changed with `EMBEDDING_MODEL` and `CHAT_MODEL`:

```bash
pip install fastapi uvicorn openai
export OPENAI_API_KEY=sk-...
uvicorn openai_server:app --port 4010
```

It works with any OpenAI-compatible server too. To run it for free against the local Ollama:

```bash
export OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_API_KEY=ollama
export EMBEDDING_MODEL=nomic-embed-text CHAT_MODEL=llama3.2:3b
uvicorn openai_server:app --port 4010
```

In PowerShell, set each variable with `$env:NAME = "value"` instead of `export`.

Then run the usual evaluation from the repository root:

```bash
pnpm run example:eval
```

On a GPU with 8 GB or less, the chat model and the judge model cannot both stay in memory, so Ollama swaps them and some answers take over 30 seconds. Raise the per-call timeout and lower the concurrency when you add the judge:

```bash
pnpm run dev run --dataset examples/dataset.jsonl --endpoint http://localhost:4010/query \
  --judge ollama --timeout 180000 --concurrency 2
```

## Document IDs must match

ragprobe measures retrieval by comparing the `id` of each returned context with `relevantDocIds` in the test set. All examples use the file name without its extension (`refund-policy.md` → `refund-policy`), which is also what `ragprobe generate` writes. If your app splits documents into chunks, return the ID of the source document for each chunk; ragprobe counts repeated IDs once.

## Other stacks

- **Node.js / TypeScript:** skip HTTP and implement the `RagPipeline` interface in-process (see the main README).
- **A different response shape:** pass `mapResponse` to `HttpPipeline` to convert it.
- **Any other language:** any server that implements the endpoint above works.
