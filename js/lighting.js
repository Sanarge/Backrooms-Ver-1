/* ========================================
   Lighting Engine  (V2 — "Alive" Lights)
   ════════════════════════════════════════════════════════
   Every ceiling panel is a unique light with
   its own personality: breathing rhythm,
   colour warmth, and hum-stability class.
   Soft, creeping shadows pool outward from
   nearby geometry.

   Systems:
    • Light placement  (ceiling-tile snapped)
    • Per-light personality & breathing
    • Distance-based PointLight culling
    • Dynamic shadow pool  (soft / creeping)
    • Dramatic flicker events
   ======================================== */

const LightingEngine = (() => {

    // =========================================
    //  CONSTANTS
    // =========================================

    // Panel visual dimensions
    const PANEL_WIDTH  = 0.88;
    const PANEL_HEIGHT = 1.85;
    const GLOW_SIZE    = 6.0;

    // PointLight base settings
    const LIGHT_COLOR     = 0xffeebb;
    const LIGHT_INTENSITY = 3.2;
    const LIGHT_RANGE     = 25;
    const LIGHT_DECAY     = 2;        // physically correct inverse-square

    // Glow halo defaults
    const GLOW_OPACITY             = 0.40;
    const PANEL_EMISSIVE_INTENSITY = 2.2;

    // Ceiling tile grid (snap lights to tile centres)
    const CEIL_TILE_W = 1.0;
    const CEIL_TILE_H = 2.0;

    // ── Personality / Breathing ──
    // Each light gets randomised values inside these ranges.
    // The wide speed range means some lights drift slowly while
    // others pulse noticeably — no two feel the same.
    const BREATH_SPEED_MIN  = 0.12;   // very slow drift (~8 sec cycle)
    const BREATH_SPEED_MAX  = 0.7;    // quicker pulse (~1.4 sec cycle)
    const BREATH_DEPTH_MIN  = 0.08;   // mildest wobble (±8%)
    const BREATH_DEPTH_MAX  = 0.22;   // strongest wobble (±22%)
    const WARMTH_SHIFT_MAX  = 0.12;   // colour temperature variation

    // Hum-stability classes — assigned per light
    //   stable   : breathing only — the "good" fluorescent
    //   nervous  : fast micro-flickers on top — about to go
    //   dying    : deep slow throb with stutter — on its last legs
    const HUM_CLASSES = ['stable', 'stable', 'nervous', 'nervous', 'dying', 'dying'];

    // Micro-flicker for "nervous" lights
    const MICRO_FLICKER_SPEED  = 28;   // high-freq sine multiplier
    const MICRO_FLICKER_DEPTH  = 0.12; // visible extra wobble

    // Low throb for "dying" lights
    const DYING_THROB_SPEED = 0.10;
    const DYING_THROB_DEPTH = 0.25;

    // ── PointLight Culling ──
    const MAX_ACTIVE_LIGHTS    = 6;
    const LIGHT_CULL_INTERVAL  = 0.15;
    const LIGHT_ACTIVATE_DIST_SQ = 20 * 20;
    const GLOW_VISIBLE_DIST_SQ  = 18 * 18;

    // ── Dynamic Shadow Pool ──
    // 3 SpotLights × 512² — soft, creeping shadows
    const SHADOW_POOL_SIZE      = 3;
    const SHADOW_UPDATE_INTERVAL = 0.18;
    const SHADOW_MAP_SIZE       = 512;
    const SHADOW_RANGE          = 22;
    const SHADOW_ANGLE          = Math.PI / 2.0;   // wider cone → broader shadow coverage
    const SHADOW_PENUMBRA       = 0.65;             // high penumbra → soft creeping edges
    const SHADOW_BIAS           = -0.0005;
    const SHADOW_NORMAL_BIAS    = 0.6;
    const SHADOW_RADIUS         = 3;                // PCF blur radius — softer
    const SHADOW_INTENSITY_MULT = 1.5;

    // ── Flicker System (dramatic events) ──
    // Exponential distribution for truly unpredictable timing.
    // Sometimes 3 seconds apart, sometimes 40+ seconds of silence.
    const FLICKER_MEAN_INTERVAL  = 14.0;  // average seconds between flicker events
    const FLICKER_MIN_GAP        = 3.0;   // minimum cooldown so they don't overlap
    const FLICKER_OFF_MIN        = 2.0;   // shortest dark period
    const FLICKER_OFF_MAX        = 12.0;  // longest dark period (wide range = unpredictable)
    const FLICKER_OUT_DURATION   = 0.15;
    const FLICKER_ON_DURATION    = 0.5;
    const FLICKER_SEARCH_RADIUS  = 25.0;

    // =========================================
    //  STATE
    // =========================================

    /** @type {THREE.Scene} */
    let sceneRef = null;

    /** All light objects */
    const lightObjects = [];

    /** World positions */
    const lightPositions = [];

    // Shared geometry
    let _panelGeo = null;
    let _glowGeo  = null;

    // Light culling state
    let lightCullTimer = 0;

    // Shadow pool
    let shadowPool = [];
    let shadowUpdateTimer = 0;

    // Flicker state
    let flickerTimer       = 5.0;
    let flickerActive      = false;
    let flickerLightIndex  = -1;
    let flickerPhase       = 'none';
    let flickerPhaseTimer  = 0;
    let flickerDarkDuration = 0;

    // Global time accumulator for breathing (never resets)
    let _globalTime = 0;

    // Reusable arrays for distance sorting
    let _distArray  = [];
    let _distLookup = null;

    // Seeded PRNG for deterministic personality assignment
    let _seed = 137;
    function _seeded() {
        _seed = (_seed * 16807 + 0) % 2147483647;
        return (_seed & 0x7fffffff) / 0x7fffffff;
    }

    /**
     * Exponential random delay for flicker timing.
     * Produces short gaps often, long gaps rarely — feels organic.
     * Clamped to a minimum cooldown so flickers don't pile up.
     */
    function _nextFlickerDelay() {
        // Exponential distribution: -mean * ln(1 - U)
        const u = Math.random();
        const raw = -FLICKER_MEAN_INTERVAL * Math.log(1 - u + 1e-10);
        return Math.max(FLICKER_MIN_GAP, raw);
    }

    // =========================================
    //  INITIALIZATION
    // =========================================

    function init(scene) {
        sceneRef = scene;
        lightObjects.length = 0;
        lightPositions.length = 0;
        shadowPool = [];
        shadowUpdateTimer = 0;
        lightCullTimer = 0;
        _distArray  = [];
        _distLookup = null;
        _globalTime = 0;
        _seed = 137;
        _resetFlicker();

        _panelGeo = new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT);
        _glowGeo  = new THREE.PlaneGeometry(GLOW_SIZE, GLOW_SIZE);
    }

    // =========================================
    //  LIGHT PLACEMENT
    // =========================================

    function snapToCeilingTile(x, z) {
        return {
            x: Math.floor(x / CEIL_TILE_W) * CEIL_TILE_W + CEIL_TILE_W / 2,
            z: Math.floor(z / CEIL_TILE_H) * CEIL_TILE_H + CEIL_TILE_H / 2,
        };
    }

    function placeLights(map, tileSize, wallHeight, panelTex, glowTex) {
        const rows = map.length;
        const cols = map[0].length;

        for (let row = 1; row < rows - 1; row += 3) {
            for (let col = 1; col < cols - 1; col += 3) {
                if (map[row][col] === 1) {
                    const rawX = col * tileSize + tileSize / 2;
                    const rawZ = row * tileSize + tileSize / 2;
                    const snapped = snapToCeilingTile(rawX, rawZ);
                    _addLightPanel(panelTex, glowTex, snapped.x, wallHeight - 0.02, snapped.z);
                }
            }
        }

        // Pre-allocate distance arrays
        _distArray = new Array(lightObjects.length);
        for (let i = 0; i < lightObjects.length; i++) {
            _distArray[i] = { idx: i, dist: 0 };
        }
        _distLookup = new Float32Array(lightObjects.length);
    }

    function _addLightPanel(panelTex, glowTex, x, y, z) {
        // ── Personality (deterministic per light) ──
        const breathSpeed = BREATH_SPEED_MIN + _seeded() * (BREATH_SPEED_MAX - BREATH_SPEED_MIN);
        const breathPhase = _seeded() * Math.PI * 2;        // random start phase
        const breathDepth = BREATH_DEPTH_MIN + _seeded() * (BREATH_DEPTH_MAX - BREATH_DEPTH_MIN);
        const warmthShift = (_seeded() - 0.5) * 2 * WARMTH_SHIFT_MAX;  // ± shift
        const humClass    = HUM_CLASSES[Math.floor(_seeded() * HUM_CLASSES.length)];

        // Compute a slightly shifted colour per light
        const baseR = 1.0, baseG = 0.93, baseB = 0.73;     // matches 0xffeebb
        const warmR = Math.min(1.0, baseR + warmthShift * 0.3);
        const warmG = Math.min(1.0, baseG - Math.abs(warmthShift) * 0.1);
        const warmB = Math.max(0.55, baseB - warmthShift * 0.5);
        const lightColor = new THREE.Color(warmR, warmG, warmB);

        // ── Emissive light panel ──
        const panelMat = new THREE.MeshStandardMaterial({
            map: panelTex,
            emissive: new THREE.Color(0xfff8d0),
            emissiveIntensity: PANEL_EMISSIVE_INTENSITY,
            roughness: 0.3,
        });
        const panel = new THREE.Mesh(_panelGeo, panelMat);
        panel.rotation.x = Math.PI / 2;
        panel.position.set(x, y, z);
        sceneRef.add(panel);

        // ── Ceiling glow halo ──
        const glowMat = new THREE.MeshBasicMaterial({
            map: glowTex,
            color: new THREE.Color(0xfff0c0),
            transparent: true,
            opacity: GLOW_OPACITY,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });
        const glow = new THREE.Mesh(_glowGeo, glowMat);
        glow.rotation.x = Math.PI / 2;
        glow.position.set(x, y - 0.015, z);
        glow.renderOrder = 1;
        sceneRef.add(glow);

        // ── Point light (starts disabled — culling activates nearest) ──
        const light = new THREE.PointLight(lightColor, 0, LIGHT_RANGE, LIGHT_DECAY);
        light.position.set(x, y - 0.1, z);
        sceneRef.add(light);

        const pos = new THREE.Vector3(x, y, z);
        lightPositions.push(pos);
        lightObjects.push({
            position: pos,
            pointLight: light,
            panelMesh: panel,
            panelMat: panelMat,
            glowMesh: glow,
            glowMat: glowMat,
            originalIntensity: LIGHT_INTENSITY,
            originalEmissive: PANEL_EMISSIVE_INTENSITY,
            originalGlowOpacity: GLOW_OPACITY,
            isActive: false,
            brightnessOverride: 1.0,

            // Personality
            breathSpeed,
            breathPhase,
            breathDepth,
            warmthShift,
            humClass,
            lightColor,                      // per-light colour
        });
    }

    // =========================================
    //  AMBIENT / FOG
    // =========================================

    function addAmbientFog(scene) {
        scene.fog = new THREE.FogExp2(0x3a2a12, 0.04);

        // Very low ambient — keeps shadowed areas dark
        const ambientLight = new THREE.AmbientLight(0xd4c090, 0.025);
        scene.add(ambientLight);

        const hemiLight = new THREE.HemisphereLight(0xf0e4b8, 0x2a1a08, 0.035);
        scene.add(hemiLight);
    }

    // =========================================
    //  PER-LIGHT BREATHING
    // =========================================

    /**
     * Animate every active light's intensity, emissive, and glow
     * according to its unique personality.  Runs every frame,
     * but only touches the 6 (or fewer) active lights.
     *
     * @param {number} dt  — frame delta in seconds
     */
    function updateBreathing(dt) {
        _globalTime += dt;
        const t = _globalTime;

        for (let i = 0; i < lightObjects.length; i++) {
            const obj = lightObjects[i];
            if (!obj.isActive) continue;

            // Skip lights that the flicker system is currently controlling
            if (flickerActive && flickerLightIndex === i) continue;

            // ── Base breathing sine wave ──
            // Layer two sine waves at different speeds for organic movement
            const breath1 = Math.sin(t * obj.breathSpeed * Math.PI * 2 + obj.breathPhase);
            const breath2 = Math.sin(t * obj.breathSpeed * Math.PI * 0.7 + obj.breathPhase * 2.3);
            const breath  = breath1 * 0.7 + breath2 * 0.3;  // mixed, less predictable
            let intensityMod = 1.0 + breath * obj.breathDepth;

            // ── Hum-class layer ──
            if (obj.humClass === 'nervous') {
                // Fast micro-flicker on top of breathing
                const micro = Math.sin(t * MICRO_FLICKER_SPEED + obj.breathPhase * 3);
                intensityMod += micro * MICRO_FLICKER_DEPTH;
                // Occasional sharp dip — like the tube catching
                if (Math.sin(t * 11.7 + obj.breathPhase * 5) > 0.85) {
                    intensityMod *= 0.55;
                }
            } else if (obj.humClass === 'dying') {
                // Slow deep throb
                const throb = Math.sin(t * DYING_THROB_SPEED * Math.PI * 2 + obj.breathPhase);
                intensityMod += throb * DYING_THROB_DEPTH;
                // Frequent micro-stutters — feels broken
                const stutter1 = Math.sin(t * 17.3 + obj.breathPhase);
                const stutter2 = Math.sin(t * 7.1 + obj.breathPhase * 2);
                if (stutter1 > 0.8 || stutter2 > 0.9) {
                    intensityMod *= 0.35;
                }
            }

            // Clamp
            intensityMod = Math.max(0.0, Math.min(1.3, intensityMod));

            // Apply
            const finalBrightness = obj.brightnessOverride * intensityMod;

            obj.pointLight.intensity       = obj.originalIntensity * finalBrightness;
            obj.panelMat.emissiveIntensity  = obj.originalEmissive * finalBrightness;
            obj.glowMat.opacity             = obj.originalGlowOpacity * finalBrightness;

            // ── Glow colour breathing ──
            // Visible warmth shift that tracks the breath cycle
            const warmShift = breath * 0.08;
            obj.glowMat.color.setRGB(
                1.0,
                0.94 + warmShift,
                0.72 - warmShift
            );
        }
    }

    // =========================================
    //  POINTLIGHT CULLING
    // =========================================

    function updateLightCulling(dt, playerPos) {
        lightCullTimer += dt;
        if (lightCullTimer < LIGHT_CULL_INTERVAL) return;
        lightCullTimer = 0;

        const px = playerPos.x, pz = playerPos.z;

        // Compute distances
        for (let i = 0; i < lightObjects.length; i++) {
            const lp = lightObjects[i].position;
            const dx = px - lp.x, dz = pz - lp.z;
            _distArray[i].idx  = i;
            _distArray[i].dist = dx * dx + dz * dz;
        }

        // Partial selection-sort for nearest MAX_ACTIVE_LIGHTS
        const n     = lightObjects.length;
        const limit = Math.min(MAX_ACTIVE_LIGHTS, n);
        for (let i = 0; i < limit; i++) {
            let minIdx = i;
            for (let j = i + 1; j < n; j++) {
                if (_distArray[j].dist < _distArray[minIdx].dist) minIdx = j;
            }
            if (minIdx !== i) {
                const tmp = _distArray[i];
                _distArray[i] = _distArray[minIdx];
                _distArray[minIdx] = tmp;
            }
        }

        // Active set
        const activeSet = new Set();
        for (let i = 0; i < limit; i++) {
            if (_distArray[i].dist < LIGHT_ACTIVATE_DIST_SQ) {
                activeSet.add(_distArray[i].idx);
            }
        }

        // O(1) distance lookup
        _distLookup.fill(Infinity);
        for (let i = 0; i < n; i++) {
            _distLookup[_distArray[i].idx] = _distArray[i].dist;
        }

        // Apply activation / deactivation
        for (let i = 0; i < lightObjects.length; i++) {
            const obj = lightObjects[i];
            const shouldBeActive = activeSet.has(i);
            const distSq = _distLookup[i];

            if (shouldBeActive && !obj.isActive) {
                obj.isActive = true;
                obj.pointLight.intensity = obj.originalIntensity * obj.brightnessOverride;
            } else if (!shouldBeActive && obj.isActive) {
                obj.isActive = false;
                obj.pointLight.intensity = 0;
            }

            // Cull distant glow meshes
            obj.glowMesh.visible = (distSq < GLOW_VISIBLE_DIST_SQ);
        }
    }

    // =========================================
    //  SHADOW POOL  (soft, creeping)
    // =========================================

    function createShadowPool() {
        shadowPool = [];
        for (let i = 0; i < SHADOW_POOL_SIZE; i++) {
            const spot = new THREE.SpotLight(
                0x000000, 0, SHADOW_RANGE, SHADOW_ANGLE, SHADOW_PENUMBRA, LIGHT_DECAY
            );
            spot.castShadow = true;
            spot.shadow.mapSize.width  = SHADOW_MAP_SIZE;
            spot.shadow.mapSize.height = SHADOW_MAP_SIZE;
            spot.shadow.camera.near = 0.1;
            spot.shadow.camera.far  = SHADOW_RANGE;
            spot.shadow.bias       = SHADOW_BIAS;
            spot.shadow.normalBias = SHADOW_NORMAL_BIAS;
            spot.shadow.radius     = SHADOW_RADIUS;

            // Park off-screen
            spot.position.set(0, -10, 0);
            spot.target.position.set(0, -11, 0);
            sceneRef.add(spot);
            sceneRef.add(spot.target);

            shadowPool.push({ spot, assignedIdx: -1 });
        }
    }

    function updateShadowPool(dt, playerPos) {
        if (shadowPool.length === 0 || lightObjects.length === 0) return;

        shadowUpdateTimer += dt;
        if (shadowUpdateTimer < SHADOW_UPDATE_INTERVAL) return;
        shadowUpdateTimer = 0;

        const px = playerPos.x, pz = playerPos.z;

        // Find nearest active lights
        const best = [];
        for (let i = 0; i < lightObjects.length; i++) {
            if (!lightObjects[i].isActive) continue;
            const lp = lightObjects[i].position;
            const dx = px - lp.x, dz = pz - lp.z;
            best.push({ idx: i, dist: dx * dx + dz * dz });
        }
        best.sort((a, b) => a.dist - b.dist);

        for (let s = 0; s < shadowPool.length; s++) {
            const slot = shadowPool[s];

            if (s >= best.length) {
                slot.spot.intensity = 0;
                slot.assignedIdx = -1;
                continue;
            }

            const lightIdx = best[s].idx;
            const obj = lightObjects[lightIdx];
            const isOff = obj.pointLight.intensity < 0.01;

            if (isOff) {
                slot.spot.intensity = 0;
                slot.assignedIdx = lightIdx;
                continue;
            }

            const lp = obj.position;
            slot.spot.position.set(lp.x, lp.y - 0.05, lp.z);
            slot.spot.target.position.set(lp.x, 0, lp.z);
            slot.spot.target.updateMatrixWorld();

            // Shadow SpotLight matches the current breathing intensity
            slot.spot.intensity = obj.pointLight.intensity * SHADOW_INTENSITY_MULT;
            slot.spot.color.copy(obj.lightColor);
            slot.assignedIdx = lightIdx;
        }
    }

    // =========================================
    //  BRIGHTNESS CONTROL
    // =========================================

    function setLightBrightness(obj, fraction) {
        if (!obj) return;
        obj.brightnessOverride = fraction;

        if (obj.isActive) {
            obj.pointLight.intensity = obj.originalIntensity * fraction;
        }
        obj.panelMat.emissiveIntensity = obj.originalEmissive * fraction;
        obj.glowMat.opacity            = obj.originalGlowOpacity * fraction;

        // Sync shadow pool
        const lightIdx = lightObjects.indexOf(obj);
        if (lightIdx >= 0) {
            for (let s = 0; s < shadowPool.length; s++) {
                if (shadowPool[s].assignedIdx === lightIdx) {
                    shadowPool[s].spot.intensity = obj.originalIntensity * fraction * SHADOW_INTENSITY_MULT;
                }
            }
        }
    }

    // =========================================
    //  FLICKER SYSTEM  (dramatic events)
    // =========================================

    function updateFlicker(dt, playerPos) {
        if (lightObjects.length === 0) return;

        if (flickerActive) {
            _updateActiveFlicker(dt);
            return;
        }

        flickerTimer -= dt;
        if (flickerTimer > 0) return;

        flickerTimer = _nextFlickerDelay();

        // Find nearest light to player
        let nearestIdx  = -1;
        let nearestDist = Infinity;

        for (let i = 0; i < lightObjects.length; i++) {
            const lpos = lightObjects[i].position;
            const dx = playerPos.x - lpos.x;
            const dz = playerPos.z - lpos.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist < nearestDist && dist < FLICKER_SEARCH_RADIUS) {
                nearestDist = dist;
                nearestIdx  = i;
            }
        }

        if (nearestIdx < 0) return;

        flickerActive      = true;
        flickerLightIndex  = nearestIdx;
        flickerPhase       = 'flickerOut';
        flickerPhaseTimer  = 0;
        // Squared random biases toward shorter darks, with occasional long ones
        const r = Math.random();
        flickerDarkDuration = FLICKER_OFF_MIN + (r * r) * (FLICKER_OFF_MAX - FLICKER_OFF_MIN);

        AudioManager.playFlickerSound();
        AudioManager.muteSource(nearestIdx);
        setLightBrightness(lightObjects[nearestIdx], 0);
    }

    /** @private */
    function _updateActiveFlicker(dt) {
        flickerPhaseTimer += dt;
        const obj = lightObjects[flickerLightIndex];

        switch (flickerPhase) {
            case 'flickerOut': {
                const t = flickerPhaseTimer / FLICKER_OUT_DURATION;
                if (obj) {
                    const flickVal = Math.sin(flickerPhaseTimer * 80);
                    const flick = flickVal > 0 ? 0.3 * (1.0 - t) : 0;
                    setLightBrightness(obj, flick);
                }
                if (t >= 1.0) {
                    setLightBrightness(obj, 0);
                    flickerPhase = 'dark';
                    flickerPhaseTimer = 0;
                }
                break;
            }
            case 'dark': {
                if (flickerPhaseTimer >= flickerDarkDuration) {
                    flickerPhase = 'flickerOn';
                    flickerPhaseTimer = 0;
                    AudioManager.playFlickerOnSound();
                }
                break;
            }
            case 'flickerOn': {
                const t = flickerPhaseTimer / FLICKER_ON_DURATION;
                if (obj) {
                    const flickRate = 45 - t * 20;
                    const flickVal = Math.sin(flickerPhaseTimer * flickRate);
                    const onThreshold = -0.8 + t * 1.6;
                    const isOn = flickVal > onThreshold;
                    const brightness = isOn ? (0.3 + t * 0.7) : 0;
                    setLightBrightness(obj, brightness);
                }
                if (t >= 1.0) {
                    setLightBrightness(obj, 1);
                    AudioManager.unmuteSource(flickerLightIndex, 0.3);
                    _resetFlicker();
                }
                break;
            }
        }
    }

    function _resetFlicker() {
        flickerActive     = false;
        flickerPhase      = 'none';
        flickerLightIndex = -1;
        flickerPhaseTimer = 0;
        flickerTimer      = _nextFlickerDelay();
    }

    // =========================================
    //  CLEANUP / RESET
    // =========================================

    function reset() {
        _resetFlicker();
        flickerTimer      = 5.0;
        shadowUpdateTimer = 0;
        lightCullTimer    = 0;
        _globalTime       = 0;

        for (const slot of shadowPool) {
            slot.spot.intensity = 0;
            slot.assignedIdx = -1;
        }
        for (const obj of lightObjects) {
            obj.isActive = false;
            obj.brightnessOverride = 1.0;
            obj.pointLight.intensity = 0;
        }
    }

    // =========================================
    //  ACCESSORS
    // =========================================

    function getLightObjects()   { return lightObjects; }
    function getLightPositions() { return lightPositions; }

    return {
        init,
        placeLights,
        addAmbientFog,
        createShadowPool,
        updateBreathing,
        updateLightCulling,
        updateShadowPool,
        updateFlicker,
        setLightBrightness,
        reset,
        getLightObjects,
        getLightPositions,
    };
})();
