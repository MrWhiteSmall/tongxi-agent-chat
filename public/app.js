import MarkdownIt from './vendor/markdown-it.mjs';

const markdown = new MarkdownIt({ html: false, breaks: true });
markdown.validateLink = value => /^https?:\/\//i.test(value);
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const label = markdown.utils.escapeHtml(token.content || '查看图片');
  const url = markdown.utils.escapeHtml(token.attrGet('src') || '');
  return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
};

const $ = id => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
function button(text, click, className = 'quiet') {
  const node = el('button', text, className);
  node.type = 'button';
  node.addEventListener('click', click);
  return node;
}

let token = sessionStorage.getItem('token');
let app;
let room;
let roomId;
let selected = [];
let mentionedPeople = new Set();
let replyDraft = null;
function speakerName(message) {
  return message.kind === 'human' ? message.sender : nameOf(message.sender);
}

function setReplyDraft(message = null) {
  replyDraft = message;
  $('replyDraft').hidden = !message;
  $('replyText').textContent = message
    ? '回复 ' + speakerName(message) + '：' + (message.text || message.attachment?.name || '').slice(0, 100)
    : '';
}

let draftFiles = [];
const attachmentsOf = message => message.attachments || (message.attachment ? [message.attachment] : []);

function setDraftFiles(files = []) {
  if (files.length > 4 || files.some(file => !file.size || file.size >= 10_000_000) ||
      files.reduce((sum, file) => sum + file.size, 0) > 18_000_000) {
    toast('每条最多 4 个文件，单个小于 10 MB，合计不超过 18 MB');
    $('fileInput').value = '';
    return;
  }
  draftFiles = files;
  $('fileInput').value = '';
  let imageIndex = 0;
  $('fileName').textContent = files.map(file => (/^image\//.test(file.type) ? '图' + (++imageIndex) + ' ' : '') + file.name).join('、');
  $('fileDraft').hidden = !files.length;
}
let contextIds = [];
let historySelection = [];
let refreshing = false;
let toastTimer;
let artifact;
let artifactSource;
let lastFeed = '';
let lastTasks = '';
let lastRooms = '';
const thumbnails = new Map();
let thumbnailObserver;
const seen = new Map();
const mobile = matchMedia('(max-width:640px)');
const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' });
const taskStatus = { queued: '排队中', running: '执行中', done: '已完成', cancelled: '已停止', failed: '失败' };
const mentionNames = [
  { ids: ['deepseek', 'deepseekharness'], name: 'DeepSeek', alias: 'dsh' },
  { ids: ['claude'], name: 'ClaudeCode', alias: 'cc' },
  { ids: ['codex'], name: 'Codex', alias: 'codex' },
  { ids: ['ohmygame'], name: 'ohMygame', alias: 'omg' },
  { ids: ['piagent'], name: 'PiAgent', alias: 'pi' }
];
const nameOf = id => mentionNames.find(agent => agent.ids.includes(id))?.name || app?.catalog.find(agent => agent.id === id)?.name || id;
const titleOf = item => item.kind === 'dm' ? item.users.find(user => user !== app.user) : item.name;
const isActive = task => ['queued', 'running'].includes(task.status);

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}

async function api(path, data) {
  const multipart = data instanceof FormData;
  const response = await fetch('api/' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data === undefined || multipart ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: multipart ? data : JSON.stringify(data) })
  });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status });
  return value;
}

function showLogin() {
  token = null;
  sessionStorage.removeItem('token');
  if ($('attachmentDialog').open) $('attachmentDialog').close();
  clearThumbnails();
  app = room = roomId = null;
  lastRooms = lastFeed = lastTasks = '';
  $('login').hidden = false;
  $('workspace').hidden = true;
  if ($('tasksDialog').open) $('tasksDialog').close();
}

async function refresh() {
  if (!token || refreshing) return;
  refreshing = true;
  const currentToken = token;
  const currentRoom = roomId;
  try {
    const model = await api('state');
    if (token !== currentToken) return;
    app = model;
    $('login').hidden = true;
    $('workspace').hidden = false;
    $('identity').textContent = app.user;
    const snapshot = JSON.stringify(app.rooms);
    if (snapshot !== lastRooms) {
      lastRooms = snapshot;
      renderRoomList();
    }
    $('profileAvatar').textContent = app.user.slice(0, 1);
    $('profileName').textContent = app.user;
    if (currentRoom) {
      const updated = await api('rooms/' + currentRoom);
      if (token === currentToken && currentRoom === roomId) {
        room = updated;
        renderRoom();
      }
    }
  } catch (error) {
    if (error.status === 401 && currentToken === token) showLogin();
    else toast(error.message);
  } finally { refreshing = false; }
}

