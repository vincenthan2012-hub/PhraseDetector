// Imports removed as content scripts don't support ES modules easily
// Since we didn't set up a bundler (Webpack/Vite), we might have issues with imports in content scripts in Manifest V3 if not loaded as modules.
// However, 'storage.js' relies on 'chrome.storage' which is available.
// Simplest fix without bundler: Copy helper code or Use dynamic import (async).
// Manifest V3 supports modules in background, but content scripts are injected.
// We will define the helpers inline or use a different loading strategy.
// For simplicity in this env, I'll inline the minimal storage/messaging logic needed or assume 'utils' is accessible if I added it to web_accessible_resources and imported it... but content scripts don't support ES modules easily without <script type="module"> injection.

// STRATEGY CHANGE: Use chrome.runtime.sendMessage for everything to Background, let Background handle storage/API.
// Content script will be "dumb" regarding logic.

let highlightAuto = 'yellow';
let highlightManual = 'pink';
let pdSettings = null;
let pdCurrentVoiceURI = '';

chrome.storage.local.get(['pd_settings', 'pd_selected_voice'], (res) => {
    if (res.pd_settings) {
        pdSettings = res.pd_settings;
        if (res.pd_settings.highlightColorAuto) highlightAuto = res.pd_settings.highlightColorAuto;
        if (res.pd_settings.highlightColorManual) highlightManual = res.pd_settings.highlightColorManual;
    }
    if (res.pd_selected_voice) {
        pdCurrentVoiceURI = res.pd_selected_voice;
    }
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        if (changes.pd_selected_voice) {
            pdCurrentVoiceURI = changes.pd_selected_voice.newValue || '';
        }
        if (changes.pd_settings) {
            pdSettings = changes.pd_settings.newValue || null;
            if (pdSettings) {
                if (pdSettings.highlightColorAuto) highlightAuto = pdSettings.highlightColorAuto;
                if (pdSettings.highlightColorManual) highlightManual = pdSettings.highlightColorManual;
            }
        }
    }
});

// Helper to get voices reliably
async function getVoices() {
    return new Promise((resolve) => {
        let voices = window.speechSynthesis.getVoices();
        if (voices.length > 0) {
            resolve(voices);
        } else {
            const timer = setTimeout(() => {
                window.speechSynthesis.onvoiceschanged = null;
                resolve(window.speechSynthesis.getVoices());
            }, 1000);
            
            window.speechSynthesis.onvoiceschanged = () => {
                clearTimeout(timer);
                window.speechSynthesis.onvoiceschanged = null;
                resolve(window.speechSynthesis.getVoices());
            };
        }
    });
}

