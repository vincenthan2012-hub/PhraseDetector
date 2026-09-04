import { getSettings, saveSettings, getFavorites, removeFavorites, clearFavorites } from '../utils/storage.js';
import { addNoteToAnki, getAnkiDecks, generateStory } from '../utils/api.js';

const els = {
    provider: document.getElementById('llmProvider'),
    url: document.getElementById('apiUrl'),
    key: document.getElementById('apiKey'),
    keyGroup: document.getElementById('apiKeyGroup'),
    model: document.getElementById('modelName'),
    tags: document.getElementById('modelTags'),
    lang: document.getElementById('targetLang'),
    save: document.getElementById('save'),
    saveModel: document.getElementById('saveModel'),
    test: document.getElementById('testConnection'),
    status: document.getElementById('status'),
    autoSwatches: document.getElementById('autoColorGroup').querySelectorAll('.swatch'),
    manualSwatches: document.getElementById('manualColorGroup').querySelectorAll('.swatch'),
    ttsProvider: document.getElementById('ttsProvider'),
    elevenLabsConfig: document.getElementById('elevenLabsConfig'),
    elevenApiKey: document.getElementById('elevenLabsApiKey'),
    newElevenVoiceName: document.getElementById('newElevenVoiceName'),
    newElevenVoiceId: document.getElementById('newElevenVoiceId'),
    addElevenVoiceBtn: document.getElementById('addElevenVoiceBtn'),
    elevenLabsVoicesList: document.getElementById('elevenLabsVoicesList')
};

let currentAuto = 'yellow';
let currentManual = 'pink';
let currentElevenLabsVoices = [];

function showStatus(msg, type) {
    els.status.textContent = msg;
    els.status.className = type;
    els.status.style.display = 'block';
    setTimeout(() => els.status.style.display = 'none', 3000);
}

function selectSwatch(swatches, value) {
    swatches.forEach(s => {
        if (s.dataset.val === value) s.classList.add('selected');
        else s.classList.remove('selected');
    });
}

function setupSwatches(swatches, isAuto) {
    swatches.forEach(s => {
        s.addEventListener('click', () => {
            if (isAuto) currentAuto = s.dataset.val;
            else currentManual = s.dataset.val;
            selectSwatch(swatches, s.dataset.val);
        });
    });
}

async function load() {
    const s = await getSettings();
    els.provider.value = s.llmProvider;
    els.url.value = s.apiUrl || 'http://127.0.0.1:11435/api/generate';
    els.key.value = s.apiKey;
    els.model.value = s.modelName;
    els.lang.value = s.targetLang;
    els.ttsProvider.value = s.ttsProvider || 'web';
    els.elevenApiKey.value = s.elevenLabsApiKey || '';
    currentElevenLabsVoices = s.elevenLabsVoices || [];

    currentAuto = s.highlightColorAuto || 'yellow';
    currentManual = s.highlightColorManual || 'pink';

    selectSwatch(els.autoSwatches, currentAuto);
    selectSwatch(els.manualSwatches, currentManual);

    toggleKey();
    toggleTtsConfig();
    renderTags(s.savedModels);
    renderElevenLabsVoices();
}

function toggleKey() {
    els.keyGroup.style.display = els.provider.value === 'online' ? 'block' : 'none';
}

function toggleTtsConfig() {
    els.elevenLabsConfig.style.display = els.ttsProvider.value === 'elevenlabs' ? 'block' : 'none';
}

function renderTags(models) {
    if (!models) return;
    els.tags.innerHTML = '';
    models.forEach(m => {
        const tag = document.createElement('span');
        tag.className = 'tag';
        
        const tagText = document.createElement('span');
        tagText.textContent = m;
        tagText.onclick = () => {
            els.model.value = m;
        };
        
        const deleteBtn = document.createElement('span');
        deleteBtn.className = 'tag-delete';
        deleteBtn.textContent = '×';
        deleteBtn.onclick = async (e) => {
            e.stopPropagation();
            const s = await getSettings();
            s.savedModels = s.savedModels.filter(model => model !== m);
            await saveSettings(s);
            renderTags(s.savedModels);
        };
        
        tag.appendChild(tagText);
        tag.appendChild(deleteBtn);
        els.tags.appendChild(tag);
    });
}