function renderRoomList() {
  if (!app) return;
  const search = $('roomSearch').value.trim().toLowerCase();
  const sorted = app.rooms.filter(item => titleOf(item).toLowerCase().includes(search))
    .sort((a, b) => (b.lastAt || b.created || 0) - (a.lastAt || a.created || 0));
  $('rooms').replaceChildren(...sorted.map(item => {
    const unread = item.lastAt > (seen.get(item.id) || 0) && item.lastSender !== app.user && item.id !== roomId;
    const link = button('', () => openRoom(item.id), 'room-link' + (item.id === roomId ? ' active' : ''));
    link.dataset.room = item.id;
    const avatar = el('span', item.kind === 'team' ? 'AI' : titleOf(item).slice(0, 1), 'avatar room-avatar ' + item.kind);
    avatar.setAttribute('aria-hidden', 'true');
    const text = el('span', undefined, 'room-copy');
    text.append(el('strong', titleOf(item)), el('small', item.last || (item.kind === 'team' ? '独立 AI 团队' : '暂无消息')));
    const meta = el('span', undefined, 'room-meta');
    if (item.lastAt) meta.append(el('time', clock.format(item.lastAt)));
    if (unread) meta.append(el('i', undefined, 'unread'));
    link.setAttribute('aria-label', titleOf(item));
    link.append(avatar, text, meta);
    return link;
  }));
  if (!sorted.length) $('rooms').append(el('p', search ? '没有找到会话' : '暂无会话', 'list-empty'));
}

function setTab(tab) {
  for (const panel of document.querySelectorAll('.tab-panel')) panel.hidden = panel.id !== tab;
  for (const item of document.querySelectorAll('[data-tab]')) {
    const active = item.dataset.tab === tab;
    item.classList.toggle('active', active);
    item.setAttribute('aria-current', active ? 'page' : 'false');
  }
  $('tabTitle').textContent = { inbox: '同席', contacts: '联系人', profile: '我' }[tab];
  if (tab !== 'contacts' || !app) return;
  const people = app.people.map(name => {
    const row = button('', async () => {
      try {
        const { id } = await api('rooms', { kind: 'dm', users: [name] });
        setTab('inbox');
        await openRoom(id);
      } catch (error) { toast(error.message); }
    }, 'contact-row');
    row.append(el('span', name.slice(0, 1), 'avatar'), el('strong', name));
    return row;
  });
  const agents = listedAgents().map(agent => {
    const row = el('div', undefined, 'contact-row');
    const copy = el('div');
    copy.append(el('strong', agent.name), el('small', [agent.alias && '@' + agent.alias, agent.status].filter(Boolean).join(' · ')));
    row.append(el('span', 'AI', 'avatar'), copy);
    return row;
  });
  $('contactList').replaceChildren(el('h2', '联系人'), ...people, el('h2', 'Agent'), ...agents);
}

async function openRoom(id) {
  if ($('attachmentDialog').open) $('attachmentDialog').close();
  clearThumbnails();
  roomId = id;
  const item = app.rooms.find(item => item.id === id);
  seen.set(id, item?.lastAt || Date.now());
  renderRoomList();
  $('chat').hidden = true;
  $('empty').hidden = false;
  room = null;
  selected = [];
  mentionedPeople.clear();
  if ($('messageActions').open) $('messageActions').close();
  contextIds = [];
  $('scope').value = 'message';
  lastFeed = lastTasks = '';
  $('input').value = '';
  setDraftFiles();
  setReplyDraft();
  $('mentionList').hidden = true;
  $('workspace').classList.add('has-room');
  await refresh();
}

function mentionSpeaker(message) {
  const input = $('input');
  if (message.kind === 'agent') {
    if (!app.catalog.some(agent => agent.id === message.sender) ||
        (room.kind === 'team' && !room.agents.includes(message.sender))) {
      toast(speakerName(message) + ' 当前不可用');
      return;
    }
    if (!selected.includes(message.sender)) selected.push(message.sender);
    renderSelection();
  } else {
    const name = message.sender;
    const start = input.selectionStart;
    const needsSpace = start > 0 && !/\s/.test(input.value[start - 1]);
    const value = (needsSpace ? ' ' : '') + '@' + name + ' ';
    input.setRangeText(value, start, input.selectionEnd, 'end');
    mentionedPeople.add(name);
  }
  $('mentionList').hidden = true;
  input.focus();
}

function quoteMessage(message) {
  setReplyDraft(message);
  $('input').focus();
}

