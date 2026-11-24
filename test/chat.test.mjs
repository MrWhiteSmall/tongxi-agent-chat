import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start(directory) {
  const child = spawn(process.execPath, ['server.mjs'], {
    env: { PATH: process.env.PATH, CHAT_DATA: directory, CHAT_TEST_AGENT: '1', CHAT_LOCAL: '0', PORT: '0',
      CHAT_CLEANUP_TOKEN: 'test-cleanup-token', CHAT_ACCOUNTS: JSON.stringify({ A: 'a'.repeat(20), B: 'b'.repeat(20), C: 'c'.repeat(20) }) },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  const port = await new Promise((resolve, reject) => {
    child.once('exit', code => reject(new Error('Server exited ' + code)));
    child.stdout.once('data', chunk => resolve(chunk.toString().match(/:(\d+)\s*$/)?.[1]));
  });
  return { child, base: 'http://127.0.0.1:' + port };
}

test('真人会话、任务、私有团队、附件、产物、重启恢复', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tongxi-e2e-'));
  let server = await start(directory);
  t.after(async () => {
    server.child.kill();
    await rm(directory, { recursive: true, force: true });
  });

  async function request(name, path, body, expected = 200) {
    const response = await fetch(server.base + '/api/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type':'application/json', ...(tokens[name] ? { Authorization: 'Bearer ' + tokens[name] } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    assert.equal(response.status, expected, path);
    return response.json();
  }
  async function settled(room, source) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const snapshot = await request('A', 'rooms/' + room);
      const task = snapshot.tasks.find(task => task.source === source && !task.parent);
      if (task && ['done','failed','cancelled'].includes(task.status)) return { snapshot, task };
      await delay(20);
    }
    assert.fail('任务没有完成');
  }
  const tokens = {};
  await request('A', 'login', { name: 'A', code: 'incorrect' }, 401);
  for (const name of ['A', 'B', 'C']) tokens[name] = (await request(name, 'login', { name, code: name.toLowerCase().repeat(20) })).token;
  const { id: dm } = await request('A', 'rooms', { kind: 'dm', users: ['B'] }, 201);
  const { id: original } = await request('B', 'rooms/' + dm + '/messages', { text: '游戏点子', file: { name: 'idea.txt', data: 'T0s=' } }, 201);
  const originalMessage = (await request('A', 'rooms/' + dm)).messages[0];
  assert.equal((await request('A', 'rooms/' + dm + '/attachment?id=' + originalMessage.attachment.id)).data, 'T0s=');
  await request('C', 'rooms/' + dm, undefined, 404);
  async function upload(size) {
    const form = new FormData();
    form.set('message', JSON.stringify({text:''}));
    form.set('file', new Blob([Buffer.alloc(size, 42)]), '验收附件.bin');
    return fetch(server.base + '/api/rooms/' + dm + '/messages', {
      method:'POST', headers:{Authorization:'Bearer ' + tokens.A}, body:form
    });
  }
  assert.equal((await upload(10_000_000)).status, 413, 'multipart upload must be less than 10 MB');
  const accepted = await upload(9_999_999);
  assert.equal(accepted.status, 201);
  const posted = (await request('B', 'rooms/' + dm)).messages.at(-1);
  const path = server.base + '/api/rooms/' + dm + '/attachment?download=1&id=' + posted.attachment.id;
  assert.equal((await fetch(path, {headers:{Authorization:'Bearer ' + tokens.C}})).status, 404);
  const download = await fetch(path, {headers:{Authorization:'Bearer ' + tokens.B}});
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.alloc(9_999_999, 42));

  const { id: question } = await request('A', 'rooms/' + dm + '/messages', { text: '你怎么看？', agents: ['test'], scope: 'selected', messageIds: [original] }, 201);
  const { snapshot, task } = await settled(dm, question);
  assert.equal(task.status, 'done');
  assert.deepEqual(snapshot.messages.find(message => message.id === question).shared, [original]);
  assert.ok(snapshot.messages.some(message => message.text === '临时加入'));
  assert.ok(snapshot.messages.some(message => message.text === '离开了会话'));
  assert.ok(snapshot.messages.some(message => message.reply === question));

  const earlierAnswer = snapshot.messages.find(message => message.reply === question);
  const { id: reply } = await request('A', 'rooms/' + dm + '/messages', { text: '请评价这条；', agents: ['test-helper'], scope: 'message', replyTo: earlierAnswer.id }, 201);
  const { snapshot: quotedSnapshot } = await settled(dm, reply);
  const replyMessage = quotedSnapshot.messages.find(message => message.id === reply);
  assert.equal(replyMessage.reply, earlierAnswer.id);
  assert.deepEqual(replyMessage.shared, [earlierAnswer.id]);

  const { id: team } = await request('A', 'rooms', { kind: 'team', name: '团队' }, 201);
  await request('B', 'rooms/' + team, undefined, 404);
  assert.deepEqual((await request('A', 'rooms/' + team)).agents, ['test', 'test-helper']);
  await request('A', 'rooms/' + dm + '/forward', { target: team, ids: [original] });
  const { id: brief } = await request('A', 'rooms/' + team + '/messages', { text: '做一个游戏', scope: 'recent' }, 201);
  const work = await settled(team, brief);
  assert.equal(work.task.status, 'done');
  assert.equal(work.snapshot.tasks.find(task => task.parent === work.task.id)?.status, 'done');
  const artifact = await request('A', 'rooms/' + team + '/artifact?task=' + work.task.id);
  const preview = await fetch(server.base + artifact.url);
  assert.ok(preview.headers.get('Content-Security-Policy').includes('sandbox allow-scripts'));
  assert.match(await preview.text(), /试玩/);
  await request('B', 'rooms/' + team + '/artifact?task=' + work.task.id, undefined, 404);
  await request('A', 'rooms/' + team + '/share', { task: work.task.id, target: dm });
  const shared = (await request('B', 'rooms/' + dm)).messages.at(-1);
  assert.equal((await request('B', 'rooms/' + dm + '/artifact?task=' + shared.task)).html, artifact.html);

  await request('A', 'rooms/' + team + '/members', { mode: 'remove', agent: 'test-helper' });
  assert.deepEqual((await request('A', 'rooms/' + team)).agents, ['test']);
  const { id: job } = await request('A', 'rooms/' + team + '/messages', { text: 'WAIT' }, 201);
  const jobs = (await request('A', 'rooms/' + team)).tasks;
  await request('A', 'rooms/' + team + '/cancel', { task: jobs.find(task => task.source === job).id });
  assert.equal((await settled(team, job)).task.status, 'cancelled');
  const { id: interrupted } = await request('A', 'rooms/' + team + '/messages', { text: 'WAIT' }, 201);
  await new Promise(resolve => { server.child.once('exit', resolve); server.child.kill(); });
  server = await start(directory);
  assert.equal((await settled(team, interrupted)).task.status, 'failed');
  assert.equal((await request('A', 'rooms/' + team)).messages[0].text, '转发的消息\nB：游戏点子');

  await request('B', 'rooms/' + dm + '/recall', {message: question}, 403);
  await request('A', 'rooms/' + dm + '/recall', {message: posted.id});
  const recalled = (await request('B', 'rooms/' + dm)).messages.find(message => message.id === posted.id);
  assert.ok(recalled.recalled);
  assert.equal(recalled.text, '');
  assert.equal(recalled.attachment, undefined);
  assert.equal((await fetch(server.base + '/api/rooms/' + dm + '/attachment?download=1&id=' + posted.attachment.id, {headers:{Authorization:'Bearer ' + tokens.B}})).status, 404);
  await request('B', 'rooms/' + dm + '/messages', {text:'引用已撤回消息',replyTo:posted.id}, 404);
  const mention = await request('A', 'rooms/' + dm + '/messages', {text:'@B 来看看',mentions:['B','C']}, 201);
  assert.deepEqual((await request('B', 'rooms/' + dm)).messages.find(message => message.id === mention.id).mentions, ['B']);

  const cleanupUrl = server.base + '/internal/daily-cleanup';
  assert.equal((await fetch(cleanupUrl, {method:'POST'})).status, 404);
  const cleanupHeaders = {Authorization:'Bearer test-cleanup-token'};
  const cleanup = await fetch(cleanupUrl, {method:'POST',headers:cleanupHeaders});
  assert.equal(cleanup.status, 200);
  assert.equal((await cleanup.json()).deleted, 1);
  assert.deepEqual(await readdir(join(directory, 'attachments')), []);
  for (const room of [dm,team]) {
    const snapshot = await request('A', 'rooms/' + room);
    assert.deepEqual(snapshot.messages, []);
    assert.deepEqual(snapshot.tasks, []);
  }
  const next = await request('B', 'rooms/' + dm + '/messages', {text:'清理后的消息'}, 201);
  await fetch(cleanupUrl, {method:'POST',headers:cleanupHeaders});
  assert.equal((await request('A', 'rooms/' + dm)).messages[0].id, next.id);
});
