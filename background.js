/**
 * Springboard Companion - Background Service Worker
 * Proxies LLM requests to bypass CORS restrictions for any user-configured endpoint
 * (OpenAI, OpenRouter, DeepSeek, Groq, Ollama, LM Studio, etc.)
 */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'CALL_LLM') {
    handleLlmCall(request.payload)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // Keep channel open for async sendResponse
  }
});

async function handleLlmCall({ baseUrl, apiKey, model, messages }) {
  const cleanBase = (baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  const url = `${cleanBase}/chat/completions`;

  const headers = {
    'Content-Type': 'application/json'
  };

  if (apiKey && apiKey.trim()) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`;
  }

  const payload = {
    model: model || 'gpt-4o-mini',
    messages: messages,
    temperature: 0.1
  };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    let parsedErr = errorBody;
    try {
      const j = JSON.parse(errorBody);
      if (j.error && j.error.message) parsedErr = j.error.message;
    } catch (_) {}
    throw new Error(`LLM Error (${response.status}): ${parsedErr}`);
  }

  const data = await response.json();
  return data;
}
