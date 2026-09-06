/**
 * API utility for LLM and Anki interactions.
 */

// Helper to clean JSON output from LLM
export const cleanJson = (text) => {
    // Remove markdown code blocks if present
    text = text.replace(/```json/g, '').replace(/```/g, '').trim();

    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start !== -1 && end !== -1) {
        return JSON.parse(text.substring(start, end + 1));
    }
    // Try to parse entire text if no brackets (maybe single object or object stream)
    // But we expect array for phrases.
    try {
        return JSON.parse(text);
    } catch (e) {
        // If it fails, maybe it's just a single object?
        const startObj = text.indexOf('{');
        const endObj = text.lastIndexOf('}');
        if (startObj !== -1 && endObj !== -1) {
            return JSON.parse(text.substring(startObj, endObj + 1));
        }
        // console.error("Failed to parse JSON", text);
        throw e;
    }
};

const SCAN_CHUNK_SIZE = 8000;
const SCAN_CHUNK_OVERLAP = 400;

const isOllamaEndpoint = (settings) => {
    if (settings.llmProvider === 'ollama') return true;
    const url = (settings.apiUrl || '').toLowerCase();
    if (url.includes('11434') || url.includes('11435')) return true;
    return (url.includes('localhost') || url.includes('127.0.0.1')) && url.includes('/api/generate');
};

const buildApiHeaders = (settings) => {
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = (settings.apiKey || '').trim();
    if (!isOllamaEndpoint(settings) && apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
};

const readApiErrorDetail = async (response) => {
    try {
        const text = await response.text();
        if (!text) return '';
        return text.length > 300 ? `${text.slice(0, 300)}...` : text;
    } catch (e) {
        return '';
    }
};

const buildApiErrorMessage = (response, settings, detail = '') => {
    const hint = response.status === 400
        ? ' 请求参数错误(400)。请检查：1) Model Name 是否填写有效；2) API URL 是否为完整的 Chat Completions 端点（如 https://api.openai.com/v1/chat/completions）。'
        : (response.status === 403
            ? ' 可能原因：API Key 无效/过期、权限不足、或请求被拒绝。Ollama 用户请确认服务已启动，API URL 用 http://127.0.0.1:11435/api/generate（代理）或 11434（直连），且 Provider 选 Ollama、API Key 留空。'
            : (response.status === 401 ? ' 请检查 API Key 是否正确。' : (response.status === 404 ? ' 接口路径未找到(404)，请检查 API URL 是否正确。' : '')));
    const urlHint = settings.apiUrl ? `\nURL: ${settings.apiUrl}` : '';
    const detailHint = detail ? `\n详情: ${detail}` : '';
    return `API 错误 ${response.status} (${response.statusText})${hint}${urlHint}${detailHint}`;
};

const normalizeCategory = (category) => {
    const value = (category || 'phrase').toLowerCase().trim();
    if (value === 'powerword' || value === 'power_word' || value === 'power-word') return 'powerword';
    if (value === 'structure' || value === 'structures') return 'structure';
    return 'phrase';
};

const splitTextForScan = (text) => {
    if (!text || text.length <= SCAN_CHUNK_SIZE) return [text];

    const chunks = [];
    let start = 0;
    while (start < text.length) {
        let end = Math.min(start + SCAN_CHUNK_SIZE, text.length);
        if (end < text.length) {
            const paragraphBreak = text.lastIndexOf('\n\n', end);
            const sentenceBreak = text.lastIndexOf('. ', end);
            const breakAt = Math.max(paragraphBreak, sentenceBreak);
            if (breakAt > start + SCAN_CHUNK_SIZE * 0.5) {
                end = breakAt + (sentenceBreak === breakAt ? 2 : 0);
            }
        }
        chunks.push(text.slice(start, end));
        if (end >= text.length) break;
        start = Math.max(end - SCAN_CHUNK_OVERLAP, start + 1);
    }
    return chunks;
};

const parseScanItems = (raw) => {
    if (!raw) return [];
    const clean = raw.replace(/```json/gi, '').replace(/```/g, '').replace(/^,/, '').trim();
    if (!clean) return [];

    const items = [];
    const tryPush = (obj) => {
        if (obj && typeof obj === 'object' && obj.phrase) {
            obj.category = normalizeCategory(obj.category);
            items.push(obj);
        }
    };

    if (clean.startsWith('[')) {
        try {
            const arr = JSON.parse(clean);
            if (Array.isArray(arr)) {
                arr.forEach(tryPush);
                return items;
            }
        } catch (e) { /* fall through to object extraction */ }
    }

    if (clean.startsWith('{') && clean.endsWith('}')) {
        try {
            tryPush(JSON.parse(clean));
            return items;
        } catch (e) { /* fall through to brace extraction */ }
    }

    // Extract any embedded JSON objects via brace matching
    extractObjectsFromText(clean, tryPush);
    return items;
};

// Robust JSON object extractor that handles multiline, concatenated, or streaming JSON objects
const extractObjectsFromText = (text, onObjectFound) => {
    let braceCount = 0;
    let startIdx = -1;
    let inString = false;
    let escape = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (escape) {
            escape = false;
            continue;
        }
        if (char === '\\') {
            escape = true;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            continue;
        }

        if (!inString) {
            if (char === '{') {
                if (braceCount === 0) {
                    startIdx = i;
                }
                braceCount++;
            } else if (char === '}') {
                braceCount--;
                if (braceCount === 0 && startIdx !== -1) {
                    const jsonStr = text.substring(startIdx, i + 1);
                    try {
                        const obj = JSON.parse(jsonStr);
                        if (obj && typeof obj === 'object' && obj.phrase) {
                            onObjectFound(obj);
                        }
                    } catch (e) {
                        // Incomplete or invalid JSON object, skip
                    }
                    startIdx = -1;
                }
            }
        }
    }
};

