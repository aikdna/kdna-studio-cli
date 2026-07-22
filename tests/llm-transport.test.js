'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { WELL_KNOWN, validateConfig } = require('../src/llm/config');
const openai = require('../src/llm/providers/openai');
const anthropic = require('../src/llm/providers/anthropic');
const {
  MAX_LLM_RESPONSE_BYTES,
  canonicalLlmBaseUrl,
  providerEndpoint,
} = require('../src/llm/transport');

const PROVIDER_ROUTE = ['v', '1'].join('');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function baseUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

test('LLM base URLs require external HTTPS or exact numeric loopback HTTP', () => {
  assert.equal(
    canonicalLlmBaseUrl(`https://api.example.test/${PROVIDER_ROUTE}`),
    `https://api.example.test/${PROVIDER_ROUTE}`,
  );
  assert.equal(
    canonicalLlmBaseUrl(`http://127.0.0.1:11434/${PROVIDER_ROUTE}`),
    `http://127.0.0.1:11434/${PROVIDER_ROUTE}`,
  );
  assert.equal(
    canonicalLlmBaseUrl(`http://[::1]:11434/${PROVIDER_ROUTE}`),
    `http://[::1]:11434/${PROVIDER_ROUTE}`,
  );
  assert.equal(
    providerEndpoint(`https://api.example.test/${PROVIDER_ROUTE}`, '/chat/completions'),
    `https://api.example.test/${PROVIDER_ROUTE}/chat/completions`,
  );

  for (const unsafe of [
    `http://localhost:11434/${PROVIDER_ROUTE}`,
    `http://192.168.1.10:11434/${PROVIDER_ROUTE}`,
    `http://api.example.test/${PROVIDER_ROUTE}`,
    `https://user:pass@api.example.test/${PROVIDER_ROUTE}`,
    `https://api.example.test/${PROVIDER_ROUTE}?token=secret`,
    `https://api.example.test/${PROVIDER_ROUTE}#fragment`,
    `https://api.example.test/${PROVIDER_ROUTE}/`,
    `https://api.example.test//${PROVIDER_ROUTE}`,
    'https://api.example.test/%76%31',
    `HTTPS://api.example.test/${PROVIDER_ROUTE}`,
    `https://API.example.test/${PROVIDER_ROUTE}`,
    `https://api.example.test:443/${PROVIDER_ROUTE}`,
    ` https://api.example.test/${PROVIDER_ROUTE}`,
    `https://例子.测试/${PROVIDER_ROUTE}`,
  ]) {
    assert.throws(
      () => canonicalLlmBaseUrl(unsafe),
      (error) => error.code === 'LLM_URL_REFUSED',
      unsafe,
    );
  }

  assert.equal(WELL_KNOWN.local.baseURL, `http://127.0.0.1:11434/${PROVIDER_ROUTE}`);
  assert.equal(WELL_KNOWN.ollama.baseURL, `http://127.0.0.1:11434/${PROVIDER_ROUTE}`);
  assert.equal(
    validateConfig({
      provider: 'openai_compatible',
      apiKey: 'configured',
      model: 'local',
      baseURL: `http://localhost:11434/${PROVIDER_ROUTE}`,
    }).valid,
    false,
  );
});

test('OpenAI-compatible transport sends one bounded request to exact loopback', async () => {
  let observed;
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      observed = {
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(raw),
      };
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        choices: [{ message: { content: 'bounded answer' } }],
        model: 'test-model',
        usage: { total_tokens: 2 },
      }));
    });
  });
  await listen(server);
  try {
    const result = await openai.chat({
      provider: 'openai_compatible',
      baseURL: `${baseUrl(server)}/${PROVIDER_ROUTE}`,
      apiKey: 'request-secret',
      model: 'test-model',
      temperature: 0,
      maxTokens: 32,
    }, [{ role: 'user', content: 'judgment-source-material' }]);
    assert.equal(result.content, 'bounded answer');
    assert.equal(observed.url, `/${PROVIDER_ROUTE}/chat/completions`);
    assert.equal(observed.authorization, 'Bearer request-secret');
    assert.equal(observed.body.messages[0].content, 'judgment-source-material');
  } finally {
    await close(server);
  }
});

