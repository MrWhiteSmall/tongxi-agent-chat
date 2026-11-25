export const mediaMcpEnabled = Boolean(process.env.BAILIAN_MCP_URL && process.env.BAILIAN_MCP_TOKEN);
const endpoint = process.env.BAILIAN_MCP_URL;
const token = process.env.BAILIAN_MCP_TOKEN;
let protocol;
let inventory;
let initialized;
let nextId = 0;

async function rpc(method, params, signal, notification = false) {
  const request = { jsonrpc: '2.0', method, ...(notification ? {} : { id: ++nextId }), ...(params ? { params } : {}) };
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal,
    headers: {
      Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', ...(protocol ? { 'MCP-Protocol-Version': protocol } : {})
    },
    body: JSON.stringify(request)
  });
  if (!response.ok) throw new Error('百炼媒体 MCP 请求失败（HTTP ' + response.status + '）');
  if (notification) return;
  const message = await response.json();
  if (message.error) throw new Error(typeof message.error.message === 'string' ? message.error.message : 'MCP 请求失败');
  if (message.id !== request.id) throw new Error('MCP 返回的请求编号不匹配');
  return message.result;
}

async function connect() {
  if (!initialized) initialized = (async () => {
    const signal = AbortSignal.timeout(12_000);
    const result = await rpc('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'tongxi-chat', version: '0.1.0' }
    }, signal);
    protocol = result?.protocolVersion;
    if (!protocol || !result.capabilities?.tools) throw new Error('媒体 MCP 未提供工具');
    await rpc('notifications/initialized', undefined, signal, true);
  })().catch(error => { initialized = undefined; throw error; });
  await initialized;
}

export async function listMediaTools(signal) {
  if (inventory?.until > Date.now()) return inventory.tools;
  await connect();
  const tools = [];
  let cursor;
  do {
    const result = await rpc('tools/list', cursor ? { cursor } : undefined, signal);
    tools.push(...(result.tools || []));
    cursor = result.nextCursor;
  } while (cursor && tools.length < 200);
  inventory = { tools, until: Date.now() + 60_000 };
  return tools;
}

export async function callMediaTool(name, args, signal) {
  await connect();
  const result = await rpc('tools/call', { name, arguments: args }, signal);
  if (result?.isError) throw new Error(result.content?.find(item => item.type === 'text')?.text || '媒体 MCP 工具执行失败');
  if (!result?.structuredContent) throw new Error('媒体 MCP 未返回产物信息');
  return result.structuredContent;
}