async function copyMessage(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const fallback = el('textarea', text, 'clipboard-fallback');
    $('messageActions').append(fallback);
    fallback.select();
    const copied = document.execCommand('copy');
    fallback.remove();
    if (!copied) throw new Error('复制失败');
  }
}

function showMessageActions(message) {
  const dialog = $('messageActions');
  if (!room || dialog.open || document.querySelector('dialog[open]') ||
      !room.messages.some(item => item.id === message.id && !item.recalled)) return;
  const sourceRoom = roomId;
  const actions = [];
  if (message.text) actions.push(button('复制', async () => {
    try {
      await copyMessage(message.text);
      dialog.close();
      toast('已复制');
    } catch { dialog.close(); toast('复制失败'); }
  }, 'message-action'));
  actions.push(button('引用', () => {
    dialog.close();
    quoteMessage(message);
  }, 'message-action'));
  if (message.kind === 'human' && message.sender === app.user) {
    actions.push(button('撤回', async () => {
      try {
        await api('rooms/' + sourceRoom + '/recall', { message: message.id });
        if (replyDraft?.id === message.id) setReplyDraft();
        if (dialog.open) dialog.close();
        await refresh();
      } catch (error) { toast(error.message); }
    }, 'message-action danger'));
  }
  $('messageActionList').replaceChildren(...actions);
  dialog.showModal();
}

function bindMessageActions(element, message) {
  let press;
  function clear() {
    if (press) clearTimeout(press.timer);
    press = null;
  }
  element.tabIndex = 0;
  element.addEventListener('contextmenu', event => {
    if (event.target.closest('a, button')) return;
    event.preventDefault();
    clear();
    showMessageActions(message);
  });
  element.addEventListener('keydown', event => {
    if (event.target === element && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
      event.preventDefault();
      showMessageActions(message);
    }
  });
  element.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' || !event.isPrimary || event.target.closest('a, button')) return;
    clear();
    const { clientX: x, clientY: y } = event;
    press = { x, y, timer: setTimeout(() => {
      if (element.isConnected) showMessageActions(message);
      clear();
    }, 500) };
  });
  element.addEventListener('pointermove', event => {
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12) clear();
  });
  for (const event of ['pointerup', 'pointercancel', 'pointerleave']) element.addEventListener(event, clear);
}

function clearThumbnails() {
  thumbnailObserver?.disconnect();
  for (const item of thumbnails.values()) if (item.url) URL.revokeObjectURL(item.url);
  thumbnails.clear();
}

function fileSize(size) {
  if (!Number.isFinite(size)) return '';
  if (size < 1024) return size + ' B';
  if (size < 1024 ** 2) return (size / 1024).toFixed(1) + ' KB';
  return (size / 1024 ** 2).toFixed(1) + ' MB';
}

function attachmentBlob(file, sourceRoom, preview) {
  return fetch('api/rooms/' + sourceRoom + '/attachment?' + (preview ? 'preview=1' : 'download=1') +
    '&id=' + encodeURIComponent(file.id), { headers: { Authorization: 'Bearer ' + token } }).then(response => {
    if (!response.ok) throw new Error(preview ? '暂时无法预览附件' : '附件下载失败');
    return response.blob();
  });
}

function thumbnail(file, sourceRoom) {
  let item = thumbnails.get(file.id);
  if (!item) {
    item = {};
    item.loading = attachmentBlob(file, sourceRoom, true).then(blob => {
      if (thumbnails.get(file.id) !== item) return '';
      item.url = URL.createObjectURL(blob);
      return item.url;
    }).catch(() => {
      if (thumbnails.get(file.id) === item) thumbnails.delete(file.id);
      return '';
    });
    thumbnails.set(file.id, item);
  }
  return item.loading;
}

function imageThumbnail(load, label, id) {
  const image = el('img', undefined, 'card-thumbnail');
  image.alt = label;
  image.loading = 'lazy';
  if (id) image.dataset.file = id;
  else void load().then(url => { if (url) image.src = url; });
  image.addEventListener('error', () => {
    image.replaceWith(el('span', '缩略图暂不可用', 'media-fallback'));
  });
  return image;
}

