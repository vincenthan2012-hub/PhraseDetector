import { getSettings, getFavorites, removeFavorites } from '../utils/storage.js';
import { addNoteToAnki, getAnkiDecks, generateStory } from '../utils/api.js';

let selectedFavorites = new Set();
let allFavorites = [];
let dateSortOrder = 'desc'; // 'asc' or 'desc'
let phraseSortOrder = 'asc'; // 'asc' or 'desc'
let currentSortBy = 'date'; // 'date' or 'phrase'

let categoryFilter = 'all'; // 'all' | 'powerword' | 'phrase' | 'structure'

const CATEGORY_LABELS = {
    all: 'All',
    powerword: 'Power Word',
    phrase: 'Phrase',
    structure: 'Structure'
};

let pendingAnkiCard = null;
let pendingAnkiBtn = null;
let isBatchExport = false;
let batchSelectedIndices = [];

const favoritesEls = {
    selectAll: document.getElementById('selectAllFavorites'),
    selectAllText: document.getElementById('selectAllText'),
    tableSelectAll: document.getElementById('tableSelectAll'),
    tableBody: document.getElementById('favoritesTableBody'),
    exportAnkiBtn: document.getElementById('exportAnkiBtn'),
    exportCsvBtn: document.getElementById('exportCsvBtn'),
    deleteSelectedBtn: document.getElementById('deleteSelectedBtn'),
    generateStoryBtn: document.getElementById('generateStoryBtn'),
    dateHeader: document.getElementById('dateHeader'),
    phraseHeader: document.getElementById('phraseHeader'),
    categoryFilterSelect: document.getElementById('categoryFilterSelect'),
    phraseSortBtn: document.getElementById('phraseSortBtn'),
    ankiModal: document.getElementById('ankiModal'),
    ankiDeckSelect: document.getElementById('ankiDeckSelect'),
    ankiCancel: document.getElementById('ankiCancel'),
    ankiConfirm: document.getElementById('ankiConfirm'),
    storyModal: document.getElementById('storyModal'),
    storyText: document.getElementById('storyText'),
    storyModalClose: document.getElementById('storyModalClose'),
    closeStoryBtn: document.getElementById('closeStoryBtn'),
    copyStoryBtn: document.getElementById('copyStoryBtn')
};

function broadcastMessage(message) {
    if (chrome && chrome.tabs) {
        chrome.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, message).catch(() => { });
            });
        });
    }
}

async function loadFavorites() {
    allFavorites = await getFavorites();
    selectedFavorites.clear();
    renderFavoritesTable();
    updateSelectAllState();
}

function getFavoriteCategory(fav) {
    return fav.category || 'phrase';
}

function getFilteredFavorites() {
    return allFavorites
        .map((fav, index) => ({ fav, index }))
        .filter(({ fav }) => categoryFilter === 'all' || getFavoriteCategory(fav) === categoryFilter);
}

