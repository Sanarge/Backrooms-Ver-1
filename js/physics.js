/* ========================================
   Physics & Interaction Engine  (cannon.js)
   ─────────────────────────────────────────
   Uses cannon.js for true rigid-body physics:
   • Gravity, friction, restitution
   • Compound collision shapes (chair = seat + back)
   • Wall / floor / ceiling static bodies from map
   • Contact-based impact sounds

   Interaction layer on top:
   • Raycasting to detect clickable objects
   • Pick-up / carry / throw mechanics
   • Crosshair feedback
   ======================================== */

var Physics = (function () {

    // =========================================
    //  CONSTANTS
    // =========================================

    var GRAVITY_Y        = -12.0;
    var CEILING_Y        = 3.0;

    // Interaction
    var PICK_UP_RANGE    = 3.5;
    var CARRY_DISTANCE   = 2.0;
    var CARRY_HEIGHT     = -0.3;
    var CARRY_LERP_SPEED = 10.0;
    var THROW_SPEED_THRESHOLD = 5.0;
    var THROW_FORCE      = 12.0;

    // Physics step
    var FIXED_STEP       = 1 / 120;
    var MAX_SUB_STEPS    = 3;

    // Sleep → partition thresholds
    var SLEEP_VEL        = 0.15;
    var SLEEP_ANG        = 0.15;
    var SLEEP_TIME       = 0.6;   // seconds below threshold before sleeping

    // =========================================
    //  STATE
    // =========================================

    var _world    = null;
    var _scene    = null;
    var _camera   = null;
    var _colData  = null;

    /** Array of body wrappers: { cannonBody, mesh, isHeld, isSleeping, sleepTimer, _partitionData } */
    var _bodies = [];

    // Interaction state
    var _heldBody       = null;
    var _mouseDown      = false;
    var _lastCarryPos   = null;
    var _prevCarryPos   = null;
    var _carryVelocity  = new THREE.Vector3();

    // Raycaster
    var _raycaster    = new THREE.Raycaster();
    var _screenCenter = new THREE.Vector2(0, 0);
    var _isLookingAtPickupable = false;

    // Impact sound cooldown (prevent rapid-fire sounds)
    var _lastImpactTime = 0;
    var IMPACT_COOLDOWN  = 0.06;  // 60 ms

    // =========================================
    //  INITIALIZATION
    // =========================================

    function init(scene, camera, collisionData) {
        _scene   = scene;
        _camera  = camera;
        _colData = collisionData;

        // --- Create cannon.js world ---
        _world = new CANNON.World();
        _world.gravity.set(0, GRAVITY_Y, 0);
        _world.broadphase = new CANNON.SAPBroadphase(_world);
        _world.solver.iterations = 12;
        _world.solver.tolerance  = 0.0001;
        _world.defaultContactMaterial.friction    = 0.4;
        _world.defaultContactMaterial.restitution = 0.1;

        // --- Materials ---
        var groundMat = new CANNON.Material('ground');
        var wallMat   = new CANNON.Material('wall');
        var propMat   = new CANNON.Material('prop');

        // Ground ↔ Prop
        _world.addContactMaterial(new CANNON.ContactMaterial(groundMat, propMat, {
            friction: 0.5,
            restitution: 0.12,
        }));

        // Wall ↔ Prop
        _world.addContactMaterial(new CANNON.ContactMaterial(wallMat, propMat, {
            friction: 0.25,
            restitution: 0.08,
        }));

        // Ceiling ↔ Prop (bouncier)
        _world.addContactMaterial(new CANNON.ContactMaterial(groundMat, propMat, {
            friction: 0.3,
            restitution: 0.15,
        }));

        // --- Floor (infinite plane at y=0, normal pointing up) ---
        var floorBody = new CANNON.Body({ mass: 0, material: groundMat });
        floorBody.addShape(new CANNON.Plane());
        floorBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
        _world.addBody(floorBody);

        // --- Ceiling (infinite plane at y=CEILING_Y, normal pointing down) ---
        var ceilBody = new CANNON.Body({ mass: 0, material: groundMat });
        ceilBody.addShape(new CANNON.Plane());
        ceilBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), Math.PI / 2);
        ceilBody.position.set(0, CEILING_Y, 0);
        _world.addBody(ceilBody);

        // --- Wall bodies from map grid ---
        _buildWallBodies(collisionData, wallMat);

        // --- Partition static bodies (half-height walls in the map) ---
        _buildPartitionBodies(collisionData, wallMat);

        // Store prop material for addBody
        _world._propMaterial = propMat;

        // --- Mouse events ---
        document.addEventListener('mousedown', _onMouseDown);
        document.addEventListener('mouseup',   _onMouseUp);

        console.log('[Physics] Initialized with cannon.js rigid-body engine');
    }

    // =========================================
    //  STATIC WORLD GEOMETRY
    // =========================================

    /**
     * Create a static CANNON.Body box for every wall tile (map value 0).
     */
    function _buildWallBodies(colData, wallMat) {
        var map  = colData.map;
        var ts   = colData.tileSize;   // 4.0
        var wh   = colData.wallHeight; // 3.0
        var rows = colData.rows;
        var cols = colData.cols;

        // Shared shape (all wall tiles are the same size)
        var wallShape = new CANNON.Box(new CANNON.Vec3(ts / 2, wh / 2, ts / 2));

        for (var r = 0; r < rows; r++) {
            for (var c = 0; c < cols; c++) {
                if (map[r][c] === 0) {
                    var wb = new CANNON.Body({ mass: 0, material: wallMat });
                    wb.addShape(wallShape);
                    wb.position.set(
                        c * ts + ts / 2,
                        wh / 2,
                        r * ts + ts / 2
                    );
                    _world.addBody(wb);
                }
            }
        }
    }

    /**
     * Create static bodies for the half-height partitions placed by Environment.
     * These are the low wall dividers the player can vault / look over.
     */
    function _buildPartitionBodies(colData, wallMat) {
        if (!colData.partitions) return;
        for (var i = 0; i < colData.partitions.length; i++) {
            var p = colData.partitions[i];
            var shape = new CANNON.Box(new CANNON.Vec3(p.halfW, p.height / 2, p.halfD));
            var pb = new CANNON.Body({ mass: 0, material: wallMat });
            pb.addShape(shape);
            pb.position.set(p.x, p.height / 2, p.z);
            _world.addBody(pb);
        }
    }

    // =========================================
    //  ADD PHYSICS BODY (for props)
    // =========================================

    /**
     * Register a Three.js mesh as a physics-enabled prop.
     * Creates a CANNON.Body with a compound shape (seat + backrest for chairs).
     *
     * @param {THREE.Object3D} mesh - the loaded model root
     * @param {object} opts - { mass, halfW, halfD, height }
     * @returns {object} body wrapper
     */
    function addBody(mesh, opts) {
        // Compute actual bounding box from the model
        var tmpBox = new THREE.Box3().setFromObject(mesh);
        var size = new THREE.Vector3();
        tmpBox.getSize(size);

        var mass   = opts.mass   || 1.0;
        var halfW  = size.x / 2;
        var halfD  = size.z / 2;
        var height = size.y;

        // -----------------------------------------------
        // Compound shape: seat + backrest (L-shape)
        // Gives realistic collision for a chair model.
        //
        //   ┌───┐   ← backrest (thin, tall)
        //   │   │
        //   ├───┤   ← seat top
        //   │   │
        //   └───┘   ← floor
        //
        // The body origin is at the bottom of the model (y=0)
        // -----------------------------------------------

        var seatH    = height * 0.38;   // seat + legs = bottom ~38% of height
        var backH    = height - seatH;  // backrest = remaining top portion
        var backD    = halfD * 0.16;    // backrest is thin

        // Seat box
        var seatShape = new CANNON.Box(new CANNON.Vec3(halfW, seatH / 2, halfD));
        var seatOffset = new CANNON.Vec3(0, seatH / 2, 0);

        // Backrest box — sits on top of seat, at the back edge (-Z)
        var backShape = new CANNON.Box(new CANNON.Vec3(halfW, backH / 2, backD));
        var backOffset = new CANNON.Vec3(0, seatH + backH / 2, -(halfD - backD));

        // Create cannon body
        var cb = new CANNON.Body({
            mass: mass,
            material: _world._propMaterial,
            linearDamping:  0.08,
            angularDamping: 0.15,
        });

        cb.addShape(seatShape, seatOffset);
        cb.addShape(backShape, backOffset);

        // Set initial position/rotation from the Three.js mesh
        cb.position.set(mesh.position.x, mesh.position.y, mesh.position.z);
        cb.quaternion.set(
            mesh.quaternion.x,
            mesh.quaternion.y,
            mesh.quaternion.z,
            mesh.quaternion.w
        );

        // Start asleep (not moving) — prevents initial jitter
        cb.velocity.set(0, 0, 0);
        cb.angularVelocity.set(0, 0, 0);

        _world.addBody(cb);

        // Put the body to sleep immediately so it doesn't
        // bounce off the floor on the first frame
        cb.sleep();

        // Body wrapper
        var bodyData = {
            cannonBody:     cb,
            mesh:           mesh,
            isHeld:         false,
            isSleeping:     true,
            sleepTimer:     SLEEP_TIME,
            // Partition data for player collision
            partHalfW:      opts.halfW  || halfW * 0.8,
            partHalfD:      opts.halfD  || halfD * 0.8,
            partHeight:     opts.height || height * 0.9,
            _partitionData: null,
            _hasPartition:  true,  // starts with partition from Props.placeModel
        };

        _bodies.push(bodyData);

        // Tag child meshes for raycasting
        mesh.traverse(function (child) {
            if (child.isMesh) {
                child.userData._physicsBody = bodyData;
            }
        });

        // Listen for collisions — impact sounds
        cb.addEventListener('collide', function (e) {
            var impact = e.contact.getImpactVelocityAlongNormal();
            var now = performance.now() / 1000;
            if (Math.abs(impact) > 1.5 && now - _lastImpactTime > IMPACT_COOLDOWN) {
                _lastImpactTime = now;
                _playImpactSound(Math.abs(impact) * 0.06);
            }
        });

        console.log('[Physics] Body registered — compound L-shape, size: ' +
            size.x.toFixed(2) + ' × ' + size.y.toFixed(2) + ' × ' + size.z.toFixed(2));

        return bodyData;
    }

    // =========================================
    //  MOUSE EVENTS
    // =========================================

    function _onMouseDown(e) {
        if (e.button !== 0) return;
        if (!document.pointerLockElement) return;

        _mouseDown = true;

        if (_heldBody) return;
        if (_bodies.length === 0) return;

        // Raycast to find clickable prop
        _raycaster.setFromCamera(_screenCenter, _camera);

        var rootMeshes = [];
        for (var i = 0; i < _bodies.length; i++) {
            rootMeshes.push(_bodies[i].mesh);
        }
        var hits = _raycaster.intersectObjects(rootMeshes, true);

        if (hits.length === 0) return;
        if (hits[0].distance > PICK_UP_RANGE) return;

        // Walk parent chain to find body wrapper
        var bodyData = null;
        var obj = hits[0].object;
        while (obj) {
            if (obj.userData && obj.userData._physicsBody) {
                bodyData = obj.userData._physicsBody;
                break;
            }
            obj = obj.parent;
        }
        if (!bodyData) return;

        // === Pick up ===
        _heldBody = bodyData;
        bodyData.isHeld = true;
        bodyData.isSleeping = false;

        var cb = bodyData.cannonBody;

        // Switch to kinematic so cannon doesn't simulate it
        cb.type = CANNON.Body.KINEMATIC;
        cb.velocity.set(0, 0, 0);
        cb.angularVelocity.set(0, 0, 0);
        cb.updateMassProperties();

        // Remove partition (player shouldn't collide with held object)
        _removePartition(bodyData);

        _lastCarryPos  = bodyData.mesh.position.clone();
        _prevCarryPos  = bodyData.mesh.position.clone();
        _carryVelocity.set(0, 0, 0);
    }

    function _onMouseUp(e) {
        if (e.button !== 0) return;
        _mouseDown = false;

        if (!_heldBody) return;

        var bodyData = _heldBody;
        _heldBody = null;
        bodyData.isHeld = false;

        var cb = bodyData.cannonBody;

        // Switch back to dynamic
        cb.type = CANNON.Body.DYNAMIC;
        cb.updateMassProperties();

        var carrySpeed = _carryVelocity.length();
        var fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(_camera.quaternion);

        if (carrySpeed > THROW_SPEED_THRESHOLD) {
            // === THROW — player was actively flinging ===
            var throwVel = _carryVelocity.clone();
            throwVel.add(fwd.clone().multiplyScalar(THROW_FORCE * 0.3));

            cb.velocity.set(throwVel.x, throwVel.y, throwVel.z);

            // Tumble spin on throw
            cb.angularVelocity.set(
                (Math.random() - 0.5) * 6,
                (Math.random() - 0.5) * 3,
                (Math.random() - 0.5) * 6
            );
        } else {
            // === DROP — gentle release ===
            cb.velocity.set(
                _carryVelocity.x * 0.05,
                -0.3,
                _carryVelocity.z * 0.05
            );

            // Mostly upright drop, occasional tip
            if (Math.random() < 0.85) {
                cb.angularVelocity.set(0, 0, 0);
            } else {
                // Gentle tip
                cb.angularVelocity.set(
                    (Math.random() - 0.5) * 2.5,
                    (Math.random() - 0.5) * 0.5,
                    (Math.random() - 0.5) * 2.5
                );
            }
        }

        // Wake it up for simulation
        cb.wakeUp();
    }

    // =========================================
    //  UPDATE
    // =========================================

    function update(dt) {
        _updateCarry(dt);
        _updateCrosshair();

        if (_world && dt > 0) {
            // Step the cannon.js world
            _world.step(FIXED_STEP, dt, MAX_SUB_STEPS);
        }

        // Sync Three.js meshes with cannon bodies & manage sleep/partitions
        for (var i = 0; i < _bodies.length; i++) {
            var bd = _bodies[i];
            if (bd.isHeld) continue;

            var cb = bd.cannonBody;

            // Sync position and rotation from cannon → Three.js
            bd.mesh.position.set(cb.position.x, cb.position.y, cb.position.z);
            bd.mesh.quaternion.set(cb.quaternion.x, cb.quaternion.y, cb.quaternion.z, cb.quaternion.w);

            // --- Sleep / partition management ---
            var speed    = cb.velocity.norm();
            var angSpeed = cb.angularVelocity.norm();

            if (speed < SLEEP_VEL && angSpeed < SLEEP_ANG) {
                bd.sleepTimer += dt;
                if (bd.sleepTimer >= SLEEP_TIME && !bd.isSleeping) {
                    bd.isSleeping = true;
                    // Force fully still
                    cb.velocity.set(0, 0, 0);
                    cb.angularVelocity.set(0, 0, 0);
                    cb.sleep();
                    _addPartition(bd);
                }
            } else {
                if (bd.isSleeping && !bd.isHeld) {
                    bd.isSleeping = false;
                    _removePartition(bd);
                }
                bd.sleepTimer = 0;
            }
        }
    }

    // =========================================
    //  CARRY SYSTEM
    // =========================================

    function _updateCarry(dt) {
        if (!_heldBody) return;

        var bd = _heldBody;
        var cb = bd.cannonBody;

        // Target position: in front of camera
        var fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(_camera.quaternion);
        var up  = new THREE.Vector3(0, 1, 0);

        var targetX = _camera.position.x + fwd.x * CARRY_DISTANCE + up.x * CARRY_HEIGHT;
        var targetY = _camera.position.y + fwd.y * CARRY_DISTANCE + up.y * CARRY_HEIGHT;
        var targetZ = _camera.position.z + fwd.z * CARRY_DISTANCE + up.z * CARRY_HEIGHT;

        // Clamp within room
        if (targetY < 0.3) targetY = 0.3;
        if (targetY > CEILING_Y - 0.5) targetY = CEILING_Y - 0.5;

        _prevCarryPos = _lastCarryPos ? _lastCarryPos.clone() : new THREE.Vector3(targetX, targetY, targetZ);

        // Lerp toward target
        var lerp = Math.min(1.0, CARRY_LERP_SPEED * dt);
        var newX = cb.position.x + (targetX - cb.position.x) * lerp;
        var newY = cb.position.y + (targetY - cb.position.y) * lerp;
        var newZ = cb.position.z + (targetZ - cb.position.z) * lerp;

        cb.position.set(newX, newY, newZ);

        // Also sync mesh immediately for visual
        bd.mesh.position.set(newX, newY, newZ);

        _lastCarryPos = new THREE.Vector3(newX, newY, newZ);

        // Track carry velocity for throw detection
        if (dt > 0) {
            _carryVelocity.set(
                (newX - _prevCarryPos.x) / dt,
                (newY - _prevCarryPos.y) / dt,
                (newZ - _prevCarryPos.z) / dt
            );
        }

        // Smoothly return to upright while held
        // Use SLERP toward identity quaternion (upright)
        var meshQ = bd.mesh.quaternion;

        // Simple approach: lerp euler toward upright on X and Z, keep Y (facing)
        var euler = new THREE.Euler().setFromQuaternion(meshQ, 'YXZ');
        euler.x += (0 - euler.x) * 0.20;
        euler.z += (0 - euler.z) * 0.20;
        if (Math.abs(euler.x) < 0.005) euler.x = 0;
        if (Math.abs(euler.z) < 0.005) euler.z = 0;
        meshQ.setFromEuler(euler);

        // Sync back to cannon
        cb.quaternion.set(meshQ.x, meshQ.y, meshQ.z, meshQ.w);
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
    //  PARTITION MANAGEMENT
    // =========================================

    /**
     * Remove the collision partition for this prop
     * so the player doesn't collide with it while it's moving / held.
     */
    function _removePartition(bd) {
        if (!_colData || !_colData.partitions) return;
        if (!bd._hasPartition) return;

        var pos = bd.mesh.position;
        var parts = _colData.partitions;

        for (var i = parts.length - 1; i >= 0; i--) {
            var p = parts[i];
            if (Math.abs(p.x - pos.x) < 1.5 && Math.abs(p.z - pos.z) < 1.5) {
                // Check it's roughly the right size (not a map partition)
                if (Math.abs(p.height - bd.partHeight) < 0.5) {
                    bd._partitionData = parts.splice(i, 1)[0];
                    bd._hasPartition = false;
                    return;
                }
            }
        }
    }

    /**
     * Add a collision partition at the prop's current position
     * so the player can stand on / collide with it.
     */
    function _addPartition(bd) {
        if (!_colData || !_colData.partitions) return;
        if (bd._hasPartition) return;

        var pos = bd.mesh.position;
        _colData.partitions.push({
            x: pos.x,
            z: pos.z,
            halfW: bd.partHalfW,
            halfD: bd.partHalfD,
            height: bd.partHeight,
        });
        bd._hasPartition = true;
    }

    // =========================================
    //  IMPACT SOUND
    // =========================================

    function _playImpactSound(intensity) {
        var ctx    = AudioManager.getContext();
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
        var buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
        var data   = buf.getChannelData(0);
        for (var i = 0; i < bufLen; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.3 * Math.exp(-i / (bufLen * 0.2));
        }
        var noise     = ctx.createBufferSource();
        noise.buffer  = buf;
        var noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(vol * 0.6, now);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        var bp = ctx.createBiquadFilter();
        bp.type           = 'bandpass';
        bp.frequency.value = 400 + Math.random() * 300;
        bp.Q.value         = 2;
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
        init:      init,
        update:    update,
        addBody:   addBody,
        isHolding: isHolding,
    };
})();