async function openMediaCard(card, sourceRoom) {
  let objectUrl;
  const dialog = $('attachmentDialog');
  try {
    const kind = card.kind;
    const file = card.file;
    const name = card.name;
    const view = $('attachmentView');
    let element;
    if (kind === 'text') {
      const blob = await attachmentBlob(file, sourceRoom, true);
      element = el('pre', await blob.slice(0, 65536).text());
    } else {
      let url = card.url;
      if (!url && kind === 'image') url = await thumbnail(file, sourceRoom);
      if (!url && file) {
        objectUrl = URL.createObjectURL(await attachmentBlob(file, sourceRoom, true));
        url = objectUrl;
      }
      if (!url) throw new Error('暂时无法预览附件');
      element = el(kind === 'image' ? 'img' : kind);
      if (kind === 'image') element.alt = name;
      else { element.controls = true; element.playsInline = true; element.preload = 'metadata'; }
      element.src = url;
      element.addEventListener('error', () => {
        if (element.isConnected) element.replaceWith(el('p', '预览暂不可用，请尝试打开原文件。', 'muted'));
      });
    }
    if (roomId !== sourceRoom || dialog.open) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      return;
    }
    $('attachmentTitle').textContent = name;
    view.replaceChildren(element);
    dialog.showModal();
    dialog.addEventListener('close', () => {
      view.replaceChildren();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }, { once: true });
  } catch (error) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    toast(error.message);
  }
}

function renderAttachmentCard(message, sourceRoom) {
  const file = message.attachment;
  const media = message.media;
  const kind = media?.kind || file.previewType?.split('/')[0] || 'file';
  const name = file?.name || (kind === 'video' ? '百炼视频' : '百炼图片');
  const section = el('section', undefined, 'attachment-card');
  const card = { kind, name, file, url: media?.url };
  if (kind === 'image') {
    const zoom = button('', () => openMediaCard(card, sourceRoom), 'attachment-thumb');
    zoom.setAttribute('aria-label', '预览 ' + name);
    zoom.append(imageThumbnail(media ? () => Promise.resolve(media.url) : () => thumbnail(file, sourceRoom), name, file?.id));
    section.append(zoom);
  } else if (kind === 'video' || kind === 'audio') {
    const play = button(kind === 'video' ? '▷ 播放视频' : '▷ 播放音频', () => openMediaCard(card, sourceRoom), 'attachment-play ' + kind);
    section.append(play);
  }
  const footer = el('div', undefined, 'attachment-meta');
  const label = el('div', undefined, 'attachment-label');
  label.append(el('strong', name));
  const size = fileSize(file?.size);
  if (size) label.append(el('small', size));
  footer.append(label);
  if (kind === 'text') footer.append(button('预览', () => openMediaCard(card, sourceRoom)));
  if (file) {
    const download = button('下载', async () => {
      try { downloadFile(await attachmentBlob(file, sourceRoom, false), file.name); }
      catch (error) { toast(error.message); }
    });
    download.setAttribute('aria-label', '下载 ' + name);
    footer.append(download);
  } else {
    const link = el('a', '打开原文件', 'attachment-open');
    link.href = media.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    footer.append(link);
  }
  section.append(footer);
  return section;
}

function loadVisibleThumbnails(sourceRoom) {
  thumbnailObserver?.disconnect();
  const files = new Map(room.messages.flatMap(attachmentsOf).map(file => [file.id, file]));
  for (const [id, item] of thumbnails) {
    if (!files.has(id)) {
      if (item.url) URL.revokeObjectURL(item.url);
      thumbnails.delete(id);
    }
  }
  thumbnailObserver = new IntersectionObserver(entries => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting) continue;
      thumbnailObserver.unobserve(target);
      const file = files.get(target.dataset.file);
      if (!file) continue;
      void thumbnail(file, sourceRoom).then(url => {
        if (!target.isConnected || roomId !== sourceRoom) return;
        if (url) target.src = url;
        else target.replaceWith(el('span', '缩略图暂不可用', 'media-fallback'));
      });
    }
  }, { root: $('feed'), rootMargin: '150px' });
  for (const image of $('feed').querySelectorAll('img[data-file]')) thumbnailObserver.observe(image);
}

