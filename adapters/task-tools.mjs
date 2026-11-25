import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { bailianEnabled, searchBailian, searchBailianImages } from './bailian.mjs';
import { callMediaTool, listMediaTools, mediaMcpEnabled } from './media-mcp.mjs';

const mediaFields = ['images', 'reference_images', 'first_frame', 'last_frame'];
const tool = (name, description, properties, required = Object.keys(properties)) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }
});
const str = description => ({ type: 'string', description });
const scopes = new Map();

export function openToolScope({ origin, signal, ...options }) {
  const id = randomUUID() + randomUUID();
  const scope = { ...options, signal, calls: 0, found: 0, references: new Map(), jobs: new Set(), outputs: new Set() };
  options.files.filter(file => file.image).forEach(file => scope.references.set(file.id, file));
  scopes.set(id, scope);
  return { url: origin + '/internal/agent-tools/' + id, close: () => scopes.delete(id), scope };
}

function textResult(value, isError = false) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError } : {}) };
}

async function inventory(scope) {
  const tools = [];
  tools.push(tool('deliver_media', '将本次任务选定的图片搜索结果、生成图片或视频作为聊天卡片交付。按展示顺序提交编号。', {
    ids: { type: 'array', items: str('搜图编号（如 image-2），或媒体工具和子任务返回的产物编号（如 output-1）') }
  }));
  if (scope.files.some(file => file.image && !file.remoteImage)) tools.push(tool('view_image', '查看一张授权上传图片，返回视觉内容。', { id: str('附件编号') }));
  if (scope.files.some(file => file.text)) tools.push(tool('read_attachment', '读取一份已授权的文本附件。', { id: str('附件编号') }));
  if (scope.members.length) tools.push(tool('delegate', '给有权限的会话成员分配子任务，返回其结果。', {
    agent: { type: 'string', enum: scope.members.map(member => member.id) },
    task: str('给子 Agent 的具体工作说明'), attachments: { type: 'array', items: str('要分享的授权附件编号') }
  }, ['agent', 'task']));
  if (bailianEnabled) tools.push(
    tool('web_search', '搜索公开网页，返回文本和来源。查询仅使用与任务相关的公开关键词。', { query: str('搜索词') }),
    tool('image_search', '搜索已有公开图片，返回公开原图链接和编号。需要把图片发给用户时，用 deliver_media 选择搜图编号交付。', { query: str('搜索词') })
  );
  if (mediaMcpEnabled) {
    try {
      for (const entry of await listMediaTools(AbortSignal.any([scope.signal, AbortSignal.timeout(12_000)]))) {
        if (!/^bailian_(?:image_|video_)/.test(entry.name)) continue;
        const schema = structuredClone(entry.inputSchema);
        const reference = str('任务内的图片编号，可以来自授权附件、搜图或生成结果');
        for (const name of mediaFields) if (schema.properties?.[name]) {
          schema.properties[name] = ['images', 'reference_images'].includes(name)
            ? { ...schema.properties[name], items: reference, description: '按使用顺序提供任务内的图片编号' } : reference;
        }
        if (entry.name === 'bailian_video_status') schema.properties.wait_seconds = {
          type: 'integer', minimum: 0, maximum: 30, description: '查询前等待的秒数，省略时等待 15 秒'
        };
        tools.push({ name: entry.name, description: entry.description, inputSchema: schema });
      }
    } catch { scope.signal.throwIfAborted(); }
  }
  return tools;
}

