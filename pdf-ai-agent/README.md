# PDF AI Agent (AWS CDK + S3 + Lambda + Pinecone + OpenAI)

Dự án mẫu triển khai pipeline: Upload PDF → S3 → Lambda trích xuất text → chunking → embeddings → lưu vào Pinecone, và API query như chatbot (RAG) dùng OpenAI.

Kiến trúc triển khai bằng AWS CDK (TypeScript):
- `S3 Bucket`: lưu file PDF được upload qua presigned URL (thư mục `uploads/`).
- `Lambda Upload Handler`: tạo presigned URL để client PUT file PDF lên S3.
- `Lambda PDF Processor`: bắt S3 event, đọc PDF, trích xuất text, chunking, tạo embeddings (OpenAI), upsert vào Pinecone, rồi xóa file gốc (có thể tắt nếu muốn).
- `Lambda Query Handler`: API query theo kiểu chatbot (RAG): embed câu hỏi → query Pinecone → tổng hợp câu trả lời với OpenAI.
- `API Gateway`: REST endpoints `/upload` và `/query`.

Các thành phần chính trong repo:
- `pdf-ai-agent/lib/pdf-ai-agent-stack.ts`: Khai báo toàn bộ hạ tầng CDK.
- `pdf-ai-agent/lambda/upload-handler/index.js`: Tạo presigned URL PUT vào S3.
- `pdf-ai-agent/lambda/pdf-processor/index.js`: Xử lý PDF, chunk, embeddings, upsert Pinecone.
- `pdf-ai-agent/lambda/query-handler/index.js`: API query chatbot.
- `pdf-ai-agent/docs/postman/PdfAiAgent.postman_collection.json`: Collection Postman để test nhanh.

## Yêu cầu trước khi bắt đầu

- Node.js 18+ và npm.
- Tài khoản AWS đã cấu hình AWS CLI (đã `aws configure`).
- AWS CDK v2: `npm i -g aws-cdk` (hoặc dùng npx).
- Tài khoản OpenAI và API key hợp lệ, còn quota.
- Tài khoản Pinecone và API key; tạo sẵn Index:
  - `dimension = 1536`, `metric = cosine`, serverless (AWS) tùy region.

## Cài đặt dependencies

Chạy các lệnh sau (từ thư mục gốc dự án):
- `cd pdf-ai-agent && npm install`
- `cd lambda/upload-handler && npm install`
- `cd ../query-handler && npm install`
- `cd ../pdf-processor && npm install`
- Quay lại root: `cd ../../..`

## Biến môi trường cần thiết

Stack yêu cầu các biến sau khi synth/deploy (bắt buộc):
- `OPENAI_API_KEY`: API key OpenAI.
- `PINECONE_API_KEY`: API key Pinecone.
- `PINECONE_INDEX_NAME`: Tên Index đã tạo trong Pinecone (dimension 1536).

Thiết lập biến môi trường:
- macOS/Linux (bash/zsh):
  - `export OPENAI_API_KEY="sk-..."`
  - `export PINECONE_API_KEY="..."`
  - `export PINECONE_INDEX_NAME="ten-index-cua-ban"`
- Windows PowerShell:
  - `$env:OPENAI_API_KEY="sk-..."`
  - `$env:PINECONE_API_KEY="..."`
  - `$env:PINECONE_INDEX_NAME="ten-index-cua-ban"`

## Deploy hạ tầng

1) Bootstrap (lần đầu trong account/region):
- `cd pdf-ai-agent`
- `npx cdk bootstrap`

2) Deploy:
- `npx cdk deploy`

Sau deploy, CDK sẽ in các Outputs:
- `PdfAiAgentStack.UploadApiUrl`: URL POST tạo presigned upload.
- `PdfAiAgentStack.QueryApiUrl`: URL POST query chatbot.
- `PdfAiAgentStack.PdfBucketName`: Tên S3 bucket lưu PDF.

Ví dụ:
- `https://<api-id>.execute-api.<region>.amazonaws.com/dev/upload`
- `https://<api-id>.execute-api.<region>.amazonaws.com/dev/query`

## Test bằng Postman (đề xuất import Collection sẵn)

