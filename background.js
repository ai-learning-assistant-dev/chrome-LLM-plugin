// Background service worker for API calls - supports multiple LLM providers

// Track last active content tab per window (excludes extension pages)
const lastActiveContentTab = {}; // windowId -> tabId

// Preset provider configurations
const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    modelsEndpoint: 'https://api.openai.com/v1/models',
    modelKey: 'id',
    defaultModel: 'gpt-4o'
  },
  deepseek: {
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    modelsEndpoint: 'https://api.deepseek.com/v1/models',
    modelKey: 'id',
    defaultModel: 'deepseek-chat'
  },
  siliconflow: {
    name: 'SiliconFlow (硅基流动)',
    endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
    modelsEndpoint: 'https://api.siliconflow.cn/v1/models',
    modelKey: 'id',
    defaultModel: 'deepseek-ai/DeepSeek-V2.5'
  },
  ollama: {
    name: 'Ollama (本地)',
    endpoint: 'http://localhost:11434/v1/chat/completions',
    modelsEndpoint: 'http://localhost:11434/api/tags',
    modelKey: 'name',
    defaultModel: 'llama3',
    isLocal: true
  },
  custom: {
    name: '自定义 API',
    endpoint: '',
    modelsEndpoint: '',
    modelKey: 'id',
    defaultModel: ''
  }
};

// Track active stream AbortControllers keyed by senderTabId
const activeStreams = {}; // senderTabId -> AbortController
// Track active stream state so popup can reconnect after closing/reopening
const streamSessions = {}; // senderTabId -> { messageId, content, done, stopped }

// ===== Context Menu: Translate Paragraph =====
// Create context menu item (idempotent - safe to call at startup)
function setupContextMenu() {
  // Remove first to avoid duplicates on SW restart
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'translate-paragraph',
      title: '🌐 翻译此段落',
      contexts: ['all']
    });
  });
}
setupContextMenu();

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'translate-paragraph') return;
  if (!tab || !tab.id) return;

  try {
    // Step 1: Get LLM config from storage
    const stored = await chrome.storage.local.get(['provider', 'apiKey', 'model', 'customEndpoint']);
    const { provider, apiKey, model, customEndpoint } = stored;

    if (!provider || !apiKey) {
      console.log('[Translation] No API config - user needs to configure first');
      return;
    }

    const actualModel = model || (provider === 'custom' ? 'custom-model' : '');
    const config = { provider, apiKey, model: actualModel, customEndpoint: customEndpoint || '' };

    // Step 2: Get the clicked element's text from content script
    const elementResp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CLICKED_ELEMENT_TEXT' });
    if (!elementResp || !elementResp.text || elementResp.text.trim().length < 5) {
      console.log('[Translation] No valid text from clicked element');
      return;
    }

    const originalText = elementResp.text.trim();
    console.log('[Translation] Translating:', originalText.substring(0, 80) + '...');

    // Step 3: Insert loading placeholder immediately (before slow LLM call)
    const placeholderResp = await chrome.tabs.sendMessage(tab.id, { type: 'INSERT_TRANSLATION_PLACEHOLDER' });
    const placeholderId = (placeholderResp && placeholderResp.placeholderId) ? placeholderResp.placeholderId : -1;

    try {
      // Step 4: Translate
      const systemPrompt = `You are a professional translator. Translate the following text into Simplified Chinese (简体中文).

Rules:
1. Return ONLY the translated text - no explanations, no JSON, no markdown
2. Preserve the original meaning, tone, and style
3. If the text is already in Chinese, return it unchanged
4. If the text is code or a technical term that should not be translated, return it unchanged`;

      const result = await translateBatch(config, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: originalText }
      ]);

      const translatedText = result.content ? result.content.trim() : '';

      if (!translatedText) {
        console.log('[Translation] Empty translation result');
        // Update placeholder with error
        await chrome.tabs.sendMessage(tab.id, {
          type: 'UPDATE_TRANSLATION',
          placeholderId: placeholderId,
          translatedText: '',
          error: true
        }).catch(() => {});
        return;
      }

      console.log('[Translation] Result:', translatedText.substring(0, 80) + '...');

      // Step 5: Update the placeholder with real translation
      await chrome.tabs.sendMessage(tab.id, {
        type: 'UPDATE_TRANSLATION',
        placeholderId: placeholderId,
        translatedText: translatedText,
        error: false
      });

    } catch (translateError) {
      console.error('[Translation] Translation error:', translateError);
      // Update placeholder with error state
      await chrome.tabs.sendMessage(tab.id, {
        type: 'UPDATE_TRANSLATION',
        placeholderId: placeholderId,
        translatedText: '',
        error: true
      }).catch(() => {});
    }

  } catch (error) {
    console.error('[Translation] Context menu translation error:', error);
  }
});

