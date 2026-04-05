/* ========================================
   Menu System
   Screen transitions, settings, audio lifecycle,
   and level selection.
   ======================================== */

const Menu = (() => {
    const screens = {
        mainMenu:    document.getElementById('main-menu'),
        levelSelect: document.getElementById('level-select'),
        options:     document.getElementById('options-menu'),
        game:        document.getElementById('game-screen'),
        loading:     document.getElementById('loading-screen'),
    };

    const btnStart      = document.getElementById('btn-start');
    const btnOptions    = document.getElementById('btn-options');
    const btnBack       = document.getElementById('btn-back');
    const btnResume     = document.getElementById('btn-resume');
    const btnQuit       = document.getElementById('btn-quit');
    const btnLevelBack  = document.getElementById('btn-level-back');
    const levelBtnsContainer = document.getElementById('level-buttons');

    const toggleFPS          = document.getElementById('toggle-fps');
    const sensitivitySlider  = document.getElementById('sensitivity-slider');
    const sensitivityValue   = document.getElementById('sensitivity-value');
    const volumeSlider       = document.getElementById('volume-slider');
    const volumeValue        = document.getElementById('volume-value');

    const settings = {
        showFPS: false,
        sensitivity: 5,
        volume: 70,
    };

    let gameInitialized = false;
    let selectedLevel   = 0;

    const mobilePauseBtn = document.getElementById('mobile-pause-btn');

    // Maximum level number
    const MAX_LEVEL = 5;

    function init() {
        btnStart.addEventListener('click', onStart);
        btnOptions.addEventListener('click', () => showScreen('options'));
        btnBack.addEventListener('click', () => showScreen('mainMenu'));
        btnResume.addEventListener('click', onResume);
        btnQuit.addEventListener('click', onQuit);

        if (btnLevelBack) {
            btnLevelBack.addEventListener('click', () => showScreen('mainMenu'));
        }

        // Mobile pause button
        if (mobilePauseBtn) {
            mobilePauseBtn.addEventListener('click', () => {
                if (Game.getIsRunning() && !Game.getIsPaused()) {
                    Game.pause();
                }
            });
        }

        toggleFPS.addEventListener('change', (e) => {
            settings.showFPS = e.target.checked;
            Game.setShowFPS(settings.showFPS);
        });

        sensitivitySlider.addEventListener('input', (e) => {
            settings.sensitivity = parseInt(e.target.value);
            sensitivityValue.textContent = settings.sensitivity;
            Player.setSensitivity(settings.sensitivity);
        });

        volumeSlider.addEventListener('input', (e) => {
            settings.volume = parseInt(e.target.value);
            volumeValue.textContent = settings.volume;
            AudioManager.setMasterVolume(settings.volume / 100);
        });

        document.addEventListener('keydown', (e) => {
            if (e.code === 'Escape') {
                if (Game.getIsRunning() && !Game.getIsPaused()) {
                    Game.pause();
                }
            }
        });
    }

    function showScreen(name) {
        for (const key in screens) {
            if (screens[key]) screens[key].classList.remove('active');
        }
        if (screens[name]) {
            screens[name].classList.add('active');
        }
    }

    // =========================================
    //  LEVEL SELECTION
    // =========================================

    /**
     * Check which levels are available (localStorage + static files).
     * Returns a promise that resolves with an array of { level, name, available }.
     */
    function _checkAvailableLevels() {
        var results = [];
        var fetches = [];

        for (var i = 0; i <= MAX_LEVEL; i++) {
            (function (lvl) {
                // Check localStorage first
                var stored = localStorage.getItem('backrooms_level_' + lvl);
                if (stored) {
                    try {
                        var data = JSON.parse(stored);
                        results.push({ level: lvl, name: data.name || ('Level ' + lvl), available: true });
                        return;
                    } catch (e) { /* fall through */ }
                }

                // Try static JSON file
                var p = fetch('assets/levels/level' + lvl + '.json', { method: 'HEAD' })
                    .then(function (res) {
                        if (res.ok) {
                            results.push({ level: lvl, name: 'Level ' + lvl, available: true });
                        } else {
                            results.push({ level: lvl, name: 'Level ' + lvl, available: false });
                        }
                    })
                    .catch(function () {
                        results.push({ level: lvl, name: 'Level ' + lvl, available: false });
                    });
                fetches.push(p);
            })(i);
        }

        return Promise.all(fetches).then(function () {
            // Sort by level number
            results.sort(function (a, b) { return a.level - b.level; });
            return results;
        });
    }

    function _buildLevelButtons(levels) {
        if (!levelBtnsContainer) return;
        levelBtnsContainer.innerHTML = '';

        for (var i = 0; i < levels.length; i++) {
            var info = levels[i];
            var btn = document.createElement('button');
            btn.className = 'menu-btn';
            btn.textContent = info.name;
            btn.setAttribute('data-level', info.level);

            if (!info.available) {
                btn.classList.add('disabled');
                btn.disabled = true;
                btn.style.opacity = '0.4';
            }

            btn.addEventListener('click', _onLevelSelect);
            levelBtnsContainer.appendChild(btn);
        }
    }

    function _onLevelSelect(e) {
        var lvl = parseInt(e.target.getAttribute('data-level'));
        if (isNaN(lvl)) return;
        selectedLevel = lvl;
        _loadAndStartLevel(lvl);
    }

    // =========================================
    //  LEVEL LOADING
    // =========================================

    /**
     * Load level data from localStorage or static JSON file.
     * Returns a promise that resolves with the parsed level data.
     */
    function _loadLevelData(levelNum) {
        // Try localStorage first
        var stored = localStorage.getItem('backrooms_level_' + levelNum);
        if (stored) {
            try {
                return Promise.resolve(JSON.parse(stored));
            } catch (e) { /* fall through */ }
        }

        // Fetch static JSON
        return fetch('assets/levels/level' + levelNum + '.json')
            .then(function (res) {
                if (!res.ok) throw new Error('Level file not found');
                return res.json();
            });
    }

    function _loadAndStartLevel(levelNum) {
        showScreen('loading');
        AudioManager.startAmbientHum();

        _loadLevelData(levelNum).then(function (levelData) {
            // Set the level data on the environment
            Environment.setLevelData(levelData);

            if (!gameInitialized) {
                Game.init(function () {
                    gameInitialized = true;
                    applySettings();
                    AudioManager.fadeAmbientHumOut(1.0);
                    setTimeout(function () {
                        showScreen('game');
                        showMobilePause();
                        MobileControls.show();
                        Game.start(true);
                    }, 2000);
                });
            } else {
                // Re-init game with new level data
                Game.stop();
                Game.init(function () {
                    applySettings();
                    AudioManager.fadeAmbientHumOut(1.0);
                    setTimeout(function () {
                        showScreen('game');
                        showMobilePause();
                        MobileControls.show();
                        Game.start(true);
                    }, 2000);
                });
            }
        }).catch(function (err) {
            console.error('[Menu] Failed to load level ' + levelNum, err);
            alert('Failed to load level ' + levelNum + '. Make sure the level file exists.');
            showScreen('mainMenu');
        });
    }

    // =========================================
    //  START / RESUME / QUIT
    // =========================================

    function onStart() {
        // Show level selection screen
        _checkAvailableLevels().then(function (levels) {
            _buildLevelButtons(levels);
            showScreen('levelSelect');
        });
    }

    function showMobilePause() {
        if (MobileControls.getIsMobile() && mobilePauseBtn) {
            mobilePauseBtn.classList.remove('hidden');
        }
    }

    function hideMobilePause() {
        if (mobilePauseBtn) mobilePauseBtn.classList.add('hidden');
    }

    /** Apply all current settings to game systems */
    function applySettings() {
        Game.setShowFPS(settings.showFPS);
        Player.setSensitivity(settings.sensitivity);
        AudioManager.setMasterVolume(settings.volume / 100);
    }

    function onResume() {
        Game.resume();
    }

    function onQuit() {
        Game.stop();
        gameInitialized = false;
        MobileControls.hide();
        document.getElementById('pause-menu').classList.add('hidden');
        hideMobilePause();
        showScreen('mainMenu');
    }

    return { init };
})();