function renderFavoritesTable() {
    if (!favoritesEls.tableBody) return;

    const filtered = getFilteredFavorites();

    if (allFavorites.length === 0) {
        favoritesEls.tableBody.innerHTML = `
            <tr>
                <td colspan="6" class="empty-state">
                    No saved expressions yet. Add favorites from the popup!
                </td>
            </tr>
        `;
        return;
    }

    if (filtered.length === 0) {
        favoritesEls.tableBody.innerHTML = `
            <tr>
                <td colspan="6" class="empty-state">
                    No saved expressions in "${CATEGORY_LABELS[categoryFilter] || categoryFilter}".
                </td>
            </tr>
        `;
        return;
    }

    // Sort by current sort column
    const sorted = [...filtered].sort((a, b) => {
        if (currentSortBy === 'date') {
            const dateA = new Date(a.fav.date);
            const dateB = new Date(b.fav.date);
            return dateSortOrder === 'desc' ? dateB - dateA : dateA - dateB;
        } else if (currentSortBy === 'phrase') {
            const phraseA = a.fav.phrase.toLowerCase();
            const phraseB = b.fav.phrase.toLowerCase();
            if (phraseSortOrder === 'asc') {
                return phraseA.localeCompare(phraseB);
            } else {
                return phraseB.localeCompare(phraseA);
            }
        }
        return 0;
    });

    favoritesEls.tableBody.innerHTML = sorted.map(({ fav, index: originalIndex }) => {
        const isSelected = selectedFavorites.has(originalIndex);
        const sourceDisplay = fav.source ? (fav.source.length > 50 ? fav.source.substring(0, 50) + '...' : fav.source) : '-';
        const sentenceDisplay = fav.sentence.length > 100 ? fav.sentence.substring(0, 100) + '...' : fav.sentence;
        
        return `
            <tr data-index="${originalIndex}">
                <td>
                    <input type="checkbox" class="favorite-checkbox" data-index="${originalIndex}" ${isSelected ? 'checked' : ''}>
                </td>
                <td>
                    <a href="${fav.source || '#'}" target="_blank" class="source-link" title="${fav.source || ''}">
                        ${sourceDisplay}
                    </a>
                </td>
                <td class="phrase-cell">${escapeHtml(fav.phrase)}</td>
                <td class="sentence-cell" title="${escapeHtml(fav.sentence)}">${escapeHtml(sentenceDisplay)}</td>
                <td class="date-cell">${fav.date}</td>
                <td>
                    <div class="action-buttons-cell">
                        <button class="action-icon-btn add-anki-btn" data-index="${originalIndex}" title="Add to Anki">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 5V19"></path>
                                <path d="M5 12H19"></path>
                            </svg>
                        </button>
                        <button class="action-icon-btn delete-btn" data-index="${originalIndex}" title="Delete">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    // Attach event listeners
    document.querySelectorAll('.favorite-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const index = parseInt(e.target.dataset.index);
            if (e.target.checked) {
                selectedFavorites.add(index);
            } else {
                selectedFavorites.delete(index);
            }
            updateSelectAllState();
        });
    });

    document.querySelectorAll('.add-anki-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const index = parseInt(e.target.closest('.add-anki-btn').dataset.index);
            await handleFavoriteAnki(index);
        });
    });

    document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const index = parseInt(e.target.closest('.delete-btn').dataset.index);
            if (confirm('Delete this favorite?')) {
                const fav = allFavorites[index];
                await removeFavorites([index]);
                
                // Broadcast to remove highlight
                if (fav) {
                    broadcastMessage({
                        action: 'REMOVE_HIGHLIGHT',
                        phrase: fav.phrase,
                        sentence: fav.sentence
                    });
                }
                
                await loadFavorites();
            }
        });
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function updateSelectAllState() {
    const visible = getFilteredFavorites();
    const total = visible.length;
    const selected = visible.filter(({ index }) => selectedFavorites.has(index)).length;
    
    if (favoritesEls.selectAllText) {
        favoritesEls.selectAllText.textContent = `Select All (${selected}/${total})`;
    }
    
    const allChecked = total > 0 && selected === total;
    if (favoritesEls.selectAll) {
        favoritesEls.selectAll.checked = allChecked;
    }
    if (favoritesEls.tableSelectAll) {
        favoritesEls.tableSelectAll.checked = allChecked;
    }
}

if (favoritesEls.selectAll) {
    favoritesEls.selectAll.addEventListener('change', (e) => {
        if (e.target.checked) {
            getFilteredFavorites().forEach(({ index }) => selectedFavorites.add(index));
        } else {
            getFilteredFavorites().forEach(({ index }) => selectedFavorites.delete(index));
        }
        renderFavoritesTable();
        updateSelectAllState();
    });
}

if (favoritesEls.tableSelectAll) {
    favoritesEls.tableSelectAll.addEventListener('change', (e) => {
        if (e.target.checked) {
            getFilteredFavorites().forEach(({ index }) => selectedFavorites.add(index));
        } else {
            getFilteredFavorites().forEach(({ index }) => selectedFavorites.delete(index));
        }
        renderFavoritesTable();
        updateSelectAllState();
    });
}

if (favoritesEls.dateHeader) {
    favoritesEls.dateHeader.addEventListener('click', () => {
        if (currentSortBy === 'date') {
            dateSortOrder = dateSortOrder === 'desc' ? 'asc' : 'desc';
        } else {
            currentSortBy = 'date';
            dateSortOrder = 'desc';
        }
        const icon = favoritesEls.dateHeader.querySelector('.sort-icon');
        if (icon) {
            icon.style.transform = dateSortOrder === 'asc' ? 'rotate(180deg)' : 'rotate(0deg)';
        }
        // Reset phrase header icon
        if (favoritesEls.phraseSortBtn) {
            const phraseIcon = favoritesEls.phraseSortBtn.querySelector('.sort-icon');
            if (phraseIcon) {
                phraseIcon.style.transform = 'rotate(0deg)';
            }
        }
        renderFavoritesTable();
    });
}

if (favoritesEls.categoryFilterSelect) {
    favoritesEls.categoryFilterSelect.addEventListener('change', (e) => {
        categoryFilter = e.target.value;
        renderFavoritesTable();
        updateSelectAllState();
    });
}

if (favoritesEls.phraseSortBtn) {
    favoritesEls.phraseSortBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (currentSortBy === 'phrase') {
            phraseSortOrder = phraseSortOrder === 'asc' ? 'desc' : 'asc';
        } else {
            currentSortBy = 'phrase';
            phraseSortOrder = 'asc';
        }
        const icon = favoritesEls.phraseSortBtn.querySelector('.sort-icon');
        if (icon) {
            icon.style.transform = phraseSortOrder === 'asc' ? 'rotate(180deg)' : 'rotate(0deg)';
        }
        if (favoritesEls.dateHeader) {
            const dateIcon = favoritesEls.dateHeader.querySelector('.sort-icon');
            if (dateIcon) {
                dateIcon.style.transform = 'rotate(0deg)';
            }
        }
        renderFavoritesTable();
    });
}

async function handleFavoriteAnki(index) {
    const favorite = allFavorites[index];
    if (!favorite) return;

    pendingAnkiCard = {
        phrase: favorite.phrase,
        phonetic: favorite.phonetic || '',
        explanation: favorite.explanation,
        sentence: favorite.sentence
    };
    pendingAnkiBtn = document.querySelector(`.add-anki-btn[data-index="${index}"]`);

    // Load Decks
    try {
        const decks = await getAnkiDecks();
        favoritesEls.ankiDeckSelect.innerHTML = decks.map(d => `<option value="${d}">${d}</option>`).join('');
        
        // Show Modal
        favoritesEls.ankiModal.classList.add('visible');
    } catch (e) {
        alert("Anki Error: " + e.message + "\nEnsure Anki is open and AnkiConnect installed.");
    }
}

// Anki Modal Handlers
if (favoritesEls.ankiCancel) {
    favoritesEls.ankiCancel.addEventListener('click', () => {
        favoritesEls.ankiModal.classList.remove('visible');
        pendingAnkiCard = null;
        pendingAnkiBtn = null;
        isBatchExport = false;
        batchSelectedIndices = [];
    });
}

if (favoritesEls.ankiConfirm) {
    favoritesEls.ankiConfirm.addEventListener('click', async () => {
        const deck = favoritesEls.ankiDeckSelect.value || 'Default';
        favoritesEls.ankiModal.classList.remove('visible');

        if (isBatchExport) {
            // Batch export
            favoritesEls.exportAnkiBtn.disabled = true;
            const originalText = favoritesEls.exportAnkiBtn.innerHTML;
            favoritesEls.exportAnkiBtn.innerHTML = 'Exporting...';

            try {
                for (const index of batchSelectedIndices) {
                    const favorite = allFavorites[index];
                    const card = {
                        phrase: favorite.phrase,
                        phonetic: favorite.phonetic || '',
                        explanation: favorite.explanation,
                        sentence: favorite.sentence
                    };
                    await addNoteToAnki(card, deck);
                }
                alert(`Successfully exported ${batchSelectedIndices.length} card(s) to Anki!`);
            } catch (e) {
                alert("Anki Error: " + e.message + "\nEnsure Anki is open and AnkiConnect installed.");
            }
            
            favoritesEls.exportAnkiBtn.disabled = false;
            favoritesEls.exportAnkiBtn.innerHTML = originalText;
            isBatchExport = false;
            batchSelectedIndices = [];
        } else {
            // Single export
            if (!pendingAnkiCard) return;

            if (pendingAnkiBtn) {
                pendingAnkiBtn.disabled = true;
                pendingAnkiBtn.style.opacity = '0.6';
            }

            try {
                await addNoteToAnki(pendingAnkiCard, deck);
                if (pendingAnkiBtn) {
                    pendingAnkiBtn.innerHTML = '✓';
                    pendingAnkiBtn.style.background = '#d4edda';
                    setTimeout(() => {
                        if (pendingAnkiBtn) {
                            pendingAnkiBtn.innerHTML = `
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M12 5V19"></path>
                                    <path d="M5 12H19"></path>
                                </svg>
                            `;
                            pendingAnkiBtn.style.background = '#28a745';
                            pendingAnkiBtn.disabled = false;
                            pendingAnkiBtn.style.opacity = '1';
                        }
                    }, 2000);
                }
            } catch (e) {
                alert("Anki Error: " + e.message + "\nEnsure Anki is open and AnkiConnect installed.");
                if (pendingAnkiBtn) {
                    pendingAnkiBtn.disabled = false;
                    pendingAnkiBtn.style.opacity = '1';
                }
            }
            pendingAnkiCard = null;
            pendingAnkiBtn = null;
        }
    });
}

if (favoritesEls.exportAnkiBtn) {
    favoritesEls.exportAnkiBtn.addEventListener('click', async () => {
        const selected = Array.from(selectedFavorites).sort((a, b) => a - b);
        if (selected.length === 0) {
            alert('Please select at least one favorite to export.');
            return;
        }

        try {
            const decks = await getAnkiDecks();
            favoritesEls.ankiDeckSelect.innerHTML = decks.map(d => `<option value="${d}">${d}</option>`).join('');
            
            // Set batch export mode
            isBatchExport = true;
            batchSelectedIndices = selected;
            favoritesEls.ankiModal.classList.add('visible');
        } catch (e) {
            alert("Anki Error: " + e.message + "\nEnsure Anki is open and AnkiConnect installed.");
        }
    });
}

if (favoritesEls.exportCsvBtn) {
    favoritesEls.exportCsvBtn.addEventListener('click', () => {
        const selected = Array.from(selectedFavorites).sort((a, b) => a - b);
        if (selected.length === 0) {
            alert('Please select at least one favorite to export.');
            return;
        }

        const csvRows = ['Source,Phrase,Phonetic,Sentence,Date,Explanation'];
        selected.forEach(index => {
            const fav = allFavorites[index];
            const row = [
                `"${(fav.source || '').replace(/"/g, '""')}"`,
                `"${fav.phrase.replace(/"/g, '""')}"`,
                `"${(fav.phonetic || '').replace(/"/g, '""')}"`,
                `"${fav.sentence.replace(/"/g, '""')}"`,
                `"${fav.date}"`,
                `"${(fav.explanation || '').replace(/"/g, '""')}"`
            ];
            csvRows.push(row.join(','));
        });

        const csv = csvRows.join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', `phrases_${new Date().toISOString().split('T')[0]}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });
}

