/* ========================================
   Props System
   ─────────────────────────────────────────
   Loads and places 3D models (GLB/GLTF)
   into the backrooms environment.
   Registers props with Physics engine
   for interaction.
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
     * Load a GLB model and place it in the scene, with optional collision and physics.
     * @param {string} url - path to .glb file
     * @param {object} opts - {
     *   position: {x,y,z},
     *   rotation: {x,y,z},
     *   scale: number|{x,y,z},
     *   collision: { halfW, halfD, height },
     *   physics: { mass, halfW, halfD, height } — if set, registers with Physics engine
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

                // Register with physics engine if specified
                if (opts.physics) {
                    Physics.addBody(model, {
                        mass:   opts.physics.mass   || 1.0,
                        halfW:  opts.physics.halfW  || 0.3,
                        halfD:  opts.physics.halfD  || 0.3,
                        height: opts.physics.height || 0.7,
                    });
                }
            },
            undefined,
            function (err) {
                console.error('[Props] Failed to load ' + url, err);
            }
        );

        // Register static collision if specified (and no physics)
        if (opts.collision && !opts.physics) {
            Environment.addPartition({
                x: pos.x,
                z: pos.z,
                halfW: opts.collision.halfW,
                halfD: opts.collision.halfD,
                height: opts.collision.height,
            });
        }

        // If physics, add initial collision partition (physics will manage it)
        if (opts.physics) {
            Environment.addPartition({
                x: pos.x,
                z: pos.z,
                halfW: opts.physics.halfW || 0.3,
                halfD: opts.physics.halfD || 0.3,
                height: opts.physics.height || 0.7,
            });
        }
    }

    /**
     * Place props near the spawn position (legacy fallback).
     * @param {THREE.Vector3} spawnPos
     */
    function placeSpawnProps(spawnPos) {
        // Chair — interactive physics prop near spawn
        placeModel('assets/chair.glb', {
            position: { x: spawnPos.x + 2, y: 0, z: spawnPos.z - 1 },
            rotation: { x: 0, y: -0.5, z: 0 },
            scale: 0.75,
            physics: { mass: 3.0, halfW: 0.25, halfD: 0.28, height: 1.2 },
        });
    }

    /**
     * Place props from level JSON data.
     * Props have offsets relative to the spawn position.
     * @param {Array} propsArray — from level JSON
     * @param {THREE.Vector3} spawnPos
     */
    function placeFromLevelData(propsArray, spawnPos) {
        if (!propsArray || propsArray.length === 0) {
            // No props defined — use legacy placement
            placeSpawnProps(spawnPos);
            return;
        }
        for (var i = 0; i < propsArray.length; i++) {
            var p = propsArray[i];
            var url = p.url || ('assets/' + p.type + '.glb');
            placeModel(url, {
                position: {
                    x: spawnPos.x + (p.offsetX || 0),
                    y: p.offsetY || 0,
                    z: spawnPos.z + (p.offsetZ || 0),
                },
                rotation: { x: 0, y: p.rotY || 0, z: 0 },
                scale: p.scale || 1.0,
                physics: p.physics || null,
            });
        }
    }

    function getModels() { return _loadedModels; }

    return {
        init,
        placeModel,
        placeSpawnProps,
        placeFromLevelData,
        getModels,
    };
})();
