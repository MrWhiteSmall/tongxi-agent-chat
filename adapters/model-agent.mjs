// This runtime drives a provider session. The provider chooses each next action.
export async function modelAgent(provider, { system, input, signal, images, canReadImages, tools }) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: images.length ? [
      { type: 'text', text: input },
      ...images.map(image => ({ type: 'image_url', image_url: { url: image.url } }))
    ] : input }
  ];
  const inventory = (await tools.list()).filter(tool => tool.name !== 'view_image' || canReadImages).map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
  }));
  for (let turn = 0; turn < 26; turn++) {
    const response = await fetch(provider.url, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + provider.key },
      body: JSON.stringify({ model: provider.model, max_tokens: 8192, ...provider.options, messages,
        ...(inventory.length ? { tools: inventory } : {}) })
    });
    if (!response.ok) throw new Error('Agent 推理请求失败（HTTP ' + response.status + '）');
    const message = (await response.json()).choices?.[0]?.message;
    if (!message?.tool_calls?.length) return message?.content;
    messages.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls });
    const visualResults = [];
    for (const call of message.tool_calls) {
      let args;
      try { args = JSON.parse(call.function.arguments); } catch {}
      const available = inventory.some(tool => tool.function.name === call.function.name);
      const output = args && available ? await tools.call(call.function.name, args)
        : { content: [{ text: available ? '工具参数不是有效的 JSON' : '该工具在本次任务中不可用' }] };
      const returnedImages = output.content.filter(item => item.type === 'image');
      for (const image of returnedImages) {
        visualResults.push({ type: 'text', text: '工具 ' + call.function.name + ' 返回的授权图片 ' + (args?.id || '') },
          { type: 'image_url', image_url: { url: 'data:' + image.mimeType + ';base64,' + image.data } });
      }
      messages.push({ role: 'tool', tool_call_id: call.id,
        content: output.content.map(item => item.text).filter(Boolean).join('\n').slice(0, 50_000) ||
          (returnedImages.length ? '工具返回了下方的图片内容。' : '工具没有返回文本') });
    }
    if (visualResults.length) messages.push({ role: 'user', content: visualResults });
  }
  throw new Error('Agent 已达到单次任务的执行步数上限');
}
