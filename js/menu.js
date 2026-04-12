/* ========================================
   Menu System
   Screen transitions, settings, audio lifecycle,
   level selection, and multiplayer lobby flow.
   ======================================== */

const Menu = (() => {
    const screens = {
        mainMenu:    document.getElementById('main-menu'),
        nameEntry:   document.getElementById('name-entry'),
        lobby:       document.getElementById('lobby-screen'),
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
    const btnNameBack   = document.getElementById('btn-name-back');
    const btnLobbyBack  = document.getElementById('btn-lobby-back');
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
    let isMultiplayer   = false;
    let isLoadingMultiplayer = false; // guard against double-loading

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

        if (btnNameBack) {
            btnNameBack.addEventListener('click', () => {
                Network.disconnect();
                showScreen('mainMenu');
            });
        }

        if (btnLobbyBack) {
            btnLobbyBack.addEventListener('click', () => {
                Network.disconnect();
                showScreen('mainMenu');
            });
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

        // Initialize lobby system
        Lobby.init();
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

    function _checkAvailableLevels() {
        var results = [];
        var fetches = [];

        for (var i = 0; i <= MAX_LEVEL; i++) {
            (function (lvl) {
                var stored = localStorage.getItem('backrooms_level_' + lvl);
                if (stored) {
                    try {
                        var data = JSON.parse(stored);
                        results.push({ level: lvl, name: data.name || ('Level ' + lvl), available: true });
                        return;
                    } catch (e) { /* fall through */ }
                }

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
        isMultiplayer = false;
        _loadAndStartLevel(lvl);
    }

    // =========================================
    //  LEVEL LOADING
    // =========================================

    function _loadLevelData(levelNum) {
        var stored = localStorage.getItem('backrooms_level_' + levelNum);
        if (stored) {
            try {
                return Promise.resolve(JSON.parse(stored));
            } catch (e) { /* fall through */ }
        }

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

    /**
     * Load and start a multiplayer game session.
     * Called by Lobby when the server sends game_state.
     * @param {number} levelNum
     * @param {object} initialState — first game_state from server
     */
    function _loadAndStartMultiplayer(levelNum, initialState) {
        // Prevent double-loading (game_state can arrive multiple times)
        if (isLoadingMultiplayer) return;
        isLoadingMultiplayer = true;

        showScreen('loading');
        AudioManager.startAmbientHum();
        isMultiplayer = true;

        _loadLevelData(levelNum).then(function (levelData) {
            Environment.setLevelData(levelData);

            if (!gameInitialized) {
                Game.init(function () {
                    gameInitialized = true;
                    applySettings();

                    // Initialize multiplayer system
                    Multiplayer.init(Game.getScene(), Network.getPlayerId());

                    AudioManager.fadeAmbientHumOut(1.0);
                    setTimeout(function () {
                        showScreen('game');
                        showMobilePause();
                        MobileControls.show();
                        Game.start(true);
                    }, 2000);
                });
            } else {
                Game.stop();
                Game.init(function () {
                    applySettings();
                    Multiplayer.init(Game.getScene(), Network.getPlayerId());
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
            console.error('[Menu] Failed to load multiplayer level ' + levelNum, err);
            alert('Failed to load multiplayer level. Returning to lobby.');
            showScreen('lobby');
        });
    }

    // =========================================
    //  START / RESUME / QUIT
    // =========================================

    function onStart() {
        // Go to name entry screen for multiplayer
        showScreen('nameEntry');
    }

    function showMobilePause() {
        if (MobileControls.getIsMobile() && mobilePauseBtn) {
            mobilePauseBtn.classList.remove('hidden');
        }
    }

    function hideMobilePause() {
        if (mobilePauseBtn) mobilePauseBtn.classList.add('hidden');
    }

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
        isLoadingMultiplayer = false;
        MobileControls.hide();
        document.getElementById('pause-menu').classList.add('hidden');
        hideMobilePause();

        // Shutdown multiplayer if active
        if (isMultiplayer) {
            Multiplayer.shutdown();
            isMultiplayer = false;
            Network.disconnect();
            showScreen('mainMenu');
        } else {
            showScreen('mainMenu');
        }
    }

    return {
        init,
        showScreen,
        _loadAndStartMultiplayer,
    };
})();
