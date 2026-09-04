import { getCards, clearCards, clearCardsByUrl, clearHistoryCards, saveCard, deleteCard, getScanningStatus, setScanningStatus, getSettings, addFavorite, removeFavorite, isFavorite, getFavorites, getScanError, clearScanError } from '../utils/storage.js';
import { addNoteToAnki, getAnkiDecks, chatWithAI } from '../utils/api.js';

// Elements (initialized later)
let els = {};

let pendingAnkiCard = null;
let pendingAnkiBtn = null;
let currentVoiceURI = '';
let favoriteVoices = [];
let activeTab = 'current'; // 'current' or 'history'
let activeSubTab = 'phrase'; // 'powerword' | 'phrase' | 'structure'

const SUBTAB_LABELS = {
    powerword: 'Power Word',
    phrase: 'Phrase',
    structure: 'Structure'
};

const EMPTY_MESSAGES = {
    powerword: 'No power words found on this page.<br>Click Scan or select text on page.',
    phrase: 'No phrases found on this page.<br>Click Scan or select text on page.',
    structure: 'No structures found on this page.<br>Click Scan or select text on page.'
};

function loadVoiceSettings(callback) {
    if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['pd_selected_voice', 'pd_favorite_voices'], (res) => {
            currentVoiceURI = res.pd_selected_voice || '';
            favoriteVoices = res.pd_favorite_voices || [];
            if (callback) callback();
        });
    } else {
        currentVoiceURI = localStorage.getItem('pd_selected_voice') || '';
        try { favoriteVoices = JSON.parse(localStorage.getItem('pd_favorite_voices')) || []; } catch (e) { }
        if (callback) callback();
    }
}

function saveVoiceSettings() {
    if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
            pd_selected_voice: currentVoiceURI,
            pd_favorite_voices: favoriteVoices
        });
    } else {
        localStorage.setItem('pd_selected_voice', currentVoiceURI);
        localStorage.setItem('pd_favorite_voices', JSON.stringify(favoriteVoices));
    }
}

function toggleFavoriteVoice() {
    if (!currentVoiceURI) return;

    if (favoriteVoices.includes(currentVoiceURI)) {
        favoriteVoices = favoriteVoices.filter(v => v !== currentVoiceURI);
    } else {
        favoriteVoices.push(currentVoiceURI);
    }

    saveVoiceSettings();
    populateVoices();
}

function updateFavoriteVoiceBtn() {
    const btn = document.getElementById('favoriteVoiceBtn');
    if (!btn) return;
    if (!currentVoiceURI) {
        btn.textContent = '☆';
        btn.style.opacity = '0.5';
        return;
    }
    btn.style.opacity = '1';
    if (favoriteVoices.includes(currentVoiceURI)) {
        btn.textContent = '★';
        btn.style.color = '#ffc107';
    } else {
        btn.textContent = '☆';
        btn.style.color = '';
    }
}

