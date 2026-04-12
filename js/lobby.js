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
    let expandedLobbies = new Set(); // track which lobby rows are expanded
    let waitingPlayers = []; // players not in any lobby
    let inGame = false; // true once we've transitioned to the game screen

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
            _addSystemMessage('Welcome, ' + playerName + '! Say hello to everyone.');
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
            waitingPlayers = data.waiting_players || [];
            _renderLobbyBrowser();
            _renderLeftPanel();
        });

        Network.on('game_state', (data) => {
            // Game is starting — transition to game screen (ONLY ONCE)
            if (data && data.data && !inGame) {
                inGame = true;
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

            const isExpanded = expandedLobbies.has(lobby.id);

            // Host indicator (green dot) + lobby name + state badge
            const nameSpan = document.createElement('span');
            nameSpan.className = 'lobby-row-name';
            let stateTag = '';
            if (lobby.state === 'playing') {
                stateTag = ' <span class="lobby-state-badge playing">IN GAME</span>';
            }
            nameSpan.innerHTML = '<span class="host-dot"></span> ' + _escapeHtml(lobby.name) + stateTag;

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
                joinBtn.textContent = 'Join';
            }

            joinBtn.addEventListener('click', () => {
                Network.joinLobby(lobby.id);
            });

            // Expandable player list — preserve expanded state
            const expandBtn = document.createElement('button');
            expandBtn.className = 'lobby-expand-btn';
            expandBtn.textContent = isExpanded ? '\u25B2' : '\u25BC';
            expandBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (expandedLobbies.has(lobby.id)) {
                    expandedLobbies.delete(lobby.id);
                } else {
                    expandedLobbies.add(lobby.id);
                }
                _renderLobbyBrowser(); // re-render with new expanded state
            });

            const topRow = document.createElement('div');
            topRow.className = 'lobby-row-top';
            topRow.appendChild(nameSpan);
            topRow.appendChild(countSpan);
            topRow.appendChild(joinBtn);
            topRow.appendChild(expandBtn);

            // Detail section (player names) — show if expanded
            const detail = document.createElement('div');
            detail.className = 'lobby-detail' + (isExpanded ? ' expanded' : '');
            if (lobby.players && lobby.players.length > 0) {
                for (const p of lobby.players) {
                    const pEl = document.createElement('div');
                    pEl.className = 'lobby-detail-player';
                    const isLobbyHost = (lobby.host_name === p.name);
                    pEl.innerHTML = (isLobbyHost ? '<span class="host-crown">&#9733;</span> ' : '<span class="player-dot-small"></span> ') + _escapeHtml(p.name);
                    detail.appendChild(pEl);
                }
            } else {
                const emptyEl = document.createElement('div');
                emptyEl.className = 'lobby-detail-player';
                emptyEl.textContent = 'No players';
                detail.appendChild(emptyEl);
            }

            row.appendChild(topRow);
            row.appendChild(detail);
            lobbyBrowser.appendChild(row);
        }
    }

    // =========================================
    //  LEFT PANEL — lobby members or waiting players
    // =========================================

    function _renderLeftPanel() {
        if (!lobbyPlayerList) return;
        lobbyPlayerList.innerHTML = '';

        // Find the current lobby
        const myLobby = lobbies.find(l => l.id === currentLobbyId);

        if (!myLobby || !myLobby.players) {
            // NOT in a lobby — show waiting room
            if (lobbyTitle) lobbyTitle.textContent = 'Waiting for Lobby';

            if (waitingPlayers.length === 0) {
                lobbyPlayerList.innerHTML = '<div class="lobby-no-lobby">No other players online</div>';
            } else {
                for (const p of waitingPlayers) {
                    const el = document.createElement('div');
                    el.className = 'lobby-player-entry';
                    const isSelf = (p.name === playerName);
                    // Green glow for yourself, gray for others
                    const indicator = isSelf ? '<span class="self-indicator"></span>' : '<span class="player-indicator"></span>';
                    el.innerHTML = indicator +
                        '<span class="player-name-text">' + _escapeHtml(p.name) + (isSelf ? ' (you)' : '') + '</span>';
                    lobbyPlayerList.appendChild(el);
                }
            }

            // Update center buttons: show Create Lobby / Back to Menu
            _updateCenterButtons(null);
            return;
        }

        // IN a lobby — show lobby members
        if (lobbyTitle) lobbyTitle.textContent = myLobby.name;

        // Check if we are host
        isHost = (myLobby.host_name === playerName);

        for (const p of myLobby.players) {
            const el = document.createElement('div');
            el.className = 'lobby-player-entry';
            const isSelf = (p.name === playerName);
            const isLobbyHost = (myLobby.host_name === p.name);
            // Green glow for yourself, gray for others
            let indicator;
            if (isSelf) {
                indicator = '<span class="self-indicator"></span>';
            } else if (isLobbyHost) {
                indicator = '<span class="host-indicator"></span>';
            } else {
                indicator = '<span class="player-indicator"></span>';
            }
            el.innerHTML = indicator +
                '<span class="player-name-text">' + _escapeHtml(p.name) + (isSelf ? ' (you)' : '') + '</span>';
            lobbyPlayerList.appendChild(el);
        }

        // If game is in progress, show "Join Game" button in the left panel
        if (myLobby.state === 'playing') {
            const joinGameBtn = document.createElement('button');
            joinGameBtn.className = 'menu-btn lobby-action-btn';
            joinGameBtn.textContent = 'Join Game';
            joinGameBtn.style.marginTop = '0.5rem';
            joinGameBtn.addEventListener('click', () => {
                Network.send({ type: 'join_game', lobby_id: currentLobbyId });
            });
            lobbyPlayerList.appendChild(joinGameBtn);
        }

        // Update center buttons: show Start Game / Leave Lobby
        _updateCenterButtons(myLobby);
    }

    function _updateCenterButtons(myLobby) {
        const createBtn_el = document.getElementById('btn-create-lobby');
        const backBtn_el = document.getElementById('btn-lobby-back');

        if (!myLobby) {
            // Not in a lobby — show Create Lobby / Back to Menu
            if (createBtn_el) createBtn_el.style.display = '';
            if (backBtn_el) backBtn_el.style.display = '';
            if (startGameBtn) startGameBtn.style.display = 'none';
            if (leaveLobbyBtn) leaveLobbyBtn.style.display = 'none';
        } else {
            // In a lobby — hide Create/Back, show Start Game (host only) / Leave Lobby
            if (createBtn_el) createBtn_el.style.display = 'none';
            if (backBtn_el) backBtn_el.style.display = 'none';
            if (startGameBtn) {
                startGameBtn.style.display = (isHost && myLobby.state === 'waiting') ? '' : 'none';
            }
            if (leaveLobbyBtn) leaveLobbyBtn.style.display = '';
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
        inGame = false;
        _renderLeftPanel();
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
