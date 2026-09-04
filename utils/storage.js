/**
 * Storage utility to handle settings and saved cards.
 */

const KEYS = {
    SETTINGS: 'pd_settings',
    CARDS: 'pd_cards',
    IS_SCANNING: 'pd_is_scanning',
    SCAN_START_TIME: 'pd_scan_start_time',
    SCAN_ERROR: 'pd_scan_error',
    FAVORITES: 'pd_favorites'
};

const DEFAULT_SETTINGS = {
    llmProvider: 'ollama', // 'ollama' or 'online'
    apiUrl: 'http://127.0.0.1:11435/api/generate', // 扩展推荐经 CORS 代理访问 Ollama
    modelName: 'llama3:latest',
    apiKey: '',
    targetLang: 'Chinese',
    sourceLang: 'auto',
    highlightColorAuto: 'yellow',
    highlightColorManual: 'pink',
    savedModels: ['llama3:latest', 'mistral', 'qwen2.5'],
    ttsProvider: 'web',
    elevenLabsApiKey: '',
    elevenLabsVoices: [
        { name: 'Rachel', id: '21m00Tcm4TlvDq8ikWAM' }
    ]
};

export const getSettings = async () => {
    const result = await chrome.storage.local.get(KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, ...result[KEYS.SETTINGS] };
};

export const saveSettings = async (settings) => {
    await chrome.storage.local.set({ [KEYS.SETTINGS]: settings });
};

export const getCards = async () => {
    const result = await chrome.storage.local.get(KEYS.CARDS);
    return result[KEYS.CARDS] || [];
};

export const saveCard = async (card) => {
    const cards = await getCards();
    const cardCategory = card.category || 'phrase';
    card.category = cardCategory;
    // Avoid duplicates based on phrase, sentence, and category
    if (!cards.find(c =>
        c.phrase.toLowerCase() === card.phrase.toLowerCase() &&
        c.sentence === card.sentence &&
        (c.category || 'phrase') === cardCategory
    )) {
        if (card.isManual) {
            // Manual cards go to the very top
            cards.unshift(card);
        } else {
            const currentUrl = card.sourceUrl || '';
            
            // Find if there are already cards from the same URL
            let lastSameUrlIndex = -1;
            for (let i = cards.length - 1; i >= 0; i--) {
                if (cards[i].sourceUrl === currentUrl && !cards[i].isManual) {
                    lastSameUrlIndex = i;
                    break;
                }
            }
            
            if (lastSameUrlIndex !== -1) {
                // Insert after the last card of the same article (maintain order within scan)
                cards.splice(lastSameUrlIndex + 1, 0, card);
            } else {
                // New article: insert at the very top
                cards.unshift(card);
            }
        }
        await chrome.storage.local.set({ [KEYS.CARDS]: cards });
    }
};

export const clearCards = async () => {
    await chrome.storage.local.set({ [KEYS.CARDS]: [] });
};

export const clearCardsByUrl = async (url) => {
    const cards = await getCards();
    const filteredCards = cards.filter(c => c.sourceUrl !== url);
    await chrome.storage.local.set({ [KEYS.CARDS]: filteredCards });
};

export const clearHistoryCards = async (currentUrl) => {
    const cards = await getCards();
    const filteredCards = cards.filter(c => c.sourceUrl === currentUrl);
    await chrome.storage.local.set({ [KEYS.CARDS]: filteredCards });
};

export const deleteCard = async (index) => {
    const cards = await getCards();
    cards.splice(index, 1);
    await chrome.storage.local.set({ [KEYS.CARDS]: cards });
};

export const getScanningStatus = async () => {
    const result = await chrome.storage.local.get(KEYS.IS_SCANNING);
    return result[KEYS.IS_SCANNING] || false;
};

export const setScanningStatus = async (isScanning) => {
    await chrome.storage.local.set({ 
        [KEYS.IS_SCANNING]: isScanning,
        [KEYS.SCAN_START_TIME]: isScanning ? Date.now() : null
    });
};

export const setScanError = async (message) => {
    await chrome.storage.local.set({ [KEYS.SCAN_ERROR]: message || null });
};

export const clearScanError = async () => {
    await chrome.storage.local.set({ [KEYS.SCAN_ERROR]: null });
};

export const getScanError = async () => {
    const result = await chrome.storage.local.get(KEYS.SCAN_ERROR);
    return result[KEYS.SCAN_ERROR] || null;
};

export const getScanStartTime = async () => {
    const result = await chrome.storage.local.get(KEYS.SCAN_START_TIME);
    return result[KEYS.SCAN_START_TIME] || null;
};

export const resetScanningStatus = async () => {
    await chrome.storage.local.set({ 
        [KEYS.IS_SCANNING]: false,
        [KEYS.SCAN_START_TIME]: null
    });
};

// Favorites functions
export const getFavorites = async () => {
    const result = await chrome.storage.local.get(KEYS.FAVORITES);
    return result[KEYS.FAVORITES] || [];
};

export const addFavorite = async (card, sourceUrl) => {
    const favorites = await getFavorites();
    // Check if already favorited (by phrase and sentence)
    const exists = favorites.find(f => 
        f.phrase.toLowerCase() === card.phrase.toLowerCase() && 
        f.sentence === card.sentence
    );
    if (!exists) {
        favorites.push({
            phrase: card.phrase,
            phonetic: card.phonetic || '',
            sentence: card.sentence,
            explanation: card.explanation,
            category: card.category || 'phrase',
            source: sourceUrl || '',
            date: new Date().toISOString().split('T')[0] // YYYY-MM-DD format
        });
        await chrome.storage.local.set({ [KEYS.FAVORITES]: favorites });
    }
    return favorites;
};

export const removeFavorite = async (index) => {
    const favorites = await getFavorites();
    favorites.splice(index, 1);
    await chrome.storage.local.set({ [KEYS.FAVORITES]: favorites });
    return favorites;
};

export const removeFavorites = async (indices) => {
    const favorites = await getFavorites();
    // Sort indices in descending order to avoid index shifting issues
    const sortedIndices = [...indices].sort((a, b) => b - a);
    sortedIndices.forEach(index => {
        favorites.splice(index, 1);
    });
    await chrome.storage.local.set({ [KEYS.FAVORITES]: favorites });
    return favorites;
};

export const clearFavorites = async () => {
    await chrome.storage.local.set({ [KEYS.FAVORITES]: [] });
};

export const isFavorite = async (card) => {
    const favorites = await getFavorites();
    return favorites.some(f => 
        f.phrase.toLowerCase() === card.phrase.toLowerCase() && 
        f.sentence === card.sentence
    );
};
