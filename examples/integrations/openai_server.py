import math
import os
from pathlib import Path

from fastapi import FastAPI
from openai import OpenAI
from pydantic import BaseModel

DOCS_DIR = Path(__file__).resolve().parent.parent / "docs"
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "text-embedding-3-small")
CHAT_MODEL = os.environ.get("CHAT_MODEL", "gpt-4o-mini")
TOP_K = 5
SYSTEM_PROMPT = (
    "Answer the question using only the provided context. "
    "If the context does not contain the answer, say that you don't know."
)

client = OpenAI()


def embed(texts: list[str]) -> list[list[float]]:
    response = client.embeddings.create(model=EMBEDDING_MODEL, input=texts)
    return [item.embedding for item in response.data]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    return dot / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)))


documents = {path.stem: path.read_text(encoding="utf-8").strip() for path in sorted(DOCS_DIR.glob("*.md"))}
doc_vectors = dict(zip(documents, embed(list(documents.values()))))

app = FastAPI()


class Query(BaseModel):
    question: str


@app.post("/query")
def query(body: Query) -> dict:
    question_vector = embed([body.question])[0]
    scores = {doc_id: cosine(question_vector, vector) for doc_id, vector in doc_vectors.items()}
    top_ids = sorted(scores, key=scores.get, reverse=True)[:TOP_K]

    context = "\n\n".join(documents[doc_id] for doc_id in top_ids)
    completion = client.chat.completions.create(
        model=CHAT_MODEL,
        temperature=0,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Context:\n{context}\n\nQuestion: {body.question}"},
        ],
    )
    return {
        "answer": completion.choices[0].message.content,
        "contexts": [{"id": doc_id, "content": documents[doc_id], "score": scores[doc_id]} for doc_id in top_ids],
    }
