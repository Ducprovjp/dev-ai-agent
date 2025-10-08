// lambda/pdf-processor/index.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { S3Client, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const pdf = require('pdf-parse');
const OpenAI = require('openai');
const { Pinecone } = require('@pinecone-database/pinecone');

const s3Client = new S3Client({ region: process.env.AWS_REGION });

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!PINECONE_API_KEY || !PINECONE_INDEX_NAME || !OPENAI_API_KEY) {
  console.error('Missing required environment variables for Pinecone or OpenAI.');
}

const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

exports.handler = async (event) => {
  console.log('Received S3 event:', JSON.stringify(event, null, 2));

  for (const record of event.Records || []) {
    const bucketName = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    if (!key.endsWith('.pdf')) {
      console.log(`Skipping non-PDF file: ${key}`);
      continue;
    }
    if (!key.startsWith('uploads/')) {
      console.log(`Skipping file not in 'uploads/': ${key}`);
      continue;
    }

    console.log(`Processing file: ${bucketName}/${key}`);

    try {
      // 1) Get PDF from S3
      const getObjectCommand = new GetObjectCommand({ Bucket: bucketName, Key: key });
      const { Body } = await s3Client.send(getObjectCommand);
      if (!Body) {
        console.warn(`S3 object body is empty for ${key}.`);
        continue;
      }
      const buffer = await streamToBuffer(Body);

      // 2) Extract text from PDF
      const data = await pdf(buffer);
      const rawText = data.text || '';
      if (!rawText.trim()) {
        console.warn(`No text extracted from PDF: ${key}. Skipping.`);
        continue;
      }
      console.log(`Extracted ${rawText.length} characters from PDF.`);

      // 3) Chunking
      const docs = splitText(rawText, 1000, 200);
      console.log(`Split text into ${docs.length} chunks.`);

      // 4) Create embeddings (batched) using OpenAI SDK
      const vectors = await embedAllChunks(openai, docs, {
        idPrefix: key.replace(/\//g, '_').replace(/\./g, '-'),
        filename: key,
        sourceUrl: `s3://${bucketName}/${key}`,
        model: 'text-embedding-3-small', // 1536 dims
        batchSize: 64,
        maxRetries: 5,
      });
      console.log(`Generated ${vectors.length} embeddings.`);
      if (vectors.length === 0) {
        console.warn(`No vectors generated for ${key}. Skipping upsert.`);
        continue;
      }

      // 5) Upsert into Pinecone in batches
      const index = pinecone.index(PINECONE_INDEX_NAME);
      const batchSize = 100;
      for (let i = 0; i < vectors.length; i += batchSize) {
        const batch = vectors.slice(i, i + batchSize);
        await index.upsert(batch);
        console.log(`Upserted batch ${Math.floor(i / batchSize) + 1} of ${key} (${batch.length} vectors).`);
      }
      console.log(`Successfully upserted ${vectors.length} vectors to Pinecone.`);

      // 6) Optional: delete original PDF
      const deleteObjectCommand = new DeleteObjectCommand({ Bucket: bucketName, Key: key });
      await s3Client.send(deleteObjectCommand);
      console.log(`Deleted original PDF from S3: ${key}`);
    } catch (error) {
      console.error(`Error processing file ${key}:`, error);
      throw error;
    }
  }

  return { statusCode: 200, body: JSON.stringify('PDFs processed successfully!') };
};

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function splitText(text, chunkSize = 1000, overlap = 200) {
  const chunks = [];
  const len = text.length;
  let start = 0;
  while (start < len) {
    const end = Math.min(start + chunkSize, len);
    const chunk = text.slice(start, end);
    chunks.push(chunk);
    if (end === len) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

async function embedAllChunks(openai, chunks, options) {
  const {
    idPrefix,
    filename,
    sourceUrl,
    model = 'text-embedding-3-small',
    batchSize = 64,
    maxRetries = 5,
  } = options || {};

  const vectors = [];
  let i = 0;
  for (let start = 0; start < chunks.length; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize).map((t) => (t || '').trim());
    const indices = batch.map((_, idx) => start + idx);
    const nonEmpty = batch.map((t, idx) => ({ text: t, idx: indices[idx] })).filter((x) => x.text.length > 0);
    if (nonEmpty.length === 0) continue;

    const inputs = nonEmpty.map((x) => x.text);
    const embeddings = await createEmbeddingsWithRetry(openai, model, inputs, maxRetries);

    for (let j = 0; j < embeddings.length; j++) {
      const globalIndex = nonEmpty[j].idx;
      vectors.push({
        id: `${idPrefix}-${globalIndex}`,
        values: embeddings[j],
        metadata: {
          filename,
          chunk_index: globalIndex,
          text: nonEmpty[j].text,
          source_url: sourceUrl,
        },
      });
      i++;
    }
  }
  return vectors;
}

async function createEmbeddingsWithRetry(openai, model, inputs, maxRetries = 5) {
  let attempt = 0;
  let lastErr;
  while (attempt < maxRetries) {
    try {
      const res = await openai.embeddings.create({ model, input: inputs });
      return res.data.map((d) => d.embedding);
    } catch (err) {
      lastErr = err;
      const status = err?.status || err?.response?.status;
      const is429 = status === 429;
      const is5xx = status >= 500 && status < 600;
      if (!(is429 || is5xx)) throw err;
      const backoffMs = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 250, 8000);
      console.warn(`Embeddings retry ${attempt + 1}/${maxRetries} after ${backoffMs}ms due to ${(is429 && '429') || status}.`);
      await new Promise((r) => setTimeout(r, backoffMs));
      attempt++;
    }
  }
  throw lastErr;
}
