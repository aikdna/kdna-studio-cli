// KDNA Studio CLI — unified LLM interface
// Supports OpenAI-compatible and Anthropic APIs
// Configuration via KDNA_LLM_* env vars or ~/.kdna/config.json
const { loadConfig, saveConfig, validateConfig } = require('./config');
const openai = require('./providers/openai');
const anthropic = require('./providers/anthropic');

function getProvider(config) {
  if (!config || !config.provider) throw new Error('LLM not configured. Run: kdna-studio llm config');
  if (config.provider === 'anthropic') return anthropic;
  return openai; // All OpenAI-compatible providers use the same API
}

async function chat(messages, options = {}) {
  const config = loadConfig();
  if (options.provider) config.provider = options.provider;
  if (options.model) config.model = options.model;
  if (options.apiKey) config.apiKey = options.apiKey;
  if (options.baseURL) config.baseURL = options.baseURL;

  const validation = validateConfig(config);
  if (!validation.valid) throw new Error(`LLM configuration error:\n${validation.errors.map(e => `  - ${e}`).join('\n')}`);

  const provider = getProvider(config);
  return provider.chat(config, messages, options);
}

async function chatWithJSON(messages, options = {}) {
  const result = await chat(messages, { ...options, responseFormat: { type: 'json_object' } });
  try {
    result.data = JSON.parse(result.content);
  } catch {
    // Try to extract JSON from markdown code blocks
    const match = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try { result.data = JSON.parse(match[1].trim()); } catch { /* raw text */ }
    }
  }
  return result;
}

function config() { return loadConfig(); }

function configure(updates) {
  saveConfig(updates);
  return loadConfig();
}

module.exports = { chat, chatWithJSON, config, configure };
