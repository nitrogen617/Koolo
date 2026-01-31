// NIP Editor UI
let allRules = [];
let filteredRules = [];
let currentPickitPath = '';
let currentLoadedFile = '';
let activeQuality = 'All';
let activeType = 'All';
let searchTerm = '';
let filterStatusMode = 0; // 0: all, 1: enabled, 2: disabled
let filterEthereal = false;
let filterUnidentify = false;
let showComments = true;
let filterFavorites = false;
let favoritesMode = false;
let editingRuleId = '';
let favorites = new Set();
let itemTypeByName = new Map();
let setItemByName = new Map();
let setItemByBase = new Map();
let itemMappingsPromise = null;
let ruleById = new Map();
let suppressValueClick = false;
let uniqueNameByBase = new Map();
let rulesSortable = null;
let qualitySortable = null;
let typeSortable = null;
let typeSortMode = 0; // 0: name asc, 1: name desc, 2: count desc, 3: count asc
let ruleSortMode = 1; // 0: default, 1: A-Z, 2: Z-A
const recentStorageKey = 'pickitRecentRules';
let recentRuleMap = loadRecentRuleMap();

const qualityLabels = {
    base: 'Base',
    normal: 'Normal',
    magic: 'Magic',
    rare: 'Rare',
    crafted: 'Crafted',
    set: 'Set',
    unique: 'Unique',
    superior: 'Superior',
    misc: 'Misc',
    charm: 'Charm',
    favorites: 'Favorites'
};

const qualityGroupMap = new Map([
    ['normal', 'base'],
    ['superior', 'base'],
    ['base', 'base'],
]);

function loadRecentRuleMap() {
    const raw = localStorage.getItem(recentStorageKey);
    if (!raw) {
        return new Map();
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return new Map();
        }
        return new Map(Object.entries(parsed).map(([id, ts]) => [id, Number(ts) || 0]));
    } catch (error) {
        return new Map();
    }
}

function saveRecentRuleMap(map) {
    const obj = {};
    map.forEach((value, key) => {
        obj[key] = value;
    });
    localStorage.setItem(recentStorageKey, JSON.stringify(obj));
}

function markRuleRecent(ruleId) {
    const now = Date.now();
    recentRuleMap.set(ruleId, now);
    if (recentRuleMap.size > 200) {
        const ordered = Array.from(recentRuleMap.entries()).sort((a, b) => b[1] - a[1]);
        recentRuleMap = new Map(ordered.slice(0, 200));
    }
    saveRecentRuleMap(recentRuleMap);
}

function getRecentRules(limit) {
    const list = allRules
        .map(rule => ({ rule, ts: recentRuleMap.get(rule.id) || 0 }))
        .filter(entry => entry.ts > 0)
        .sort((a, b) => b.ts - a.ts);
    const capped = typeof limit === 'number' ? list.slice(0, limit) : list;
    return capped.map(entry => entry.rule);
}

const nameAliasMap = new Map([
    ['sabre', 'saber'],
]);

const typeGroupMap = new Map([
    ['assassinclaw', 'claw'],
    ['claw', 'claw'],
    ['jewel', 'jewel'],
    ['throwing', 'throwing'],
    ['throwingweapon', 'throwing'],
    ['thrownweapon', 'throwing'],
    ['voodoohead', 'shield'],
    ['voodooheads', 'shield'],
    ['necrohelm', 'shield'],
    ['necrohead', 'shield'],
    ['necroheads', 'shield'],
    ['necroshield', 'shield'],
    ['head', 'shield'],
    ['auricshield', 'shield'],
    ['auricshields', 'shield'],
    ['shield', 'shield'],
    ['crossbow', 'amazonweapon'],
    ['bow', 'amazonweapon'],
    ['amazonbow', 'amazonweapon'],
    ['amazonjavelin', 'amazonweapon'],
    ['javelin', 'amazonweapon'],
    ['amazonspear', 'amazonweapon'],
    ['polearm', 'spear'],
    ['spear', 'spear'],
    ['dagger', 'dagger'],
    ['knife', 'dagger'],
    ['hammer', 'mace'],
    ['mace', 'mace'],
    ['scepter', 'mace'],
    ['sorcorb', 'staff'],
    ['orb', 'staff'],
    ['staff', 'staff'],
    ['wand', 'staff'],
    ['helm', 'helm'],
    ['primalhelm', 'helm'],
    ['barbhelm', 'helm'],
    ['druidhelm', 'helm'],
    ['druidpelt', 'helm'],
    ['pelt', 'helm'],
]);

const miscTypes = new Set(['gem', 'rune', 'misc']);
const charmTypes = new Set(['grandcharm', 'smallcharm', 'sunder', 'annihilus', 'torch', 'gheeds', 'charm']);
const uniqueCharmGroupTypes = new Set(['gheeds', 'sunder', 'annihilus', 'torch']);
const typeLabelOverrides = new Map([
    ['grandcharm', 'Grand Charm'],
    ['smallcharm', 'Small Charm'],
    ['annihilus', 'Annihilus Charm'],
    ['sunder', 'Sunder'],
    ['torch', 'Torch'],
    ['gheeds', "Gheed's Fortune"],
    ['spear', 'Spear & Polearm'],
    ['mace', 'Mace & Scepter'],
    ['charm', 'Charm'],
]);

const uniqueCharmNameTypeMap = new Map([
    ['gheedsfortune', 'gheeds'],
    ['thecrackoftheheavens', 'sunder'],
    ['thecoldrupture', 'sunder'],
    ['theflamerift', 'sunder'],
    ['theblackcleft', 'sunder'],
    ['thebonebreak', 'sunder'],
    ['therottingfissure', 'sunder'],
]);

const baseViewport = {
    width: 1040,
    height: 720,
    minScale: 0.7,
};

window.addEventListener('DOMContentLoaded', () => {
    applyViewportScale();
    window.addEventListener('resize', applyViewportScale);

    const savedPath = localStorage.getItem('pickitPath');
    if (savedPath) {
        currentPickitPath = savedPath;
        loadCharacterFiles();
    }

    favorites = new Set(JSON.parse(localStorage.getItem('nipFavorites') || '[]'));

    bindUI();
    loadItemMappings();
});

function applyViewportScale() {
    const scaleX = window.innerWidth / baseViewport.width;
    const scaleY = window.innerHeight / baseViewport.height;
    const rawScale = Math.min(scaleX, scaleY, 1);
    const clamped = Math.max(baseViewport.minScale, rawScale);
    const useZoom = typeof document.body.style.zoom !== 'undefined';
    if (useZoom) {
        document.body.style.zoom = clamped.toFixed(3);
        document.documentElement.style.setProperty('--ui-scale', '1');
    } else {
        document.documentElement.style.setProperty('--ui-scale', clamped.toFixed(3));
    }
    if (clamped < 1) {
        document.documentElement.classList.add('ui-scaled');
    } else {
        document.documentElement.classList.remove('ui-scaled');
    }
}

