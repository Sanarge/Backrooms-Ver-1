/* ========================================
   Lobby System
   Name entry, lobby browser, chat panel,
   and lobby creation dialog.
   ======================================== */

const Lobby = (() => {

    // --- State ---
    let currentLobbyId = null;
    let isHost = false;
    let playerName = '';
    let lobbies = [];    // latest lobby list from server
    let chatMessages = []; // { name, message, timestamp }

    // --- Server address (loaded dynamically from server_config.json) ---
    let SERVER_ADDRESS = null;

    // --- DOM refs (populated on init) ---
    let nameInput = null;
    let nameArrow = null;
    // serverInput removed — address is hardcoded
    let lobbyScreen = null;
    let lobbyPlayerList = null;
    let lobbyBrowser = null;
    let chatPanel = null;
    let chatInput = null;
    let chatSendBtn = null;
    let chatMessagesEl = null;
    let createBtn = null;
    let createDialog = null;
    let createDialogInput = null;
    let createDialogConfirm = null;
    let createDialogBack = null;
    let startGameBtn = null;
    let leaveLobbyBtn = null;
    let lobbyTitle = null;
    let connectionStatus = null;

    // =========================================
    //  INIT
    // =========================================

    async function init() {
        // Determine server address:
        // If served from the Pi (HTTP), connect WebSocket to same host
        // If served from GitHub Pages (HTTPS), load from server_config.json
        if (window.location.protocol === 'http:') {
            // Served from the Pi — WebSocket on same host, port 7778
            SERVER_ADDRESS = 'ws://' + window.location.hostname + ':7778';
            console.log('Server address (same host):', SERVER_ADDRESS);
        } else {
            // Served from HTTPS (GitHub Pages) — try config file
            try {
                const resp = await fetch('server_config.json?t=' + Date.now());
                const config = await resp.json();
                SERVER_ADDRESS = config.address;
                console.log('Server address loaded:', SERVER_ADDRESS);
            } catch (e) {
                console.warn('Could not load server_config.json, using fallback');
                SERVER_ADDRESS = 'ws://136.36.187.132:7778';
            }
        }

        // Cache DOM elements
        nameInput       = document.getElementById('name-input');
        nameArrow       = document.getElementById('name-arrow');
        // serverInput removed — address is hardcoded
        lobbyScreen     = document.getElementById('lobby-screen');
        lobbyPlayerList = document.getElementById('lobby-player-list');
        lobbyBrowser    = document.getElementById('lobby-browser-list');
        chatPanel       = document.getElementById('chat-messages');
        chatInput       = document.getElementById('chat-input');
        chatSendBtn     = document.getElementById('chat-send');
        chatMessagesEl  = document.getElementById('chat-messages');
        createBtn       = document.getElementById('btn-create-lobby');
        createDialog    = document.getElementById('create-lobby-dialog');
        createDialogInput   = document.getElementById('create-lobby-name');
        createDialogConfirm = document.getElementById('create-lobby-confirm');
        createDialogBack    = document.getElementById('create-lobby-back');
        startGameBtn    = document.getElementById('btn-start-game');
        leaveLobbyBtn   = document.getElementById('btn-leave-lobby');
        lobbyTitle      = document.getElementById('lobby-title');
        connectionStatus = document.getElementById('connection-status');

        _bindEvents();
        _bindNetworkHandlers();
    }

    function _bindEvents() {
        // Name entry arrow button
        if (nameArrow) {
            nameArrow.addEventListener('click', _onNameSubmit);
        }
        if (nameInput) {
            nameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') _onNameSubmit();
            });
        }

        // Chat
        if (chatSendBtn) {
            chatSendBtn.addEventListener('click', _onChatSend);
        }
        if (chatInput) {
            chatInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') _onChatSend();
            });
        }

        // Create lobby
        if (createBtn) {
            createBtn.addEventListener('click', _showCreateDialog);
        }
        if (createDialogConfirm) {
            createDialogConfirm.addEventListener('click', _onCreateLobby);
        }
        if (createDialogBack) {
            createDialogBack.addEventListener('click', _hideCreateDialog);
        }

        // Start game (host only)
        if (startGameBtn) {
            startGameBtn.addEventListener('click', _onStartGame);
        }

        // Leave lobby
        if (leaveLobbyBtn) {
            leaveLobbyBtn.addEventListener('click', _onLeaveLobby);
        }
    }

    function _bindNetworkHandlers() {
        Network.on('connected', () => {
            if (connectionStatus) connectionStatus.textContent = 'Connected';
            if (connectionStatus) connectionStatus.className = 'status-connected';
        });

        Network.on('disconnected', () => {
            if (connectionStatus) connectionStatus.textContent = 'Disconnected';
            if (connectionStatus) connectionStatus.className = 'status-disconnected';
        });

        Network.on('error', (data) => {
            _addSystemMessage('Error: ' + (data.message || 'Unknown error'));
        });

        Network.on('lobby_joined', (data) => {
            // Server confirmed we joined/created a lobby
            currentLobbyId = data.lobby_id;
            console.log('[Lobby] Joined lobby:', data.lobby_name, '(' + data.lobby_id + ')');
            _addSystemMessage('Joined ' + data.lobby_name);
        });

        Network.on('lobby_list', (data) => {
            lobbies = data.lobbies || [];
            _renderLobbyBrowser();
            _renderPlayerList();
        });

        Network.on('game_state', (data) => {
            // Game is starting — transition to game screen
            if (data && data.data) {
                _onGameStart(data);
            }
        });

        Network.on('chat', (data) => {
            if (data.name && data.message) {
                _addChatMessage(data.name, data.message);
            }
        });
    }

    // =========================================
    //  NAME ENTRY
    // =========================================

    function _onNameSubmit() {
        const name = nameInput ? nameInput.value.trim() : '';
        if (name.length < 1) {
            nameInput.classList.add('shake');
            setTimeout(() => nameInput.classList.remove('shake'), 400);
            return;
        }

        playerName = name.substring(0, 20);

        if (!SERVER_ADDRESS) {
            console.error('Server address not loaded yet');
            return;
        }

        // Connect to server
        Network.connect(SERVER_ADDRESS, playerName);

        // Transition to lobby screen
        Menu.showScreen('lobby');
    }

    // =========================================
    //  LOBBY BROWSER
    // =========================================

    function _renderLobbyBrowser() {
        if (!lobbyBrowser) return;
        lobbyBrowser.innerHTML = '';

        if (lobbies.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'lobby-empty-msg';
            empty.textContent = 'No lobbies found. Create one!';
            lobbyBrowser.appendChild(empty);
            return;
        }

        for (const lobby of lobbies) {
            const row = document.createElement('div');
            row.className = 'lobby-row';
            if (lobby.id === currentLobbyId) row.classList.add('current');

            // Host indicator (green dot) + lobby name
            const nameSpan = document.createElement('span');
            nameSpan.className = 'lobby-row-name';
            nameSpan.innerHTML = '<span class="host-dot"></span> ' + _escapeHtml(lobby.name);

            // Player count
            const countSpan = document.createElement('span');
            countSpan.className = 'lobby-row-count';
            countSpan.textContent = lobby.player_count + '/' + lobby.max_players;

            // Join button — allow joining even if game is in progress
            const joinBtn = document.createElement('button');
            joinBtn.className = 'lobby-join-btn';
            joinBtn.textContent = 'Join';
            joinBtn.disabled = lobby.player_count >= lobby.max_players || lobby.id === currentLobbyId;

            if (lobby.id === currentLobbyId) {
                joinBtn.textContent = 'Joined';
            } else if (lobby.player_count >= lobby.max_players) {
                joinBtn.textContent = 'Full';
            } else if (lobby.state === 'playing') {
                joinBtn.textContent = 'Join Game';
            }

            joinBtn.addEventListener('click', () => {
                Network.joinLobby(lobby.id);
                // currentLobbyId is set when server sends lobby_joined confirmation
            });

            // Expandable player list
            const expandBtn = document.createElement('button');
            expandBtn.className = 'lobby-expand-btn';
            expandBtn.textContent = '\u25BC';
            expandBtn.addEventListener('click', () => {
                const detail = row.querySelector('.lobby-detail');
                if (detail) {
                    detail.classList.toggle('expanded');
                    expandBtn.textContent = detail.classList.contains('expanded') ? '\u25B2' : '\u25BC';
                }
            });

            const topRow = document.createElement('div');
            topRow.className = 'lobby-row-top';
            topRow.appendChild(nameSpan);
            topRow.appendChild(countSpan);
            topRow.appendChild(joinBtn);
            topRow.appendChild(expandBtn);

            // Detail section (player names)
            const detail = document.createElement('div');
            detail.className = 'lobby-detail';
            if (lobby.players) {
                for (const p of lobby.players) {
                    const pEl = document.createElement('div');
                    pEl.className = 'lobby-detail-player';
                    const isLobbyHost = (lobby.host_name === p.name);
                    pEl.innerHTML = (isLobbyHost ? '<span class="host-crown">&#9733;</span> ' : '') + _escapeHtml(p.name);
                    detail.appendChild(pEl);
                }
            }

            row.appendChild(topRow);
            row.appendChild(detail);
            lobbyBrowser.appendChild(row);
        }
    }

    // =========================================
    //  PLAYER LIST (current lobby)
    // =========================================

    function _renderPlayerList() {
        if (!lobbyPlayerList) return;
        lobbyPlayerList.innerHTML = '';

        // Find the current lobby
        const myLobby = lobbies.find(l => l.id === currentLobbyId);
        if (!myLobby || !myLobby.players) {
            lobbyPlayerList.innerHTML = '<div class="lobby-no-lobby">Not in a lobby</div>';
            if (startGameBtn) startGameBtn.style.display = 'none';
            if (leaveLobbyBtn) leaveLobbyBtn.style.display = 'none';
            if (lobbyTitle) lobbyTitle.textContent = 'Lobby';
            return;
        }

        if (lobbyTitle) lobbyTitle.textContent = myLobby.name;

        // Check if we are host
        isHost = (myLobby.host_name === playerName);
        if (startGameBtn) startGameBtn.style.display = isHost ? '' : 'none';
        if (leaveLobbyBtn) leaveLobbyBtn.style.display = '';

        for (const p of myLobby.players) {
            const el = document.createElement('div');
            el.className = 'lobby-player-entry';
            const isLobbyHost = (myLobby.host_name === p.name);
            el.innerHTML = (isLobbyHost ? '<span class="host-indicator"></span>' : '<span class="player-indicator"></span>') +
                '<span class="player-name-text">' + _escapeHtml(p.name) + '</span>';
            lobbyPlayerList.appendChild(el);
        }
    }

    // =========================================
    //  CHAT
    // =========================================

    function _onChatSend() {
        if (!chatInput) return;
        const msg = chatInput.value.trim();
        if (msg.length === 0) return;

        Network.sendChat(msg);
        _addChatMessage(playerName, msg);
        chatInput.value = '';
    }

    function _addChatMessage(name, message) {
        chatMessages.push({ name, message, timestamp: Date.now() });
        if (chatMessages.length > 100) chatMessages.shift();

        if (!chatMessagesEl) return;
        const el = document.createElement('div');
        el.className = 'chat-msg';
        el.innerHTML = '<span class="chat-name">' + _escapeHtml(name) + ':</span> ' + _escapeHtml(message);
        chatMessagesEl.appendChild(el);
        chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    }

    function _addSystemMessage(message) {
        if (!chatMessagesEl) return;
        const el = document.createElement('div');
        el.className = 'chat-msg chat-system';
        el.textContent = message;
        chatMessagesEl.appendChild(el);
        chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    }

    // =========================================
    //  CREATE LOBBY
    // =========================================

    function _showCreateDialog() {
        if (createDialog) {
            createDialog.classList.add('active');
            if (createDialogInput) {
                createDialogInput.value = playerName + "'s Lobby";
                createDialogInput.select();
            }
        }
    }

    function _hideCreateDialog() {
        if (createDialog) createDialog.classList.remove('active');
    }

    function _onCreateLobby() {
        const name = createDialogInput ? createDialogInput.value.trim() : '';
        Network.createLobby(name || undefined);
        _hideCreateDialog();
        // currentLobbyId is set when server sends lobby_joined confirmation
        _addSystemMessage('Creating lobby...');
    }

    // =========================================
    //  GAME START
    // =========================================

    function _onStartGame() {
        if (!currentLobbyId || !isHost) return;
        Network.startGame(currentLobbyId);
        _addSystemMessage('Starting game...');
    }

    function _onGameStart(data) {
        // Transition to game — Menu handles screen switching
        Menu.showScreen('loading');
        AudioManager.startAmbientHum();

        // Load the level and start
        const levelNum = 0; // Default level for multiplayer
        Menu._loadAndStartMultiplayer(levelNum, data);
    }

    // =========================================
    //  LEAVE LOBBY
    // =========================================

    function _onLeaveLobby() {
        Network.leaveLobby();
        currentLobbyId = null;
        isHost = false;
        _renderPlayerList();
        _addSystemMessage('Left lobby');
    }

    // =========================================
    //  UTILS
    // =========================================

    function _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function getCurrentLobbyId() { return currentLobbyId; }
    function setCurrentLobbyId(id) { currentLobbyId = id; }
    function getIsHost() { return isHost; }
    function getPlayerName() { return playerName; }

    return {
        init,
        getCurrentLobbyId,
        setCurrentLobbyId,
        getIsHost,
        getPlayerName,
    };
})();
