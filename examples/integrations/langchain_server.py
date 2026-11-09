import os
from pathlib import Path

from fastapi import FastAPI
from langchain_core.documents import Document
from langchain_core.vectorstores import InMemoryVectorStore
from langchain_ollama import ChatOllama, OllamaEmbeddings
from pydantic import BaseModel

DOCS_DIR = Path(os.environ.get("DOCS_DIR", Path(__file__).resolve().parent.parent / "docs"))
CHUNK_CHARS = 2000


def split_into_chunks(text: str) -> list[str]:
    """Groups paragraphs into chunks of about CHUNK_CHARS characters."""
    chunks: list[str] = []
    current = ""
    for paragraph in text.split("\n\n"):
        if current and len(current) + len(paragraph) > CHUNK_CHARS:
            chunks.append(current)
            current = ""
        current = f"{current}\n\n{paragraph}" if current else paragraph
    if current.strip():
        chunks.append(current)
    return chunks


documents = [
    Document(page_content=chunk, metadata={"id": path.relative_to(DOCS_DIR).with_suffix("").as_posix()})
    for path in sorted(DOCS_DIR.rglob("*.md"))
    for chunk in split_into_chunks(path.read_text(encoding="utf-8"))
]
retriever = InMemoryVectorStore.from_documents(
    documents, OllamaEmbeddings(model="nomic-embed-text")
).as_retriever(search_kwargs={"k": 5})
llm = ChatOllama(model="llama3.2:3b", temperature=0)

app = FastAPI()


class Query(BaseModel):
    question: str


@app.post("/query")
def query(body: Query) -> dict:
    docs = retriever.invoke(body.question)
    context = "\n\n".join(doc.page_content for doc in docs)
    answer = llm.invoke(
        f"Answer the question using only this context.\n\n{context}\n\nQuestion: {body.question}"
    ).content
    return {
        "answer": answer,
        "contexts": [{"id": doc.metadata["id"], "content": doc.page_content} for doc in docs],
    }
