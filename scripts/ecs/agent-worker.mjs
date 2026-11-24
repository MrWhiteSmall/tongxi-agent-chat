import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { cli } from '../../adapters/index.mjs';

const token = process.env.TONGXI_WORKER_TOKEN;
if (!token || !process.env.DEEPSEEK_API_KEY) throw new Error('Worker credentials missing');
const bearer = Buffer.from('Bearer ' + token);
const commands = new Set(['claude', 'codex', 'pi']);
let tail = Promise.resolve();
let queued = 0;

createServer(async (req, res) => {
  const authorization = Buffer.from(req.headers.authorization || '');
  const command = req.url.slice(1);
  function send(status, data) {
    if (!res.destroyed) res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  }
  if (req.method !== 'POST' || !commands.has(command) ||
      authorization.length !== bearer.length || !timingSafeEqual(authorization, bearer)) return send(404, {});
  if (queued >= 5) return send(429, { error: 'Worker busy' });
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  queued++;
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 100_000) return send(413, {});
    }
    const { system, input } = JSON.parse(body);
    if (typeof system !== 'string' || typeof input !== 'string') return send(400, {});
    const run = tail.then(() => {
      controller.signal.throwIfAborted();
      return cli({ command }, system + '\n\n' + input, AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]));
    });
    tail = run.catch(() => {});
    send(200, { text: await run });
  } catch (error) {
    if (!controller.signal.aborted) console.error(command, error.code || error.name, error.message);
    send(502, { error: 'Worker request failed' });
  } finally {
    queued--;
  }
}).listen(4318, '127.0.0.1');
