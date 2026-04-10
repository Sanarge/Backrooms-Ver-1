/* ========================================
   Mobile Controls
   Virtual joystick + touch-look for mobile
   ======================================== */

const MobileControls = (() => {
    let isMobile = false;
    let isActive = false;       // true when device is mobile
    let isGameActive = false;   // true only when game screen is running

    // --- Joystick state ---
    let joystickTouchId = null;
    let joystickCenter = { x: 0, y: 0 };
    let joystickPos = { x: 0, y: 0 };      // current touch position
    let joystickAngle = 0;                  // radians
    let joystickMagnitude = 0;              // 0–1
    const JOYSTICK_RADIUS = 55;             // max drag radius in px

    // --- Touch-look state ---
    let lookTouchId = null;
    let lookLastPos = { x: 0, y: 0 };

    // --- DOM elements ---
    let joystickContainer = null;
    let joystickBase = null;
    let joystickThumb = null;
    let fullscreenBtn = null;

    // --- Sprint threshold: >80% magnitude = sprint ---
    const SPRINT_THRESHOLD = 0.80;
    const WALK_THRESHOLD = 0.20;             // below this = no movement

    /** Detect mobile/touch device (avoid false positives on desktop Macs) */
    function detectMobile() {
        // iPads report as Macintosh in modern Safari, so check touch + screen size
        const hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
        if (!hasTouch) return false;
        // If screen is small, definitely mobile
        if (window.innerWidth <= 1024) return true;
        // iPads in landscape can be wide — check for touch + no mouse-primary pointer
        if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
        // Fallback: check user agent for common mobile strings
        const ua = navigator.userAgent.toLowerCase();
        if (/iphone|ipad|ipod|android|mobile|tablet/.test(ua)) return true;
        return false;
    }

    /** Initialize mobile controls if on a touch device */
    function init() {
        isMobile = detectMobile();
        if (!isMobile) return;

        isActive = true;
        createDOM();
        bindEvents();

        // Hide cursor crosshair on mobile
        const crosshair = document.getElementById('crosshair');
        if (crosshair) crosshair.style.display = 'none';

        // Add mobile class to body for responsive CSS
        document.body.classList.add('is-mobile');
    }

    /** Create the joystick and fullscreen button DOM elements */
    function createDOM() {
        // --- Joystick ---
        joystickContainer = document.createElement('div');
        joystickContainer.id = 'mobile-joystick';
        joystickContainer.innerHTML = `
            <div class="joystick-base">
                <div class="joystick-thumb"></div>
            </div>
        `;
        document.body.appendChild(joystickContainer);

        joystickBase = joystickContainer.querySelector('.joystick-base');
        joystickThumb = joystickContainer.querySelector('.joystick-thumb');

        // --- Fullscreen button ---
        fullscreenBtn = document.createElement('button');
        fullscreenBtn.id = 'mobile-fullscreen';
        fullscreenBtn.textContent = 'Fullscreen';
        fullscreenBtn.className = 'menu-btn mobile-fs-btn';
        document.body.appendChild(fullscreenBtn);

        fullscreenBtn.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(() => {});
            } else {
                document.exitFullscreen();
            }
        });
    }

    /** Bind touch events */
    function bindEvents() {
        document.addEventListener('touchstart', onTouchStart, { passive: false });
        document.addEventListener('touchmove', onTouchMove, { passive: false });
        document.addEventListener('touchend', onTouchEnd, { passive: false });
        document.addEventListener('touchcancel', onTouchEnd, { passive: false });
    }

    /** Check if a touch target is an interactive UI element */
    function isUIElement(el) {
        if (!el) return false;
        const tag = el.tagName;
        if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'LABEL' || tag === 'SELECT') return true;
        // Check if inside a menu/pause overlay or if it has a click handler class
        if (el.classList && (el.classList.contains('menu-btn') || el.classList.contains('toggle-switch'))) return true;
        // Walk up a few parents to catch nested elements
        if (el.parentElement) {
            const pt = el.parentElement.tagName;
            if (pt === 'BUTTON' || pt === 'LABEL') return true;
            if (el.parentElement.classList && el.parentElement.classList.contains('menu-btn')) return true;
        }
        return false;
    }

    function onTouchStart(e) {
        if (!isActive) return;

        // Always let UI elements (buttons, inputs) handle their own events
        if (isUIElement(e.target)) return;

        // Only intercept touches when the game is actually running
        if (!isGameActive) return;

        for (const touch of e.changedTouches) {
            const x = touch.clientX;
            const y = touch.clientY;
            const screenW = window.innerWidth;

            // Left 40% of screen = joystick zone
            if (x < screenW * 0.40 && joystickTouchId === null) {
                e.preventDefault();
                joystickTouchId = touch.identifier;
                joystickCenter.x = x;
                joystickCenter.y = y;
                joystickPos.x = x;
                joystickPos.y = y;
                joystickMagnitude = 0;

                // Position the joystick at touch point
                joystickContainer.style.left = x + 'px';
                joystickContainer.style.top = y + 'px';
                joystickContainer.classList.add('active');
                joystickThumb.style.transform = 'translate(-50%, -50%)';
            }
            // Right 60% = look zone
            else if (x >= screenW * 0.40 && lookTouchId === null) {
                e.preventDefault();
                lookTouchId = touch.identifier;
                lookLastPos.x = x;
                lookLastPos.y = y;
            }
        }
    }

    function onTouchMove(e) {
        if (!isActive || !isGameActive) return;

        for (const touch of e.changedTouches) {
            if (touch.identifier === joystickTouchId) {
                e.preventDefault();
                const dx = touch.clientX - joystickCenter.x;
                const dy = touch.clientY - joystickCenter.y;
                const dist = Math.sqrt(dx * dx + dy * dy);

                // Clamp to radius
                const clampedDist = Math.min(dist, JOYSTICK_RADIUS);
                const angle = Math.atan2(dy, dx);

                joystickMagnitude = clampedDist / JOYSTICK_RADIUS;
                joystickAngle = angle;

                // Move thumb visually
                const thumbX = Math.cos(angle) * clampedDist;
                const thumbY = Math.sin(angle) * clampedDist;
                joystickThumb.style.transform =
                    `translate(calc(-50% + ${thumbX}px), calc(-50% + ${thumbY}px))`;
            }
            else if (touch.identifier === lookTouchId) {
                e.preventDefault();
                const dx = touch.clientX - lookLastPos.x;
                const dy = touch.clientY - lookLastPos.y;
                lookLastPos.x = touch.clientX;
                lookLastPos.y = touch.clientY;

                // Send as synthetic mouse movement to Player
                Player.onMouseMove({ movementX: dx * 1.2, movementY: dy * 1.2 });
            }
        }
    }

    function onTouchEnd(e) {
        if (!isActive) return;

        for (const touch of e.changedTouches) {
            if (touch.identifier === joystickTouchId) {
                joystickTouchId = null;
                joystickMagnitude = 0;
                joystickContainer.classList.remove('active');
                joystickThumb.style.transform = 'translate(-50%, -50%)';
            }
            else if (touch.identifier === lookTouchId) {
                lookTouchId = null;
            }
        }
    }

    /**
     * Called each frame by the game loop to translate joystick state
     * into Player input keys and speed.
     */
    function applyInput() {
        if (!isActive || !isGameActive) return;

        // Reset directional keys
        Player.resetInput();

        if (joystickMagnitude < WALK_THRESHOLD) return;

        // Convert angle to directional keys
        // angle: 0 = right, PI/2 = down, PI = left, -PI/2 = up
        const ax = Math.cos(joystickAngle);  // +right, -left
        const ay = Math.sin(joystickAngle);  // +down(backward), -up(forward)

        // Thresholds for diagonal vs cardinal
        const DEAD = 0.38;

        const keys = {};
        keys.forward = ay < -DEAD;
        keys.backward = ay > DEAD;
        keys.left = ax < -DEAD;
        keys.right = ax > DEAD;

        // Sprint if magnitude > threshold
        keys.sprint = joystickMagnitude >= SPRINT_THRESHOLD;

        // Apply to Player keys
        Player.setMobileInput(keys);
    }

    /** Show/hide mobile controls based on game state */
    function show() {
        if (!isActive) return;
        isGameActive = true;
        if (joystickContainer) {
            joystickContainer.style.display = '';
            // Show joystick in default position (bottom-left) so it's always visible
            joystickContainer.style.left = '90px';
            joystickContainer.style.top = (window.innerHeight - 110) + 'px';
            joystickContainer.classList.add('active');
        }
    }

    function hide() {
        if (!isActive) return;
        isGameActive = false;
        if (joystickContainer) joystickContainer.style.display = 'none';
        joystickTouchId = null;
        lookTouchId = null;
        joystickMagnitude = 0;
    }

    function getIsMobile() { return isMobile; }

    return {
        init,
        applyInput,
        show,
        hide,
        getIsMobile,
    };
})();
