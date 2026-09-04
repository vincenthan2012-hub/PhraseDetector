import { getSettings, saveCard, setScanningStatus, getScanningStatus, getCards, setScanError, clearScanError } from './utils/storage.js';
import { fetchPhrases, scanPageText, explainSelection } from './utils/api.js';

// Open options page on install
chrome.runtime.onInstalled.addListener(() => {
    chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'START_SCAN') {
        // Return immediately to confirm receipt, then start async process
        startBackgroundScan().catch(err => {
            console.error("Scan failed:", err);
            setScanningStatus(false);
        });
        sendResponse({ status: 'started' });
        return true;
    }

    if (request.action === 'SCAN_PAGE') {
        // Legacy/content triggered scan if needed, or remove. 
        // Keeping for now but diverting logic.
        handleScanPage(request.text).then(sendResponse).catch(err => sendResponse({ error: err.message }));
        return true;
    }

    if (request.action === 'EXPLAIN_SELECTION') {
        handleExplainSelection(request.selection, request.context).then(sendResponse).catch(err => sendResponse({ error: err.message }));
        return true;
    }

    if (request.action === 'UPDATE_CARD_SENTENCE') {
        updateCardSentence(request.phrase, request.sentence).then(sendResponse).catch(err => sendResponse({ error: err.message }));
        return true;
    }

    if (request.action === 'RESET_SCAN') {
        setScanningStatus(false).then(() => sendResponse({ status: 'reset' })).catch(err => sendResponse({ error: err.message }));
        return true;
    }

    if (request.action === 'GET_STORED_PHRASES') {
        getStoredPhrasesForUrl(sender.tab?.url).then(sendResponse).catch(err => sendResponse({ error: err.message }));
        return true;
    }

    if (request.action === 'GET_AUDIO_DATA') {
        fetchAudioAsBase64(request.url, request.headers, request.method, request.body)
            .then(dataUrl => sendResponse({ dataUrl }))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }
});

async function getStoredPhrasesForUrl(url) {
    if (!url) return { phrases: [] };
    
    // Normalize URL for comparison (remove fragment)
    const normalizeUrl = (u) => {
        try {
            const urlObj = new URL(u);
            urlObj.hash = ''; // Remove fragment
            return urlObj.toString().replace(/\/$/, ''); // Remove trailing slash
        } catch (e) {
            return u;
        }
    };
    
    const targetUrl = normalizeUrl(url);
    const cards = await getCards();
    
    // Filter cards by normalized URL
    const phrases = cards.filter(c => normalizeUrl(c.sourceUrl) === targetUrl);
    return { phrases };
}

async function fetchAudioAsBase64(url, headers = {}, method = 'GET', body = null) {
    const response = await fetch(url, { method, headers, body });
    if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// Legacy non-streaming helper (kept for reference or fallback if needed)
async function handleScanPage(text) {
    const settings = await getSettings();
    if (!settings.modelName) throw new Error("Please configure model in options.");

    const phrases = await fetchPhrases(text, settings);
    
    // Get current tab URL for sourceUrl
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const currentUrl = tab?.url || '';
    const scanStartTime = Date.now();

    // Save to storage
    for (let i = 0; i < phrases.length; i++) {
        phrases[i].category = phrases[i].category || 'phrase';
        phrases[i].sourceUrl = currentUrl;
        phrases[i].timestamp = scanStartTime;
        phrases[i].phraseOrder = i;
        await saveCard(phrases[i]);
    }

    return { phrases };
}

async function handleExplainSelection(selection, context) {
    const settings = await getSettings();
    const card = await explainSelection(selection, context, settings);
    // Use the context (complete sentence) passed from content script
    if (context) {
        card.sentence = context;
    }
    // Mark as manually generated
    card.isManual = true;
    card.category = card.category || 'phrase';
    // Add URL for consistency (manual cards still go to top)
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    card.sourceUrl = tab?.url || '';
    card.timestamp = Date.now();
    await saveCard(card);
    return { card };
}

async function updateCardSentence(phrase, sentence) {
    const { getCards } = await import('./utils/storage.js');
    const cards = await getCards();
    const cardIndex = cards.findIndex(c => c.phrase.toLowerCase() === phrase.toLowerCase());
    if (cardIndex !== -1) {
        cards[cardIndex].sentence = sentence;
        await chrome.storage.local.set({ pd_cards: cards });
    }
    return { success: true };
}

async function startBackgroundScan() {
    await setScanningStatus(true);
    await clearScanError();
    let collectedCount = 0;
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) {
            await setScanningStatus(false);
            return; // No active tab
        }

        // 1. Get Text
        let textRes;
        try {
            textRes = await chrome.tabs.sendMessage(tab.id, { action: 'GET_PAGE_TEXT' });
        } catch (e) {
            console.error("Connection error:", e);
            await setScanningStatus(false);
            throw new Error("Could not connect to page. Pls reload.");
        }

        if (!textRes || !textRes.text) {
            await setScanningStatus(false);
            throw new Error("Could not read page text.");
        }

        const settings = await getSettings();
        if (!settings.modelName || !settings.apiUrl) {
            await setScanningStatus(false);
            throw new Error("Please configure model in options.");
        }

        // 2. Stream Process with incremental highlighting
        const collectedPhrases = [];
        const currentUrl = tab.url || '';
        const scanStartTime = Date.now();
        let phraseOrder = 0; // Track order within the article

        await scanPageText(textRes.text, settings, async (phraseObj) => {
            collectedCount++;
            // Add URL, timestamp, category, and order for proper sorting
            phraseObj.category = phraseObj.category || 'phrase';
            phraseObj.sourceUrl = currentUrl;
            phraseObj.timestamp = scanStartTime;
            phraseObj.phraseOrder = phraseOrder++;
            
            // Incremental Save
            await saveCard(phraseObj);
            collectedPhrases.push(phraseObj);
            
            // Stream highlight: highlight each phrase as it's generated
            try {
                await chrome.tabs.sendMessage(tab.id, {
                    action: 'HIGHLIGHT_PHRASE',
                    phrase: phraseObj
                });
            } catch (e) {
                console.error("Stream highlight error:", e);
            }
        });

        if (collectedCount === 0) {
            await setScanError('扫描完成但未提取到内容。请确认 Ollama/模型正常运行，或在 Options 中测试连接。');
        }

    } catch (e) {
        console.error("Background scan error:", e);
        await setScanError(e.message || String(e));
        await setScanningStatus(false);
    } finally {
        await setScanningStatus(false);
    }
}
