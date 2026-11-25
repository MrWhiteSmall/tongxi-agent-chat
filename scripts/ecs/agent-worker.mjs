import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { cli } from '../../adapters/index.mjs';

const token = process.env.TONGXI_WORKER_TOKEN;
if (!token || !process.env.DEEPSEEK_API_KEY) throw new Error('Worker credentials missing');
const bearer = Buffer.from('Bearer ' + token);
const commands = new Set(['claude', 'codex', 'pi']);
let queued = 0;

createServer(async (req, res) => {
  const authorization = Buffer.from(req.headers.authorization || '');
  const command = req.url.slice(1);
  function send(status, data) {
    if (res.destroyed) return;
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
  if (req.method !== 'POST' || !commands.has(command) ||
      authorization.length !== bearer.length || !timingSafeEqual(authorization, bearer)) return send(404, {});
  if (queued >= 5) return send(429, { error: 'Worker busy' });
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  queued++;
  let heartbeat;
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 100_000) return send(413, {});
    }
    const { system, input, tools } = JSON.parse(body);
    if (typeof system !== 'string' || typeof input !== 'string' || (tools &&
        !/^http:\/\/127\.0\.0\.1:\d+\/internal\/agent-tools\/[0-9a-f-]{72}$/.test(tools.url))) return send(400, {});
    controller.signal.throwIfAborted();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(' ');
    heartbeat = setInterval(() => { if (!res.destroyed) res.write(' '); }, 15_000);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(895_000)]);
    send(200, { text: await cli({ command }, system + '\n\n' + input, signal, tools?.url) });
  } catch (error) {
    if (!controller.signal.aborted) console.error(command, error.code || error.name, error.message);
    send(502, { error: 'Worker request failed' });
  } finally {
    clearInterval(heartbeat);
    queued--;
  }
}).listen(4318, '127.0.0.1');
