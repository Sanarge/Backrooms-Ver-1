/* ========================================
   Game Engine
   Core rendering loop, state management,
   and UI orchestration.
   Delegates lighting to LightingEngine,
   physics to MovementEngine.
   ======================================== */

const Game = (() => {
    // Three.js core
    let renderer = null;
    let scene = null;
    let camera = null;

    // State
    let isRunning = false;
    let isPaused = false;
    let animFrameId = null;

    // Timing — fixed timestep at 120 Hz
    const FIXED_DT = 1 / 120;
    const MAX_FRAME_DT = 0.05;
    let accumulator = 0;
    let lastTime = 0;

    // FPS tracking
    let showFPS = false;
    let fpsFrames = 0;
    let fpsTime = 0;
    let currentFPS = 0;
    const fpsEl = document.getElementById('fps-counter');

    // Pointer lock
    let isPointerLocked = false;

    // Audio update throttle
    let audioUpdateTimer = 0;
    const AUDIO_UPDATE_INTERVAL = 1 / 30;

    // Stamina UI
    let staminaFullTimer = 0;
    const STAMINA_FADE_DELAY = 1.5;
    let staminaUIVisible = false;
    const staminaUI = document.getElementById('stamina-ui');
    const staminaFill = document.getElementById('stamina-bar-fill');

    // =========================================
    //  INITIALIZATION
    // =========================================

    /**
     * Initialize the game engine.
     * @param {Function} onLoaded
     */
    function init(onLoaded) {
        const canvas = document.getElementById('game-canvas');

        // --- Renderer ---
        renderer = new THREE.WebGLRenderer({
            canvas,
            antialias: true,
            powerPreference: 'high-performance',
            stencil: false,
            depth: true,
        });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.0));
        renderer.outputEncoding = THREE.sRGBEncoding;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 0.80;
        renderer.physicallyCorrectLights = true;

        // Shadow mapping (PCF — cheaper than PCFSoft, still decent quality)
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFShadowMap;

        // Scene
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x3a2a12);

        // Camera
        camera = new THREE.PerspectiveCamera(
            70,
            window.innerWidth / window.innerHeight,
            0.1,
            40    // V2: tightened — fog hides beyond ~25 units anyway
        );

        // --- Build textures ---
        const textures = {
            wall: TextureFactory.createWallTexture(),
            floor: TextureFactory.createFloorTexture(),
            ceiling: TextureFactory.createCeilingTexture(),
            lightPanel: TextureFactory.createLightPanelTexture(),
            glow: TextureFactory.createGlowTexture(),
        };

        // --- Build environment geometry ---
        const envData = Environment.build(scene, textures);

        // --- Initialize lighting engine ---
        LightingEngine.init(scene);

        // Use level JSON light data if available, otherwise auto-place
        const levelData = Environment.getLevelData();
        if (levelData && levelData.lights && levelData.lights.length > 0) {
            LightingEngine.placeLightsFromData(
                levelData.lights,
                envData.tileSize,
                envData.wallHeight,
                textures.lightPanel,
                textures.glow
            );
        } else {
            LightingEngine.placeLights(
                envData.map,
                envData.tileSize,
                envData.wallHeight,
                textures.lightPanel,
                textures.glow
            );
        }

        LightingEngine.addAmbientFog(scene);
        LightingEngine.createShadowPool();

        // --- Initialize audio ---
        AudioManager.init();
        const lightPositions = LightingEngine.getLightPositions();
        for (const pos of lightPositions) {
            AudioManager.addLightSource(pos);
        }
        AudioManager.muteSpatialSources();

        // --- Initialize atmosphere engine ---
        const collisionData = Environment.getCollisionData();
        Atmosphere.init(
            AudioManager.getContext(),
            AudioManager.getMasterGainNode(),
            { map: envData.map, tileSize: envData.tileSize, rows: envData.map.length, cols: envData.map[0].length }
        );

        // --- Initialize player ---
        const spawn = Environment.getSpawnPosition();
        Player.init(camera, spawn, collisionData);

        // --- Place props from level data or legacy fallback ---
        Props.init(scene);
        if (levelData && levelData.props) {
            Props.placeFromLevelData(levelData.props, spawn);
        } else {
            Props.placeSpawnProps(spawn);
        }

        // --- Initialize physics & interaction engine ---
        Physics.init(scene, camera, collisionData);

        // Event listeners (only once)
        if (!Game._listenersAdded) {
            window.addEventListener('resize', onResize);
            document.addEventListener('pointerlockchange', onPointerLockChange);
            Game._listenersAdded = true;
        }

        simulateLoading(onLoaded);
    }

    // =========================================
    //  LOADING SCREEN
    // =========================================

    function simulateLoading(onLoaded) {
        const bar = document.getElementById('loading-bar');
        const text = document.getElementById('loading-text');
        const percent = document.getElementById('loading-percent');
        const hint = document.getElementById('loading-hint');

        const stages = [
            { label: 'Generating textures',    target: 15,  duration: 600 },
            { label: 'Constructing geometry',   target: 35,  duration: 800 },
            { label: 'Placing lights',          target: 55,  duration: 700 },
            { label: 'Initializing audio',      target: 70,  duration: 500 },
            { label: 'Building collision map',  target: 85,  duration: 600 },
            { label: 'Preparing Level 0',       target: 95,  duration: 400 },
        ];

        const hints = [
            'You hear a faint hum...',
            'The fluorescent lights flicker overhead...',
            'The carpet smells damp...',
            'Something feels wrong...',
        ];

        if (hint) {
            hint.textContent = hints[Math.floor(Math.random() * hints.length)];
        }

        let currentProgress = 0;
        let stageIdx = 0;

        function runStage() {
            if (stageIdx >= stages.length) {
                smoothRamp(currentProgress, 100, 300, () => {
                    text.textContent = 'Ready';
                    if (percent) percent.textContent = '100%';
                    bar.style.width = '100%';
                    setTimeout(() => { if (onLoaded) onLoaded(); }, 400);
                });
                return;
            }

            const stage = stages[stageIdx];
            text.textContent = stage.label;

            smoothRamp(currentProgress, stage.target, stage.duration, () => {
                currentProgress = stage.target;
                stageIdx++;
                setTimeout(runStage, 80 + Math.random() * 120);
            });
        }

        function smoothRamp(from, to, duration, callback) {
            const startTime = performance.now();
            function tick(now) {
                const elapsed = now - startTime;
                const t = Math.min(elapsed / duration, 1.0);
                const ease = 1.0 - (1.0 - t) * (1.0 - t);
                const p = from + (to - from) * ease;
                bar.style.width = p.toFixed(1) + '%';
                if (percent) percent.textContent = Math.floor(p) + '%';
                if (t < 1.0) {
                    requestAnimationFrame(tick);
                } else {
                    if (callback) callback();
                }
            }
            requestAnimationFrame(tick);
        }

        setTimeout(runStage, 200);
    }

    // =========================================
    //  GAME LOOP
    // =========================================

    /**
     * Start / restart the game loop.
     * @param {boolean} playIntro — if true, play the standing-up intro sequence
     */
    function start(playIntro) {
        if (isRunning) return;
        isRunning = true;
        isPaused = false;
        lastTime = performance.now();
        accumulator = 0;
        audioUpdateTimer = 0;

        if (playIntro) {
            AudioManager.resume();
            Player.startIntro();
        } else {
            AudioManager.rebuildSources();
        }

        requestPointerLock();
        animFrameId = requestAnimationFrame(loop);
    }

    /** Main game loop */
    function loop(now) {
        if (!isRunning) return;
        animFrameId = requestAnimationFrame(loop);

        if (isPaused) return;

        const rawDt = (now - lastTime) / 1000;
        lastTime = now;
        const dt = Math.min(rawDt, MAX_FRAME_DT);

        accumulator += dt;

        // Mobile joystick input
        MobileControls.applyInput();

        // Fixed timestep physics
        while (accumulator >= FIXED_DT) {
            Player.update(FIXED_DT);
            accumulator -= FIXED_DT;
        }

        // Audio (throttled)
        audioUpdateTimer += dt;
        if (audioUpdateTimer >= AUDIO_UPDATE_INTERVAL) {
            audioUpdateTimer = 0;
            const pos = Player.getPosition();
            const dirs = Player.getCameraDirections();
            AudioManager.updateListener(pos, dirs.forward, dirs.up);
        }

        // Lighting systems (delegated to LightingEngine)
        const playerPos = Player.getPosition();
        LightingEngine.updateLightCulling(dt, playerPos);
        LightingEngine.updateBreathing(dt);
        LightingEngine.updateFlicker(dt, playerPos);
        LightingEngine.updateShadowPool(dt, playerPos);

        // Atmosphere (distant sounds, visual unease, watcher)
        const camDirs = Player.getCameraDirections();
        Atmosphere.update(dt, playerPos, camDirs.forward);

        // Physics & interaction (props)
        Physics.update(dt);

        // Multiplayer remote players (if active)
        if (Multiplayer.getIsActive()) {
            Multiplayer.update(dt);
        }

        // Render
        renderer.render(scene, camera);

        // Stamina UI
        updateStaminaUI(dt);

        // FPS counter (uses raw uncapped dt)
        fpsFrames++;
        fpsTime += rawDt;
        if (fpsTime >= 0.5) {
            currentFPS = fpsFrames / fpsTime;
            fpsFrames = 0;
            fpsTime = 0;
            if (showFPS && fpsEl) {
                fpsEl.textContent = 'FPS: ' + Math.round(currentFPS);
            }
        }
    }

    // =========================================
    //  STAMINA UI
    // =========================================

    function updateStaminaUI(dt) {
        if (!staminaUI || !staminaFill) return;

        const info = Player.getStamina();
        const pct = (info.fraction * 100).toFixed(1) + '%';
        staminaFill.style.width = pct;

        staminaFill.classList.toggle('depleted', info.fraction <= 0.01);
        staminaFill.classList.toggle('low', info.fraction > 0.01 && info.fraction < 0.25);

        if (info.isSprinting || info.fraction < 0.999) {
            staminaFullTimer = 0;
            if (!staminaUIVisible) {
                staminaUIVisible = true;
                staminaUI.classList.remove('fading');
                staminaUI.classList.add('visible');
            }
        } else {
            staminaFullTimer += dt;
            if (staminaFullTimer >= STAMINA_FADE_DELAY && staminaUIVisible) {
                staminaUIVisible = false;
                staminaUI.classList.remove('visible');
                staminaUI.classList.add('fading');
            }
        }
    }

    // =========================================
    //  CONTROLS
    // =========================================

    function setShowFPS(show) {
        showFPS = show;
        if (fpsEl) fpsEl.classList.toggle('hidden', !show);
    }

    function pause() {
        isPaused = true;
        Player.resetInput();
        document.exitPointerLock();
        document.getElementById('pause-menu').classList.remove('hidden');
    }

    function resume() {
        document.getElementById('pause-menu').classList.add('hidden');
        isPaused = false;
        lastTime = performance.now();
        accumulator = 0;
        AudioManager.resume();
        requestPointerLock();
    }

    function stop() {
        isRunning = false;
        isPaused = false;
        if (animFrameId) {
            cancelAnimationFrame(animFrameId);
            animFrameId = null;
        }
        Player.resetInput();
        AudioManager.stopAll();

        // Reset lighting & atmosphere state
        LightingEngine.reset();
        Atmosphere.reset();

        // Hide stamina UI
        if (staminaUI) {
            staminaUI.classList.remove('visible', 'fading');
            staminaUIVisible = false;
            staminaFullTimer = 0;
        }
        try { document.exitPointerLock(); } catch (e) {}
    }

    function requestPointerLock() {
        if (MobileControls.getIsMobile()) return;
        const canvas = document.getElementById('game-canvas');
        canvas.requestPointerLock();
    }

    function onPointerLockChange() {
        if (MobileControls.getIsMobile()) return;

        const canvas = document.getElementById('game-canvas');
        isPointerLocked = document.pointerLockElement === canvas;

        if (isPointerLocked) {
            document.addEventListener('mousemove', Player.onMouseMove);
        } else {
            document.removeEventListener('mousemove', Player.onMouseMove);
            if (isRunning && !isPaused) {
                pause();
            }
        }
    }

    function onResize() {
        if (!camera || !renderer) return;
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }

    function getIsPaused() { return isPaused; }
    function getIsRunning() { return isRunning; }
    function getScene() { return scene; }

    return {
        _listenersAdded: false,
        init,
        start,
        pause,
        resume,
        stop,
        setShowFPS,
        getIsPaused,
        getIsRunning,
        getScene,
    };
})();
