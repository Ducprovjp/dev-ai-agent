// lambda/upload-handler/index.js
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET_NAME = process.env.BUCKET_NAME;

exports.handler = async (event) => {
  try {
    if (!BUCKET_NAME) {
      return response(500, { message: 'Missing BUCKET_NAME environment variable' });
    }

    if (event.httpMethod && event.httpMethod !== 'POST') {
      return response(405, { message: 'Method Not Allowed' });
    }

    const body = parseBody(event.body);
    const originalFileName = (body.fileName || 'document.pdf').trim();
    const contentType = (body.contentType || 'application/pdf').trim();

    if (!originalFileName.toLowerCase().endsWith('.pdf')) {
      return response(400, { message: 'Only .pdf files are supported' });
    }

    const objectKey = `uploads/${uuidv4()}-${safeName(originalFileName)}`;

    const putCmd = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: objectKey,
      ContentType: contentType,
    });

    const expiresIn = 900; // 15 minutes
    const uploadUrl = await getSignedUrl(s3, putCmd, { expiresIn });

    return response(200, {
      uploadUrl,
      key: objectKey,
      bucket: BUCKET_NAME,
      expiresIn,
    });
  } catch (err) {
    console.error('Upload handler error:', err);
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

function safeName(name) {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
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

