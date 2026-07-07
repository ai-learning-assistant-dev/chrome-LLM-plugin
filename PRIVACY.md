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

For Bilibili pages, the extension makes requests to Bilibili's public APIs (`api.bilibili.com`) from your browser to retrieve video metadata, subtitle information, and user comments. These requests use your existing browser cookies for authentication and do not transmit data to any third party beyond Bilibili's own servers.

## Data Storage

This extension stores the following data **locally in your browser** (`chrome.storage.local`):

- Your selected API provider and API key
- Your selected model
- Your custom API endpoint (if configured)
- Conversation history per tab (to preserve your chat across page reloads), including the associated page context (title, URL, text content, subtitles, and comments)
- UI preferences (such as font size)

**None of this data is transmitted to any external server by this extension.**

## Translation Feature

The "翻译此段落" (Translate Paragraph) right-click context menu feature:

- Tracks which page element you right-click on (via a `contextmenu` event listener) to identify the paragraph to translate
- Sends the selected paragraph's text to your configured AI API for translation into Simplified Chinese
- Injects the translation result directly into the webpage as an inline block below the original paragraph
- **Does not** persistently store translated text or track your browsing behavior

## Third-Party Services

This extension relies entirely on third-party AI API services configured by you. Your use of those services (including their data collection practices) is governed by the privacy policies of those respective service providers.

## Permissions

- `storage`: Store your configuration and conversation history locally
- `sidePanel`: Enable the side panel interface
- `contextMenus`: Provide the right-click "翻译此段落" (Translate Paragraph) option
- Host permissions (`https://*/`, `http://*/`): Required to extract content from and communicate with the webpages you visit, to reach your configured API endpoints, and to call Bilibili's public APIs for subtitle and comment extraction

## Changes

If this privacy policy changes, the updated version will be posted with an updated version number in the Chrome Web Store listing.