function bindUI() {
    const searchInput = document.getElementById('globalSearch');
    const clearSearch = document.getElementById('clearSearch');

    if (searchInput) {
        searchInput.addEventListener('input', () => {
            searchTerm = searchInput.value.trim().toLowerCase();
            applyFilters();
        });
    }

    if (clearSearch) {
        clearSearch.addEventListener('click', () => {
            clearSearchState();
            applyFilters();
        });
    }

    const statusChip = document.getElementById('filterStatus');
    const etherealChip = document.getElementById('filterEthereal');
    const unidentifyChip = document.getElementById('filterUnidentify');
    const commentsChip = document.getElementById('filterComments');
    const favoritesChip = document.getElementById('filterFavorites');
    const typeSortToggle = document.getElementById('typeSortToggle');
    const ruleSortToggle = document.getElementById('ruleSortToggle');

    if (statusChip) {
        statusChip.addEventListener('click', () => {
            clearSearchState();
            filterStatusMode = (filterStatusMode + 1) % 3;
            if (filterStatusMode === 0) {
                statusChip.textContent = 'All';
            } else if (filterStatusMode === 1) {
                statusChip.textContent = 'Enabled';
            } else {
                statusChip.textContent = 'Disabled';
            }
            applyFilters();
        });
    }

    if (etherealChip) {
        etherealChip.addEventListener('click', () => {
            clearSearchState();
            filterEthereal = !filterEthereal;
            etherealChip.classList.toggle('active', filterEthereal);
            applyFilters();
        });
    }

    if (unidentifyChip) {
        unidentifyChip.addEventListener('click', () => {
            clearSearchState();
            filterUnidentify = !filterUnidentify;
            unidentifyChip.classList.toggle('active', filterUnidentify);
            applyFilters();
        });
    }

    if (commentsChip) {
        commentsChip.addEventListener('click', () => {
            clearSearchState();
            showComments = !showComments;
            commentsChip.classList.toggle('active', showComments);
            renderRules();
        });
    }

    if (favoritesChip) {
        favoritesChip.addEventListener('click', () => {
            clearSearchState();
            filterFavorites = !filterFavorites;
            favoritesChip.classList.toggle('active', filterFavorites);
            applyFilters();
        });
    }

    if (typeSortToggle) {
        typeSortToggle.addEventListener('click', () => {
            typeSortMode = (typeSortMode + 1) % 4;
            updateTypeSortToggle(typeSortToggle);
            buildFilters();
            applyFilters();
        });
        updateTypeSortToggle(typeSortToggle);
    }

    if (ruleSortToggle) {
        ruleSortToggle.addEventListener('click', () => {
            ruleSortMode = (ruleSortMode + 1) % 3;
            updateRuleSortToggle(ruleSortToggle);
            applyFilters();
        });
        updateRuleSortToggle(ruleSortToggle);
    }

    const rulesList = document.getElementById('rulesList');
    if (rulesList) {
        rulesList.addEventListener('pointerdown', handleRuleListPointerDown);
        rulesList.addEventListener('click', handleRuleListClick);
    }
}

function resetFilterToggles() {
    filterStatusMode = 0;
    filterEthereal = false;
    filterUnidentify = false;
    filterFavorites = false;
    showComments = true;

    const statusChip = document.getElementById('filterStatus');
    if (statusChip) {
        statusChip.textContent = 'All';
    }

    const etherealChip = document.getElementById('filterEthereal');
    if (etherealChip) {
        etherealChip.classList.toggle('active', false);
    }

    const unidentifyChip = document.getElementById('filterUnidentify');
    if (unidentifyChip) {
        unidentifyChip.classList.toggle('active', false);
    }

    const favoritesChip = document.getElementById('filterFavorites');
    if (favoritesChip) {
        favoritesChip.classList.toggle('active', false);
    }

    const commentsChip = document.getElementById('filterComments');
    if (commentsChip) {
        commentsChip.classList.toggle('active', true);
    }
}

function updateTypeSortToggle(button) {
    if (!button) {
        return;
    }
    const labels = ['A→Z', 'Z→A', 'Most', 'Least'];
    button.textContent = labels[typeSortMode] || 'Sort';
}

function updateRuleSortToggle(button) {
    if (!button) {
        return;
    }
    const labels = ['All', 'A→Z', 'Z→A'];
    button.textContent = labels[ruleSortMode] || 'All';
}

function clearSearchState() {
    if (!searchTerm) {
        return;
    }
    searchTerm = '';
    const searchInput = document.getElementById('globalSearch');
    if (searchInput) {
        searchInput.value = '';
    }
}

function handleRuleListPointerDown(event) {
    const valueChip = event.target.closest('.value-chip');
    if (!valueChip) {
        return;
    }
    suppressValueClick = true;
    enterValueEdit(valueChip);
    event.preventDefault();
    event.stopPropagation();
}

function handleRuleListClick(event) {
    if (suppressValueClick) {
        suppressValueClick = false;
        return;
    }
    const valueChip = event.target.closest('.value-chip');
    if (valueChip) {
        enterValueEdit(valueChip);
        return;
    }

    const toggle = event.target.closest('.toggle');
    if (toggle) {
        toggleRule(toggle.dataset.ruleId);
        return;
    }

    const favoriteBtn = event.target.closest('[data-action="favorite"]');
    if (favoriteBtn) {
        toggleFavorite(favoriteBtn.dataset.ruleId);
        return;
    }

    const etherealBtn = event.target.closest('[data-action="toggle-ethereal"]');
    if (etherealBtn) {
        toggleRuleEthereal(etherealBtn.dataset.ruleId);
        return;
    }

    const commentBtn = event.target.closest('[data-action="comment"]');
    if (commentBtn) {
        editRuleComment(commentBtn.dataset.ruleId);
        return;
    }

    const editBtn = event.target.closest('[data-action="edit"]');
    if (editBtn) {
        openRuleEditModal(editBtn.dataset.ruleId);
        return;
    }

    const deleteBtn = event.target.closest('[data-action="delete"]');
    if (deleteBtn) {
        deleteRule(deleteBtn.dataset.ruleId);
    }
}

function showFileConfigModal() {
    const modal = document.getElementById('fileConfigModal');
    modal.classList.add('active');

    const savedPath = localStorage.getItem('pickitPath');
    if (savedPath) {
        document.getElementById('pickitPath').value = savedPath;
    }
}

function closeFileConfigModal() {
    const modal = document.getElementById('fileConfigModal');
    modal.classList.remove('active');
}

async function browseFolder() {
    try {
        const response = await fetch('/api/pickit/browse-folder', { method: 'POST' });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        if (data.error) {
            showToast('Failed to select folder: ' + data.error);
            return;
        }
        if (data.cancelled) {
            return;
        }

        if (data.path) {
            document.getElementById('pickitPath').value = data.path;
            await scanForFiles();
        } else {
            showToast('No folder selected.');
        }
    } catch (error) {
        showToast('Failed to browse folders: ' + error.message);
    }
}

async function scanForFiles() {
    const pickitPath = document.getElementById('pickitPath').value.trim();
    if (!pickitPath) {
        showToast('Please enter a Pickit path.');
        return;
    }

    try {
        const response = await fetch(`/api/pickit/files?path=${encodeURIComponent(pickitPath)}`);
        if (!response.ok) {
            throw new Error('Failed to load file list.');
        }

        const files = await response.json();
        const filesList = document.getElementById('foundFiles');
        if (files && files.length > 0) {
            filesList.innerHTML = files
                .map(file => `<div class="file-item">${escapeHtml(file.name || file)}</div>`)
                .join('');
        } else {
            filesList.innerHTML = '<div class="file-item">No .nip files found.</div>';
        }
    } catch (error) {
        showToast('Scan failed: ' + error.message);
    }
}

function saveFileConfig() {
    const pickitPath = document.getElementById('pickitPath').value.trim();
    if (!pickitPath) {
        showToast('Please enter a Pickit path.');
        return;
    }

    currentPickitPath = pickitPath;
    localStorage.setItem('pickitPath', pickitPath);
    closeFileConfigModal();
    loadCharacterFiles();
}

