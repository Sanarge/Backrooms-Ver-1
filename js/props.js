/* ========================================
   Props System
   ─────────────────────────────────────────
   Loads and places 3D models (GLB/GLTF)
   into the backrooms environment.
   ======================================== */

const Props = (() => {

    let _scene = null;
    let _loader = null;
    const _loadedModels = [];

    function init(scene) {
        _scene = scene;
        _loader = new THREE.GLTFLoader();
    }

    /**
     * Load a GLB model and place it in the scene, with optional collision box.
     * @param {string} url - path to .glb file
     * @param {object} opts - {
     *   position: {x,y,z},
     *   rotation: {x,y,z},
     *   scale: number|{x,y,z},
     *   collision: { halfW, halfD, height } — optional hitbox dimensions
     * }
     */
    function placeModel(url, opts) {
        if (!_loader || !_scene) {
            console.warn('[Props] Not initialized');
            return;
        }

        const pos = opts.position || { x: 0, y: 0, z: 0 };
        const rot = opts.rotation || { x: 0, y: 0, z: 0 };
        const scl = opts.scale || 1;

        _loader.load(
            url,
            function (gltf) {
                const model = gltf.scene;

                model.position.set(pos.x, pos.y, pos.z);
                model.rotation.set(rot.x, rot.y, rot.z);

                if (typeof scl === 'number') {
                    model.scale.set(scl, scl, scl);
                } else {
                    model.scale.set(scl.x || 1, scl.y || 1, scl.z || 1);
                }

                // Enable shadows on all meshes in the model
                model.traverse(function (child) {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.receiveShadow = true;
                    }
                });

                _scene.add(model);
                _loadedModels.push(model);
                console.log('[Props] Loaded: ' + url);
            },
            undefined,
            function (err) {
                console.error('[Props] Failed to load ' + url, err);
            }
        );

        // Register collision hitbox if specified
        if (opts.collision) {
            Environment.addPartition({
                x: pos.x,
                z: pos.z,
                halfW: opts.collision.halfW,
                halfD: opts.collision.halfD,
                height: opts.collision.height,
            });
        }
    }

    /**
     * Place props near the spawn position.
     * @param {THREE.Vector3} spawnPos
     */
    function placeSpawnProps(spawnPos) {
        // Chair — placed in front and to the right of spawn, away from walls
        placeModel('assets/chair.glb', {
            position: { x: spawnPos.x + 2, y: 0, z: spawnPos.z - 1 },
            rotation: { x: 0, y: -0.5, z: 0 },
            scale: 0.6,
            collision: { halfW: 0.3, halfD: 0.3, height: 0.7 },
        });
    }

    function getModels() { return _loadedModels; }

    return {
        init,
        placeModel,
        placeSpawnProps,
        getModels,
    };
})();