async function call(scope, name, args) {
  scope.signal.throwIfAborted();
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象');
  const tools = await inventory(scope);
  if (!tools.some(tool => tool.name === name)) throw new Error('该工具在本次任务中不可用');
  if (++scope.calls > 24) throw new Error('本次任务已达到工具调用次数上限');
  if (name === 'read_attachment') {
    const file = scope.files.find(file => file.id === args.id && file.text);
    if (!file) throw new Error('文本附件不在授权范围内');
    return { id: file.id, name: file.name, text: await scope.readText(file) };
  }
  if (name === 'delegate') {
    const result = await scope.delegate(args);
    for (const item of result.artifacts) {
      scope.outputs.add(item.id);
      if (item.kind === 'image') scope.references.set(item.id, { url: item.url, sources: item.sources });
    }
    return result;
  }
  if (name === 'deliver_media') {
    if (!Array.isArray(args.ids) || !args.ids.length || args.ids.length > 6 || args.ids.some(id => !scope.outputs.has(id) && !scope.references.get(id)?.searchId)) {
      throw new Error('请从本次任务的产物中选择一至六项');
    }
    const ids = [...new Set(args.ids)];
    scope.deliver(ids.map(id => {
      const reference = scope.references.get(id);
      return scope.outputs.has(id) ? id : scope.publish({
        kind: 'image', url: reference.url, searchId: id
      });
    }));
    return { delivered: ids };
  }
  if (name === 'view_image') {
    const file = scope.files.find(file => file.id === args.id && file.image && !file.remoteImage);
    if (!file) throw new Error('图片不在本任务的上传附件范围内');
    const url = await scope.readImage(file, 2_000_000);
    const [, mimeType, data] = url.match(/^data:([^;]+);base64,(.+)$/);
    return { imageContent: { type: 'image', mimeType, data } };
  }
  if (name === 'web_search' || name === 'image_search') {
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 1500) throw new Error('请提供不超过 1500 字的搜索词');
    if (name === 'web_search') return searchBailian(args.query, scope.signal);
    const found = await searchBailianImages(args.query, scope.signal);
    return found.map(image => {
      const id = 'image-' + (++scope.found);
      scope.references.set(id, { url: image.url, sources: [image.url], searchId: id });
      return { id, url: image.url, source: image.link };
    });
  }
  const input = { ...args };
  if (name === 'bailian_video_status') {
    if (!scope.jobs.has(args.job)) throw new Error('视频任务不在授权范围内');
    const seconds = args.wait_seconds ?? 15;
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 30) throw new Error('等待时间须为 0–30 秒');
    delete input.wait_seconds;
    if (seconds) await delay(seconds * 1000, undefined, { signal: scope.signal });
  }
  let inlineBytes = 0;
  const sources = new Set();
  const load = async id => {
    const ref = scope.references.get(id);
    if (!ref) throw new Error('图片不在当前任务的授权范围内，请使用图片编号');
    for (const url of ref.sources || []) sources.add(url);
    const url = ref.url || await scope.readImage(ref);
    if (url.startsWith('data:')) {
      inlineBytes += Math.ceil(url.slice(url.indexOf(',') + 1).length * 3 / 4);
      if (inlineBytes > 20_000_000) throw new Error('一次调用最多传入 20 MB 的上传图片');
    }
    return url;
  };
  for (const field of mediaFields) if (field in input) {
    if (Array.isArray(input[field])) {
      if (input[field].length > 10) throw new Error('一次最多传入 10 张参考图');
      const images = [];
      for (const id of input[field]) images.push(await load(id));
      input[field] = images;
    } else input[field] = await load(input[field]);
  }
  const result = await scope.mediaCall(name, input, () => callMediaTool(name, input, scope.signal));
  if (result.job) scope.jobs.add(result.job);
  if (result.url && ['image', 'video'].includes(result.kind) && result.status === 'SUCCEEDED') {
    const id = scope.publish({ ...result, sources: [...sources] });
    scope.outputs.add(id);
    if (result.kind === 'image') scope.references.set(id, { url: result.url, sources: [...sources] });
    return { ...result, id };
  }
  return result;
}

export async function dispatchTools(scope, { method, params }) {
  scope.signal.throwIfAborted();
  if (method === 'initialize') return {
    protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(params?.protocolVersion)
      ? params.protocolVersion : '2025-11-25',
    capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'tongxi', version: '1.0' }
  };
  if (method === 'ping') return {};
  if (method === 'resources/list') return {
    resources: scope.files.filter(file => !file.remoteImage).map(file => ({
      uri: 'tongxi://attachment/' + file.id, name: file.name
    }))
  };
  if (method === 'resources/read') {
    const file = scope.files.find(file => !file.remoteImage && 'tongxi://attachment/' + file.id === params?.uri);
    if (!file) throw new Error('附件不在本次任务的授权范围内');
    const resource = file.text ? { mimeType: 'text/plain', text: await scope.readText(file) }
      : { mimeType: 'application/octet-stream', blob: (await scope.readFile(file)).toString('base64') };
    return { contents: [{ uri: params.uri, ...resource }] };
  }
  if (method === 'tools/list') return { tools: await inventory(scope) };
  if (method === 'tools/call') {
    try {
      const value = await call(scope, params?.name, params?.arguments ?? {});
      return value?.imageContent ? { content: [value.imageContent] } : textResult(value);
    }
    catch (error) { scope.signal.throwIfAborted(); return textResult(error.message, true); }
  }
  throw Object.assign(new Error('Method not found'), { code: -32601 });
}

export function taskScope(path) {
  const id = path.match(/^\/internal\/agent-tools\/([0-9a-f-]{72})$/)?.[1];
  return scopes.get(id);
}
