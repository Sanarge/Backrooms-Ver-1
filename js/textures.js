/* ========================================
   Procedural Texture Generator
   Creates Backrooms-style textures via Canvas
   with randomized decay, stains, and damage
   ======================================== */

const TextureFactory = (() => {

    // =========================================
    //  SEEDED RANDOM for reproducible decay
    //  (each session gets a unique seed)
    // =========================================

    let _decaySeed = Math.floor(Math.random() * 2147483647);
    function decayRandom() {
        _decaySeed = (_decaySeed * 16807 + 0) % 2147483647;
        return (_decaySeed & 0x7fffffff) / 0x7fffffff;
    }

    // =========================================
    //  DECAY OVERLAY HELPERS
    //  These paint procedural damage onto a
    //  canvas after the HD texture loads.
    // =========================================

    /**
     * Draw a soft irregular blob (used for water stains, mold, etc.)
     * Uses a warped polygon path with radial gradients for organic shapes.
     */
    function drawBlob(ctx, cx, cy, radius, color, alpha) {
        const layers = 2 + Math.floor(decayRandom() * 4);
        for (let L = 0; L < layers; L++) {
            const ox = (decayRandom() - 0.5) * radius * 0.8;
            const oy = (decayRandom() - 0.5) * radius * 0.8;
            const r  = radius * (0.5 + decayRandom() * 0.5);
            const a  = alpha * (0.3 + decayRandom() * 0.7);

            // Build an irregular closed path by warping points around a circle
            const points = 8 + Math.floor(decayRandom() * 6);
            const pts = [];
            for (let i = 0; i < points; i++) {
                const angle = (i / points) * Math.PI * 2;
                const warp = r * (0.5 + decayRandom() * 0.7);
                pts.push({
                    x: cx + ox + Math.cos(angle) * warp,
                    y: cy + oy + Math.sin(angle) * warp,
                });
            }

            // Draw the warped shape with a radial gradient fill
            const grad = ctx.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, r);
            grad.addColorStop(0, color.replace('ALPHA', a.toFixed(2)));
            grad.addColorStop(0.5, color.replace('ALPHA', (a * 0.4).toFixed(2)));
            grad.addColorStop(1, color.replace('ALPHA', '0'));
            ctx.fillStyle = grad;

            // Smooth the path with quadratic curves between midpoints
            ctx.beginPath();
            const first = pts[0];
            const second = pts[1];
            ctx.moveTo((first.x + second.x) / 2, (first.y + second.y) / 2);
            for (let i = 1; i < pts.length; i++) {
                const cur = pts[i];
                const next = pts[(i + 1) % pts.length];
                const mx = (cur.x + next.x) / 2;
                const my = (cur.y + next.y) / 2;
                ctx.quadraticCurveTo(cur.x, cur.y, mx, my);
            }
            ctx.closePath();
            ctx.fill();
        }
    }

    /**
     * Draw a drip / streak running downward (water damage on walls).
     */
    function drawDrip(ctx, x, startY, length, width, color, alpha) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x, startY);
        let cy = startY;
        for (let i = 0; i < 6; i++) {
            const dx = (decayRandom() - 0.5) * width * 3;
            const dy = length / 6;
            cy += dy;
            ctx.lineTo(x + dx, cy);
        }
        ctx.stroke();
        ctx.restore();
    }

    /**
     * Apply wall decay: yellowing, water stains, drip marks, mold patches.
     * Draws onto a canvas at the wallpaper texture's resolution.
     */
    function applyWallDecay(img) {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        const W = canvas.width;
        const H = canvas.height;

        // Draw the original image first
        ctx.drawImage(img, 0, 0);

        // --- Yellowing / aging discoloration ---
        // Large soft patches of yellow-brown aging
        const yellowCount = 3 + Math.floor(decayRandom() * 4);
        for (let i = 0; i < yellowCount; i++) {
            const cx = decayRandom() * W;
            const cy = decayRandom() * H;
            const r  = W * (0.15 + decayRandom() * 0.25);
            drawBlob(ctx, cx, cy, r, 'rgba(120,100,40,ALPHA)', 0.06 + decayRandom() * 0.06);
        }

        // --- Water stains (dark brownish rings) ---
        const stainCount = 2 + Math.floor(decayRandom() * 3);
        for (let i = 0; i < stainCount; i++) {
            const cx = decayRandom() * W;
            const cy = decayRandom() * H * 0.6; // mostly upper half (ceiling leaks)
            const r  = W * (0.05 + decayRandom() * 0.12);
            // Dark ring outline
            ctx.save();
            ctx.globalAlpha = 0.08 + decayRandom() * 0.08;
            ctx.strokeStyle = 'rgba(80,60,30,0.6)';
            ctx.lineWidth = 2 + decayRandom() * 3;
            ctx.beginPath();
            ctx.ellipse(cx, cy, r, r * (0.6 + decayRandom() * 0.4), 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
            // Inner fill
            drawBlob(ctx, cx, cy, r * 0.7, 'rgba(90,70,35,ALPHA)', 0.04 + decayRandom() * 0.05);
        }

        // --- Drip streaks (water running down wall) ---
        const dripCount = 1 + Math.floor(decayRandom() * 3);
        for (let i = 0; i < dripCount; i++) {
            const x = decayRandom() * W;
            const sy = decayRandom() * H * 0.3;
            const len = H * (0.2 + decayRandom() * 0.5);
            const w = 1 + decayRandom() * 2;
            drawDrip(ctx, x, sy, len, w, 'rgba(100,80,40,0.5)', 0.06 + decayRandom() * 0.08);
        }

        // --- Mold spots (dark green-black clusters near edges) ---
        const moldCount = Math.floor(decayRandom() * 3); // 0-2 mold patches
        for (let i = 0; i < moldCount; i++) {
            // Mold tends to grow in corners and along edges
            const edge = decayRandom() > 0.5;
            const cx = edge ? (decayRandom() > 0.5 ? W * 0.05 : W * 0.95) : decayRandom() * W;
            const cy = H * (0.7 + decayRandom() * 0.3); // lower portion
            const r  = W * (0.02 + decayRandom() * 0.05);
            drawBlob(ctx, cx, cy, r, 'rgba(30,40,20,ALPHA)', 0.08 + decayRandom() * 0.1);
        }

        // --- Subtle scuff marks / dirt ---
        const scuffCount = 3 + Math.floor(decayRandom() * 5);
        for (let i = 0; i < scuffCount; i++) {
            const cx = decayRandom() * W;
            const cy = H * (0.6 + decayRandom() * 0.4); // lower half where people touch walls
            const r  = W * (0.01 + decayRandom() * 0.03);
            drawBlob(ctx, cx, cy, r, 'rgba(60,50,30,ALPHA)', 0.05 + decayRandom() * 0.08);
        }

        return canvas;
    }

    /**
     * Apply ceiling decay: water damage rings, brown spots, sagging discoloration.
     */
    function applyCeilingDecay(img) {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        const W = canvas.width;
        const H = canvas.height;

        ctx.drawImage(img, 0, 0);

        // --- Water damage rings (the classic ceiling leak stain) ---
        const ringCount = 3 + Math.floor(decayRandom() * 4);
        for (let i = 0; i < ringCount; i++) {
            const cx = decayRandom() * W;
            const cy = decayRandom() * H;
            const r  = W * (0.03 + decayRandom() * 0.08);

            // Brown ring
            ctx.save();
            ctx.globalAlpha = 0.1 + decayRandom() * 0.12;
            ctx.strokeStyle = 'rgba(110,80,35,0.7)';
            ctx.lineWidth = 2 + decayRandom() * 4;
            ctx.beginPath();
            ctx.ellipse(cx, cy, r, r * (0.7 + decayRandom() * 0.3), decayRandom() * Math.PI, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();

            // Darker center
            drawBlob(ctx, cx, cy, r * 0.5, 'rgba(90,65,25,ALPHA)', 0.05 + decayRandom() * 0.06);
        }

        // --- Yellowing patches (aging ceiling tiles) ---
        const yellowCount = 2 + Math.floor(decayRandom() * 3);
        for (let i = 0; i < yellowCount; i++) {
            const cx = decayRandom() * W;
            const cy = decayRandom() * H;
            const r  = W * (0.08 + decayRandom() * 0.15);
            drawBlob(ctx, cx, cy, r, 'rgba(140,120,50,ALPHA)', 0.04 + decayRandom() * 0.05);
        }

        // --- Dark moisture spots ---
        const spotCount = 4 + Math.floor(decayRandom() * 6);
        for (let i = 0; i < spotCount; i++) {
            const cx = decayRandom() * W;
            const cy = decayRandom() * H;
            const r  = W * (0.005 + decayRandom() * 0.02);
            drawBlob(ctx, cx, cy, r, 'rgba(70,55,25,ALPHA)', 0.08 + decayRandom() * 0.12);
        }

        // --- Mold near edges of tiles (subtle dark green tint) ---
        const moldCount = Math.floor(decayRandom() * 3);
        for (let i = 0; i < moldCount; i++) {
            const cx = decayRandom() * W;
            const cy = decayRandom() * H;
            const r  = W * (0.02 + decayRandom() * 0.04);
            drawBlob(ctx, cx, cy, r, 'rgba(40,50,25,ALPHA)', 0.06 + decayRandom() * 0.08);
        }

        return canvas;
    }

    /**
     * No carpet decay — return the original image as-is.
     */
    function applyCarpetDecay(img) {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');

        ctx.drawImage(img, 0, 0);

        return canvas;
    }


    // =========================================
    //  TEXTURE CREATORS
    // =========================================

    /**
     * Create the Backrooms wallpaper texture from HD image.
     * Uses world-space UV mapping in the material shader (see environment.js)
     * so the texture needs RepeatWrapping but repeat=(1,1) since UVs are
     * computed manually in the shader.
     * @returns {THREE.Texture}
     */
    function createWallTexture() {
        // Placeholder while the HD image loads
        const pCanvas = document.createElement('canvas');
        pCanvas.width = 64;
        pCanvas.height = 64;
        const pCtx = pCanvas.getContext('2d');
        pCtx.fillStyle = '#b0a040';
        pCtx.fillRect(0, 0, 64, 64);

        const tex = new THREE.CanvasTexture(pCanvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(1, 1);
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.anisotropy = 16;
        tex.encoding = THREE.sRGBEncoding;

        // Load the HD wallpaper image, apply decay, then swap it in
        const img = new Image();
        img.onload = function () {
            const decayed = applyWallDecay(img);
            tex.image = decayed;
            tex.needsUpdate = true;
        };
        img.onerror = function () {
            console.warn('Failed to load wallpaper.png, using placeholder');
        };
        img.src = 'assets/wallpaper.png';

        return tex;
    }

    /**
     * Create a carpet / floor texture from the HD seamless carpet image.
     * @returns {THREE.Texture}
     */
    function createFloorTexture() {
        // Create a placeholder canvas texture with the right color first
        const placeholderW = 64, placeholderH = 64;
        const pCanvas = document.createElement('canvas');
        pCanvas.width = placeholderW;
        pCanvas.height = placeholderH;
        const pCtx = pCanvas.getContext('2d');
        pCtx.fillStyle = '#6e6840';
        pCtx.fillRect(0, 0, placeholderW, placeholderH);

        const tex = new THREE.CanvasTexture(pCanvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(80, 80);
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.anisotropy = 16;
        tex.encoding = THREE.sRGBEncoding;

        // Load the real carpet image, apply decay, then swap it in
        const img = new Image();
        img.onload = function () {
            const decayed = applyCarpetDecay(img);
            tex.image = decayed;
            tex.needsUpdate = true;
        };
        img.onerror = function () {
            console.warn('Failed to load carpet.png, using procedural fallback');
        };
        img.src = 'assets/carpet.png';

        return tex;
    }

    /**
     * Create a ceiling tile texture.
     * @returns {THREE.CanvasTexture}
     */
    function createCeilingTexture() {
        // Placeholder canvas while the HD image loads
        const pCanvas = document.createElement('canvas');
        pCanvas.width = 64;
        pCanvas.height = 64;
        const pCtx = pCanvas.getContext('2d');
        pCtx.fillStyle = '#d8d0b8';
        pCtx.fillRect(0, 0, 64, 64);

        const tex = new THREE.CanvasTexture(pCanvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(15, 15);
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.anisotropy = 16;
        tex.encoding = THREE.sRGBEncoding;

        // Load the HD ceiling tile image, apply decay, then swap it in
        const img = new Image();
        img.onload = function () {
            const decayed = applyCeilingDecay(img);
            tex.image = decayed;
            tex.needsUpdate = true;
        };
        img.onerror = function () {
            console.warn('Failed to load ceiling_tiles_color.png, using placeholder');
        };
        img.src = 'assets/ceiling_tiles_color.png';

        return tex;
    }

    /**
     * Create a light panel emissive texture.
     * @returns {THREE.CanvasTexture}
     */
    function createLightPanelTexture() {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');

        const grad = ctx.createRadialGradient(32, 64, 5, 32, 64, 60);
        grad.addColorStop(0, '#fffbe6');
        grad.addColorStop(0.4, '#f5ecc8');
        grad.addColorStop(1, '#d8d0b0');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 64, 128);

        ctx.strokeStyle = '#a09878';
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, 62, 126);

        ctx.strokeStyle = 'rgba(180, 170, 140, 0.25)';
        ctx.lineWidth = 0.5;
        for (let y = 0; y < 128; y += 16) {
            ctx.beginPath(); ctx.moveTo(2, y); ctx.lineTo(62, y); ctx.stroke();
        }
        for (let x = 0; x < 64; x += 16) {
            ctx.beginPath(); ctx.moveTo(x, 2); ctx.lineTo(x, 126); ctx.stroke();
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        return tex;
    }

    /**
     * Create a radial glow texture for ceiling light halos.
     * Warm white center fading to fully transparent at edges.
     * @returns {THREE.CanvasTexture}
     */
    function createGlowTexture() {
        const S = 256;
        const canvas = document.createElement('canvas');
        canvas.width = S;
        canvas.height = S;
        const ctx = canvas.getContext('2d');

        // Fully transparent background
        ctx.clearRect(0, 0, S, S);

        // Radial gradient: warm white center → transparent edge
        const grad = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
        grad.addColorStop(0.0,  'rgba(255, 250, 230, 0.95)');
        grad.addColorStop(0.15, 'rgba(255, 245, 215, 0.60)');
        grad.addColorStop(0.35, 'rgba(255, 238, 195, 0.30)');
        grad.addColorStop(0.6,  'rgba(255, 230, 175, 0.10)');
        grad.addColorStop(0.85, 'rgba(255, 220, 160, 0.03)');
        grad.addColorStop(1.0,  'rgba(255, 215, 150, 0.0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, S, S);

        const tex = new THREE.CanvasTexture(canvas);
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearFilter; // no mipmaps for transparency
        return tex;
    }

    return {
        createWallTexture,
        createFloorTexture,
        createCeilingTexture,
        createLightPanelTexture,
        createGlowTexture,
    };
})();
