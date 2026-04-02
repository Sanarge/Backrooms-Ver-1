/* ========================================
   Menu System
   Screen transitions, settings, audio lifecycle
   ======================================== */

const Menu = (() => {
    const screens = {
        mainMenu: document.getElementById('main-menu'),
        options: document.getElementById('options-menu'),
        game: document.getElementById('game-screen'),
        loading: document.getElementById('loading-screen'),
    };

    const btnStart = document.getElementById('btn-start');
    const btnOptions = document.getElementById('btn-options');
    const btnBack = document.getElementById('btn-back');
    const btnResume = document.getElementById('btn-resume');
    const btnQuit = document.getElementById('btn-quit');

    const toggleFPS = document.getElementById('toggle-fps');
    const sensitivitySlider = document.getElementById('sensitivity-slider');
    const sensitivityValue = document.getElementById('sensitivity-value');
    const volumeSlider = document.getElementById('volume-slider');
    const volumeValue = document.getElementById('volume-value');

    const settings = {
        showFPS: false,
        sensitivity: 5,
        volume: 70,
    };

    let gameInitialized = false;

    const mobilePauseBtn = document.getElementById('mobile-pause-btn');

    function init() {
        btnStart.addEventListener('click', onStart);
        btnOptions.addEventListener('click', () => showScreen('options'));
        btnBack.addEventListener('click', () => showScreen('mainMenu'));
        btnResume.addEventListener('click', onResume);
        btnQuit.addEventListener('click', onQuit);

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
            screens[key].classList.remove('active');
        }
        if (screens[name]) {
            screens[name].classList.add('active');
        }
    }

    function onStart() {
        if (!gameInitialized) {
            showScreen('loading');
            AudioManager.startAmbientHum();
            Game.init(() => {
                gameInitialized = true;
                applySettings();
                AudioManager.fadeAmbientHumOut(1.0);
                setTimeout(() => {
                    showScreen('game');
                    showMobilePause();
                    MobileControls.show();
                    Game.start(true);
                }, 2000);
            });
        } else {
            applySettings();
            showScreen('game');
            showMobilePause();
            MobileControls.show();
            Game.start(false);
        }
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
        MobileControls.hide();
        document.getElementById('pause-menu').classList.add('hidden');
        hideMobilePause();
        showScreen('mainMenu');
    }

    return { init };
})();
