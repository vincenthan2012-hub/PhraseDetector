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

const PROVIDER_PRESETS = {
    deepseek: {
        name: 'DeepSeek (官方)',
        url: 'https://api.deepseek.com/v1/chat/completions',
        model: 'deepseek-chat',
        apiKeyRequired: true,
        keyPlaceholder: 'sk-...'
    },
    siliconflow: {
        name: 'SiliconFlow (硅基流动)',
        url: 'https://api.siliconflow.cn/v1/chat/completions',
        model: 'deepseek-ai/DeepSeek-V3',
        apiKeyRequired: true,
        keyPlaceholder: 'sk-...'
    },
    openrouter: {
        name: 'OpenRouter',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        model: 'deepseek/deepseek-chat',
        apiKeyRequired: true,
        keyPlaceholder: 'sk-or-...'
    },
    openai: {
        name: 'OpenAI (ChatGPT)',
        url: 'https://api.openai.com/v1/chat/completions',
        model: 'gpt-4o-mini',
        apiKeyRequired: true,
        keyPlaceholder: 'sk-...'
    },
    qwen: {
        name: '通义千问 (DashScope)',
        url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        model: 'qwen-plus',
        apiKeyRequired: true,
        keyPlaceholder: 'sk-...'
    },
    moonshot: {
        name: 'Kimi (Moonshot)',
        url: 'https://api.moonshot.cn/v1/chat/completions',
        model: 'moonshot-v1-8k',
        apiKeyRequired: true,
        keyPlaceholder: 'sk-...'
    },
    zhipu: {
        name: '智谱清言 (GLM)',
        url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        model: 'glm-4-flash',
        apiKeyRequired: true,
        keyPlaceholder: 'API Key...'
    },
    ollama: {
        name: 'Ollama (Local)',
        url: 'http://127.0.0.1:11434/api/generate',
        model: 'llama3:latest',
        apiKeyRequired: false,
        keyPlaceholder: ''
    },
    online: {
        name: 'Custom (OpenAI Compatible)',
        url: '',
        model: '',
        apiKeyRequired: true,
        keyPlaceholder: 'sk-...'
    }
};

let currentAuto = 'yellow';
let currentManual = 'pink';
let currentElevenLabsVoices = [];
let activeProvider = 'ollama';
let providerConfigs = {};

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
    activeProvider = s.llmProvider || 'ollama';
    if (!PROVIDER_PRESETS[activeProvider]) {
        activeProvider = 'online';
    }
    els.provider.value = activeProvider;

    // Load providerConfigs
    providerConfigs = s.providerConfigs || {};

    // Ensure all presets exist in providerConfigs with their defaults
    for (const [pKey, preset] of Object.entries(PROVIDER_PRESETS)) {
        if (!providerConfigs[pKey]) {
            providerConfigs[pKey] = {
                apiUrl: preset.url || '',
                apiKey: '',
                modelName: preset.model || ''
            };
        }
    }

    // Sync legacy or active settings to active provider slot
    if (s.apiUrl) providerConfigs[activeProvider].apiUrl = s.apiUrl;
    if (s.apiKey) providerConfigs[activeProvider].apiKey = s.apiKey;
    if (s.modelName) providerConfigs[activeProvider].modelName = s.modelName;

    // Load active provider values into UI inputs
    const currentConfig = providerConfigs[activeProvider];
    els.url.value = currentConfig.apiUrl || '';
    els.key.value = currentConfig.apiKey || '';
    els.model.value = currentConfig.modelName || '';

    els.lang.value = s.targetLang || 'Chinese';
    els.ttsProvider.value = s.ttsProvider || 'web';
    els.elevenApiKey.value = s.elevenLabsApiKey || '';
    currentElevenLabsVoices = s.elevenLabsVoices || [];

    currentAuto = s.highlightColorAuto || 'yellow';
    currentManual = s.highlightColorManual || 'pink';

    selectSwatch(els.autoSwatches, currentAuto);
    selectSwatch(els.manualSwatches, currentManual);

    updateProviderUIState(activeProvider);
    toggleTtsConfig();
    renderTags(s.savedModels);
    renderElevenLabsVoices();
}

