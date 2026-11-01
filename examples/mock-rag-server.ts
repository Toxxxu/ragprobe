/**
 * A deliberately simple RAG service for demos and CI: TF-IDF style keyword
 * retrieval over a tiny corpus and an extractive "answer" (first sentence
 * of the best document). No LLM, no network, fully deterministic.
 *
 *   pnpm run example:server   ->  POST http://localhost:4010/query
 */
import { createServer } from 'node:http';

const CORPUS: Record<string, string> = {
  'refund-policy': 'Customers can request a full refund within 30 days of purchase. Refunds are issued to the original payment method within 5 business days.',
  'shipping-times': 'Standard shipping takes 3 to 5 business days within the EU. Express shipping delivers in 1 to 2 business days for an extra fee.',
  'shipping-international': 'International orders outside the EU ship in 7 to 14 business days. Customs duties are paid by the recipient.',
  'password-reset': 'To reset your password, open Settings, choose Security, and click Reset password. A reset link is emailed and expires after one hour.',
  'two-factor': 'Two-factor authentication can be enabled under Settings, Security. Authenticator apps and hardware keys are supported.',
  'plan-pricing': 'The Pro plan costs 12 euros per month or 120 euros per year. The Team plan costs 20 euros per user per month.',
  'plan-cancel': 'You can cancel a subscription at any time from Billing. Access continues until the end of the current billing period.',
  'data-export': 'Account data can be exported as JSON from Settings, Privacy. Exports are prepared in the background and emailed when ready.',
};

const STOPWORDS = new Set('a an and are as at be by can do does for from how i in is it my of on or the to what when where which who why with you your'.split(' '));

const tokenize = (text: string) =>
  text.toLowerCase().match(/[a-z0-9]+/g)?.filter((t) => !STOPWORDS.has(t)) ?? [];

const docs = Object.entries(CORPUS).map(([id, content]) => ({ id, content, terms: new Set(tokenize(content)) }));
const docFreq = new Map<string, number>();
for (const d of docs) for (const t of d.terms) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
const idf = (t: string) => Math.log((docs.length + 1) / ((docFreq.get(t) ?? 0) + 1)) + 1;

function retrieve(question: string, limit = 5) {
  const q = new Set(tokenize(question));
  return docs
    .map((d) => ({ id: d.id, content: d.content, score: [...q].reduce((s, t) => (d.terms.has(t) ? s + idf(t) : s), 0) }))
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

const PORT = Number(process.env['PORT'] ?? 4010);

createServer((req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/query') return send(404, { error: 'not found' });

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk: string) => (raw += chunk));
  req.on('end', () => {
    let question: unknown;
    try {
      question = (JSON.parse(raw) as { question?: unknown }).question;
    } catch {
      return send(400, { error: 'invalid JSON' });
    }
    if (typeof question !== 'string') return send(400, { error: '"question" must be a string' });

    const contexts = retrieve(question);
    const answer = contexts[0] ? (contexts[0].content.split(/(?<=\.)\s/)[0] ?? '') : "I don't know.";
    send(200, { answer, contexts });
  });
}).listen(PORT, () => console.log(`mock RAG server on http://localhost:${PORT}`));
