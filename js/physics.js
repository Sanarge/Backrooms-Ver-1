/* ========================================
   Physics & Interaction Engine
   ─────────────────────────────────────────
   Handles:
   1. Rigid-body physics for props (gravity,
      velocity, friction, bounce, rotation)
   2. Raycasting to detect clickable objects
   3. Pick-up / carry / throw mechanics
   ======================================== */

const Physics = (() => {

    // =========================================
    //  CONSTANTS
    // =========================================

    const GRAVITY          = -12.0;
    const FLOOR_Y          = 0.0;
    const FRICTION         = 0.92;
    const AIR_FRICTION     = 0.995;
    const BOUNCE_FACTOR    = 0.3;
    const ANGULAR_FRICTION = 0.90;
    const SLEEP_THRESHOLD  = 0.05;
    const ANGULAR_SLEEP    = 0.02;

    // Interaction
    const PICK_UP_RANGE    = 3.5;
    const CARRY_DISTANCE   = 2.0;
    const CARRY_HEIGHT     = -0.3;
    const CARRY_LERP_SPEED = 10.0;
    const THROW_FORCE      = 12.0;
    const THROW_FORCE_SPRINT = 18.0;

    // Collision
    const WALL_BOUNCE      = 0.2;

    // =========================================
    //  STATE
    // =========================================

    let _scene    = null;
    let _camera   = null;
    let _colData  = null;

    /** @type {Array} */
    const _bodies = [];

    // Interaction state
    let _heldBody       = null;
    let _isHolding      = false;
    let _mouseDown      = false;
    let _mouseDownTime  = 0;
    let _lastCarryPos   = null;
    let _prevCarryPos   = null;
    let _carryVelocity  = new THREE.Vector3();

    // Raycaster
    const _raycaster = new THREE.Raycaster();
    const _screenCenter = new THREE.Vector2(0, 0);

    // Crosshair state
    let _isLookingAtPickupable = false;

    // =========================================
    //  PHYSICS BODY
    // =========================================

    function addBody(mesh, opts) {
        const body = {
            mesh:       mesh,
            velocity:   new THREE.Vector3(0, 0, 0),
            angularVel: new THREE.Vector3(0, 0, 0),
            mass:       opts.mass   || 1.0,
            halfW:      opts.halfW  || 0.3,
            halfD:      opts.halfD  || 0.3,
            height:     opts.height || 0.7,
            isAwake:    false,
            isHeld:     false,
            _partitionData: null,
        };
        _bodies.push(body);

        // Tag all child meshes so raycaster can find the body
        mesh.traverse(function (child) {
            if (child.isMesh) {
                child.userData._physicsBody = body;
            }
        });

        console.log('[Physics] Body registered — meshes tagged, total bodies: ' + _bodies.length);
        return body;
    }

    // =========================================
    //  INITIALIZATION
    // =========================================

    function init(scene, camera, collisionData) {
        _scene   = scene;
        _camera  = camera;
        _colData = collisionData;

        document.addEventListener('mousedown', _onMouseDown);
        document.addEventListener('mouseup', _onMouseUp);
        console.log('[Physics] Initialized');
    }

    // =========================================
    //  MOUSE EVENTS
    // =========================================

    function _onMouseDown(e) {
        if (e.button !== 0) return;
        if (!document.pointerLockElement) return;

        _mouseDown = true;
        _mouseDownTime = performance.now();

        if (_heldBody) return;  // already holding something
        if (_bodies.length === 0) return;

        // Raycast from camera center
        _raycaster.setFromCamera(_screenCenter, _camera);

        // Test against all body root meshes recursively
        const rootMeshes = _bodies.map(function (b) { return b.mesh; });
        const hits = _raycaster.intersectObjects(rootMeshes, true);

        if (hits.length === 0) return;

        // Find which body was hit
        const hitObj = hits[0];
        if (hitObj.distance > PICK_UP_RANGE) return;

        // Walk up the parent chain to find the tagged object
        let body = null;
        let obj = hitObj.object;
        while (obj) {
            if (obj.userData && obj.userData._physicsBody) {
                body = obj.userData._physicsBody;
                break;
            }
            obj = obj.parent;
        }

        if (!body) return;

        // Pick up!
        _heldBody = body;
        body.isHeld = true;
        body.isAwake = false;
        body.velocity.set(0, 0, 0);
        body.angularVel.set(0, 0, 0);

        // Remove partition collision while held
        _removePartition(body);

        // Init carry tracking
        _lastCarryPos = body.mesh.position.clone();
        _prevCarryPos = body.mesh.position.clone();
        _carryVelocity.set(0, 0, 0);

        console.log('[Physics] Picked up object');
    }

    function _onMouseUp(e) {
        if (e.button !== 0) return;
        _mouseDown = false;

        if (!_heldBody) return;

        var body = _heldBody;
        body.isHeld = false;
        _heldBody = null;

        var carrySpeed = _carryVelocity.length();
        var fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(_camera.quaternion);

        if (carrySpeed > 5.0) {
            // === THROW — player was actively swinging/flinging ===
            var throwVel = _carryVelocity.clone();
            throwVel.add(fwd.clone().multiplyScalar(THROW_FORCE * 0.3));
            body.velocity.copy(throwVel);

            // Strong tumble
            body.angularVel.set(
                (Math.random() - 0.5) * 6,
                (Math.random() - 0.5) * 4,
                (Math.random() - 0.5) * 6
            );
            console.log('[Physics] Threw object, vel: ' + throwVel.length().toFixed(1));

        } else {
            // === DROP — just let go, no throw ===
            // Only inherit a fraction of carry movement (natural hand release)
            body.velocity.set(
                _carryVelocity.x * 0.15,
                -0.5,   // slight downward nudge (gravity will do the rest)
                _carryVelocity.z * 0.15
            );

            // Very gentle tumble — might tip over, might not
            var tipChance = Math.random();
            if (tipChance < 0.3) {
                // Stays mostly upright
                body.angularVel.set(
                    (Math.random() - 0.5) * 0.3,
                    (Math.random() - 0.5) * 0.5,
                    (Math.random() - 0.5) * 0.3
                );
            } else {
                // Slight wobble
                body.angularVel.set(
                    (Math.random() - 0.5) * 1.0,
                    (Math.random() - 0.5) * 0.8,
                    (Math.random() - 0.5) * 1.0
                );
            }
            console.log('[Physics] Dropped object gently');
        }

        body.isAwake = true;
    }

    // =========================================
    //  PARTITION MANAGEMENT
    // =========================================

    function _removePartition(body) {
        if (!_colData || !_colData.partitions) return;
        const pos = body.mesh.position;
        const parts = _colData.partitions;
        for (let i = parts.length - 1; i >= 0; i--) {
            const p = parts[i];
            if (Math.abs(p.x - pos.x) < 1.0 && Math.abs(p.z - pos.z) < 1.0) {
                body._partitionData = parts.splice(i, 1)[0];
                return;
            }
        }
    }

    function _addPartition(body) {
        if (!_colData || !_colData.partitions) return;
        const pos = body.mesh.position;
        _colData.partitions.push({
            x: pos.x,
            z: pos.z,
            halfW: body.halfW,
            halfD: body.halfD,
            height: body.height,
        });
    }

    // =========================================
    //  COLLISION CHECKS
    // =========================================

    function _isWall(x, z) {
        if (!_colData) return false;
        const col = Math.floor(x / _colData.tileSize);
        const row = Math.floor(z / _colData.tileSize);
        if (row < 0 || row >= _colData.rows || col < 0 || col >= _colData.cols) return true;
        return _colData.map[row][col] === 0;
    }

    function _resolveWallCollisions(body) {
        const pos = body.mesh.position;
        const hw = body.halfW;
        const hd = body.halfD;
        const ts = _colData ? _colData.tileSize : 4.0;

        if (_isWall(pos.x + hw, pos.z)) {
            const col = Math.floor((pos.x + hw) / ts);
            pos.x = col * ts - hw - 0.01;
            body.velocity.x = -Math.abs(body.velocity.x) * WALL_BOUNCE;
            body.angularVel.y += (Math.random() - 0.5) * 2;
        }
        if (_isWall(pos.x - hw, pos.z)) {
            const col = Math.floor((pos.x - hw) / ts);
            pos.x = (col + 1) * ts + hw + 0.01;
            body.velocity.x = Math.abs(body.velocity.x) * WALL_BOUNCE;
            body.angularVel.y += (Math.random() - 0.5) * 2;
        }
        if (_isWall(pos.x, pos.z + hd)) {
            const row = Math.floor((pos.z + hd) / ts);
            pos.z = row * ts - hd - 0.01;
            body.velocity.z = -Math.abs(body.velocity.z) * WALL_BOUNCE;
            body.angularVel.y += (Math.random() - 0.5) * 2;
        }
        if (_isWall(pos.x, pos.z - hd)) {
            const row = Math.floor((pos.z - hd) / ts);
            pos.z = (row + 1) * ts + hd + 0.01;
            body.velocity.z = Math.abs(body.velocity.z) * WALL_BOUNCE;
            body.angularVel.y += (Math.random() - 0.5) * 2;
        }
    }

    // =========================================
    //  UPDATE
    // =========================================

    function update(dt) {
        _updateCarry(dt);
        _updateCrosshair();

        for (let i = 0; i < _bodies.length; i++) {
            const body = _bodies[i];
            if (body.isHeld) continue;
            if (!body.isAwake) continue;
            _updateBody(body, dt);
        }
    }

    function _updateBody(body, dt) {
        var pos = body.mesh.position;
        var vel = body.velocity;
        var angVel = body.angularVel;

        // Cap dt to prevent tunneling through floor on lag spikes
        var stepDt = Math.min(dt, 0.02);

        // Gravity
        vel.y += GRAVITY * stepDt;

        // Clamp max downward velocity to prevent floor phasing
        if (vel.y < -20) vel.y = -20;

        // Move
        pos.x += vel.x * stepDt;
        pos.y += vel.y * stepDt;
        pos.z += vel.z * stepDt;

        // Floor collision — always enforce, never let Y go below floor
        if (pos.y <= FLOOR_Y) {
            pos.y = FLOOR_Y;

            if (Math.abs(vel.y) > 1.0) {
                vel.y = -vel.y * BOUNCE_FACTOR;
                // Clamp bounce so it doesn't go crazy
                if (vel.y > 8) vel.y = 8;
                _playImpactSound(Math.abs(vel.y) * 0.1 + Math.sqrt(vel.x * vel.x + vel.z * vel.z) * 0.05);
                angVel.x += (Math.random() - 0.5) * Math.min(Math.abs(vel.y), 3) * 0.3;
                angVel.z += (Math.random() - 0.5) * Math.min(Math.abs(vel.y), 3) * 0.3;
            } else {
                vel.y = 0;
            }

            // Ground friction
            vel.x *= FRICTION;
            vel.z *= FRICTION;
            angVel.x *= ANGULAR_FRICTION;
            angVel.y *= ANGULAR_FRICTION;
            angVel.z *= ANGULAR_FRICTION;
        } else {
            vel.x *= AIR_FRICTION;
            vel.z *= AIR_FRICTION;
        }

        // Extra safety: never below floor
        if (pos.y < FLOOR_Y) pos.y = FLOOR_Y;

        // Wall collisions
        if (_colData) {
            _resolveWallCollisions(body);
        }

        // Apply angular velocity to rotation
        body.mesh.rotation.x += angVel.x * dt;
        body.mesh.rotation.y += angVel.y * dt;
        body.mesh.rotation.z += angVel.z * dt;

        // Sleep check
        var speed = vel.length();
        var angSpeed = angVel.length();
        if (speed < SLEEP_THRESHOLD && angSpeed < ANGULAR_SLEEP && pos.y <= FLOOR_Y + 0.01) {
            vel.set(0, 0, 0);
            angVel.set(0, 0, 0);
            body.isAwake = false;
            _addPartition(body);
        }
    }

    // =========================================
    //  CARRY SYSTEM
    // =========================================

    function _updateCarry(dt) {
        if (!_heldBody) return;

        var body = _heldBody;
        var fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(_camera.quaternion);
        var up = new THREE.Vector3(0, 1, 0);

        // Target position: in front of camera
        var targetPos = _camera.position.clone()
            .add(fwd.clone().multiplyScalar(CARRY_DISTANCE))
            .add(up.clone().multiplyScalar(CARRY_HEIGHT));

        // Keep above floor
        if (targetPos.y < 0.3) targetPos.y = 0.3;

        // Smoothly move toward target
        _prevCarryPos = _lastCarryPos ? _lastCarryPos.clone() : targetPos.clone();
        body.mesh.position.lerp(targetPos, Math.min(1.0, CARRY_LERP_SPEED * dt));
        _lastCarryPos = body.mesh.position.clone();

        // Track carry velocity for throw momentum
        if (dt > 0) {
            _carryVelocity.copy(_lastCarryPos).sub(_prevCarryPos).divideScalar(dt);
        }

        // Smoothly level out rotation while held
        body.mesh.rotation.x *= 0.85;
        body.mesh.rotation.z *= 0.85;
    }

    // =========================================
    //  CROSSHAIR FEEDBACK
    // =========================================

    function _updateCrosshair() {
        if (_heldBody) {
            if (!_isLookingAtPickupable) {
                _isLookingAtPickupable = true;
                _setCrosshairActive(true);
            }
            return;
        }

        // Raycast to check if looking at a pickupable object
        _raycaster.setFromCamera(_screenCenter, _camera);

        var rootMeshes = _bodies.map(function (b) { return b.mesh; });
        var hits = _raycaster.intersectObjects(rootMeshes, true);
        var canPick = hits.length > 0 && hits[0].distance <= PICK_UP_RANGE;

        if (canPick !== _isLookingAtPickupable) {
            _isLookingAtPickupable = canPick;
            _setCrosshairActive(canPick);
        }
    }

    function _setCrosshairActive(active) {
        var el = document.getElementById('crosshair');
        if (!el) return;
        if (active) {
            el.classList.add('interact');
        } else {
            el.classList.remove('interact');
        }
    }

    // =========================================
    //  IMPACT SOUND
    // =========================================

    function _playImpactSound(intensity) {
        var ctx = AudioManager.getContext();
        var master = AudioManager.getMasterGainNode();
        if (!ctx || !master) return;

        var vol = Math.min(0.5, intensity * 0.3);
        if (vol < 0.02) return;

        var now = ctx.currentTime;

        // Low thud
        var osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(60 + Math.random() * 30, now);
        osc.frequency.exponentialRampToValueAtTime(25, now + 0.15);
        var oscGain = ctx.createGain();
        oscGain.gain.setValueAtTime(vol, now);
        oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        osc.connect(oscGain);
        oscGain.connect(master);
        osc.start(now);
        osc.stop(now + 0.2);

        // Clatter noise
        var bufLen = Math.floor(ctx.sampleRate * 0.1);
        var buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
        var data = buf.getChannelData(0);
        for (var i = 0; i < bufLen; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.3 * Math.exp(-i / (bufLen * 0.2));
        }
        var noise = ctx.createBufferSource();
        noise.buffer = buf;
        var noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(vol * 0.6, now);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
        var bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 400 + Math.random() * 300;
        bp.Q.value = 2;
        noise.connect(bp);
        bp.connect(noiseGain);
        noiseGain.connect(master);
        noise.start(now);
        noise.stop(now + 0.15);
    }

    // =========================================
    //  PUBLIC API
    // =========================================

    function isHolding() { return _heldBody !== null; }

    return {
        init,
        update,
        addBody,
        isHolding,
    };
})();
