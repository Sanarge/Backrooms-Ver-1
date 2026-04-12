/* ========================================
   Network Layer
   WebSocket connection to multiplayer server.
   Handles connect, disconnect, message routing,
   and auto-reconnect.
   ======================================== */

const Network = (() => {
    let ws = null;
    let serverUrl = '';
    let isConnected = false;
    let reconnectAttempts = 0;
    const MAX_RECONNECT = 5;
    const RECONNECT_DELAY = 2000; // ms
    let reconnectTimer = null;

    // Message handlers keyed by type
    const handlers = {};

    // Queued messages to send once connected
    const sendQueue = [];

    // Player name (set before connect)
    let playerName = '';

    /**
     * Register a handler for a specific message type.
     * @param {string} type
     * @param {Function} callback — called with (data)
     */
    function on(type, callback) {
        if (!handlers[type]) handlers[type] = [];
        handlers[type].push(callback);
    }

    /**
     * Remove all handlers for a message type.
     * @param {string} type
     */
    function off(type) {
        delete handlers[type];
    }

    /**
     * Emit to local handlers (internal).
     */
    function _emit(type, data) {
        const list = handlers[type];
        if (list) {
            for (const fn of list) {
                try { fn(data); } catch (e) { console.error('[Network] Handler error:', e); }
            }
        }
    }

    /**
     * Connect to the game server.
     * @param {string} url — WebSocket URL, e.g. "ws://192.168.1.100:77788"
     * @param {string} name — player display name
     */
    function connect(url, name) {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            return; // already connected/connecting
        }

        serverUrl = url;
        playerName = name;
        reconnectAttempts = 0;

        _createConnection();
    }

    function _createConnection() {
        try {
            ws = new WebSocket(serverUrl);
        } catch (e) {
            console.error('[Network] Failed to create WebSocket:', e);
            _emit('error', { message: 'Failed to connect to server' });
            return;
        }

        ws.onopen = () => {
            isConnected = true;
            reconnectAttempts = 0;
            console.log('[Network] Connected to', serverUrl);

            // Send name registration
            send({ type: 'set_name', name: playerName });

            // Flush queued messages
            while (sendQueue.length > 0) {
                const msg = sendQueue.shift();
                _rawSend(msg);
            }

            _emit('connected', {});
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                const type = data.type;
                if (type) {
                    _emit(type, data);
                }
            } catch (e) {
                console.warn('[Network] Invalid message:', e);
            }
        };

        ws.onclose = (event) => {
            const wasConnected = isConnected;
            isConnected = false;
            ws = null;
            console.log('[Network] Disconnected', event.code, event.reason);

            _emit('disconnected', { code: event.code, reason: event.reason });

            // Auto-reconnect if was previously connected
            if (wasConnected && reconnectAttempts < MAX_RECONNECT) {
                reconnectAttempts++;
                console.log(`[Network] Reconnecting (${reconnectAttempts}/${MAX_RECONNECT})...`);
                reconnectTimer = setTimeout(() => {
                    _createConnection();
                }, RECONNECT_DELAY);
            }
        };

        ws.onerror = (error) => {
            console.error('[Network] WebSocket error:', error);
            _emit('error', { message: 'Connection error' });
        };
    }

    /**
     * Send a message object to the server.
     * Queues if not yet connected.
     * @param {object} data
     */
    function send(data) {
        if (isConnected && ws && ws.readyState === WebSocket.OPEN) {
            _rawSend(data);
        } else {
            sendQueue.push(data);
        }
    }

    function _rawSend(data) {
        try {
            ws.send(JSON.stringify(data));
        } catch (e) {
            console.error('[Network] Send error:', e);
        }
    }

    /**
     * Disconnect from the server.
     */
    function disconnect() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        reconnectAttempts = MAX_RECONNECT; // prevent auto-reconnect
        if (ws) {
            ws.close(1000, 'Client disconnect');
            ws = null;
        }
        isConnected = false;
        sendQueue.length = 0;
    }

    /**
     * Send player input to server (called every frame during gameplay).
     * @param {object} keys — { forward, backward, left, right, sprint, crouch }
     * @param {object} mouse — { yaw, pitch }
     */
    function sendInput(keys, mouse) {
        if (!isConnected) return;
        send({
            type: 'player_input',
            keys: keys,
            mouse: mouse,
        });
    }

    /**
     * Send a chat message.
     * @param {string} message
     */
    function sendChat(message) {
        send({ type: 'chat', message: message });
    }

    /**
     * Request to create a lobby.
     * @param {string} [lobbyName]
     */
    function createLobby(lobbyName) {
        send({ type: 'create_lobby', name: lobbyName || undefined });
    }

    /**
     * Request to join a lobby.
     * @param {string} lobbyId
     */
    function joinLobby(lobbyId) {
        send({ type: 'join_lobby', lobby_id: lobbyId });
    }

    /**
     * Leave the current lobby.
     */
    function leaveLobby() {
        send({ type: 'leave_lobby' });
    }

    /**
     * Request to start the game (host only).
     * @param {string} lobbyId
     */
    function startGame(lobbyId) {
        send({ type: 'start_game', lobby_id: lobbyId });
    }

    /**
     * Request fresh lobby list.
     */
    function requestLobbies() {
        send({ type: 'list_lobbies' });
    }

    function getIsConnected() { return isConnected; }
    function getPlayerName() { return playerName; }

    return {
        on,
        off,
        connect,
        disconnect,
        send,
        sendInput,
        sendChat,
        createLobby,
        joinLobby,
        leaveLobby,
        startGame,
        requestLobbies,
        getIsConnected,
        getPlayerName,
    };
})();
