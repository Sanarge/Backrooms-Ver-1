var MapEditor = (function() {
    // ===== PRIVATE STATE =====
    var _scene, _camera, _renderer;
    var _canvas = null;

    // Level data
    var _currentLevel = null;
    var _levelNumber = null;

    // Visualization groups
    var _floorGroup, _wallGroup, _ceilingGroup, _lightGroup, _propsGroup;
    var _gridHelper = null;
    var _hoverMesh = null;
    var _spawnMarker = null;

    // Cell object tracking for mesh updates
    var _cellObjects = {};  // key: "row_col", value: { floor, ceiling, wall }
    var _propObjects = {};  // key: prop index, value: THREE.Group (model)

    // Editor state
    var _currentTool = 'wall';  // wall, open, light, spawn, chair, eraser
    var _currentLayer = 'floor';  // floor, middle, ceiling
    var _cameraMode = 'orbit';  // orbit, freefly
    var _lastTime = performance.now();
    var _isPainting = false;
    var _lastPaintedCell = null;

    // Orbit camera
    var _orbitAngle = 0;
    var _orbitElevation = Math.PI / 4;
    var _orbitDistance = 50;
    var _orbitTarget = new THREE.Vector3();
    var _orbitDamping = 0.1;
    var _orbitVelocity = { angle: 0, elevation: 0, distance: 0 };

    // Free fly camera
    var _freeFlyPos = new THREE.Vector3();
    var _freeFlyYaw = 0;
    var _freeFlyPitch = 0;
    var _freeFlySpeed = 20;

    // Raycasting
    var _raycaster = new THREE.Raycaster();
    var _mouse = new THREE.Vector2();
    var _hoverPlanes = {};  // layer -> Plane3D
    var _currentHoverCell = null;

    // Shared geometries
    var _floorGeom = null;
    var _ceilingGeom = null;
    var _wallGeom = null;
    var _lightIndicatorGeom = null;
    var _spawnGeom = null;

    // Materials
    var _floorMat = null;
    var _ceilingMat = null;
    var _wallMat = null;
    var _lightMat = null;
    var _spawnMat = null;
    var _hoverMat = null;

    // GLTFLoader for props
    var _gltfLoader = null;
    var _loadedModels = {};  // url -> THREE.Group clone template

    // Input tracking
    var _keysPressed = {};
    var _mouseDown = false;
    var _middleMouseDown = false;
    var _rightMouseDown = false;
    var _dragStart = new THREE.Vector2();
    var _panStart = new THREE.Vector3();

    // ===== PUBLIC API =====
    var api = {};

    api.init = function() {
        _initDOM();
        _initThreeJS();
        _initMaterials();
        _initGeometries();
        _initControls();
        _showLevelMenu();
        _animate();
    };

    // ===== DOM INITIALIZATION =====
    function _initDOM() {
        // Create main container if not present
        if (!document.getElementById('editor-container')) {
            var container = document.createElement('div');
            container.id = 'editor-container';
            container.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%;';
            document.body.appendChild(container);
        }

        _canvas = document.getElementById('editor-canvas');
        if (!_canvas) {
            _canvas = document.createElement('canvas');
            _canvas.id = 'editor-canvas';
            _canvas.style.cssText = 'display:block; width:100%; height:100%;';
            document.getElementById('editor-container').appendChild(_canvas);
        }
    }

    // ===== THREE.JS INITIALIZATION =====
    function _initThreeJS() {
        // Scene
        _scene = new THREE.Scene();
        _scene.background = new THREE.Color(0x1a1a2e);
        _scene.fog = new THREE.Fog(0x1a1a2e, 200, 300);

        // Camera
        _camera = new THREE.PerspectiveCamera(
            60,
            window.innerWidth / window.innerHeight,
            0.1,
            1000
        );
        _camera.position.set(0, 30, 50);

        // Renderer
        _renderer = new THREE.WebGLRenderer({
            canvas: _canvas,
            antialias: true,
            powerPreference: 'high-performance'
        });
        _renderer.setSize(window.innerWidth, window.innerHeight);
        _renderer.setPixelRatio(window.devicePixelRatio);
        _renderer.shadowMap.enabled = true;

        // Lighting
        var ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        _scene.add(ambientLight);

        var directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(50, 50, 50);
        directionalLight.castShadow = true;
        directionalLight.shadow.mapSize.width = 2048;
        directionalLight.shadow.mapSize.height = 2048;
        directionalLight.shadow.camera.far = 200;
        _scene.add(directionalLight);

        // Groups
        _floorGroup = new THREE.Group();
        _floorGroup.name = 'floors';
        _scene.add(_floorGroup);

        _wallGroup = new THREE.Group();
        _wallGroup.name = 'walls';
        _scene.add(_wallGroup);

        _ceilingGroup = new THREE.Group();
        _ceilingGroup.name = 'ceilings';
        _scene.add(_ceilingGroup);

        _lightGroup = new THREE.Group();
        _lightGroup.name = 'lights';
        _scene.add(_lightGroup);

        _propsGroup = new THREE.Group();
        _propsGroup.name = 'props';
        _scene.add(_propsGroup);

        // Grid helper
        _gridHelper = new THREE.GridHelper(100, 100, 0x444444, 0x222222);
        _gridHelper.position.y = 0.02;
        _scene.add(_gridHelper);

        // Loader for props
        _gltfLoader = new THREE.GLTFLoader();

        // Handle window resize
        window.addEventListener('resize', _onWindowResize);
    }

    function _initMaterials() {
        _floorMat = new THREE.MeshStandardMaterial({
            color: 0x8B7355,
            roughness: 0.7,
            metalness: 0.0
        });

        _ceilingMat = new THREE.MeshStandardMaterial({
            color: 0xCCBB99,
            roughness: 0.5,
            metalness: 0.0
        });

        _wallMat = new THREE.MeshStandardMaterial({
            color: 0x998866,
            roughness: 0.8,
            metalness: 0.0
        });

        _lightMat = new THREE.MeshStandardMaterial({
            color: 0xFFFF00,
            emissive: 0xFFFF00,
            emissiveIntensity: 0.5,
            roughness: 0.3
        });

        _spawnMat = new THREE.MeshStandardMaterial({
            color: 0x00FF00,
            emissive: 0x00FF00,
            emissiveIntensity: 0.4,
            roughness: 0.3
        });

        _hoverMat = new THREE.MeshStandardMaterial({
            color: 0x0099FF,
            emissive: 0x0099FF,
            emissiveIntensity: 0.2,
            transparent: true,
            opacity: 0.3,
            roughness: 0.5
        });
    }

    function _initGeometries() {
        _floorGeom = new THREE.PlaneGeometry(1, 1);
        _ceilingGeom = new THREE.PlaneGeometry(1, 1);
        _wallGeom = new THREE.BoxGeometry(1, 1, 1);
        _lightIndicatorGeom = new THREE.BoxGeometry(0.8, 0.15, 1.6);
        _spawnGeom = new THREE.CylinderGeometry(0.3, 0.3, 0.6, 16);
    }

    function _initControls() {
        document.addEventListener('mousemove', _onMouseMove);
        document.addEventListener('mousedown', _onMouseDown);
        document.addEventListener('mouseup', _onMouseUp);
        document.addEventListener('wheel', _onMouseWheel, { passive: false });
        document.addEventListener('keydown', _onKeyDown);
        document.addEventListener('keyup', _onKeyUp);
    }

    // ===== LEVEL MANAGEMENT =====
    function _showLevelMenu() {
        _hideWorkspace();
        _buildLevelListUI();
    }

    function _buildLevelListUI() {
        var menu = document.getElementById('editor-menu');
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'editor-menu';
            menu.style.cssText = 'position:absolute; top:20px; left:20px; background:#2a2a3e; padding:20px; border-radius:8px; color:#fff; font-family:monospace; max-width:600px;';
            document.body.appendChild(menu);
        }

        var html = '<h2 style="margin-top:0; color:#0099FF;">BACKROOMS MAP EDITOR</h2>';
        html += '<p>Select a level to edit or create a new one.</p>';
        html += '<div style="margin-top:20px;">';

        for (var i = 0; i < 6; i++) {
            var key = 'backrooms_level_' + i;
            var data = localStorage.getItem(key);
            var parsed = data ? JSON.parse(data) : null;
            var name = parsed ? parsed.name : 'Empty';

            html += '<div style="background:#1a1a2e; padding:10px; margin:5px 0; border-radius:4px;">';
            html += '<strong>Level ' + i + ':</strong> ' + name;
            html += '<div style="margin-top:8px;">';

            if (data) {
                html += '<button class="editor-btn" data-action="edit" data-level="' + i + '">Edit</button> ';
                html += '<button class="editor-btn" data-action="delete" data-level="' + i + '">Delete</button>';
            } else {
                html += '<button class="editor-btn" data-action="new" data-level="' + i + '">New Level</button>';
            }

            html += '</div></div>';
        }

        html += '<div style="margin-top:20px;">';
        html += '<button class="editor-btn" id="import-btn">Import from JSON</button>';
        html += '<input type="file" id="import-file" accept=".json" style="display:none;">';
        html += '</div></div>';

        menu.innerHTML = html;

        // Add event listeners
        var buttons = menu.querySelectorAll('button');
        buttons.forEach(function(btn) {
            btn.style.cssText = 'padding:6px 12px; margin:2px; background:#0099FF; color:#fff; border:none; border-radius:4px; cursor:pointer; font-family:monospace;';
            btn.addEventListener('mouseover', function() { this.style.background = '#00CCFF'; });
            btn.addEventListener('mouseout', function() { this.style.background = '#0099FF'; });

            var action = btn.getAttribute('data-action');
            var level = btn.getAttribute('data-level');

            if (action === 'edit') {
                btn.addEventListener('click', function() { _loadLevel(parseInt(level)); });
            } else if (action === 'delete') {
                btn.addEventListener('click', function() { _deleteLevel(parseInt(level)); });
            } else if (action === 'new') {
                btn.addEventListener('click', function() { _newLevel(parseInt(level)); });
            }
        });

        var importBtn = document.getElementById('import-btn');
        if (importBtn) {
            importBtn.addEventListener('click', function() {
                document.getElementById('import-file').click();
            });
        }

        var importFile = document.getElementById('import-file');
        if (importFile) {
            importFile.addEventListener('change', _onImportFile);
        }

        menu.style.display = 'block';
    }

    function _newLevel(level) {
        var name = prompt('Enter level name:', 'Level ' + level);
        if (!name) return;

        _currentLevel = {
            name: name,
            level: level,
            rows: 15,
            cols: 15,
            tileSize: 4.0,
            wallHeight: 3.0,
            map: _createBlankMap(15, 15),
            spawn: { row: 7, col: 7 },
            lights: [],
            props: []
        };
        _levelNumber = level;
        _showWorkspace();
        _rebuildScene();
    }

    function _loadLevel(level) {
        var key = 'backrooms_level_' + level;
        var data = localStorage.getItem(key);

        if (!data) {
            // Try to load default level 0
            if (level === 0) {
                _loadDefaultLevel0(level);
                return;
            }
            alert('No data for level ' + level);
            return;
        }

        try {
            _currentLevel = JSON.parse(data);
            _levelNumber = level;
            _showWorkspace();
            _rebuildScene();
        } catch (e) {
            alert('Error loading level: ' + e.message);
        }
    }

    function _loadDefaultLevel0(level) {
        // Try to fetch from assets
        fetch('assets/levels/level0.json')
            .then(function(r) { return r.json(); })
            .then(function(data) {
                _currentLevel = data;
                _levelNumber = level;
                _showWorkspace();
                _rebuildScene();
            })
            .catch(function() {
                // Create blank level 0
                _newLevel(level);
            });
    }

    function _deleteLevel(level) {
        if (!confirm('Delete level ' + level + '?')) return;
        localStorage.removeItem('backrooms_level_' + level);
        _buildLevelListUI();
    }

    function _onImportFile(e) {
        var file = e.target.files[0];
        if (!file) return;

        var reader = new FileReader();
        reader.onload = function(evt) {
            try {
                var data = JSON.parse(evt.target.result);
                var level = prompt('Import to level slot (0-5):', '0');
                if (level === null) return;
                var levelNum = parseInt(level);
                if (isNaN(levelNum) || levelNum < 0 || levelNum > 5) {
                    alert('Invalid level number');
                    return;
                }
                _currentLevel = data;
                _currentLevel.level = levelNum;
                _levelNumber = levelNum;
                _showWorkspace();
                _rebuildScene();
            } catch (err) {
                alert('Error parsing JSON: ' + err.message);
            }
        };
        reader.readAsText(file);
    }

    function _createBlankMap(rows, cols) {
        var map = [];
        for (var r = 0; r < rows; r++) {
            var row = [];
            for (var c = 0; c < cols; c++) {
                row.push(0);  // 0 = wall
            }
            map.push(row);
        }
        return map;
    }

    function _saveLevel() {
        if (!_currentLevel) return;
        var key = 'backrooms_level_' + _levelNumber;
        localStorage.setItem(key, JSON.stringify(_currentLevel));
        _showStatus('Saved level ' + _levelNumber + '!', 2000);
    }

    function _exportJSON() {
        if (!_currentLevel) return;
        var json = JSON.stringify(_currentLevel, null, 2);
        var blob = new Blob([json], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'level' + _levelNumber + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function _showWorkspace() {
        var menu = document.getElementById('editor-menu');
        if (menu) menu.style.display = 'none';
        _buildWorkspaceUI();
    }

    function _hideWorkspace() {
        var ui = document.getElementById('editor-ui');
        if (ui) ui.style.display = 'none';
    }

    function _buildWorkspaceUI() {
        var existingUI = document.getElementById('editor-ui');
        if (existingUI) {
            existingUI.style.display = 'block';
            return;
        }

        var ui = document.createElement('div');
        ui.id = 'editor-ui';
        ui.style.cssText = 'position:absolute; top:10px; left:10px; background:#2a2a3e; padding:15px; border-radius:8px; color:#fff; font-family:monospace; font-size:12px; max-width:400px; max-height:90vh; overflow-y:auto;';

        var html = '';
        html += '<div style="margin-bottom:10px;">';
        html += '<h3 style="margin:0 0 10px 0; color:#0099FF;">LEVEL ' + _levelNumber + '</h3>';

        // Tools
        html += '<div style="margin-bottom:10px;">';
        html += '<p style="margin:5px 0;">Tools:</p>';
        html += '<button class="tool-btn active" data-tool="wall">Wall</button> ';
        html += '<button class="tool-btn" data-tool="open">Open</button> ';
        html += '<button class="tool-btn" data-tool="light">Light</button> ';
        html += '<button class="tool-btn" data-tool="spawn">Spawn</button> ';
        html += '<button class="tool-btn" data-tool="chair">Chair</button> ';
        html += '<button class="tool-btn" data-tool="eraser">Erase</button>';
        html += '</div>';

        // Layers
        html += '<div style="margin-bottom:10px;">';
        html += '<p style="margin:5px 0;">Layer:</p>';
        html += '<button class="layer-btn active" data-layer="floor">Floor</button> ';
        html += '<button class="layer-btn" data-layer="middle">Middle</button> ';
        html += '<button class="layer-btn" data-layer="ceiling">Ceiling</button>';
        html += '</div>';

        // Camera
        html += '<div style="margin-bottom:10px;">';
        html += '<p style="margin:5px 0;">Camera:</p>';
        html += '<button class="cam-btn active" data-cam="orbit">Orbit</button> ';
        html += '<button class="cam-btn" data-cam="freefly">Free Fly</button>';
        html += '</div>';

        // Grid resize
        html += '<div style="margin-bottom:10px;">';
        html += '<p style="margin:5px 0;">Grid:</p>';
        html += '<input type="number" id="grid-rows" value="' + _currentLevel.rows + '" min="5" max="100" style="width:50px; padding:4px;">';
        html += '<span> x </span>';
        html += '<input type="number" id="grid-cols" value="' + _currentLevel.cols + '" min="5" max="100" style="width:50px; padding:4px;">';
        html += '<button id="resize-btn" style="margin-left:5px;">Resize</button>';
        html += '</div>';

        // Status bar
        html += '<div id="status-bar" style="background:#1a1a2e; padding:8px; border-radius:4px; margin:10px 0; min-height:20px; color:#0099FF;"></div>';

        // Save / Export
        html += '<div style="margin-top:10px;">';
        html += '<button id="save-btn" style="display:block; width:100%; padding:8px; margin-bottom:5px;">Save</button>';
        html += '<button id="export-btn" style="display:block; width:100%; padding:8px; margin-bottom:5px;">Export JSON</button>';
        html += '<button id="back-btn" style="display:block; width:100%; padding:8px; background:#FF5555;">Back to Menu</button>';
        html += '</div>';

        // Help
        html += '<div style="margin-top:10px; border-top:1px solid #444; padding-top:10px; font-size:11px;">';
        html += '<p style="margin:5px 0; color:#0099FF;">Keyboard:</p>';
        html += '<p style="margin:3px 0;">Arrow keys (orbit) / WASD (fly)</p>';
        html += '<p style="margin:3px 0;">Scroll = zoom | Middle drag = pan</p>';
        html += '<p style="margin:3px 0;">Tab = toggle camera mode</p>';
        html += '<p style="margin:3px 0;">H = help overlay</p>';
        html += '<p style="margin:3px 0;">Click/drag to paint, click props to place</p>';
        html += '</div>';

        html += '</div>';

        ui.innerHTML = html;
        document.body.appendChild(ui);

        // Style buttons
        var btns = ui.querySelectorAll('button');
        btns.forEach(function(btn) {
            btn.style.cssText = 'padding:6px 10px; margin:2px; background:#0099FF; color:#fff; border:none; border-radius:4px; cursor:pointer; font-family:monospace;';
            btn.addEventListener('mouseover', function() {
                if (!this.classList.contains('active')) this.style.background = '#00CCFF';
            });
            btn.addEventListener('mouseout', function() {
                if (this.classList.contains('active')) this.style.background = '#00FF00';
                else this.style.background = '#0099FF';
            });
        });

        // Tool buttons
        var toolBtns = ui.querySelectorAll('.tool-btn');
        toolBtns.forEach(function(btn) {
            btn.addEventListener('click', function() {
                toolBtns.forEach(function(b) { b.classList.remove('active'); b.style.background = '#0099FF'; });
                btn.classList.add('active');
                btn.style.background = '#00FF00';
                _currentTool = btn.getAttribute('data-tool');
                _updateStatus();
            });
        });

        // Layer buttons
        var layerBtns = ui.querySelectorAll('.layer-btn');
        layerBtns.forEach(function(btn) {
            btn.addEventListener('click', function() {
                layerBtns.forEach(function(b) { b.classList.remove('active'); b.style.background = '#0099FF'; });
                btn.classList.add('active');
                btn.style.background = '#00FF00';
                _currentLayer = btn.getAttribute('data-layer');
                _updateStatus();
            });
        });

        // Camera buttons
        var camBtns = ui.querySelectorAll('.cam-btn');
        camBtns.forEach(function(btn) {
            btn.addEventListener('click', function() {
                camBtns.forEach(function(b) { b.classList.remove('active'); b.style.background = '#0099FF'; });
                btn.classList.add('active');
                btn.style.background = '#00FF00';
                _cameraMode = btn.getAttribute('data-cam');
                _updateStatus();
            });
        });

        // Resize button
        document.getElementById('resize-btn').addEventListener('click', function() {
            var rows = parseInt(document.getElementById('grid-rows').value);
            var cols = parseInt(document.getElementById('grid-cols').value);
            if (rows < 5 || rows > 100 || cols < 5 || cols > 100) {
                alert('Grid size must be 5-100');
                return;
            }
            _resizeGrid(rows, cols);
        });

        // Save button
        document.getElementById('save-btn').addEventListener('click', _saveLevel);

        // Export button
        document.getElementById('export-btn').addEventListener('click', _exportJSON);

        // Back button
        document.getElementById('back-btn').addEventListener('click', function() {
            _hideWorkspace();
            _showLevelMenu();
        });

        _updateStatus();
    }

    function _updateStatus() {
        var status = document.getElementById('status-bar');
        if (status) {
            status.textContent = 'Grid: ' + _currentLevel.rows + 'x' + _currentLevel.cols +
                               ' | Tool: ' + _currentTool +
                               ' | Layer: ' + _currentLayer +
                               ' | Camera: ' + _cameraMode;
        }
    }

    function _showStatus(msg, duration) {
        var status = document.getElementById('status-bar');
        if (status) {
            var original = status.textContent;
            status.textContent = msg;
            status.style.color = '#00FF00';
            if (duration) {
                setTimeout(function() {
                    status.textContent = original;
                    status.style.color = '#0099FF';
                }, duration);
            }
        }
    }

    // ===== SCENE MANAGEMENT =====
    function _rebuildScene() {
        _clearScene();
        _rebuildGrid();
        _rebuildAllCells();
        _rebuildLights();
        _rebuildSpawn();
        _rebuildProps();
        _updateOrbitTarget();
    }

    function _clearScene() {
        _floorGroup.children = [];
        _wallGroup.children = [];
        _ceilingGroup.children = [];
        _lightGroup.children = [];
        _propsGroup.children = [];
        _cellObjects = {};
        _propObjects = {};
    }

    function _rebuildGrid() {
        if (_gridHelper) _scene.remove(_gridHelper);
        var size = Math.max(_currentLevel.rows, _currentLevel.cols) * _currentLevel.tileSize;
        _gridHelper = new THREE.GridHelper(size, Math.max(_currentLevel.rows, _currentLevel.cols), 0x444444, 0x222222);
        _gridHelper.position.y = 0.02;
        _scene.add(_gridHelper);
    }

    function _rebuildAllCells() {
        for (var r = 0; r < _currentLevel.rows; r++) {
            for (var c = 0; c < _currentLevel.cols; c++) {
                _rebuildCell(r, c);
            }
        }
    }

    function _rebuildCell(row, col) {
        var key = row + '_' + col;
        var old = _cellObjects[key];
        if (old) {
            if (old.floor) _floorGroup.remove(old.floor);
            if (old.ceiling) _ceilingGroup.remove(old.ceiling);
            if (old.wall) _wallGroup.remove(old.wall);
        }
        delete _cellObjects[key];

        var x = col * _currentLevel.tileSize + _currentLevel.tileSize / 2;
        var z = row * _currentLevel.tileSize + _currentLevel.tileSize / 2;
        var cellType = _currentLevel.map[row][col];

        var objs = { floor: null, ceiling: null, wall: null };

        if (cellType === 1) {
            // Open cell - floor and ceiling
            var floor = new THREE.Mesh(_floorGeom, _floorMat);
            floor.scale.set(_currentLevel.tileSize, _currentLevel.tileSize, 1);
            floor.rotation.x = -Math.PI / 2;
            floor.position.set(x, 0.01, z);
            floor.receiveShadow = true;
            _floorGroup.add(floor);
            objs.floor = floor;

            var ceiling = new THREE.Mesh(_ceilingGeom, _ceilingMat);
            ceiling.scale.set(_currentLevel.tileSize, _currentLevel.tileSize, 1);
            ceiling.rotation.x = Math.PI / 2;
            ceiling.position.set(x, _currentLevel.wallHeight - 0.01, z);
            ceiling.receiveShadow = true;
            _ceilingGroup.add(ceiling);
            objs.ceiling = ceiling;
        } else if (cellType === 0) {
            // Wall cell
            var wall = new THREE.Mesh(_wallGeom, _wallMat);
            wall.scale.set(_currentLevel.tileSize, _currentLevel.wallHeight, _currentLevel.tileSize);
            wall.position.set(x, _currentLevel.wallHeight / 2, z);
            wall.castShadow = true;
            wall.receiveShadow = true;
            _wallGroup.add(wall);
            objs.wall = wall;
        }

        _cellObjects[key] = objs;
    }

    function _rebuildLights() {
        _lightGroup.children = [];
        for (var i = 0; i < _currentLevel.lights.length; i++) {
            var light = _currentLevel.lights[i];
            var x = light.col * _currentLevel.tileSize + _currentLevel.tileSize / 2;
            var z = light.row * _currentLevel.tileSize + _currentLevel.tileSize / 2;
            var y = _currentLevel.wallHeight - 0.15;

            var indicator = new THREE.Mesh(_lightIndicatorGeom, _lightMat);
            indicator.position.set(x, y, z);
            _lightGroup.add(indicator);
        }
    }

    function _rebuildSpawn() {
        if (_spawnMarker) _scene.remove(_spawnMarker);

        var spawn = _currentLevel.spawn;
        var x = spawn.col * _currentLevel.tileSize + _currentLevel.tileSize / 2;
        var z = spawn.row * _currentLevel.tileSize + _currentLevel.tileSize / 2;
        var y = 0.3;

        _spawnMarker = new THREE.Mesh(_spawnGeom, _spawnMat);
        _spawnMarker.position.set(x, y, z);
        _scene.add(_spawnMarker);
    }

    function _rebuildProps() {
        _propsGroup.children = [];
        _propObjects = {};

        for (var i = 0; i < _currentLevel.props.length; i++) {
            var prop = _currentLevel.props[i];
            _loadAndPlaceProp(i, prop);
        }
    }

    function _loadAndPlaceProp(index, propData) {
        if (propData.url && _loadedModels[propData.url]) {
            _placeProp(index, propData, _loadedModels[propData.url]);
        } else if (propData.url) {
            _gltfLoader.load(propData.url, function(gltf) {
                _loadedModels[propData.url] = gltf.scene;
                _placeProp(index, propData, gltf.scene);
            }, undefined, function(err) {
                console.error('Failed to load prop:', propData.url, err);
            });
        }
    }

    function _placeProp(index, propData, modelTemplate) {
        var model = modelTemplate.clone();

        var x = propData.col * _currentLevel.tileSize + _currentLevel.tileSize / 2 + (propData.offsetX || 0);
        var y = (propData.offsetY || 0);
        var z = propData.row * _currentLevel.tileSize + _currentLevel.tileSize / 2 + (propData.offsetZ || 0);

        model.position.set(x, y, z);
        model.rotation.y = propData.rotY || 0;
        model.scale.set(propData.scale || 1, propData.scale || 1, propData.scale || 1);

        _propsGroup.add(model);
        _propObjects[index] = model;
    }

    function _resizeGrid(newRows, newCols) {
        var oldMap = _currentLevel.map;
        var oldRows = _currentLevel.rows;
        var oldCols = _currentLevel.cols;

        var newMap = _createBlankMap(newRows, newCols);

        // Copy old data
        for (var r = 0; r < Math.min(oldRows, newRows); r++) {
            for (var c = 0; c < Math.min(oldCols, newCols); c++) {
                newMap[r][c] = oldMap[r][c];
            }
        }

        _currentLevel.rows = newRows;
        _currentLevel.cols = newCols;
        _currentLevel.map = newMap;

        // Update grid size inputs
        document.getElementById('grid-rows').value = newRows;
        document.getElementById('grid-cols').value = newCols;

        _rebuildScene();
        _showStatus('Grid resized to ' + newRows + 'x' + newCols, 2000);
    }

    function _updateOrbitTarget() {
        var centerRow = _currentLevel.rows / 2;
        var centerCol = _currentLevel.cols / 2;
        var x = centerCol * _currentLevel.tileSize + _currentLevel.tileSize / 2;
        var z = centerRow * _currentLevel.tileSize + _currentLevel.tileSize / 2;
        var y = _currentLevel.wallHeight / 2;
        _orbitTarget.set(x, y, z);
    }

    // ===== RAYCASTING & HOVER =====
    function _updateHoverCell() {
        var layerY;
        if (_currentLayer === 'floor') layerY = 0;
        else if (_currentLayer === 'middle') layerY = _currentLevel.wallHeight / 2;
        else layerY = _currentLevel.wallHeight;

        _raycaster.setFromCamera(_mouse, _camera);

        var plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -layerY);
        var point = new THREE.Vector3();
        _raycaster.ray.intersectPlane(plane, point);

        var col = Math.floor(point.x / _currentLevel.tileSize);
        var row = Math.floor(point.z / _currentLevel.tileSize);

        col = Math.max(0, Math.min(col, _currentLevel.cols - 1));
        row = Math.max(0, Math.min(row, _currentLevel.rows - 1));

        if (!_currentHoverCell || _currentHoverCell.row !== row || _currentHoverCell.col !== col) {
            _currentHoverCell = { row: row, col: col };
            _updateHoverMesh();
        }
    }

    function _updateHoverMesh() {
        if (_hoverMesh) _scene.remove(_hoverMesh);

        if (!_currentHoverCell) return;

        var row = _currentHoverCell.row;
        var col = _currentHoverCell.col;
        var x = col * _currentLevel.tileSize + _currentLevel.tileSize / 2;
        var z = row * _currentLevel.tileSize + _currentLevel.tileSize / 2;
        var layerY;

        if (_currentLayer === 'floor') {
            layerY = 0.02;
            _hoverMesh = new THREE.Mesh(_floorGeom, _hoverMat);
            _hoverMesh.rotation.x = -Math.PI / 2;
            _hoverMesh.scale.set(_currentLevel.tileSize * 0.95, _currentLevel.tileSize * 0.95, 1);
        } else if (_currentLayer === 'ceiling') {
            layerY = _currentLevel.wallHeight - 0.02;
            _hoverMesh = new THREE.Mesh(_ceilingGeom, _hoverMat);
            _hoverMesh.rotation.x = Math.PI / 2;
            _hoverMesh.scale.set(_currentLevel.tileSize * 0.95, _currentLevel.tileSize * 0.95, 1);
        } else {
            layerY = _currentLevel.wallHeight / 2;
            _hoverMesh = new THREE.Mesh(_wallGeom, _hoverMat);
            _hoverMesh.scale.set(_currentLevel.tileSize * 0.95, _currentLevel.wallHeight * 0.95, _currentLevel.tileSize * 0.95);
        }

        _hoverMesh.position.set(x, layerY, z);
        _scene.add(_hoverMesh);
    }

    // ===== EDITING TOOLS =====
    function _paintCell(row, col) {
        if (row < 0 || row >= _currentLevel.rows || col < 0 || col >= _currentLevel.cols) return;

        switch (_currentTool) {
            case 'wall':
                _currentLevel.map[row][col] = 0;
                _removeLight(row, col);
                _removeSpawnAt(row, col);
                _removePropsAt(row, col);
                _rebuildCell(row, col);
                break;

            case 'open':
                _currentLevel.map[row][col] = 1;
                _rebuildCell(row, col);
                break;

            case 'light':
                if (_currentLevel.map[row][col] === 1) {
                    _toggleLight(row, col);
                    _rebuildLights();
                }
                break;

            case 'spawn':
                if (_currentLevel.map[row][col] === 1) {
                    _currentLevel.spawn = { row: row, col: col };
                    _rebuildSpawn();
                }
                break;

            case 'chair':
                if (_currentLevel.map[row][col] === 1) {
                    var prop = {
                        type: 'chair',
                        url: 'assets/chair.glb',
                        row: row,
                        col: col,
                        offsetX: 0,
                        offsetY: 0,
                        offsetZ: 0,
                        rotY: 0,
                        scale: 0.75,
                        physics: {
                            mass: 3.0,
                            halfW: 0.25,
                            halfD: 0.28,
                            height: 1.2
                        }
                    };
                    _currentLevel.props.push(prop);
                    _rebuildProps();
                }
                break;

            case 'eraser':
                _currentLevel.map[row][col] = 1;
                _removeLight(row, col);
                _removeSpawnAt(row, col);
                _removePropsAt(row, col);
                _rebuildCell(row, col);
                _rebuildLights();
                _rebuildSpawn();
                break;
        }
    }

    function _toggleLight(row, col) {
        var idx = -1;
        for (var i = 0; i < _currentLevel.lights.length; i++) {
            if (_currentLevel.lights[i].row === row && _currentLevel.lights[i].col === col) {
                idx = i;
                break;
            }
        }

        if (idx >= 0) {
            _currentLevel.lights.splice(idx, 1);
        } else {
            _currentLevel.lights.push({ row: row, col: col });
        }
    }

    function _removeLight(row, col) {
        _currentLevel.lights = _currentLevel.lights.filter(function(light) {
            return !(light.row === row && light.col === col);
        });
    }

    function _removeSpawnAt(row, col) {
        if (_currentLevel.spawn.row === row && _currentLevel.spawn.col === col) {
            var newSpawn = Math.floor(_currentLevel.rows / 2);
            _currentLevel.spawn = { row: newSpawn, col: newSpawn };
        }
    }

    function _removePropsAt(row, col) {
        _currentLevel.props = _currentLevel.props.filter(function(prop) {
            return !(prop.row === row && prop.col === col);
        });
    }

    // ===== CAMERA CONTROLS =====
    function _updateCamera(dt) {
        if (_cameraMode === 'orbit') {
            _updateOrbitCamera(dt);
        } else {
            _updateFreeFlyCam(dt);
        }
    }

    function _updateOrbitCamera(dt) {
        // Damped input
        if (_keysPressed['ArrowLeft']) _orbitVelocity.angle += 2.0;
        if (_keysPressed['ArrowRight']) _orbitVelocity.angle -= 2.0;
        if (_keysPressed['ArrowUp']) _orbitVelocity.elevation += 1.5;
        if (_keysPressed['ArrowDown']) _orbitVelocity.elevation -= 1.5;

        _orbitVelocity.angle *= (1 - _orbitDamping);
        _orbitVelocity.elevation *= (1 - _orbitDamping);
        _orbitVelocity.distance *= (1 - _orbitDamping);

        _orbitAngle += _orbitVelocity.angle * dt;
        _orbitElevation += _orbitVelocity.elevation * dt;
        _orbitElevation = Math.max(0.1, Math.min(_orbitElevation, Math.PI / 2 - 0.05));
        _orbitDistance += _orbitVelocity.distance * dt;
        _orbitDistance = Math.max(10, Math.min(_orbitDistance, 150));

        // Compute camera position
        var x = _orbitTarget.x + _orbitDistance * Math.sin(_orbitAngle) * Math.cos(_orbitElevation);
        var y = _orbitTarget.y + _orbitDistance * Math.sin(_orbitElevation);
        var z = _orbitTarget.z + _orbitDistance * Math.cos(_orbitAngle) * Math.cos(_orbitElevation);

        _camera.position.set(x, y, z);
        _camera.lookAt(_orbitTarget);
    }

    function _updateFreeFlyCam(dt) {
        var speed = _keysPressed['Shift'] ? _freeFlySpeed * 2 : _freeFlySpeed;
        var dir = new THREE.Vector3();

        if (_keysPressed['w'] || _keysPressed['W']) {
            dir.x += Math.sin(_freeFlyYaw);
            dir.z += Math.cos(_freeFlyYaw);
        }
        if (_keysPressed['s'] || _keysPressed['S']) {
            dir.x -= Math.sin(_freeFlyYaw);
            dir.z -= Math.cos(_freeFlyYaw);
        }
        if (_keysPressed['a'] || _keysPressed['A']) {
            dir.x += Math.sin(_freeFlyYaw - Math.PI / 2);
            dir.z += Math.cos(_freeFlyYaw - Math.PI / 2);
        }
        if (_keysPressed['d'] || _keysPressed['D']) {
            dir.x += Math.sin(_freeFlyYaw + Math.PI / 2);
            dir.z += Math.cos(_freeFlyYaw + Math.PI / 2);
        }
        if (_keysPressed['q'] || _keysPressed['Q']) {
            dir.y -= 1;
        }
        if (_keysPressed['e'] || _keysPressed['E']) {
            dir.y += 1;
        }

        if (dir.length() > 0) {
            dir.normalize();
            _freeFlyPos.x += dir.x * speed * dt;
            _freeFlyPos.y += dir.y * speed * dt;
            _freeFlyPos.z += dir.z * speed * dt;
        }

        _camera.position.copy(_freeFlyPos);
        _camera.rotation.order = 'YXZ';
        _camera.rotation.y = _freeFlyYaw;
        _camera.rotation.x = _freeFlyPitch;
    }

    // ===== INPUT HANDLERS =====
    function _onMouseMove(e) {
        _mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        _mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

        _updateHoverCell();

        if (_middleMouseDown) {
            var deltaX = e.clientX - _dragStart.x;
            var deltaY = e.clientY - _dragStart.y;

            var panScale = _orbitDistance / 50;
            var right = new THREE.Vector3();
            _camera.getWorldDirection(right);
            var up = _camera.up;

            right.cross(up).normalize();
            var actualUp = new THREE.Vector3().crossVectors(right, new THREE.Vector3(0, 1, 0)).normalize();

            _orbitTarget.addScaledVector(right, -deltaX * 0.05 * panScale);
            _orbitTarget.addScaledVector(actualUp, deltaY * 0.05 * panScale);

            _dragStart.x = e.clientX;
            _dragStart.y = e.clientY;
        }

        if (_rightMouseDown) {
            var dx = e.clientX - _dragStart.x;
            var dy = e.clientY - _dragStart.y;

            _freeFlyYaw -= dx * 0.005;
            _freeFlyPitch -= dy * 0.005;
            _freeFlyPitch = Math.max(-Math.PI / 2 + 0.1, Math.min(_freeFlyPitch, Math.PI / 2 - 0.1));

            _dragStart.x = e.clientX;
            _dragStart.y = e.clientY;
        }

        if (_isPainting && _currentHoverCell) {
            var key = _currentHoverCell.row + '_' + _currentHoverCell.col;
            if (key !== _lastPaintedCell) {
                _paintCell(_currentHoverCell.row, _currentHoverCell.col);
                _lastPaintedCell = key;
            }
        }
    }

    function _onMouseDown(e) {
        if (e.button === 0) {  // left click
            _mouseDown = true;
            _isPainting = true;
            if (_currentHoverCell) {
                _lastPaintedCell = _currentHoverCell.row + '_' + _currentHoverCell.col;
                _paintCell(_currentHoverCell.row, _currentHoverCell.col);
            }
        } else if (e.button === 1) {  // middle click
            _middleMouseDown = true;
            _dragStart.x = e.clientX;
            _dragStart.y = e.clientY;
        } else if (e.button === 2) {  // right click
            _rightMouseDown = true;
            _dragStart.x = e.clientX;
            _dragStart.y = e.clientY;
        }
    }

    function _onMouseUp(e) {
        if (e.button === 0) {
            _mouseDown = false;
            _isPainting = false;
            _lastPaintedCell = null;
        } else if (e.button === 1) {
            _middleMouseDown = false;
        } else if (e.button === 2) {
            _rightMouseDown = false;
        }
    }

    function _onMouseWheel(e) {
        e.preventDefault();
        var delta = e.deltaY > 0 ? 1 : -1;
        _orbitVelocity.distance += delta * 3;
    }

    function _onKeyDown(e) {
        _keysPressed[e.key] = true;

        if (e.key === 'Tab') {
            e.preventDefault();
            _cameraMode = _cameraMode === 'orbit' ? 'freefly' : 'orbit';
            if (_cameraMode === 'freefly') {
                _freeFlyPos.copy(_camera.position);
            }
            _updateStatus();
            _updateCameraButtons();
        }

        if (e.key === 'h' || e.key === 'H') {
            _toggleHelp();
        }
    }

    function _onKeyUp(e) {
        delete _keysPressed[e.key];
    }

    function _updateCameraButtons() {
        var buttons = document.querySelectorAll('.cam-btn');
        buttons.forEach(function(btn) {
            btn.classList.remove('active');
            btn.style.background = '#0099FF';
            if (btn.getAttribute('data-cam') === _cameraMode) {
                btn.classList.add('active');
                btn.style.background = '#00FF00';
            }
        });
    }

    function _toggleHelp() {
        var help = document.getElementById('help-overlay');
        if (help) {
            help.style.display = help.style.display === 'none' ? 'block' : 'none';
        } else {
            _buildHelpOverlay();
        }
    }

    function _buildHelpOverlay() {
        var help = document.createElement('div');
        help.id = 'help-overlay';
        help.style.cssText = 'position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); background:#2a2a3e; padding:30px; border-radius:8px; color:#fff; font-family:monospace; font-size:12px; max-width:500px; border:2px solid #0099FF;';

        var html = '<h2 style="color:#0099FF; margin-top:0;">HELP</h2>';
        html += '<div style="max-height:400px; overflow-y:auto;">';
        html += '<h3 style="color:#00FF00;">Orbit Camera:</h3>';
        html += '<p>Arrow Keys = Rotate | Scroll = Zoom | Middle Drag = Pan</p>';
        html += '<h3 style="color:#00FF00;">Free Fly Camera:</h3>';
        html += '<p>WASD = Move | QE = Up/Down | Shift = Speed</p>';
        html += '<p>Right Drag = Look Around</p>';
        html += '<h3 style="color:#00FF00;">Tools:</h3>';
        html += '<p>Wall = Draw walls (0)</p>';
        html += '<p>Open = Create open space (1)</p>';
        html += '<p>Light = Toggle light at cell</p>';
        html += '<p>Spawn = Set spawn point</p>';
        html += '<p>Chair = Place chair prop</p>';
        html += '<p>Eraser = Remove wall/light/prop</p>';
        html += '<h3 style="color:#00FF00;">General:</h3>';
        html += '<p>Tab = Toggle camera mode</p>';
        html += '<p>H = Toggle help</p>';
        html += '<p>Click/Drag = Paint (Wall, Open)</p>';
        html += '<p>Single Click = Place (Light, Spawn, Chair)</p>';
        html += '</div>';
        html += '<button id="help-close" style="margin-top:15px; width:100%; padding:8px; background:#0099FF; color:#fff; border:none; border-radius:4px; cursor:pointer;">Close</button>';

        help.innerHTML = html;
        document.body.appendChild(help);

        document.getElementById('help-close').addEventListener('click', function() {
            help.style.display = 'none';
        });
    }

    function _onWindowResize() {
        _camera.aspect = window.innerWidth / window.innerHeight;
        _camera.updateProjectionMatrix();
        _renderer.setSize(window.innerWidth, window.innerHeight);
    }

    // ===== ANIMATION LOOP =====
    function _animate() {
        requestAnimationFrame(_animate);
        var now = performance.now();
        var dt = Math.min((now - _lastTime) / 1000, 0.05);
        _lastTime = now;

        _updateCamera(dt);
        _renderer.render(_scene, _camera);
    }

    return api;
})();

// Initialize on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
        MapEditor.init();
    });
} else {
    MapEditor.init();
}
