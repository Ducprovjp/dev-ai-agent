// lambda/query-handler/index.js
const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });

exports.handler = async (event) => {
  try {
    if (!OPENAI_API_KEY || !PINECONE_API_KEY || !PINECONE_INDEX_NAME) {
      return response(500, { message: 'Missing required environment variables' });
    }

    if (event.httpMethod && event.httpMethod !== 'POST') {
      return response(405, { message: 'Method Not Allowed' });
    }

    const body = parseBody(event.body);
    const query = (body.query || '').trim();
    const topK = Number(body.topK || 5);
    const namespace = body.namespace || undefined;

    if (!query) {
      return response(400, { message: 'Missing query' });
    }

    // 1) Embed the user query
    const embeddingRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    });
    const vector = embeddingRes.data[0].embedding;

    // 2) Query Pinecone for similar chunks
    const index = pinecone.index(PINECONE_INDEX_NAME);
    const search = await index.query(
      {
        topK,
        vector,
        includeMetadata: true,
      },
      namespace
    );

    const matches = (search.matches || []).filter(m => !!m?.metadata?.text);
    const contextText = matches
      .map((m, i) => `[#${i + 1}] (score=${m.score?.toFixed(3)})\n${(m.metadata.text || '').slice(0, 1500)}`)
      .join('\n\n');

    // 3) Ask LLM with retrieved context (simple RAG)
    const system = 'Bạn là trợ lý AI trả lời ngắn gọn, chính xác bằng tiếng Việt dựa trên ngữ cảnh được cung cấp. Nếu không đủ ngữ cảnh, hãy nói không chắc chắn.';
    const user = `Câu hỏi: ${query}\n\nNgữ cảnh liên quan:\n${contextText || '(không có)'}\n\nYêu cầu: Trả lời dựa vào ngữ cảnh ở trên. Nếu thiếu, nêu rõ là có thể không chính xác.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });

    const answer = completion.choices?.[0]?.message?.content?.trim() || '';

    return response(200, {
      answer,
      matches: matches.map((m) => ({
        id: m.id,
        score: m.score,
        filename: m.metadata?.filename,
        chunk_index: m.metadata?.chunk_index,
        source_url: m.metadata?.source_url,
      })),
    });
  } catch (err) {
    console.error('Query handler error:', err);
    return response(500, { message: 'Internal Server Error', error: String(err) });
  }
};

function parseBody(body) {
  if (!body) return {};
  try {
    return typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return {};
  }
}

function response(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(payload),
  };
}

