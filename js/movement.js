/* ========================================
   Movement Engine
   Handles physics, collision detection,
   inertia, and ground height calculations.
   Shared by Player and any future entities.
   ======================================== */

const MovementEngine = (() => {

    // =========================================
    //  CONSTANTS
    // =========================================

    const PLAYER_RADIUS = 0.35;
    const EYE_HEIGHT = 1.6;
    const GRAVITY = -15.0;
    const JUMP_VELOCITY = 5.5;

    // Speed settings
    const WALK_SPEED = 4.5;
    const SPRINT_SPEED = 9.0;

    // Inertia timings
    const SPRINT_ACCEL_TIME = 0.70;
    const SPRINT_DECEL_TIME = 0.55;
    const STOP_DECEL_TIME = 0.30;
    const WALK_STOP_TIME = 0.10;
    const WALK_ACCEL_TIME = 0.14;

    // =========================================
    //  STATE (per-entity, but currently single player)
    // =========================================

    /** Collision data reference set by init */
    let collisionData = null;

    // =========================================
    //  INITIALIZATION
    // =========================================

    /**
     * Set the collision data used for all movement checks.
     * @param {object} colData - from Environment.getCollisionData()
     */
    function setCollisionData(colData) {
        collisionData = colData;
    }

    // =========================================
    //  INERTIA / SPEED
    // =========================================

    /**
     * Compute the next speed value given current speed, target speed, and dt.
     * Handles acceleration and deceleration with appropriate ramp timings.
     * @param {number} currentSpeed
     * @param {number} targetSpeed
     * @param {number} dt
     * @returns {number} updated speed
     */
    function updateSpeed(currentSpeed, targetSpeed, dt) {
        if (targetSpeed > currentSpeed) {
            // Accelerating
            const accelTime = (currentSpeed < WALK_SPEED && targetSpeed <= WALK_SPEED)
                ? WALK_ACCEL_TIME
                : SPRINT_ACCEL_TIME;
            const rate = (SPRINT_SPEED - 0) / accelTime;
            return Math.min(targetSpeed, currentSpeed + rate * dt);
        } else if (targetSpeed < currentSpeed) {
            if (targetSpeed === 0) {
                // Stopping — gradual slide
                const decelTime = (currentSpeed > WALK_SPEED + 0.5)
                    ? STOP_DECEL_TIME
                    : WALK_STOP_TIME;
                const rate = currentSpeed / Math.max(decelTime, 0.01);
                return Math.max(0, currentSpeed - rate * dt);
            } else {
                // Sprint→walk slowdown
                const rate = (SPRINT_SPEED - WALK_SPEED) / SPRINT_DECEL_TIME;
                return Math.max(targetSpeed, currentSpeed - rate * dt);
            }
        }
        return currentSpeed;
    }

    // =========================================
    //  COLLISION DETECTION
    // =========================================

    /**
     * Get the ground height at a world (x, z) position,
     * accounting for partition tops the player can stand on.
     * @param {number} x
     * @param {number} z
     * @param {number} currentY - player's current position.y (for step-up check)
     * @returns {number} ground height (0 for base floor)
     */
    function getGroundHeight(x, z, currentY) {
        if (!collisionData || !collisionData.partitions) return 0;
        let maxH = 0;

        for (const p of collisionData.partitions) {
            if (
                x >= p.x - p.halfW - PLAYER_RADIUS * 0.3 &&
                x <= p.x + p.halfW + PLAYER_RADIUS * 0.3 &&
                z >= p.z - p.halfD - PLAYER_RADIUS * 0.3 &&
                z <= p.z + p.halfD + PLAYER_RADIUS * 0.3
            ) {
                const feetY = currentY - EYE_HEIGHT;
                if (feetY >= p.height - 0.3) {
                    maxH = Math.max(maxH, p.height);
                }
            }
        }
        return maxH;
    }

    /**
     * Check whether a position (x, z) at feetY collides with walls or partitions.
     * @param {number} x
     * @param {number} z
     * @param {number} feetY - Y coordinate of the player's feet
     * @returns {boolean} true if colliding
     */
    function isCollidingXZ(x, z, feetY) {
        if (!collisionData) return false;
        const { map, tileSize, rows, cols, partitions: parts } = collisionData;

        // Check four corners of the player's bounding circle against walls
        const offsets = [
            [-PLAYER_RADIUS, -PLAYER_RADIUS],
            [ PLAYER_RADIUS, -PLAYER_RADIUS],
            [-PLAYER_RADIUS,  PLAYER_RADIUS],
            [ PLAYER_RADIUS,  PLAYER_RADIUS],
        ];

        for (const [ox, oz] of offsets) {
            const cx = x + ox, cz = z + oz;
            const col = Math.floor(cx / tileSize);
            const row = Math.floor(cz / tileSize);
            if (row < 0 || row >= rows || col < 0 || col >= cols) return true;
            if (map[row][col] === 0) return true;
        }

        // Check against partitions
        if (parts) {
            for (const p of parts) {
                // Only block if player's feet are well below the partition top
                // Use a generous margin so the player can step off small props easily
                if (feetY < p.height - 0.15) {
                    const dx = Math.abs(x - p.x) - p.halfW;
                    const dz = Math.abs(z - p.z) - p.halfD;
                    if (dx < PLAYER_RADIUS && dz < PLAYER_RADIUS) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    /**
     * Apply horizontal movement with collision sliding.
     * Attempts X and Z independently for wall-sliding behavior.
     * @param {THREE.Vector3} position - modified in place
     * @param {THREE.Vector3} moveVec  - movement delta (x, 0, z)
     * @param {number} feetY
     */
    function moveWithCollision(position, moveVec, feetY) {
        const newX = position.x + moveVec.x;
        if (!isCollidingXZ(newX, position.z, feetY)) {
            position.x = newX;
        }
        const newZ = position.z + moveVec.z;
        if (!isCollidingXZ(position.x, newZ, feetY)) {
            position.z = newZ;
        }
    }

    // =========================================
    //  PHYSICS
    // =========================================

    /**
     * Apply gravity to a vertical velocity and update position.
     * @param {THREE.Vector3} position
     * @param {number} velocityY
     * @param {number} dt
     * @returns {number} updated velocityY
     */
    function applyGravity(position, velocityY, dt) {
        velocityY += GRAVITY * dt;
        position.y += velocityY * dt;
        return velocityY;
    }

    // =========================================
    //  ACCESSORS
    // =========================================

    return {
        // Constants exposed for external use
        PLAYER_RADIUS,
        EYE_HEIGHT,
        GRAVITY,
        JUMP_VELOCITY,
        WALK_SPEED,
        SPRINT_SPEED,

        // Methods
        setCollisionData,
        updateSpeed,
        getGroundHeight,
        isCollidingXZ,
        moveWithCollision,
        applyGravity,
    };
})();