function renderRoom() {
  $('empty').hidden = true;
  $('chat').hidden = false;
  seen.set(roomId, room.messages.at(-1)?.at || Date.now());
  $('roomTitle').textContent = titleOf(room);
  $('roomSub').textContent = room.kind === 'team' ? '独立 AI 团队 · ' + listedAgents(room).filter(agent => agent.memberId).length + ' 位 Agent' : room.kind === 'dm' ? '私聊' : room.users.length + ' 位成员';
  const snapshot = JSON.stringify(room.messages);
  if (snapshot !== lastFeed) {
    const atBottom = !lastFeed || $('feed').scrollHeight - $('feed').scrollTop - $('feed').clientHeight < 100;
    lastFeed = snapshot;
    $('feed').replaceChildren(...room.messages.flatMap((message, index) => {
      const preceding = room.messages[index - 1];
      const timestamp = !preceding || message.at - preceding.at > 5 * 60_000 ? [el('div', clock.format(message.at), 'timestamp')] : [];
      if (message.kind === 'event') return [...timestamp, el('div', nameOf(message.sender) + ' ' + message.text, 'system-message')];
      if (message.recalled) {
        const who = message.sender === app.user ? '你' : message.sender;
        return [...timestamp, el('div', who + '撤回了一条消息', 'system-message')];
      }
      const mine = message.kind === 'human' && message.sender === app.user;
      const row = el('article', undefined, 'message' + (mine ? ' mine' : ''));
      const avatar = button(message.kind === 'agent' ? 'AI' : message.sender.slice(0, 1), () => mentionSpeaker(message), 'avatar message-avatar');
      avatar.setAttribute('aria-label', '@' + speakerName(message));
      row.append(avatar);
      const details = el('div', undefined, 'message-content');
      details.append(el('div', (message.kind === 'human' ? message.sender : nameOf(message.sender)) + (message.kind === 'agent' ? ' · Agent' : ''), 'sender'));
      const source = room.messages.find(item => item.id === message.reply);
      if (source) details.append(el('blockquote', speakerName(source) + '：' + (source.recalled ? '消息已撤回' : (source.text || source.attachment?.name || '').slice(0, 100))));
      if (message.text) {
        const bubble = el('div', undefined, 'bubble');
        bubble.innerHTML = markdown.render(message.media ? message.text.split('\n\n')[0] : message.text);
        details.append(bubble);
      }
      if (message.agents?.length) details.append(el('small', '共享：' + (message.shared?.length ? '本条及历史 ' + message.shared.length + ' 条' : '仅本条') + ' · ' + message.agents.map(nameOf).join('、')));
      for (const file of attachmentsOf(message)) details.append(renderAttachmentCard({ attachment: file }, roomId));
      if (message.media) details.append(renderAttachmentCard({ media: message.media }, roomId));
      if (message.artifact) {
        const card = el('section', undefined, 'attachment-card');
        const footer = el('div', undefined, 'attachment-meta');
        const label = el('div', undefined, 'attachment-label');
        label.append(el('strong', 'HTML 产物'));
        footer.append(label, button('打开预览', () => showArtifact(message.task)));
        card.append(footer);
        details.append(card);
      }
      const reply = button('回复', () => quoteMessage(message), 'reply-action');
      bindMessageActions(details, message);
      reply.setAttribute('aria-label', '回复 ' + speakerName(message) + ' 的消息');
      details.append(reply);
      row.append(details);
      return [...timestamp, row];
    }));
    if (atBottom) $('feed').scrollTop = $('feed').scrollHeight;
    loadVisibleThumbnails(roomId);
  }
  const activeCount = room.tasks.filter(task => !task.parent && isActive(task)).length;
  $('taskCount').textContent = activeCount;
  $('taskCount').hidden = !activeCount;
  if ($('tasksDialog').open) renderTasks();
  renderSelection();
}

function renderTasks() {
  if (!room) return;
  const snapshot = JSON.stringify(room.tasks);
  if (snapshot === lastTasks) return;
  lastTasks = snapshot;
  const expanded = new Set([...$('taskPanel').querySelectorAll('details[open]')].map(item => item.dataset.id));
  const roots = room.tasks.filter(task => !task.parent);
  const items = [...roots.filter(isActive).reverse(), ...roots.filter(task => !isActive(task)).reverse()];
  $('taskPanel').replaceChildren(...items.map(task => {
    const item = el('details', undefined, 'task');
    item.dataset.id = task.id;
    item.open = expanded.has(task.id);
    item.append(el('summary', nameOf(task.agent) + ' · ' + taskStatus[task.status]));
    if (isActive(task) && task.progress) item.append(el('p', task.progress, 'muted'));
    if (task.error) item.append(el('p', task.error, 'muted'));
    for (const child of room.tasks.filter(child => child.parent === task.id)) {
      item.append(el('p', nameOf(child.agent) + ' · ' + taskStatus[child.status] + (child.preview ? '：' + child.preview : '')));
    }
    if (isActive(task) && (room.owner === app.user || room.messages.find(message => message.id === task.source)?.sender === app.user)) {
      item.append(button('停止任务', () => change('cancel', { task: task.id })));
    }
    return item;
  }));
  if (!items.length) $('taskPanel').append(el('p', '当前会话暂无任务。', 'muted'));
}