async function loadCharacterFiles() {
    if (!currentPickitPath) {
        return;
    }

    try {
        const response = await fetch(`/api/pickit/files?path=${encodeURIComponent(currentPickitPath)}`);
        if (!response.ok) {
            throw new Error('Failed to load file list.');
        }

        const files = await response.json();
        const select = document.getElementById('pickitFile');
        select.innerHTML = '';

        if (files && files.length > 0) {
            select.innerHTML = files
                .map(file => {
                    const name = file.name || file;
                    return `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
                })
                .join('');
            currentLoadedFile = select.value;
            await loadPickitFile();
        } else {
            select.innerHTML = '<option value="">No files</option>';
        }
    } catch (error) {
        showToast('Failed to load file list: ' + error.message);
    }
}

async function loadPickitFile() {
    const fileName = document.getElementById('pickitFile').value;
    if (!fileName) {
        showToast('Please select a file.');
        return;
    }
    if (!currentPickitPath) {
        showToast('Please select a Pickit folder first.');
        return;
    }

    try {
        await loadItemMappings();
        const response = await fetch(`/api/pickit/files?path=${encodeURIComponent(currentPickitPath)}&file=${encodeURIComponent(fileName)}`);
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || 'Failed to load file.');
        }

        const rules = await response.json();
        currentLoadedFile = fileName;
        allRules = rules.map(normalizeRule).filter(rule => rule.nipLine);
        ruleById = new Map(allRules.map(rule => [rule.id, rule]));

        activeQuality = 'All';
        activeType = 'All';
        buildFilters();
        applyFilters();

        showToast(`Loaded ${allRules.length} rules from ${fileName}.`);
    } catch (error) {
        showToast('Load failed: ' + error.message);
    }
}

function normalizeRule(rawRule) {
    const id = rawRule.id || rawRule.ID || '';
    const fileName = rawRule.fileName || rawRule.FileName || currentLoadedFile;
    const generated = rawRule.generatedNip || rawRule.GeneratedNIP || rawRule.nipSyntax || '';
    const enabled = typeof rawRule.enabled === 'boolean' ? rawRule.enabled : typeof rawRule.Enabled === 'boolean' ? rawRule.Enabled : !generated.trim().startsWith('//');
    const comment = (rawRule.comments || rawRule.Comments || '').trim();

    const nipLine = stripLeadingComment(generated);
    const meta = parseRuleMeta(nipLine);

    return {
        id,
        fileName,
        enabled,
        nipLine,
        meta,
        comment,
    };
}

function stripLeadingComment(line) {
    const trimmed = (line || '').trim();
    if (trimmed.startsWith('//')) {
        return trimmed.replace(/^\/\/\s*/, '').trim();
    }
    return trimmed;
}

function parseRuleMeta(nipLine) {
    const parts = nipLine.split('#');
    const leftPart = parts[0] || '';
    const stage2Part = parts.length > 1 ? parts.slice(1).join('#') : '';
    const conditions = leftPart.split('&&').map(cond => cond.trim()).filter(Boolean);
    const names = extractConditionValues(leftPart, 'name');
    const types = extractConditionValues(leftPart, 'type');
    const qualities = extractConditionValues(leftPart, 'quality');
    let quality = '';
    let type = '';
    let rawType = '';
    let name = '';
    let setName = '';
    const nameTypeMap = {
        jewel: 'jewel',
        gold: 'misc',
        grandcharm: 'grandcharm',
        smallcharm: 'smallcharm',
        largecharm: 'torch',
    };

    for (const cond of conditions) {
        const parsed = parseCondition(cond);
        if (!parsed) {
            continue;
        }
        const property = parsed.property.toLowerCase();
        if (property === 'quality' && parsed.operator === '==') {
            quality = parsed.value.toLowerCase();
        }
        if (property === 'quality' && parsed.operator === '<=') {
            const qualityValue = parsed.value.toLowerCase();
            if (qualityValue === 'superior' || qualityValue === 'normal') {
                quality = 'base';
            } else {
                quality = qualityValue;
            }
        }
        if (property === 'type' && parsed.operator === '==') {
            type = parsed.value.toLowerCase();
            rawType = parsed.value;
        }
        if (property === 'name' && parsed.operator === '==') {
            name = parsed.value;
        }
    }

    if (qualities.length > 0) {
        quality = normalizeQualityGroup(qualities[0]);
    }

    if (types.length > 0) {
        const groupedTypes = Array.from(new Set(types.map(typeValue => normalizeTypeGroup(typeValue))));
        const filteredGroups = groupedTypes.filter(Boolean);
        type = filteredGroups.length === 1 ? filteredGroups[0] : 'Other';
        if (!rawType) {
            rawType = types[0];
        }
    }

    if (names.length > 0) {
        name = names[0];
    }

    if (name) {
        const normalizedName = normalizeItemKey(name);
        if (normalizedName === 'grandcharm') {
            type = 'grandcharm';
        } else if (normalizedName === 'smallcharm') {
            type = quality === 'unique' ? 'annihilus' : 'smallcharm';
        } else if (normalizedName === 'largecharm') {
            type = 'torch';
        }
    }

    if (quality === 'unique' && name) {
        const normalizedName = normalizeItemKey(name);
        const isCharmBase = normalizedName === 'grandcharm' || normalizedName === 'smallcharm' || normalizedName === 'largecharm';
        if (!isCharmBase) {
            const uniqueName = uniqueNameByBase.get(normalizedName);
            if (uniqueName) {
                name = uniqueName;
            }
        }
    }

    if (quality === 'set' && name) {
        const normalized = normalizeItemKey(name);
        const setItem = setItemByName.get(normalized) || setItemByBase.get(normalized);
        if (setItem) {
            name = setItem.itemName;
            setName = setItem.setName;
        }
    }

    if (quality === 'set' && (type === 'ring' || type === 'amulet') && (!name || !setName)) {
        const stage2Stats = parseStage2Stats(stage2Part);
        const setMapping = detectSetAccessoryMapping(stage2Stats, type);
        if (setMapping) {
            name = setMapping.itemName;
            setName = setMapping.setName;
        }
    }

    if (quality === 'unique' && type === 'ring' && !name) {
        const stage2Stats = parseStage2Stats(stage2Part);
        const ringName = detectUniqueRingName(stage2Stats);
        if (ringName) {
            name = ringName;
        }
    }

    if (quality === 'unique' && type === 'amulet' && !name) {
        const stage2Stats = parseStage2Stats(stage2Part);
        const amuletName = detectUniqueAmuletName(stage2Stats);
        if (amuletName) {
            name = amuletName;
        }
    }

    if (quality === 'unique' && (type === 'grandcharm' || type === 'sunder' || type === 'charm')) {
        const normalizedName = normalizeItemKey(name);
        const isBaseCharmName = normalizedName === 'grandcharm' || normalizedName === 'smallcharm' || normalizedName === 'largecharm' || !normalizedName;
        if (isBaseCharmName) {
            const stage2Stats = parseStage2Stats(stage2Part);
            const charmMapping = detectUniqueCharmMapping(stage2Stats);
            if (charmMapping) {
                name = charmMapping.name;
                type = charmMapping.type || type;
            }
        }
    }

    if (quality === 'unique' && name) {
        const normalizedName = normalizeItemKey(name);
        const mappedType = uniqueCharmNameTypeMap.get(normalizedName);
        if (mappedType) {
            type = mappedType;
        }
    }

    if (!type && names.length > 0) {
        const mappedTypes = new Set();
        names.forEach(nameValue => {
            const normalizedName = normalizeItemKey(nameValue);
            const preferredType = nameTypeMap[nameValue.toLowerCase()];
            const mappedType = preferredType || itemTypeByName.get(normalizedName);
            if (mappedType) {
                mappedTypes.add(normalizeTypeGroup(mappedType));
            }
        });

        if (mappedTypes.size === 1) {
            type = Array.from(mappedTypes)[0];
        } else {
            type = 'Other';
        }
    }

    return {
        quality: normalizeQualityGroup(quality) || 'all',
        type: normalizeTypeGroup(type) || 'Other',
        name: name || '',
        setName: setName || '',
        rawType: rawType || '',
    };
}

function parseStage2Stats(stage2Part) {
    if (!stage2Part) {
        return [];
    }
    const cleaned = stage2Part.split('//')[0].replace(/[\r\n]+/g, ' ');
    const stats = [];
    const seen = new Set();
    const regex = /\[\s*([^\]]+?)\s*\]\s*([=!<>]{1,2})\s*([-\d.]+)/g;
    let match;
    while ((match = regex.exec(cleaned)) !== null) {
        const property = match[1].trim().toLowerCase();
        const operator = match[2].trim();
        const value = Number.parseFloat(match[3]);
        if (!Number.isNaN(value)) {
            seen.add(property);
            stats.push({ property, operator, value });
        }
    }
    const nameRegex = /\[\s*([^\]]+?)\s*\]/g;
    while ((match = nameRegex.exec(cleaned)) !== null) {
        const property = match[1].trim().toLowerCase();
        if (!seen.has(property)) {
            stats.push({ property, operator: '', value: Number.NaN });
            seen.add(property);
        }
    }
    return stats;
}

function hasStat(stats, property) {
    const target = property.toLowerCase();
    return stats.some(stat => stat.property === target);
}

function hasAllStats(stats, properties) {
    return properties.every(property => hasStat(stats, property));
}

function detectUniqueRingName(stats) {
    if (hasAllStats(stats, ['itemmagicbonus'])) {
        return 'Nagelring';
    }
    if (hasAllStats(stats, ['hpregen', 'manaleech'])) {
        return 'Manald Heal';
    }
    if (hasAllStats(stats, ['itemmaxmanapercent'])) {
        return 'Stone of Jordan';
    }
    if (hasAllStats(stats, ['maxhp', 'magicdamagereduction'])) {
        return 'Dwarf Star';
    }
    if (hasAllStats(stats, ['dexterity', 'tohit'])) {
        return 'Raven Frost';
    }
    if (hasAllStats(stats, ['lifeleech', 'itemallskills'])) {
        return "Bul-Kathos' Wedding Band";
    }
    if (hasAllStats(stats, ['poisonresist', 'normaldamagereduction'])) {
        return "Nature's Peace";
    }
    if (hasAllStats(stats, ['itemabsorblightpercent'])) {
        return 'Wisp Projector';
    }
    return '';
}

function detectUniqueAmuletName(stats) {
    if (hasAllStats(stats, ['itemallskills'])) {
        return "Mara's Kaleidoscope";
    }
    if (hasAllStats(stats, ['defensiveaurasskilltab'])) {
        return "Seraph's Hymn";
    }
    if (hasAllStats(stats, ['coldresist', 'plusdefense'])) {
        return 'Metalgrid';
    }
    if (hasAllStats(stats, ['lightresist'])) {
        return "Highlord's Wrath";
    }
    if (hasAllStats(stats, ['dexterity'])) {
        return "The Cat's Eye";
    }
    if (hasAllStats(stats, ['strength', 'fireresist'])) {
        return "Saracen's Chance";
    }
    if (hasAllStats(stats, ['fireresist'])) {
        return 'Nokozan Relic';
    }
    return '';
}

function detectUniqueCharmMapping(stats) {
    const elemental = ['fireresist', 'coldresist', 'lightresist'];
    const elementalCount = elemental.filter(stat => hasStat(stats, stat)).length;
    if (elementalCount > 1) {
        return { name: 'Sunder', type: 'sunder' };
    }

    if (hasStat(stats, 'lightresist')) {
        return { name: 'The Crack of the Heavens', type: 'sunder' };
    }
    if (hasStat(stats, 'coldresist')) {
        return { name: 'The Cold Rupture', type: 'sunder' };
    }
    if (hasStat(stats, 'fireresist')) {
        return { name: 'The Flame Rift', type: 'sunder' };
    }
    if (hasStat(stats, 'magicresist')) {
        return { name: 'The Black Cleft', type: 'sunder' };
    }
    if (hasStat(stats, 'physicalresist')) {
        return { name: 'The Bone Break', type: 'sunder' };
    }
    if (hasStat(stats, 'poisonresist')) {
        return { name: 'The Rotting Fissure', type: 'sunder' };
    }

    if (hasStat(stats, 'itemmagicbonus')) {
        return { name: "Gheed's Fortune", type: 'gheeds' };
    }

    return null;
}

const setAccessoryMappings = [
    {
        type: 'ring',
        requiredStats: ['lifeleech', 'normaldamagereduction'],
        itemName: "Cathan's Seal",
        setName: "Cathan's Traps",
    },
    {
        type: 'ring',
        requiredStats: ['maxhp'],
        itemName: 'Angelic Halo',
        setName: 'Angelical Raiment',
    },
    {
        type: 'amulet',
        requiredStats: ['itemallskills', 'coldresist'],
        itemName: 'Telling of Beads',
        setName: 'The Disciple',
    },
    {
        type: 'amulet',
        requiredStats: ['coldresist', 'maxmana'],
        itemName: "Vidala's Snare",
        setName: "Vidala's Rig",
    },
    {
        type: 'amulet',
        requiredStats: ['manarecovery', 'hpregen'],
        itemName: "Civerb's Icon",
        setName: "Civerb's Vestments",
    },
    {
        type: 'amulet',
        requiredStats: ['fhr', 'lightmaxdam'],
        itemName: "Cathan's Sigil",
        setName: "Cathan's Traps",
    },
    {
        type: 'amulet',
        requiredStats: ['itemlightradius', 'itemdamagetomana'],
        itemName: 'Angelic Wings',
        setName: 'Angelical Raiment',
    },
    {
        type: 'amulet',
        requiredStats: ['poisonresist', 'poisonlength'],
        itemName: "Iratha's Collar",
        setName: "Iratha's Finery",
    },
    {
        type: 'amulet',
        requiredStats: ['magicdamagereduction', 'normaldamagereduction'],
        itemName: "Tancred's Weird",
        setName: "Tancred's Battlegear",
    },
    {
        type: 'amulet',
        requiredStats: ['sorceressskills'],
        itemName: "Tal Rasha's Adjudication",
        setName: "Tal Rasha's Wrappings",
    },
    {
        type: 'amulet',
        requiredStats: ['maxmana'],
        itemName: "Arcanna's Sign",
        setName: "Arcanna's Tricks",
    },
];

function detectSetAccessoryMapping(stats, accessoryType) {
    for (const mapping of setAccessoryMappings) {
        if (mapping.type !== accessoryType) {
            continue;
        }
        if (hasAllStats(stats, mapping.requiredStats)) {
            return {
                itemName: mapping.itemName,
                setName: mapping.setName,
            };
        }
    }
    return null;
}

async function loadItemMappings() {
    if (itemMappingsPromise) {
        return itemMappingsPromise;
    }

    itemMappingsPromise = (async () => {
        try {
            const [itemsResult, d2goResult, setResult, uniqueResult] = await Promise.allSettled([
                fetch('/api/pickit/items'),
                fetch('/api/pickit/item-types'),
                fetch('/api/pickit/set-mappings'),
                fetch('/api/pickit/unique-mappings'),
            ]);

            itemTypeByName = new Map();
            uniqueNameByBase = new Map();
            setItemByName = new Map();
            setItemByBase = new Map();
            const uniqueBaseCandidates = new Map();

            if (itemsResult.status === 'fulfilled' && itemsResult.value.ok) {
                const items = await itemsResult.value.json();
                items.forEach(item => {
                    const itemType = item.type || '';
                    if (!itemType) {
                        return;
                    }

                    addItemTypeMapping(item.nipName, itemType);
                    addItemTypeMapping(item.internalName, itemType);
                    addItemTypeMapping(item.name, itemType);
                    if (itemType !== 'unique' && itemType !== 'set') {
                        addItemTypeMapping(item.baseItem, itemType);
                    }
                    if (itemType === 'unique' && item.baseItem) {
                        const baseKey = normalizeItemKey(item.baseItem);
                        const uniqueList = uniqueBaseCandidates.get(baseKey) || new Set();
                        uniqueList.add(item.name);
                        uniqueBaseCandidates.set(baseKey, uniqueList);
                    }
                });
            }

            if (d2goResult.status === 'fulfilled' && d2goResult.value.ok) {
                const mapping = await d2goResult.value.json();
                Object.entries(mapping).forEach(([key, value]) => {
                    addItemTypeMapping(key, value, true);
                });
            }

            if (setResult.status === 'fulfilled' && setResult.value.ok) {
                const mapping = await setResult.value.json();
                if (mapping.setItems) {
                    Object.entries(mapping.setItems).forEach(([key, value]) => {
                        if (value && value.setName && value.itemName) {
                            setItemByName.set(normalizeItemKey(key), value);
                        }
                    });
                }
                if (mapping.baseItems) {
                    Object.entries(mapping.baseItems).forEach(([key, value]) => {
                        if (value && value.setName && value.itemName) {
                            setItemByBase.set(normalizeItemKey(key), value);
                        }
                    });
                }
            }

            if (uniqueResult.status === 'fulfilled' && uniqueResult.value.ok) {
                const mapping = await uniqueResult.value.json();
                if (mapping.baseItems) {
                    Object.entries(mapping.baseItems).forEach(([key, value]) => {
                        if (value && value.itemName) {
                            uniqueNameByBase.set(normalizeItemKey(key), value.itemName);
                        }
                    });
                }
            }

            uniqueBaseCandidates.forEach((names, baseKey) => {
                if (names.size === 1 && !uniqueNameByBase.has(baseKey)) {
                    uniqueNameByBase.set(baseKey, Array.from(names)[0]);
                }
            });

            applyNameAliases();
        } catch (error) {
            console.warn('Failed to load item mappings:', error);
        }
    })();

    return itemMappingsPromise;
}

function addItemTypeMapping(value, itemType, allowOverride) {
    if (!value || !itemType) {
        return;
    }

    const key = normalizeItemKey(value);
    if (itemTypeByName.has(key)) {
        if (!allowOverride) {
            return;
        }
        const existingType = itemTypeByName.get(key);
        if (existingType !== 'unique' && existingType !== 'set') {
            return;
        }
    }

    itemTypeByName.set(key, itemType);
}

function applyNameAliases() {
    nameAliasMap.forEach((sourceName, aliasName) => {
        const sourceKey = normalizeItemKey(sourceName);
        if (!itemTypeByName.has(sourceKey)) {
            return;
        }
        itemTypeByName.set(normalizeItemKey(aliasName), itemTypeByName.get(sourceKey));
    });
}

function normalizeItemKey(value) {
    return String(value)
        .toLowerCase()
        .replace(/[\s'\-]/g, '');
}

function parseCondition(condition) {
    const cleaned = condition.split('//')[0].trim();
    const match = cleaned.match(/^\[(.+?)\]\s*([=!<>]{1,2})\s*(.+)$/);
    if (!match) {
        return null;
    }

    return {
        property: match[1].trim(),
        operator: match[2].trim(),
        value: match[3].trim().replace(/['"]/g, ''),
    };
}

function extractConditionValues(section, property) {
    const values = [];
    const regex = new RegExp(`\\[\\s*${property}\\s*\\]\\s*==\\s*([^\\s\\]&|()#]+)`, 'ig');
    let match;

    while ((match = regex.exec(section)) !== null) {
        values.push(normalizeConditionValue(match[1]));
    }

    return values.filter(Boolean);
}

function normalizeConditionValue(value) {
    return String(value)
        .trim()
        .replace(/^['"]|['"]$/g, '');
}

function normalizeTypeGroup(typeName) {
    if (!typeName) {
        return '';
    }
    const normalized = typeName.toLowerCase();
    return typeGroupMap.get(normalized) || normalized;
}

function formatTypeLabel(typeName) {
    if (!typeName) {
        return '';
    }
    const trimmed = String(typeName).trim();
    if (trimmed.length === 0) {
        return '';
    }
    const override = typeLabelOverrides.get(trimmed.toLowerCase());
    if (override) {
        return override;
    }
    const first = trimmed.charAt(0);
    if (first >= 'a' && first <= 'z') {
        return first.toUpperCase() + trimmed.slice(1);
    }
    return trimmed;
}

function normalizeQualityGroup(qualityName) {
    if (!qualityName) {
        return '';
    }
    const normalized = qualityName.toLowerCase();
    return qualityGroupMap.get(normalized) || normalized;
}

function buildFilters() {
    const qualityTabs = document.getElementById('qualityTabs');
    const typeList = document.getElementById('typeList');
    if (!qualityTabs || !typeList) {
        return;
    }

    const qualitySet = new Set();
    const typeCounts = new Map();

    allRules.forEach(rule => {
        qualitySet.add(rule.meta.quality);
    });

    const orderedQualities = buildQualityOrder(qualitySet);
    const baseQualities = orderedQualities.length > 0 ? orderedQualities : ['All'];
    const qualities = applyStoredOrder(baseQualities, loadStoredOrder('pickitQualityOrder'));
    qualityTabs.innerHTML = qualities
        .map(quality => {
            const label = quality === 'All' ? 'All' : (quality === 'favorites' ? '★' : (qualityLabels[quality] || quality));
            const active = quality === 'favorites' ? (favoritesMode ? 'active' : '') : (!favoritesMode && quality === activeQuality ? 'active' : '');
            const extraClass = quality === 'favorites' ? ' favorites' : '';
            return `<button class="quality-tab ${active}${extraClass}" data-quality="${quality}">${escapeHtml(label)}</button>`;
        })
        .join('');

    qualityTabs.querySelectorAll('.quality-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            clearSearchState();
            resetFilterToggles();
            const nextQuality = tab.dataset.quality;
            if (nextQuality === 'favorites') {
                favoritesMode = true;
                filterFavorites = true;
                activeQuality = 'All';
                activeType = 'All';
            } else {
                favoritesMode = false;
                activeQuality = nextQuality;
                if (activeQuality === 'misc' || activeQuality === 'set' || activeQuality === 'charm') {
                    activeType = 'All';
                }
            }
            buildFilters();
            applyFilters();
        });
    });
    initQualitySortable(qualityTabs);

    let typeSource = allRules;
    if (activeQuality === 'misc') {
        typeSource = allRules.filter(rule => miscTypes.has(rule.meta.type));
    } else if (activeQuality === 'set') {
        typeSource = allRules.filter(rule => rule.meta.quality === 'set');
    } else if (activeQuality === 'charm') {
        typeSource = allRules.filter(rule => charmTypes.has(rule.meta.type));
    } else if (activeQuality !== 'All') {
        typeSource = allRules.filter(rule => rule.meta.quality === activeQuality);
    }

    const recentSource = getRecentRules(50).filter(rule => {
        if (favoritesMode && !favorites.has(rule.id)) {
            return false;
        }
        if (activeQuality !== 'All') {
            return rule.meta.quality === activeQuality;
        }
        return true;
    });
    typeSource.forEach(rule => {
        let typeKey = rule.meta.type || 'Other';
        if (activeQuality === 'set') {
            typeKey = rule.meta.setName || 'Other';
        } else if (activeQuality === 'unique' && uniqueCharmGroupTypes.has(typeKey)) {
            typeKey = 'charm';
        }
        typeCounts.set(typeKey, (typeCounts.get(typeKey) || 0) + 1);
    });

    const sortedTypes = Array.from(typeCounts.entries()).sort((a, b) => {
        if (typeSortMode === 0) {
            return a[0].localeCompare(b[0]);
        }
        if (typeSortMode === 1) {
            return b[0].localeCompare(a[0]);
        }
        if (typeSortMode === 2) {
            return b[1] - a[1];
        }
        if (typeSortMode === 3) {
            return a[1] - b[1];
        }
        return a[0].localeCompare(b[0]);
    });
    let typeEntries = [['All', typeSource.length], ...sortedTypes];
    if (typeSortMode === 0) {
        typeEntries = applyStoredEntryOrder(typeEntries, loadStoredOrder(`pickitTypeOrder:${activeQuality}`));
    }
    typeEntries = [['Recent', recentSource.length], ...typeEntries];
    const availableTypes = new Set(typeEntries.map(entry => entry[0]));
    if (!availableTypes.has(activeType)) {
        activeType = 'All';
    }

    typeList.innerHTML = typeEntries
        .map(([type, count]) => {
            let label = type === 'All' ? 'All' : (activeQuality === 'set' ? type : formatTypeLabel(type));
            if (activeQuality === 'charm' && type === 'charm') {
                label = 'Other';
            }
            const active = type === activeType ? 'active' : '';
            const recentClass = type === 'Recent' ? ' recent' : '';
            return `
                <div class="type-item ${active}${recentClass}" data-type="${escapeHtml(type)}">
                    <span>${escapeHtml(label)}</span>
                    <span class="muted">${count}</span>
                </div>
            `;
        })
        .join('');

    typeList.querySelectorAll('.type-item').forEach(item => {
        item.addEventListener('click', () => {
            clearSearchState();
            resetFilterToggles();
            activeType = item.dataset.type;
            buildFilters();
            applyFilters();
        });
    });
    initTypeSortable(typeList);
}

function buildQualityOrder(qualitySet) {
    const available = new Set(Array.from(qualitySet).filter(q => q && q !== 'all'));
    const order = ['All', 'crafted', 'base', 'magic', 'rare', 'set', 'unique', 'charm', 'misc', 'favorites'];
    return order.filter(quality => quality === 'All' || quality === 'misc' || quality === 'charm' || quality === 'favorites' || available.has(quality));
}

function loadStoredOrder(key) {
    const raw = localStorage.getItem(key);
    if (!raw) {
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
    } catch (error) {
        return null;
    }
}

function saveStoredOrder(key, order) {
    localStorage.setItem(key, JSON.stringify(order));
}

function applyStoredOrder(list, order) {
    if (!order || order.length === 0) {
        return list;
    }
    const indexMap = new Map(order.map((value, index) => [value, index]));
    const fallbackIndex = new Map(list.map((value, index) => [value, index]));
    return [...list].sort((a, b) => {
        const aIndex = indexMap.has(a) ? indexMap.get(a) : Number.MAX_SAFE_INTEGER;
        const bIndex = indexMap.has(b) ? indexMap.get(b) : Number.MAX_SAFE_INTEGER;
        if (aIndex !== bIndex) {
            return aIndex - bIndex;
        }
        return (fallbackIndex.get(a) || 0) - (fallbackIndex.get(b) || 0);
    });
}

function applyStoredEntryOrder(entries, order) {
    if (!order || order.length === 0) {
        return entries;
    }
    const entryMap = new Map(entries.map(entry => [entry[0], entry]));
    const used = new Set();
    const ordered = [];
    order.forEach(key => {
        const entry = entryMap.get(key);
        if (entry) {
            ordered.push(entry);
            used.add(key);
        }
    });
    entries.forEach(entry => {
        if (!used.has(entry[0])) {
            ordered.push(entry);
        }
    });
    return ordered;
}

function initQualitySortable(container) {
    if (!container || !window.Sortable) {
        return;
    }
    if (qualitySortable) {
        qualitySortable.destroy();
        qualitySortable = null;
    }

    qualitySortable = new Sortable(container, {
        animation: 120,
        onEnd: () => {
            const order = Array.from(container.querySelectorAll('.quality-tab'))
                .map(tab => tab.dataset.quality)
                .filter(Boolean);
            saveStoredOrder('pickitQualityOrder', order);
            buildFilters();
        },
    });
}

function initTypeSortable(container) {
    if (!container || !window.Sortable) {
        return;
    }
    if (typeSortable) {
        typeSortable.destroy();
        typeSortable = null;
    }

    typeSortable = new Sortable(container, {
        animation: 120,
        filter: '.type-item.recent',
        preventOnFilter: false,
        onEnd: () => {
            const order = Array.from(container.querySelectorAll('.type-item'))
                .map(item => item.dataset.type)
                .filter(Boolean);
            saveStoredOrder(`pickitTypeOrder:${activeQuality}`, order);
            buildFilters();
        },
    });
}

function applyFilters() {
    if (activeType === 'Recent' && !searchTerm) {
        filteredRules = getRecentRules(50).filter(ruleMatchesFilters);
    } else {
        filteredRules = allRules.filter(ruleMatchesFilters);
    }

    if (ruleSortMode === 0 && filterStatusMode === 0 && !searchTerm) {
        const indexMap = new Map(allRules.map((rule, index) => [rule.id, index]));
        filteredRules.sort((a, b) => {
            if (a.enabled !== b.enabled) {
                return a.enabled ? -1 : 1;
            }
            return (indexMap.get(a.id) || 0) - (indexMap.get(b.id) || 0);
        });
    } else if (ruleSortMode === 1) {
        filteredRules.sort((a, b) => {
            const aKey = (a.meta.name || a.meta.rawType || a.meta.type || '').toLowerCase();
            const bKey = (b.meta.name || b.meta.rawType || b.meta.type || '').toLowerCase();
            return aKey.localeCompare(bKey);
        });
    } else if (ruleSortMode === 2) {
        filteredRules.sort((a, b) => {
            const aKey = (a.meta.name || a.meta.rawType || a.meta.type || '').toLowerCase();
            const bKey = (b.meta.name || b.meta.rawType || b.meta.type || '').toLowerCase();
            return bKey.localeCompare(aKey);
        });
    }

    updateSelectionLabel();
    updateFavoritesChip();
    renderSummary();
    renderRules();
}

function updateFavoritesChip() {
    const favoritesChip = document.getElementById('filterFavorites');
    if (!favoritesChip) {
        return;
    }
    favoritesChip.classList.toggle('active', filterFavorites);
}

function ruleMatchesFilters(rule) {
    if (!ruleMatchesSelection(rule)) {
        return false;
    }
    if (filterStatusMode === 1 && !rule.enabled) {
        return false;
    }
    if (filterStatusMode === 2 && rule.enabled) {
        return false;
    }
    if (filterEthereal && !isEtherealRule(rule)) {
        return false;
    }
    const skipUnidentify = activeQuality === 'misc' || activeQuality === 'base';
    if (!skipUnidentify) {
        if (filterUnidentify) {
            if (!isUnidentifyRule(rule)) {
                return false;
            }
        } else if (isUnidentifyRule(rule)) {
            return false;
        }
    }
    if (filterFavorites && !favorites.has(rule.id)) {
        return false;
    }
    if (searchTerm && !rule.nipLine.toLowerCase().includes(searchTerm)) {
        return false;
    }
    return true;
}

function ruleMatchesSelection(rule) {
    if (searchTerm) {
        return true;
    }
    if (activeType === 'Recent') {
        if (!recentRuleMap.has(rule.id)) {
            return false;
        }
        if (activeQuality === 'misc') {
            return miscTypes.has(rule.meta.type);
        }
        if (activeQuality === 'charm') {
            return charmTypes.has(rule.meta.type);
        }
        if (activeQuality === 'set') {
            return rule.meta.quality === 'set';
        }
        if (activeQuality !== 'All') {
            return rule.meta.quality === activeQuality;
        }
        return true;
    }
    if (activeQuality === 'misc') {
        if (activeType !== 'All') {
            return rule.meta.type === activeType;
        }
        return miscTypes.has(rule.meta.type);
    }
    if (activeQuality === 'charm') {
        if (activeType !== 'All') {
            return rule.meta.type === activeType;
        }
        return charmTypes.has(rule.meta.type);
    }
    if (activeQuality === 'set') {
        if (rule.meta.quality !== 'set') {
            return false;
        }
        const group = rule.meta.setName || 'Other';
        if (activeType !== 'All') {
            return group === activeType;
        }
        return true;
    }
    if (activeQuality !== 'All' && rule.meta.quality !== activeQuality) {
        return false;
    }
    if (activeQuality === 'unique' && activeType === 'charm') {
        return uniqueCharmGroupTypes.has(rule.meta.type);
    }
    if (activeType !== 'All' && rule.meta.type !== activeType) {
        return false;
    }
    return true;
}

function renderSummary() {
    const summary = document.getElementById('summaryCounts');
    if (!summary) {
        return;
    }

    let selectionRules = searchTerm ? filteredRules : allRules.filter(ruleMatchesSelection);
    if (!searchTerm && activeType === 'Recent') {
        selectionRules = getRecentRules(50).filter(ruleMatchesSelection);
    }
    if (!searchTerm && filterFavorites) {
        selectionRules = selectionRules.filter(rule => favorites.has(rule.id));
    }
    const enabledCount = selectionRules.filter(rule => rule.enabled).length;
    const disabledCount = selectionRules.length - enabledCount;
    summary.textContent = `All ${selectionRules.length} / Enabled ${enabledCount} / Disabled ${disabledCount}`;
}

function updateSelectionLabel() {
    const label = document.getElementById('selectionLabel');
    if (!label) {
        return;
    }

    const qualityLabel = activeQuality === 'All' ? 'All' : (qualityLabels[activeQuality] || formatTypeLabel(activeQuality));
    let typeLabel = activeType === 'All' ? 'All' : formatTypeLabel(activeType);
    if (activeQuality === 'charm' && activeType === 'charm') {
        typeLabel = 'Other';
    }

    if (favoritesMode) {
        if (typeLabel === 'All') {
            label.textContent = 'Favorites';
        } else {
            label.textContent = `Favorites > ${typeLabel}`;
        }
        return;
    }

    if (qualityLabel === 'All' && typeLabel === 'All') {
        label.textContent = 'All';
        return;
    }

    label.textContent = `${qualityLabel} > ${typeLabel}`;
}

function renderRules() {
    const list = document.getElementById('rulesList');
    if (!list) {
        return;
    }

    if (filteredRules.length === 0) {
        list.innerHTML = '<div class="empty-state">No rules match the current filters.</div>';
        return;
    }

    list.innerHTML = filteredRules.map(rule => renderRuleCard(rule)).join('');
    initRulesSortable();
}

function renderRuleCard(rule) {
    const typeTitle = rule.meta.rawType ? formatTypeLabel(rule.meta.rawType) : formatTypeLabel(rule.meta.type);
    const title = rule.meta.name || typeTitle || 'Rule';
    const qualityLabel = rule.meta.quality === 'all' ? 'All' : (qualityLabels[rule.meta.quality] || rule.meta.quality);
    const typeLabel = rule.meta.quality === 'set' && rule.meta.setName ? rule.meta.setName : formatTypeLabel(rule.meta.type || 'Other');
    const favoriteActive = favorites.has(rule.id) ? '★' : '☆';
    const qualityClass = buildQualityClass(rule.meta.quality);
    const comment = showComments ? getRuleComment(rule) : '';
    const commentLabel = comment || 'Add comment';
    const commentClass = comment ? '' : ' empty';
    const commentMarkup = showComments
        ? `<button class="rule-comment${commentClass}" data-action="comment" data-rule-id="${escapeHtml(rule.id)}"><span class="rule-comment-icon">C</span>${escapeHtml(commentLabel)}</button>`
        : '';
    const unidentifyMarkup = isUnidentifyRule(rule) ? '<span class="pill">Unidentify</span>' : '';
    const etherealState = getEtherealFlagState(rule);
    const etherealActive = etherealState === 'ethereal' ? ' active' : '';
    const etherealLabel = etherealState === 'nonethereal' ? 'Non-Ethereal' : 'Ethereal';
    const etherealMarkup = etherealState === 'unknown'
        ? ''
        : `<button class="pill pill-toggle${etherealActive}" data-action="toggle-ethereal" data-rule-id="${escapeHtml(rule.id)}">${etherealLabel}</button>`;

    return `
        <div class="rule-card ${rule.enabled ? '' : 'disabled'}" data-rule-id="${escapeHtml(rule.id)}">
            <div class="rule-header">
                <div class="rule-title">
                    <button class="icon-btn small" data-action="favorite" data-rule-id="${escapeHtml(rule.id)}">${favoriteActive}</button>
                    <span>${escapeHtml(title)}</span>
                    ${commentMarkup}
                </div>
                <div class="rule-actions">
                    <div class="toggle ${rule.enabled ? 'active' : ''}" data-rule-id="${escapeHtml(rule.id)}"></div>
                    <button class="icon-btn small" data-action="edit" data-rule-id="${escapeHtml(rule.id)}">✎</button>
                    <button class="icon-btn small" data-action="delete" data-rule-id="${escapeHtml(rule.id)}">🗑</button>
                </div>
            </div>
            <div class="rule-meta">
                <span class="pill ${qualityClass}">${escapeHtml(qualityLabel)}</span>
                <span class="pill">${escapeHtml(typeLabel)}</span>
                ${unidentifyMarkup}
                ${etherealMarkup}
            </div>
            <div class="rule-body">
                <div class="rule-line">${renderTokens(rule)}</div>
            </div>
        </div>
    `;
}

function buildQualityClass(quality) {
    const normalized = (quality || '').toLowerCase();
    if (!normalized || normalized === 'all') {
        return 'primary';
    }
    if (normalized === 'base') {
        return 'quality-base';
    }
    return `quality-${normalized}`;
}

function renderTokens(rule) {
    const displayLine = getRuleDisplayLine(rule);
    if (!displayLine) {
        return '<span class="muted">Empty rule</span>';
    }

    const tokens = tokenizeNumbers(displayLine);
    return tokens.map(token => {
        if (token.isNumber) {
            return `<button class="value-chip" data-rule-id="${escapeHtml(rule.id)}" data-start="${token.start}" data-end="${token.end}">${escapeHtml(token.text)}</button>`;
        }
        return `<span>${escapeHtml(token.text)}</span>`;
    }).join('');
}

function getRuleDisplayLine(rule) {
    if (!rule || !rule.nipLine) {
        return '';
    }
    const commentIndex = rule.nipLine.indexOf('//');
    if (commentIndex === -1) {
        return rule.nipLine;
    }
    return rule.nipLine.slice(0, commentIndex).trimEnd();
}

function getRuleComment(rule) {
    if (!rule) {
        return '';
    }
    if (rule.comment) {
        return rule.comment;
    }
    if (!rule.nipLine) {
        return '';
    }
    const commentIndex = rule.nipLine.indexOf('//');
    if (commentIndex === -1) {
        return '';
    }
    return rule.nipLine.slice(commentIndex + 2).trim();
}

function stripInlineComment(line) {
    if (!line) {
        return '';
    }
    const commentIndex = line.indexOf('//');
    if (commentIndex === -1) {
        return line.trimEnd();
    }
    return line.slice(0, commentIndex).trimEnd();
}

async function editRuleComment(ruleId) {
    const rule = ruleById.get(ruleId);
    if (!rule) {
        return;
    }

    const currentComment = getRuleComment(rule);
    const next = prompt('Edit comment', currentComment || '');
    if (next === null) {
        return;
    }

    let trimmed = next.trim();
    if (trimmed.startsWith('//')) {
        trimmed = trimmed.replace(/^\/\/\s*/, '');
    }

    const originalLine = rule.nipLine;
    const originalComment = rule.comment;
    const baseLine = stripInlineComment(originalLine);

    rule.comment = trimmed;
    rule.nipLine = trimmed ? `${baseLine} // ${trimmed}` : baseLine;

    const success = await saveRuleLine(rule);
    if (!success) {
        rule.nipLine = originalLine;
        rule.comment = originalComment;
        return;
    }

    applyFilters();
}

function tokenizeNumbers(line) {
    const tokens = [];
    const regex = /-?\d+(?:\.\d+)?/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(line)) !== null) {
        if (match.index > lastIndex) {
            tokens.push({ text: line.slice(lastIndex, match.index), isNumber: false });
        }
        tokens.push({
            text: match[0],
            isNumber: true,
            start: match.index,
            end: match.index + match[0].length,
        });
        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < line.length) {
        tokens.push({ text: line.slice(lastIndex), isNumber: false });
    }

    return tokens;
}

function enterValueEdit(button) {
    const ruleId = button.dataset.ruleId;
    const start = Number(button.dataset.start);
    const end = Number(button.dataset.end);
    const rule = ruleById.get(ruleId);
    if (!rule || Number.isNaN(start) || Number.isNaN(end)) {
        return;
    }

    const currentValue = rule.nipLine.slice(start, end);
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'value-input';
    input.value = currentValue;

    const originalLine = rule.nipLine;

    button.replaceWith(input);
    requestAnimationFrame(() => {
        input.focus();
        input.select();
    });

    const commit = () => {
        const newValue = input.value.trim();
        if (!newValue) {
            updateRuleCard(rule);
            return;
        }

        rule.nipLine = originalLine.slice(0, start) + newValue + originalLine.slice(end);
        if (!ruleMatchesFilters(rule)) {
            applyFilters();
            return;
        }
        updateRuleCard(rule);

        saveRuleLine(rule).then(success => {
            if (success) {
                return;
            }
            rule.nipLine = originalLine;
            if (!ruleMatchesFilters(rule)) {
                applyFilters();
                return;
            }
            updateRuleCard(rule);
        });
    };

    const cancel = () => {
        updateRuleCard(rule);
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            input.blur();
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
        }
    });
}

