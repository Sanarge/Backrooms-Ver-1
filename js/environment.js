/* ========================================
   Environment Builder
   Constructs the Backrooms Level 0 geometry:
   floor, ceiling, walls, and partitions.
   Light placement delegated to LightingEngine.
   ======================================== */

const Environment = (() => {
    const WALL_HEIGHT = 3.0;
    const TILE_SIZE = 4.0;

    // Layout map: 1 = open space, 0 = wall
    const MAP = [
        [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
        [0,1,1,1,1,0,1,1,1,0,1,1,1,1,0],
        [0,1,1,1,1,0,1,1,1,0,1,1,1,1,0],
        [0,1,1,0,1,1,1,1,1,1,1,0,1,1,0],
        [0,1,1,0,0,0,0,1,0,0,0,0,1,1,0],
        [0,1,1,1,1,1,1,1,1,1,1,1,1,1,0],
        [0,0,0,1,0,0,1,1,1,0,0,1,0,0,0],
        [0,1,1,1,1,1,1,1,1,1,1,1,1,1,0],
        [0,1,1,1,0,0,0,1,0,0,0,1,1,1,0],
        [0,1,0,1,1,1,1,1,1,1,1,1,0,1,0],
        [0,1,0,1,1,0,1,1,1,0,1,1,0,1,0],
        [0,1,1,1,1,0,1,1,1,0,1,1,1,1,0],
        [0,1,1,0,1,1,1,0,1,1,1,0,1,1,0],
        [0,1,1,1,1,1,1,1,1,1,1,1,1,1,0],
        [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    ];

    const mapRows = MAP.length;
    const mapCols = MAP[0].length;

    /** Half-height partition data for collision */
    const partitions = [];

    // Seeded pseudo-random for deterministic partition placement
    let _seed = 42;
    function seededRandom() {
        _seed = (_seed * 16807 + 0) % 2147483647;
        return (_seed & 0x7fffffff) / 0x7fffffff;
    }

    // Wall texture repeat — one image per this many world units
    const WALL_TEX_REPEAT = 3.0;

    // =========================================
    //  BUILD
    // =========================================

    /**
     * Build all environment geometry.
     * @param {THREE.Scene} scene
     * @param {object} textures - { wall, floor, ceiling }
     * @returns {{ map, tileSize, wallHeight }} data for LightingEngine
     */
    function build(scene, textures) {
        partitions.length = 0;
        _seed = 42;

        buildFloor(scene, textures.floor);
        buildCeiling(scene, textures.ceiling);
        buildWalls(scene, textures.wall);
        buildPartitions(scene, textures.wall);

        return {
            map: MAP,
            tileSize: TILE_SIZE,
            wallHeight: WALL_HEIGHT,
        };
    }

    // =========================================
    //  FLOOR
    // =========================================

    function buildFloor(scene, tex) {
        const w = mapCols * TILE_SIZE;
        const d = mapRows * TILE_SIZE;
        const geo = new THREE.PlaneGeometry(w, d);
        const mat = new THREE.MeshStandardMaterial({
            map: tex,
            roughness: 0.92,
            metalness: 0.0,
            color: new THREE.Color(2.4, 2.3, 2.05),
        });

        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(w / 2, 0, d / 2);
        mesh.receiveShadow = true;
        scene.add(mesh);
    }

    // =========================================
    //  CEILING
    // =========================================

    function buildCeiling(scene, tex) {
        const w = mapCols * TILE_SIZE;
        const d = mapRows * TILE_SIZE;
        const geo = new THREE.PlaneGeometry(w, d);
        const mat = new THREE.MeshStandardMaterial({
            map: tex, roughness: 0.85, metalness: 0.0,
            color: new THREE.Color(1.7, 1.65, 1.55),
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = Math.PI / 2;
        mesh.position.set(w / 2, WALL_HEIGHT, d / 2);
        scene.add(mesh);
    }

    // =========================================
    //  WALLS
    // =========================================

    function buildWalls(scene, tex) {
        const wallGeo = new THREE.BoxGeometry(TILE_SIZE, WALL_HEIGHT, TILE_SIZE);
        const wallMat = new THREE.MeshStandardMaterial({
            map: tex, roughness: 0.78, metalness: 0.02,
            color: new THREE.Color(1.5, 1.45, 1.3),
        });

        // World-space UV shader injection for continuous wallpaper wrapping
        wallMat.onBeforeCompile = function (shader) {
            shader.vertexShader = shader.vertexShader.replace(
                '#include <common>',
                [
                    '#include <common>',
                    'varying vec3 vWallWorldPos;',
                    'varying vec3 vWallWorldNorm;',
                ].join('\n')
            );
            shader.vertexShader = shader.vertexShader.replace(
                '#include <worldpos_vertex>',
                [
                    '#include <worldpos_vertex>',
                    '#ifdef USE_INSTANCING',
                    '  vWallWorldPos  = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;',
                    '  vWallWorldNorm = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);',
                    '#else',
                    '  vWallWorldPos  = (modelMatrix * vec4(transformed, 1.0)).xyz;',
                    '  vWallWorldNorm = normalize(mat3(modelMatrix) * objectNormal);',
                    '#endif',
                ].join('\n')
            );
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <common>',
                [
                    '#include <common>',
                    'varying vec3 vWallWorldPos;',
                    'varying vec3 vWallWorldNorm;',
                ].join('\n')
            );
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <map_fragment>',
                [
                    '#ifdef USE_MAP',
                    '  vec3 absN = abs(vWallWorldNorm);',
                    '  float wallU;',
                    '  if (absN.x > absN.z) {',
                    '    wallU = vWallWorldPos.z;',
                    '  } else {',
                    '    wallU = vWallWorldPos.x;',
                    '  }',
                    '  wallU /= ' + WALL_TEX_REPEAT.toFixed(1) + ';',
                    '  float wallV = vWallWorldPos.y / ' + WALL_HEIGHT.toFixed(1) + ';',
                    '  vec4 texelColor = texture2D(map, vec2(wallU, wallV));',
                    '  texelColor = mapTexelToLinear(texelColor);',
                    '  diffuseColor *= texelColor;',
                    '#endif',
                ].join('\n')
            );
        };

        const wallCount = MAP.flat().filter(v => v === 0).length;
        const inst = new THREE.InstancedMesh(wallGeo, wallMat, wallCount);

        const dummy = new THREE.Object3D();
        let idx = 0;
        for (let row = 0; row < mapRows; row++) {
            for (let col = 0; col < mapCols; col++) {
                if (MAP[row][col] === 0) {
                    dummy.position.set(
                        col * TILE_SIZE + TILE_SIZE / 2,
                        WALL_HEIGHT / 2,
                        row * TILE_SIZE + TILE_SIZE / 2
                    );
                    dummy.updateMatrix();
                    inst.setMatrixAt(idx++, dummy.matrix);
                }
            }
        }
        inst.instanceMatrix.needsUpdate = true;
        inst.castShadow = true;
        inst.receiveShadow = true;
        scene.add(inst);
    }

    // =========================================
    //  PARTITIONS
    // =========================================

    function buildPartitions(scene, wallTex) {
        const partMat = new THREE.MeshStandardMaterial({
            map: wallTex, roughness: 0.80, metalness: 0.02,
            color: new THREE.Color(1.5, 1.45, 1.3),
        });

        // World-space UV for partitions
        partMat.onBeforeCompile = function (shader) {
            shader.vertexShader = shader.vertexShader.replace(
                '#include <common>',
                '#include <common>\nvarying vec3 vWallWorldPos;\nvarying vec3 vWallWorldNorm;'
            );
            shader.vertexShader = shader.vertexShader.replace(
                '#include <worldpos_vertex>',
                '#include <worldpos_vertex>\nvWallWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWallWorldNorm = normalize(mat3(modelMatrix) * objectNormal);'
            );
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <common>',
                '#include <common>\nvarying vec3 vWallWorldPos;\nvarying vec3 vWallWorldNorm;'
            );
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <map_fragment>',
                [
                    '#ifdef USE_MAP',
                    '  vec3 absN = abs(vWallWorldNorm);',
                    '  float wallU;',
                    '  if (absN.x > absN.z) { wallU = vWallWorldPos.z; }',
                    '  else { wallU = vWallWorldPos.x; }',
                    '  wallU /= ' + WALL_TEX_REPEAT.toFixed(1) + ';',
                    '  float wallV = vWallWorldPos.y / ' + WALL_HEIGHT.toFixed(1) + ';',
                    '  vec4 texelColor = texture2D(map, vec2(wallU, wallV));',
                    '  texelColor = mapTexelToLinear(texelColor);',
                    '  diffuseColor *= texelColor;',
                    '#endif',
                ].join('\n')
            );
        };

        // Collect candidates
        const centerRow = Math.floor(mapRows / 2);
        const centerCol = Math.floor(mapCols / 2);
        const candidates = [];

        for (let row = 1; row < mapRows - 1; row++) {
            for (let col = 1; col < mapCols - 1; col++) {
                if (MAP[row][col] !== 1) continue;
                if (Math.abs(row - centerRow) <= 1 && Math.abs(col - centerCol) <= 1) continue;
                let openNeighbors = 0;
                if (MAP[row-1][col] === 1) openNeighbors++;
                if (MAP[row+1][col] === 1) openNeighbors++;
                if (MAP[row][col-1] === 1) openNeighbors++;
                if (MAP[row][col+1] === 1) openNeighbors++;
                if (openNeighbors >= 3) candidates.push({ row, col });
            }
        }

        const count = Math.min(candidates.length, 10);
        const chosen = [];
        const used = new Set();

        for (let i = 0; i < count && candidates.length > 0; i++) {
            const idx = Math.floor(seededRandom() * candidates.length);
            const c = candidates[idx];
            const key = `${c.row},${c.col}`;
            let tooClose = false;
            for (const k of used) {
                const [pr, pc] = k.split(',').map(Number);
                if (Math.abs(pr - c.row) + Math.abs(pc - c.col) <= 1) {
                    tooClose = true;
                    break;
                }
            }
            candidates.splice(idx, 1);
            if (tooClose) continue;
            used.add(key);
            chosen.push(c);
        }

        for (const c of chosen) {
            const x = c.col * TILE_SIZE + TILE_SIZE / 2;
            const z = c.row * TILE_SIZE + TILE_SIZE / 2;
            const h = 0.6 + seededRandom() * 0.8;
            const isLong = seededRandom() > 0.5;
            const length = 1.5 + seededRandom() * 1.5;
            const thickness = 0.15;

            const geo = isLong
                ? new THREE.BoxGeometry(length, h, thickness)
                : new THREE.BoxGeometry(thickness, h, length);

            const mesh = new THREE.Mesh(geo, partMat);
            const ox = (seededRandom() - 0.5) * 1.0;
            const oz = (seededRandom() - 0.5) * 1.0;

            mesh.position.set(x + ox, h / 2, z + oz);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            scene.add(mesh);

            const halfW = isLong ? length / 2 : thickness / 2;
            const halfD = isLong ? thickness / 2 : length / 2;
            partitions.push({
                x: x + ox,
                z: z + oz,
                halfW,
                halfD,
                height: h,
            });
        }
    }

    // =========================================
    //  ACCESSORS
    // =========================================

    function getCollisionData() {
        return {
            map: MAP,
            tileSize: TILE_SIZE,
            rows: mapRows,
            cols: mapCols,
            wallHeight: WALL_HEIGHT,
            partitions,
        };
    }

    function getSpawnPosition() {
        const cr = Math.floor(mapRows / 2);
        const cc = Math.floor(mapCols / 2);

        for (let r = 0; r < Math.max(mapRows, mapCols); r++) {
            for (let dr = -r; dr <= r; dr++) {
                for (let dc = -r; dc <= r; dc++) {
                    const row = cr + dr, col = cc + dc;
                    if (row >= 0 && row < mapRows && col >= 0 && col < mapCols) {
                        if (MAP[row][col] === 1) {
                            return new THREE.Vector3(
                                col * TILE_SIZE + TILE_SIZE / 2,
                                1.6,
                                row * TILE_SIZE + TILE_SIZE / 2
                            );
                        }
                    }
                }
            }
        }
        return new THREE.Vector3(TILE_SIZE * 1.5, 1.6, TILE_SIZE * 1.5);
    }

    return {
        build,
        getCollisionData,
        getSpawnPosition,
    };
})();