async function populateVoices() {
    if (!els.voiceSelect) return;

    try {
        const settings = await getSettings();
        if (settings.ttsProvider === 'elevenlabs') {
            els.voiceSelect.innerHTML = '';
            els.voiceSelect.disabled = false;
            if (els.favoriteVoiceBtn) els.favoriteVoiceBtn.style.display = 'inline-block';
            
            const voices = settings.elevenLabsVoices || [];
            if (voices.length === 0) {
                 const opt = document.createElement('option');
                 opt.value = '';
                 opt.textContent = 'No ElevenLabs Voices Configured';
                 els.voiceSelect.appendChild(opt);
                 return;
            }

            const favVoices = voices.filter(v => favoriteVoices.includes(v.id));
            if (favVoices.length > 0) {
                const favGroup = document.createElement('optgroup');
                favGroup.label = 'Favorites';
                favVoices.forEach(v => {
                    const opt = document.createElement('option');
                    opt.value = v.id;
                    opt.textContent = `★ ${v.name} (ElevenLabs)`;
                    if (v.id === currentVoiceURI) opt.selected = true;
                    favGroup.appendChild(opt);
                });
                els.voiceSelect.appendChild(favGroup);
            }
            
            const allGroup = document.createElement('optgroup');
            allGroup.label = 'All Voices';
            voices.forEach(v => {
                if (favoriteVoices.includes(v.id)) return;
                const opt = document.createElement('option');
                opt.value = v.id;
                opt.textContent = `${v.name} (ElevenLabs)`;
                if (v.id === currentVoiceURI) opt.selected = true;
                allGroup.appendChild(opt);
            });
            
            if (voices.length > 0) {
                els.voiceSelect.appendChild(allGroup);
            }
            
            updateFavoriteVoiceBtn();
            return;
        }
    } catch (e) {
        console.error("Error fetching settings for voices:", e);
    }

    els.voiceSelect.disabled = false;
    if (els.favoriteVoiceBtn) els.favoriteVoiceBtn.style.display = 'inline-block';

    let voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) {
        window.speechSynthesis.onvoiceschanged = () => {
            populateVoices();
        };
        // Fast return but we might still populate the custom voice later on onvoiceschanged
    }

    const customVoices = [
        { voiceURI: 'custom_th_google', name: 'Google Translate (Thai)', lang: 'th-TH', custom: true },
        { voiceURI: 'custom_yue_google', name: 'Google Translate (Cantonese)', lang: 'yue-HK', custom: true }
    ];

    const allVoices = [...voices, ...customVoices];

    els.voiceSelect.innerHTML = '';

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Default Voice';
    els.voiceSelect.appendChild(defaultOption);

    // Favorites group
    const favVoices = allVoices.filter(v => favoriteVoices.includes(v.voiceURI));
    if (favVoices.length > 0) {
        const favGroup = document.createElement('optgroup');
        favGroup.label = 'Favorites';
        favVoices.forEach(voice => {
            const option = document.createElement('option');
            option.value = voice.voiceURI;
            option.textContent = `★ ${voice.name} (${voice.lang})`;
            if (voice.voiceURI === currentVoiceURI) option.selected = true;
            favGroup.appendChild(option);
        });
        els.voiceSelect.appendChild(favGroup);
    }

    // Standard group
    const allGroup = document.createElement('optgroup');
    allGroup.label = 'All Voices';
    allVoices.forEach(voice => {
        if (favoriteVoices.includes(voice.voiceURI)) return;
        const option = document.createElement('option');
        option.value = voice.voiceURI;
        option.textContent = `${voice.name} (${voice.lang})`;
        if (voice.voiceURI === currentVoiceURI) option.selected = true;
        allGroup.appendChild(option);
    });

    if (allVoices.length > 0) {
        els.voiceSelect.appendChild(allGroup);
    }

    updateFavoriteVoiceBtn();
}

