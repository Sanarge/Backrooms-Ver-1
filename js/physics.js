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

    const GRAVITY          = -12.0;    // m/s² downward
    const FLOOR_Y          = 0.0;     // ground plane
    const FRICTION         = 0.92;    // velocity damping per frame on ground
    const AIR_FRICTION     = 0.995;   // very little air drag
    const BOUNCE_FACTOR    = 0.3;     // how much velocity is kept on bounce
    const ANGULAR_FRICTION = 0.90;    // rotation damping on ground
    const SLEEP_THRESHOLD  = 0.05;    // speed below which object stops
    const ANGULAR_SLEEP    = 0.02;    // angular speed below which rotation stops

    // Interaction
    const PICK_UP_RANGE    = 3.5;     // max distance to grab an object
    const CARRY_DISTANCE   = 2.0;     // how far in front of camera the object floats
    const CARRY_HEIGHT     = -0.3;    // offset below eye level when carrying
    const CARRY_LERP_SPEED = 10.0;    // how quickly object follows camera
    const THROW_FORCE      = 12.0;    // base throw speed
    const THROW_FORCE_SPRINT = 18.0;  // throw while sprinting
    const DROP_FORCE       = 2.0;     // gentle drop if just releasing

    // Collision
    const WALL_BOUNCE      = 0.2;     // speed kept when hitting wall
    const PARTITION_BOUNCE  = 0.15;

    // =========================================
    //  STATE
    // =========================================

    let _scene    = null;
    let _camera   = null;
    let _colData  = null;   // collision data from Environment

    /** @type {PhysicsBody[]} */
    const _bodies = [];

    // Interaction state
    let _heldBody       = null;   // currently held physics body
    let _isHolding      = false;
    let _mouseDown      = false;
    let _mouseDownTime  = 0;
    let _lastCarryPos   = null;   // for computing throw velocity
    let _prevCarryPos   = null;
    let _carryVelocity  = new THREE.Vector3();

    // Raycaster
    const _raycaster = new THREE.Raycaster();
    const _screenCenter = new THREE.Vector2(0, 0);  // center of screen

    // Crosshair state
    let _isLookingAtPickupable = false;

    // =========================================
    //  PHYSICS BODY
    // =========================================

    /**
     * @typedef {Object} PhysicsBody
     * @property {THREE.Object3D} mesh — the 3D model
     * @property {THREE.Vector3} velocity
     * @property {THREE.Vector3} angularVel — rotation velocity (euler rates)
     * @property {number} mass
     * @property {number} halfW — collision half-width (X)
     * @property {number} halfD — collision half-depth (Z)
     * @property {number} height — collision height
     * @property {boolean} isAwake — whether physics is active
     * @property {boolean} isHeld — currently being carried
     * @property {string} partitionId — ID in Environment partitions (if any)
     */

    /**
     * Register a mesh as a physics-enabled prop.
     * @param {THREE.Object3D} mesh
     * @param {object} opts - { mass, halfW, halfD, height }
     * @returns {PhysicsBody}
     */
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
        };
        _bodies.push(body);
        return body;
    }

    // =========================================
    //  INITIALIZATION
    // =========================================

    function init(scene, camera, collisionData) {
        _scene   = scene;
        _camera  = camera;
        _colData = collisionData;

        // Mouse events for pick-up/throw (only during pointer lock)
        document.addEventListener('mousedown', _onMouseDown);
        document.addEventListener('mouseup', _onMouseUp);
    }

    // =========================================
    //  MOUSE EVENTS
    // =========================================

    function _onMouseDown(e) {
        if (e.button !== 0) return;  // left click only
        if (!document.pointerLockElement) return;

        _mouseDown = true;
        _mouseDownTime = performance.now();

        if (_heldBody) return;  // already holding something

        // Raycast from screen center
        _raycaster.setFromCamera(_screenCenter, _camera);
        const meshes = _bodies.map(b => b.mesh);

        // Collect all meshes including children
        const testObjects = [];
        for (const body of _bodies) {
            body.mesh.traverse(function (child) {
                if (child.isMesh) {
                    child.userData._physicsBody = body;
                    testObjects.push(child);
                }
            });
        }

        const hits = _raycaster.intersectObjects(testObjects, false);
        if (hits.length === 0) return;

        const hit = hits[0];
        if (hit.distance > PICK_UP_RANGE) return;

        const body = hit.object.userData._physicsBody;
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
    }

    function _onMouseUp(e) {
        if (e.button !== 0) return;
        _mouseDown = false;

        if (!_heldBody) return;

        const body = _heldBody;
        body.isHeld = false;
        _heldBody = null;

        // Compute throw velocity from carry movement
        const throwVel = _carryVelocity.clone();

        // Add forward impulse based on how the player is moving
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(_camera.quaternion);
        const holdDuration = (performance.now() - _mouseDownTime) / 1000;

        // If there's significant carry velocity (player was swinging), use it
        const carrySpeed = throwVel.length();

        if (carrySpeed > 2.0) {
            // Fling — use the carry momentum, add a bit of forward
            throwVel.add(fwd.clone().multiplyScalar(THROW_FORCE * 0.3));
        } else {
            // Forward throw
            const isSprinting = Player.getStamina().isSprinting;
            const force = isSprinting ? THROW_FORCE_SPRINT : THROW_FORCE;
            throwVel.copy(fwd).multiplyScalar(force);
            // Add slight upward arc
            throwVel.y += 2.0;
        }

        body.velocity.copy(throwVel);

        // Give it a tumble spin
        body.angularVel.set(
            (Math.random() - 0.5) * 6,
            (Math.random() - 0.5) * 4,
            (Math.random() - 0.5) * 6
        );

        body.isAwake = true;
    }

    // =========================================
    //  PARTITION MANAGEMENT
    // =========================================

    /** Remove the collision partition for a held object */
    function _removePartition(body) {
        if (!_colData || !_colData.partitions) return;
        const pos = body.mesh.position;
        const parts = _colData.partitions;
        for (let i = parts.length - 1; i >= 0; i--) {
            const p = parts[i];
            if (Math.abs(p.x - pos.x) < 0.5 && Math.abs(p.z - pos.z) < 0.5) {
                body._partitionData = parts.splice(i, 1)[0];
                return;
            }
        }
    }

    /** Re-add collision partition when object is dropped */
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

    /** Check if position (x, z) is inside a wall */
    function _isWall(x, z) {
        if (!_colData) return false;
        const col = Math.floor(x / _colData.tileSize);
        const row = Math.floor(z / _colData.tileSize);
        if (row < 0 || row >= _colData.rows || col < 0 || col >= _colData.cols) return true;
        return _colData.map[row][col] === 0;
    }

    /** Resolve wall collisions for a body, bouncing off walls */
    function _resolveWallCollisions(body) {
        const pos = body.mesh.position;
        const hw = body.halfW;
        const hd = body.halfD;
        const ts = _colData ? _colData.tileSize : 4.0;

        // Check each side
        if (_isWall(pos.x + hw, pos.z)) {
            // Push out of wall on +X side
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

        for (const body of _bodies) {
            if (body.isHeld) continue;
            if (!body.isAwake) continue;

            _updateBody(body, dt);
        }
    }

    function _updateBody(body, dt) {
        const pos = body.mesh.position;
        const vel = body.velocity;
        const angVel = body.angularVel;

        // Gravity
        vel.y += GRAVITY * dt;

        // Move
        pos.x += vel.x * dt;
        pos.y += vel.y * dt;
        pos.z += vel.z * dt;

        // Floor collision
        // The object's bottom is at pos.y (origin at base)
        // For models with origin at center, adjust:
        const bottomY = pos.y;
        if (bottomY <= FLOOR_Y) {
            pos.y = FLOOR_Y;

            if (Math.abs(vel.y) > 1.0) {
                // Bounce
                vel.y = -vel.y * BOUNCE_FACTOR;

                // Impact sound
                const impactSpeed = Math.abs(vel.y) + Math.sqrt(vel.x * vel.x + vel.z * vel.z);
                _playImpactSound(impactSpeed * 0.1);

                // Impact adds tumble
                angVel.x += (Math.random() - 0.5) * vel.y * 0.5;
                angVel.z += (Math.random() - 0.5) * vel.y * 0.5;
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
            // Air friction
            vel.x *= AIR_FRICTION;
            vel.z *= AIR_FRICTION;
        }

        // Wall collisions
        if (_colData) {
            _resolveWallCollisions(body);
        }

        // Apply angular velocity to rotation
        body.mesh.rotation.x += angVel.x * dt;
        body.mesh.rotation.y += angVel.y * dt;
        body.mesh.rotation.z += angVel.z * dt;

        // Sleep check — if barely moving, stop physics
        const speed = vel.length();
        const angSpeed = angVel.length();
        if (speed < SLEEP_THRESHOLD && angSpeed < ANGULAR_SLEEP && pos.y <= FLOOR_Y + 0.01) {
            vel.set(0, 0, 0);
            angVel.set(0, 0, 0);
            body.isAwake = false;

            // Re-add collision partition now that it's resting
            _addPartition(body);
        }
    }

    // =========================================
    //  CARRY SYSTEM
    // =========================================

    function _updateCarry(dt) {
        if (!_heldBody) return;

        const body = _heldBody;
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(_camera.quaternion);
        const up = new THREE.Vector3(0, 1, 0);

        // Target position: in front of camera
        const targetPos = _camera.position.clone()
            .add(fwd.clone().multiplyScalar(CARRY_DISTANCE))
            .add(up.clone().multiplyScalar(CARRY_HEIGHT));

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
            _isLookingAtPickupable = true;
            _setCrosshairActive(true);
            return;
        }

        // Raycast to check if looking at a pickupable object
        _raycaster.setFromCamera(_screenCenter, _camera);

        const testObjects = [];
        for (const body of _bodies) {
            body.mesh.traverse(function (child) {
                if (child.isMesh) {
                    child.userData._physicsBody = body;
                    testObjects.push(child);
                }
            });
        }

        const hits = _raycaster.intersectObjects(testObjects, false);
        const canPick = hits.length > 0 && hits[0].distance <= PICK_UP_RANGE;

        if (canPick !== _isLookingAtPickupable) {
            _isLookingAtPickupable = canPick;
            _setCrosshairActive(canPick);
        }
    }

    function _setCrosshairActive(active) {
        const el = document.getElementById('crosshair');
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
        const ctx = AudioManager.getContext();
        const master = AudioManager.getMasterGainNode();
        if (!ctx || !master) return;

        const vol = Math.min(0.5, intensity * 0.3);
        if (vol < 0.02) return;

        const now = ctx.currentTime;

        // Low thud
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(60 + Math.random() * 30, now);
        osc.frequency.exponentialRampToValueAtTime(25, now + 0.15);
        const oscGain = ctx.createGain();
        oscGain.gain.setValueAtTime(vol, now);
        oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        osc.connect(oscGain);
        oscGain.connect(master);
        osc.start(now);
        osc.stop(now + 0.2);

        // Clatter noise
        const bufLen = Math.floor(ctx.sampleRate * 0.1);
        const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < bufLen; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.3 * Math.exp(-i / (bufLen * 0.2));
        }
        const noise = ctx.createBufferSource();
        noise.buffer = buf;
        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(vol * 0.6, now);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
        const bp = ctx.createBiquadFilter();
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
    function getHeldBody() { return _heldBody; }
    function getBodies() { return _bodies; }

    return {
        init,
        update,
        addBody,
        isHolding,
        getHeldBody,
        getBodies,
    };
})();
