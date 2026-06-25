// LLM Provider Configuration
// Sources (priority order): env vars > ~/.kdna/config.json > defaults
const fs = require('fs');
const path = require('path');
const os = require('os');

const ENV_PREFIX = 'KDNA_LLM_';

const WELL_KNOWN = {
  openai: { baseURL: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'] },
  anthropic: { baseURL: 'https://api.anthropic.com/v1', models: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-latest'] },
  deepseek: { baseURL: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', models: ['openai/gpt-4o', 'anthropic/claude-sonnet-4', 'deepseek/deepseek-chat'] },
  gemini: { baseURL: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.5-flash', 'gemini-2.5-pro'] },
  perplexity: { baseURL: 'https://api.perplexity.ai', models: ['sonar-pro', 'sonar'] },
  groq: { baseURL: 'https://api.groq.com/openai/v1', models: ['llama-4-scout-17b-16e-instruct', 'deepseek-r1-distill-llama-70b'] },
  local: { baseURL: 'http://localhost:11434/v1', models: ['llama3.2'] },
  ollama: { baseURL: 'http://localhost:11434/v1', models: ['llama3.2'] },
  openai_compatible: { baseURL: null, models: [] },
};

function loadConfig() {
  const config = { provider: null, apiKey: null, model: null, baseURL: null, temperature: 0.7, maxTokens: 4096 };

  // 1. Read from ~/.kdna/config.json
  const configPath = path.join(os.homedir(), '.kdna', 'config.json');
  try { if (fs.existsSync(configPath)) Object.assign(config, JSON.parse(fs.readFileSync(configPath, 'utf8')).llm || {}); } catch (e) { console.error('Error reading LLM config file:', e.message); }

  // 2. Env vars override
  if (process.env.KDNA_LLM_PROVIDER) config.provider = process.env.KDNA_LLM_PROVIDER;
  if (process.env.KDNA_LLM_API_KEY) config.apiKey = process.env.KDNA_LLM_API_KEY;
  if (process.env.KDNA_LLM_MODEL) config.model = process.env.KDNA_LLM_MODEL;
  if (process.env.KDNA_LLM_BASE_URL) config.baseURL = process.env.KDNA_LLM_BASE_URL;
  if (process.env.KDNA_LLM_TEMPERATURE) config.temperature = parseFloat(process.env.KDNA_LLM_TEMPERATURE);
  if (process.env.KDNA_LLM_MAX_TOKENS) config.maxTokens = parseInt(process.env.KDNA_LLM_MAX_TOKENS, 10);

  // 3. Resolve well-known provider
  if (config.provider && WELL_KNOWN[config.provider]) {
    const wk = WELL_KNOWN[config.provider];
    if (wk.baseURL && !config.baseURL) config.baseURL = wk.baseURL;
    if (wk.models.length > 0 && !config.model) config.model = wk.models[0];
  }

  // 4. Provider-specific env var (KDNA_LLM_API_KEY_<PROVIDER>)
  if (!config.apiKey && config.provider) {
    const keyEnv = `KDNA_LLM_API_KEY_${config.provider.toUpperCase().replace(/-/g, '_')}`;
    if (process.env[keyEnv]) config.apiKey = process.env[keyEnv];
  }

  // 5. Provider-native fallback — each provider only uses its own native env var
  if (!config.apiKey && config.provider) {
    const PROVIDER_NATIVE_KEYS = {
      openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      deepseek: 'DEEPSEEK_API_KEY',
      groq: 'GROQ_API_KEY',
      gemini: 'GEMINI_API_KEY',
      perplexity: 'PERPLEXITY_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
    };
    const nativeEnv = PROVIDER_NATIVE_KEYS[config.provider];
    if (nativeEnv && process.env[nativeEnv]) config.apiKey = process.env[nativeEnv];
  }

  return config;
}

function saveConfig(updates) {
  const configPath = path.join(os.homedir(), '.kdna', 'config.json');
  let existing = {};
  try { if (fs.existsSync(configPath)) existing = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) { console.error('Error reading config file for save:', e.message); }
  existing.llm = { ...(existing.llm || {}), ...updates };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n');
}

function validateConfig(config) {
  const errors = [];
  if (!config.provider) errors.push('Missing KDNA_LLM_PROVIDER. Set via env var or ~/.kdna/config.json');
  if (!config.apiKey) errors.push('Missing KDNA_LLM_API_KEY');
  if (!config.model) errors.push('Missing KDNA_LLM_MODEL');
  return { valid: errors.length === 0, errors };
}

module.exports = { loadConfig, saveConfig, validateConfig, WELL_KNOWN };
