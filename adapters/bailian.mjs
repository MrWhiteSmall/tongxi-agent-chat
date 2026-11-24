import { setTimeout as wait } from 'node:timers/promises';

export const bailianEnabled = Boolean(process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY);
const key = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;
const compatible = (process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
const native = (process.env.DASHSCOPE_HTTP_BASE_URL || compatible.replace(/\/compatible-mode\/v1$/, '/api/v1')).replace(/\/$/, '');
const imageModel = process.env.BAILIAN_IMAGE_MODEL || 'qwen-image-2.1-turbo';
const searchModel = process.env.BAILIAN_SEARCH_MODEL || 'qwen-flash';
const videoModel = process.env.BAILIAN_VIDEO_MODEL || 'wan2.7-t2v';
const actionNames = { 生图: 'image', 改图: 'edit', 视频: 'video', 模型: 'model', 搜索: 'search', search: 'search', image: 'image', edit: 'edit', video: 'video', model: 'model' };

export function bailianCommand(text, allowNatural = false) {
  const prompt = text.replace(/^(?:@[\w-]+\s*)+/u, '').trim();
  const explicit = prompt.match(/^\/(?:百炼|bailian)\s+(生图|改图|视频|模型|搜索|image|edit|video|model|search)(?:\s+([\s\S]*))?$/i);
  if (explicit) {
    const kind = actionNames[explicit[1].toLowerCase()];
    const rest = explicit[2]?.trim() || '';
    if (kind !== 'model') return { kind, prompt: rest };
    const model = rest.match(/^([\w./-]{1,120})\s+([\s\S]+)$/);
    return { kind, model: model?.[1], prompt: model?.[2] || '' };
  }
  if (!allowNatural || !bailianEnabled) return;
  if (/联网(?:搜索|查|核实)?|上网(?:搜|查)|(?:web|internet)\s+search|^(?:(?:请|帮我|给我)\s*)*(?:查一下|查找|查证|搜索|搜一下|检索|核实)/i.test(prompt)) {
    return { kind: 'search', prompt, automatic: true };
  }
  const natural = prompt.match(/^(?:(?:请|帮我|给我)\s*)*(?:用百炼\s*)?(?:生成|制作|画)(?:一[张幅段个条]|个)?[^\n，。！？：:]{0,16}?(图片|图像|海报|插画|视频|短片|图)/);
  if (natural) return { kind: ['视频','短片'].includes(natural[1]) ? 'video' : 'image', prompt, automatic: true };
  if (/^(?:(?:请|帮我)\s*)*(?:用百炼\s*)?(?:编辑|修改|调整|改一下)(?:这[张个幅])?(?:图片|图像|照片|图)/.test(prompt)) {
    return { kind: 'edit', prompt, automatic: true };
  }
}

async function request(endpoint, payload, signal, async = false) {
  const response = await fetch(endpoint, {
    method: payload ? 'POST' : 'GET', redirect: 'error', signal,
    headers: { Authorization: 'Bearer ' + key, ...(payload ? { 'Content-Type': 'application/json' } : {}), ...(async ? { 'X-DashScope-Async': 'enable' } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code || data.error) {
    const code = String(data.code || data.error?.code || response.status).replace(/[^\w.-]/g, '').slice(0, 60);
    throw new Error('百炼调用失败（' + code + '）');
  }
  return data;
}

function resultLink(url, label) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return '[' + label + '](<' + parsed.href.replace(/[<>]/g, c => encodeURIComponent(c)) + '>)';
  } catch {}
  throw new Error('百炼未返回有效的产物链接');
}

export async function searchBailian(prompt, signal) {
  const data = await request(native + '/services/aigc/text-generation/generation', {
    model: searchModel,
    input: { messages: [{ role: 'user', content: prompt }] },
    parameters: {
      enable_search: true, result_format: 'message', max_tokens: 1400,
      search_options: { forced_search: true, enable_source: true, enable_citation: true }
    }
  }, signal);
  const text = data.output?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('百炼搜索未返回内容');
  const sources = [];
  const seen = new Set();
  for (const item of (data.output?.search_info?.search_results || []).slice(0, 12)) {
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    const title = String(item.title || '查看来源').replace(/[\[\]<>\n\r]/g, '').slice(0, 110);
    try { sources.push(resultLink(item.url, title)); } catch {}
    if (sources.length === 6) break;
  }
  return { text, sources };
}

export function bailianSourceList(sources) {
  return sources.length ? '\n\n**百炼搜索来源**\n' + sources.map(link => '- ' + link).join('\n') : '';
}

export function bailianUsesImages(command) {
  return command?.kind === 'edit' || (command?.kind === 'model' && /(?:^|[-/])vl(?:-|$)/i.test(command.model || ''));
}

export async function runBailian(command, images, signal, onStatus = () => {}) {
  if (!bailianEnabled) throw new Error('百炼 API Key 未配置');
  if (!command.prompt) throw new Error('请输入百炼指令和提示词。模型调用格式：/百炼 模型 <模型ID> <问题>');
  if (command.kind === 'search') {
    onStatus('正在使用百炼联网搜索。');
    const result = await searchBailian(command.prompt, signal);
    return result.text + bailianSourceList(result.sources);
  }
  if (command.kind === 'model') {
    const references = bailianUsesImages(command) ? images.filter(image => image.url)
      .map(image => ({ type: 'image_url', image_url: { url: image.url } })) : [];
    const content = references.length ? [{ type: 'text', text: command.prompt }, ...references] : command.prompt;
    const data = await request(compatible + '/chat/completions', {
      model: command.model, messages: [{ role: 'user', content }], max_tokens: 4096
    }, signal);
    const output = data.choices?.[0]?.message?.content;
    if (typeof output !== 'string' || !output.trim()) throw new Error('百炼模型未返回文本');
    return output;
  }
  if (command.kind === 'video') {
    const data = await request(native + '/services/aigc/video-generation/video-synthesis', {
      model: videoModel, input: { prompt: command.prompt },
      parameters: { resolution: '720P', duration: 5, ratio: '16:9' }
    }, signal, true);
    const id = data.output?.task_id;
    if (!id) throw new Error('百炼未返回视频任务编号');
    onStatus('百炼已接单，正在生成 5 秒视频。');
    for (;;) {
      await wait(5000, null, { signal });
      const { output } = await request(native + '/tasks/' + encodeURIComponent(id), null, signal);
      if (output?.task_status === 'SUCCEEDED') return '百炼视频已生成。模型：`' + videoModel + '`。\n\n' + resultLink(output.video_url, '打开视频');
      if (!['PENDING', 'RUNNING'].includes(output?.task_status)) throw new Error('百炼视频生成未完成（' + (output?.task_status || '未知状态') + '）');
    }
  }
  const references = command.kind === 'edit' ? images.filter(image => image.url).map(image => ({ image: image.url })) : [];
  if (command.kind === 'edit' && !references.length) throw new Error('请附上或引用要编辑的 PNG、JPEG、GIF 或 WebP 图片');
  const data = await request(native + '/services/aigc/multimodal-generation/generation', {
    model: imageModel, input: { messages: [{ role: 'user', content: [...references, { text: command.prompt }] }] },
    parameters: { n: 1 }
  }, signal);
  const url = data.output?.choices?.flatMap(choice => choice.message?.content || []).find(part => part.image)?.image;
  return '百炼图片已' + (command.kind === 'edit' ? '编辑' : '生成') + '。模型：`' + imageModel + '`。\n\n' + resultLink(url, '打开图片');
}
