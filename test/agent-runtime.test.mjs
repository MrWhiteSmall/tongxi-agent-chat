import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

test('Agent chooses a sequence, receives tool errors and results, and selects the media it delivers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tongxi-runtime-'));
  const calls = [];
  const tool = { name: 'bailian_image_edit', description: 'Edit a reference image', inputSchema: {
    type: 'object', properties: { prompt: { type: 'string' }, images: { type: 'array', items: { type: 'string' } } },
    required: ['prompt', 'images']
  } };
  const imageUrl = 'https://example.org/reference.png';
  const output = 'https://dashscope-test.oss-accelerate.aliyuncs.com/output.png';
  const mock = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      const json = data => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
      if (req.url === '/mcp') {
        const result = {
          initialize: { protocolVersion: '2025-11-25', capabilities: { tools: {} } },
          'tools/list': { tools: [tool] }
        }[input.method];
        if (result) return json({ id: input.id, result });
        if (!input.id) return res.writeHead(202).end();
        assert.equal(input.params.name, tool.name);
        const secondPass = calls.includes('media');
        assert.deepEqual(input.params.arguments.images, [secondPass ? output : imageUrl]);
        calls.push('media');
        return json({ id: input.id, result: { structuredContent: { kind: 'image', status: 'SUCCEEDED', url: secondPass ? output + '?revision=2' : output } } });
      }
      if (req.url === '/compatible-mode/v1/responses') {
        calls.push('search');
        assert.equal(input.stream, true);
        const item = { type: 'web_search_image_call', status: 'completed', output: JSON.stringify([{ url: imageUrl, title: 'reference' }]) };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return res.end('event: response.output_item.done\r\ndata: ' + JSON.stringify({ type: 'response.output_item.done', item }) + '\r\n\r\n');
      }
      assert.equal(req.url, '/model');
      assert(input.messages[1].content.includes('当前任务'));
      const results = input.messages.filter(message => message.role === 'tool');
      const next = (name, args) => json({ choices: [{ message: {
        tool_calls: [{ id: 'call_' + results.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
      } }] });
      const last = results.at(-1)?.content;
      switch (results.length) {
        case 0:
          assert(input.tools.some(item => item.function.name === 'image_search'));
          return next(tool.name, { prompt: '图像编辑', images: ['not-authorized'] });
        case 1:
          assert.match(last, /授权范围/);
          return next('image_search', { query: 'public reference' });
        case 2:
          return next(tool.name, { prompt: '图像编辑', images: [JSON.parse(last)[0].id] });
        case 3:
          return next(tool.name, { prompt: '再精修', images: [JSON.parse(last).id] });
        case 4:
          return next('deliver_media', { ids: [JSON.parse(last).id, 'image-1'] });
        default:
          assert.equal(JSON.parse(last).delivered.length, 2);
          return json({ choices: [{ message: { content: '最终交付。' } }] });
      }
    } catch (error) {
      calls.push(error);
      res.writeHead(500).end();
    }
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  t.after(() => { mock.close(); mock.closeAllConnections(); });
  const url = 'http://127.0.0.1:' + mock.address().port;
  const child = spawn(process.execPath, ['server.mjs'], {
    env: {
      PATH: process.env.PATH, CHAT_LOCAL: '1', CHAT_DATA: directory, PORT: '0',
      DEEPSEEK_API_KEY: 'test', DEEPSEEK_AGENT_MODEL_URL: url + '/model',
      QWEN_API_KEY: 'test', QWEN_BASE_URL: url + '/compatible-mode/v1',
      BAILIAN_MCP_TOKEN: 'test', BAILIAN_MCP_URL: url + '/mcp'
    },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await rm(directory, { recursive: true, force: true });
  });
  const [address] = await once(child.stdout, 'data');
  const base = address.toString().trim().split(' ').at(-1);
  let token;
  async function api(path, body) {
    const response = await fetch(base + '/api/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    assert(response.ok, path + ' ' + response.status);
    return response.json();
  }
  ({ token } = await api('login', { name: 'A' }));
  const { id: room } = await api('rooms', { kind: 'dm', users: ['B'] });
  await api('rooms/' + room + '/messages', { text: '当前任务', agents: ['deepseek'] });
  for (let i = 0; i < 100; i++) {
    const snapshot = await api('rooms/' + room);
    const task = snapshot.tasks[0];
    if (['done', 'failed'].includes(task?.status)) {
      assert.deepEqual(calls, ['search', 'media', 'media']);
      assert.equal(task.status, 'done', task.error);
      assert(!('artifacts' in task));
      const reply = snapshot.messages.find(message => message.kind === 'agent');
      assert.equal(reply.text, '最终交付。');
      assert.equal(reply.media.url, output + '?revision=2');
      assert.deepEqual(reply.media.sources, [imageUrl]);
      assert.equal(reply.mediaItems.length, 2);
      assert.equal(reply.mediaItems[1].searchId, 'image-1');
      assert.equal(reply.mediaItems[1].url, imageUrl);
      return;
    }
    await delay(20);
  }
  assert.fail('Agent runtime did not finish');
});