// Handle messages from popup / sidepanel
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'SEND_TO_AI') {
    // For streaming, we don't wait for response - chunks are sent via chrome.runtime.sendMessage
    sendToLLM(request.config, request.messages, request.tools, request.senderTabId).catch(error => {
      console.error('[DEBUG] sendToLLM error:', error);
      // Only send error if it's not an abort
      if (error.name !== 'AbortError') {
        chrome.runtime.sendMessage({
          type: 'STREAM_ERROR',
          error: error.message,
          senderTabId: request.senderTabId
        }).catch(() => {});
      }
    });
    sendResponse({ started: true });
    return true;
  }

  if (request.type === 'STOP_STREAM') {
    const controller = activeStreams[request.senderTabId];
    if (controller) {
      console.log('[DEBUG] Aborting stream for tab:', request.senderTabId);
      controller.abort();
      delete activeStreams[request.senderTabId];
      delete streamSessions[request.senderTabId];
    }
    sendResponse({ stopped: true });
    return true;
  }

  if (request.type === 'FETCH_MODELS') {
    fetchModels(request.config)
      .then(models => sendResponse({ models }))
      .catch(error => sendResponse({ error: error.message, models: [] }));
    return true;
  }

  if (request.type === 'GET_PROVIDERS') {
    sendResponse({ providers: PROVIDERS });
    return true;
  }

  // Return the active content tab for the current window
  if (request.type === 'GET_ACTIVE_CONTENT_TAB') {
    const windowId = request.windowId;

    // First, try to get the currently active tab in this window
    chrome.tabs.query({ active: true, windowId: windowId }, (activeTabs) => {
      if (activeTabs && activeTabs.length > 0) {
        const activeTab = activeTabs[0];
        // If the active tab is a content tab (not extension), use it directly
        if (activeTab.url && !activeTab.url.startsWith('chrome-extension://') && !activeTab.url.startsWith('chrome://')) {
          lastActiveContentTab[windowId] = activeTab.id;
          sendResponse({ tabId: activeTab.id });
          return;
        }
      }

      // Fallback: find the first non-extension tab in this window (e.g., when sidepanel is active)
      chrome.tabs.query({ windowId: windowId }, (tabs) => {
        if (tabs && tabs.length > 0) {
          const targetTab = tabs.find(t =>
            t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://')
          );

          if (targetTab) {
            lastActiveContentTab[windowId] = targetTab.id;
            sendResponse({ tabId: targetTab.id });
          } else {
            sendResponse({ tabId: null });
          }
        } else {
          sendResponse({ tabId: null });
        }
      });
    });
    return true;
  }

  if (request.type === 'WEB_SEARCH') {
    performWebSearch(request.query, request.senderTabId)
      .then(results => sendResponse({ results }))
      .catch(error => sendResponse({ error: error.message, results: [] }));
    return true;
  }

  if (request.type === 'GET_STREAM_STATE') {
    const session = streamSessions[request.senderTabId];
    if (session) {
      sendResponse({
        active: true,
        messageId: session.messageId,
        content: session.content,
        done: session.done
      });
    } else {
      sendResponse({ active: false });
    }
    return true;
  }
});

