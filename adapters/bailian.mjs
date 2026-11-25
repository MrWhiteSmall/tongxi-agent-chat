export const bailianEnabled = Boolean(process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY);
const key = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;
const compatible = (process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
const native = (process.env.DASHSCOPE_HTTP_BASE_URL || compatible.replace(/\/compatible-mode\/v1$/, '/api/v1')).replace(/\/$/, '');
const searchModel = process.env.BAILIAN_SEARCH_MODEL || 'qwen-flash';

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

export function bailianMediaUrl(text, kind) {
  const match = kind === 'video'
    ? text.match(/\[打开视频\]\(<(https:\/\/[^>]+)>\)/)
    : text.match(/\[打开图片\]\(<(https:\/\/[^>]+)>\)/);
  if (!match) return;
  try {
    const url = new URL(match[1]);
    if (!url.username && !url.password && !url.port && /^dashscope-[\w-]+\.oss-[\w-]+\.aliyuncs\.com$/i.test(url.hostname)) return url.href;
  } catch {}
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

async function imageSearchOutput(prompt, signal) {
  const response = await fetch(compatible + '/responses', {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(150_000)]),
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      model: process.env.BAILIAN_IMAGE_SEARCH_MODEL || 'qwen4-max',
      input: '检索以下关键词对应的公开图片。优先原始或官方来源。只检索，不生成图片：' + prompt,
      tools: [{ type: 'web_search_image' }], store: false, stream: true
    })
  });
  if (!response.ok) throw new Error('百炼图片搜索失败（HTTP ' + response.status + '）');
  if (!response.headers.get('Content-Type')?.includes('text/event-stream')) return (await response.json()).output || [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trimEnd();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      let event;
      try { event = JSON.parse(line.slice(5)); } catch { continue; }
      if (event.type === 'response.output_item.done' && event.item?.type === 'web_search_image_call' &&
          event.item.status === 'completed' && event.item.output) return [event.item];
      if (event.type === 'response.completed') return event.response?.output || [];
      if (event.type === 'response.failed' || event.type === 'error') throw new Error('百炼未完成图片搜索');
    }
  }
  return [];
}

export async function searchBailianImages(prompt, signal) {
  let output;
  try { output = await imageSearchOutput(prompt, signal); }
  catch (error) {
    if (error.name === 'TimeoutError') throw new Error('百炼图片搜索超时，可以缩短查询词后重试');
    throw error;
  }
  const images = [];
  const seen = new Set();
  for (const item of output) {
    if (item.type !== 'web_search_image_call' || item.status !== 'completed') continue;
    let rows;
    try { rows = JSON.parse(item.output); } catch { continue; }
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      try {
        const url = new URL(row.url);
        if (url.protocol !== 'https:' || url.username || url.password || url.port || !/[a-z]\.[a-z]/i.test(url.hostname)
            || url.href.length > 8192 || /\.(?:local|internal|localhost)$/i.test(url.hostname) || seen.has(url.href)) continue;
        seen.add(url.href);
        const title = String(row.title || '打开原图').replace(/[\[\]<>\n\r]/g, '').slice(0, 110);
        images.push({ url: url.href, link: resultLink(url.href, title || '打开原图') });
        if (images.length === 6) return images;
      } catch {}
    }
  }
  return images;
}