function updateRuleCard(rule) {
    const card = document.querySelector(`.rule-card[data-rule-id="${CSS.escape(rule.id)}"]`);
    if (!card) {
        return;
    }

    const line = card.querySelector('.rule-line');
    if (line) {
        line.innerHTML = renderTokens(rule);
    }
}

function isEtherealRule(rule) {
    if (!rule || !rule.nipLine) {
        return false;
    }
    const line = rule.nipLine.toLowerCase();
    if (/\[flag\]\s*!=\s*ethereal/.test(line)) {
        return false;
    }
    if (/\[flag\]\s*==\s*ethereal/.test(line)) {
        return true;
    }
    return false;
}

function getEtherealFlagState(rule) {
    if (!rule || !rule.nipLine) {
        return 'unknown';
    }
    const line = rule.nipLine.toLowerCase();
    if (/\[flag\]\s*==\s*ethereal/.test(line)) {
        return 'ethereal';
    }
    if (/\[flag\]\s*!=\s*ethereal/.test(line)) {
        return 'nonethereal';
    }
    return 'unknown';
}

function splitLineComment(line) {
    const index = line.indexOf('//');
    if (index === -1) {
        return { base: line.trimEnd(), comment: '' };
    }
    return {
        base: line.slice(0, index).trimEnd(),
        comment: line.slice(index + 2).trim(),
    };
}

