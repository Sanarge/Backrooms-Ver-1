/* ========================================
   Procedural Texture Generator
   Creates Backrooms-style textures via Canvas
   ======================================== */

const TextureFactory = (() => {

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

        // Load the HD wallpaper image and swap it in
        const img = new Image();
        img.onload = function () {
            tex.image = img;
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
     * Uses an Image element to load the texture synchronously into a
     * CanvasTexture so all wrapping/filter properties apply immediately.
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

        // Load the real carpet image and swap it in
        const img = new Image();
        img.onload = function () {
            tex.image = img;
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
        // Image has 4 cols x 2 rows of tiles. Repeat=15 aligns with 15-cell map
        // so each repeat = one 4.0-unit map cell, and each ceiling tile = 1.0 x 2.0 world units.
        tex.repeat.set(15, 15);
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.anisotropy = 16;
        tex.encoding = THREE.sRGBEncoding;

        // Load the HD ceiling tile image and swap it in
        const img = new Image();
        img.onload = function () {
            tex.image = img;
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