// Track active content tab, ignoring extension pages (sidepanel, devtools, etc.)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const { tabId, windowId } = activeInfo;
  try {
    const tab = await chrome.tabs.get(tabId);
    // Skip extension pages - we want the actual content tab
    if (tab.url && !tab.url.startsWith('chrome-extension://')) {
      lastActiveContentTab[windowId] = tabId;
    }
  } catch (e) {
    // Tab may not be accessible
  }
});

// Also update on tab URL changes (e.g. navigation within same tab)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const windowId = tab.windowId;
    // If this tab is the currently tracked one, update it
    if (lastActiveContentTab[windowId] === tabId) {
      if (tab.url && !tab.url.startsWith('chrome-extension://')) {
        lastActiveContentTab[windowId] = tabId;
      }
    }
  }
});

// ===== Web Search =====

// Perform a web search by opening a Bing search tab, extracting results, then closing it
async function performWebSearch(query, senderTabId) {
  const searchUrl = 'https://www.bing.com/search?q=' + encodeURIComponent(query);

  console.log('[WebSearch] Searching Bing for:', query);

  // Create a new tab with the Bing search
  let tab;
  try {
    tab = await chrome.tabs.create({ url: searchUrl, active: false });
  } catch (e) {
    throw new Error('无法创建搜索标签页: ' + e.message);
  }

  if (!tab || !tab.id) {
    throw new Error('无法创建搜索标签页');
  }

  const tabId = tab.id;
  console.log('[WebSearch] Created search tab:', tabId);

  try {
    // Wait for the tab to finish loading
    let loaded = false;
    const maxWaitMs = 15000; // 15 second timeout
    const pollIntervalMs = 500;

    const tabLoadPromise = new Promise((resolve, reject) => {
      const checkComplete = () => {
        if (loaded) return;
        chrome.tabs.get(tabId, (t) => {
          if (chrome.runtime.lastError || !t) {
            reject(new Error('搜索标签页已关闭'));
            return;
          }
          if (t.status === 'complete') {
            loaded = true;
            resolve();
          }
        });
      };

      // Listen for tab update events for faster detection
      const updateListener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          loaded = true;
          chrome.tabs.onUpdated.removeListener(updateListener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(updateListener);

      // Poll as fallback
      const pollInterval = setInterval(() => {
        checkComplete();
      }, pollIntervalMs);

      // Timeout
      const timeoutId = setTimeout(() => {
        clearInterval(pollInterval);
        chrome.tabs.onUpdated.removeListener(updateListener);
        if (!loaded) {
          reject(new Error('搜索页面加载超时'));
        }
      }, maxWaitMs);

      // Cleanup on resolve
      const origResolve = resolve;
      resolve = () => {
        clearInterval(pollInterval);
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(updateListener);
        origResolve();
      };
    });

    await tabLoadPromise;
    console.log('[WebSearch] Search tab loaded, extracting results...');

    // Extract results from the Bing page
    const extractResp = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_BING_RESULTS' });

    const results = (extractResp && extractResp.results) ? extractResp.results : [];
    console.log('[WebSearch] Extracted', results.length, 'results');

    // Close the search tab
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {
      console.warn('[WebSearch] Could not close search tab:', e.message);
    }

    return results;

  } catch (error) {
    // Clean up: try to close the search tab
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {
      // Ignore close errors
    }
    throw error;
  }
}

async function fetchModels(config) {
  const { provider, apiKey, customEndpoint, customModelsEndpoint } = config;

  if (provider === 'custom') {
    if (!customEndpoint) {
      throw new Error('请填写自定义 API 端点');
    }
    return [];
  }

  const providerConfig = PROVIDERS[provider];
  const endpoint = providerConfig.modelsEndpoint;

  if (!endpoint || !apiKey) {
    return [];
  }

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();

    // Different APIs have different response structures
    if (provider === 'ollama') {
      return (data.models || []).map(m => m.name || m.model_name);
    }

    const modelKey = providerConfig.modelKey;
    const models = data.data || data.models || [];

    return models
      .filter(m => {
        const id = m[modelKey] || m.id || m.name;
        // Filter out non-chat models for better UX
        return id && !id.includes('embed') && !id.includes('embedding') && !id.includes('tts') && !id.includes('whisper');
      })
      .map(m => m[modelKey] || m.id || m.name);
  } catch (error) {
    console.error('Error fetching models:', error);
    throw error;
  }
}