function toggleEtherealInLine(line) {
    const { base, comment } = splitLineComment(line);
    const parts = base.split('#');
    const left = (parts[0] || '').trim();
    const rest = parts.length > 1 ? parts.slice(1).join('#').trim() : '';
    let nextLeft = left;

    if (/\[flag\]\s*==\s*ethereal/i.test(left)) {
        nextLeft = left.replace(/\[flag\]\s*==\s*ethereal/gi, '[flag] != ethereal');
    } else if (/\[flag\]\s*!=\s*ethereal/i.test(left)) {
        nextLeft = left.replace(/\[flag\]\s*!=\s*ethereal/gi, '[flag] == ethereal');
    } else if (left) {
        nextLeft = `${left} && [flag] == ethereal`;
    } else {
        nextLeft = '[flag] == ethereal';
    }

    let rebuilt = nextLeft;
    if (rest) {
        rebuilt = `${rebuilt} # ${rest}`;
    }
    if (comment) {
        rebuilt = `${rebuilt} // ${comment}`;
    }
    return rebuilt.trim();
}

async function toggleRuleEthereal(ruleId) {
    const rule = ruleById.get(ruleId);
    if (!rule) {
        return;
    }

    const originalLine = rule.nipLine;
    rule.nipLine = toggleEtherealInLine(originalLine);

    const success = await saveRuleLine(rule);
    if (!success) {
        rule.nipLine = originalLine;
        return;
    }

    applyFilters();
}

