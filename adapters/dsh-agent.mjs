import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export async function dshAgent({ cwd, env, prompt, toolsUrl, signal }) {
  const child = spawn('dsh', ['--profile', 'acp'], {
    cwd, signal, env: { ...env, DSH_PERMISSION_MODE: 'read-only', DSH_APPROVAL_POLICY: 'ask' },
    stdio: ['pipe', 'pipe', 'ignore']
  });
  let next = 0;
  let answer = '';
  let failure;
  const pending = new Map();
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const stop = error => {
    failure = error;
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };
  child.stdin.on('error', stop);
  child.once('error', stop);
  child.once('exit', () => stop(new Error('DeepSeek Harness 运行时已退出')));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      if (message.method === 'session/request_permission') {
        send({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
      } else {
        send({ id: message.id, error: { code: -32601, message: 'Client operation unavailable' } });
      }
      return;
    }
    if (message.method === 'session/update' && message.params?.update?.sessionUpdate === 'agent_message_chunk') {
      const content = message.params.update.content;
      if (content?.type === 'text') answer += content.text;
      if (answer.length > 500_000) {
        stop(new Error('运行时返回内容超出限制'));
        child.kill();
      }
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error('DeepSeek Harness 请求失败：' + message.error.message));
    else waiter.resolve(message.result);
  });
  function request(method, params) {
    return new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      const id = ++next;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  }
  try {
    const ready = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    if (toolsUrl && !ready.agentCapabilities?.mcpCapabilities?.http) throw new Error('DeepSeek Harness 不支持 HTTP MCP');
    const { sessionId } = await request('session/new', {
      cwd, mcpServers: toolsUrl ? [{ name: 'tongxi', type: 'http', url: toolsUrl, headers: [] }] : []
    });
    await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
    if (!answer.trim()) throw new Error('DeepSeek Harness 未返回回复');
    return answer.trim();
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
  }
}