if (favoritesEls.deleteSelectedBtn) {
    favoritesEls.deleteSelectedBtn.addEventListener('click', async () => {
        const selected = Array.from(selectedFavorites).sort((a, b) => b - a);
        if (selected.length === 0) {
            alert('Please select at least one favorite to delete.');
            return;
        }

        if (confirm(`Delete ${selected.length} selected favorite(s)?`)) {
            const favsToRemove = selected.map(i => allFavorites[i]);
            await removeFavorites(selected);
            
            // Broadcast removal for each
            favsToRemove.forEach(fav => {
                if (fav) {
                    broadcastMessage({
                        action: 'REMOVE_HIGHLIGHT',
                        phrase: fav.phrase,
                        sentence: fav.sentence
                    });
                }
            });
            
            selectedFavorites.clear();
            await loadFavorites();
        }
    });
}

// Highlight phrases in story text
function highlightPhrasesInStory(story, phrases) {
    let highlightedStory = escapeHtml(story);
    
    // Sort phrases by length (longest first) to avoid partial matches
    const sortedPhrases = [...phrases].sort((a, b) => b.phrase.length - a.phrase.length);
    
    sortedPhrases.forEach(fav => {
        const phrase = escapeHtml(fav.phrase);
        // Use case-insensitive regex to find and highlight phrases
        const regex = new RegExp(`(${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        highlightedStory = highlightedStory.replace(regex, (match) => {
            return `<span class="story-phrase-highlight">${match}</span>`;
        });
    });
    
    return highlightedStory;
}

if (favoritesEls.generateStoryBtn) {
    favoritesEls.generateStoryBtn.addEventListener('click', async () => {
        const selected = Array.from(selectedFavorites).sort((a, b) => a - b);
        if (selected.length === 0) {
            alert('Please select at least one favorite to generate a story.');
            return;
        }

        const selectedFavoritesData = selected.map(index => allFavorites[index]);
        
        try {
            const settings = await getSettings();
            if (!settings.modelName || !settings.apiUrl) {
                alert('Please configure AI settings first.');
                return;
            }

            const originalBtnContent = favoritesEls.generateStoryBtn.innerHTML;
            favoritesEls.generateStoryBtn.disabled = true;
            favoritesEls.generateStoryBtn.innerHTML = 'Generating...';

            const story = await generateStory(selectedFavoritesData, settings);
            
            // Highlight phrases in the story
            const highlightedStory = highlightPhrasesInStory(story, selectedFavoritesData);
            
            // Show story in modal
            favoritesEls.storyText.innerHTML = highlightedStory;
            favoritesEls.storyModal.classList.add('visible');

            favoritesEls.generateStoryBtn.disabled = false;
            favoritesEls.generateStoryBtn.innerHTML = originalBtnContent;
        } catch (e) {
            alert('Error generating story: ' + e.message);
            favoritesEls.generateStoryBtn.disabled = false;
            favoritesEls.generateStoryBtn.innerHTML = originalBtnContent;
        }
    });
}

// Story modal event handlers
if (favoritesEls.storyModalClose) {
    favoritesEls.storyModalClose.addEventListener('click', () => {
        favoritesEls.storyModal.classList.remove('visible');
    });
}

if (favoritesEls.closeStoryBtn) {
    favoritesEls.closeStoryBtn.addEventListener('click', () => {
        favoritesEls.storyModal.classList.remove('visible');
    });
}

if (favoritesEls.copyStoryBtn) {
    favoritesEls.copyStoryBtn.addEventListener('click', () => {
        const storyText = favoritesEls.storyText.textContent || favoritesEls.storyText.innerText;
        navigator.clipboard.writeText(storyText).then(() => {
            const originalText = favoritesEls.copyStoryBtn.textContent;
            favoritesEls.copyStoryBtn.textContent = 'Copied!';
            setTimeout(() => {
                favoritesEls.copyStoryBtn.textContent = originalText;
            }, 2000);
        });
    });
}

// Close modal when clicking outside
if (favoritesEls.storyModal) {
    favoritesEls.storyModal.addEventListener('click', (e) => {
        if (e.target === favoritesEls.storyModal) {
            favoritesEls.storyModal.classList.remove('visible');
        }
    });
}

// Listen for storage changes to update favorites
chrome.storage.onChanged.addListener((changes) => {
    if (changes.pd_favorites) {
        loadFavorites();
    }
});

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    loadFavorites();
});

