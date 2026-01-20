// Bulk apply settings to multiple supervisors
document.addEventListener('DOMContentLoaded', function () {
    const modal = document.getElementById('supervisorModal');
    const openButtons = [];
    const bulkOpenButton = document.getElementById('bulkApplyOpenBtn');
    const closeButton = document.getElementById('supervisorModalCloseBtn') || (modal && modal.querySelector('.btn-close'));
    const cancelButton = document.getElementById('supervisorModalCancelBtn') || (modal && modal.querySelector('.modal-footer .btn-secondary'));
    const applyButton = document.getElementById('supervisorApplyBtn');
    const supervisorList = document.getElementById('supervisorList');
    const selectAllCheckbox = document.getElementById('selectAllChars');

    if (!modal || !supervisorList || !applyButton) {
        return;
    }
    const applyButtonOriginalText = applyButton.textContent;
    const applyingStatus = document.createElement('div');
    applyingStatus.className = 'bulk-apply-status';
    applyingStatus.textContent = 'Applying settings...';
    applyingStatus.style.display = 'none';
    applyingStatus.style.marginLeft = 'auto';
    applyingStatus.style.marginRight = 'auto';
    applyingStatus.style.marginTop = '8px';
    applyingStatus.style.fontWeight = '600';
    applyingStatus.style.color = '#0d6efd';
    const modalFooter = modal.querySelector('.modal-footer');
    if (modalFooter) {
        modalFooter.appendChild(applyingStatus);
    } else {
        modal.appendChild(applyingStatus);
    }

    function setApplyingState(applying) {
        if (applyButton) {
            applyButton.disabled = applying;
            applyButton.textContent = applying ? 'Applying...' : applyButtonOriginalText;
        }
        if (cancelButton) {
            cancelButton.disabled = applying;
        }
        if (closeButton) {
            closeButton.disabled = applying;
        }
        if (warningApplyAllBtn) {
            warningApplyAllBtn.disabled = applying;
        }
        if (warningExcludeBtn) {
            warningExcludeBtn.disabled = applying;
        }
        if (warningCancelBtn) {
            warningCancelBtn.disabled = applying;
        }
        applyingStatus.style.display = applying ? 'block' : 'none';
    }

    // Track original section values for "changed" indicators
    const initialSectionState = {
        health: '',
        chicken: '',
        merc: '',
        runs: '',
        packet: '',
        cube: '',
        general: '',
        backToTown: '',
        beltLayout: '',
        inventoryLock: '',
        gambling: '',
        client: '',
        scheduler: '',
        // muling/shopping dirty checking not implemented yet, but placeholders can be added if needed
    };
    const sectionDirty = {
        health: false,
        chicken: false,
        merc: false,
        runs: false,
        packet: false,
        cube: false,
        general: false,
        backToTown: false,
        beltLayout: false,
        inventoryLock: false,
        gambling: false,
        client: false,
        scheduler: false,
    };

    const levelingClasses = new Set([
        'sorceress_leveling',
        'paladin',
        'druid_leveling',
        'amazon_leveling',
        'necromancer',
        'assassin',
        'barb_leveling',
    ]);
    const levelingSupervisors = new Set();
    const SECTION_CHECKBOX_IDS = [
        'sectionHealth',
        'sectionChickenOnCursesAuras',
        'sectionMerc',
        'sectionRuns',
        'sectionPacketCasting',
        'sectionCubeRecipes',
        'sectionRunewordMaker',
        'sectionGeneral',
        'sectionBackToTown',
        'sectionBeltLayout',
        'sectionInventoryLock',
        'sectionGambling',
        'sectionClient',
        'sectionScheduler',
        'sectionMuling',   // [Added]
        'sectionShopping', // [Added]
    ];
    let sectionSelectAllCheckbox = null;

    // Custom 3-button warning overlay for leveling supervisors
    const levelingWarningOverlay = document.getElementById('levelingWarningOverlay');
    const levelingWarningMessage = document.getElementById('levelingWarningMessage');
    const levelingWarningTargets = document.getElementById('levelingWarningTargets');
    const warningApplyAllBtn = document.getElementById('levelingWarningApplyAllBtn');
    const warningExcludeBtn = document.getElementById('levelingWarningExcludeBtn');
    const warningCancelBtn = document.getElementById('levelingWarningCancelBtn');

    let pendingApplyState = null;

    function openLevelingWarning(levelingTargets, applyState) {
        if (!levelingWarningOverlay) {
            return;
        }
        pendingApplyState = applyState;

        if (levelingWarningMessage) {
            levelingWarningMessage.textContent =
                'One or more leveling supervisors are selected. Applying these settings may prevent leveling from continuing.';
        }
        if (levelingWarningTargets) {
            const namesList = levelingTargets.join(', ');
            levelingWarningTargets.textContent = levelingTargets.length
                ? `Leveling supervisors: ${namesList}`
                : '';
        }

        levelingWarningOverlay.style.display = 'flex';
    }

    function closeLevelingWarning() {
        if (!levelingWarningOverlay) {
            return;
        }
        levelingWarningOverlay.style.display = 'none';
        pendingApplyState = null;
    }

    function updateSectionSelectAllState() {
        if (!sectionSelectAllCheckbox) {
            return;
        }
        const checkboxes = SECTION_CHECKBOX_IDS
            .map(id => document.getElementById(id))
            .filter(Boolean);
        const total = checkboxes.length;
        if (!total) {
            sectionSelectAllCheckbox.checked = false;
            sectionSelectAllCheckbox.indeterminate = false;
            return;
        }
        const checkedCount = checkboxes.filter(cb => cb.checked).length;
        sectionSelectAllCheckbox.checked = checkedCount === total;
        sectionSelectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < total;
    }

    function snapshotHealthState() {
        const form = document.querySelector('form');
        if (!form) {
            return '';
        }
        const getVal = (name) => {
            const el = form.elements.namedItem(name);
            if (!el) {
                return '';
            }
            if (el.type === 'checkbox') {
                return el.checked ? '1' : '0';
            }
            return el.value ?? '';
        };
        const state = {
            healingPotionAt: getVal('healingPotionAt'),
            manaPotionAt: getVal('manaPotionAt'),
            rejuvPotionAtLife: getVal('rejuvPotionAtLife'),
            rejuvPotionAtMana: getVal('rejuvPotionAtMana'),
            chickenAt: getVal('chickenAt'),
            townChickenAt: getVal('townChickenAt'),
        };
        return JSON.stringify(state);
    }

    function snapshotChickenState() {
        const form = document.querySelector('form');
        if (!form) {
            return '';
        }
        const boolVal = (name) => !!form.querySelector(`input[name="${name}"]`)?.checked;
        const state = {
            chickenAmplifyDamage: boolVal('chickenAmplifyDamage'),
            chickenDecrepify: boolVal('chickenDecrepify'),
            chickenLowerResist: boolVal('chickenLowerResist'),
            chickenBloodMana: boolVal('chickenBloodMana'),
            chickenFanaticism: boolVal('chickenFanaticism'),
            chickenMight: boolVal('chickenMight'),
            chickenConviction: boolVal('chickenConviction'),
            chickenHolyFire: boolVal('chickenHolyFire'),
            chickenBlessedAim: boolVal('chickenBlessedAim'),
            chickenHolyFreeze: boolVal('chickenHolyFreeze'),
            chickenHolyShock: boolVal('chickenHolyShock'),
        };
        return JSON.stringify(state);
    }

    function snapshotMercState() {
        const form = document.querySelector('form');
        if (!form) {
            return '';
        }
        const getVal = (name) => {
            const el = form.elements.namedItem(name);
            if (!el) {
                return '';
            }
            if (el.type === 'checkbox') {
                return el.checked ? '1' : '0';
            }
            return el.value ?? '';
        };
        const state = {
            useMerc: getVal('useMerc'),
            mercHealingPotionAt: getVal('mercHealingPotionAt'),
            mercRejuvPotionAt: getVal('mercRejuvPotionAt'),
            mercChickenAt: getVal('mercChickenAt'),
        };
        return JSON.stringify(state);
    }

    function snapshotBackToTownState() {
        const form = document.querySelector('form');
        if (!form) {
            return '';
        }
        const boolVal = (name) => !!form.querySelector(`input[name="${name}"]`)?.checked;
        const state = {
            noHpPotions: boolVal('noHpPotions'),
            noMpPotions: boolVal('noMpPotions'),
            mercDied: boolVal('mercDied'),
            equipmentBroken: boolVal('equipmentBroken'),
        };
        return JSON.stringify(state);
    }

    function snapshotBeltLayoutState() {
        const form = document.querySelector('form');
        if (!form) {
            return '';
        }
        const selects = Array.from(form.querySelectorAll('select[name="inventoryBeltColumns[]"]'));
        const state = selects.map(el => el.value || '');
        return JSON.stringify(state);
    }

    function snapshotInventoryLockState() {
        const form = document.querySelector('form');
        if (!form) {
            return '';
        }
        const inputs = Array.from(form.querySelectorAll('input[name^="inventoryLock["]'));
        const state = inputs.map(el => [el.name, el.checked ? 1 : 0]);
        state.sort((a, b) => a[0].localeCompare(b[0]));
        return JSON.stringify(state);
    }

    function snapshotGamblingState() {
        const form = document.querySelector('form');
        if (!form) {
            return '';
        }
        const boolVal = (name) => !!form.querySelector(`input[name="${name}"]`)?.checked;
        const inputVal = (name) => {
            const el = form.elements.namedItem(name);
            return el ? (el.value || '') : '';
        };
        const state = {
            gamblingEnabled: boolVal('gamblingEnabled'),
            gamblingItems: inputVal('gamblingItems'),
        };
        return JSON.stringify(state);
    }

    function snapshotRunsState() {
        const runsInput = document.getElementById('gameRuns');
        return runsInput ? (runsInput.value || '') : '';
    }

    function snapshotPacketState() {
        const state = {
            useForItemPickup: !!document.querySelector('input[name="packetCastingUseForItemPickup"]')?.checked,
            useForTpInteraction: !!document.querySelector('input[name="packetCastingUseForTpInteraction"]')?.checked,
            useForEntranceInteraction: !!document.querySelector('input[name="packetCastingUseForEntranceInteraction"]')?.checked,
            useForTeleport: !!document.querySelector('input[name="packetCastingUseForTeleport"]')?.checked,
            useForEntitySkills: !!document.querySelector('input[name="packetCastingUseForEntitySkills"]')?.checked,
            useForSkillSelection: !!document.querySelector('input[name="packetCastingUseForSkillSelection"]')?.checked,
        };
        return JSON.stringify(state);
    }

    function snapshotCubeState() {
        const enabled = !!document.querySelector('input[name="enableCubeRecipes"]')?.checked;
        const skipPerfectAmethysts = !!document.querySelector('input[name="skipPerfectAmethysts"]')?.checked;
        const skipPerfectRubies = !!document.querySelector('input[name="skipPerfectRubies"]')?.checked;
        const jewelsToKeepInput = document.querySelector('input[name="jewelsToKeep"]');
        const jewelsToKeep = jewelsToKeepInput ? jewelsToKeepInput.value || '' : '';
        const enabledRecipeInputs = document.querySelectorAll('input[name="enabledRecipes"]:checked');
        const enabledRecipes = Array.from(enabledRecipeInputs)
            .map(el => el.value)
            .filter(Boolean)
            .sort();
        const state = {
            enabled,
            skipPerfectAmethysts,
            skipPerfectRubies,
            jewelsToKeep,
            enabledRecipes,
        };
        return JSON.stringify(state);
    }

    function snapshotGeneralState() {
        const form = document.querySelector('form');
        if (!form) {
            return '';
        }
        const boolVal = (name) => !!form.querySelector(`input[name="${name}"]`)?.checked;
        const inputVal = (name) => {
            const el = form.elements.namedItem(name);
            return el ? (el.value || '') : '';
        };
        const state = {
            characterUseExtraBuffs: boolVal('characterUseExtraBuffs'),
            characterUseTeleport: boolVal('characterUseTeleport'),
            characterStashToShared: boolVal('characterStashToShared'),
            useCentralizedPickit: boolVal('useCentralizedPickit'),
            interactWithShrines: boolVal('interactWithShrines'),
            interactWithChests: boolVal('interactWithChests'),
            stopLevelingAt: inputVal('stopLevelingAt'),
            gameMinGoldPickupThreshold: inputVal('gameMinGoldPickupThreshold'),
            useCainIdentify: boolVal('useCainIdentify'),
            disableIdentifyTome: boolVal('game.disableIdentifyTome'),
        };
        return JSON.stringify(state);
    }

    function snapshotClientState() {
        const form = document.querySelector('form');
        if (!form) {
            return '';
        }
        const inputVal = (name) => {
            const el = form.elements.namedItem(name);
            return el ? (el.value || '') : '';
        };
        const boolVal = (name) => !!form.querySelector(`input[name="${name}"]`)?.checked;

        const state = {
            commandLineArgs: inputVal('commandLineArgs'),
            killD2OnStop: boolVal('kill_d2_process'),
            classicMode: boolVal('classic_mode'),
            hidePortraits: boolVal('hide_portraits'),
        };
        return JSON.stringify(state);
    }

    function snapshotSchedulerState() {
        const form = document.querySelector('form');
        if (!form) {
            return '';
        }
        const fd = new FormData(form);
        const pairs = [];
        fd.forEach((value, key) => {
            if (key && (key.startsWith('scheduler') || key === 'schedulerEnabled')) {
                pairs.push([key, String(value)]);
            }
        });
        pairs.sort((a, b) => {
            if (a[0] === b[0]) {
                return a[1].localeCompare(b[1]);
            }
            return a[0].localeCompare(b[0]);
        });
        return JSON.stringify(pairs);
    }

    function refreshSectionDirtyIndicators() {
        const healthCheckbox = document.getElementById('sectionHealth');
        const chickenCheckbox = document.getElementById('sectionChickenOnCursesAuras');
        const mercCheckbox = document.getElementById('sectionMerc');
        const runCheckbox = document.getElementById('sectionRuns');
        const packetCheckbox = document.getElementById('sectionPacketCasting');
        const cubeCheckbox = document.getElementById('sectionCubeRecipes');
        const generalCheckbox = document.getElementById('sectionGeneral');
        const backToTownCheckbox = document.getElementById('sectionBackToTown');
        const beltLayoutCheckbox = document.getElementById('sectionBeltLayout');
        const inventoryLockCheckbox = document.getElementById('sectionInventoryLock');
        const gamblingCheckbox = document.getElementById('sectionGambling');
        const clientCheckbox = document.getElementById('sectionClient');
        const schedulerCheckbox = document.getElementById('sectionScheduler');
        // Muling/Shopping labels not yet tracked for dirty state, so skipped here.

        const healthLabelSpan = healthCheckbox && healthCheckbox.nextElementSibling;
        const chickenLabelSpan = chickenCheckbox && chickenCheckbox.nextElementSibling;
        const mercLabelSpan = mercCheckbox && mercCheckbox.nextElementSibling;
        const runLabelSpan = runCheckbox && runCheckbox.nextElementSibling;
        const packetLabelSpan = packetCheckbox && packetCheckbox.nextElementSibling;
        const cubeLabelSpan = cubeCheckbox && cubeCheckbox.nextElementSibling;
        const generalLabelSpan = generalCheckbox && generalCheckbox.nextElementSibling;
        const backToTownLabelSpan = backToTownCheckbox && backToTownCheckbox.nextElementSibling;
        const beltLayoutLabelSpan = beltLayoutCheckbox && beltLayoutCheckbox.nextElementSibling;
        const inventoryLockLabelSpan = inventoryLockCheckbox && inventoryLockCheckbox.nextElementSibling;
        const gamblingLabelSpan = gamblingCheckbox && gamblingCheckbox.nextElementSibling;
        const clientLabelSpan = clientCheckbox && clientCheckbox.nextElementSibling;
        const schedulerLabelSpan = schedulerCheckbox && schedulerCheckbox.nextElementSibling;

        if (healthLabelSpan) {
            if (sectionDirty.health) {
                healthLabelSpan.classList.add('section-dirty');
            } else {
                healthLabelSpan.classList.remove('section-dirty');
            }
        }
        if (chickenLabelSpan) {
            if (sectionDirty.chicken) {
                chickenLabelSpan.classList.add('section-dirty');
            } else {
                chickenLabelSpan.classList.remove('section-dirty');
            }
        }
        if (runLabelSpan) {
            if (sectionDirty.runs) {
                runLabelSpan.classList.add('section-dirty');
            } else {
                runLabelSpan.classList.remove('section-dirty');
            }
        }
        if (mercLabelSpan) {
            if (sectionDirty.merc) {
                mercLabelSpan.classList.add('section-dirty');
            } else {
                mercLabelSpan.classList.remove('section-dirty');
            }
        }
        if (packetLabelSpan) {
            if (sectionDirty.packet) {
                packetLabelSpan.classList.add('section-dirty');
            } else {
                packetLabelSpan.classList.remove('section-dirty');
            }
        }
        if (cubeLabelSpan) {
            if (sectionDirty.cube) {
                cubeLabelSpan.classList.add('section-dirty');
            } else {
                cubeLabelSpan.classList.remove('section-dirty');
            }
        }
        if (generalLabelSpan) {
            if (sectionDirty.general) {
                generalLabelSpan.classList.add('section-dirty');
            } else {
                generalLabelSpan.classList.remove('section-dirty');
            }
        }
        if (backToTownLabelSpan) {
            if (sectionDirty.backToTown) {
                backToTownLabelSpan.classList.add('section-dirty');
            } else {
                backToTownLabelSpan.classList.remove('section-dirty');
            }
        }
        if (beltLayoutLabelSpan) {
            if (sectionDirty.beltLayout) {
                beltLayoutLabelSpan.classList.add('section-dirty');
            } else {
                beltLayoutLabelSpan.classList.remove('section-dirty');
            }
        }
        if (inventoryLockLabelSpan) {
            if (sectionDirty.inventoryLock) {
                inventoryLockLabelSpan.classList.add('section-dirty');
            } else {
                inventoryLockLabelSpan.classList.remove('section-dirty');
            }
        }
        if (gamblingLabelSpan) {
            if (sectionDirty.gambling) {
                gamblingLabelSpan.classList.add('section-dirty');
            } else {
                gamblingLabelSpan.classList.remove('section-dirty');
            }
        }
        if (clientLabelSpan) {
            if (sectionDirty.client) {
                clientLabelSpan.classList.add('section-dirty');
            } else {
                clientLabelSpan.classList.remove('section-dirty');
            }
        }
        if (schedulerLabelSpan) {
            if (sectionDirty.scheduler) {
                schedulerLabelSpan.classList.add('section-dirty');
            } else {
                schedulerLabelSpan.classList.remove('section-dirty');
            }
        }
    }

    function updateHealthDirty() {
        const current = snapshotHealthState();
        sectionDirty.health = current !== initialSectionState.health;
        refreshSectionDirtyIndicators();
    }

    function updateChickenDirty() {
        const current = snapshotChickenState();
        sectionDirty.chicken = current !== initialSectionState.chicken;
        refreshSectionDirtyIndicators();
    }

    function updateMercDirty() {
        const current = snapshotMercState();
        sectionDirty.merc = current !== initialSectionState.merc;
        refreshSectionDirtyIndicators();
    }

    function updateBackToTownDirty() {
        const current = snapshotBackToTownState();
        sectionDirty.backToTown = current !== initialSectionState.backToTown;
        refreshSectionDirtyIndicators();
    }

    function updateBeltLayoutDirty() {
        const current = snapshotBeltLayoutState();
        sectionDirty.beltLayout = current !== initialSectionState.beltLayout;
        refreshSectionDirtyIndicators();
    }

    function updateInventoryLockDirty() {
        const current = snapshotInventoryLockState();
        sectionDirty.inventoryLock = current !== initialSectionState.inventoryLock;
        refreshSectionDirtyIndicators();
    }

    function updateGamblingDirty() {
        const current = snapshotGamblingState();
        sectionDirty.gambling = current !== initialSectionState.gambling;
        refreshSectionDirtyIndicators();
    }

    function updateRunsDirty() {
        const current = snapshotRunsState();
        // First invocation just captures the initial state as baseline
        if (!initialSectionState.runs) {
            initialSectionState.runs = current;
            sectionDirty.runs = false;
        } else {
            sectionDirty.runs = current !== initialSectionState.runs;
        }
        refreshSectionDirtyIndicators();
    }

    function updatePacketDirty() {
        const current = snapshotPacketState();
        sectionDirty.packet = current !== initialSectionState.packet;
        refreshSectionDirtyIndicators();
    }

    function updateCubeDirty() {
        const current = snapshotCubeState();
        sectionDirty.cube = current !== initialSectionState.cube;
        refreshSectionDirtyIndicators();
    }

    function updateGeneralDirty() {
        const current = snapshotGeneralState();
        sectionDirty.general = current !== initialSectionState.general;
        refreshSectionDirtyIndicators();
    }

    function updateClientDirty() {
        const current = snapshotClientState();
        sectionDirty.client = current !== initialSectionState.client;
        refreshSectionDirtyIndicators();
    }

    function updateSchedulerDirty() {
        const current = snapshotSchedulerState();
        sectionDirty.scheduler = current !== initialSectionState.scheduler;
        refreshSectionDirtyIndicators();
    }

    // Initialize snapshots
    initialSectionState.health = snapshotHealthState();
    initialSectionState.chicken = snapshotChickenState();
    initialSectionState.merc = snapshotMercState();
    initialSectionState.backToTown = snapshotBackToTownState();
    initialSectionState.beltLayout = snapshotBeltLayoutState();
    initialSectionState.inventoryLock = snapshotInventoryLockState();
    initialSectionState.gambling = snapshotGamblingState();
    initialSectionState.packet = snapshotPacketState();
    initialSectionState.cube = snapshotCubeState();
    initialSectionState.general = snapshotGeneralState();
    initialSectionState.client = snapshotClientState();
    initialSectionState.scheduler = snapshotSchedulerState();
    refreshSectionDirtyIndicators();

    if (bulkOpenButton) {
        openButtons.push(bulkOpenButton);
    }

    function openModal() {
        modal.style.display = 'flex';
    }

    function closeModal() {
        modal.style.display = 'none';
    }

    openButtons.forEach(btn => {
        btn.addEventListener('click', openModal);
    });

    if (closeButton) {
        closeButton.addEventListener('click', closeModal);
    }
    if (cancelButton) {
        cancelButton.addEventListener('click', closeModal);
    }

    // Normalize button labels to English for global use
    if (cancelButton) {
        cancelButton.textContent = 'Cancel';
    }
    if (applyButton) {
        applyButton.textContent = 'Apply';
    }

    // Initialize section selection UI inside the modal
    const sectionContainer = modal.querySelector('.modal-body .mb-2');
    if (sectionContainer) {
        sectionContainer.innerHTML = ''
            + '<div class="supervisor-header-row">'
            + '  <strong>Select settings</strong>'
            + '  <label class="supervisor-select-all" for="sectionSelectAll">'
            + '    <input type="checkbox" id="sectionSelectAll">'
            + '    <span>Select all settings</span>'
            + '  </label>'
            + '</div>'
            + '<div class="supervisor-section-toggles">'
            + '  <label>'
            + '    <input type="checkbox" id="sectionHealth">'
            + '    <span>Health settings</span>'
            + '  </label>'
            + '  <label>'
            + '    <input type="checkbox" id="sectionChickenOnCursesAuras">'
            + '    <span>Chicken on Curses/Auras</span>'
            + '  </label>'
            + '  <label>'
            + '    <input type="checkbox" id="sectionMerc">'
            + '    <span>Merc settings</span>'
            + '  </label>'
            + '  <label>'
            + '    <input type="checkbox" id="sectionRuns">'
            + '    <span>Run settings</span>'
            + '  </label>'
            + '  <label>'
            + '    <input type="checkbox" id="sectionPacketCasting">'
            + '    <span>Using Packets</span>'
            + '  </label>'
            + '  <label>'
            + '    <input type="checkbox" id="sectionCubeRecipes">'
            + '    <span>Cube recipes</span>'
            + '  </label>'
            + '  <label>'
            + '    <input type="checkbox" id="sectionRunewordMaker">'
            + '    <span>Runeword settings</span>'
            + '  </label>'
            + '  <label>'
            + '    <input type="checkbox" id="sectionGeneral">'
            + '    <span>General settings</span>'
            + '  </label>'
            + '  <label>'
            + '    <input type="checkbox" id="sectionBackToTown">'
            + '    <span>Back to Town settings</span>'
            + '  </label>'
            + '  <label>'
            + '    <input type="checkbox" id="sectionBeltLayout">'
            + '    <span>Belt layout</span>'
            + '  </label>'
            + '  <label>'
            + '    <input type="checkbox" id="sectionInventoryLock">'
            + '    <span>Inventory lock</span>'
            + '  </label>'
            + '  <label>'
            + '    <input type="checkbox" id="sectionGambling">'
            + '    <span>Gambling settings</span>'
            + '  </label>'
            + '  <label>'
            + '    <input type="checkbox" id="sectionClient">'
            + '    <span>Client settings</span>'
            + '  </label>'
            + '  <label>'
            + '    <input type="checkbox" id="sectionScheduler">'
            + '    <span>Scheduler settings</span>'
            + '  </label>'
            + '  <label>'
            + '    <input type="checkbox" id="sectionMuling">'
            + '    <span>Muling settings</span>'
            + '  </label>'
            + '  <label>'
            + '    <input type="checkbox" id="sectionShopping">'
            + '    <span>Shopping settings</span>'
            + '  </label>'
            + '</div>'
            + '<div class="run-detail-toggles">'
            + '  <span class="run-detail-title">Run detail options to copy (optional):</span>'
            + '  <div class="run-detail-grid" id="runDetailGrid"></div>'
            + '</div>';
    }

    sectionSelectAllCheckbox = document.getElementById('sectionSelectAll');
    SECTION_CHECKBOX_IDS.forEach((id) => {
        const cb = document.getElementById(id);
        if (cb) {
            cb.addEventListener('change', updateSectionSelectAllState);
        }
    });
    if (sectionSelectAllCheckbox) {
        sectionSelectAllCheckbox.addEventListener('change', function () {
            const targetState = sectionSelectAllCheckbox.checked;
            SECTION_CHECKBOX_IDS.forEach((id) => {
                const checkbox = document.getElementById(id);
                if (checkbox) {
                    checkbox.checked = targetState;
                    checkbox.dispatchEvent(new Event('change'));
                }
            });
            sectionSelectAllCheckbox.indeterminate = false;
            sectionSelectAllCheckbox.checked = targetState;
        });
        updateSectionSelectAllState();
    }

    const runDetailToggles = modal.querySelector('.run-detail-toggles');
    const runDetailGrid = modal.querySelector('#runDetailGrid');

    const SUPPORTED_RUN_DETAILS = [
        { id: 'pit', label: 'Pit' },
        { id: 'andariel', label: 'Andariel' },
        { id: 'duriel', label: 'Duriel' },
        { id: 'countess', label: 'Countess' },
        { id: 'cows', label: 'Cows' },
        { id: 'pindleskin', label: 'Pindleskin' },
        { id: 'stony_tomb', label: 'Stony Tomb' },
        { id: 'mausoleum', label: 'Mausoleum' },
        { id: 'summoner', label: 'Summoner' },
        { id: 'ancient_tunnels', label: 'Ancient Tunnels' },
        { id: 'drifter_cavern', label: 'Drifter Cavern' },
        { id: 'spider_cavern', label: 'Spider Cavern' },
        { id: 'arachnid_lair', label: 'Arachnid Lair' },
        { id: 'mephisto', label: 'Mephisto' },
        { id: 'tristram', label: 'Tristram' },
        { id: 'nihlathak', label: 'Nihlathak' },
        { id: 'baal', label: 'Baal' },
        { id: 'eldritch', label: 'Eldritch' },
        { id: 'lower_kurast_chest', label: 'Lower Kurast Chest' },
        { id: 'diablo', label: 'Diablo' },
        { id: 'leveling', label: 'Leveling' },
        { id: 'leveling_sequence', label: 'Leveling sequence' },
        { id: 'quests', label: 'Quests' },
        { id: 'terror_zone', label: 'Terror Zone' },
        { id: 'utility', label: 'Utility' },
        { id: 'shopping', label: 'Shopping' },
    ];

    let runDetailToggleButton = null;

    function rebuildRunDetailOptions() {
        if (!runDetailGrid || !runDetailToggles) {
            return;
        }

        runDetailGrid.innerHTML = '';

        const runsInput = document.getElementById('gameRuns');
        if (!runsInput || !runsInput.value) {
            runDetailToggles.classList.remove('open');
            return;
        }

        let enabledRuns;
        try {
            enabledRuns = JSON.parse(runsInput.value);
        } catch (_e) {
            enabledRuns = [];
        }
        if (!Array.isArray(enabledRuns)) {
            enabledRuns = [];
        }

        const enabledSet = new Set(enabledRuns);

        SUPPORTED_RUN_DETAILS.forEach((run) => {
            if (!enabledSet.has(run.id)) {
                return;
            }
            const label = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.className = 'run-detail-checkbox';
            input.setAttribute('data-run-id', run.id);
            label.appendChild(input);
            label.appendChild(document.createTextNode(' ' + run.label));
            runDetailGrid.appendChild(label);
        });

        updateRunDetailVisibility();
    }

    function updateRunDetailVisibility() {
        if (!runDetailToggles || !runDetailGrid) {
            return;
        }
        const runCheckbox = document.getElementById('sectionRuns');
        const hasAny = runDetailGrid.children.length > 0;
        const enabled = !!(runCheckbox && runCheckbox.checked && hasAny);

        if (runDetailToggleButton) {
            if (enabled) {
                runDetailToggleButton.classList.remove('disabled');
                runDetailToggleButton.classList.add('visible');
            } else {
                runDetailToggleButton.classList.add('disabled');
                runDetailToggleButton.classList.remove('visible');
            }
        }

        if (!enabled) {
            runDetailToggles.classList.remove('open');
        }
    }

    const runsSectionCheckbox = document.getElementById('sectionRuns');
    if (runsSectionCheckbox) {
        runsSectionCheckbox.addEventListener('change', updateRunDetailVisibility);

        const runLabelSpan = runsSectionCheckbox.nextElementSibling;
        if (runLabelSpan && runLabelSpan.parentElement) {
            runDetailToggleButton = document.createElement('button');
            runDetailToggleButton.type = 'button';
            runDetailToggleButton.className = 'run-detail-toggle-btn disabled';
            runDetailToggleButton.innerHTML = '<i class="bi bi-sliders"></i>';
            runDetailToggleButton.setAttribute('aria-label', 'Configure run details');
            runDetailToggleButton.title = 'Configure run details';
            runLabelSpan.parentElement.appendChild(runDetailToggleButton);

            runDetailToggleButton.addEventListener('click', function () {
                if (!runDetailToggles) {
                    return;
                }
                const isOpen = runDetailToggles.classList.contains('open');
                if (isOpen) {
                    runDetailToggles.classList.remove('open');
                } else {
                    runDetailToggles.classList.add('open');
                }
                updateRunDetailVisibility();
            });
        }
    }

    // Fix label text for "select all" if it contains garbled characters
      const selectAllLabelText = selectAllCheckbox
          ? document.querySelector('label[for="selectAllChars"] span')
          : null;
      if (selectAllLabelText) {
          selectAllLabelText.textContent = 'Select all supervisors';
      }

    // Load supervisor list from initial-data endpoint
    async function populateSupervisorList() {
        try {
            const response = await fetch('/initial-data?skipAutoStartPrompt=true', {
                headers: { 'Accept': 'application/json' },
            });
            if (!response.ok) {
                return;
            }
            const data = await response.json();
            const status = data && data.Status ? data.Status : {};
            const names = Object.keys(status);
            names.sort();

            supervisorList.innerHTML = '';

            const currentSupervisorInput = document.querySelector('input[name="name"]');
            const currentSupervisorName = currentSupervisorInput ? currentSupervisorInput.value : '';

            names.forEach(name => {
                if (!name) {
                    return;
                }
                const wrapper = document.createElement('div');
                wrapper.className = 'form-check';

                const input = document.createElement('input');
                input.type = 'checkbox';
                input.className = 'form-check-input supervisor-checkbox';
                input.id = `sup-${name}`;
                input.value = name;

                const label = document.createElement('label');
                label.className = 'form-check-label';
                label.htmlFor = input.id;
                label.textContent = name;

                if (currentSupervisorName && name === currentSupervisorName) {
                    label.classList.add('current-supervisor');
                    label.title = 'Current supervisor (this page)';
                }

                const info = status[name];
                const cls = info && info.UI && info.UI.Class ? String(info.UI.Class) : '';
                if (cls && levelingClasses.has(cls)) {
                    levelingSupervisors.add(name);
                    label.classList.add('leveling-supervisor');
                    if (!label.title) {
                        label.title = 'Leveling profile';
                    } else {
                        label.title += ' • Leveling profile';
                    }
                }

                wrapper.appendChild(input);
                wrapper.appendChild(label);
                supervisorList.appendChild(wrapper);
            });
        } catch (error) {
            console.error('Failed to populate supervisor list', error);
        }
    }

    void populateSupervisorList();

    // Track changes in sections to mark as "dirty"
    const HEALTH_FIELD_NAMES = new Set([
        'healingPotionAt',
        'manaPotionAt',
        'rejuvPotionAtLife',
        'rejuvPotionAtMana',
        'chickenAt',
        'townChickenAt',
    ]);

    const MERC_FIELD_NAMES = new Set([
        'useMerc',
        'mercHealingPotionAt',
        'mercRejuvPotionAt',
        'mercChickenAt',
    ]);

    const CUBE_FIELD_NAMES = new Set([
        'enableCubeRecipes',
        'skipPerfectAmethysts',
        'skipPerfectRubies',
        'jewelsToKeep',
        'enabledRecipes',
    ]);

    const CHICKEN_FIELD_NAMES = new Set([
        'chickenAmplifyDamage',
        'chickenDecrepify',
        'chickenLowerResist',
        'chickenBloodMana',
        'chickenFanaticism',
        'chickenMight',
        'chickenConviction',
        'chickenHolyFire',
        'chickenBlessedAim',
        'chickenHolyFreeze',
        'chickenHolyShock',
    ]);

    const BACK_TO_TOWN_FIELD_NAMES = new Set([
        'noHpPotions',
        'noMpPotions',
        'mercDied',
        'equipmentBroken',
    ]);

    const GAMBLING_FIELD_NAMES = new Set([
        'gamblingEnabled',
        'gamblingItems',
    ]);

    const GENERAL_FIELD_NAMES = new Set([
        'characterUseExtraBuffs',
        'characterUseTeleport',
        'characterStashToShared',
        'useCentralizedPickit',
        'interactWithShrines',
        'interactWithChests',
        'stopLevelingAt',
        'gameMinGoldPickupThreshold',
        'useCainIdentify',
        'game.disableIdentifyTome',
    ]);

    const CLIENT_FIELD_NAMES = new Set([
        'commandLineArgs',
        'kill_d2_process',
        'classic_mode',
        'hide_portraits',
    ]);

    document.addEventListener('change', function (event) {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
            return;
        }

        if (HEALTH_FIELD_NAMES.has(target.name)) {
            updateHealthDirty();
            return;
        }

        if (CHICKEN_FIELD_NAMES.has(target.name)) {
            updateChickenDirty();
            return;
        }

        if (MERC_FIELD_NAMES.has(target.name)) {
            updateMercDirty();
            return;
        }

        if (BACK_TO_TOWN_FIELD_NAMES.has(target.name)) {
            updateBackToTownDirty();
            return;
        }

        if (target.name === 'inventoryBeltColumns[]') {
            updateBeltLayoutDirty();
            return;
        }

        if (target.name && target.name.startsWith('inventoryLock[')) {
            updateInventoryLockDirty();
            return;
        }

        if (GAMBLING_FIELD_NAMES.has(target.name)) {
            updateGamblingDirty();
            return;
        }

        if (target.name && target.name.startsWith('packetCastingUseFor')) {
            updatePacketDirty();
            return;
        }

        if (CUBE_FIELD_NAMES.has(target.name)) {
            updateCubeDirty();
            return;
        }

        if (GENERAL_FIELD_NAMES.has(target.name)) {
            updateGeneralDirty();
            return;
        }

        if (CLIENT_FIELD_NAMES.has(target.name)) {
            updateClientDirty();
            return;
        }

        if (target.name && (target.name === 'schedulerEnabled' || target.name.startsWith('scheduler'))) {
            updateSchedulerDirty();
        }
    });

    document.addEventListener('click', function (event) {
        const btn = event.target.closest('.col-lock-btn');
        if (!btn) {
            return;
        }
        updateInventoryLockDirty();
    });

    // Called from updateEnabledRunsHiddenField whenever the run list changes
    window.onGameRunsUpdated = function () {
        updateRunsDirty();
        rebuildRunDetailOptions();
    };

    if (selectAllCheckbox) {
        selectAllCheckbox.addEventListener('change', function () {
            const checkboxes = supervisorList.querySelectorAll('.supervisor-checkbox');
            checkboxes.forEach(cb => {
                cb.checked = selectAllCheckbox.checked;
            });
        });
    }

    function collectFormAsJson() {
        const form = document.querySelector('form');
        const fd = new FormData(form);
        const result = {};

        fd.forEach((value, key) => {
            const asString = String(value);
            if (!Object.prototype.hasOwnProperty.call(result, key)) {
                result[key] = [asString];
            } else {
                result[key].push(asString);
            }
        });

        return result;
    }

    function getSectionsSelection() {
        const healthCheckbox = document.getElementById('sectionHealth');
        const chickenCheckbox = document.getElementById('sectionChickenOnCursesAuras');
        const mercCheckbox = document.getElementById('sectionMerc');
        const runsCheckbox = document.getElementById('sectionRuns');
        const packetCheckbox = document.getElementById('sectionPacketCasting');
        const cubeCheckbox = document.getElementById('sectionCubeRecipes');
        const runewordCheckbox = document.getElementById('sectionRunewordMaker');
        const generalCheckbox = document.getElementById('sectionGeneral');
        const backToTownCheckbox = document.getElementById('sectionBackToTown');
        const beltLayoutCheckbox = document.getElementById('sectionBeltLayout');
        const inventoryLockCheckbox = document.getElementById('sectionInventoryLock');
        const gamblingCheckbox = document.getElementById('sectionGambling');
        const clientCheckbox = document.getElementById('sectionClient');
        const schedulerCheckbox = document.getElementById('sectionScheduler');
        const mulingCheckbox = document.getElementById('sectionMuling');     // [Added]
        const shoppingCheckbox = document.getElementById('sectionShopping'); // [Added]

        return {
            health: !!(healthCheckbox && healthCheckbox.checked),
            chickenOnCursesAuras: !!(chickenCheckbox && chickenCheckbox.checked),
            merc: !!(mercCheckbox && mercCheckbox.checked),
            runs: !!(runsCheckbox && runsCheckbox.checked),
            packetCasting: !!(packetCheckbox && packetCheckbox.checked),
            cubeRecipes: !!(cubeCheckbox && cubeCheckbox.checked),
            runewordMaker: !!(runewordCheckbox && runewordCheckbox.checked),
            general: !!(generalCheckbox && generalCheckbox.checked),
            backToTown: !!(backToTownCheckbox && backToTownCheckbox.checked),
            beltLayout: !!(beltLayoutCheckbox && beltLayoutCheckbox.checked),
            inventoryLock: !!(inventoryLockCheckbox && inventoryLockCheckbox.checked),
            gambling: !!(gamblingCheckbox && gamblingCheckbox.checked),
            client: !!(clientCheckbox && clientCheckbox.checked),
            scheduler: !!(schedulerCheckbox && schedulerCheckbox.checked),
            muling: !!(mulingCheckbox && mulingCheckbox.checked),       // [Added]
            shopping: !!(shoppingCheckbox && shoppingCheckbox.checked), // [Added]
        };
    }

    function collectRunDetailTargets() {
        if (!modal) {
            return [];
        }
        const checkboxes = modal.querySelectorAll('.run-detail-checkbox:checked');
        return Array.from(checkboxes)
            .map(cb => cb.getAttribute('data-run-id') || '')
            .filter(Boolean);
    }

    async function sendBulkApply(currentSupervisor, targetSupervisors, sections, runDetailTargets) {
        const payload = {
            sourceSupervisor: currentSupervisor,
            targetSupervisors: targetSupervisors,
            sections: sections,
            runDetailTargets: runDetailTargets,
            form: collectFormAsJson(),
        };

        try {
            setApplyingState(true);
            const response = await fetch('/api/supervisors/bulk-apply', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const message = await response.text();
                throw new Error(message || `Bulk apply failed (${response.status})`);
            }

            const data = await response.json().catch(() => ({}));
            if (data && data.success === false) {
                const errors = Array.isArray(data.errors) ? data.errors : [];
                if (errors.length > 0) {
                    const names = errors
                        .map(err => (err && err.supervisor ? String(err.supervisor) : ''))
                        .filter(Boolean);
                    console.error('Bulk apply failures', errors);
                    if (names.length > 0) {
                        alert(`Failed to apply settings for: ${names.join(', ')}. Please check the logs for details.`);
                    } else {
                        alert('Failed to apply settings. Please check the logs for details.');
                    }
                } else {
                    alert(data.error || 'Failed to apply settings. Please check the logs for details.');
                }
                return;
            }

            alert('Settings were applied to the selected supervisors.');
            closeModal();
        } catch (error) {
            console.error('Failed to bulk apply settings', error);
            alert('Failed to apply settings. Please check the logs for details.');
        } finally {
            setApplyingState(false);
        }
    }

    if (warningCancelBtn) {
        warningCancelBtn.addEventListener('click', function () {
            closeLevelingWarning();
        });
    }

    if (warningApplyAllBtn) {
        warningApplyAllBtn.addEventListener('click', async function () {
            if (!pendingApplyState) {
                closeLevelingWarning();
                return;
            }
            const { currentSupervisor, targetSupervisors, sections, runDetailTargets } = pendingApplyState;
            closeLevelingWarning();
            await sendBulkApply(currentSupervisor, targetSupervisors, sections, runDetailTargets);
        });
    }

    if (warningExcludeBtn) {
        warningExcludeBtn.addEventListener('click', async function () {
            if (!pendingApplyState) {
                closeLevelingWarning();
                return;
            }
            const { currentSupervisor, targetSupervisors, sections, runDetailTargets } = pendingApplyState;
            const filteredTargets = targetSupervisors.filter(function (name) {
                return !levelingSupervisors.has(name);
            });
            if (filteredTargets.length === 0) {
                alert('Only leveling supervisors are selected. There are no remaining targets.');
                closeLevelingWarning();
                return;
            }
            closeLevelingWarning();
            await sendBulkApply(currentSupervisor, filteredTargets, sections, runDetailTargets);
        });
    }

    applyButton.addEventListener('click', async function () {
        const supervisorNameInput = document.querySelector('input[name="name"]');
        const currentSupervisor = supervisorNameInput ? supervisorNameInput.value : '';
        if (!currentSupervisor) {
            alert('Supervisor name is empty.');
            return;
        }

        // New flow: use custom leveling warning overlay with 3 options
        const selectedSupervisorElemsNew = supervisorList.querySelectorAll('.supervisor-checkbox:checked');
        const targetSupervisorsNew = Array.from(selectedSupervisorElemsNew)
            .map(cb => cb.value)
            .filter(name => !!name && name !== currentSupervisor);

        if (targetSupervisorsNew.length === 0) {
            alert('Please select at least one supervisor.');
            return;
        }

        const sectionsNew = getSectionsSelection();
        const anySelectedNew = Object.values(sectionsNew).some(Boolean);
        if (!anySelectedNew) {
            alert('Please select at least one section to apply.');
            return;
        }

        const runDetailTargetsNew = sectionsNew.runs ? collectRunDetailTargets() : [];
        const levelingTargetsNew = targetSupervisorsNew.filter(function (name) {
            return levelingSupervisors.has(name);
        });

        if (levelingTargetsNew.length > 0) {
            openLevelingWarning(levelingTargetsNew, {
                currentSupervisor: currentSupervisor,
                targetSupervisors: targetSupervisorsNew,
                sections: sectionsNew,
                runDetailTargets: runDetailTargetsNew,
            });
        } else {
            await sendBulkApply(currentSupervisor, targetSupervisorsNew, sectionsNew, runDetailTargetsNew);
        }

    });
});