function listedAgents(conversation = null) {
  const base = app.bailian ? [...mentionNames, { ids: ['qwen'], name: 'Qwen', alias: 'qwen' }] : mentionNames;
  const definitions = app.catalog.some(agent => agent.id === 'offline')
    ? [...base, { ids: ['offline'], name: '离线示例', alias: '' }]
    : base;
  return definitions.map(choice => {
    const available = choice.ids.filter(id => app.catalog.some(agent => agent.id === id));
    const memberId = available.find(id => conversation?.agents.includes(id));
    const activeId = available.find(id => conversation?.tasks?.some(task => task.agent === id && isActive(task)));
    const availableId = memberId || activeId || available[0];
    const id = conversation?.kind === 'team' ? memberId : availableId;
    return { ...choice, id, availableId, memberId, activeId, status: !availableId ? '未接入' : !id ? '未加入' : '' };
  });
}

function typedMentions(text) {
  if (!room) return [];
  const lower = text.toLowerCase();
  return listedAgents(room).filter(agent => [agent.name, agent.alias].filter(Boolean).some(value => {
    const needle = '@' + value.toLowerCase();
    let index = lower.indexOf(needle);
    while (index >= 0) {
      const before = index ? lower[index - 1] : '';
      const after = lower[index + needle.length] || '';
      if ((!before || !/[\w@]/.test(before)) && (!after || !/[\w-]/.test(after))) return true;
      index = lower.indexOf(needle, index + needle.length);
    }
    return false;
  }));
}

function renderSelection() {
  $('selectedAgents').replaceChildren(...selected.map(id => button('@' + nameOf(id) + ' ×', () => {
    selected = selected.filter(item => item !== id);
    renderSelection();
  }, 'chip')));
  $('scopeLabel').hidden = !selected.length && !typedMentions($('input').value).length && room?.kind !== 'team';
}

function mentions(force = false) {
  const input = $('input');
  const before = input.value.slice(0, input.selectionStart);
  const match = before.match(/(?:^|\s)@([^@\n]*)$/);
  const query = match?.[1].trim().toLowerCase() || '';
  if (!room || (!force && (!match || (typedMentions(before).length && /[\s，。？！、：:!?]/.test(query))))) {
    $('mentionList').hidden = true;
    return;
  }
  const candidates = listedAgents(room).filter(agent => !query || [agent.name, agent.alias].some(value => value.toLowerCase().startsWith(query)));
  $('mentionList').replaceChildren(...candidates.map(agent => {
    const option = button('', () => {
      if (!selected.includes(agent.id)) selected.push(agent.id);
      if (match) input.setRangeText('', before.lastIndexOf('@'), input.selectionStart, 'end');
      input.focus();
      $('mentionList').hidden = true;
      renderSelection();
    }, 'mention-option');
    option.disabled = !agent.id;
    option.append(el('span', agent.name));
    if (agent.alias && agent.alias !== agent.name.toLowerCase()) option.append(el('small', '@' + agent.alias));
    if (!agent.id) option.append(el('small', agent.status));
    return option;
  }));
  if (!candidates.length) $('mentionList').append(el('p', '没有匹配的 Agent', 'muted'));
  $('mentionList').hidden = false;
}

async function change(action, data) {
  try {
    await api('rooms/' + roomId + '/' + action, data);
    await refresh();
    if ($('membersDialog').open) renderMembers();
  } catch (error) { toast(error.message); }
}

function renderMembers() {
  const list = $('memberList');
  list.replaceChildren(...room.users.map(user => el('p', user + (user === app.user ? ' · 你' : ''))));
  for (const agent of listedAgents(room)) {
    const line = el('div', undefined, 'member-line');
    const id = agent.memberId || agent.activeId || agent.availableId;
    const lead = id && room.lead === id;
    const status = lead ? '负责人' : agent.memberId ? '已加入' : agent.activeId ? '临时参与' : agent.status;
    const label = el('span', undefined, 'member-agent-copy');
    label.append(el('strong', agent.name));
    if (agent.alias || status) label.append(el('small', [agent.alias && '@' + agent.alias, status].filter(Boolean).join(' · ')));
    line.append(label);
    if (id && (room.kind !== 'group' || room.owner === app.user)) {
      const removing = agent.memberId || agent.activeId;
      line.append(button(removing ? '移除' : '加入', () => change('members', { agent: id, mode: removing ? 'remove' : 'add' })));
      if (agent.memberId && room.kind === 'team' && !lead) line.append(button('设为负责人', () => change('members', { agent: id, mode: 'lead' })));
    }
    list.append(line);
  }
}

async function showArtifact(id) {
  try {
    const result = await api('rooms/' + roomId + '/artifact?task=' + encodeURIComponent(id));
    artifact = result.html;
    artifactSource = { room: roomId, task: id };
    $('shareDestination').replaceChildren(...app.rooms.filter(item => item.id !== roomId).map(item => {
      const option = el('option', titleOf(item));
      option.value = item.id;
      return option;
    }));
    $('share').disabled = !$('shareDestination').options.length;
    $('preview').src = new URL(result.url.slice(1), document.baseURI);
    $('previewDialog').showModal();
  } catch (error) { toast(error.message); }
}

