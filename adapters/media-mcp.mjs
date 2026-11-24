import { setTimeout as sleep } from 'node:timers/promises';

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

async function callTool(name, args, signal) {
  await connect();
  const result = await rpc('tools/call', { name, arguments: args }, signal);
  if (result?.isError) throw new Error(result.content?.find(item => item.type === 'text')?.text || '媒体 MCP 工具执行失败');
  if (!result?.structuredContent) throw new Error('媒体 MCP 未返回产物信息');
  return result.structuredContent;
}

export function explicitMediaOptions(text) {
  const options = {};
  const prompt = text.replace(/(?:^|\s+)--(resolution|duration|ratio|size|model)(?:[=\s]+(\S+))?/g, (_, key, value) => {
    if (!value || value.startsWith('--')) throw new Error('缺少 --' + key + ' 参数值');
    if (key === 'duration') {
      if (!/^\d+$/.test(value) || Number(value) < 2 || Number(value) > 30) throw new Error('时长须为 2–30 秒的整数');
      options[key] = Number(value);
    } else options[key] = value;
    return '';
  }).trim();
  return { prompt, options };
}

const catalogKinds = {
  bailian_image_generate: 'image', bailian_image_edit: 'edit', bailian_video_text: 'video',
  bailian_video_first: 'video', bailian_video_frames: 'video', bailian_video_reference: 'video'
};
export const mediaToolKind = name => catalogKinds[name];

export function contextualMediaTools(tools, count) {
  return tools.filter(tool => {
    if (!mediaToolKind(tool.name)) return false;
    if (tool.name === 'bailian_video_text') return count === 0;
    if (tool.name === 'bailian_video_first') return count === 1;
    if (tool.name === 'bailian_video_frames') return count === 2;
    if (['bailian_image_edit', 'bailian_video_reference'].includes(tool.name)) return count > 0;
    return true;
  }).map(tool => {
    const schema = structuredClone(tool.inputSchema);
    const index = { type: 'integer', minimum: 1, maximum: count };
    for (const name of ['first_frame', 'last_frame']) {
      if (schema.properties[name]) schema.properties[name] = { ...index, description: '已授权图片的编号，从 1 开始' };
    }
    for (const name of ['images', 'reference_images']) {
      if (schema.properties[name]) schema.properties[name] = { type: 'array', items: index, description: '按用途顺序传入已授权图片的编号，禁止填写 URL' };
    }
    return { type: 'function', function: { name: tool.name, description: tool.description, parameters: schema } };
  });
}

function imageAt(assets, index) {
  if (!Number.isInteger(index) || !assets[index - 1]?.url) throw new Error('缺少指定用途的图片，请引用或重新上传');
  return assets[index - 1].url;
}

export async function runMediaTool(action, assets, signal, onStatus, assetCount) {
  const { prompt, options: explicit } = explicitMediaOptions(action.prompt);
  if (!prompt) throw new Error('请输入生成内容');
  const { resolution, duration, ratio, size, model, images, reference_images, first_frame, last_frame } = action.mediaArgs || {};
  const original = action.originalPrompt || action.prompt;
  const mentionedDuration = original.match(/(?:时长[：:\s]*|生成\s*)?(?<![\d.])(\d{1,3}(?:\.\d+)?)\s*秒(?:钟)?(?:的)?/);
  const mentionedResolution = original.match(/(?:^|\D)(480p|720p|1080p)(?=$|\D)/i);
  const mentionedSize = original.match(/(?:^|\D)(\d{3,4}\s*[xX*×]\s*\d{3,4})(?=$|\D)/);
  const settings = {
    resolution: mentionedResolution?.[1] || resolution,
    duration: mentionedDuration ? Number(mentionedDuration[1]) : duration,
    ratio, size: mentionedSize?.[1]?.replace(/\s/g, '') || size, model, ...explicit
  };
  const use = action.mediaTool || ({
    image: 'bailian_image_generate', edit: 'bailian_image_edit'
  }[action.kind]) || (action.mode === 'frames' ? 'bailian_video_frames' :
    action.mode === 'reference' || assetCount > 1 ? 'bailian_video_reference' :
    assetCount === 1 ? 'bailian_video_first' : 'bailian_video_text');
  const tools = await listMediaTools(signal);
  if (!tools.some(tool => tool.name === use) || mediaToolKind(use) !== action.kind) throw new Error('当前媒体 MCP 没有可用的对应工具');
  if (action.kind === 'video' && use === 'bailian_video_text' && (assetCount || action.requiresImage)) {
    throw new Error('需要可读取的原图，请重新引用或上传图片再生成视频');
  }
  if (use === 'bailian_video_frames' && assetCount !== 2) throw new Error('首尾帧需要正好两张图，不能同时传入其他参考图');
  const all = Array.from({ length: assetCount }, (_, index) => index + 1);
  const request = action.kind === 'video'
    ? { prompt, resolution: settings.resolution, duration: settings.duration, ratio: settings.ratio, model: settings.model }
    : { prompt, size: settings.size, model: settings.model };
  if (use === 'bailian_image_edit') {
    const ordered = images || all;
    if (ordered.length !== all.length || new Set(ordered).size !== all.length) throw new Error('部分原图未被分配用途，请明确指定或取消引用');
    request.images = ordered.map(index => imageAt(assets, index));
  }
  if (use === 'bailian_video_reference') {
    const ordered = reference_images || all;
    if (ordered.length !== all.length || new Set(ordered).size !== all.length) throw new Error('部分参考图未被分配用途，请明确指定或取消引用');
    request.reference_images = ordered.map(index => imageAt(assets, index));
  }
  if (use === 'bailian_video_first' || use === 'bailian_video_frames') request.first_frame = imageAt(assets, first_frame ?? 1);
  if (use === 'bailian_video_frames') {
    if ((first_frame ?? 1) === (last_frame ?? 2)) throw new Error('请明确指定不同的首帧和尾帧图片');
    request.last_frame = imageAt(assets, last_frame ?? 2);
  }
  let result = await callTool(use, request, signal);
  if (result.kind === 'video' && result.job) {
    onStatus('百炼媒体 MCP 已接单，正在生成 ' + result.duration + ' 秒 ' + result.resolution + ' 视频。');
    while (['PENDING', 'QUEUED', 'RUNNING'].includes(result.status)) {
      await sleep(5000, null, { signal });
      result = await callTool('bailian_video_status', { job: result.job }, signal);
    }
  }
  if (result.status !== 'SUCCEEDED' || !result.url) throw new Error(result.error || '媒体任务没有生成结果');
  const tag = result.kind === 'video' ? '视频' : '图片';
  const mode = ({ first: '首帧', frames: '首尾帧', reference: '参考图' })[result.mode];
  return '百炼' + (mode ? mode + '生' : '') + tag + '已' + (result.mode === 'edit' ? '编辑' : '生成') +
    '。模型：`' + result.model + '`。' + (result.fallback ? '已使用同规格兼容模型。' : '') +
    (result.resolution ? ' 分辨率：' + result.resolution + '。' : '') +
    (result.duration ? ' 时长：' + result.duration + ' 秒。' : '') +
    '\n\n[打开' + tag + '](<' + result.url.replace(/[<>]/g, c => encodeURIComponent(c)) + '>)';
}
