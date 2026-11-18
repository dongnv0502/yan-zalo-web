import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

const Bucket = process.env.RUSTFS_BUCKET;
const client = new S3Client({
  endpoint: process.env.RUSTFS_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.RUSTFS_ACCESS_KEY_ID,
    secretAccessKey: process.env.RUSTFS_SECRET_ACCESS_KEY,
  },
});

try {
  await client.send(new HeadBucketCommand({ Bucket }));
} catch (error) {
  if (error.$metadata?.httpStatusCode !== 404) throw error;
  await client.send(new CreateBucketCommand({ Bucket }));
} finally {
  client.destroy();
}