$('share').onclick = async () => {
  try {
    await api('rooms/' + artifactSource.room + '/share', { task: artifactSource.task, target: $('shareDestination').value });
    toast('已分享');
  } catch (error) { toast(error.message); }
};
function downloadFile(blob, name) {
  const link = el('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 3000);
}
$('download').onclick = () => downloadFile(new Blob([artifact], { type: 'text/html' }), 'agent-artifact.html');
$('previewDialog').addEventListener('close', () => { $('preview').removeAttribute('src'); });
for (const close of document.querySelectorAll('[data-close]')) close.onclick = () => close.closest('dialog').close();
$('taskButton').onclick = () => { renderTasks(); $('tasksDialog').showModal(); };
$('memberButton').onclick = () => { renderMembers(); $('membersDialog').showModal(); };
$('mentionButton').onclick = () => { if ($('mentionList').hidden) mentions(true); else $('mentionList').hidden = true; };
$('input').oninput = () => { mentions(); renderSelection(); };
$('input').onkeydown = event => {
  if (event.key === 'Escape') $('mentionList').hidden = true;
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    const choice = !$('mentionList').hidden && $('mentionList').querySelector('button:not([disabled])');
    if (choice) choice.click();
    else $('composer').requestSubmit();
  }
};
$('composer').onsubmit = async event => {
  event.preventDefault();
  if (!room || (!$('input').value.trim() && !draftFiles.length)) return;
  const draft = $('input').value;
  const mentionsInDraft = typedMentions(draft);
  const unavailable = mentionsInDraft.find(agent => !agent.id);
  if (unavailable) return toast(unavailable.name + ' 当前' + unavailable.status);
  const typed = mentionsInDraft.map(agent => agent.id);
  const recipients = [...selected, ...typed];
  const prefix = selected.filter(id => !typed.includes(id)).map(id => '@' + nameOf(id)).join(' ');
  const text = prefix ? prefix + ' ' + draft : draft;
  const submit = event.currentTarget.querySelector('button.primary');
  submit.disabled = true;
  try {
    const sourceRoom = roomId;
    const localFiles = draftFiles;
    const quoted = replyDraft;
    const people = [...mentionedPeople].filter(name => text.includes('@' + name + ' '));
    const message = { text, mentions: people, agents: recipients, scope: $('scope').value, messageIds: contextIds, replyTo: quoted?.id };
    let payload = message;
    if (localFiles.length) {
      payload = new FormData();
      payload.append('message', JSON.stringify(message));
      for (const file of localFiles) payload.append('file', file);
    }
    await api('rooms/' + sourceRoom + '/messages', payload);
    if (roomId !== sourceRoom) return;
    if ($('input').value === draft) $('input').value = '';
    selected = [];
    mentionedPeople.clear();
    if (draftFiles === localFiles) setDraftFiles();
    if (replyDraft === quoted) setReplyDraft();
    $('mentionList').hidden = true;
    await refresh();
  } catch (error) { toast(error.message); }
  finally { submit.disabled = false; }
};
$('loginForm').onsubmit = async event => {
  event.preventDefault();
  try {
    const result = await api('login', { name: $('loginName').value, code: $('loginCode').value });
    token = result.token;
    sessionStorage.setItem('token', token);
    $('loginCode').value = '';
    await refresh();
  } catch (error) { $('loginError').textContent = error.message; }
};
$('logout').onclick = $('mobileLogout').onclick = () => {
  setTab('inbox');
  $('workspace').classList.remove('has-room');
  seen.clear();
  showLogin();
};
$('back').onclick = () => {
  $('workspace').classList.remove('has-room');
  if (mobile.matches) {
    room = roomId = null;
    renderRoomList();
  }
};
for (const tab of document.querySelectorAll('[data-tab]')) tab.onclick = () => setTab(tab.dataset.tab);
$('roomSearch').oninput = renderRoomList;
function createFields() {
  const kind = $('roomKind').value;
  $('roomNameLabel').hidden = kind === 'dm';
  $('people').hidden = kind === 'team';
  $('teamHint').hidden = kind !== 'team';
  $('peopleList').replaceChildren(...app.people.map(name => {
    const label = el('label', undefined, 'person');
    const input = el('input');
    input.type = kind === 'dm' ? 'radio' : 'checkbox';
    input.name = 'member';
    input.value = name;
    label.append(input, el('span', name));
    return label;
  }));
}
$('roomKind').onchange = createFields;
$('newRoom').onclick = () => { $('createForm').reset(); createFields(); $('createDialog').showModal(); };
$('createForm').onsubmit = async event => {
  event.preventDefault();
  try {
    const result = await api('rooms', { kind: $('roomKind').value, name: $('roomName').value, users: new FormData($('createForm')).getAll('member') });
    $('createDialog').close();
    await openRoom(result.id);
  } catch (error) { toast(error.message); }
};

