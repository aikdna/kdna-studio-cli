// OpenAI-compatible chat completions provider
// Works with: OpenAI, DeepSeek, OpenRouter, Groq, Ollama, LM Studio, Perplexity, and any OpenAI-compatible API

const { postLlmJson } = require('../transport');

async function chat(config, messages, options = {}) {
  const model = options.model || config.model;
  const temperature = options.temperature ?? config.temperature ?? 0.7;
  const maxTokens = options.maxTokens || config.maxTokens || 4096;
  const responseFormat = options.responseFormat || null;

  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (responseFormat) body.response_format = responseFormat;

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey}`,
  };

  // Provider-specific headers
  if (config.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/aikdna/kdna-studio-cli';
    headers['X-Title'] = 'KDNA Studio CLI';
  }

  const data = await postLlmJson({
    baseUrl: config.baseURL,
    endpoint: '/chat/completions',
    headers,
    body,
  });
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM returned empty response');

  return {
    content: content.trim(),
    model: data.model || model,
    usage: data.usage || null,
  };
}

module.exports = { chat };