// Non-streaming LLM call for translation (returns full response at once)
async function translateBatch(config, messages) {
  const { provider, apiKey, model, customEndpoint } = config;

  if (!apiKey) throw new Error('请先填写 API Key');
  if (!model) throw new Error('请选择模型');

  let endpoint;
  if (provider === 'custom') {
    endpoint = customEndpoint;
    if (!endpoint) throw new Error('请填写自定义 API 端点');
  } else {
    endpoint = PROVIDERS[provider].endpoint;
  }

  const body = {
    model: model,
    messages: messages,
    stream: false
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    let errorMsg = `API error: ${response.status}`;
    try {
      const errorData = await response.json();
      errorMsg = errorData.error?.message || errorData.message || errorMsg;
    } catch (e) {}
    throw new Error(errorMsg);
  }

  const data = await response.json();
  return { content: data.choices?.[0]?.message?.content || '' };
}

async function sendToLLM(config, messages, tools, senderTabId) {
  const { provider, apiKey, model, customEndpoint } = config;
  console.log('[DEBUG] sendToLLM called, provider:', provider, 'model:', model, 'hasTools:', !!tools);

  if (!apiKey) {
    console.error('[DEBUG] No API key');
    throw new Error('请先填写 API Key');
  }

  if (!model) {
    console.error('[DEBUG] No model');
    throw new Error('请选择模型');
  }

  let endpoint;

  if (provider === 'custom') {
    endpoint = customEndpoint;
    if (!endpoint) {
      console.error('[DEBUG] No custom endpoint');
      throw new Error('请填写自定义 API 端点');
    }
  } else {
    endpoint = PROVIDERS[provider].endpoint;
  }
  console.log('[DEBUG] Endpoint:', endpoint);

  // Build request body for OpenAI-compatible API
  const body = {
    model: model,
    messages: messages,
    stream: true
  };

  // Add tools if provided
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  // Add max_tokens for providers that require it
  if (provider === 'anthropic') {
    body.max_tokens = 1024;
  }

  // Create AbortController and store it so user can stop the stream
  const abortController = new AbortController();
  activeStreams[senderTabId] = abortController;

  console.log('[DEBUG] Sending fetch request...');
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: abortController.signal
    });
  } catch (fetchError) {
    delete activeStreams[senderTabId];
    delete streamSessions[senderTabId];
    if (fetchError.name === 'AbortError') {
      console.log('[DEBUG] Fetch aborted by user for tab:', senderTabId);
      return { content: '', stopped: true };
    }
    throw fetchError;
  }
  console.log('[DEBUG] Response status:', response.status);

  if (!response.ok) {
    delete activeStreams[senderTabId];
    delete streamSessions[senderTabId];
    let errorMsg = `API error: ${response.status}`;
    try {
      const errorData = await response.json();
      errorMsg = errorData.error?.message || errorData.message || errorMsg;
    } catch (e) {}
    console.error('[DEBUG] Response not ok:', errorMsg);
    chrome.runtime.sendMessage({
      type: 'STREAM_ERROR',
      error: errorMsg,
      senderTabId
    }).catch(e => console.error('[DEBUG] Failed to send STREAM_ERROR:', e));
    return { error: errorMsg };
  }

  // Process the streaming response - this may involve tool calls
  const result = await processStreamResponse(response, endpoint, config, messages, tools, abortController, senderTabId);

  // Clean up the abort controller
  delete activeStreams[senderTabId];

  return result;
}

