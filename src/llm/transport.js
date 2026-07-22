'use strict';

/**
 * Transport boundary for supported AI authoring providers.
 *
 * Requests contain provider credentials plus source evidence, interview
 * answers, or other judgment-authoring material. External providers must use
 * HTTPS. Plain HTTP is limited to exact numeric loopback development hosts;
 * localhost, LAN addresses, and arbitrary hostnames are not exceptions.
 */

const MAX_LLM_URL_BYTES = 2048;
const MAX_LLM_RESPONSE_BYTES = 4 * 1024 * 1024;
const ALLOWED_ENDPOINTS = new Set(['/chat/completions', '/messages']);

class LlmTransportError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'LlmTransportError';
    this.code = code;
    this.status = Number.isInteger(status) ? status : null;
  }
}

function isExactLoopback(hostname) {
  return hostname === '127.0.0.1' || hostname === '[::1]';
}

function canonicalLlmBaseUrl(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_LLM_URL_BYTES ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        character === '\\' ||
        character === '?' ||
        character === '#' ||
        codePoint < 0x21 ||
        codePoint > 0x7e
      );
    })
  ) {
    throw new LlmTransportError(
      'LLM_URL_REFUSED',
      'LLM base URL must be a canonical visible-ASCII URL.',
    );
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new LlmTransportError('LLM_URL_REFUSED', 'LLM base URL must be absolute.');
  }
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname.includes('%') ||
    parsed.pathname
      .split('/')
      .some((segment, index) =>
        segment === '.' ||
        segment === '..' ||
        (index > 0 && segment === '' && parsed.pathname !== '/'))
  ) {
    throw new LlmTransportError(
      'LLM_URL_REFUSED',
      'LLM base URL contains credentials or an unsupported component.',
    );
  }
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && isExactLoopback(parsed.hostname))
  ) {
    throw new LlmTransportError(
      'LLM_URL_REFUSED',
      'LLM base URL must use HTTPS except for an exact loopback HTTP origin.',
    );
  }

  const canonical = parsed.pathname === '/' ? parsed.origin : `${parsed.origin}${parsed.pathname}`;
  if (value !== canonical || (parsed.pathname !== '/' && parsed.pathname.endsWith('/'))) {
    throw new LlmTransportError('LLM_URL_REFUSED', 'LLM base URL is not canonical.');
  }
  return canonical;
}

function providerEndpoint(baseUrl, endpoint) {
  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    throw new LlmTransportError('LLM_URL_REFUSED', 'LLM provider endpoint is not admitted.');
  }
  return `${canonicalLlmBaseUrl(baseUrl)}${endpoint}`;
}

async function refuseInvalidResponse(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Response bytes never cross the transport boundary.
  }
  throw new LlmTransportError('LLM_RESPONSE_INVALID', 'LLM provider returned an invalid response.');
}

async function readBoundedJson(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    return refuseInvalidResponse(response);
  }
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^(0|[1-9]\d*)$/.test(contentLength) || Number(contentLength) > MAX_LLM_RESPONSE_BYTES)
  ) {
    return refuseInvalidResponse(response);
  }
  if (!response.body) {
    return refuseInvalidResponse(response);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_LLM_RESPONSE_BYTES) {
        await reader.cancel();
        throw new LlmTransportError(
          'LLM_RESPONSE_INVALID',
          'LLM provider returned an invalid response.',
        );
      }
      chunks.push(Buffer.from(value));
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('not an object');
    }
    return payload;
  } catch (error) {
    if (error instanceof LlmTransportError) throw error;
    throw new LlmTransportError('LLM_RESPONSE_INVALID', 'LLM provider returned an invalid response.');
  } finally {
    reader.releaseLock();
  }
}

async function postLlmJson({ baseUrl, endpoint, headers, body, timeoutMs = 120000 }) {
  const url = providerEndpoint(baseUrl, endpoint);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new LlmTransportError(
      'LLM_TRANSPORT_FAILED',
      'LLM provider request failed [LLM_TRANSPORT_FAILED].',
    );
  }

  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // Nothing from the provider response crosses the error boundary.
    }
    throw new LlmTransportError(
      'LLM_HTTP_ERROR',
      `LLM provider rejected the request [LLM_HTTP_ERROR] (HTTP ${response.status}).`,
      response.status,
    );
  }
  return readBoundedJson(response);
}

module.exports = {
  LlmTransportError,
  MAX_LLM_RESPONSE_BYTES,
  canonicalLlmBaseUrl,
  isExactLoopback,
  postLlmJson,
  providerEndpoint,
};
