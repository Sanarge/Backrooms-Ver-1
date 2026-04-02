/* ========================================
   Atmosphere Engine
   ════════════════════════════════════════════════════════
   Three layered systems that build dread:

   1. Distant Sounds — spatial audio events
      (footsteps, scraping, breathing, a phone)
      that play from empty corridors nearby.

   2. Visual Unease — fullscreen post-process
      overlay: film grain, pulsing vignette,
      micro-static, subtle chromatic shift.

   3. The Watcher — an invisible presence that
      reacts to the player: sounds behind you,
      lights dimming in rooms you just left,
      grain spikes when "it" is close.
   ======================================== */

const Atmosphere = (() => {

    // =========================================
    //  CONSTANTS
    // =========================================

    // ── Distant Sounds ──
    const DISTANT_SOUND_MIN_GAP   = 8;     // seconds — minimum quiet between events
    const DISTANT_SOUND_MEAN_GAP  = 25;    // average gap (exponential distribution)
    const DISTANT_SOUND_MIN_DIST  = 10;    // min distance from player (world units)
    const DISTANT_SOUND_MAX_DIST  = 22;    // max distance
    const DISTANT_SOUND_VOLUME    = 0.45;  // clearly audible but still "distant"

    // ── Visual Unease ──
    const GRAIN_BASE_OPACITY      = 0.025; // subtle film grain — not distracting
    const GRAIN_UPDATE_INTERVAL   = 1 / 15; // grain redraws per second (choppy = creepier)
    const VIGNETTE_BASE_STRENGTH  = 0.25;  // gentle baseline vignette
    const VIGNETTE_STILL_GROWTH   = 0.004; // slower tightening when still
    const VIGNETTE_MAX_STRENGTH   = 0.50;  // lighter max — never overwhelms
    const VIGNETTE_RECOVER_SPEED  = 0.06;  // recovers faster when moving
    const STATIC_CHANCE_PER_SEC   = 0.015; // rarer static flashes
    const STATIC_DURATION         = 0.06;  // shorter flash

    // ── The Watcher ──
    const WATCHER_MIN_GAP         = 20;
    const WATCHER_MEAN_GAP        = 45;
    const WATCHER_BEHIND_SOUND_VOL = 0.25;  // audible enough to make you turn around
    const WATCHER_GRAIN_SPIKE     = 0.08;   // subtler grain boost during an event
    const WATCHER_GRAIN_SPIKE_DUR = 1.5;    // seconds
    const WATCHER_LIGHT_DIM_FRAC  = 0.4;    // how much to dim the "room you left"
    const WATCHER_LIGHT_DIM_DUR   = 3.0;    // seconds to fade the dim back to normal

    // =========================================
    //  STATE
    // =========================================

    let _audioCtx   = null;   // reference to the shared Web Audio context
    let _masterGain  = null;   // AudioManager's master gain node
    let _mapData     = null;   // { map, tileSize, rows, cols }
    let _initialized = false;

    // Distant sounds
    let _distantTimer = 0;
    let _nextDistantDelay = 0;

    // Pre-loaded audio buffers (MP3 assets)
    let _runningBuffer = null;   // distant_running.mp3
    let _alarmBuffer   = null;   // distant_alarm.mp3

    // Visual unease — DOM elements
    let _grainCanvas  = null;
    let _grainCtx     = null;
    let _vignetteEl   = null;
    let _staticEl     = null;
    let _overlayContainer = null;

    // Vignette state
    let _vignetteStrength = VIGNETTE_BASE_STRENGTH;
    let _playerStillTime  = 0;
    let _lastPlayerPos    = null;

    // Grain timing
    let _grainTimer = 0;

    // Static flash
    let _staticActive = false;
    let _staticTimer  = 0;

    // Watcher
    let _watcherTimer = 0;
    let _nextWatcherDelay = 0;
    let _watcherGrainBoost = 0;    // current extra grain from watcher event
    let _watcherDimLight   = null;  // { lightObj, timer, duration } — light being dimmed
    let _lastMoveDir = null;        // direction player was moving (to pick "behind" direction)

    // =========================================
    //  HELPERS
    // =========================================

    /** Exponential random with minimum floor */
    function _expRandom(mean, min) {
        const raw = -mean * Math.log(1 - Math.random() + 1e-10);
        return Math.max(min, raw);
    }

    /** Pick a random open-space position within [minDist, maxDist] of the player */
    function _randomPositionNear(playerPos, minDist, maxDist) {
        if (!_mapData) return null;
        const { map, tileSize, rows, cols } = _mapData;

        // Try up to 20 random angles to find an open tile at the right distance
        for (let attempt = 0; attempt < 20; attempt++) {
            const angle = Math.random() * Math.PI * 2;
            const dist  = minDist + Math.random() * (maxDist - minDist);
            const wx = playerPos.x + Math.cos(angle) * dist;
            const wz = playerPos.z + Math.sin(angle) * dist;

            const col = Math.floor(wx / tileSize);
            const row = Math.floor(wz / tileSize);

            if (row >= 0 && row < rows && col >= 0 && col < cols && map[row][col] === 1) {
                return { x: wx, y: 1.5, z: wz };
            }
        }
        return null; // couldn't find valid position — skip this event
    }

    // =========================================
    //  INITIALIZATION
    // =========================================

    /**
     * @param {AudioContext} audioCtx
     * @param {GainNode} masterGain
     * @param {object} mapData — { map, tileSize, rows, cols }
     */
    function init(audioCtx, masterGain, mapData) {
        _audioCtx   = audioCtx;
        _masterGain  = masterGain;
        _mapData     = mapData;

        _nextDistantDelay = _expRandom(DISTANT_SOUND_MEAN_GAP, DISTANT_SOUND_MIN_GAP);
        _distantTimer     = 0;

        _nextWatcherDelay = _expRandom(WATCHER_MEAN_GAP, WATCHER_MIN_GAP);
        _watcherTimer     = 0;
        _watcherGrainBoost = 0;
        _watcherDimLight   = null;

        _vignetteStrength = VIGNETTE_BASE_STRENGTH;
        _playerStillTime  = 0;
        _lastPlayerPos    = null;
        _lastMoveDir      = null;

        _createOverlayDOM();
        _drawGrain();

        // Load MP3 assets asynchronously
        _loadRunningSound();
        _loadAlarmSound();

        _initialized = true;
    }

    /** Load the distant running MP3 into an AudioBuffer.
     *  Uses XMLHttpRequest instead of fetch — works on file:// protocol. */
    function _loadRunningSound() {
        if (!_audioCtx) {
            console.warn('[Atmosphere] No audio context — skipping MP3 load');
            return;
        }

        console.log('[Atmosphere] Loading distant_running.mp3...');

        var xhr = new XMLHttpRequest();
        xhr.open('GET', 'assets/distant_running.mp3', true);
        xhr.responseType = 'arraybuffer';

        xhr.onload = function () {
            if (xhr.status === 200 || xhr.status === 0) {  // status 0 for file://
                console.log('[Atmosphere] MP3 fetched, decoding... (' + xhr.response.byteLength + ' bytes)');
                _audioCtx.decodeAudioData(
                    xhr.response,
                    function (buffer) {
                        _runningBuffer = buffer;
                        console.log('[Atmosphere] distant_running.mp3 loaded OK — duration: ' + buffer.duration.toFixed(2) + 's');
                    },
                    function (err) {
                        console.error('[Atmosphere] Failed to decode distant_running.mp3', err);
                    }
                );
            } else {
                console.error('[Atmosphere] Failed to fetch distant_running.mp3 — status:', xhr.status);
            }
        };

        xhr.onerror = function () {
            console.error('[Atmosphere] XHR error loading distant_running.mp3');
        };

        xhr.send();
    }

    /** Load the distant alarm MP3 (loud source — we'll attenuate it) */
    function _loadAlarmSound() {
        if (!_audioCtx) return;

        var xhr = new XMLHttpRequest();
        xhr.open('GET', 'assets/distant_alarm.mp3', true);
        xhr.responseType = 'arraybuffer';

        xhr.onload = function () {
            if (xhr.status === 200 || xhr.status === 0) {
                _audioCtx.decodeAudioData(
                    xhr.response,
                    function (buffer) { _alarmBuffer = buffer; },
                    function (err) { console.error('[Atmosphere] Failed to decode distant_alarm.mp3', err); }
                );
            }
        };
        xhr.onerror = function () { console.error('[Atmosphere] XHR error loading distant_alarm.mp3'); };
        xhr.send();
    }

    // =========================================
    //  VISUAL OVERLAY (DOM)
    // =========================================

    function _createOverlayDOM() {
        // Container sits on top of the game canvas
        if (_overlayContainer) return; // already created

        _overlayContainer = document.createElement('div');
        _overlayContainer.id = 'atmosphere-overlay';
        _overlayContainer.style.cssText =
            'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;';

        // ── Grain canvas ──
        _grainCanvas = document.createElement('canvas');
        _grainCanvas.width  = 512;
        _grainCanvas.height = 512;
        _grainCanvas.style.cssText =
            'position:absolute;top:0;left:0;width:100%;height:100%;' +
            'opacity:' + GRAIN_BASE_OPACITY + ';mix-blend-mode:overlay;';
        _grainCtx = _grainCanvas.getContext('2d');
        _overlayContainer.appendChild(_grainCanvas);

        // ── Vignette (radial-gradient div) ──
        _vignetteEl = document.createElement('div');
        _vignetteEl.style.cssText =
            'position:absolute;top:0;left:0;width:100%;height:100%;' +
            'background:radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.35) 100%);';
        _overlayContainer.appendChild(_vignetteEl);

        // ── Static flash overlay ──
        _staticEl = document.createElement('div');
        _staticEl.style.cssText =
            'position:absolute;top:0;left:0;width:100%;height:100%;' +
            'background:white;opacity:0;mix-blend-mode:overlay;';
        _overlayContainer.appendChild(_staticEl);

        const gameScreen = document.getElementById('game-screen');
        if (gameScreen) {
            gameScreen.appendChild(_overlayContainer);
        }
    }

    /** Redraw the grain noise texture (called at ~15fps for that choppy film look) */
    function _drawGrain() {
        if (!_grainCtx) return;
        const w = _grainCanvas.width, h = _grainCanvas.height;
        const imgData = _grainCtx.createImageData(w, h);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            const v = Math.random() * 255;
            d[i] = d[i + 1] = d[i + 2] = v;
            d[i + 3] = 255;
        }
        _grainCtx.putImageData(imgData, 0, 0);
    }

    function _updateVignetteCSS() {
        if (!_vignetteEl) return;
        const s = _vignetteStrength;
        // Inner transparent radius shrinks as strength increases
        const inner = Math.max(10, 50 - s * 50);
        _vignetteEl.style.background =
            'radial-gradient(ellipse at center, transparent ' + inner + '%, rgba(0,0,0,' + s.toFixed(3) + ') 100%)';
    }

    // =========================================
    //  DISTANT SOUND EVENTS
    // =========================================

    const SOUND_TYPES = ['footsteps', 'scrape', 'breath', 'knock', 'whisper', 'running', 'running', 'alarm'];

    function _playDistantSound(playerPos) {
        if (!_audioCtx || !_masterGain) return;

        const pos = _randomPositionNear(playerPos, DISTANT_SOUND_MIN_DIST, DISTANT_SOUND_MAX_DIST);
        if (!pos) return;

        const type = SOUND_TYPES[Math.floor(Math.random() * SOUND_TYPES.length)];

        // Spatial panner
        const panner = _audioCtx.createPanner();
        panner.panningModel    = 'HRTF';
        panner.distanceModel   = 'inverse';
        panner.refDistance      = 2;
        panner.maxDistance      = 30;
        panner.rolloffFactor    = 2;
        panner.setPosition(pos.x, pos.y, pos.z);

        const now = _audioCtx.currentTime;

        switch (type) {
            case 'footsteps': _synthFootsteps(panner, now); break;
            case 'scrape':    _synthScrape(panner, now);    break;
            case 'breath':    _synthBreath(panner, now);    break;
            case 'knock':     _synthKnock(panner, now);     break;
            case 'whisper':   _synthWhisper(panner, now);   break;
            case 'running':   _playRunningMP3(panner, now); break;
            case 'alarm':     _playAlarmMP3(panner, now);   break;
        }

        panner.connect(_masterGain);
    }

    // --- Sound synthesis functions ---

    function _synthFootsteps(panner, now) {
        // 3-6 irregular soft thuds
        const count = 3 + Math.floor(Math.random() * 4);
        for (let i = 0; i < count; i++) {
            const t = now + i * (0.35 + Math.random() * 0.25);
            const bufLen = Math.floor(_audioCtx.sampleRate * 0.08);
            const buf = _audioCtx.createBuffer(1, bufLen, _audioCtx.sampleRate);
            const data = buf.getChannelData(0);
            for (let j = 0; j < bufLen; j++) {
                const env = Math.exp(-j / (bufLen * 0.15));
                data[j] = (Math.random() * 2 - 1) * 0.5 * env;
            }
            const src = _audioCtx.createBufferSource();
            src.buffer = buf;
            const g = _audioCtx.createGain();
            g.gain.setValueAtTime(DISTANT_SOUND_VOLUME * (0.7 + Math.random() * 0.6), t);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
            const lp = _audioCtx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = 300 + Math.random() * 200;
            src.connect(lp); lp.connect(g); g.connect(panner);
            src.start(t); src.stop(t + 0.1);
        }
    }

    function _synthScrape(panner, now) {
        // Long filtered noise — wet dragging sound
        const dur = 1.0 + Math.random() * 1.5;
        const bufLen = Math.floor(_audioCtx.sampleRate * dur);
        const buf = _audioCtx.createBuffer(1, bufLen, _audioCtx.sampleRate);
        const data = buf.getChannelData(0);
        for (let j = 0; j < bufLen; j++) {
            const t = j / bufLen;
            const env = Math.sin(t * Math.PI);  // swell in the middle
            data[j] = (Math.random() * 2 - 1) * 0.3 * env;
        }
        const src = _audioCtx.createBufferSource();
        src.buffer = buf;
        const bp = _audioCtx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 200 + Math.random() * 150; bp.Q.value = 3;
        const g = _audioCtx.createGain();
        g.gain.setValueAtTime(DISTANT_SOUND_VOLUME * 0.8, now);
        g.gain.setValueAtTime(0.001, now + dur);
        src.connect(bp); bp.connect(g); g.connect(panner);
        src.start(now); src.stop(now + dur + 0.05);
    }

    function _synthBreath(panner, now) {
        // 2-4 slow inhale/exhale cycles — filtered noise
        const cycles = 2 + Math.floor(Math.random() * 3);
        const cycleDur = 1.2 + Math.random() * 0.8;
        const totalDur = cycles * cycleDur;
        const bufLen = Math.floor(_audioCtx.sampleRate * totalDur);
        const buf = _audioCtx.createBuffer(1, bufLen, _audioCtx.sampleRate);
        const data = buf.getChannelData(0);
        for (let j = 0; j < bufLen; j++) {
            const t = j / bufLen;
            const cycleT = (t * cycles) % 1.0;
            const env = Math.sin(cycleT * Math.PI) * 0.35;
            data[j] = (Math.random() * 2 - 1) * env;
        }
        const src = _audioCtx.createBufferSource();
        src.buffer = buf;
        const bp = _audioCtx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 400; bp.Q.value = 0.8;
        const g = _audioCtx.createGain();
        g.gain.setValueAtTime(DISTANT_SOUND_VOLUME * 0.6, now);
        src.connect(bp); bp.connect(g); g.connect(panner);
        src.start(now); src.stop(now + totalDur + 0.05);
    }

    function _synthKnock(panner, now) {
        // 2-3 sharp taps on a wall
        const count = 2 + Math.floor(Math.random() * 2);
        for (let i = 0; i < count; i++) {
            const t = now + i * (0.3 + Math.random() * 0.4);
            const osc = _audioCtx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(120 + Math.random() * 60, t);
            osc.frequency.exponentialRampToValueAtTime(40, t + 0.06);
            const g = _audioCtx.createGain();
            g.gain.setValueAtTime(DISTANT_SOUND_VOLUME * 1.2, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
            osc.connect(g); g.connect(panner);
            osc.start(t); osc.stop(t + 0.1);
        }
    }

    function _synthWhisper(panner, now) {
        // Very faint filtered noise with sibilant character
        const dur = 0.8 + Math.random() * 1.0;
        const bufLen = Math.floor(_audioCtx.sampleRate * dur);
        const buf = _audioCtx.createBuffer(1, bufLen, _audioCtx.sampleRate);
        const data = buf.getChannelData(0);
        for (let j = 0; j < bufLen; j++) {
            const t = j / bufLen;
            const env = Math.sin(t * Math.PI) * 0.25;
            // Sibilance: mix broadband + high-freq emphasis
            data[j] = (Math.random() * 2 - 1) * env;
        }
        const src = _audioCtx.createBufferSource();
        src.buffer = buf;
        const hp = _audioCtx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 2000; hp.Q.value = 0.5;
        const lp = _audioCtx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 6000;
        const g = _audioCtx.createGain();
        g.gain.setValueAtTime(DISTANT_SOUND_VOLUME * 0.5, now);
        src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(panner);
        src.start(now); src.stop(now + dur + 0.05);
    }

    function _playRunningMP3(panner, now) {
        // Play the pre-loaded distant_running.mp3 through the spatial panner.
        // The source file is very quiet, so we boost the gain heavily.
        if (!_runningBuffer) {
            // Buffer hasn't loaded yet — fall back to synth footsteps
            _synthFootsteps(panner, now);
            return;
        }

        const src = _audioCtx.createBufferSource();
        src.buffer = _runningBuffer;

        // Heavy gain boost — the MP3 is monumentally quiet
        const g = _audioCtx.createGain();
        g.gain.setValueAtTime(DISTANT_SOUND_VOLUME * 12.0, now);

        src.connect(g);
        g.connect(panner);
        src.start(now);
    }

    function _playAlarmMP3(panner, now) {
        // Play the distant alarm sound. Source file is very loud, so we
        // attenuate it down to sit at a similar level to other distant sounds.
        if (!_alarmBuffer) {
            _synthKnock(panner, now);
            return;
        }

        const src = _audioCtx.createBufferSource();
        src.buffer = _alarmBuffer;

        // Quiet it down — source is very loud
        const g = _audioCtx.createGain();
        g.gain.setValueAtTime(DISTANT_SOUND_VOLUME * 0.3, now);

        src.connect(g);
        g.connect(panner);
        src.start(now);
    }

    // =========================================
    //  THE WATCHER
    // =========================================

    function _triggerWatcherEvent(playerPos) {
        if (!_audioCtx || !_masterGain) return;

        // Pick a random watcher behaviour
        const roll = Math.random();

        if (roll < 0.40) {
            // === Sound directly behind the player ===
            _playBehindSound(playerPos);
            _watcherGrainBoost = WATCHER_GRAIN_SPIKE;
        } else if (roll < 0.70) {
            // === Grain spike only (something "shifted" nearby) ===
            _watcherGrainBoost = WATCHER_GRAIN_SPIKE * 1.5;
        } else {
            // === Dim the nearest light briefly (room you just left) ===
            _dimNearestLight(playerPos);
            _watcherGrainBoost = WATCHER_GRAIN_SPIKE * 0.5;
        }
    }

    function _playBehindSound(playerPos) {
        if (!_lastMoveDir) return;

        // Place the sound 4-7 units behind the player
        const behindDist = 4 + Math.random() * 3;
        const bx = playerPos.x - _lastMoveDir.x * behindDist;
        const bz = playerPos.z - _lastMoveDir.z * behindDist;

        const panner = _audioCtx.createPanner();
        panner.panningModel  = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance    = 1;
        panner.maxDistance    = 15;
        panner.rolloffFactor  = 1.5;
        panner.setPosition(bx, 1.5, bz);

        const now = _audioCtx.currentTime;

        // Soft exhale / presence sound
        const dur = 0.6 + Math.random() * 0.6;
        const bufLen = Math.floor(_audioCtx.sampleRate * dur);
        const buf = _audioCtx.createBuffer(1, bufLen, _audioCtx.sampleRate);
        const data = buf.getChannelData(0);
        for (let j = 0; j < bufLen; j++) {
            const t = j / bufLen;
            const env = Math.sin(t * Math.PI) * 0.3;
            data[j] = (Math.random() * 2 - 1) * env;
        }
        const src = _audioCtx.createBufferSource();
        src.buffer = buf;

        const bp = _audioCtx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 300; bp.Q.value = 1.0;

        const g = _audioCtx.createGain();
        g.gain.setValueAtTime(WATCHER_BEHIND_SOUND_VOL, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + dur);

        src.connect(bp); bp.connect(g); g.connect(panner); panner.connect(_masterGain);
        src.start(now); src.stop(now + dur + 0.05);
    }

    function _dimNearestLight(playerPos) {
        const lights = LightingEngine.getLightObjects();
        if (lights.length === 0) return;

        // Find 2nd or 3rd nearest light (not the one you're standing under)
        let sorted = [];
        for (let i = 0; i < lights.length; i++) {
            const lp = lights[i].position;
            const dx = playerPos.x - lp.x, dz = playerPos.z - lp.z;
            sorted.push({ idx: i, dist: dx * dx + dz * dz });
        }
        sorted.sort((a, b) => a.dist - b.dist);

        // Pick the 2nd or 3rd nearest (skip index 0 — that's overhead)
        const pick = sorted[Math.min(1 + Math.floor(Math.random() * 2), sorted.length - 1)];
        const obj = lights[pick.idx];
        if (!obj || !obj.isActive) return;

        // Temporarily dim it
        _watcherDimLight = {
            lightObj: obj,
            timer: 0,
            duration: WATCHER_LIGHT_DIM_DUR,
            origOverride: obj.brightnessOverride,
        };
        LightingEngine.setLightBrightness(obj, obj.brightnessOverride * WATCHER_LIGHT_DIM_FRAC);
    }

    // =========================================
    //  UPDATE (called every frame from game.js)
    // =========================================

    /**
     * @param {number} dt
     * @param {THREE.Vector3} playerPos
     * @param {THREE.Vector3} playerForward — camera forward dir
     */
    function update(dt, playerPos, playerForward) {
        if (!_initialized) return;

        // Track player movement for "still" detection and "behind" direction
        if (_lastPlayerPos) {
            const dx = playerPos.x - _lastPlayerPos.x;
            const dz = playerPos.z - _lastPlayerPos.z;
            const moved = Math.sqrt(dx * dx + dz * dz);

            if (moved > 0.01) {
                _playerStillTime = 0;
                _lastMoveDir = { x: dx / moved, z: dz / moved };
            } else {
                _playerStillTime += dt;
            }
        } else {
            _lastMoveDir = { x: playerForward.x, z: playerForward.z };
        }
        _lastPlayerPos = { x: playerPos.x, z: playerPos.z };

        // ── Distant sounds ──
        _distantTimer += dt;
        if (_distantTimer >= _nextDistantDelay) {
            _distantTimer = 0;
            _nextDistantDelay = _expRandom(DISTANT_SOUND_MEAN_GAP, DISTANT_SOUND_MIN_GAP);
            _playDistantSound(playerPos);
        }

        // ── Watcher ──
        _watcherTimer += dt;
        if (_watcherTimer >= _nextWatcherDelay) {
            _watcherTimer = 0;
            _nextWatcherDelay = _expRandom(WATCHER_MEAN_GAP, WATCHER_MIN_GAP);
            _triggerWatcherEvent(playerPos);
        }

        // Fade watcher grain boost
        if (_watcherGrainBoost > 0) {
            _watcherGrainBoost -= dt / WATCHER_GRAIN_SPIKE_DUR;
            if (_watcherGrainBoost < 0) _watcherGrainBoost = 0;
        }

        // Recover watcher light dim
        if (_watcherDimLight) {
            _watcherDimLight.timer += dt;
            const t = _watcherDimLight.timer / _watcherDimLight.duration;
            if (t >= 1.0) {
                LightingEngine.setLightBrightness(
                    _watcherDimLight.lightObj,
                    _watcherDimLight.origOverride
                );
                _watcherDimLight = null;
            } else {
                // Smoothly fade brightness back
                const dimmed = _watcherDimLight.origOverride * WATCHER_LIGHT_DIM_FRAC;
                const current = dimmed + (_watcherDimLight.origOverride - dimmed) * t;
                LightingEngine.setLightBrightness(_watcherDimLight.lightObj, current);
            }
        }

        // ── Visual: grain ──
        _grainTimer += dt;
        if (_grainTimer >= GRAIN_UPDATE_INTERVAL) {
            _grainTimer = 0;
            _drawGrain();
        }
        // Grain opacity = base + watcher boost
        if (_grainCanvas) {
            const grainOp = Math.min(0.35, GRAIN_BASE_OPACITY + _watcherGrainBoost);
            _grainCanvas.style.opacity = grainOp.toFixed(3);
        }

        // ── Visual: vignette ──
        if (_playerStillTime > 2.0) {
            // Vignette tightens when you stand still
            _vignetteStrength = Math.min(
                VIGNETTE_MAX_STRENGTH,
                _vignetteStrength + VIGNETTE_STILL_GROWTH * dt
            );
        } else {
            // Eases back when moving
            _vignetteStrength = Math.max(
                VIGNETTE_BASE_STRENGTH,
                _vignetteStrength - VIGNETTE_RECOVER_SPEED * dt
            );
        }
        _updateVignetteCSS();

        // ── Visual: random static flash ──
        if (_staticActive) {
            _staticTimer -= dt;
            if (_staticTimer <= 0) {
                _staticActive = false;
                if (_staticEl) _staticEl.style.opacity = '0';
            }
        } else if (Math.random() < STATIC_CHANCE_PER_SEC * dt) {
            _staticActive = true;
            _staticTimer = STATIC_DURATION;
            if (_staticEl) _staticEl.style.opacity = (0.03 + Math.random() * 0.04).toFixed(3);
        }
    }

    // =========================================
    //  CLEANUP
    // =========================================

    function reset() {
        _distantTimer      = 0;
        _nextDistantDelay  = _expRandom(DISTANT_SOUND_MEAN_GAP, DISTANT_SOUND_MIN_GAP);
        _watcherTimer      = 0;
        _nextWatcherDelay  = _expRandom(WATCHER_MEAN_GAP, WATCHER_MIN_GAP);
        _watcherGrainBoost = 0;
        _watcherDimLight   = null;
        _vignetteStrength  = VIGNETTE_BASE_STRENGTH;
        _playerStillTime   = 0;
        _lastPlayerPos     = null;
        _lastMoveDir       = null;
        _staticActive      = false;

        if (_grainCanvas)  _grainCanvas.style.opacity = GRAIN_BASE_OPACITY;
        if (_staticEl)     _staticEl.style.opacity = '0';
        _updateVignetteCSS();
    }

    function destroy() {
        reset();
        if (_overlayContainer && _overlayContainer.parentNode) {
            _overlayContainer.parentNode.removeChild(_overlayContainer);
        }
        _overlayContainer = null;
        _grainCanvas = null;
        _grainCtx = null;
        _vignetteEl = null;
        _staticEl = null;
        _initialized = false;
    }

    function isInitialized() { return _initialized; }



    return {
        init,
        update,
        reset,
        destroy,
        isInitialized,
    };
})();