Bạn có thể import file collection tại `pdf-ai-agent/docs/postman/PdfAiAgent.postman_collection.json` vào Postman, sau đó:

1) Tạo Environment trong Postman, thêm biến:
- `baseUrl = https://<api-id>.execute-api.<region>.amazonaws.com/dev`

2) Create Upload URL (POST `/upload`):
- Request: `Create Upload URL`
- Headers: `Content-Type: application/json`
- Body (raw JSON) ví dụ:
  - `{ "fileName": "AWS_DevOps.pdf", "contentType": "application/pdf" }`
- Send → Response trả `uploadUrl`, `key`, `bucket`.
- Collection đã có sẵn test script để lưu `uploadUrl` và `s3Key` vào Environment.

3) Upload PDF lên S3 (PUT presigned URL):
- Request: `PUT PDF to S3`
- URL: `{{uploadUrl}}` (đã được set ở bước 2)
- Headers: `Content-Type: application/pdf` (bắt buộc khớp với khi presign)
- Body: chọn `binary` → chọn file PDF trên máy.
- Send → 200/204 là thành công. S3 sẽ trigger `PdfProcessor` tự chạy.

4) Query Chatbot (POST `/query`):
- Request: `Query Chatbot`
- Headers: `Content-Type: application/json`
- Body (raw JSON) ví dụ:
  - `{ "query": "Tài liệu nói gì về quy trình DevOps trên AWS?", "topK": 5 }`
- Send → Nhận `answer` (tiếng Việt) và `matches` (các chunk nguồn, file, chỉ số, URL nguồn s3://...).

Gợi ý câu hỏi:
- "Các thực hành tốt khi triển khai CI/CD trên AWS là gì?"
- "Tài liệu liệt kê những dịch vụ nào cho pipeline DevOps?"

## Hành vi và cấu hình quan trọng

- `PdfProcessor` xóa file PDF gốc sau khi xử lý. Nếu muốn giữ lại, mở `pdf-ai-agent/lambda/pdf-processor/index.js` và bỏ đoạn DeleteObject.
- Text splitter mặc định: độ dài 1000 ký tự, overlap 200. Có thể chỉnh trong `splitText(...)` ở `pdf-ai-agent/lambda/pdf-processor/index.js`.
- Model embeddings dùng: `text-embedding-3-small` (1536 dims). Đảm bảo Pinecone index khớp `dimension = 1536`.
- Batch embeddings và retry/backoff khi gặp rate limit để giảm lỗi 429.

## Troubleshooting

- 403 SignatureDoesNotMatch khi PUT lên presigned URL:
  - Đảm bảo header `Content-Type` khi PUT trùng với khi tạo presigned (`application/pdf`).
- 429 InsufficientQuotaError từ OpenAI:
  - Kiểm tra quota/billing của API key. Hoặc thay key khác còn quota.
- Pinecone dimension mismatch:
  - Tạo index `dimension = 1536`, `metric = cosine`.
- PDF toàn ảnh (scan) → không có text:
  - `pdf-parse` không OCR. Cần OCR trước khi đưa vào pipeline.
- Xử lý chậm/timed out:
  - Tăng `memorySize`/`timeout` của `PdfProcessor` trong `pdf-ai-agent/lib/pdf-ai-agent-stack.ts`.
- Không thấy trigger chạy:
  - Kiểm tra file được upload vào `uploads/` và có `.pdf` đuôi.

## Nâng cấp mở rộng (tùy chọn)

- Thêm `namespace` Pinecone theo người dùng/dự án để tách dữ liệu; truyền `namespace` vào cả upsert và query.
- Dùng AWS Bedrock Embeddings thay OpenAI để tránh quản lý quota OpenAI.
- Bật DLQ cho Lambda `PdfProcessor` để theo dõi/lặp lại khi lỗi tạm thời.
- Thêm auth cho API Gateway (IAM/Authorizer) nếu dùng public.

## Cleanup

- Xóa hạ tầng: `npx cdk destroy` (Bucket đã bật `autoDeleteObjects`, chú ý dữ liệu sẽ bị xóa).

## Lệnh hữu ích

- Build TypeScript (nếu cần): `npm run build`
- Xem diff template: `npx cdk diff`
- Xuất CloudFormation template: `npx cdk synth`
