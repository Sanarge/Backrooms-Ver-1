/* ========================================
   Physics & Interaction Engine
   ─────────────────────────────────────────
   Handles:
   1. Rigid-body physics for props (gravity,
      velocity, friction, bounce, rotation)
      with proper bounding-box collision
   2. Raycasting to detect clickable objects
   3. Pick-up / carry / throw mechanics
   4. Realistic tipping & settling
   ======================================== */

var Physics = (function () {

    // =========================================
    //  CONSTANTS
    // =========================================

    var GRAVITY          = -12.0;
    var FLOOR_Y          = 0.0;
    var CEILING_Y        = 3.0;     // matches WALL_HEIGHT in environment.js
    var FRICTION         = 0.88;
    var AIR_FRICTION     = 0.995;
    var BOUNCE_FACTOR    = 0.25;
    var BOUNCE_MIN       = 0.8;     // below this impact speed, no bounce
    var ANGULAR_FRICTION = 0.88;
    var SLEEP_THRESHOLD  = 0.08;
    var ANGULAR_SLEEP    = 0.05;
    var MAX_SUBSTEPS     = 4;       // physics substeps per frame to prevent tunneling
    var SUBSTEP_DT       = 0.008;   // ~125Hz physics

    // Interaction
    var PICK_UP_RANGE    = 3.5;
    var CARRY_DISTANCE   = 2.0;
    var CARRY_HEIGHT     = -0.3;
    var CARRY_LERP_SPEED = 10.0;
    var THROW_SPEED_THRESHOLD = 5.0;  // carry speed above this = throw
    var THROW_FORCE      = 12.0;
    var THROW_FORCE_SPRINT = 18.0;

    // Collision
    var WALL_BOUNCE      = 0.15;

    // =========================================
    //  STATE
    // =========================================

    var _scene    = null;
    var _camera   = null;
    var _colData  = null;

    var _bodies = [];

    // Interaction state
    var _heldBody       = null;
    var _mouseDown      = false;
    var _mouseDownTime  = 0;
    var _lastCarryPos   = null;
    var _prevCarryPos   = null;
    var _carryVelocity  = new THREE.Vector3();

    // Raycaster
    var _raycaster = new THREE.Raycaster();
    var _screenCenter = new THREE.Vector2(0, 0);
    var _isLookingAtPickupable = false;

    // Temp vectors (reuse to avoid GC)
    var _tmpVec = new THREE.Vector3();
    var _tmpBox = new THREE.Box3();

    // =========================================
    //  PHYSICS BODY
    // =========================================

    /**
     * Register a mesh as a physics-enabled prop.
     * Computes actual bounding box from the model geometry.
     */
    function addBody(mesh, opts) {
        // Compute the actual bounding box of the model in local space
        _tmpBox.setFromObject(mesh);
        var size = new THREE.Vector3();
        _tmpBox.getSize(size);
        var center = new THREE.Vector3();
        _tmpBox.getCenter(center);

        // The offset from the mesh origin to the bounding box bottom
        var bottomOffset = _tmpBox.min.y - mesh.position.y;

        var body = {
            mesh:         mesh,
            velocity:     new THREE.Vector3(0, 0, 0),
            angularVel:   new THREE.Vector3(0, 0, 0),
            mass:         opts.mass   || 1.0,
            // Actual model dimensions
            boxWidth:     size.x,
            boxHeight:    size.y,
            boxDepth:     size.z,
            halfW:        size.x / 2,
            halfD:        size.z / 2,
            height:       size.y,
            bottomOffset: bottomOffset,  // how far below mesh.position.y the bottom is
            // Collision for partitions (slightly smaller than visual)
            partHalfW:    opts.halfW  || size.x * 0.4,
            partHalfD:    opts.halfD  || size.z * 0.4,
            partHeight:   opts.height || size.y * 0.5,
            isAwake:      false,
            isHeld:       false,
            isTipping:    false,
            tipAxis:      null,       // which axis it's tipping on
            tipDirection: 0,          // +1 or -1
            _partitionData: null,
        };

        _bodies.push(body);

        // Tag all child meshes for raycasting
        mesh.traverse(function (child) {
            if (child.isMesh) {
                child.userData._physicsBody = body;
            }
        });

        console.log('[Physics] Body registered — size: ' +
            size.x.toFixed(2) + ' x ' + size.y.toFixed(2) + ' x ' + size.z.toFixed(2) +
            ', bottomOffset: ' + bottomOffset.toFixed(3));
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

        if (_heldBody) return;
        if (_bodies.length === 0) return;

        _raycaster.setFromCamera(_screenCenter, _camera);

        var rootMeshes = [];
        for (var i = 0; i < _bodies.length; i++) {
            rootMeshes.push(_bodies[i].mesh);
        }
        var hits = _raycaster.intersectObjects(rootMeshes, true);

        if (hits.length === 0) return;
        if (hits[0].distance > PICK_UP_RANGE) return;

        // Walk parent chain to find body
        var body = null;
        var obj = hits[0].object;
        while (obj) {
            if (obj.userData && obj.userData._physicsBody) {
                body = obj.userData._physicsBody;
                break;
            }
            obj = obj.parent;
        }
        if (!body) return;

        // Pick up
        _heldBody = body;
        body.isHeld = true;
        body.isAwake = false;
        body.isTipping = false;
        body.velocity.set(0, 0, 0);
        body.angularVel.set(0, 0, 0);

        _removePartition(body);

        _lastCarryPos = body.mesh.position.clone();
        _prevCarryPos = body.mesh.position.clone();
        _carryVelocity.set(0, 0, 0);
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

        if (carrySpeed > THROW_SPEED_THRESHOLD) {
            // === THROW — player was actively flinging ===
            var throwVel = _carryVelocity.clone();
            throwVel.add(fwd.clone().multiplyScalar(THROW_FORCE * 0.3));
            body.velocity.copy(throwVel);

            // Strong tumble on throw
            body.angularVel.set(
                (Math.random() - 0.5) * 5,
                (Math.random() - 0.5) * 3,
                (Math.random() - 0.5) * 5
            );

        } else {
            // === DROP — just release, normal gravity drop ===
            body.velocity.set(
                _carryVelocity.x * 0.05,
                -0.2,
                _carryVelocity.z * 0.05
            );

            // 90% upright, 10% tip over
            if (Math.random() < 0.9) {
                // Upright — no spin at all, clean drop
                body.angularVel.set(0, 0, 0);
            } else {
                // Will tip over onto a side
                _startTip(body);
            }
        }

        body.isAwake = true;
    }

    // =========================================
    //  TIPPING SYSTEM
    // =========================================

    /**
     * Start a natural-looking tip. Pick a random direction
     * (forward, backward, left, right) and apply a gentle
     * angular impulse that will cause the chair to fall that way.
     */
    function _startTip(body) {
        var direction = Math.floor(Math.random() * 4);
        var tipStrength = 1.5 + Math.random() * 1.0;  // gentle but enough to tip

        switch (direction) {
            case 0: // tip forward (fall on front)
                body.angularVel.x = -tipStrength;
                body.tipAxis = 'x';
                body.tipDirection = -1;
                break;
            case 1: // tip backward (fall on back)
                body.angularVel.x = tipStrength;
                body.tipAxis = 'x';
                body.tipDirection = 1;
                break;
            case 2: // tip left
                body.angularVel.z = tipStrength;
                body.tipAxis = 'z';
                body.tipDirection = 1;
                break;
            case 3: // tip right
                body.angularVel.z = -tipStrength;
                body.tipAxis = 'z';
                body.tipDirection = -1;
                break;
        }

        // Small random yaw spin
        body.angularVel.y = (Math.random() - 0.5) * 0.5;
        body.isTipping = true;
    }

    /**
     * Determine if the object should spring back upright or commit
     * to falling over, based on its current tilt angle.
     *
     * Tipping threshold: ~25 degrees (0.44 rad). Below this,
     * a restoring force pulls the object back to upright (like a
     * chair rocking back onto all 4 legs). Above this, gravity
     * commits the tilt into a full fall onto that side.
     */
    var TIP_THRESHOLD = 0.44;  // ~25 degrees — tipping point
    var RESTORE_STRENGTH = 6.0;  // spring force back to upright
    var COMMIT_STRENGTH = 2.5;   // force pushing it the rest of the way over

    function _checkSettleOrientation(body) {
        var rx = body.mesh.rotation.x % (Math.PI * 2);
        var rz = body.mesh.rotation.z % (Math.PI * 2);

        // Normalize to -PI to PI
        if (rx > Math.PI) rx -= Math.PI * 2;
        if (rx < -Math.PI) rx += Math.PI * 2;
        if (rz > Math.PI) rz -= Math.PI * 2;
        if (rz < -Math.PI) rz += Math.PI * 2;

        // Find nearest stable rest angle for each axis
        var nearestRestRx = Math.round(rx / (Math.PI / 2)) * (Math.PI / 2);
        var nearestRestRz = Math.round(rz / (Math.PI / 2)) * (Math.PI / 2);

        // Distance from upright (nearest multiple of PI on each axis)
        var distFromUprightX = Math.abs(rx - Math.round(rx / Math.PI) * Math.PI);
        var distFromUprightZ = Math.abs(rz - Math.round(rz / Math.PI) * Math.PI);

        // --- X axis ---
        if (Math.abs(rx) < 0.01) {
            // Basically upright on this axis — zero out any drift
            body.angularVel.x *= 0.7;
        } else if (Math.abs(rx) < TIP_THRESHOLD && Math.abs(nearestRestRx) < 0.01) {
            // Below tipping point and nearest rest is upright — spring back
            body.angularVel.x += (0 - rx) * RESTORE_STRENGTH;
            body.angularVel.x *= 0.85;  // damping to prevent oscillation
        } else {
            // Past tipping point — commit to falling to nearest rest
            body.angularVel.x += (nearestRestRx - rx) * COMMIT_STRENGTH;
        }

        // --- Z axis ---
        if (Math.abs(rz) < 0.01) {
            body.angularVel.z *= 0.7;
        } else if (Math.abs(rz) < TIP_THRESHOLD && Math.abs(nearestRestRz) < 0.01) {
            // Below tipping point — spring back upright
            body.angularVel.z += (0 - rz) * RESTORE_STRENGTH;
            body.angularVel.z *= 0.85;
        } else {
            // Past tipping point — commit to falling
            body.angularVel.z += (nearestRestRz - rz) * COMMIT_STRENGTH;
        }
    }

    // =========================================
    //  PARTITION MANAGEMENT
    // =========================================

    function _removePartition(body) {
        if (!_colData || !_colData.partitions) return;
        var pos = body.mesh.position;
        var parts = _colData.partitions;
        for (var i = parts.length - 1; i >= 0; i--) {
            var p = parts[i];
            if (Math.abs(p.x - pos.x) < 1.0 && Math.abs(p.z - pos.z) < 1.0) {
                body._partitionData = parts.splice(i, 1)[0];
                return;
            }
        }
    }

    function _addPartition(body) {
        if (!_colData || !_colData.partitions) return;
        var pos = body.mesh.position;
        _colData.partitions.push({
            x: pos.x,
            z: pos.z,
            halfW: body.partHalfW,
            halfD: body.partHalfD,
            height: body.partHeight,
        });
    }

    // =========================================
    //  COLLISION CHECKS
    // =========================================

    function _isWall(x, z) {
        if (!_colData) return false;
        var col = Math.floor(x / _colData.tileSize);
        var row = Math.floor(z / _colData.tileSize);
        if (row < 0 || row >= _colData.rows || col < 0 || col >= _colData.cols) return true;
        return _colData.map[row][col] === 0;
    }

    function _resolveWallCollisions(body) {
        var pos = body.mesh.position;
        var hw = body.halfW * 0.5;  // use smaller collision for walls
        var hd = body.halfD * 0.5;
        var ts = _colData ? _colData.tileSize : 4.0;

        if (_isWall(pos.x + hw, pos.z)) {
            var col = Math.floor((pos.x + hw) / ts);
            pos.x = col * ts - hw - 0.01;
            body.velocity.x = -Math.abs(body.velocity.x) * WALL_BOUNCE;
            body.angularVel.y += (Math.random() - 0.5) * 2;
            _playImpactSound(Math.abs(body.velocity.x) * 0.15);
        }
        if (_isWall(pos.x - hw, pos.z)) {
            var col2 = Math.floor((pos.x - hw) / ts);
            pos.x = (col2 + 1) * ts + hw + 0.01;
            body.velocity.x = Math.abs(body.velocity.x) * WALL_BOUNCE;
            body.angularVel.y += (Math.random() - 0.5) * 2;
            _playImpactSound(Math.abs(body.velocity.x) * 0.15);
        }
        if (_isWall(pos.x, pos.z + hd)) {
            var row = Math.floor((pos.z + hd) / ts);
            pos.z = row * ts - hd - 0.01;
            body.velocity.z = -Math.abs(body.velocity.z) * WALL_BOUNCE;
            body.angularVel.y += (Math.random() - 0.5) * 2;
            _playImpactSound(Math.abs(body.velocity.z) * 0.15);
        }
        if (_isWall(pos.x, pos.z - hd)) {
            var row2 = Math.floor((pos.z - hd) / ts);
            pos.z = (row2 + 1) * ts + hd + 0.01;
            body.velocity.z = Math.abs(body.velocity.z) * WALL_BOUNCE;
            body.angularVel.y += (Math.random() - 0.5) * 2;
            _playImpactSound(Math.abs(body.velocity.z) * 0.15);
        }
    }

    /**
     * Get the effective floor offset for a rotated object.
     * When the object tips, its bounding box extends below the origin.
     * Returns how high the origin should be above FLOOR_Y.
     */
    function _getFloorOffset(body) {
        // Recompute bounding box with current rotation
        _tmpBox.setFromObject(body.mesh);
        // The lowest point of the model in world space
        var lowestY = _tmpBox.min.y;
        // The offset needed to keep the lowest point at FLOOR_Y
        return body.mesh.position.y - lowestY;
    }

    /**
     * Get the highest point for ceiling collision.
     */
    function _getCeilingOffset(body) {
        _tmpBox.setFromObject(body.mesh);
        var highestY = _tmpBox.max.y;
        return highestY - body.mesh.position.y;
    }

    // =========================================
    //  UPDATE
    // =========================================

    function update(dt) {
        _updateCarry(dt);
        _updateCrosshair();

        for (var i = 0; i < _bodies.length; i++) {
            var body = _bodies[i];
            if (body.isHeld) continue;
            if (!body.isAwake) continue;

            // Substep physics for stability
            var remaining = dt;
            var steps = 0;
            while (remaining > 0 && steps < MAX_SUBSTEPS) {
                var stepDt = Math.min(remaining, SUBSTEP_DT);
                _updateBody(body, stepDt);
                remaining -= stepDt;
                steps++;
            }
        }
    }

    function _updateBody(body, dt) {
        var pos = body.mesh.position;
        var vel = body.velocity;
        var angVel = body.angularVel;

        // Gravity
        vel.y += GRAVITY * dt;

        // Clamp max velocity
        if (vel.y < -25) vel.y = -25;
        if (vel.y > 25) vel.y = 25;

        // Move
        pos.x += vel.x * dt;
        pos.y += vel.y * dt;
        pos.z += vel.z * dt;

        // Apply angular velocity
        body.mesh.rotation.x += angVel.x * dt;
        body.mesh.rotation.y += angVel.y * dt;
        body.mesh.rotation.z += angVel.z * dt;

        // --- Floor collision using actual model bounds ---
        var floorOffset = _getFloorOffset(body);
        var minY = FLOOR_Y + floorOffset;

        if (pos.y < minY) {
            pos.y = minY;

            var impactSpeed = Math.abs(vel.y);
            if (impactSpeed > BOUNCE_MIN) {
                vel.y = -vel.y * BOUNCE_FACTOR;
                if (vel.y > 8) vel.y = 8;
                _playImpactSound(impactSpeed * 0.08);

                // Impact can cause a little extra tumble
                var tumbleAmount = Math.min(impactSpeed * 0.15, 2.0);
                angVel.x += (Math.random() - 0.5) * tumbleAmount;
                angVel.z += (Math.random() - 0.5) * tumbleAmount;
            } else {
                vel.y = 0;
            }

            // Ground friction
            vel.x *= FRICTION;
            vel.z *= FRICTION;
            angVel.x *= ANGULAR_FRICTION;
            angVel.y *= ANGULAR_FRICTION;
            angVel.z *= ANGULAR_FRICTION;

            // Help the object settle into a stable orientation
            _checkSettleOrientation(body);
        } else {
            vel.x *= AIR_FRICTION;
            vel.z *= AIR_FRICTION;
        }

        // --- Ceiling collision using actual model bounds ---
        var ceilOffset = _getCeilingOffset(body);
        var maxY = CEILING_Y - ceilOffset;
        if (maxY < minY) maxY = minY;  // safety

        if (pos.y > maxY) {
            pos.y = maxY;
            if (vel.y > 0) {
                vel.y = -vel.y * 0.2;  // bounce down from ceiling
                _playImpactSound(Math.abs(vel.y) * 0.05);
            }
        }

        // --- Wall collisions ---
        if (_colData) {
            _resolveWallCollisions(body);
        }

        // --- Absolute floor safety ---
        _tmpBox.setFromObject(body.mesh);
        if (_tmpBox.min.y < FLOOR_Y - 0.01) {
            pos.y += (FLOOR_Y - _tmpBox.min.y);
        }

        // --- Sleep check ---
        var speed = vel.length();
        var angSpeed = angVel.length();
        if (speed < SLEEP_THRESHOLD && angSpeed < ANGULAR_SLEEP && pos.y <= minY + 0.05) {
            vel.set(0, 0, 0);
            angVel.set(0, 0, 0);
            body.isAwake = false;
            body.isTipping = false;
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

        var targetPos = _camera.position.clone()
            .add(fwd.clone().multiplyScalar(CARRY_DISTANCE))
            .add(up.clone().multiplyScalar(CARRY_HEIGHT));

        // Keep within room bounds
        if (targetPos.y < 0.3) targetPos.y = 0.3;
        if (targetPos.y > CEILING_Y - 0.5) targetPos.y = CEILING_Y - 0.5;

        _prevCarryPos = _lastCarryPos ? _lastCarryPos.clone() : targetPos.clone();
        body.mesh.position.lerp(targetPos, Math.min(1.0, CARRY_LERP_SPEED * dt));
        _lastCarryPos = body.mesh.position.clone();

        // Track carry velocity for throw detection
        if (dt > 0) {
            _carryVelocity.copy(_lastCarryPos).sub(_prevCarryPos).divideScalar(dt);
        }

        // Strongly level out rotation while held (return to fully upright)
        body.mesh.rotation.x += (0 - body.mesh.rotation.x) * 0.25;
        body.mesh.rotation.z += (0 - body.mesh.rotation.z) * 0.25;
        // Snap to zero if very close (prevents lingering micro-tilt on release)
        if (Math.abs(body.mesh.rotation.x) < 0.005) body.mesh.rotation.x = 0;
        if (Math.abs(body.mesh.rotation.z) < 0.005) body.mesh.rotation.z = 0;
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

        _raycaster.setFromCamera(_screenCenter, _camera);

        var rootMeshes = [];
        for (var i = 0; i < _bodies.length; i++) {
            rootMeshes.push(_bodies[i].mesh);
        }
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
        var bufLen = Math.floor(ctx.sampleRate * 0.12);
        var buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
        var data = buf.getChannelData(0);
        for (var i = 0; i < bufLen; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.3 * Math.exp(-i / (bufLen * 0.2));
        }
        var noise = ctx.createBufferSource();
        noise.buffer = buf;
        var noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(vol * 0.6, now);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
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
        init: init,
        update: update,
        addBody: addBody,
        isHolding: isHolding,
    };
})();
