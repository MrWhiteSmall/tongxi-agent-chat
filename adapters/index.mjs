import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const local = process.env.CHAT_LOCAL !== '0';
const deepseek = process.env.DEEPSEEK_API_KEY;
const qwen = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;
const model = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
const providers = {
  deepseek: { key: deepseek, url: 'https://api.deepseek.com/chat/completions', model },
  qwen: { key: qwen, url: (process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '') + '/chat/completions', model: process.env.QWEN_MODEL || 'qwen4-max' }
};

const agents = [
  { id: 'deepseek', name: 'DeepSeek', role: '分析与调研', provider: 'deepseek' },
  { id: 'maker', name: '制作助手', role: '实现网页工具和小游戏', provider: deepseek ? 'deepseek' : 'qwen' },
  { id: 'review', name: '审校助手', role: '审校内容和检查功能', provider: deepseek ? 'deepseek' : 'qwen' },
  { id: 'qwen', name: 'Qwen', role: '通用助手', provider: 'qwen' },
  { id: 'codex', name: 'Codex', role: '代码设计与实现', command: 'codex', enabled: local && process.env.ENABLE_CODEX === '1' },
  { id: 'claude', name: 'Claude', role: '推理与写作', command: 'claude', enabled: local && process.env.ENABLE_CLAUDE === '1' },
  { id: 'piagent', name: 'PiAgent', role: '代码分析', command: 'pi', enabled: local && !!process.env.PI_MODEL },
  { id: 'deepseekharness', name: 'DeepSeek Harness', role: '独立运行时', command: 'dsh', enabled: local && process.env.ENABLE_DSH === '1' && !process.env.DEEPSEEKHARNESS_URL, url: process.env.DEEPSEEKHARNESS_URL },
  ...['mastra', 'ohmygame', 'crewai'].map(id => ({
    id, name: { deepseekharness: 'DeepSeek Harness', mastra: 'Mastra', ohmygame: 'OhMyGame', crewai: 'CrewAI' }[id],
    role: '独立运行时', url: process.env[id.toUpperCase() + '_URL']
  }))
];

if (local && !deepseek && !qwen && process.env.CHAT_TEST_AGENT !== '1') {
  agents.push({ id: 'offline', name: '离线示例', role: '演示回复与试玩产物', offline: true });
}
if (process.env.CHAT_TEST_AGENT === '1') agents.unshift(
  { id: 'test', name: '测试助手', role: '测试', test: true },
  { id: 'test-helper', name: '测试子助手', role: '测试', test: true }
);

export const directory = new Map(agents.filter(a => a.test || a.offline || a.url || a.enabled || providers[a.provider]?.key).map(a => [a.id, a]));

async function cli(agent, prompt, signal) {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-chat-'));
  try {
    const args = {
      codex: ['-a', 'never', 'exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-o', join(cwd, 'answer.txt'), '-'],
      claude: ['-p', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence'],
      dsh: ['--profile', 'headless', '--permission-mode', 'read-only', '--approval-policy', 'never', '-'],
      pi: ['-p', '--no-session', '--no-tools', '--no-extensions', '--no-mcp', '--model', process.env.PI_MODEL || '']
    }[agent.command];
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && !(
        (agent.command === 'claude' && /^ANTHROPIC_/.test(key)) ||
        (['pi', 'dsh'].includes(agent.command) && /^(DEEPSEEK|DASHSCOPE|QWEN)_API_KEY$/.test(key))
      )) delete env[key];
    }
    const output = await new Promise((resolve, reject) => {
      const child = spawn(agent.command, args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.setEncoding('utf8').on('data', chunk => {
        output += chunk;
        if (output.length > 500_000) child.kill();
      });
      child.stdin.on('error', () => {});
      child.on('error', reject);
      child.on('close', code => code === 0 && (output.trim() || agent.command === 'codex') ? resolve(output.trim()) : reject(new Error('本地运行时未返回结果')));
      child.stdin.end(prompt);
    });
    return agent.command === 'codex' ? (await readFile(join(cwd, 'answer.txt'), 'utf8')).trim() : output;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export function acceptsImages(agent) {
  return agent.provider === 'deepseek' && /^(deepseek-flash|deepseek-v4-flash(?:-vision-exp)?)$/.test(model);
}

export async function runAgent(agent, system, input, signal, images = []) {
  const canReadImages = acceptsImages(agent);
  if (images.length && !canReadImages) {
    input += '\n所选图片没有传给这个运行时，它不支持当前图片输入。图片：' + images.map(image => image.name).join('、');
  }
  if (agent.offline) {
    if (system.includes('规划 JSON')) return '{"agents":[]}';
    return '这是离线示例。已生成一个点击计数小游戏。\n```html\n<!doctype html><html lang="zh"><meta charset="utf-8"><title>点击挑战</title><style>body{font:24px system-ui;text-align:center;padding:3rem;color:#19392f}button{font:inherit;padding:1rem;border-radius:1rem;background:#d0efde}</style><h1>点击挑战</h1><p>在 5 秒内尽可能多点几次。</p><button id="hit">开始</button><p id="count">0</p><script>let n=0,running=false;hit.onclick=()=>{if(!running){running=true;n=0;hit.textContent="继续点";setTimeout(()=>{running=false;hit.textContent="再玩一次"},5000)}count.textContent=++n};</script></html>\n```';
  }
  if (agent.test) {
    if (input.includes('WAIT')) await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 2500);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    if (system.includes('规划 JSON')) return '{"agents":["test-helper"]}';
    return '已回复。\n```html\n<!doctype html><html><button>试玩</button></html>\n```';
  }
  if (agent.command && !agent.url) return cli(agent, system + '\n\n' + input, signal);
  const provider = providers[agent.provider];
  const key = provider?.key || process.env[agent.id.toUpperCase() + '_TOKEN'];
  const options = provider ? {
    model: provider.model,
    max_tokens: 8192,
    ...(agent.provider === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
    messages: [{ role: 'system', content: system }, { role: 'user', content: canReadImages && images.length ? [
      { type: 'text', text: input },
      ...images.map(image => ({ type: 'image_url', image_url: { url: image.url } }))
    ] : input }]
  } : { system, input };
  const response = await fetch(provider?.url || agent.url, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
    body: JSON.stringify(options)
  });
  if (!response.ok) throw new Error('运行时请求失败（HTTP ' + response.status + '）');
  const result = await response.json();
  const answer = provider ? result.choices?.[0]?.message?.content : result.text;
  if (typeof answer !== 'string' || !answer.trim() || answer.length > 500_000) throw new Error('运行时返回内容无效');
  return answer.trim();
}