test('Anthropic transport uses the same fail-closed request boundary', async () => {
  let observed;
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      observed = { url: request.url, apiKey: request.headers['x-api-key'], body: JSON.parse(raw) };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ content: [{ text: 'anthropic answer' }], model: 'test-model' }));
    });
  });
  await listen(server);
  try {
    const result = await anthropic.chat({
      provider: 'anthropic',
      baseURL: `${baseUrl(server)}/${PROVIDER_ROUTE}`,
      apiKey: 'anthropic-secret',
      model: 'test-model',
      maxTokens: 32,
    }, [
      { role: 'system', content: 'system judgment' },
      { role: 'user', content: 'source material' },
    ]);
    assert.equal(result.content, 'anthropic answer');
    assert.equal(observed.url, `/${PROVIDER_ROUTE}/messages`);
    assert.equal(observed.apiKey, 'anthropic-secret');
    assert.equal(observed.body.system, 'system judgment');
  } finally {
    await close(server);
  }
});

test('LLM redirects are refused before credentials or judgment reach the destination', async () => {
  let destinationRequests = 0;
  const destination = http.createServer((_request, response) => {
    destinationRequests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  const redirector = http.createServer((_request, response) => {
    response.writeHead(307, {
      location: `${baseUrl(destination)}/capture?token=redirect-secret`,
    });
    response.end();
  });
  await listen(destination);
  await listen(redirector);
  try {
    await assert.rejects(
      openai.chat({
        provider: 'openai_compatible',
        baseURL: `${baseUrl(redirector)}/${PROVIDER_ROUTE}`,
        apiKey: 'request-secret',
        model: 'test-model',
      }, [{ role: 'user', content: 'private-judgment-material' }]),
      (error) => {
        assert.equal(error.code, 'LLM_TRANSPORT_FAILED');
        assert.doesNotMatch(
          error.message,
          /127\.0\.0\.1|redirect-secret|request-secret|private-judgment|capture/,
        );
        return true;
      },
    );
    assert.equal(destinationRequests, 0);
  } finally {
    await close(redirector);
    await close(destination);
  }
});

test('LLM HTTP errors never expose provider response bodies', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      error: {
        message: 'token=response-secret; url=https://private.invalid; file=/tmp/provider.json',
      },
    }));
  });
  await listen(server);
  try {
    await assert.rejects(
      openai.chat({
        provider: 'openai_compatible',
        baseURL: `${baseUrl(server)}/${PROVIDER_ROUTE}`,
        apiKey: 'request-secret',
        model: 'test-model',
      }, [{ role: 'user', content: 'private-judgment-material' }]),
      (error) => {
        assert.equal(error.code, 'LLM_HTTP_ERROR');
        assert.equal(error.status, 403);
        assert.match(error.message, /LLM_HTTP_ERROR.*HTTP 403/);
        assert.doesNotMatch(
          error.message,
          /response-secret|private\.invalid|provider\.json|request-secret|private-judgment/,
        );
        return true;
      },
    );
  } finally {
    await close(server);
  }
});

test('LLM successful responses are bounded and invalid content stays sterile', async () => {
  let mode = 'invalid-json';
  const server = http.createServer((_request, response) => {
    if (mode === 'oversized') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(MAX_LLM_RESPONSE_BYTES + 1),
      });
      response.end('{}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"private":"response-secret"');
  });
  await listen(server);
  try {
    for (mode of ['invalid-json', 'oversized']) {
      await assert.rejects(
        openai.chat({
          provider: 'openai_compatible',
          baseURL: `${baseUrl(server)}/${PROVIDER_ROUTE}`,
          apiKey: 'request-secret',
          model: 'test-model',
        }, [{ role: 'user', content: 'private-judgment-material' }]),
        (error) => {
          assert.equal(error.code, 'LLM_RESPONSE_INVALID');
          assert.equal(error.message, 'LLM provider returned an invalid response.');
          assert.doesNotMatch(
            error.message,
            /response-secret|request-secret|private-judgment|127\.0\.0\.1/,
          );
          return true;
        },
      );
    }
  } finally {
    await close(server);
  }
});
