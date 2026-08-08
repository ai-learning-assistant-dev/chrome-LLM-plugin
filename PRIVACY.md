# Privacy Policy

**狐狸学伴AI助手 (Fox Study Buddy AI Assistant)** operates locally on your device and does not collect, store, or transmit any user data to its own servers. All data handling is transparent and under your control.

## Data Access

This extension accesses the following on your device:

- **Current webpage content**: The extension extracts the title, URL, and visible text content of the webpage you are viewing to provide context for AI conversations. For Bilibili (bilibili.com) pages, it also extracts video subtitles (AI and manual) and user comments via Bilibili's public APIs.
- **Right-clicked element content**: When you use the "翻译此段落" (Translate Paragraph) context menu option, the extension reads the text content of the paragraph you right-clicked on to send it for translation.
- **User input**: Any text you type into the extension's chat interface.

## Data Transmission

**You control where data is sent.**

This extension transmits the following data to an **AI API endpoint of your choosing**:

- The current webpage's title, URL, and text content
- Video subtitles and user comments (for Bilibili pages)
- Your chat messages
- Your conversation history (for context)
- Paragraph text selected via the right-click "翻译此段落" feature (sent for translation)

The supported API providers are:
- OpenAI (api.openai.com)
- Anthropic (api.anthropic.com)
- DeepSeek (api.deepseek.com)
- SiliconFlow (api.siliconflow.cn)
- Ollama (localhost:11434, for local AI)
- Custom API endpoints you configure

**You must provide your own API key.** This extension does not include or manage API keys — they are stored exclusively in your browser's local storage and are transmitted directly to your chosen API provider.

The extension also fetches available model lists from your configured API provider to enable model selection.

### Web Search

The extension provides AI-powered web search through supported search engines (Bing, Google, Baidu, Wikipedia). When the AI decides to use a search tool:

- The extension opens a hidden browser tab to the search engine's URL with your search query
- It extracts the search result titles, URLs, and snippets from the loaded page
- The search tab is automatically closed after extraction
- Search results are sent to your configured AI API as part of the ongoing conversation for the AI to synthesize a response

**Your search queries are transmitted to the respective search engine** (Bing, Google, Baidu, or Wikipedia) as part of the search URL, just as they would be if you visited the search engine directly. These requests are subject to each search engine's own privacy policy.

You can enable or disable individual search engines at any time in the extension settings.

### Bilibili Integration

For Bilibili pages, the extension makes requests to Bilibili's public APIs (`api.bilibili.com`) from your browser to retrieve:

- Video metadata and chapter information (`x/web-interface/view`)
- Subtitle information and content (`x/player/wbi/v2`)
- User comments (`x/v2/reply/wbi/main`)

These requests use your existing browser cookies for authentication and do not transmit data to any third party beyond Bilibili's own servers.

## Data Storage

This extension stores the following data **locally in your browser** (`chrome.storage.local`):

- Your selected API provider and API key
- Your selected model
- Your custom API endpoint (if configured)
- Your search engine preferences (enabled/disabled)
- Conversation history per tab (to preserve your chat across page reloads), including the associated page context (title, URL, text content, subtitles, and comments)
- UI preferences (such as font size)

**None of this data is transmitted to any external server by this extension.**

## Translation Feature

The "翻译此段落" (Translate Paragraph) right-click context menu feature:

- Tracks which page element you right-click on (via a `contextmenu` event listener) to identify the paragraph to translate
- Sends the selected paragraph's text to your configured AI API for translation into Simplified Chinese
- Inserts a loading placeholder directly into the webpage, then streams the translation result as inline content below the original paragraph
- Translated content is rendered in a styled block with a delete button — clicking delete removes the translation block from the page
- **Does not** persistently store translated text or track your browsing behavior

## Third-Party Services

This extension relies entirely on third-party AI API services configured by you. Your use of those services (including their data collection practices) is governed by the privacy policies of those respective service providers.

Web search queries are sent to the respective search engines (Bing, Google, Baidu, Wikipedia) and are subject to each search engine's privacy policy.

## Permissions

- `storage`: Store your configuration and conversation history locally
- `sidePanel`: Enable the side panel interface
- `contextMenus`: Provide the right-click "翻译此段落" (Translate Paragraph) option
- `tabs`: Open hidden search engine tabs for web search, and identify the active content tab to associate conversations with the correct webpage. The extension does not read or track your open tabs beyond identifying which page you are actively viewing.
- Host permissions (`https://*/`, `http://*/`, `https://api.anthropic.com/*`): Required to inject content scripts into webpages for text extraction and translation, to open search engine pages for web search, to reach your configured API endpoints, and to call Bilibili's public APIs for subtitle and comment extraction

## Changes

If this privacy policy changes, the updated version will be posted with an updated version number in the Chrome Web Store listing.