async function speakText(text) {
    if (!text) return;

    try {
        const settings = await getSettings();
        if (settings.ttsProvider === 'elevenlabs' && settings.elevenLabsApiKey) {
            let targetVoiceId = currentVoiceURI;
            const configuredVoices = settings.elevenLabsVoices || [];
            if (!configuredVoices.find(v => v.id === targetVoiceId) && configuredVoices.length > 0) {
                targetVoiceId = configuredVoices[0].id;
            }

            if (!targetVoiceId) {
                console.error("No ElevenLabs voice configured");
                return;
            }

            const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${targetVoiceId}`, {
                method: 'POST',
                headers: {
                    'Accept': 'audio/mpeg',
                    'Content-Type': 'application/json',
                    'xi-api-key': settings.elevenLabsApiKey
                },
                body: JSON.stringify({
                    text: text,
                    model_id: "eleven_multilingual_v2",
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75
                    }
                })
            });

            if (!response.ok) {
                const errResult = await response.text();
                console.error('ElevenLabs API Error, falling back to Web Speech API', errResult);
                alert("ElevenLabs API Error (Fallback to built-in TTS):\n" + errResult);
            } else {
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                const audio = new Audio(url);
                audio.play();
                return; // successfully played with elevenlabs
            }
        }
    } catch (e) {
        console.error('TTS config error or fetch failed:', e);
    }

    if (currentVoiceURI === 'custom_th_google') {
        window.speechSynthesis.cancel();
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=th&q=${encodeURIComponent(text)}`;
        const audio = new Audio(url);
        audio.play().catch(e => console.error("Audio playback error:", e));
        return;
    }

    if (currentVoiceURI === 'custom_yue_google') {
        window.speechSynthesis.cancel();
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=yue&q=${encodeURIComponent(text)}`;
        const audio = new Audio(url);
        audio.play().catch(e => console.error("Audio playback error:", e));
        return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    if (currentVoiceURI) {
        const voices = window.speechSynthesis.getVoices();
        const selectedVoice = voices.find(v => v.voiceURI === currentVoiceURI);
        if (selectedVoice) {
            utterance.voice = selectedVoice;
        }
    }

    // Fallback logic for Thai or other specific issues if we can infer language?
    // Left as default if no URI is matched.

    window.speechSynthesis.speak(utterance);
}

function broadcastMessage(message) {
    if (chrome && chrome.tabs) {
        chrome.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, message).catch(() => { });
            });
        });
    }
}

function init() {
    els = {
        list: document.getElementById('cardList'),
        scanBtn: document.getElementById('scanBtn'),
        resetScanBtn: document.getElementById('resetScanBtn'),
        clearBtn: document.getElementById('clearBtn'),
        optionsBtn: document.getElementById('optionsBtn'),
        favoritesBtn: document.getElementById('favoritesBtn'),
        ankiModal: document.getElementById('ankiModal'),
        ankiDeckSelect: document.getElementById('ankiDeckSelect'),
        ankiCancel: document.getElementById('ankiCancel'),
        ankiConfirm: document.getElementById('ankiConfirm'),
        voiceSelect: document.getElementById('voiceSelect'),
        favoriteVoiceBtn: document.getElementById('favoriteVoiceBtn'),
        sourceLangSelect: document.getElementById('sourceLangSelect')
    };

    if (els.sourceLangSelect) {
        getSettings().then(settings => {
            els.sourceLangSelect.value = settings.sourceLang || 'auto';
        });
        
        els.sourceLangSelect.addEventListener('change', async (e) => {
            const settings = await getSettings();
            settings.sourceLang = e.target.value;
            chrome.storage.local.set({ pd_settings: settings });
        });
    }

    if (els.voiceSelect) {
        loadVoiceSettings(() => {
            populateVoices();
        });

        els.voiceSelect.addEventListener('change', (e) => {
            currentVoiceURI = e.target.value;
            saveVoiceSettings();
            updateFavoriteVoiceBtn();
        });
    }

    if (els.favoriteVoiceBtn) {
        els.favoriteVoiceBtn.addEventListener('click', () => {
            toggleFavoriteVoice();
        });
    }

    // Listeners
    if (els.scanBtn) {
        els.scanBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleScan();
        });
    }
    if (els.resetScanBtn) {
        els.resetScanBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleResetScan();
        });
    }
    if (els.clearBtn) els.clearBtn.addEventListener('click', async () => {
        const msg = activeTab === 'current' ? 'Clear cards for this page?' : 'Clear all history cards (excluding this page)?';
        if (confirm(msg)) {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const currentUrl = tabs[0]?.url || '';
            
            if (activeTab === 'current') {
                await clearCardsByUrl(currentUrl);
                // Broadcast to current tab to remove highlights
                chrome.tabs.sendMessage(tabs[0].id, { action: 'REMOVE_ALL_HIGHLIGHTS' }).catch(() => { });
            } else {
                await clearHistoryCards(currentUrl);
            }
            render();
        }
    });
    if (els.optionsBtn) els.optionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
    if (els.favoritesBtn) els.favoritesBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#favorites') });
    });

    // Tab switching
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            activeTab = tab.dataset.tab;
            updateSubTabsVisibility();
            render();
        });
    });

    // Sub-tab switching (Current Page categories)
    const subTabs = document.querySelectorAll('.sub-tab');
    subTabs.forEach(subTab => {
        subTab.addEventListener('click', () => {
            subTabs.forEach(t => t.classList.remove('active'));
            subTab.classList.add('active');
            activeSubTab = subTab.dataset.subtab;
            render();
        });
    });

    updateSubTabsVisibility();

    // Anki Modal Handlers
    if (els.ankiCancel) els.ankiCancel.addEventListener('click', () => {
        els.ankiModal.classList.remove('visible');
        pendingAnkiCard = null;
        pendingAnkiBtn = null;
    });

    if (els.ankiConfirm) els.ankiConfirm.addEventListener('click', async () => {
        if (!pendingAnkiCard || !pendingAnkiBtn) return;

        const deck = els.ankiDeckSelect.value || 'Default';
        pendingAnkiBtn.textContent = '...';
        els.ankiModal.classList.remove('visible');

        try {
            await addNoteToAnki(pendingAnkiCard, deck);
            pendingAnkiBtn.textContent = 'Added';
            pendingAnkiBtn.disabled = true;
            pendingAnkiBtn.style.background = '#d4edda';
            pendingAnkiBtn.style.borderColor = '#c3e6cb';
        } catch (e) {
            alert("Anki Error: " + e.message + "\nEnsure Anki is open and AnkiConnect installed.");
            pendingAnkiBtn.textContent = '+ Anki';
        }
    });

    render();

    getScanError().then(err => {
        if (err) {
            alert('Scan failed:\n' + err);
            clearScanError();
        }
    });

    // Check scanning status periodically and show reset button if stuck
    setInterval(async () => {
        const isScanning = await getScanningStatus();
        if (isScanning && els.resetScanBtn) {
            els.resetScanBtn.style.display = 'block';
        }
    }, 5000); // Check every 5 seconds
}

document.addEventListener('DOMContentLoaded', init);

function updateSubTabsVisibility() {
    const subTabsEl = document.getElementById('subTabs');
    if (subTabsEl) {
        subTabsEl.classList.toggle('hidden', activeTab !== 'current');
    }
}

function getCardCategory(card) {
    return card.category || 'phrase';
}

async function render() {
    const cards = await getCards();

    const isScanning = await getScanningStatus();

    if (els.scanBtn) {
        if (isScanning) {
            els.scanBtn.textContent = 'Scanning...';
            els.scanBtn.classList.add('scanning');
            els.scanBtn.disabled = true;
            if (els.resetScanBtn) els.resetScanBtn.style.display = 'block';
        } else {
            els.scanBtn.textContent = 'Scan Page';
            els.scanBtn.classList.remove('scanning');
            els.scanBtn.disabled = false;
            if (els.resetScanBtn) els.resetScanBtn.style.display = 'none';
        }
    }

    els.list.innerHTML = '';

    // Get current tab URL for filtering
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const currentUrl = tabs[0]?.url || '';

    // Filter cards based on tab
    let filteredCards;
    if (activeTab === 'current') {
        filteredCards = cards.filter(c => c.sourceUrl === currentUrl);
        filteredCards = filteredCards.filter(c => getCardCategory(c) === activeSubTab);
    } else {
        filteredCards = cards.filter(c => c.sourceUrl !== currentUrl);
    }

    if (filteredCards.length === 0) {
        let emptyMsg;
        if (activeTab === 'current') {
            emptyMsg = EMPTY_MESSAGES[activeSubTab] || EMPTY_MESSAGES.phrase;
        } else {
            emptyMsg = 'No history phrases found.';
        }
        els.list.innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
        return;
    }

    // Sort cards: manual first, then auto-scanned
    // Within auto-scanned: maintain article order (new articles first, then old articles)
    // Within same article: maintain phrase order (phraseOrder)
    const sortedCards = [...filteredCards].sort((a, b) => {
        // Sort by timestamp: newer first
        const aTime = a.timestamp || 0;
        const bTime = b.timestamp || 0;
        if (aTime !== bTime) {
            return bTime - aTime;
        }

        // Same timestamp (usually same scan): maintain phrase order
        const aOrder = a.phraseOrder !== undefined ? a.phraseOrder : 0;
        const bOrder = b.phraseOrder !== undefined ? b.phraseOrder : 0;
        return aOrder - bOrder;
    });

    // Get all favorites to check status efficiently
    const favorites = await getFavorites();

    for (let index = 0; index < sortedCards.length; index++) {
        const card = sortedCards[index];
        const category = getCardCategory(card);
        const div = document.createElement('div');
        div.className = `card card-${category}`;

        const showPhonetic = category === 'powerword' && card.phonetic;
        const categoryLabel = SUBTAB_LABELS[category] || 'Phrase';

        // Check if card is favorited
        const favorited = favorites.some(f =>
            f.phrase.toLowerCase() === card.phrase.toLowerCase() &&
            f.sentence === card.sentence
        );

        div.innerHTML = `
            <div class="card-header">
                <div class="card-title">
                    ${card.phrase}
                    <button class="speak-btn phrase-speak" title="Read ${categoryLabel.toLowerCase()}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                        </svg>
                    </button>
                </div>
                <div class="card-actions">
                    <button class="icon-btn delete-btn" data-idx="${index}" title="Delete Card">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="icon-svg">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            <line x1="10" y1="11" x2="10" y2="17"></line>
                            <line x1="14" y1="11" x2="14" y2="17"></line>
                        </svg>
                    </button>
                    <button class="icon-btn favorite-btn ${favorited ? 'favorited' : ''}" data-idx="${index}" title="${favorited ? 'Remove from favorites' : 'Add to favorites'}">
                        <!-- Star Icon -->
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="${favorited ? 'currentColor' : 'none'}" class="icon-svg" stroke="currentColor" stroke-width="2">
                            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </button>
                    <button class="icon-btn ask-ai" data-idx="${index}" title="Chat with AI">
                        <!-- Chat Icon -->
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" class="icon-svg">
                            <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 13.5997 2.37562 15.1116 3.04346 16.4525C3.22094 16.8088 3.28001 17.2161 3.17712 17.6006L2.58151 19.8267C2.32295 20.793 3.20701 21.677 4.17335 21.4185L6.39939 20.8229C6.78393 20.72 7.19121 20.7791 7.54753 20.9565C8.88837 21.6244 10.4003 22 12 22Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            <path d="M8 12H16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </button>
                    <button class="icon-btn add-anki" data-idx="${index}" title="Add to Anki">
                        <!-- Plus Icon -->
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" class="icon-svg">
                             <path d="M12 5V19" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                             <path d="M5 12H19" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </button>
                </div>
            </div>
            
            ${showPhonetic ? `<div class="card-phonetic">[${card.phonetic}]</div>` : ''}
            <div class="card-explanation">${card.explanation}</div>
            <div class="card-sentence">
                "${card.sentence}"
                <button class="speak-btn sentence-speak" title="Read sentence">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                    </svg>
                </button>
            </div>
            
            <div class="chat-container" id="chat-${index}">
                <div class="chat-messages"></div>
                <div class="chat-input-area">
                    <input type="text" placeholder="Type your question...">
                    <button class="chat-send-btn">
                         <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2">
                            <path d="M22 2L11 13M22 2L15 22L11 13M11 13L2 9L22 2" stroke-linecap="round" stroke-linejoin="round"/>
                         </svg>
                    </button>
                </div>
            </div>
        `;

        const deleteBtn = div.querySelector('.delete-btn');
        const ankiBtn = div.querySelector('.add-anki');
        const aiBtn = div.querySelector('.ask-ai');
        const favoriteBtn = div.querySelector('.favorite-btn');
        const phraseSpeakBtn = div.querySelector('.phrase-speak');
        const sentenceSpeakBtn = div.querySelector('.sentence-speak');

        deleteBtn.onclick = async (e) => {
            e.stopPropagation();
            if (confirm('Delete this card?')) {
                // Find the actual index in the original cards array
                const originalCards = await getCards();
                // Since we sorted them, we should find by phrase and sentence
                const realIdx = originalCards.findIndex(c => 
                    c.phrase === card.phrase && 
                    c.sentence === card.sentence && 
                    c.sourceUrl === card.sourceUrl
                );
                if (realIdx !== -1) {
                    await deleteCard(realIdx);
                    // Broadcast to all tabs to remove highlight
                    broadcastMessage({
                        action: 'REMOVE_HIGHLIGHT',
                        phrase: card.phrase,
                        sentence: card.sentence
                    });
                    render();
                }
            }
        };

        phraseSpeakBtn.onclick = () => speakText(card.phrase);
        sentenceSpeakBtn.onclick = () => speakText(card.sentence);

        ankiBtn.onclick = () => handleAnki(card, ankiBtn);
        aiBtn.onclick = () => handleAskAI(card, div.querySelector(`#chat-${index}`));
        favoriteBtn.onclick = async () => {
            const isFav = await isFavorite(card);
            if (isFav) {
                // Remove from favorites
                const favorites = await getFavorites();
                const favIndex = favorites.findIndex(f =>
                    f.phrase.toLowerCase() === card.phrase.toLowerCase() &&
                    f.sentence === card.sentence
                );
                if (favIndex !== -1) {
                    await removeFavorite(favIndex);
                    favoriteBtn.classList.remove('favorited');
                    favoriteBtn.querySelector('svg').setAttribute('fill', 'none');
                    favoriteBtn.title = 'Add to favorites';
                }
            } else {
                // Add to favorites - get current tab URL when clicking
                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                const url = tabs[0]?.url || currentUrl;
                // Only save http/https URLs, not chrome:// or extension URLs
                const validUrl = url && (url.startsWith('http://') || url.startsWith('https://')) ? url : '';
                await addFavorite(card, validUrl);
                favoriteBtn.classList.add('favorited');
                favoriteBtn.querySelector('svg').setAttribute('fill', 'currentColor');
                favoriteBtn.title = 'Remove from favorites';
            }
        };

        els.list.appendChild(div);
    }
}

async function handleAnki(card, btn) {
    pendingAnkiCard = card;
    pendingAnkiBtn = btn;

    // Load Decks
    const decks = await getAnkiDecks();
    els.ankiDeckSelect.innerHTML = decks.map(d => `<option value="${d}">${d}</option>`).join('');

    // Show Modal
    els.ankiModal.classList.add('visible');
}

async function handleScan() {
    // Prevent multiple clicks
    if (els.scanBtn && els.scanBtn.disabled) {
        return;
    }

    try {
        // Check if AI is configured before starting scan
        const settings = await getSettings();
        if (!settings.modelName || !settings.apiUrl) {
            alert("Please configure AI settings in options first.");
            return;
        }

        // Disable button immediately to prevent double-click
        if (els.scanBtn) {
            els.scanBtn.disabled = true;
            els.scanBtn.textContent = 'Starting...';
        }

        const response = await chrome.runtime.sendMessage({ action: 'START_SCAN' });

        if (chrome.runtime.lastError) {
            throw new Error(chrome.runtime.lastError.message || "Failed to start scan");
        }

        // The background script sets IsScanning=true immediately.
        // We trigger a render to update UI.
        await render();

        // Set a timeout to reset scanning status if it gets stuck
        setTimeout(async () => {
            const isScanning = await getScanningStatus();
            if (isScanning) {
                // If still scanning after 60 seconds, reset it
                await setScanningStatus(false);
                await render();
                alert("Scan timeout. Please check your AI configuration and try again.");
            }
        }, 300000);
    } catch (e) {
        // Reset scanning status on error
        await setScanningStatus(false);
        await render();
        const errorMsg = e.message || "Unknown error occurred";
        alert("Scan Failed: " + errorMsg);
        console.error("Scan error:", e);
    }
}

async function handleResetScan() {
    if (confirm('Reset scanning status? This will stop the current scan.')) {
        try {
            await setScanningStatus(false);
            await render();
            // Also try to send message to background to ensure it's reset
            chrome.runtime.sendMessage({ action: 'RESET_SCAN' }).catch(() => { });
        } catch (e) {
            console.error("Reset scan error:", e);
            await setScanningStatus(false);
            await render();
        }
    }
}

// Format text for better readability
function formatText(text) {
    if (!text) return '';

    // Escape HTML to prevent XSS
    let formatted = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // Convert markdown-style formatting
    // Process bold first (double markers), then italic (single markers)
    // Bold: **text** or __text__
    formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    formatted = formatted.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // Italic: *text* or _text_ (single markers, not part of bold)
    // Use a simpler approach: match single * or _ that are not part of double markers
    formatted = formatted.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');
    formatted = formatted.replace(/(?<!_)_([^_\n]+?)_(?!_)/g, '<em>$1</em>');

    // Code: `code`
    formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Convert double line breaks to paragraphs
    formatted = formatted.replace(/\n\n+/g, '</p><p>');

    // Convert single line breaks to <br>
    formatted = formatted.replace(/\n/g, '<br>');

    // Wrap in paragraph if needed
    if (!formatted.startsWith('<p>')) {
        formatted = '<p>' + formatted + '</p>';
    }

    return formatted;
}

async function handleAskAI(card, container) {
    if (container.classList.contains('visible')) {
        container.classList.remove('visible');
        return;
    }
    container.classList.add('visible');

    const msgList = container.querySelector('.chat-messages');
    const input = container.querySelector('input');
    const sendBtn = container.querySelector('button');

    // Init if empty
    if (msgList.innerHTML === '') {
        const initial = document.createElement('div');
        initial.className = 'chat-bubble ai';
        initial.innerHTML = formatText(`What would you like to know about this ${SUBTAB_LABELS[getCardCategory(card)] || 'phrase'}?`);
        msgList.appendChild(initial);
    }

    const sendMessage = async () => {
        const text = input.value.trim();
        if (!text) return;

        // User Msg
        const userBubble = document.createElement('div');
        userBubble.className = 'chat-bubble user';
        userBubble.textContent = text; // User messages stay as plain text
        msgList.appendChild(userBubble);
        input.value = '';
        msgList.scrollTop = msgList.scrollHeight;

        // Context
        const messages = [
            { role: 'system', content: `You are a helpful language tutor. User is asking about the ${SUBTAB_LABELS[getCardCategory(card)] || 'phrase'} "${card.phrase}" found in this sentence: "${card.sentence}". The current explanation is: "${card.explanation}". Answer concisely and format your response with proper paragraphs and line breaks for better readability.` },
            { role: 'user', content: text }
        ];

        // Loading
        const loadBubble = document.createElement('div');
        loadBubble.className = 'chat-bubble ai';
        loadBubble.innerHTML = '<p>...</p>';
        msgList.appendChild(loadBubble);
        msgList.scrollTop = msgList.scrollHeight;

        try {
            const settings = await getSettings();
            const response = await chatWithAI(messages, settings);
            loadBubble.innerHTML = formatText(response);
        } catch (e) {
            loadBubble.innerHTML = formatText("Error: " + e.message);
        }

        msgList.scrollTop = msgList.scrollHeight;
    };

    sendBtn.onclick = sendMessage;
    input.onkeypress = (e) => {
        if (e.key === 'Enter') sendMessage();
    };

    input.focus();
}

// Listen for updates (e.g. from manual generation in bg)
chrome.storage.onChanged.addListener((changes) => {
    if (changes.pd_cards || changes.pd_is_scanning) {
        if (typeof render === 'function') render();
    }
    if (changes.pd_scan_error && changes.pd_scan_error.newValue) {
        alert('Scan failed:\n' + changes.pd_scan_error.newValue);
        clearScanError();
        if (typeof render === 'function') render();
    }
});
