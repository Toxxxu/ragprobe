from pathlib import Path

from fastapi import FastAPI
from langchain_core.documents import Document
from langchain_core.vectorstores import InMemoryVectorStore
from langchain_ollama import ChatOllama, OllamaEmbeddings
from pydantic import BaseModel

DOCS_DIR = Path(__file__).resolve().parent.parent / "docs"

documents = [
    Document(page_content=path.read_text(encoding="utf-8"), metadata={"id": path.stem})
    for path in sorted(DOCS_DIR.glob("*.md"))
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
