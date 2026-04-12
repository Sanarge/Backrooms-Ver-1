/* ========================================
   Multiplayer Manager
   Manages remote player models in the scene,
   interpolates server state, syncs local
   player input to server.
   ======================================== */

const Multiplayer = (() => {

    let scene = null;
    let isActive = false;
    let localPlayerId = null;

    // Remote player tracking: playerId -> { model, serverState, prevState, interpT }
    const remotePlayers = {};

    // Interpolation settings
    const INTERP_DURATION = 0.05; // 50ms (1 tick at 20Hz)
    const POSITION_SNAP_THRESHOLD = 5.0; // snap if too far apart

    // Input send rate (match server tick rate)
    let inputSendTimer = 0;
    const INPUT_SEND_INTERVAL = 1 / 20; // 20Hz

    // Remote player footstep timing
    const FOOTSTEP_WALK_INTERVAL = 0.55;  // seconds between steps when walking
    const FOOTSTEP_RUN_INTERVAL = 0.32;   // seconds between steps when running

    // =========================================
    //  INIT / SHUTDOWN
    // =========================================

    /**
     * Initialize multiplayer system.
     * @param {THREE.Scene} gameScene
     * @param {string} myPlayerId — the local player's ID from the server
     */
    function init(gameScene, myPlayerId) {
        scene = gameScene;
        localPlayerId = myPlayerId;
        isActive = true;
        inputSendTimer = 0;

        console.log('[Multiplayer] Init — localPlayerId:', localPlayerId, 'scene:', !!scene);

        // Listen for game state updates
        Network.on('game_state', _onGameState);
    }

    /**
     * Shut down multiplayer — remove all remote models.
     */
    function shutdown() {
        isActive = false;
        Network.off('game_state');

        // Remove all remote player models
        for (const pid in remotePlayers) {
            _removeRemotePlayer(pid);
        }

        scene = null;
        localPlayerId = null;
    }

    // =========================================
    //  GAME STATE HANDLER
    // =========================================

    let _debugLogCount = 0;

    function _onGameState(data) {
        if (!isActive || !data.data || !data.data.players) return;

        const serverPlayers = data.data.players;
        const seenIds = new Set();

        // Debug: log first few game states to verify player data
        if (_debugLogCount < 5) {
            _debugLogCount++;
            const pids = Object.keys(serverPlayers);
            console.log('[Multiplayer] game_state #' + _debugLogCount +
                ' — players:', pids.length, 'ids:', pids,
                'localId:', localPlayerId,
                'remoteCount:', Object.keys(remotePlayers).length);
        }

        for (const pid in serverPlayers) {
            seenIds.add(pid);

            // Skip local player (we control our own camera)
            if (pid === localPlayerId) {
                // Apply server corrections to local player
                _applyLocalCorrection(serverPlayers[pid]);
                continue;
            }

            const sp = serverPlayers[pid];

            if (!remotePlayers[pid]) {
                // New remote player — create model
                _addRemotePlayer(pid, sp);
            }

            // Update server state for interpolation
            const rp = remotePlayers[pid];
            rp.prevState = rp.serverState ? { ...rp.serverState } : null;
            rp.serverState = {
                x: sp.position.x,
                y: sp.position.y,
                z: sp.position.z,
                yaw: sp.rotation.yaw,
                state: sp.state,
            };
            rp.interpT = 0;
        }

        // Remove players no longer in server state
        for (const pid in remotePlayers) {
            if (!seenIds.has(pid)) {
                _removeRemotePlayer(pid);
            }
        }
    }

    // =========================================
    //  REMOTE PLAYER MANAGEMENT
    // =========================================

    function _addRemotePlayer(playerId, serverData) {
        console.log('[Multiplayer] Adding remote player:', playerId, serverData.player_name,
            'at', serverData.position.x.toFixed(1), serverData.position.y.toFixed(1), serverData.position.z.toFixed(1));
        const model = PlayerModel.create(serverData.player_name || 'Player');

        // Set initial position
        model.position.set(
            serverData.position.x,
            0, // feet on ground
            serverData.position.z
        );

        // Face the right direction
        model.rotation.y = (serverData.rotation.yaw || 0) * Math.PI / 180;

        if (scene) scene.add(model);

        remotePlayers[playerId] = {
            model: model,
            serverState: {
                x: serverData.position.x,
                y: serverData.position.y,
                z: serverData.position.z,
                yaw: serverData.rotation.yaw || 0,
                state: serverData.state || 'idle',
            },
            prevState: null,
            interpT: 0,
            name: serverData.player_name,
            footstepTimer: 0, // accumulates dt, triggers spatial footstep
        };
    }

    function _removeRemotePlayer(playerId) {
        const rp = remotePlayers[playerId];
        if (!rp) return;

        if (scene && rp.model) {
            scene.remove(rp.model);
        }
        PlayerModel.dispose(rp.model);
        delete remotePlayers[playerId];
    }

    // =========================================
    //  LOCAL PLAYER CORRECTION
    // =========================================

    function _applyLocalCorrection(serverState) {
        // Light-touch correction: only snap if desync is extreme
        // The server is authoritative, but we don't want rubber-banding
        const localPos = Player.getPosition();
        const dx = serverState.position.x - localPos.x;
        const dz = serverState.position.z - localPos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist > POSITION_SNAP_THRESHOLD) {
            // Snap — too far out of sync
            // We'd need Player to expose a setPosition method for this
            console.warn('[Multiplayer] Large desync detected:', dist.toFixed(1), 'units');
        }
    }

    // =========================================
    //  UPDATE (called each frame)
    // =========================================

    /**
     * Update remote player interpolation and send local input.
     * @param {number} dt — delta time in seconds
     */
    function update(dt) {
        if (!isActive) return;

        // Interpolate remote players
        for (const pid in remotePlayers) {
            const rp = remotePlayers[pid];
            if (!rp.model || !rp.serverState) continue;

            rp.interpT += dt / INTERP_DURATION;
            rp.interpT = Math.min(rp.interpT, 1.0);

            const ss = rp.serverState;
            const ps = rp.prevState || ss;
            const t = rp.interpT;

            // Interpolate position
            rp.model.position.x = ps.x + (ss.x - ps.x) * t;
            rp.model.position.z = ps.z + (ss.z - ps.z) * t;
            // Y position stays at ground level (model places itself)

            // Interpolate rotation (yaw)
            const targetYaw = ss.yaw * Math.PI / 180;
            const prevYaw = ps.yaw * Math.PI / 180;
            rp.model.rotation.y = prevYaw + _shortAngleDist(prevYaw, targetYaw) * t;

            // Animate the stick figure
            PlayerModel.animate(rp.model, ss.state, dt);

            // Remote player footstep audio
            const isWalking = (ss.state === 'walking');
            const isRunning = (ss.state === 'running');
            if (isWalking || isRunning) {
                const interval = isRunning ? FOOTSTEP_RUN_INTERVAL : FOOTSTEP_WALK_INTERVAL;
                rp.footstepTimer += dt;
                if (rp.footstepTimer >= interval) {
                    rp.footstepTimer -= interval;
                    AudioManager.playSpatialFootstep(
                        { x: rp.model.position.x, y: 0, z: rp.model.position.z },
                        isRunning
                    );
                }
            } else {
                rp.footstepTimer = 0;
            }
        }

        // Send local input to server
        inputSendTimer += dt;
        if (inputSendTimer >= INPUT_SEND_INTERVAL) {
            inputSendTimer -= INPUT_SEND_INTERVAL;
            _sendLocalInput();
        }
    }

    /**
     * Send current local player state to the server.
     * Sends actual position + rotation so the server can relay to others.
     */
    function _sendLocalInput() {
        if (!Network.getIsConnected()) return;

        const pos = Player.getPosition();
        const dirs = Player.getCameraDirections();
        const stamina = Player.getStamina();

        // Extract yaw/pitch from camera direction
        const fwd = dirs.forward;
        const yaw = Math.atan2(fwd.x, fwd.z) * 180 / Math.PI;
        const pitch = Math.asin(-fwd.y) * 180 / Math.PI;

        // Determine movement state
        const keys = Player._getKeys ? Player._getKeys() : {};
        let state = 'idle';
        if (keys.crouch) state = 'crouching';
        else if (keys.sprint && (keys.forward || keys.backward || keys.left || keys.right)) state = 'running';
        else if (keys.forward || keys.backward || keys.left || keys.right) state = 'walking';

        // Send full player state — server relays position to other clients
        Network.send({
            type: 'player_input',
            keys: keys,
            mouse: { yaw: yaw, pitch: pitch },
            position: { x: pos.x, y: pos.y, z: pos.z },
            state: state,
        });
    }

    // =========================================
    //  UTILS
    // =========================================

    function _shortAngleDist(from, to) {
        const max = Math.PI * 2;
        const da = ((to - from) % max + max) % max;
        if (da > Math.PI) return da - max;
        return da;
    }

    function getRemotePlayerCount() {
        return Object.keys(remotePlayers).length;
    }

    function getIsActive() { return isActive; }

    return {
        init,
        shutdown,
        update,
        getRemotePlayerCount,
        getIsActive,
    };
})();
