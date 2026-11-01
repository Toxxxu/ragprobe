from pathlib import Path

from fastapi import FastAPI
from llama_index.core import Settings, SimpleDirectoryReader, VectorStoreIndex
from llama_index.embeddings.ollama import OllamaEmbedding
from llama_index.llms.ollama import Ollama
from pydantic import BaseModel

DOCS_DIR = Path(__file__).resolve().parent.parent / "docs"

Settings.embed_model = OllamaEmbedding(model_name="nomic-embed-text")
Settings.llm = Ollama(model="llama3.2:3b", request_timeout=120.0, context_window=8192)

documents = SimpleDirectoryReader(str(DOCS_DIR), required_exts=[".md"]).load_data()
engine = VectorStoreIndex.from_documents(documents).as_query_engine(similarity_top_k=5)

app = FastAPI()


class Query(BaseModel):
    question: str


@app.post("/query")
def query(body: Query) -> dict:
    response = engine.query(body.question)
    return {
        "answer": str(response),
        "contexts": [
            {
                "id": Path(node.node.metadata["file_name"]).stem,
                "content": node.node.get_content(),
                "score": node.score,
            }
            for node in response.source_nodes
        ],
    }