try {
  const config = await api('config');
  $('localHint').hidden = !config.local;
  $('codeLabel').hidden = config.local;
  if (token) await refresh();
  else showLogin();
} catch (error) { showLogin(); toast(error.message); }
setInterval(refresh, 1000);

$('scope').onchange = () => {
  if ($('scope').value !== 'selected') return;
  const candidates = room.messages.filter(message => message.kind !== 'event' && !message.recalled).slice(-30).reverse();
  historySelection = contextIds.filter(id => candidates.some(message => message.id === id));
  const indices = new Map();
  const setIndices = () => {
    let current = draftFiles.filter(file => /^image\//.test(file.type)).length;
    const pictureCount = message => attachmentsOf(message || {}).filter(file => file.previewType?.startsWith('image/')).length +
      Number(message?.media?.kind === 'image');
    current += pictureCount(replyDraft);
    for (const index of indices.values()) index.textContent = '';
    for (const id of historySelection) {
      if (id === replyDraft?.id) continue;
      const count = pictureCount(candidates.find(message => message.id === id));
      if (!count) continue;
      const next = current + 1;
      current += count;
      indices.get(id).textContent = '图' + next + (count > 1 ? '–图' + current : '') + ' ';
    }
  };
  $('historyList').replaceChildren(...candidates.map(message => {
    const label = el('label', undefined, 'person');
    const copy = el('span');
    const badge = el('strong');
    indices.set(message.id, badge);
    const input = el('input');
    input.type = 'checkbox';
    input.value = message.id;
    input.checked = historySelection.includes(message.id);
    input.onchange = () => {
      historySelection = input.checked ? [...historySelection, message.id] : historySelection.filter(id => id !== message.id);
      setIndices();
    };
    copy.append(badge, document.createTextNode(nameOf(message.sender) + '：' +
      (message.text || attachmentsOf(message).map(file => file.name).join('、')).slice(0, 75)));
    label.append(input, copy);
    return label;
  }));
  setIndices();
  $('historyDialog').showModal();
};
$('historyForm').onsubmit = event => {
  event.preventDefault();
  if (historySelection.length > 12) return toast('最多选择 12 条');
  contextIds = historySelection;
  if (!contextIds.length) $('scope').value = 'message';
  $('historyDialog').close();
};

$('fileInput').onchange = () => setDraftFiles([...draftFiles, ...$('fileInput').files]);
$('clearReply').onclick = () => setReplyDraft();
$('clearFile').onclick = () => setDraftFiles();
$('input').addEventListener('paste', event => {
  const clipboard = event.clipboardData;
  if (!clipboard) return;
  const files = Array.from(clipboard.files);
  if (!files.length) {
    for (const item of clipboard.items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
  }
  if (!files.length) return;
  event.preventDefault();
  setDraftFiles([...draftFiles, ...files]);
});
$('forwardButton').onclick = () => {
  const teams = app.rooms.filter(item => item.kind === 'team' && item.id !== roomId);
  if (!teams.length) return toast('请先创建独立 AI 团队');
  $('forwardTarget').replaceChildren(...teams.map(team => {
    const option = el('option', titleOf(team));
    option.value = team.id;
    return option;
  }));
  $('forwardList').replaceChildren(...room.messages.filter(message => message.kind !== 'event' && !message.recalled).slice(-30).reverse().map(message => {
    const label = el('label', undefined, 'person');
    const check = el('input');
    check.type = 'checkbox';
    check.value = message.id;
    label.append(check, el('span', nameOf(message.sender) + '：' + message.text.slice(0, 75)));
    return label;
  }));
  $('forwardDialog').showModal();
};
$('forwardForm').onsubmit = async event => {
  event.preventDefault();
  const ids = [...event.currentTarget.querySelectorAll('input:checked')].map(input => input.value);
  if (!ids.length || ids.length > 12) return toast('请选择 1–12 条消息');
  const target = $('forwardTarget').value;
  try {
    await api('rooms/' + roomId + '/forward', { target, ids });
    $('forwardDialog').close();
    await openRoom(target);
    $('scope').value = 'recent';
  } catch (error) { toast(error.message); }
};
