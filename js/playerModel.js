/* ========================================
   Player Model
   Stick figure Three.js model for remote
   players with walk, run, trip, recovery,
   and spawn-drop animations.
   ======================================== */

const PlayerModel = (() => {

    // --- Stick figure dimensions ---
    const HEAD_RADIUS   = 0.18;
    const BODY_LENGTH   = 0.65;
    const ARM_LENGTH    = 0.5;
    const LEG_LENGTH    = 0.55;
    const LIMB_THICKNESS = 0.04;
    const TOTAL_HEIGHT  = HEAD_RADIUS * 2 + BODY_LENGTH + LEG_LENGTH; // ~1.56

    // --- Colors ---
    const STICK_COLOR   = 0xd4c090;   // Muted yellow to match backrooms palette
    const HEAD_COLOR    = 0xe8d9a0;

    // --- Nameplate ---
    const NAMEPLATE_Y_OFFSET = 0.35;  // above head

    /**
     * Create a stick figure group for a remote player.
     * @param {string} playerName
     * @returns {THREE.Group} — the figure group with named children
     */
    function create(playerName) {
        const group = new THREE.Group();
        group.name = 'player_model';

        const limbMat = new THREE.MeshStandardMaterial({
            color: STICK_COLOR,
            roughness: 0.7,
            metalness: 0.1,
        });

        const headMat = new THREE.MeshStandardMaterial({
            color: HEAD_COLOR,
            roughness: 0.6,
            metalness: 0.05,
        });

        // --- HEAD ---
        const headGeo = new THREE.SphereGeometry(HEAD_RADIUS, 12, 8);
        const head = new THREE.Mesh(headGeo, headMat);
        head.name = 'head';
        head.position.y = BODY_LENGTH + HEAD_RADIUS;
        head.castShadow = true;
        group.add(head);

        // --- BODY (torso) ---
        const bodyGeo = new THREE.CylinderGeometry(LIMB_THICKNESS, LIMB_THICKNESS, BODY_LENGTH, 6);
        const body = new THREE.Mesh(bodyGeo, limbMat);
        body.name = 'body';
        body.position.y = BODY_LENGTH / 2;
        body.castShadow = true;
        group.add(body);

        // --- LEFT ARM ---
        const armGeo = new THREE.CylinderGeometry(LIMB_THICKNESS * 0.8, LIMB_THICKNESS * 0.8, ARM_LENGTH, 5);
        const leftArm = new THREE.Mesh(armGeo, limbMat);
        leftArm.name = 'leftArm';
        leftArm.position.set(-LIMB_THICKNESS * 3, BODY_LENGTH * 0.85, 0);
        leftArm.geometry.translate(0, -ARM_LENGTH / 2, 0); // pivot at shoulder
        leftArm.castShadow = true;
        group.add(leftArm);

        // --- RIGHT ARM ---
        const rightArm = new THREE.Mesh(armGeo.clone(), limbMat);
        rightArm.name = 'rightArm';
        rightArm.position.set(LIMB_THICKNESS * 3, BODY_LENGTH * 0.85, 0);
        rightArm.geometry.translate(0, -ARM_LENGTH / 2, 0);
        rightArm.castShadow = true;
        group.add(rightArm);

        // --- LEFT LEG ---
        const legGeo = new THREE.CylinderGeometry(LIMB_THICKNESS, LIMB_THICKNESS * 0.7, LEG_LENGTH, 5);
        const leftLeg = new THREE.Mesh(legGeo, limbMat);
        leftLeg.name = 'leftLeg';
        leftLeg.position.set(-LIMB_THICKNESS * 2, 0, 0);
        leftLeg.geometry.translate(0, -LEG_LENGTH / 2, 0);
        leftLeg.castShadow = true;
        group.add(leftLeg);

        // --- RIGHT LEG ---
        const rightLeg = new THREE.Mesh(legGeo.clone(), limbMat);
        rightLeg.name = 'rightLeg';
        rightLeg.position.set(LIMB_THICKNESS * 2, 0, 0);
        rightLeg.geometry.translate(0, -LEG_LENGTH / 2, 0);
        rightLeg.castShadow = true;
        group.add(rightLeg);

        // --- NAMEPLATE ---
        const nameplate = _createNameplate(playerName);
        nameplate.position.y = BODY_LENGTH + HEAD_RADIUS * 2 + NAMEPLATE_Y_OFFSET;
        group.add(nameplate);

        // Store animation state
        group.userData = {
            animTime: 0,
            currentState: 'idle',
            spawnProgress: 0,     // 0 = dropping in, 1 = landed
            tripProgress: 0,      // 0 = standing, 1 = on ground
            recoveryProgress: 0,  // 0 = on ground, 1 = standing
        };

        return group;
    }

    /**
     * Create a text nameplate sprite.
     */
    function _createNameplate(name) {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');

        ctx.clearRect(0, 0, 256, 64);

        // Background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        const textWidth = ctx.measureText(name).width;
        _roundRect(ctx, 128 - 60, 10, 120, 40, 6);
        ctx.fill();

        // Text
        ctx.font = 'bold 22px Courier New';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#e8d9a0';
        ctx.fillText(name.substring(0, 16), 128, 30);

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;

        const spriteMat = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
        });

        const sprite = new THREE.Sprite(spriteMat);
        sprite.name = 'nameplate';
        sprite.scale.set(1.2, 0.3, 1);
        return sprite;
    }

    function _roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    // =========================================
    //  ANIMATION UPDATE
    // =========================================

    /**
     * Update the stick figure animation.
     * @param {THREE.Group} model — the player model group
     * @param {string} state — 'idle','walking','running','crouching','tripping','spawning'
     * @param {number} dt — delta time in seconds
     */
    function animate(model, state, dt) {
        if (!model || !model.userData) return;

        const ud = model.userData;
        ud.animTime += dt;
        ud.currentState = state;

        const leftArm  = model.getObjectByName('leftArm');
        const rightArm = model.getObjectByName('rightArm');
        const leftLeg  = model.getObjectByName('leftLeg');
        const rightLeg = model.getObjectByName('rightLeg');
        const head     = model.getObjectByName('head');
        const body     = model.getObjectByName('body');

        if (!leftArm || !rightArm || !leftLeg || !rightLeg) return;

        switch (state) {
            case 'spawning':
                _animateSpawn(model, ud, dt);
                break;

            case 'walking':
                _animateWalk(leftArm, rightArm, leftLeg, rightLeg, head, body, ud, 4.0);
                break;

            case 'running':
                _animateWalk(leftArm, rightArm, leftLeg, rightLeg, head, body, ud, 8.0);
                break;

            case 'crouching':
                _animateCrouch(leftArm, rightArm, leftLeg, rightLeg, head, body, ud);
                break;

            case 'tripping':
                _animateTrip(model, leftArm, rightArm, leftLeg, rightLeg, head, body, ud, dt);
                break;

            case 'idle':
            default:
                _animateIdle(leftArm, rightArm, leftLeg, rightLeg, head, body, ud);
                break;
        }
    }

    // --- IDLE ---
    function _animateIdle(lArm, rArm, lLeg, rLeg, head, body, ud) {
        const breathe = Math.sin(ud.animTime * 1.5) * 0.015;

        // Arms hang naturally with slight sway
        lArm.rotation.x = _lerp(lArm.rotation.x, breathe + 0.05, 0.1);
        rArm.rotation.x = _lerp(rArm.rotation.x, -breathe + 0.05, 0.1);
        lArm.rotation.z = _lerp(lArm.rotation.z, 0.08, 0.1);
        rArm.rotation.z = _lerp(rArm.rotation.z, -0.08, 0.1);

        // Legs straight
        lLeg.rotation.x = _lerp(lLeg.rotation.x, 0, 0.1);
        rLeg.rotation.x = _lerp(rLeg.rotation.x, 0, 0.1);

        // Head slight movement
        if (head) head.rotation.y = Math.sin(ud.animTime * 0.8) * 0.03;

        // Body upright
        if (body) body.rotation.x = _lerp(body.rotation.x, 0, 0.1);
    }

    // --- WALK / RUN ---
    function _animateWalk(lArm, rArm, lLeg, rLeg, head, body, ud, speed) {
        const t = ud.animTime * speed;
        const swing = speed > 5.0 ? 0.55 : 0.35; // bigger swing when running

        // Arms swing opposite to legs
        lArm.rotation.x = Math.sin(t) * swing;
        rArm.rotation.x = -Math.sin(t) * swing;
        lArm.rotation.z = 0.05;
        rArm.rotation.z = -0.05;

        // Legs swing
        lLeg.rotation.x = -Math.sin(t) * swing * 0.8;
        rLeg.rotation.x = Math.sin(t) * swing * 0.8;

        // Body lean forward slightly when running
        if (body) body.rotation.x = speed > 5.0 ? -0.08 : -0.03;

        // Head bob
        if (head) {
            head.position.y = BODY_LENGTH + HEAD_RADIUS + Math.abs(Math.sin(t * 2)) * 0.03;
        }
    }

    // --- CROUCH ---
    function _animateCrouch(lArm, rArm, lLeg, rLeg, head, body, ud) {
        // Arms forward for balance
        lArm.rotation.x = _lerp(lArm.rotation.x, -0.4, 0.08);
        rArm.rotation.x = _lerp(rArm.rotation.x, -0.4, 0.08);
        lArm.rotation.z = _lerp(lArm.rotation.z, 0.15, 0.08);
        rArm.rotation.z = _lerp(rArm.rotation.z, -0.15, 0.08);

        // Legs bent
        lLeg.rotation.x = _lerp(lLeg.rotation.x, -0.5, 0.08);
        rLeg.rotation.x = _lerp(rLeg.rotation.x, -0.5, 0.08);

        // Body leaned forward
        if (body) body.rotation.x = _lerp(body.rotation.x, -0.3, 0.08);
    }

    // --- SPAWN (drop from ceiling) ---
    function _animateSpawn(model, ud, dt) {
        ud.spawnProgress = Math.min(1.0, ud.spawnProgress + dt * 0.5); // 2s animation

        // Ease out bounce
        const t = ud.spawnProgress;
        const bounce = t < 0.6
            ? t / 0.6 * 1.2   // fall
            : 1.0 + Math.sin((t - 0.6) / 0.4 * Math.PI) * 0.1 * (1 - t); // bounce settle

        // Model drops from above
        const dropHeight = 3.0; // start 3 units above ground
        model.position.y = dropHeight * (1 - Math.min(bounce, 1.0));

        // Limbs flail during fall
        const lArm = model.getObjectByName('leftArm');
        const rArm = model.getObjectByName('rightArm');
        const lLeg = model.getObjectByName('leftLeg');
        const rLeg = model.getObjectByName('rightLeg');

        if (t < 0.6) {
            // Falling — limbs splayed
            if (lArm) { lArm.rotation.x = Math.sin(t * 15) * 0.5; lArm.rotation.z = 0.8; }
            if (rArm) { rArm.rotation.x = -Math.sin(t * 15) * 0.5; rArm.rotation.z = -0.8; }
            if (lLeg) lLeg.rotation.x = Math.sin(t * 12) * 0.3;
            if (rLeg) rLeg.rotation.x = -Math.sin(t * 12) * 0.3;
        } else {
            // Landing — settle to idle
            if (lArm) { lArm.rotation.x = _lerp(lArm.rotation.x, 0, 0.15); lArm.rotation.z = _lerp(lArm.rotation.z, 0.08, 0.15); }
            if (rArm) { rArm.rotation.x = _lerp(rArm.rotation.x, 0, 0.15); rArm.rotation.z = _lerp(rArm.rotation.z, -0.08, 0.15); }
            if (lLeg) lLeg.rotation.x = _lerp(lLeg.rotation.x, 0, 0.15);
            if (rLeg) rLeg.rotation.x = _lerp(rLeg.rotation.x, 0, 0.15);
        }
    }

    // --- TRIP ---
    function _animateTrip(model, lArm, rArm, lLeg, rLeg, head, body, ud, dt) {
        ud.tripProgress = Math.min(1.0, ud.tripProgress + dt * 0.5); // 2s trip animation
        const t = ud.tripProgress;

        if (t < 0.3) {
            // Falling forward
            const fall = t / 0.3;
            if (body) body.rotation.x = _lerp(body.rotation.x, -1.2, fall * 0.3);
            lArm.rotation.x = _lerp(lArm.rotation.x, -1.5, fall * 0.3);
            rArm.rotation.x = _lerp(rArm.rotation.x, -1.5, fall * 0.3);
            lArm.rotation.z = _lerp(lArm.rotation.z, 0.4, fall * 0.2);
            rArm.rotation.z = _lerp(rArm.rotation.z, -0.4, fall * 0.2);
            lLeg.rotation.x = _lerp(lLeg.rotation.x, 0.3, fall * 0.2);
            rLeg.rotation.x = _lerp(rLeg.rotation.x, -0.2, fall * 0.2);

            // Drop the model height
            model.position.y = _lerp(model.position.y, -0.6, fall * 0.3);
        } else if (t < 0.5) {
            // On the ground
            if (body) body.rotation.x = -1.2;
        } else {
            // Recovery — getting back up
            const recov = (t - 0.5) / 0.5;
            if (body) body.rotation.x = _lerp(body.rotation.x, 0, recov * 0.15);
            lArm.rotation.x = _lerp(lArm.rotation.x, 0, recov * 0.1);
            rArm.rotation.x = _lerp(rArm.rotation.x, 0, recov * 0.1);
            lLeg.rotation.x = _lerp(lLeg.rotation.x, 0, recov * 0.1);
            rLeg.rotation.x = _lerp(rLeg.rotation.x, 0, recov * 0.1);
            model.position.y = _lerp(model.position.y, 0, recov * 0.1);
        }
    }

    // =========================================
    //  RESET ANIMATION STATE
    // =========================================

    function resetAnimation(model) {
        if (!model || !model.userData) return;
        model.userData.animTime = 0;
        model.userData.spawnProgress = 0;
        model.userData.tripProgress = 0;
        model.userData.recoveryProgress = 0;
    }

    // =========================================
    //  DISPOSE
    // =========================================

    function dispose(model) {
        if (!model) return;
        model.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (child.material.map) child.material.map.dispose();
                child.material.dispose();
            }
        });
    }

    // =========================================
    //  UTIL
    // =========================================

    function _lerp(a, b, t) {
        return a + (b - a) * t;
    }

    function getTotalHeight() { return TOTAL_HEIGHT; }

    return {
        create,
        animate,
        resetAnimation,
        dispose,
        getTotalHeight,
    };
})();
