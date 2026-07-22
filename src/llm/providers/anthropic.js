// Anthropic Messages API provider

const { postLlmJson } = require('../transport');

async function chat(config, messages, options = {}) {
  const model = options.model || config.model;
  const maxTokens = options.maxTokens || config.maxTokens || 4096;

  // Convert OpenAI-format messages to Anthropic format
  const systemMessages = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const conversationMessages = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  const body = { model, max_tokens: maxTokens, messages: conversationMessages };
  if (systemMessages) body.system = systemMessages;

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': config.apiKey,
    'anthropic-version': '2023-06-01',
  };

  const data = await postLlmJson({
    baseUrl: config.baseURL,
    endpoint: '/messages',
    headers,
    body,
  });
  const content = data.content?.[0]?.text;
  if (!content) throw new Error('Anthropic returned empty response');

  return {
    content: content.trim(),
    model: data.model || model,
    usage: data.usage || null,
  };
}

module.exports = { chat };