function onProviderChange() {
    // 1. Save current input values into previous active provider
    if (activeProvider && providerConfigs[activeProvider]) {
        providerConfigs[activeProvider].apiUrl = els.url.value.trim();
        providerConfigs[activeProvider].apiKey = els.key.value.trim();
        providerConfigs[activeProvider].modelName = els.model.value.trim();
    }

    // 2. Switch to new provider
    activeProvider = els.provider.value;
    const preset = PROVIDER_PRESETS[activeProvider] || PROVIDER_PRESETS.online;

    if (!providerConfigs[activeProvider]) {
        providerConfigs[activeProvider] = {
            apiUrl: preset.url || '',
            apiKey: '',
            modelName: preset.model || ''
        };
    }

    // 3. Load new provider's saved values
    const targetConfig = providerConfigs[activeProvider];
    els.url.value = targetConfig.apiUrl !== undefined ? targetConfig.apiUrl : (preset.url || '');
    els.key.value = targetConfig.apiKey || '';
    els.model.value = targetConfig.modelName !== undefined ? targetConfig.modelName : (preset.model || '');

    // 4. Update UI input state (placeholders, visibility)
    updateProviderUIState(activeProvider);
}

function updateProviderUIState(provider) {
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.online;

    // Show/hide API Key input
    els.keyGroup.style.display = preset.apiKeyRequired ? 'block' : 'none';
    if (preset.keyPlaceholder) {
        els.key.placeholder = preset.keyPlaceholder;
    }

    if (preset.url) {
        els.url.placeholder = preset.url;
    } else {
        els.url.placeholder = 'https://api.your-provider.com/v1/chat/completions';
    }

    if (preset.model) {
        els.model.placeholder = preset.model;
    } else {
        els.model.placeholder = 'custom-model-name';
    }
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

    // Sync current inputs into activeProvider's config
    if (activeProvider) {
        if (!providerConfigs[activeProvider]) providerConfigs[activeProvider] = {};
        providerConfigs[activeProvider].apiUrl = els.url.value.trim();
        providerConfigs[activeProvider].apiKey = els.key.value.trim();
        providerConfigs[activeProvider].modelName = els.model.value.trim();
    }

    await saveSettings({
        llmProvider: activeProvider,
        apiUrl: els.url.value.trim(),
        apiKey: els.key.value.trim(),
        modelName: els.model.value.trim(),
        providerConfigs: providerConfigs,
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

    const url = els.url.value.trim();
    const model = els.model.value.trim();
    const isOllama = els.provider.value === 'ollama' || url.includes('11434') || url.includes('11435') || url.includes('/api/generate');
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = els.key.value.trim();
    if (!isOllama && apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const requestBody = isOllama ? {
        model: model,
        prompt: "Hi",
        stream: false,
        options: { num_predict: 16 }
    } : {
        model: model,
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
        max_tokens: 16
    };

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody)
        });

        if (res.ok) {
            showStatus('Connection Successful!', 'success');
        } else {
            let detail = '';
            try {
                const text = await res.text();
                if (text) detail = text.length > 200 ? text.slice(0, 200) + '...' : text;
            } catch (e) { }

            let msg = `Error: ${res.status} ${res.statusText}`;
            if (res.status === 400) {
                msg += ' (400 Bad Request)。请检查：1) Model Name 是否有效；2) API URL 是否为完整的 Chat Completions 端点（如 https://api.openai.com/v1/chat/completions）。';
            } else if (res.status === 401) {
                msg += '。请检查 API Key 是否正确。';
            } else if (res.status === 403) {
                msg += '。可能原因：API Key 无效或已过期、权限不足；若用 Ollama 请确认代理(11435)或直连(11434)已启动且地址正确。';
            } else if (res.status === 404) {
                msg += '。API 路径未找到(404)，请检查 API URL 是否填写完整。';
            }
            if (detail) {
                msg += ` [详情: ${detail}]`;
            }
            showStatus(msg, 'error');
        }
    } catch (e) {
        let msg = e.message || 'Unknown error';
        if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
            msg += '。请确认：1) 网络与 API 地址可连通；2) 若用 Ollama，请确认服务已启动或运行 node proxy.js 开启代理。';
        }
        showStatus(`Error: ${msg}`, 'error');
    }
}

els.save.addEventListener('click', save);
els.saveModel.addEventListener('click', saveModelTag);
els.test.addEventListener('click', testConnection);
els.provider.addEventListener('change', onProviderChange);
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