function isUnidentifyRule(rule) {
    if (!rule || !rule.nipLine) {
        return false;
    }
    const parts = rule.nipLine.split('#');
    if (parts.length < 2) {
        return true;
    }
    const stage2 = stripInlineComment(parts.slice(1).join('#')).trim();
    return stage2.length === 0;
}

async function toggleRule(ruleId) {
    const rule = ruleById.get(ruleId);
    if (!rule) {
        return;
    }

    const originalEnabled = rule.enabled;
    rule.enabled = !rule.enabled;

    const success = await saveRuleLine(rule);
    if (!success) {
        rule.enabled = originalEnabled;
    }
    applyFilters();
}

async function saveRuleLine(rule) {
    if (!currentPickitPath || !currentLoadedFile) {
        showToast('Please load a Pickit file first.');
        return false;
    }

    const line = rule.enabled ? rule.nipLine : `// ${rule.nipLine}`;

    try {
        const response = await fetch(`/api/pickit/files/rules/update?path=${encodeURIComponent(currentPickitPath)}&file=${encodeURIComponent(currentLoadedFile)}&id=${encodeURIComponent(rule.id)}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ newNipLine: line }),
            });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || 'Update failed');
        }

        markRuleRecent(rule.id);
        showToast('Saved.');
        return true;
    } catch (error) {
        showToast('Save failed: ' + error.message);
        return false;
    }
}

async function deleteRule(ruleId) {
    const rule = ruleById.get(ruleId);
    if (!rule) {
        return;
    }

    if (!confirm('Delete this rule?')) {
        return;
    }

    try {
        const response = await fetch(`/api/pickit/files/rules/delete?path=${encodeURIComponent(currentPickitPath)}&file=${encodeURIComponent(currentLoadedFile)}&id=${encodeURIComponent(rule.id)}`,
            { method: 'POST' });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || 'Delete failed');
        }

        recentRuleMap.delete(rule.id);
        saveRecentRuleMap(recentRuleMap);
        showToast('Deleted.');
        await loadPickitFile();
    } catch (error) {
        showToast('Delete failed: ' + error.message);
    }
}

function createNewFile() {
    if (!currentPickitPath) {
        showToast('Please select a Pickit folder first.');
        return;
    }

    const fileName = prompt('Enter new .nip file name (e.g. my_rules.nip)');
    if (!fileName) {
        return;
    }

    if (!fileName.endsWith('.nip')) {
        showToast('File extension must be .nip.');
        return;
    }

    const select = document.getElementById('pickitFile');
    const option = document.createElement('option');
    option.value = fileName;
    option.textContent = fileName;
    select.appendChild(option);
    select.value = fileName;
    currentLoadedFile = fileName;

    showToast(`${fileName} added. It will be created when you save rules.`);
}

function toggleFavorite(ruleId) {
    if (favorites.has(ruleId)) {
        favorites.delete(ruleId);
    } else {
        favorites.add(ruleId);
    }

    localStorage.setItem('nipFavorites', JSON.stringify(Array.from(favorites)));
    applyFilters();
}

function openRuleEditModal(ruleId) {
    const rule = ruleById.get(ruleId);
    if (!rule) {
        return;
    }

    editingRuleId = ruleId;
    const modal = document.getElementById('ruleEditModal');
    const input = document.getElementById('ruleEditInput');
    if (input) {
        input.value = rule.nipLine;
    }
    if (modal) {
        modal.classList.add('active');
    }
}

function closeRuleEditModal() {
    const modal = document.getElementById('ruleEditModal');
    if (modal) {
        modal.classList.remove('active');
    }
    editingRuleId = '';
}

async function saveRuleEdit() {
    const rule = ruleById.get(editingRuleId);
    const input = document.getElementById('ruleEditInput');
    if (!rule || !input) {
        closeRuleEditModal();
        return;
    }

    const newLine = input.value.trim();
    if (!newLine) {
        showToast('Please enter a NIP line.');
        return;
    }

    const originalLine = rule.nipLine;
    rule.nipLine = newLine;

    const success = await saveRuleLine(rule);
    if (!success) {
        rule.nipLine = originalLine;
    }
    closeRuleEditModal();
    buildFilters();
    applyFilters();
}

function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) {
        return;
    }

    toast.textContent = message;
    toast.classList.add('show');

    setTimeout(() => {
        toast.classList.remove('show');
    }, 2500);
}

function canReorderRules() {
    if (searchTerm) {
        return false;
    }
    if (filterEthereal || filterUnidentify) {
        return false;
    }
    if (favoritesMode || filterFavorites) {
        return filteredRules.length > 0;
    }
    return filteredRules.length > 0 && filteredRules.length === allRules.length;
}

function initRulesSortable() {
    const list = document.getElementById('rulesList');
    if (!list || !window.Sortable) {
        return;
    }

    if (!canReorderRules()) {
        if (rulesSortable) {
            rulesSortable.destroy();
            rulesSortable = null;
        }
        return;
    }

    if (rulesSortable) {
        return;
    }

    rulesSortable = new Sortable(list, {
        animation: 150,
        handle: '.rule-header',
        filter: 'button, .toggle, .value-chip, .rule-comment',
        preventOnFilter: false,
        onEnd: () => {
            const orderedIds = Array.from(list.querySelectorAll('.rule-card'))
                .map(card => card.dataset.ruleId)
                .filter(Boolean);
            const allIds = allRules.map(rule => rule.id);
            if (orderedIds.length === allIds.length) {
                saveRuleOrder(orderedIds);
                return;
            }

            if (!(favoritesMode || filterFavorites)) {
                showToast('Reorder is only available in All or Favorites view.');
                return;
            }

            const orderedSet = new Set(orderedIds);
            const targetIndexes = [];
            allIds.forEach((id, index) => {
                if (orderedSet.has(id)) {
                    targetIndexes.push(index);
                }
            });
            if (targetIndexes.length !== orderedIds.length) {
                showToast('Reorder failed: selection mismatch.');
                return;
            }
            const merged = [...allIds];
            orderedIds.forEach((id, position) => {
                merged[targetIndexes[position]] = id;
            });
            saveRuleOrder(merged);
        },
    });
}

async function saveRuleOrder(orderedIds) {
    if (!currentPickitPath || !currentLoadedFile) {
        showToast('Please load a Pickit file first.');
        return;
    }

    try {
        const response = await fetch(`/api/pickit/files/rules/reorder?path=${encodeURIComponent(currentPickitPath)}&file=${encodeURIComponent(currentLoadedFile)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderedIds }),
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || 'Reorder failed');
        }
        showToast('Order saved.');
        await loadPickitFile();
    } catch (error) {
        showToast('Reorder failed: ' + error.message);
    }
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