// Process a streaming SSE response, handling tool calls if present
async function processStreamResponse(response, endpoint, config, messages, tools, abortController, senderTabId) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';
  let messageId = Date.now().toString();

  // Track tool calls in streaming response
  let toolCalls = {}; // index -> { id, name, arguments }
  let hasToolCalls = false;

  // Send initial "start" event and initialize stream session
  console.log('[DEBUG] Sending STREAM_START, senderTabId:', senderTabId);
  streamSessions[senderTabId] = { messageId, content: '', done: false, stopped: false };
  setTimeout(() => {
    chrome.runtime.sendMessage({
      type: 'STREAM_START',
      messageId,
      senderTabId
    }).catch(e => console.error('[DEBUG] Failed to send STREAM_START:', e));
  }, 0);

  try {
    while (true) {
      let readResult;
      try {
        readResult = await reader.read();
      } catch (readError) {
        if (readError.name === 'AbortError' || abortController.signal.aborted) {
          console.log('[DEBUG] Stream reading aborted for tab:', senderTabId);
          break;
        }
        throw readError;
      }
      const { done, value } = readResult;
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            console.log('[DEBUG] Received [DONE]');
            if (!hasToolCalls) {
              // Normal completion: send final chunk and return early (skip tool-call loop below)
              streamSessions[senderTabId].done = true;
              setTimeout(() => {
                chrome.runtime.sendMessage({
                  type: 'STREAM_CHUNK',
                  messageId,
                  content: fullContent,
                  done: true,
                  senderTabId
                }).catch(e => console.error('[DEBUG] Failed to send final STREAM_CHUNK:', e));
              }, 0);

              console.log('[DEBUG] Stream complete (no tool calls), total content length:', fullContent.length);
              setTimeout(() => { delete streamSessions[senderTabId]; }, 30000);
              return {
                content: fullContent,
                id: messageId
              };
            }
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            const delta = choice?.delta || {};

            // Check for tool calls in delta
            if (delta.tool_calls && delta.tool_calls.length > 0) {
              hasToolCalls = true;
              for (const tc of delta.tool_calls) {
                const idx = tc.index !== undefined ? tc.index : 0;
                if (!toolCalls[idx]) {
                  toolCalls[idx] = { id: tc.id || '', name: '', arguments: '' };
                }
                if (tc.id) toolCalls[idx].id = tc.id;
                if (tc.function?.name) toolCalls[idx].name += tc.function.name;
                if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
              }
            }

            // Also track content in case of mixed response
            const content = delta.content || '';
            if (content && !hasToolCalls) {
              fullContent += content;
              // Update stream session for reconnection
              if (streamSessions[senderTabId]) {
                streamSessions[senderTabId].content = fullContent;
              }
              // Send streaming chunk
              const chunkContent = fullContent;
              setTimeout(() => {
                chrome.runtime.sendMessage({
                  type: 'STREAM_CHUNK',
                  messageId,
                  content: chunkContent,
                  done: false,
                  senderTabId
                }).catch(e => console.error('[DEBUG] Failed to send STREAM_CHUNK:', e));
              }, 0);
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Handle tool calls if detected
  if (hasToolCalls && Object.keys(toolCalls).length > 0) {
    console.log('[DEBUG] Detected tool calls:', Object.keys(toolCalls).length);

    // Notify popup that we're searching
    fullContent = fullContent + '\n\n🔍 *正在搜索网页...*';
    if (streamSessions[senderTabId]) streamSessions[senderTabId].content = fullContent;
    chrome.runtime.sendMessage({
      type: 'STREAM_CHUNK',
      messageId,
      content: fullContent,
      done: false,
      senderTabId
    }).catch(e => console.error('[DEBUG] Failed to send search indicator:', e));

    // Execute each tool call
    const toolResults = [];
    const sortedCalls = Object.keys(toolCalls).sort().map(k => toolCalls[k]);

    for (const toolCall of sortedCalls) {
      if (toolCall.name === 'web_search') {
        try {
          const args = JSON.parse(toolCall.arguments || '{}');
          const query = args.query || '';
          console.log('[DEBUG] Executing web_search for:', query);

          // Send search notification
          fullContent = fullContent + '\n\n🔍 *正在搜索: ' + query + '...*';
          if (streamSessions[senderTabId]) streamSessions[senderTabId].content = fullContent;
          chrome.runtime.sendMessage({
            type: 'STREAM_CHUNK',
            messageId,
            content: fullContent,
            done: false,
            senderTabId
          }).catch(() => {});

          const searchResults = await performWebSearch(query, senderTabId);

          // Format results for the AI
          const resultsText = searchResults.length > 0
            ? JSON.stringify(searchResults, null, 2)
            : '没有找到相关结果';

          toolResults.push({
            tool_call_id: toolCall.id,
            role: 'tool',
            content: resultsText
          });

          fullContent += '\n\n🔍 **搜索结果: ' + query + '**\n';
          if (searchResults.length > 0) {
            searchResults.forEach((r, i) => {
              fullContent += (i + 1) + '. [' + r.title + '](' + r.url + ')\n';
            });
          } else {
            fullContent += '没有找到结果\n';
          }

          console.log('[DEBUG] Web search completed, got', searchResults.length, 'results');
        } catch (e) {
          console.error('[DEBUG] Web search error:', e);
          toolResults.push({
            tool_call_id: toolCall.id,
            role: 'tool',
            content: '搜索出错: ' + e.message
          });
        }
      } else {
        // Unknown tool
        toolResults.push({
          tool_call_id: toolCall.id,
          role: 'tool',
          content: '未知工具: ' + toolCall.name
        });
      }
    }

    // Build the assistant's tool call message
    const assistantToolMsg = {
      role: 'assistant',
      content: null,
      tool_calls: sortedCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: tc.arguments
        }
      }))
    };

    // Start with messages extended by tool call + results
    let followUpMessages = [
      ...messages,
      assistantToolMsg,
      ...toolResults
    ];

    // Multi-round tool calling: loop until AI returns text content (no more tool_calls)
    const MAX_TOOL_ROUNDS = 3;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      console.log('[DEBUG] Tool call round', round + 1, 'of max', MAX_TOOL_ROUNDS);

      // Make a streaming follow-up call
      let roundContent = '';
      let roundToolCalls = {};
      let roundHasToolCalls = false;

      try {
        const { apiKey, model, provider, customEndpoint } = config;
        let ep = provider === 'custom' ? customEndpoint : PROVIDERS[provider].endpoint;

        const followUpBody = {
          model: model,
          messages: followUpMessages,
          stream: true
        };

        if (tools && tools.length > 0) {
          followUpBody.tools = tools;
          followUpBody.tool_choice = 'auto';
        }

        const roundResponse = await fetch(ep, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify(followUpBody),
          signal: abortController.signal
        });

        if (!roundResponse.ok) {
          console.error('[DEBUG] Follow-up API call failed:', roundResponse.status);
          fullContent += '\n\n*(搜索完成但生成回复失败)*';
          break;
        }

        // Stream the follow-up response to extract content and detect tool calls
        const roundReader = roundResponse.body.getReader();
        const roundDecoder = new TextDecoder();
        let roundBuffer = '';

        try {
          while (true) {
            const { done, value } = await roundReader.read();
            if (done) break;

            const chunk = roundDecoder.decode(value, { stream: true });
            roundBuffer += chunk;
            const lines = roundBuffer.split('\n');
            roundBuffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;
                try {
                  const parsed = JSON.parse(data);
                  const delta = parsed.choices?.[0]?.delta || {};

                  // Check for tool calls
                  if (delta.tool_calls && delta.tool_calls.length > 0) {
                    roundHasToolCalls = true;
                    for (const tc of delta.tool_calls) {
                      const idx = tc.index !== undefined ? tc.index : 0;
                      if (!roundToolCalls[idx]) {
                        roundToolCalls[idx] = { id: tc.id || '', name: '', arguments: '' };
                      }
                      if (tc.id) roundToolCalls[idx].id = tc.id;
                      if (tc.function?.name) roundToolCalls[idx].name += tc.function.name;
                      if (tc.function?.arguments) roundToolCalls[idx].arguments += tc.function.arguments;
                    }
                  }

                  // Accumulate text content
                  const textContent = delta.content || '';
                  if (textContent && !roundHasToolCalls) {
                    roundContent += textContent;
                    fullContent += textContent;
                    if (streamSessions[senderTabId]) streamSessions[senderTabId].content = fullContent;

                    // Send streaming update to popup
                    chrome.runtime.sendMessage({
                      type: 'STREAM_CHUNK',
                      messageId,
                      content: fullContent,
                      done: false,
                      senderTabId
                    }).catch(() => {});
                  }
                } catch (e) { /* skip invalid JSON */ }
              }
            }
          }
        } finally {
          roundReader.releaseLock();
        }

        // If the AI returned text content and no more tool calls, we're done
        if (!roundHasToolCalls && roundContent) {
          console.log('[DEBUG] AI returned final text content, done after round', round + 1);
          break;
        }

        // If the AI wants more tool calls, execute them
        if (roundHasToolCalls && Object.keys(roundToolCalls).length > 0) {
          console.log('[DEBUG] Round', round + 1, 'detected more tool calls:', Object.keys(roundToolCalls).length);

          const assistantMsg = {
            role: 'assistant',
            content: roundContent || null,
            tool_calls: Object.keys(roundToolCalls).sort().map(k => {
              const tc = roundToolCalls[k];
              return {
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments }
              };
            })
          };

          followUpMessages.push(assistantMsg);

          // Execute each new tool call
          const sortedRoundCalls = Object.keys(roundToolCalls).sort().map(k => roundToolCalls[k]);
          for (const tc of sortedRoundCalls) {
            if (tc.name === 'web_search') {
              try {
                const args = JSON.parse(tc.arguments || '{}');
                const query = args.query || '';

                fullContent += '\n\n🔍 *正在搜索: ' + query + '...*';
                if (streamSessions[senderTabId]) streamSessions[senderTabId].content = fullContent;
                chrome.runtime.sendMessage({
                  type: 'STREAM_CHUNK', messageId, content: fullContent, done: false, senderTabId
                }).catch(() => {});

                const searchResults = await performWebSearch(query, senderTabId);

                const resultsText = searchResults.length > 0
                  ? JSON.stringify(searchResults, null, 2)
                  : '没有找到相关结果';

                followUpMessages.push({
                  tool_call_id: tc.id,
                  role: 'tool',
                  content: resultsText
                });

                fullContent += '\n\n🔍 **搜索结果: ' + query + '**\n';
                if (searchResults.length > 0) {
                  searchResults.forEach((r, i) => {
                    fullContent += (i + 1) + '. [' + r.title + '](' + r.url + ')\n';
                  });
                } else {
                  fullContent += '没有找到结果\n';
                }
                if (streamSessions[senderTabId]) streamSessions[senderTabId].content = fullContent;
              } catch (e) {
                followUpMessages.push({
                  tool_call_id: tc.id,
                  role: 'tool',
                  content: '搜索出错: ' + e.message
                });
              }
            }
          }
          // Continue loop for next round
          continue;
        }

        // No tool calls and no content - this round produced nothing useful
        if (!roundHasToolCalls && !roundContent) {
          console.log('[DEBUG] Round produced no content and no tool calls, breaking');
          fullContent += '\n\n*(搜索完成但未生成回复)*';
          break;
        }

      } catch (e) {
        if (e.name === 'AbortError') {
          console.log('[DEBUG] Follow-up call aborted');
          return { content: fullContent, stopped: true };
        }
        console.error('[DEBUG] Follow-up API call error:', e);
        fullContent += '\n\n*(搜索完成但生成回复时出错: ' + e.message + ')*';
        break;
      }
    }

    // Send final done chunk
    setTimeout(() => {
      if (streamSessions[senderTabId]) {
        streamSessions[senderTabId].done = true;
        streamSessions[senderTabId].content = fullContent;
      }
      chrome.runtime.sendMessage({
        type: 'STREAM_CHUNK',
        messageId,
        content: fullContent,
        done: true,
        senderTabId
      }).catch(e => console.error('[DEBUG] Failed to send final STREAM_CHUNK:', e));
    }, 100);
  }

  console.log('[DEBUG] Stream complete, total content length:', fullContent.length);

  // Clean up stream session after a delay (allow popup to reconnect briefly)
  setTimeout(() => {
    delete streamSessions[senderTabId];
  }, 30000);

  return {
    content: fullContent,
    id: messageId
  };
}
