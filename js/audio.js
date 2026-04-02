/* ========================================
   Audio Manager
   Spatial 3D positional audio with PannerNodes
   ======================================== */

const AudioManager = (() => {
    let audioCtx = null;
    let masterGain = null;
    let isInitialized = false;
    let masterVolume = 0.7;

    // Positional audio sources (one per light)
    const sources = [];

    // Stored positions for rebuilding after stop/restart
    let storedPositions = [];

    /** Initialize the Web Audio API context (only once) */
    function init() {
        if (isInitialized) return;
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = masterVolume;
        masterGain.connect(audioCtx.destination);
        isInitialized = true;
    }

    /** Resume audio context (required after user gesture) */
    function resume() {
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    }

    /**
     * Create the fluorescent hum sound using oscillators + PannerNode.
     * @param {THREE.Vector3} position - World position for the panner
     * @returns {object|null}
     */
    function createFluorescentHum(position) {
        if (!audioCtx) return null;

        // --- Panner for true 3D spatial audio ---
        const panner = audioCtx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 1.5;
        panner.maxDistance = 18;
        panner.rolloffFactor = 2.5;
        panner.coneInnerAngle = 360;
        panner.coneOuterAngle = 360;
        panner.coneOuterGain = 0.4;
        panner.setPosition(position.x, position.y, position.z);

        // Base 60Hz hum (loud)
        const osc1 = audioCtx.createOscillator();
        osc1.type = 'sine';
        osc1.frequency.value = 60;

        // 120Hz harmonic
        const osc2 = audioCtx.createOscillator();
        osc2.type = 'sine';
        osc2.frequency.value = 120;

        // 180Hz harmonic
        const osc3 = audioCtx.createOscillator();
        osc3.type = 'sine';
        osc3.frequency.value = 180;

        // High-frequency buzz
        const osc4 = audioCtx.createOscillator();
        osc4.type = 'sawtooth';
        osc4.frequency.value = 240;

        // Flicker modulation
        const lfo = audioCtx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 0.2 + Math.random() * 0.5;
        const lfoGain = audioCtx.createGain();
        lfoGain.gain.value = 0.02;
        lfo.connect(lfoGain);
        lfoGain.connect(osc1.frequency);

        // Individual gain nodes — present but not dominant
        const gain1 = audioCtx.createGain();
        gain1.gain.value = 0.18;

        const gain2 = audioCtx.createGain();
        gain2.gain.value = 0.09;

        const gain3 = audioCtx.createGain();
        gain3.gain.value = 0.035;

        const gain4 = audioCtx.createGain();
        gain4.gain.value = 0.012;

        // Low-pass filter for warmth
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 500;
        filter.Q.value = 1.2;

        // Mix bus before panner
        const mixGain = audioCtx.createGain();
        mixGain.gain.value = 1.0;

        // Connect oscillators → gains → filter → mix → panner → master
        osc1.connect(gain1);
        osc2.connect(gain2);
        osc3.connect(gain3);
        osc4.connect(gain4);

        gain1.connect(filter);
        gain2.connect(filter);
        gain3.connect(filter);
        gain4.connect(filter);

        filter.connect(mixGain);
        mixGain.connect(panner);
        panner.connect(masterGain);

        // Start
        osc1.start();
        osc2.start();
        osc3.start();
        osc4.start();
        lfo.start();

        return {
            panner,
            mixGain,
            oscillators: [osc1, osc2, osc3, osc4, lfo],
        };
    }

    /**
     * Register a light position and create a spatial hum for it.
     * @param {THREE.Vector3} position
     * @returns {number}
     */
    function addLightSource(position) {
        const hum = createFluorescentHum(position);
        if (!hum) return -1;

        sources.push({
            position: position.clone(),
            panner: hum.panner,
            mixGain: hum.mixGain,
            oscillators: hum.oscillators,
        });

        // Store position for rebuild
        storedPositions.push(position.clone());

        return sources.length - 1;
    }

    /**
     * Update the Web Audio listener to match the camera.
     * @param {THREE.Vector3} listenerPos
     * @param {THREE.Vector3} listenerForward - Camera forward direction
     * @param {THREE.Vector3} listenerUp - Camera up direction
     */
    function updateListener(listenerPos, listenerForward, listenerUp) {
        if (!audioCtx) return;

        const listener = audioCtx.listener;

        // Position
        if (listener.positionX) {
            listener.positionX.setValueAtTime(listenerPos.x, audioCtx.currentTime);
            listener.positionY.setValueAtTime(listenerPos.y, audioCtx.currentTime);
            listener.positionZ.setValueAtTime(listenerPos.z, audioCtx.currentTime);
        } else {
            listener.setPosition(listenerPos.x, listenerPos.y, listenerPos.z);
        }

        // Orientation (forward + up)
        if (listenerForward && listenerUp) {
            if (listener.forwardX) {
                listener.forwardX.setValueAtTime(listenerForward.x, audioCtx.currentTime);
                listener.forwardY.setValueAtTime(listenerForward.y, audioCtx.currentTime);
                listener.forwardZ.setValueAtTime(listenerForward.z, audioCtx.currentTime);
                listener.upX.setValueAtTime(listenerUp.x, audioCtx.currentTime);
                listener.upY.setValueAtTime(listenerUp.y, audioCtx.currentTime);
                listener.upZ.setValueAtTime(listenerUp.z, audioCtx.currentTime);
            } else {
                listener.setOrientation(
                    listenerForward.x, listenerForward.y, listenerForward.z,
                    listenerUp.x, listenerUp.y, listenerUp.z
                );
            }
        }
    }

    /** Set master volume (0–1) */
    function setMasterVolume(v) {
        masterVolume = Math.max(0, Math.min(1, v));
        if (masterGain && audioCtx) {
            masterGain.gain.setTargetAtTime(masterVolume, audioCtx.currentTime, 0.05);
        }
    }

    /** Get current master volume */
    function getMasterVolume() {
        return masterVolume;
    }

    /** Stop all oscillators and clear sources (keeps context alive) */
    function stopAll() {
        for (const src of sources) {
            for (const osc of src.oscillators) {
                try { osc.stop(); } catch (e) { /* already stopped */ }
            }
            try { src.panner.disconnect(); } catch (e) {}
            try { src.mixGain.disconnect(); } catch (e) {}
        }
        sources.length = 0;
    }

    /**
     * Rebuild all light sources from stored positions.
     * Called when re-entering the game after quitting to menu.
     */
    function rebuildSources() {
        // Stop any existing sources first
        stopAll();

        // Ensure context exists and is running
        if (!isInitialized) init();
        resume();

        // Recreate hums from stored positions
        const positions = storedPositions.slice();
        storedPositions.length = 0;

        for (const pos of positions) {
            addLightSource(pos);
        }

        // Restore volume
        if (masterGain && audioCtx) {
            masterGain.gain.setTargetAtTime(masterVolume, audioCtx.currentTime, 0.05);
        }
    }

    /**
     * Play a body-fall impact sound (for tripping).
     * @param {boolean} wasSprinting - louder/heavier for sprint falls
     */
    function playFallSound(wasSprinting) {
        if (!audioCtx) return;
        resume();

        const now = audioCtx.currentTime;

        // Sprint falls are louder and have more bass
        const vol = wasSprinting ? 1.0 : 0.75;
        const bassFreq = wasSprinting ? 65 : 80;
        const duration = wasSprinting ? 0.4 : 0.3;

        // Thud — low sine burst
        const thud = audioCtx.createOscillator();
        thud.type = 'sine';
        thud.frequency.setValueAtTime(bassFreq, now);
        thud.frequency.exponentialRampToValueAtTime(25, now + duration * 0.5);

        const thudGain = audioCtx.createGain();
        thudGain.gain.setValueAtTime(vol, now);
        thudGain.gain.exponentialRampToValueAtTime(0.001, now + duration);

        // Secondary mid thud for sprint (body sliding impact)
        let thud2, thud2Gain;
        if (wasSprinting) {
            thud2 = audioCtx.createOscillator();
            thud2.type = 'sine';
            thud2.frequency.setValueAtTime(120, now + 0.04);
            thud2.frequency.exponentialRampToValueAtTime(40, now + 0.2);
            thud2Gain = audioCtx.createGain();
            thud2Gain.gain.setValueAtTime(0.45, now + 0.04);
            thud2Gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
            thud2.connect(thud2Gain);
            thud2Gain.connect(masterGain);
        }

        // Noise burst for cloth/body impact
        const bufLen = audioCtx.sampleRate * (wasSprinting ? 0.3 : 0.2);
        const noiseBuffer = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufLen; i++) {
            data[i] = (Math.random() * 2 - 1) * (wasSprinting ? 0.4 : 0.3);
        }
        const noise = audioCtx.createBufferSource();
        noise.buffer = noiseBuffer;

        const noiseGain = audioCtx.createGain();
        noiseGain.gain.setValueAtTime(vol * 0.5, now);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, now + duration * 0.8);

        const noiseFilter = audioCtx.createBiquadFilter();
        noiseFilter.type = 'lowpass';
        noiseFilter.frequency.value = wasSprinting ? 800 : 600;

        // Connect
        thud.connect(thudGain);
        thudGain.connect(masterGain);

        noise.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(masterGain);

        thud.start(now);
        thud.stop(now + duration);
        noise.start(now);
        noise.stop(now + duration);

        if (wasSprinting && thud2) {
            thud2.start(now + 0.04);
            thud2.stop(now + 0.25);
        }
    }

    // =========================================
    //  SPATIAL SOURCE VOLUME CONTROL
    //  Mute/fade the positional fluorescent hums
    // =========================================

    /** Set all spatial source mixGains to a value immediately */
    function muteSpatialSources() {
        if (!audioCtx) return;
        const now = audioCtx.currentTime;
        for (const src of sources) {
            src.mixGain.gain.cancelScheduledValues(now);
            src.mixGain.gain.setValueAtTime(0.0, now);
        }
    }

    /** Fade all spatial source mixGains from current value to 1.0 over duration */
    function fadeSpatialSourcesIn(duration) {
        if (!audioCtx) return;
        const now = audioCtx.currentTime;
        for (const src of sources) {
            src.mixGain.gain.cancelScheduledValues(now);
            src.mixGain.gain.setValueAtTime(src.mixGain.gain.value, now);
            src.mixGain.gain.linearRampToValueAtTime(1.0, now + duration);
        }
    }

    // =========================================
    //  INDIVIDUAL SOURCE CONTROL (for light flicker)
    // =========================================

    /** Mute a single spatial source by index (fast fade to silence) */
    function muteSource(index) {
        if (!audioCtx || index < 0 || index >= sources.length) return;
        const src = sources[index];
        const now = audioCtx.currentTime;
        src.mixGain.gain.cancelScheduledValues(now);
        src.mixGain.gain.setValueAtTime(src.mixGain.gain.value, now);
        src.mixGain.gain.linearRampToValueAtTime(0.0, now + 0.05);
    }

    /** Unmute a single spatial source by index (fade back to 1.0) */
    function unmuteSource(index, fadeDuration) {
        if (!audioCtx || index < 0 || index >= sources.length) return;
        const src = sources[index];
        const now = audioCtx.currentTime;
        const dur = fadeDuration || 0.3;
        src.mixGain.gain.cancelScheduledValues(now);
        src.mixGain.gain.setValueAtTime(src.mixGain.gain.value, now);
        src.mixGain.gain.linearRampToValueAtTime(1.0, now + dur);
    }

    /**
     * Play an electrical flicker/power-out sound effect.
     * Non-positional — heard from the player's perspective.
     */
    function playFlickerSound() {
        if (!audioCtx) return;
        resume();

        const now = audioCtx.currentTime;

        // --- Electrical buzz/crackle ---
        // Short burst of filtered noise (like a tube shorting)
        const bufLen = Math.floor(audioCtx.sampleRate * 0.25);
        const noiseBuffer = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufLen; i++) {
            // Crackly noise with 60Hz modulation
            const env = Math.exp(-i / (audioCtx.sampleRate * 0.08));
            const buzz = Math.sin(i / audioCtx.sampleRate * 60 * Math.PI * 2);
            data[i] = (Math.random() * 2 - 1) * 0.6 * env * (0.4 + 0.6 * Math.abs(buzz));
        }
        const noise = audioCtx.createBufferSource();
        noise.buffer = noiseBuffer;

        // Band-pass for electrical character
        const bpFilter = audioCtx.createBiquadFilter();
        bpFilter.type = 'bandpass';
        bpFilter.frequency.value = 400;
        bpFilter.Q.value = 1.5;

        const noiseGain = audioCtx.createGain();
        noiseGain.gain.setValueAtTime(0.35, now);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

        noise.connect(bpFilter);
        bpFilter.connect(noiseGain);
        noiseGain.connect(masterGain);

        // --- Thunk: low-freq power-down thud ---
        const thunk = audioCtx.createOscillator();
        thunk.type = 'sine';
        thunk.frequency.setValueAtTime(100, now);
        thunk.frequency.exponentialRampToValueAtTime(30, now + 0.15);

        const thunkGain = audioCtx.createGain();
        thunkGain.gain.setValueAtTime(0.25, now);
        thunkGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

        thunk.connect(thunkGain);
        thunkGain.connect(masterGain);

        // --- Brief high-freq tick (relay click) ---
        const tick = audioCtx.createOscillator();
        tick.type = 'square';
        tick.frequency.value = 2000;

        const tickGain = audioCtx.createGain();
        tickGain.gain.setValueAtTime(0.12, now);
        tickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.02);

        tick.connect(tickGain);
        tickGain.connect(masterGain);

        // Start and stop
        noise.start(now);
        noise.stop(now + 0.25);
        thunk.start(now);
        thunk.stop(now + 0.15);
        tick.start(now);
        tick.stop(now + 0.02);
    }

    /**
     * Play an electrical power-restoration sound (light coming back on).
     * Brighter, more "warming up" character than the off-sound.
     */
    function playFlickerOnSound() {
        if (!audioCtx) return;
        resume();

        const now = audioCtx.currentTime;

        // --- Electrical buzz that builds (tube warming up) ---
        const bufLen = Math.floor(audioCtx.sampleRate * 0.4);
        const noiseBuffer = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufLen; i++) {
            const t = i / bufLen;
            // Envelope: builds up then sustains, with 60Hz character
            const env = Math.min(t * 4, 1.0) * (0.5 + 0.5 * Math.exp(-t * 2));
            const buzz = Math.sin(i / audioCtx.sampleRate * 120 * Math.PI * 2);
            data[i] = (Math.random() * 2 - 1) * 0.4 * env * (0.3 + 0.7 * Math.abs(buzz));
        }
        const noise = audioCtx.createBufferSource();
        noise.buffer = noiseBuffer;

        const bpFilter = audioCtx.createBiquadFilter();
        bpFilter.type = 'bandpass';
        bpFilter.frequency.value = 500;
        bpFilter.Q.value = 1.2;

        const noiseGain = audioCtx.createGain();
        noiseGain.gain.setValueAtTime(0.0, now);
        noiseGain.gain.linearRampToValueAtTime(0.3, now + 0.08);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

        noise.connect(bpFilter);
        bpFilter.connect(noiseGain);
        noiseGain.connect(masterGain);

        // --- Rising tone (power-up whine) ---
        const whine = audioCtx.createOscillator();
        whine.type = 'sine';
        whine.frequency.setValueAtTime(80, now);
        whine.frequency.exponentialRampToValueAtTime(200, now + 0.3);

        const whineGain = audioCtx.createGain();
        whineGain.gain.setValueAtTime(0.15, now);
        whineGain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

        whine.connect(whineGain);
        whineGain.connect(masterGain);

        // --- Click/clunk (ballast engaging) ---
        const clunk = audioCtx.createOscillator();
        clunk.type = 'square';
        clunk.frequency.value = 1500;

        const clunkGain = audioCtx.createGain();
        clunkGain.gain.setValueAtTime(0.10, now);
        clunkGain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);

        clunk.connect(clunkGain);
        clunkGain.connect(masterGain);

        noise.start(now);
        noise.stop(now + 0.4);
        whine.start(now);
        whine.stop(now + 0.35);
        clunk.start(now);
        clunk.stop(now + 0.03);
    }

    /** Get the number of spatial sources */
    function getSourceCount() {
        return sources.length;
    }

    /** Get position of a spatial source by index */
    function getSourcePosition(index) {
        if (index < 0 || index >= sources.length) return null;
        return sources[index].position;
    }

    // =========================================
    //  AMBIENT LOADING HUM
    //  A non-positional hum for the loading screen
    // =========================================
    let ambientHumNodes = null;

    /** Start a faint ambient hum (non-positional, for loading screen) */
    function startAmbientHum() {
        if (!isInitialized) init();
        resume();
        if (ambientHumNodes) stopAmbientHum();

        const now = audioCtx.currentTime;

        const humGain = audioCtx.createGain();
        humGain.gain.setValueAtTime(0, now);
        // Fade in over 1.5s to a low level
        humGain.gain.linearRampToValueAtTime(0.13, now + 1.5);
        humGain.connect(masterGain);

        const filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 350;
        filter.Q.value = 0.8;
        filter.connect(humGain);

        const osc1 = audioCtx.createOscillator();
        osc1.type = 'sine';
        osc1.frequency.value = 60;
        osc1.connect(filter);
        osc1.start();

        const osc2 = audioCtx.createOscillator();
        osc2.type = 'sine';
        osc2.frequency.value = 120;
        const g2 = audioCtx.createGain();
        g2.gain.value = 0.4;
        osc2.connect(g2);
        g2.connect(filter);
        osc2.start();

        ambientHumNodes = { gain: humGain, oscillators: [osc1, osc2], extra: [g2, filter] };
    }

    /** Fade the ambient hum to complete silence (called when loading finishes) */
    function fadeAmbientHumOut(duration) {
        if (!ambientHumNodes || !audioCtx) return;
        const dur = duration || 0.8;
        const now = audioCtx.currentTime;
        ambientHumNodes.gain.gain.cancelScheduledValues(now);
        ambientHumNodes.gain.gain.setValueAtTime(ambientHumNodes.gain.gain.value, now);
        ambientHumNodes.gain.gain.linearRampToValueAtTime(0.001, now + dur);
    }

    /**
     * Fade ambient hum back in from silence over a duration.
     * Used during the standing-up intro so the world audio settles in gradually.
     */
    function fadeAmbientHumIn(duration) {
        if (!ambientHumNodes || !audioCtx) return;
        const now = audioCtx.currentTime;
        ambientHumNodes.gain.gain.cancelScheduledValues(now);
        // Start from current value (should be ~0 after fadeOut)
        ambientHumNodes.gain.gain.setValueAtTime(ambientHumNodes.gain.gain.value, now);
        ambientHumNodes.gain.gain.linearRampToValueAtTime(0.13, now + duration);
    }

    /** Stop and clean up ambient hum */
    function stopAmbientHum() {
        if (!ambientHumNodes) return;
        for (const osc of ambientHumNodes.oscillators) {
            try { osc.stop(); } catch (e) {}
        }
        for (const node of ambientHumNodes.extra) {
            try { node.disconnect(); } catch (e) {}
        }
        try { ambientHumNodes.gain.disconnect(); } catch (e) {}
        ambientHumNodes = null;
    }

    /** Full cleanup */
    function dispose() {
        stopAll();
        stopAmbientHum();
        storedPositions.length = 0;
        if (audioCtx) {
            audioCtx.close();
            audioCtx = null;
        }
        isInitialized = false;
    }

    /** Expose raw AudioContext + master gain node for Atmosphere engine */
    function getContext()       { return audioCtx; }
    function getMasterGainNode() { return masterGain; }

    return {
        init,
        resume,
        addLightSource,
        updateListener,
        setMasterVolume,
        getMasterVolume,
        getContext,
        getMasterGainNode,
        stopAll,
        rebuildSources,
        playFallSound,
        muteSpatialSources,
        fadeSpatialSourcesIn,
        muteSource,
        unmuteSource,
        playFlickerSound,
        playFlickerOnSound,
        getSourceCount,
        getSourcePosition,
        startAmbientHum,
        fadeAmbientHumOut,
        fadeAmbientHumIn,
        stopAmbientHum,
        dispose,
    };
})();