const buildScanPrompt = (text, settings, streamFormat, chunkMeta = null) => {
    const languageInstruction = settings.sourceLang === 'auto' || !settings.sourceLang
        ? "Automatically detect the language of the text and identify expressions in that language."
        : `The text is in ${settings.sourceLang}. Identify expressions specifically in ${settings.sourceLang}.`;

    const chunkInstruction = chunkMeta && chunkMeta.totalChunks > 1
        ? `This is section ${chunkMeta.chunkIndex + 1} of ${chunkMeta.totalChunks} from a longer article. Extract ALL qualifying items from THIS section only — do not skip valid expressions.`
        : 'Extract ALL qualifying expressions from the entire text below — do not stop after a few examples.';

    return `
    Analyze the following text and identify language-learning items in THREE categories. ${languageInstruction}
    ${chunkInstruction}
    Explain the meaning in ${settings.targetLang}.
    IMPORTANT: The "explanation" field MUST be written EXCLUSIVELY in ${settings.targetLang}. Do not use English.

    QUANTITY: There is NO fixed limit per category. Include EVERY expression in the text that meets the criteria below. Do NOT stop at 2–3 items per category. Longer texts should yield more items. Omit only duplicates and items with low learning value.

    Categories (assign exactly one "category" per item):
    1. "powerword" — Punchy, compact words with vivid meaning and flexible usage; OR familiar words used in uncommon/rare senses. Single words or very short compounds only.
    2. "phrase" — Practical short phrases, idioms, slang, and fixed collocations (multi-word expressions).
    3. "structure" — Reusable sentence-level patterns that elevate writing/speaking beyond basic grammar. Prioritize sophisticated, transferable frameworks that improve expression quality and efficiency.
       Include patterns useful for:
       - Descriptive writing: vivid scene-setting, sensory detail framing, character/state portrayal (e.g. "X is the kind of Y that...", "What strikes you about X is...")
       - Narrative writing: story progression, turning points, cause-effect chains, flashback/foreshadowing frames (e.g. "By the time X..., Y had already...", "Little did X know that...")
       - Analytical/argumentative writing: thesis framing, evidence integration, contrast, implication, evaluation (e.g. "The irony is that...", "This speaks to a broader...", "Far from X, Y in fact...")
       The "phrase" field should be the abstract, reusable pattern (use "..." for variable slots); "sentence" is a concrete example from the text.
       EXCLUDE from structure:
       - Single subordinators or openers alone: "If...", "When...", "While...", "Although...", "Because...", "Unless...", "Since...", "As..." (with no further rhetorical frame)
       - Elementary correlative pairs (not only/but also, either/or, both/and, if...then)
       - Patterns shorter than ~6 content words (excluding variable slots)
       - Basic conditional or causal clauses with no rhetorical sophistication
       - Anything taught in the first weeks of beginner grammar
       REQUIRE for structure: multi-clause frames, explicit rhetorical purpose (contrast, emphasis, implication, nuance, evaluation), or templates clearly reusable in advanced writing/speaking.

    Phonetic rules:
    - For "powerword" ONLY: provide phonetic transcription, pinyin, or romanization in "phonetic". Use the MOST COMMON learner-friendly system for the language (IPA for English; Pinyin for Mandarin; Jyutping for Cantonese; Romaji for Japanese; etc.).
    - For "phrase" and "structure": set "phonetic" to an empty string "".

    OUTPUT FORMAT:
    Output valid JSON objects for each expression found:
    [
      {
        "category": "powerword" | "phrase" | "structure",
        "phrase": "...",
        "phonetic": "...",
        "explanation": "...",
        "sentence": "..."
      }
    ]

    IMPORTANT: The "sentence" field must be the EXACT complete sentence from the original text, including proper punctuation.
    Ignore standard subject-verb combinations. Focus on high language-learning value.

    Text:
    "${text}"
    `;
};