async function playPhraseTTS(e) {
    const target = e.currentTarget;
    const text = (target.dataset.phrase || target.textContent || '').trim();
    if (!text) return;

    e.stopPropagation();

    // 1. Try ElevenLabs if configured
    const settings = pdSettings;
    if (settings && settings.ttsProvider === 'elevenlabs' && settings.elevenLabsApiKey) {
        let targetVoiceId = pdCurrentVoiceURI;
        const configuredVoices = settings.elevenLabsVoices || [];
        
        // If current voice is not an ElevenLabs voice, try to find the first available one
        if (!configuredVoices.find(v => v.id === targetVoiceId) && configuredVoices.length > 0) {
            targetVoiceId = configuredVoices[0].id;
        }

        if (targetVoiceId && !['custom_th_google', 'custom_yue_google'].includes(targetVoiceId)) {
            try {
                const url = `https://api.elevenlabs.io/v1/text-to-speech/${targetVoiceId}`;
                const headers = {
                    'Accept': 'audio/mpeg',
                    'Content-Type': 'application/json',
                    'xi-api-key': settings.elevenLabsApiKey
                };
                const body = JSON.stringify({
                    text: text,
                    model_id: "eleven_multilingual_v2",
                    voice_settings: { stability: 0.5, similarity_boost: 0.75 }
                });

                const response = await chrome.runtime.sendMessage({
                    action: 'GET_AUDIO_DATA',
                    url,
                    method: 'POST',
                    headers,
                    body
                });
                
                if (response && response.dataUrl && !response.error) {
                    const audio = new Audio(response.dataUrl);
                    await audio.play();
                    return;
                }
                console.warn('ElevenLabs playback failed, falling back...', response?.error);
            } catch (err) {
                console.error('ElevenLabs error:', err);
            }
        }
    }

    // 2. Try Google Translate TTS for specific languages
    if (pdCurrentVoiceURI === 'custom_th_google' || pdCurrentVoiceURI === 'custom_yue_google') {
        const lang = pdCurrentVoiceURI === 'custom_th_google' ? 'th' : 'yue';
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${lang}&q=${encodeURIComponent(text)}`;
        
        try {
            const response = await chrome.runtime.sendMessage({ action: 'GET_AUDIO_DATA', url });
            if (response && response.dataUrl && !response.error) {
                window.speechSynthesis.cancel();
                const audio = new Audio(response.dataUrl);
                await audio.play();
                return;
            }
        } catch (err) {
            console.error("Google TTS failed:", err);
        }
    }

    // 3. Fallback to Web Speech API (Built-in)
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    
    if (pdCurrentVoiceURI) {
        const voices = await getVoices();
        const selectedVoice = voices.find(v => v.voiceURI === pdCurrentVoiceURI);
        if (selectedVoice) {
            utterance.voice = selectedVoice;
            utterance.lang = selectedVoice.lang;
        }
    }
    
    window.speechSynthesis.speak(utterance);
}

// --- UI Elements ---
let tooltip = null;
let fab = null;

function createUi() {
    tooltip = document.createElement('div');
    tooltip.className = 'pd-ext-tooltip';
    document.body.appendChild(tooltip);

    fab = document.createElement('div');
    fab.className = 'pd-ext-fab';
    fab.textContent = 'Generate Card ✨';
    document.body.appendChild(fab);

    fab.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Prevent losing selection
        handleManualGeneration();
    });
}

// --- Highlighting Logic ---
function getCardCategory(item) {
    return item.category || 'phrase';
}

function highlightPhrases(phrases) {
    phrases.forEach(p => {
        applyPageMark(p);
    });
}

function applyPageMark(item) {
    const category = getCardCategory(item);
    if (category === 'structure') {
        const searchText = getStructureSearchText(item);
        findAndUnderline(searchText, item.explanation, item.isManual, item.phrase);
    } else {
        findAndHighlight(item.phrase, item.explanation, item.isManual, category);
    }
}

function getStructureSearchText(item) {
    const sentence = (item.sentence || '').trim();
    const phrase = (item.phrase || '').trim();
    const bodyText = document.body.innerText || '';

    if (sentence && bodyText.toLowerCase().includes(sentence.toLowerCase())) {
        return sentence;
    }
    if (phrase && !phrase.includes('...') && bodyText.toLowerCase().includes(phrase.toLowerCase())) {
        return phrase;
    }
    return sentence || phrase;
}

function isInsideMark(node) {
    if (!node.parentElement) return false;
    return node.parentElement.classList.contains('pd-ext-highlight') ||
        node.parentElement.classList.contains('pd-ext-underline');
}

// Extract complete sentence containing a phrase from container text
function extractCompleteSentence(container, phrase, phraseLower) {
    // Get full text from container (before any DOM modifications)
    const fullText = container.textContent || container.innerText || '';

    // Find phrase position in full text (case-insensitive)
    const phrasePos = fullText.toLowerCase().indexOf(phraseLower);
    if (phrasePos === -1) {
        // Fallback: return a reasonable context
        return fullText.substring(0, Math.min(200, fullText.length));
    }

    // Find sentence boundaries
    let sentenceStart = phrasePos;
    let sentenceEnd = phrasePos + phrase.length;

    // Sentence end punctuation for multiple languages
    const sentenceEndPunctuation = ['.', '!', '?', '。', '！', '？', '…', '。', '！', '？'];

    // Find start of sentence (look backwards for boundaries)
    for (let i = phrasePos - 1; i >= 0; i--) {
        const char = fullText[i];
        const nextChar = fullText[i + 1];

        // Punctuation boundary: punctuation followed by space or newline
        if (sentenceEndPunctuation.includes(char) && (i + 1 >= fullText.length || /[\s]/.test(nextChar))) {
            sentenceStart = i + 1;
            break;
        }

        // Newline boundary: treat lines as sentences (common in lyrics)
        if (char === '\n' || char === '\r') {
            sentenceStart = i + 1;
            break;
        }

        // Multiple spaces boundary: 2 or more spaces often separate items/lyrics
        if (char === ' ' && nextChar === ' ') {
            sentenceStart = i + 1;
            break;
        }

        if (i === 0) {
            sentenceStart = 0;
            break;
        }
    }

    // Find end of sentence (look forwards for boundaries)
    for (let i = phrasePos + phrase.length; i < fullText.length; i++) {
        const char = fullText[i];
        const prevChar = fullText[i - 1];

        // Punctuation boundary
        if (sentenceEndPunctuation.includes(char)) {
            sentenceEnd = i + 1;
            break;
        }

        // Newline boundary
        if (char === '\n' || char === '\r') {
            sentenceEnd = i;
            break;
        }

        // Multiple spaces boundary
        if (char === ' ' && prevChar === ' ') {
            sentenceEnd = i - 1;
            break;
        }
    }
    if (sentenceEnd === phrasePos + phrase.length) {
        // No sentence end found, extend to reasonable limit or end of text
        sentenceEnd = Math.min(fullText.length, phrasePos + phrase.length + 150);
    }

    // Extract and clean the sentence
    let sentence = fullText.substring(sentenceStart, sentenceEnd).trim();

    // Clean up: remove leading/trailing whitespace only, or very specific punctuation if needed
    // Avoid using \W as it strips CJK characters
    sentence = sentence.replace(/^[\s,;]+/, '').replace(/[\s,;]+$/, '');

    // Ensure sentence contains the phrase
    if (!sentence.toLowerCase().includes(phraseLower)) {
        // Fallback: use larger context
        const contextStart = Math.max(0, phrasePos - 50);
        const contextEnd = Math.min(fullText.length, phrasePos + phrase.length + 100);
        sentence = fullText.substring(contextStart, contextEnd).trim();
    }

    return sentence || phrase;
}

function findAndHighlight(phrase, explanation, isManual = false, category = 'phrase') {
    if (!phrase || phrase.trim().length < 1) return;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    const phraseLower = phrase.toLowerCase();
    let highlightedCount = 0;
    const maxHighlights = 100;

    for (const node of nodes) {
        if (highlightedCount >= maxHighlights) break;

        if (node.parentElement && ['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT'].includes(node.parentElement.tagName)) continue;
        if (isInsideMark(node)) continue;

        const nodeText = node.nodeValue;
        if (!nodeText) continue;

        const idx = nodeText.toLowerCase().indexOf(phraseLower);
        if (idx !== -1) {
            let container = node.parentElement;
            while (container && !['P', 'DIV', 'ARTICLE', 'SECTION', 'LI', 'BLOCKQUOTE', 'SPAN', 'BODY'].includes(container.tagName)) {
                container = container.parentElement;
            }
            if (!container) container = document.body;

            const completeSentence = extractCompleteSentence(container, phrase, phraseLower);

            const matchNode = node.splitText(idx);
            matchNode.splitText(phrase.length);

            const span = document.createElement('span');
            span.className = isManual ? 'pd-ext-highlight pd-ext-highlight-manual' : 'pd-ext-highlight';
            span.dataset.explanation = explanation;
            span.dataset.phrase = phrase;
            span.dataset.sentence = completeSentence;
            span.dataset.category = category;
            span.textContent = matchNode.textContent;

            matchNode.parentNode.replaceChild(span, matchNode);

            span.addEventListener('mouseenter', showTooltip);
            span.addEventListener('mouseleave', hideTooltip);
            span.addEventListener('click', playPhraseTTS);

            highlightedCount++;
        }
    }
}

function findAndUnderline(searchText, explanation, isManual = false, patternLabel = '') {
    if (!searchText || searchText.trim().length < 1) return;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    const searchLower = searchText.toLowerCase();
    let markedCount = 0;
    const maxMarks = 100;

    for (const node of nodes) {
        if (markedCount >= maxMarks) break;

        if (node.parentElement && ['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT'].includes(node.parentElement.tagName)) continue;
        if (isInsideMark(node)) continue;

        const nodeText = node.nodeValue;
        if (!nodeText) continue;

        const idx = nodeText.toLowerCase().indexOf(searchLower);
        if (idx !== -1) {
            let container = node.parentElement;
            while (container && !['P', 'DIV', 'ARTICLE', 'SECTION', 'LI', 'BLOCKQUOTE', 'SPAN', 'BODY'].includes(container.tagName)) {
                container = container.parentElement;
            }
            if (!container) container = document.body;

            const completeSentence = extractCompleteSentence(container, searchText, searchLower);

            const matchNode = node.splitText(idx);
            matchNode.splitText(searchText.length);

            const span = document.createElement('span');
            span.className = 'pd-ext-underline';
            span.dataset.explanation = explanation;
            span.dataset.phrase = patternLabel || searchText;
            span.dataset.sentence = completeSentence;
            span.dataset.category = 'structure';
            span.textContent = matchNode.textContent;

            matchNode.parentNode.replaceChild(span, matchNode);

            span.addEventListener('mouseenter', showTooltip);
            span.addEventListener('mouseleave', hideTooltip);
            span.addEventListener('click', playPhraseTTS);

            markedCount++;
        }
    }
}


function showTooltip(e) {
    const text = e.target.dataset.explanation;
    const phrase = e.target.dataset.phrase || e.target.textContent.trim();
    if (!text) return;

    tooltip.innerHTML = `<div class="pd-ext-tooltip-header">${phrase}</div>${text}`;

    const rect = e.target.getBoundingClientRect();
    tooltip.style.top = `${window.scrollY + rect.bottom + 5}px`;
    tooltip.style.left = `${window.scrollX + rect.left}px`;
    tooltip.classList.add('visible');
}

function hideTooltip() {
    tooltip.classList.remove('visible');
}


// --- Manual Selection ---
document.addEventListener('mouseup', (e) => {
    const selection = window.getSelection();
    if (selection.toString().trim().length > 0) {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        fab.style.top = `${window.scrollY + rect.bottom + 5}px`;
        fab.style.left = `${window.scrollX + rect.right - 80}px`;
        fab.style.display = 'block';
    } else {
        fab.style.display = 'none';
    }
});

// Extract complete sentence from a selection range
function extractSentenceFromRange(range) {
    // Get the container element
    let container = range.commonAncestorContainer;
    if (container.nodeType === Node.TEXT_NODE) {
        container = container.parentElement;
    }

    // Find a suitable container (paragraph, div, etc.)
    while (container && !['P', 'DIV', 'ARTICLE', 'SECTION', 'LI', 'BLOCKQUOTE', 'BODY'].includes(container.tagName)) {
        container = container.parentElement;
    }
    if (!container) container = document.body;

    const fullText = container.textContent || container.innerText || '';

    // Get the selected text position in the container
    const selectedText = range.toString();
    const startOffset = fullText.indexOf(selectedText);

    if (startOffset === -1) {
        // Fallback: use a larger context
        return container.textContent.substring(0, 200);
    }

    // Find sentence boundaries
    let sentenceStart = startOffset;
    let sentenceEnd = startOffset + selectedText.length;

    // Sentence end punctuation for multiple languages
    const sentenceEndPunctuation = ['.', '!', '?', '。', '！', '？', '…', '。', '！', '？'];

    // Find start of sentence (look backwards for boundaries)
    for (let i = startOffset - 1; i >= 0; i--) {
        const char = fullText[i];
        const nextChar = fullText[i + 1];

        // Punctuation boundary
        if (sentenceEndPunctuation.includes(char) && (i + 1 >= fullText.length || /[\s]/.test(nextChar))) {
            sentenceStart = i + 1;
            break;
        }

        // Newline boundary (e.g. lyrics)
        if (char === '\n' || char === '\r') {
            sentenceStart = i + 1;
            break;
        }

        // Multiple spaces boundary
        if (char === ' ' && nextChar === ' ') {
            sentenceStart = i + 1;
            break;
        }

        if (i === 0) {
            sentenceStart = 0;
            break;
        }
    }

    // Find end of sentence (look forwards for boundaries)
    for (let i = startOffset + selectedText.length; i < fullText.length; i++) {
        const char = fullText[i];
        const prevChar = fullText[i - 1];

        // Punctuation boundary
        if (sentenceEndPunctuation.includes(char)) {
            sentenceEnd = i + 1;
            break;
        }

        // Newline boundary
        if (char === '\n' || char === '\r') {
            sentenceEnd = i;
            break;
        }

        // Multiple spaces boundary
        if (char === ' ' && prevChar === ' ') {
            sentenceEnd = i - 1;
            break;
        }
    }
    if (sentenceEnd === startOffset + selectedText.length) {
        // No sentence end found, extend to reasonable limit or end of text
        sentenceEnd = Math.min(fullText.length, startOffset + selectedText.length + 150);
    }

    // Extract and clean the sentence
    let sentence = fullText.substring(sentenceStart, sentenceEnd).trim();
    
    // Clean up: remove leading/trailing whitespace and common separators, but not CJK characters
    sentence = sentence.replace(/^[\s,;]+/, '').replace(/[\s,;]+$/, '');
    sentence = sentence.trim();

    return sentence || selectedText;
}

async function handleManualGeneration() {
    const selection = window.getSelection();
    const text = selection.toString().trim();
    if (!text) return;

    // Extract complete sentence containing the selection
    const range = selection.getRangeAt(0);
    const completeSentence = extractSentenceFromRange(range);

    fab.textContent = 'Generating...';
    fab.classList.add('pd-ext-loading');

    try {
        const response = await chrome.runtime.sendMessage({
            action: 'EXPLAIN_SELECTION',
            selection: text,
            context: completeSentence
        });

        if (response.error) throw new Error(response.error);

        // Update response card with the extracted sentence
        response.card.sentence = completeSentence;

        // Highlight logic for manual
        const highlightRange = selection.getRangeAt(0);
        const span = document.createElement('span');
        span.className = 'pd-ext-highlight pd-ext-highlight-manual';
        span.dataset.explanation = response.card.explanation;
        span.dataset.phrase = text;
        span.dataset.sentence = completeSentence;
        span.dataset.category = response.card.category || 'phrase';
        span.textContent = text;

        highlightRange.deleteContents();
        highlightRange.insertNode(span);

        span.addEventListener('mouseenter', showTooltip);
        span.addEventListener('mouseleave', hideTooltip);
        span.addEventListener('click', playPhraseTTS);

        fab.style.display = 'none';
    } catch (e) {
        alert("Error: " + e.message);
    } finally {
        fab.textContent = 'Generate Card ✨';
        fab.classList.remove('pd-ext-loading');
        window.getSelection().removeAllRanges();
    }
}


// --- Initial Setup ---
createUi();

// Auto-apply highlights on load
// Added a small delay to ensure DOM is ready and network-loaded content might be present
setTimeout(() => {
    console.log(`[PhraseDetector] Checking for stored highlights for: ${window.location.href}`);
    chrome.runtime.sendMessage({ action: 'GET_STORED_PHRASES' }, (response) => {
        if (chrome.runtime.lastError) {
            console.error(`[PhraseDetector] Error requesting stored phrases:`, chrome.runtime.lastError);
            return;
        }
        if (response && response.phrases && response.phrases.length > 0) {
            console.log(`[PhraseDetector] Re-applying ${response.phrases.length} stored highlights.`);
            highlightPhrases(response.phrases);
        } else {
            console.log(`[PhraseDetector] No stored highlights found for this page.`);
        }
    });
}, 1000);

// Listen for scan triggers from Popup
// But Popup cannot send message to Content script directly if popup is closed? 
// No, Popup sends valid messages to active tab.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'HIGHLIGHT_PHRASES') {
        highlightPhrases(msg.phrases);
    }

    if (msg.action === 'HIGHLIGHT_PHRASE') {
        if (msg.phrase) {
            applyPageMark(msg.phrase);

            setTimeout(() => {
                const isStructure = getCardCategory(msg.phrase) === 'structure';
                const markedSpans = isStructure
                    ? document.querySelectorAll('.pd-ext-underline')
                    : document.querySelectorAll('.pd-ext-highlight[data-phrase="' + msg.phrase.phrase.replace(/"/g, '\\"') + '"]');
                const targetSpans = isStructure
                    ? Array.from(markedSpans).filter(s => s.dataset.phrase === msg.phrase.phrase || s.dataset.sentence === msg.phrase.sentence)
                    : markedSpans;

                if (targetSpans.length > 0) {
                    const firstSpan = targetSpans[0];
                    const extractedSentence = firstSpan.dataset.sentence;
                    if (extractedSentence && extractedSentence !== msg.phrase.sentence) {
                        chrome.runtime.sendMessage({
                            action: 'UPDATE_CARD_SENTENCE',
                            phrase: msg.phrase.phrase,
                            sentence: extractedSentence
                        }).catch(() => { });
                    }
                }
            }, 100);
        }
    }

    if (msg.action === 'REMOVE_HIGHLIGHT') {
        const highlights = document.querySelectorAll('.pd-ext-highlight, .pd-ext-underline');
        highlights.forEach(span => {
            if (span.dataset.phrase === msg.phrase && (!msg.sentence || span.dataset.sentence === msg.sentence)) {
                const parent = span.parentNode;
                if (parent) {
                    const textNode = document.createTextNode(span.textContent);
                    parent.replaceChild(textNode, span);
                    parent.normalize();
                }
            }
        });
    }

    if (msg.action === 'REMOVE_ALL_HIGHLIGHTS') {
        const highlights = document.querySelectorAll('.pd-ext-highlight, .pd-ext-underline');
        highlights.forEach(span => {
            const parent = span.parentNode;
            if (parent) {
                const textNode = document.createTextNode(span.textContent);
                parent.replaceChild(textNode, span);
                parent.normalize();
            }
        });
    }

    if (msg.action === 'GET_PAGE_TEXT') {
        // Try to find main article content first
        let mainContent = null;

        // Common article selectors
        const articleSelectors = [
            'article',
            'main',
            '[role="main"]',
            '.article',
            '.content',
            '.post-content',
            '.entry-content',
            '.article-body',
            '.post-body',
            '#content',
            '#main-content',
            '.main-content'
        ];

        for (const selector of articleSelectors) {
            const element = document.querySelector(selector);
            if (element) {
                mainContent = element;
                break;
            }
        }

        // If no main content found, use body
        const container = mainContent || document.body;

        // Get all text nodes from the container, excluding script, style, etc.
        const walker = document.createTreeWalker(
            container,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function (node) {
                    const parent = node.parentElement;
                    if (!parent) return NodeFilter.FILTER_REJECT;

                    // Skip script, style, and form elements
                    if (['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'BUTTON', 'NAV', 'HEADER', 'FOOTER', 'ASIDE'].includes(parent.tagName)) {
                        return NodeFilter.FILTER_REJECT;
                    }

                    // Skip if parent has common non-content classes
                    if (parent.classList.contains('ad') ||
                        parent.classList.contains('advertisement') ||
                        parent.classList.contains('sidebar') ||
                        parent.classList.contains('menu') ||
                        parent.classList.contains('navigation') ||
                        parent.id === 'sidebar') {
                        return NodeFilter.FILTER_REJECT;
                    }

                    // Skip if text is too short (likely not content)
                    if (node.textContent.trim().length < 3) {
                        return NodeFilter.FILTER_SKIP;
                    }

                    return NodeFilter.FILTER_ACCEPT;
                }
            },
            false
        );

        const textParts = [];
        let node;
        while (node = walker.nextNode()) {
            const text = node.textContent.trim();
            if (text.length > 0) {
                textParts.push(text);
            }
        }

        // Join with newlines and limit to reasonable size (50KB instead of 5KB)
        const text = textParts.join('\n').substring(0, 50000);
        sendResponse({ text });
    }
});
