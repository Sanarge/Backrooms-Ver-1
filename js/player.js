/* ========================================
   Player Controller
   First-person camera, input, head bob,
   sprint/stamina, tripping, and intro.
   Movement physics delegated to MovementEngine.
   ======================================== */

const Player = (() => {
    // --- Movement (constants from MovementEngine) ---
    const WALK_SPEED = MovementEngine.WALK_SPEED;
    const SPRINT_SPEED = MovementEngine.SPRINT_SPEED;
    const EYE_HEIGHT = MovementEngine.EYE_HEIGHT;

    // --- Mouse ---
    const MOUSE_SENSITIVITY = 0.002;
    let sensitivityMultiplier = 1.0;

    // --- Inertia ---
    let currentSpeed = 0;

    // --- Physics ---
    let velocityY = 0;
    let isGrounded = true;
    let groundHeight = 0;

    // Air movement: preserve speed at moment of jump
    let airSpeed = 0;
    let wasSprintingAtJump = false;

    // --- Head bob (full-body feel) ---
    const BOB_SPEED_WALK = 8.0;
    const BOB_SPEED_SPRINT = 11.0;
    const BOB_AMOUNT_Y = 0.055;
    const BOB_AMOUNT_X = 0.018;
    const BOB_ROLL_AMOUNT = 0.008;
    let bobTimer = 0;

    // Sprint camera lean
    const SPRINT_LEAN_PITCH = -0.02;
    let sprintLeanPitch = 0;

    // Landing impact
    const LAND_BOB_AMOUNT = 0.10;
    const LAND_BOB_DECAY = 6.0;
    let landBobOffset = 0;
    let wasGrounded = true;

    // Idle breathing
    const IDLE_BOB_SPEED = 1.2;
    const IDLE_BOB_AMOUNT = 0.004;
    let idleTimer = 0;

    // Strafe lean
    const STRAFE_LEAN_AMOUNT = 0.012;
    let strafeLean = 0;

    // Bob amplitude envelope
    let bobAmplitude = 0;
    const BOB_AMP_ATTACK = 15.0;
    const BOB_AMP_DECAY = 8.0;

    // Direction smoothing
    const lastMoveDir = new THREE.Vector3();

    // --- Camera state ---
    let yaw = 0;
    let pitch = 0;
    const MAX_PITCH = Math.PI / 2 - 0.05;

    // --- Position & movement ---
    const position = new THREE.Vector3();
    const moveDir = new THREE.Vector3();

    // --- References ---
    let camera = null;

    // --- State flags ---
    let isMoving = false;
    let isSprinting = false;

    // --- Stamina system ---
    const STAMINA_MAX = 5.0;
    const STAMINA_RECHARGE_DELAY = 2.0;
    const STAMINA_RECHARGE_TIME = 7.0;
    const STAMINA_RECHARGE_RATE = STAMINA_MAX / STAMINA_RECHARGE_TIME;
    const STAMINA_JUMP_COST = 1.0;
    let stamina = STAMINA_MAX;
    let staminaRechargeTimer = 0;
    let staminaDepleted = false;
    let wasSprinting = false;

    // --- Intro: fallen-into-the-Backrooms sequence ---
    const INTRO_DURATION = 5.5;
    const INTRO_PHASE_IMPACT_END  = 0.8;
    const INTRO_PHASE_DAZED_END   = 2.5;
    const INTRO_PHASE_RISING_END  = 4.5;
    const INTRO_AUDIO_DELAY = 1.2;
    const INTRO_AUDIO_FADE  = 3.5;
    let introActive = false;
    let introTimer = 0;
    let introCameraY = 0;
    let introCameraRoll = 0;
    let introCameraPitch = 0;
    let introCameraYaw = 0;
    let introAudioStarted = false;
    let introImpactPlayed = false;

    // --- Footstep tracking (synced to head bob cycle) ---
    let prevBobStep = 0;      // tracks which bob half-cycle we're in

    // --- Crouch system ---
    const CROUCH_EYE_HEIGHT = 0.85;          // roughly half standing
    const CROUCH_WALK_SPEED_MULT = 0.45;     // 45% of normal walk
    const CROUCH_SPRINT_SPEED_MULT = 0.50;   // 50% of normal sprint
    const CROUCH_TRANSITION_SPEED = 8.0;     // smooth crouch/stand lerp
    let isCrouching = false;
    let crouchLerp = 0;                      // 0 = standing, 1 = fully crouched
    let crouchEyeOffset = 0;                 // actual interpolated offset

    // --- Input ---
    const keys = {
        forward: false, backward: false,
        left: false, right: false,
        jump: false, sprint: false,
        crouch: false,
    };

    // =========================================
    //  TRIPPING SYSTEM
    // =========================================
    const TRIP_MIN_MOVE_TIME = 2.0;
    const TRIP_BASE_CHANCE = 0.003;
    const TRIP_SPRINT_MULTIPLIER = 3.0;
    const TRIP_COOLDOWN = 12.0;

    // Walk trip timings
    const TRIP_WALK_FALL_DURATION = 0.35;
    const TRIP_WALK_FLOOR_PAUSE = 0.5;
    const TRIP_WALK_RECOVERY_DURATION = 2.5;

    // Sprint trip timings
    const TRIP_SPRINT_FALL_DURATION = 0.20;
    const TRIP_SPRINT_FLOOR_PAUSE = 0.3;
    const TRIP_SPRINT_RECOVERY_DURATION = 1.5;

    // Walk trip targets
    const WALK_TARGET_Y = -(EYE_HEIGHT - 0.15);
    const WALK_TARGET_ROLL = 0.45;
    const WALK_TARGET_PITCH = -0.15;

    // Sprint trip targets
    const SPRINT_TARGET_Y = -(EYE_HEIGHT - 0.10);
    const SPRINT_TARGET_ROLL = 0.18;
    const SPRINT_TARGET_PITCH = -0.35;

    let moveTimer = 0;
    let tripState = 'none';
    let tripTimer = 0;
    let tripCooldownTimer = 0;
    let tripCameraY = 0;
    let tripCameraRoll = 0;
    let tripCameraPitch = 0;
    let tripWasSprinting = false;

    let tripFallDuration = 0;
    let tripFloorPause = 0;
    let tripRecoveryDuration = 0;
    let tripTargetY = 0;
    let tripTargetRoll = 0;
    let tripTargetPitch = 0;

    let isSprintRecovering = false;
    let tripRollSign = 1;
    let tripBounceOffset = 0;

    let stumbleEndY = 0;
    let stumbleEndRoll = 0;
    let stumbleEndPitch = 0;

    const IMPACT_STUN_DURATION = 0.25;
    let impactStunTimer = 0;

    // Stumble phase
    const STUMBLE_DURATION_WALK = 0.40;
    const STUMBLE_DURATION_SPRINT = 0.55;
    const STUMBLE_STEPS = 2;
    const STUMBLE_ROLL_WALK = 0.07;
    const STUMBLE_ROLL_SPRINT = 0.12;
    const STUMBLE_PITCH_WALK = -0.06;
    const STUMBLE_PITCH_SPRINT = -0.14;
    const STUMBLE_Y_DIP = 0.06;
    const STUMBLE_Y_DIP_SPRINT = 0.10;
    const STUMBLE_FORWARD_WALK = 2.5;
    const STUMBLE_FORWARD_SPRINT = 7.0;
    const INSTANT_TRIP_CHANCE = 0.10;

    let stumbleDuration = 0;
    let stumbleRollAmp = 0;
    let stumblePitchTarget = 0;
    let stumbleYDip = 0;
    let stumbleForwardSpeed = 0;

    const tripForwardDir = new THREE.Vector3();

    // =========================================
    //  INIT
    // =========================================
    function init(cam, spawnPos, collisionData) {
        camera = cam;
        position.copy(spawnPos);
        MovementEngine.setCollisionData(collisionData);

        yaw = 0;
        pitch = 0;
        bobTimer = 0;
        prevBobStep = 0;
        isCrouching = false;
        crouchLerp = 0;
        crouchEyeOffset = 0;
        velocityY = 0;
        isGrounded = true;
        groundHeight = 0;
        currentSpeed = 0;
        airSpeed = 0;
        wasSprintingAtJump = false;
        moveTimer = 0;
        tripState = 'none';
        tripTimer = 0;
        tripCooldownTimer = 0;
        tripCameraY = 0;
        tripCameraRoll = 0;
        tripCameraPitch = 0;
        tripWasSprinting = false;
        isSprintRecovering = false;
        tripBounceOffset = 0;
        tripRollSign = 1;
        impactStunTimer = 0;
        stumbleEndY = 0;
        stumbleEndRoll = 0;
        stumbleEndPitch = 0;
        stumbleDuration = 0;
        stumbleRollAmp = 0;
        stumblePitchTarget = 0;
        stumbleYDip = 0;
        stumbleForwardSpeed = 0;
        sprintLeanPitch = 0;
        landBobOffset = 0;
        wasGrounded = true;
        idleTimer = 0;
        strafeLean = 0;
        lastMoveDir.set(0, 0, 0);
        bobAmplitude = 0;
        stamina = STAMINA_MAX;
        staminaRechargeTimer = 0;
        staminaDepleted = false;
        wasSprinting = false;
        introActive = false;
        introTimer = 0;
        introCameraY = 0;
        introCameraRoll = 0;
        introCameraPitch = 0;
        introCameraYaw = 0;
        introAudioStarted = false;
        introImpactPlayed = false;

        camera.position.copy(position);

        if (!Player._listenersAdded) {
            document.addEventListener('keydown', onKeyDown);
            document.addEventListener('keyup', onKeyUp);
            Player._listenersAdded = true;
        }
    }

    function setSensitivity(val) {
        sensitivityMultiplier = 0.3 + (val / 10) * 1.7;
    }

    // =========================================
    //  INPUT
    // =========================================
    function onMouseMove(e) {
        if (tripState === 'falling' || tripState === 'onFloor') return;
        const dx = e.movementX || 0;
        const dy = e.movementY || 0;
        const stumbleMult = (tripState === 'stumbling') ? 0.4 : 1.0;
        yaw -= dx * MOUSE_SENSITIVITY * sensitivityMultiplier * stumbleMult;
        pitch -= dy * MOUSE_SENSITIVITY * sensitivityMultiplier * stumbleMult;
        pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
    }

    function onKeyDown(e) {
        switch (e.code) {
            case 'KeyW': keys.forward = true; break;
            case 'KeyS': keys.backward = true; break;
            case 'KeyA': keys.left = true; break;
            case 'KeyD': keys.right = true; break;
            case 'Space': keys.jump = true; break;
            case 'ShiftLeft': case 'ShiftRight': keys.sprint = true; break;
            case 'ControlLeft': case 'ControlRight': case 'KeyC':
                keys.crouch = true; break;
        }
    }

    function onKeyUp(e) {
        switch (e.code) {
            case 'KeyW': keys.forward = false; break;
            case 'KeyS': keys.backward = false; break;
            case 'KeyA': keys.left = false; break;
            case 'KeyD': keys.right = false; break;
            case 'Space': keys.jump = false; break;
            case 'ShiftLeft': case 'ShiftRight': keys.sprint = false; break;
            case 'ControlLeft': case 'ControlRight': case 'KeyC':
                keys.crouch = false; break;
        }
    }

    // =========================================
    //  INTRO
    // =========================================
    const _forward = new THREE.Vector3();
    const _right = new THREE.Vector3();
    const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
    const _recoveryMove = new THREE.Vector3();

    function startIntro() {
        introActive = true;
        introTimer = 0;
        introAudioStarted = false;
        introImpactPlayed = false;
        introCameraY = -(EYE_HEIGHT - 0.15);
        introCameraRoll = 0;
        introCameraPitch = 0;
        introCameraYaw = 0;
    }

    function updateIntro(dt) {
        introTimer += dt;
        const T = introTimer;

        // Audio triggers
        if (!introImpactPlayed && T > 0.05) {
            introImpactPlayed = true;
            AudioManager.playFallSound(true);
        }
        if (!introAudioStarted && T >= INTRO_AUDIO_DELAY) {
            introAudioStarted = true;
            AudioManager.stopAmbientHum();
            AudioManager.fadeSpatialSourcesIn(INTRO_AUDIO_FADE);
        }

        const floorY = -(EYE_HEIGHT - 0.15);

        // PHASE 1: IMPACT (0 – 0.8s)
        if (T < INTRO_PHASE_IMPACT_END) {
            const pt = T / INTRO_PHASE_IMPACT_END;
            const bounce = Math.sin(pt * Math.PI) * 0.06;
            introCameraY = floorY + bounce;
            const shakeDecay = (1.0 - pt) * (1.0 - pt);
            const shakeFreq = 35;
            introCameraPitch = 0.35 + shakeDecay * 0.12 * Math.sin(T * shakeFreq);
            introCameraRoll  = shakeDecay * 0.10 * Math.sin(T * shakeFreq * 1.3 + 1.0);
            introCameraYaw   = shakeDecay * 0.06 * Math.sin(T * shakeFreq * 0.7 + 2.0);
        }
        // PHASE 2: DAZED (0.8 – 2.5s)
        else if (T < INTRO_PHASE_DAZED_END) {
            const pt = (T - INTRO_PHASE_IMPACT_END) / (INTRO_PHASE_DAZED_END - INTRO_PHASE_IMPACT_END);
            const riseEase = pt * pt * (3.0 - 2.0 * pt);
            const riseTarget = floorY * 0.6;
            introCameraY = floorY + (riseTarget - floorY) * riseEase;
            const wobbleDecay = 1.0 - pt * 0.5;
            introCameraPitch = 0.35 * (1.0 - riseEase * 0.85)
                + wobbleDecay * 0.06 * Math.sin(T * 4.5)
                + wobbleDecay * 0.03 * Math.sin(T * 7.2 + 1.5);
            introCameraRoll = (1.0 - pt * 0.6) * 0.08 * Math.sin(T * 2.8)
                + 0.04 * Math.sin(T * 5.1 + 0.8);
            introCameraYaw = 0.05 * Math.sin(T * 1.8 + 0.5)
                + 0.025 * Math.sin(T * 3.3 + 2.0);
        }
        // PHASE 3: RISING (2.5 – 4.5s)
        else if (T < INTRO_PHASE_RISING_END) {
            const pt = (T - INTRO_PHASE_DAZED_END) / (INTRO_PHASE_RISING_END - INTRO_PHASE_DAZED_END);
            const riseEase = pt * pt * (3.0 - 2.0 * pt);
            const startY = floorY * 0.6;
            introCameraY = startY * (1.0 - riseEase);
            const wobble = (1.0 - pt) * 0.03;
            introCameraPitch = (1.0 - riseEase) * 0.06 + wobble * Math.sin(T * 3.8);
            introCameraRoll = (1.0 - riseEase) * 0.04 * Math.sin(T * 2.2)
                + (1.0 - pt) * 0.015 * Math.sin(T * 5.5 + 1.0);
            introCameraYaw = (1.0 - pt * pt) * 0.07 * Math.sin(T * 1.2 + 3.0)
                + 0.03 * Math.sin(T * 2.5) * (1.0 - riseEase);
        }
        // PHASE 4: SETTLE (4.5 – 5.5s)
        else {
            const pt = (T - INTRO_PHASE_RISING_END) / (INTRO_DURATION - INTRO_PHASE_RISING_END);
            const fadeOut = Math.max(0, 1.0 - pt);
            const smoothFade = fadeOut * fadeOut;
            introCameraY = 0;
            introCameraPitch = smoothFade * 0.012 * Math.sin(T * 3.0);
            introCameraRoll  = smoothFade * 0.008 * Math.sin(T * 2.3 + 0.5);
            introCameraYaw   = smoothFade * 0.010 * Math.sin(T * 1.6 + 1.0);
        }

        // Apply camera
        camera.position.set(position.x, position.y + introCameraY, position.z);
        _euler.set(pitch + introCameraPitch, yaw + introCameraYaw, introCameraRoll);
        camera.quaternion.setFromEuler(_euler);

        // End intro
        if (T >= INTRO_DURATION) {
            introActive = false;
            introCameraY = 0;
            introCameraRoll = 0;
            introCameraPitch = 0;
            introCameraYaw = 0;
        }
    }

    // =========================================
    //  UPDATE
    // =========================================
    function update(dt) {
        if (!camera) return;

        if (introActive) {
            updateIntro(dt);
            return;
        }

        if (tripCooldownTimer > 0) tripCooldownTimer -= dt;
        if (impactStunTimer > 0) impactStunTimer -= dt;

        // --- Trip state machine ---
        if (tripState !== 'none') {
            updateTrip(dt);

            if (tripState === 'stumbling') {
                applyStumbleMovement(dt);
            }
            if (tripState === 'recovering' && impactStunTimer <= 0) {
                updateRecoveryMovement(dt);
            }
            if (tripWasSprinting && tripState === 'falling') {
                applyFallMomentum(dt);
            }
            if (tripWasSprinting && tripState === 'onFloor' && impactStunTimer <= 0) {
                applyFallMomentum(dt);
            }

            updateCamera();
            return;
        }

        // --- Stamina ---
        const wantsSprint = keys.sprint && isGrounded;

        if (wantsSprint && stamina > 0 && !staminaDepleted) {
            stamina = Math.max(0, stamina - dt);
            staminaRechargeTimer = STAMINA_RECHARGE_DELAY;
            if (stamina <= 0) staminaDepleted = true;
        }
        if (!keys.sprint) staminaDepleted = false;

        if (!wantsSprint || stamina <= 0) {
            if (staminaRechargeTimer > 0) {
                staminaRechargeTimer -= dt;
            } else if (stamina < STAMINA_MAX) {
                stamina = Math.min(STAMINA_MAX, stamina + STAMINA_RECHARGE_RATE * dt);
            }
        }

        isSprinting = wantsSprint && stamina > 0 && !staminaDepleted;
        if (isSprinting && !wasSprinting) wasSprinting = true;
        if (!isSprinting && wasSprinting) wasSprinting = false;

        // --- Crouch ---
        isCrouching = keys.crouch;
        const crouchTarget = isCrouching ? 1.0 : 0.0;
        crouchLerp += (crouchTarget - crouchLerp) * Math.min(1.0, CROUCH_TRANSITION_SPEED * dt);
        crouchEyeOffset = crouchLerp * (CROUCH_EYE_HEIGHT - EYE_HEIGHT);

        // --- Direction vectors ---
        const sy = Math.sin(yaw), cy = Math.cos(yaw);
        _forward.set(-sy, 0, -cy);
        _right.set(cy, 0, -sy);

        moveDir.set(0, 0, 0);
        if (keys.forward) moveDir.add(_forward);
        if (keys.backward) moveDir.sub(_forward);
        if (keys.left) moveDir.sub(_right);
        if (keys.right) moveDir.add(_right);

        const wantsToMove = moveDir.lengthSq() > 0.001;
        const strafeInput = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);

        // --- Inertia (delegated to MovementEngine) ---
        let targetSpeed = 0;
        if (wantsToMove) {
            targetSpeed = isSprinting ? SPRINT_SPEED : WALK_SPEED;
            // Apply crouch speed reduction (lerped so transitions feel smooth)
            if (crouchLerp > 0.01) {
                const crouchMult = isSprinting ? CROUCH_SPRINT_SPEED_MULT : CROUCH_WALK_SPEED_MULT;
                targetSpeed *= (1.0 - crouchLerp) + crouchLerp * crouchMult;
            }
        }

        if (isGrounded) {
            currentSpeed = MovementEngine.updateSpeed(currentSpeed, targetSpeed, dt);
        }

        let effectiveSpeed = isGrounded ? currentSpeed : airSpeed;

        // Direction smoothing
        if (wantsToMove) {
            moveDir.normalize();
            if (lastMoveDir.lengthSq() > 0.001) {
                lastMoveDir.lerp(moveDir, Math.min(1.0, 12.0 * dt));
                moveDir.copy(lastMoveDir).normalize();
            } else {
                lastMoveDir.copy(moveDir);
            }
        } else if (currentSpeed > 0.01 && isGrounded) {
            if (lastMoveDir.lengthSq() > 0.001) {
                moveDir.copy(lastMoveDir);
            } else {
                moveDir.set(-sy, 0, -cy);
            }
        }

        isMoving = effectiveSpeed > 0.01 && moveDir.lengthSq() > 0.001;
        if (isMoving) {
            moveDir.normalize().multiplyScalar(effectiveSpeed * dt);
        }

        // --- Jump ---
        if (keys.jump && isGrounded && stamina >= STAMINA_JUMP_COST) {
            stamina = Math.max(0, stamina - STAMINA_JUMP_COST);
            staminaRechargeTimer = STAMINA_RECHARGE_DELAY;
            // Slightly reduced jump height when crouching
            const jumpMult = isCrouching ? 0.8 : 1.0;
            velocityY = MovementEngine.JUMP_VELOCITY * jumpMult;
            isGrounded = false;
            airSpeed = currentSpeed;
            wasSprintingAtJump = isSprinting;
            keys.jump = false;
        } else if (keys.jump && isGrounded) {
            keys.jump = false;
        }

        // --- Gravity ---
        if (!isGrounded) {
            velocityY += MovementEngine.GRAVITY * dt;
        }
        position.y += velocityY * dt;

        // --- Ground collision (uses MovementEngine) ---
        groundHeight = MovementEngine.getGroundHeight(position.x, position.z, position.y);
        if (position.y <= groundHeight + EYE_HEIGHT) {
            position.y = groundHeight + EYE_HEIGHT;
            if (!wasGrounded) {
                currentSpeed = airSpeed;
                const impactSpeed = Math.abs(velocityY);
                landBobOffset = -LAND_BOB_AMOUNT * Math.min(impactSpeed / 12.0, 1.0);
            }
            velocityY = 0;
            isGrounded = true;
        } else if (position.y > groundHeight + EYE_HEIGHT + 0.01) {
            isGrounded = false;
        }
        wasGrounded = isGrounded;

        // --- Horizontal collision (uses MovementEngine) ---
        if (isMoving) {
            MovementEngine.moveWithCollision(position, moveDir, position.y - EYE_HEIGHT);
        }

        // --- Bob amplitude envelope ---
        if (wantsToMove && isGrounded) {
            bobAmplitude = Math.min(1.0, bobAmplitude + BOB_AMP_ATTACK * dt);
        } else {
            bobAmplitude = Math.max(0.0, bobAmplitude - BOB_AMP_DECAY * dt);
        }

        // --- Head bob ---
        let bobOffsetY = 0;
        let bobOffsetX = 0;
        let bobRoll = 0;

        if (bobAmplitude > 0.001 && isGrounded) {
            const bobRate = (currentSpeed > WALK_SPEED + 1) ? BOB_SPEED_SPRINT : BOB_SPEED_WALK;
            bobTimer += dt * bobRate * bobAmplitude;
            const speedFactor = currentSpeed / SPRINT_SPEED;
            bobOffsetY = Math.sin(bobTimer * 2) * BOB_AMOUNT_Y * (0.6 + speedFactor * 0.4) * bobAmplitude;
            bobOffsetX = Math.cos(bobTimer) * BOB_AMOUNT_X * (0.5 + speedFactor * 0.5) * bobAmplitude;
            bobRoll = Math.sin(bobTimer) * BOB_ROLL_AMOUNT * (0.5 + speedFactor * 0.5) * bobAmplitude;

            // --- Footstep trigger (one per full bob cycle = one per step) ---
            const curBobStep = Math.floor(bobTimer / Math.PI);
            if (curBobStep !== prevBobStep && bobAmplitude > 0.35) {
                AudioManager.playFootstep(isSprinting, bobAmplitude, isCrouching);
                prevBobStep = curBobStep;
            }
        } else if (isGrounded) {
            idleTimer += dt * IDLE_BOB_SPEED;
            bobOffsetY = Math.sin(idleTimer) * IDLE_BOB_AMOUNT;
        }

        if (bobAmplitude < 0.01) {
            bobTimer *= 0.9;
            prevBobStep = Math.floor(bobTimer / Math.PI);
        }

        // --- Landing impact decay ---
        if (landBobOffset < -0.001) {
            landBobOffset += Math.abs(landBobOffset) * LAND_BOB_DECAY * dt;
            if (landBobOffset > -0.001) landBobOffset = 0;
        }

        // --- Sprint lean ---
        const targetLean = isSprinting ? SPRINT_LEAN_PITCH : 0;
        sprintLeanPitch += (targetLean - sprintLeanPitch) * Math.min(1.0, 5.0 * dt);

        // --- Strafe lean ---
        const targetStrafeLean = strafeInput * STRAFE_LEAN_AMOUNT * (isMoving ? 1 : 0);
        strafeLean += (targetStrafeLean - strafeLean) * Math.min(1.0, 6.0 * dt);

        // --- Trip chance ---
        updateTripChance(dt);

        // --- Camera ---
        position.y = Math.max(position.y, groundHeight + EYE_HEIGHT);

        const camX = position.x + _right.x * bobOffsetX;
        const camZ = position.z + _right.z * bobOffsetX;
        const camY = position.y + bobOffsetY + landBobOffset + crouchEyeOffset;

        camera.position.set(camX, camY, camZ);
        _euler.set(pitch + sprintLeanPitch, yaw, bobRoll + strafeLean);
        camera.quaternion.setFromEuler(_euler);
    }

    // =========================================
    //  TRIP CAMERA
    // =========================================
    let recoveryBobTimer = 0;

    function updateCamera() {
        if (!camera) return;

        let microBobY = 0;
        let microBobRoll = 0;

        if (tripState === 'recovering' && impactStunTimer <= 0) {
            const wantsMove = keys.forward || keys.backward || keys.left || keys.right;
            if (wantsMove) {
                const recoveryProgress = Math.min(tripTimer / tripRecoveryDuration, 1.0);
                const bobIntensity = recoveryProgress * recoveryProgress;
                const bobSpeed = 6.0 + recoveryProgress * 4.0;
                recoveryBobTimer += (1 / 120) * bobSpeed;
                microBobY = Math.sin(recoveryBobTimer * 2) * 0.03 * bobIntensity;
                microBobRoll = Math.sin(recoveryBobTimer) * 0.006 * bobIntensity;
            } else {
                recoveryBobTimer *= 0.92;
            }
        } else {
            recoveryBobTimer = 0;
        }

        _euler.set(pitch + tripCameraPitch, yaw, tripCameraRoll + microBobRoll);
        camera.quaternion.setFromEuler(_euler);
        const minCamY = groundHeight + 0.15;
        const camY = Math.max(minCamY, position.y + tripCameraY + microBobY);
        camera.position.set(position.x, camY, position.z);
    }

    // =========================================
    //  RECOVERY MOVEMENT (uses MovementEngine)
    // =========================================
    function updateRecoveryMovement(dt) {
        const sy = Math.sin(yaw), cy = Math.cos(yaw);
        _forward.set(-sy, 0, -cy);
        _right.set(cy, 0, -sy);

        _recoveryMove.set(0, 0, 0);
        if (keys.forward) _recoveryMove.add(_forward);
        if (keys.backward) _recoveryMove.sub(_forward);
        if (keys.left) _recoveryMove.sub(_right);
        if (keys.right) _recoveryMove.add(_right);

        const wantsMove = _recoveryMove.lengthSq() > 0.001;
        if (!wantsMove) {
            isSprintRecovering = false;
            return;
        }

        const wantsSprint = keys.sprint;
        if (wantsSprint && !isSprintRecovering) {
            isSprintRecovering = true;
            if (tripRecoveryDuration !== TRIP_SPRINT_RECOVERY_DURATION) {
                const progress = Math.min(tripTimer / tripRecoveryDuration, 1.0);
                tripRecoveryDuration = TRIP_SPRINT_RECOVERY_DURATION;
                tripTimer = progress * tripRecoveryDuration;
            }
        }

        const recoveryProgress = Math.min(tripTimer / tripRecoveryDuration, 1.0);
        let maxRecoverySpeed;
        if (isSprintRecovering) {
            maxRecoverySpeed = 1.5 + recoveryProgress * (SPRINT_SPEED - 1.5);
        } else {
            maxRecoverySpeed = 1.2 + recoveryProgress * (WALK_SPEED * 0.6 - 1.2);
        }

        const spd = maxRecoverySpeed * dt;
        _recoveryMove.normalize().multiplyScalar(spd);

        const feetY = position.y - EYE_HEIGHT + tripCameraY;
        MovementEngine.moveWithCollision(position, _recoveryMove, feetY);

        if (isSprintRecovering && recoveryProgress >= 0.95) {
            currentSpeed = maxRecoverySpeed;
        }
    }

    // =========================================
    //  STUMBLE / FALL MOMENTUM (uses MovementEngine)
    // =========================================
    function applyStumbleMovement(dt) {
        const t = Math.min(tripTimer / stumbleDuration, 1.0);
        const forwardScale = 0.6 + t * 0.4;
        const fwdSpeed = stumbleForwardSpeed * forwardScale * dt;
        const stepPhase = t * STUMBLE_STEPS * Math.PI * 2;
        const lateralWeave = Math.cos(stepPhase) * 0.3 * dt * (tripWasSprinting ? 2.0 : 1.0);

        const sy = Math.sin(yaw), cy = Math.cos(yaw);
        const rightX = cy, rightZ = -sy;

        const _stumbleVec = _recoveryMove; // reuse temp vector
        _stumbleVec.set(
            tripForwardDir.x * fwdSpeed + rightX * lateralWeave * tripRollSign,
            0,
            tripForwardDir.z * fwdSpeed + rightZ * lateralWeave * tripRollSign
        );
        MovementEngine.moveWithCollision(position, _stumbleVec, position.y - EYE_HEIGHT);
    }

    function applyFallMomentum(dt) {
        const totalSlideDuration = tripFallDuration + tripFloorPause;
        let elapsed;
        if (tripState === 'falling') {
            elapsed = tripTimer;
        } else {
            elapsed = tripFallDuration + tripTimer;
        }
        const t = Math.min(elapsed / totalSlideDuration, 1.0);
        const momentumScale = (1.0 - t * t) * 0.9;
        const slideSpeed = SPRINT_SPEED * momentumScale * dt;

        if (slideSpeed < 0.0001) return;

        const _slideVec = _recoveryMove; // reuse temp vector
        _slideVec.set(tripForwardDir.x * slideSpeed, 0, tripForwardDir.z * slideSpeed);
        MovementEngine.moveWithCollision(position, _slideVec, position.y - EYE_HEIGHT);
    }

    // =========================================
    //  TRIP LOGIC
    // =========================================
    function updateTripChance(dt) {
        if (!isMoving || !isGrounded) {
            moveTimer = Math.max(0, moveTimer - dt * 0.5);
            return;
        }

        moveTimer += dt;
        if (moveTimer < TRIP_MIN_MOVE_TIME) return;
        if (tripCooldownTimer > 0) return;

        let chance = TRIP_BASE_CHANCE;
        if (isSprinting) {
            chance *= TRIP_SPRINT_MULTIPLIER;
        } else {
            chance *= 0.05;
        }

        const extraTime = moveTimer - TRIP_MIN_MOVE_TIME;
        chance *= (1.0 + extraTime * 0.05);

        if (Math.random() < chance) {
            startTrip();
        }
    }

    function startTrip() {
        tripWasSprinting = isSprinting;
        tripTimer = 0;
        moveTimer = 0;
        tripCooldownTimer = TRIP_COOLDOWN;
        isSprintRecovering = false;
        tripRollSign = Math.random() < 0.5 ? 1 : -1;

        const sy = Math.sin(yaw), cy = Math.cos(yaw);
        tripForwardDir.set(-sy, 0, -cy).normalize();

        if (tripWasSprinting) {
            tripFallDuration = TRIP_SPRINT_FALL_DURATION;
            tripFloorPause = TRIP_SPRINT_FLOOR_PAUSE;
            tripRecoveryDuration = TRIP_SPRINT_RECOVERY_DURATION;
            tripTargetY = SPRINT_TARGET_Y;
            tripTargetRoll = SPRINT_TARGET_ROLL * tripRollSign;
            tripTargetPitch = SPRINT_TARGET_PITCH;
        } else {
            tripFallDuration = TRIP_WALK_FALL_DURATION;
            tripFloorPause = TRIP_WALK_FLOOR_PAUSE;
            tripRecoveryDuration = TRIP_WALK_RECOVERY_DURATION;
            tripTargetY = WALK_TARGET_Y;
            tripTargetRoll = WALK_TARGET_ROLL * tripRollSign;
            tripTargetPitch = WALK_TARGET_PITCH;
        }

        if (Math.random() < INSTANT_TRIP_CHANCE) {
            tripState = 'falling';
            currentSpeed = 0;
            stumbleEndY = 0;
            stumbleEndRoll = 0;
            stumbleEndPitch = 0;
            AudioManager.playFallSound(tripWasSprinting);
            return;
        }

        tripState = 'stumbling';
        tripCameraY = 0;
        tripCameraRoll = 0;
        tripCameraPitch = 0;

        if (tripWasSprinting) {
            stumbleDuration = STUMBLE_DURATION_SPRINT;
            stumbleRollAmp = STUMBLE_ROLL_SPRINT;
            stumblePitchTarget = STUMBLE_PITCH_SPRINT;
            stumbleYDip = STUMBLE_Y_DIP_SPRINT;
            stumbleForwardSpeed = STUMBLE_FORWARD_SPRINT;
        } else {
            stumbleDuration = STUMBLE_DURATION_WALK;
            stumbleRollAmp = STUMBLE_ROLL_WALK;
            stumblePitchTarget = STUMBLE_PITCH_WALK;
            stumbleYDip = STUMBLE_Y_DIP;
            stumbleForwardSpeed = STUMBLE_FORWARD_WALK;
        }

        currentSpeed = tripWasSprinting ? SPRINT_SPEED * 0.3 : WALK_SPEED * 0.2;
    }

    function updateTrip(dt) {
        tripTimer += dt;

        switch (tripState) {
            case 'stumbling': {
                const t = Math.min(tripTimer / stumbleDuration, 1.0);
                const stepPhase = t * STUMBLE_STEPS * Math.PI * 2;
                const growingAmplitude = stumbleRollAmp * (0.5 + t * 0.5);
                tripCameraRoll = Math.sin(stepPhase) * growingAmplitude * tripRollSign;
                const pitchEase = t * t;
                tripCameraPitch = stumblePitchTarget * pitchEase;
                const stepBob = Math.abs(Math.sin(stepPhase));
                tripCameraY = -stepBob * stumbleYDip * (0.4 + t * 0.6);

                if (t >= 1.0) {
                    stumbleEndY = tripCameraY;
                    stumbleEndRoll = tripCameraRoll;
                    stumbleEndPitch = tripCameraPitch;
                    tripState = 'falling';
                    tripTimer = 0;
                    currentSpeed = 0;
                    AudioManager.playFallSound(tripWasSprinting);
                }
                break;
            }
            case 'falling': {
                const t = Math.min(tripTimer / tripFallDuration, 1.0);
                const ease = t * t * t;
                tripCameraY = stumbleEndY + (tripTargetY - stumbleEndY) * ease;
                tripCameraRoll = stumbleEndRoll + (tripTargetRoll - stumbleEndRoll) * ease;
                tripCameraPitch = stumbleEndPitch + (tripTargetPitch - stumbleEndPitch) * ease;

                if (t >= 1.0) {
                    tripState = 'onFloor';
                    tripTimer = 0;
                    impactStunTimer = IMPACT_STUN_DURATION;
                }
                break;
            }
            case 'onFloor': {
                if (tripWasSprinting) {
                    const bt = Math.min(tripTimer / tripFloorPause, 1.0);
                    tripBounceOffset = Math.sin(bt * Math.PI) * Math.exp(-bt * 3.0) * 0.12;
                } else {
                    tripBounceOffset = 0;
                }

                tripCameraY = tripTargetY + tripBounceOffset;
                tripCameraRoll = tripTargetRoll;
                tripCameraPitch = tripTargetPitch;

                if (tripTimer >= tripFloorPause) {
                    tripState = 'recovering';
                    tripTimer = 0;
                    tripBounceOffset = 0;
                    if (keys.sprint) {
                        isSprintRecovering = true;
                        tripRecoveryDuration = TRIP_SPRINT_RECOVERY_DURATION;
                    }
                }
                break;
            }
            case 'recovering': {
                const t = Math.min(tripTimer / tripRecoveryDuration, 1.0);
                const ease = 1.0 - (1.0 - t) * (1.0 - t);
                const remaining = 1.0 - ease;

                const wobbleDecay = remaining * remaining;
                const wobbleSpeed = 9.0;

                const recoveryWobbleRoll = Math.sin(tripTimer * wobbleSpeed) * 0.045 * wobbleDecay * tripRollSign;
                const recoveryWobbleRoll2 = Math.sin(tripTimer * wobbleSpeed * 1.7 + 1.0) * 0.025 * wobbleDecay * -tripRollSign;
                const recoveryWobblePitch = Math.sin(tripTimer * wobbleSpeed * 0.8 + 0.5) * 0.03 * wobbleDecay;
                const recoveryBounceY = Math.sin(tripTimer * wobbleSpeed * 1.3) * 0.025 * wobbleDecay;

                tripCameraY = tripTargetY * remaining + recoveryBounceY;
                tripCameraRoll = tripTargetRoll * remaining + recoveryWobbleRoll + recoveryWobbleRoll2;
                tripCameraPitch = tripTargetPitch * remaining + recoveryWobblePitch;

                if (t >= 1.0) {
                    tripState = 'none';
                    tripCameraY = 0;
                    tripCameraRoll = 0;
                    tripCameraPitch = 0;
                    if (isSprintRecovering) {
                        currentSpeed = SPRINT_SPEED * 0.85;
                    }
                    isSprintRecovering = false;
                }
                break;
            }
        }
    }

    // =========================================
    //  PUBLIC API
    // =========================================
    function getPosition() {
        return position.clone();
    }

    function getCameraDirections() {
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
        return { forward: fwd, up };
    }

    function resetInput() {
        keys.forward = false;
        keys.backward = false;
        keys.left = false;
        keys.right = false;
        keys.jump = false;
        keys.sprint = false;
        keys.crouch = false;
    }

    function setMobileInput(mobileKeys) {
        keys.forward = mobileKeys.forward || false;
        keys.backward = mobileKeys.backward || false;
        keys.left = mobileKeys.left || false;
        keys.right = mobileKeys.right || false;
        keys.sprint = mobileKeys.sprint || false;
        keys.crouch = mobileKeys.crouch || false;
    }

    function getStamina() {
        return {
            current: stamina,
            max: STAMINA_MAX,
            fraction: stamina / STAMINA_MAX,
            isSprinting: isSprinting,
            isCrouching: isCrouching,
        };
    }

    function dispose() {
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('keyup', onKeyUp);
        Player._listenersAdded = false;
    }

    return {
        _listenersAdded: false,
        init,
        update,
        startIntro,
        onMouseMove,
        getPosition,
        getCameraDirections,
        getStamina,
        setSensitivity,
        resetInput,
        setMobileInput,
        dispose,
    };
})();