const buildScanRequestBody = (settings, prompt, stream) => {
    if (isOllamaEndpoint(settings)) {
        const body = {
            model: settings.modelName,
            prompt,
            stream,
            options: {
                num_predict: 4096,
                num_ctx: 16384,
                temperature: 0.2
            }
        };
        if (!stream) {
            body.format = 'json';
        }
        return body;
    } else {
        // OpenAI Compatible Chat Completion
        return {
            model: settings.modelName,
            messages: [
                { role: 'user', content: prompt }
            ],
            stream,
            max_tokens: 4096,
            temperature: 0.2
        };
    }
};

export const scanPageText = async (text, settings, onPhraseFound) => {
    const chunks = splitTextForScan(text);
    for (let i = 0; i < chunks.length; i++) {
        await fetchPhrasesStream(chunks[i], settings, onPhraseFound, {
            chunkIndex: i,
            totalChunks: chunks.length
        });
    }
};

export const fetchPhrasesStream = async (text, settings, onPhraseFound, chunkMeta = null) => {
    const prompt = buildScanPrompt(text, settings, true, chunkMeta);

    try {
        const response = await fetch(settings.apiUrl, {
            method: 'POST',
            headers: buildApiHeaders(settings),
            body: JSON.stringify(buildScanRequestBody(settings, prompt, true))
        });

        if (!response.ok) {
            const detail = await readApiErrorDetail(response);
            throw new Error(buildApiErrorMessage(response, settings, detail));
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let accumulatedRawText = '';
        let lineBuffer = '';
        const emittedKeys = new Set();

        const emitSingleItem = (obj) => {
            if (obj && typeof obj === 'object' && obj.phrase) {
                obj.category = normalizeCategory(obj.category);
                const key = `${obj.phrase.toLowerCase().trim()}|||${(obj.sentence || '').trim()}`;
                if (!emittedKeys.has(key)) {
                    emittedKeys.add(key);
                    onPhraseFound(obj);
                }
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            lineBuffer += chunk;

            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                if (trimmed === 'data: [DONE]') continue;

                let jsonStr = trimmed;
                if (trimmed.startsWith('data:')) {
                    jsonStr = trimmed.slice(5).trim();
                }

                try {
                    const json = JSON.parse(jsonStr);
                    let textChunk = '';
                    if (json.response !== undefined) {
                        // Ollama format
                        textChunk = json.response;
                    } else if (json.choices && json.choices.length > 0) {
                        // OpenAI format
                        textChunk = json.choices[0]?.delta?.content || json.choices[0]?.message?.content || '';
                    }

                    if (textChunk) {
                        accumulatedRawText += textChunk;
                        // Attempt progressive object extraction from accumulated text
                        extractObjectsFromText(accumulatedRawText, emitSingleItem);
                    }
                } catch (e) {
                    // Non-JSON line from stream (e.g. comment), skip
                }
            }
        }

        // Final pass on full accumulated text to ensure nothing missed
        if (accumulatedRawText.trim()) {
            parseScanItems(accumulatedRawText).forEach(emitSingleItem);
        }

    } catch (error) {
        console.error("Stream Error:", error);
        throw error;
    }
};

export const fetchPhrases = async (text, settings) => {
    const prompt = buildScanPrompt(text, settings, false);

    try {
        const response = await fetch(settings.apiUrl, {
            method: 'POST',
            headers: buildApiHeaders(settings),
            body: JSON.stringify(buildScanRequestBody(settings, prompt, false))
        });

        if (!response.ok) {
            const detail = await readApiErrorDetail(response);
            throw new Error(buildApiErrorMessage(response, settings, detail));
        }

        const data = await response.json();
        // Ollama 'response', OpenAI 'choices[0].message.content'
        const rawOutput = data.response || (data.choices && data.choices[0]?.message?.content) || "";
        const items = cleanJson(rawOutput);
        const list = Array.isArray(items) ? items : [items];
        return list.map(item => ({ ...item, category: normalizeCategory(item.category) }));

    } catch (error) {
        console.error("LLM Fetch Error:", error);
        throw error;
    }
};

export const explainSelection = async (selection, context, settings) => {
    const languageInstruction = settings.sourceLang === 'auto' || !settings.sourceLang
        ? ""
        : `The source language is ${settings.sourceLang}.`;

    const prompt = `
    Explain the phrase or word "${selection}" in the context of: "${context}".
    Target language for explanation: ${settings.targetLang}. ${languageInstruction}
    IMPORTANT: The "explanation" field MUST be written EXCLUSIVELY in ${settings.targetLang}.
    
    Provide the phonetic transcription, pinyin, or romanization for the phrase in the "phonetic" field. You MUST use the MOST COMMON, learner-friendly phonetic annotation system specific to the detected language.
    For example: Use IPA for English; Pinyin with tone marks for Mandarin Chinese; Jyutping for Cantonese; Romaji for Japanese; Revised Romanization for Korean; and Paiboon system (or similar romanization with tone marks like "sà-wàt-dee kâ") for Thai.
    Do NOT default to IPA or custom English-like pronunciation guides for languages that have established romanization systems.
    
    Return ONLY a JSON object:
    {
       "phrase": "${selection}",
       "phonetic": "phonetic transcription",
       "explanation": "brief explanation",
       "sentence": "${context}"
    }
    `;

    try {
        const isOllama = isOllamaEndpoint(settings);
        const body = isOllama ? {
            model: settings.modelName,
            prompt: prompt,
            stream: false,
            format: "json",
            options: { num_predict: 1024, temperature: 0.2 }
        } : {
            model: settings.modelName,
            messages: [{ role: "user", content: prompt }],
            stream: false,
            max_tokens: 1024,
            temperature: 0.2
        };

        const response = await fetch(settings.apiUrl, {
            method: 'POST',
            headers: buildApiHeaders(settings),
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const detail = await readApiErrorDetail(response);
            throw new Error(buildApiErrorMessage(response, settings, detail));
        }

        const data = await response.json();
        const rawOutput = data.response || (data.choices && data.choices[0]?.message?.content) || "";

        try {
            return cleanJson(rawOutput);
        } catch (e) {
            // Fallback for non-json models or bad output
            console.warn("JSON Parse Error on Explain, using raw text:", e);
            return {
                phrase: selection,
                explanation: rawOutput.replace(/```json/g, '').replace(/```/g, '').trim(),
                sentence: context
            };
        }
    } catch (error) {
        console.error("LLM Explain Error:", error);
        throw error;
    }
};


export const getAnkiDecks = async () => {
    try {
        const response = await fetch('http://127.0.0.1:8765', {
            method: 'POST',
            body: JSON.stringify({
                action: "deckNames",
                version: 6
            })
        });
        const result = await response.json();
        if (result.error) throw new Error(result.error);
        return result.result || ['Default'];
    } catch (error) {
        console.error("Anki Connect Decks Error:", error);
        return ['Default'];
    }
};

const MODEL_NAME = "PhraseDetector";

async function ensureModelExists() {
    try {
        const response = await fetch('http://127.0.0.1:8765', {
            method: 'POST',
            body: JSON.stringify({
                action: "modelNames",
                version: 6
            })
        });
        const result = await response.json();
        if (result.result && result.result.includes(MODEL_NAME)) {
            return true;
        }

        // Create the model
        const createResponse = await fetch('http://127.0.0.1:8765', {
            method: 'POST',
            body: JSON.stringify({
                action: "createModel",
                version: 6,
                params: {
                    modelName: MODEL_NAME,
                    inOrderFields: ["Phrase", "Phonetic", "Explanation", "Sentence"],
                    css: `
                        .card {
                            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                            font-size: 16px;
                            text-align: left;
                            color: #333;
                            background-color: #f8f9fa;
                            padding: 20px;
                        }
                        .pd-card {
                            background: white;
                            background: linear-gradient(120deg, #fdfbf7 0%, #f0f9f4 50%, #e8f5e9 100%);
                            padding: 24px;
                            border-radius: 16px;
                            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
                            border: 1px solid rgba(200, 230, 200, 0.4);
                            max-width: 450px;
                            margin: 20px auto;
                        }
                        .pd-phrase {
                            font-weight: 800;
                            font-size: 26px;
                            color: #2c3e50;
                            letter-spacing: -0.5px;
                            margin-bottom: 8px;
                        }
                        .pd-phonetic {
                            color: #6c757d;
                            font-size: 16px;
                            margin-bottom: 16px;
                            font-family: sans-serif;
                        }
                        .pd-explanation {
                            margin-bottom: 20px;
                            color: #495057;
                            line-height: 1.6;
                            font-size: 16px;
                        }
                        .pd-sentence {
                            color: #6a737d;
                            font-style: italic;
                            font-size: 15px;
                            padding: 12px 16px;
                            background: rgba(255, 255, 255, 0.6);
                            border-radius: 10px;
                            border-left: 4px solid #81c784;
                            line-height: 1.5;
                        }
                        .pd-footer {
                            margin-top: 24px;
                            font-size: 12px;
                            color: #adb5bd;
                            text-align: right;
                            font-weight: 600;
                            text-transform: uppercase;
                            letter-spacing: 1px;
                        }
                        hr {
                            border: 0;
                            border-top: 1px solid rgba(0,0,0,0.06);
                            margin: 20px 0;
                        }
                    `,
                    cardTemplates: [
                        {
                            Name: "Phrase Card",
                            Front: `
                                <div class="pd-card">
                                    <div class="pd-phrase">{{Phrase}}</div>
                                    {{#Phonetic}}
                                    <div class="pd-phonetic">[{{Phonetic}}]</div>
                                    {{/Phonetic}}
                                </div>
                            `,
                            Back: `
                                <div class="pd-card">
                                    <div class="pd-phrase">{{Phrase}}</div>
                                    {{#Phonetic}}
                                    <div class="pd-phonetic">[{{Phonetic}}]</div>
                                    {{/Phonetic}}
                                    <hr>
                                    <div class="pd-explanation">{{Explanation}}</div>
                                    <div class="pd-sentence">{{Sentence}}</div>
                                    <div class="pd-footer">PhraseDetector</div>
                                </div>
                            `
                        }
                    ]
                }
            })
        });
        const createResult = await createResponse.json();
        if (createResult.error) throw new Error(createResult.error);
        return true;
    } catch (error) {
        console.error("Anki Model Creation Error:", error);
        return false;
    }
}

export const addNoteToAnki = async (card, deckName = 'Default') => {
    // 1. Ensure the custom model exists
    await ensureModelExists();

    const fields = {
        Phrase: card.phrase,
        Phonetic: card.phonetic || "",
        Explanation: card.explanation,
        Sentence: card.sentence
    };

    // 2. Check if note already exists to implement "overwrite" behavior
    try {
        const findQuery = `"deck:${deckName}" "note:${MODEL_NAME}" "Phrase:${card.phrase.replace(/"/g, '\\"')}"`;
        const findResponse = await fetch('http://127.0.0.1:8765', {
            method: 'POST',
            body: JSON.stringify({
                action: "findNotes",
                version: 6,
                params: { query: findQuery }
            })
        });
        const findResult = await findResponse.json();
        
        if (findResult.result && findResult.result.length > 0) {
            // Note exists, update its fields
            const noteId = findResult.result[0];
            const updateResponse = await fetch('http://127.0.0.1:8765', {
                method: 'POST',
                body: JSON.stringify({
                    action: "updateNoteFields",
                    version: 6,
                    params: {
                        note: {
                            id: noteId,
                            fields: fields
                        }
                    }
                })
            });
            const updateResult = await updateResponse.json();
            if (updateResult.error) {
                throw new Error(updateResult.error);
            }
            return noteId;
        }
    } catch (e) {
        console.warn("Anki duplicate check/update failed, falling back to addNote:", e);
    }

    // 3. Add new note if it doesn't exist
    const body = {
        action: "addNote",
        version: 6,
        params: {
            note: {
                deckName: deckName,
                modelName: MODEL_NAME,
                fields: fields,
                options: {
                    allowDuplicate: false
                },
                tags: ["PhraseDetector"]
            }
        }
    };

    try {
        const response = await fetch('http://127.0.0.1:8765', {
            method: 'POST',
            body: JSON.stringify(body)
        });
        const result = await response.json();
        if (result.error) {
            throw new Error(result.error);
        }
        return result.result;
    } catch (error) {
        console.error("Anki Connect Error:", error);
        throw error;
    }
};

export const chatWithAI = async (messages, settings) => {
    const isOllama = isOllamaEndpoint(settings);
    let body;

    if (isOllama) {
        let prompt = "";
        messages.forEach(m => {
            prompt += `${m.role}: ${m.content}\n`;
        });
        prompt += "assistant: ";
        body = {
            model: settings.modelName,
            prompt: prompt,
            stream: false
        };
    } else {
        body = {
            model: settings.modelName,
            messages: messages,
            stream: false
        };
    }

    try {
        const response = await fetch(settings.apiUrl, {
            method: 'POST',
            headers: buildApiHeaders(settings),
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const detail = await readApiErrorDetail(response);
            throw new Error(buildApiErrorMessage(response, settings, detail));
        }

        const data = await response.json();
        return data.response || (data.choices && data.choices[0]?.message?.content) || "";

    } catch (error) {
        console.error("Chat Error:", error);
        throw error;
    }
};

export const generateStory = async (favorites, settings) => {
    const phrasesList = favorites.map(f => `"${f.phrase}"`).join(', ');
    const prompt = `
    Create a short, engaging story (150-250 words) that naturally incorporates the following phrases in everyday life scenarios:
    ${phrasesList}
    
    Requirements:
    1. Use ALL the phrases naturally in the story - each phrase must appear at least once
    2. Create a realistic everyday life scenario (e.g., work, school, family, friendship, daily activities)
    3. Make the story interesting, humorous, or thought-provoking with a meaningful message
    4. Keep it concise and focused - not too long
    5. Write in the same language as the phrases
    6. The story should help readers understand how to use these phrases in different real-world contexts
    
    Return ONLY the story text, no title, no additional explanation, no formatting. Just the story content.
    `;

    try {
        const isOllama = isOllamaEndpoint(settings);
        const body = isOllama ? {
            model: settings.modelName,
            prompt: prompt,
            stream: false
        } : {
            model: settings.modelName,
            messages: [{ role: "user", content: prompt }],
            stream: false
        };

        const response = await fetch(settings.apiUrl, {
            method: 'POST',
            headers: buildApiHeaders(settings),
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const detail = await readApiErrorDetail(response);
            throw new Error(buildApiErrorMessage(response, settings, detail));
        }

        const data = await response.json();
        return data.response || (data.choices && data.choices[0]?.message?.content) || "";

    } catch (error) {
        console.error("Generate Story Error:", error);
        throw error;
    }
};