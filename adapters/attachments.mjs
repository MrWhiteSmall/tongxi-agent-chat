import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const maxFileBytes = 10_000_000;

export async function attachments(data, local) {
  const { OSS_BUCKET, OSS_REGION, OSS_ENDPOINT, OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET } = process.env;
  if (OSS_BUCKET) {
    const { default: OSS } = await import('ali-oss');
    const client = new OSS({
      bucket: OSS_BUCKET,
      region: OSS_REGION,
      endpoint: OSS_ENDPOINT,
      accessKeyId: OSS_ACCESS_KEY_ID,
      accessKeySecret: OSS_ACCESS_KEY_SECRET,
      authorizationV4: true,
      timeout: 30_000
    });
    return {
      kind: 'oss',
      async put(id, bytes) {
        await client.put('attachments/' + id, bytes, { mime: 'application/octet-stream' });
      },
      async remove(id) { await client.delete('attachments/' + id); },
      async get(id) {
        return (await client.getStream('attachments/' + id)).stream;
      }
    };
  }
  if (!local && process.env.CHAT_TEST_AGENT !== '1') throw new Error('服务器模式必须配置 OSS_BUCKET');
  const folder = join(data, 'attachments');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  return {
    kind: 'disk',
    async put(id, bytes) { await writeFile(join(folder, id), bytes, { flag: 'wx', mode: 0o600 }); },
    async remove(id) { await rm(join(folder, id), { force: true }); },
    async get(id) { return createReadStream(join(folder, id)); }
  };
}

export function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
}