function renderElevenLabsVoices() {
    els.elevenLabsVoicesList.innerHTML = '';
    currentElevenLabsVoices.forEach((voice, index) => {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.style.marginBottom = '5px';
        
        const tagText = document.createElement('span');
        tagText.textContent = `${voice.name} (${voice.id})`;
        
        const deleteBtn = document.createElement('span');
        deleteBtn.className = 'tag-delete';
        deleteBtn.textContent = '×';
        deleteBtn.onclick = async (e) => {
            e.stopPropagation();
            currentElevenLabsVoices.splice(index, 1);
            renderElevenLabsVoices();
            save();
        };
        
        tag.appendChild(tagText);
        tag.appendChild(deleteBtn);
        els.elevenLabsVoicesList.appendChild(tag);
    });
}

async function save() {
    const old = await getSettings();
    await saveSettings({
        llmProvider: els.provider.value,
        apiUrl: els.url.value,
        apiKey: els.key.value,
        modelName: els.model.value,
        targetLang: els.lang.value,
        ttsProvider: els.ttsProvider.value,
        elevenLabsApiKey: els.elevenApiKey.value,
        elevenLabsVoices: currentElevenLabsVoices,
        highlightColorAuto: currentAuto,
        highlightColorManual: currentManual,
        savedModels: old.savedModels
    });
    showStatus('Settings saved!', 'success');
}

// Init swatches
setupSwatches(els.autoSwatches, true);
setupSwatches(els.manualSwatches, false);

async function saveModelTag() {
    const val = els.model.value.trim();
    if (!val) return;
    const s = await getSettings();
    if (!s.savedModels.includes(val)) {
        s.savedModels.push(val);
        await saveSettings(s);
        renderTags(s.savedModels);
    }
}

function addElevenVoice() {
    const name = els.newElevenVoiceName.value.trim();
    const id = els.newElevenVoiceId.value.trim();
    if (!name || !id) {
        showStatus('Please enter both Name and Voice ID.', 'error');
        return;
    }
    
    // update list
    currentElevenLabsVoices.push({ name, id });
    renderElevenLabsVoices();
    
    // clear input
    els.newElevenVoiceName.value = '';
    els.newElevenVoiceId.value = '';
    
    // Auto-save settings
    save();
}

async function testConnection() {
    els.status.textContent = 'Testing...';
    els.status.style.display = 'block';
    els.status.className = '';

    const url = els.url.value;
    const model = els.model.value;
    const isOllama = els.provider.value === 'ollama' || url.includes('11434') || url.includes('11435');
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = els.key.value.trim();
    if (!isOllama && apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: model,
                prompt: "Hi",
                stream: false,
                ...(isOllama ? { options: { num_predict: 16 } } : { max_tokens: 16 })
            })
        });

        if (res.ok) {
            showStatus('Connection Successful!', 'success');
        } else {
            let msg = `Error: ${res.status} ${res.statusText}`;
            if (res.status === 403) {
                msg += '。可能原因：API Key 无效或已过期、权限不足；若用 Ollama 请确认代理(11435)或直连(11434)已启动且地址正确。';
            } else if (res.status === 401) {
                msg += '。请检查 API Key 是否正确。';
            }
            showStatus(msg, 'error');
        }
    } catch (e) {
        let msg = e.message || 'Unknown error';
        if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
            msg += '。请确认：1) Ollama 已启动；2) 若用代理，请运行 node proxy.js 启动代理(端口 11435)。';
        }
        showStatus(`Error: ${msg}`, 'error');
    }
}

els.save.addEventListener('click', save);
els.saveModel.addEventListener('click', saveModelTag);
els.test.addEventListener('click', testConnection);
els.provider.addEventListener('change', toggleKey);
els.ttsProvider.addEventListener('change', toggleTtsConfig);
els.addElevenVoiceBtn.addEventListener('click', addElevenVoice);

// Tab switching logic
document.addEventListener('DOMContentLoaded', () => {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');

    function switchTab(tabId) {
        tabBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabId));
        tabPanes.forEach(pane => pane.classList.toggle('active', pane.id === tabId));
        window.location.hash = tabId.replace('tab-', '');
    }

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Handle initial hash or hash changes
    function onHashChange() {
        if (window.location.hash === '#favorites') {
            switchTab('tab-favorites');
        } else {
            switchTab('tab-settings');
        }
    }
    
    window.addEventListener('hashchange', onHashChange);
    onHashChange();
});

document.addEventListener('DOMContentLoaded', load);
