// lib/pdf-ai-agent-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import { Construct } from 'constructs';

export class PdfAiAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1) S3 bucket lưu trữ PDF
    const pdfBucket = new s3.Bucket(this, 'PdfStorageBucket', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new cdk.CfnOutput(this, 'PdfBucketName', {
      value: pdfBucket.bucketName,
      description: 'Tên S3 Bucket lưu trữ PDF',
    });

    // 2) Lambda tạo URL upload (presigned)
    const uploadHandler = new lambda.Function(this, 'UploadHandler', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/upload-handler'),
      environment: {
        BUCKET_NAME: pdfBucket.bucketName,
      },
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
    });
    pdfBucket.grantWrite(uploadHandler);

    // Helper yêu cầu biến môi trường khi synth
    const requireEnv = (name: string) => {
      const v = process.env[name];
      if (!v) throw new Error(`Missing environment variable ${name} for Lambda configuration`);
      return v;
    };

    // 3) Lambda xử lý PDF + embedding + upsert Pinecone
    const pdfProcessor = new lambda.Function(this, 'PdfProcessor', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/pdf-processor'),
      timeout: cdk.Duration.minutes(10),
      memorySize: 1024,
      environment: {
        // AWS_REGION: this.region,
        BUCKET_NAME: pdfBucket.bucketName,
        PINECONE_API_KEY: requireEnv('PINECONE_API_KEY'),
        PINECONE_INDEX_NAME: requireEnv('PINECONE_INDEX_NAME'),
        OPENAI_API_KEY: requireEnv('OPENAI_API_KEY'),
      },
    });
    pdfBucket.grantRead(pdfProcessor);
    pdfBucket.grantDelete(pdfProcessor);

    // S3 -> Lambda trigger khi có object mới trong uploads/*.pdf
    pdfBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(pdfProcessor),
      { prefix: 'uploads/', suffix: '.pdf' },
    );

    // 4) API Gateway cho Upload & Query
    const api = new apigw.RestApi(this, 'PdfApi', {
      restApiName: 'PDF AI Agent API',
      description: 'API upload PDF và query agent',
      deployOptions: { stageName: 'dev' },
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: apigw.Cors.DEFAULT_HEADERS,
      },
    });

    const uploadResource = api.root.addResource('upload');
    uploadResource.addMethod('POST', new apigw.LambdaIntegration(uploadHandler));
    new cdk.CfnOutput(this, 'UploadApiUrl', {
      value: `${api.url}upload`,
      description: 'URL API upload file PDF',
    });

    // 5) Lambda Query (chatbot RAG) + route
    const queryHandler = new lambda.Function(this, 'QueryHandler', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/query-handler'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        OPENAI_API_KEY: requireEnv('OPENAI_API_KEY'),
        PINECONE_API_KEY: requireEnv('PINECONE_API_KEY'),
        PINECONE_INDEX_NAME: requireEnv('PINECONE_INDEX_NAME'),
      },
    });
    const queryResource = api.root.addResource('query');
    queryResource.addMethod('POST', new apigw.LambdaIntegration(queryHandler));
    new cdk.CfnOutput(this, 'QueryApiUrl', {
      value: `${api.url}query`,
      description: 'URL của API query chatbot',
    });
  }
}

