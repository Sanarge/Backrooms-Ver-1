"""
Backrooms Game WebSocket Server — Raspberry Pi 5 Edition

Full ncurses terminal application with:
- Interactive panes (system stats, player list, event log)
- Keyboard shortcuts to switch views
- Per-player log files in ~/Desktop/logs/
- IP-based tracking from first connection through all actions

Log format: [IP]_[Name]_[Date].log
Action format in logs: [HH:MM:SS] [IP] [Name] [Action]
"""

import asyncio
import curses
import json
import mimetypes
import os
import re
import resource
import sys
import threading
import urllib.request
from collections import deque
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Dict, List, Optional

import psutil
import websockets

try:
    import miniupnpc
    HAS_UPNP = True
except ImportError:
    HAS_UPNP = False

from lobby_manager import LobbyManager, Player
from game_session import GameSession


# =============================================
#  PLAYER LOGGER — per-player log files
# =============================================

class PlayerLogger:
    """
    Manages per-player log files in ~/Desktop/logs/.
    Each player gets a file named [IP]_[Name]_[Date].log
    that updates in real time.
    """

    def __init__(self):
        self.log_dir = Path.home() / "Desktop" / "logs"
        self.log_dir.mkdir(parents=True, exist_ok=True)

        # Track open file handles: client_id -> file handle
        self.open_files: Dict[str, object] = {}
        # Track client_id -> (ip, name) mapping
        self.client_info: Dict[str, tuple] = {}

    def _sanitize(self, text: str) -> str:
        """Remove characters that aren't safe for filenames."""
        return re.sub(r'[^\w\-.]', '_', text)

    def _get_timestamp(self) -> str:
        return datetime.now().strftime("%H:%M:%S")

    def _get_date(self) -> str:
        return datetime.now().strftime("%Y-%m-%d")

    def register_connection(self, client_id: str, ip: str):
        """
        Called when a client first connects (before they set a name).
        Creates an initial tracking entry.
        """
        self.client_info[client_id] = (ip, None)

    def register_name(self, client_id: str, name: str):
        """
        Called when a client sets their name. Creates the log file
        and writes the initial login entry.
        """
        if client_id not in self.client_info:
            return

        ip, _ = self.client_info[client_id]
        self.client_info[client_id] = (ip, name)

        # Build filename: [IP]_[Name]_[Date].log
        safe_ip = self._sanitize(ip)
        safe_name = self._sanitize(name)
        date_str = self._get_date()
        filename = f"{safe_ip}_{safe_name}_{date_str}.log"
        filepath = self.log_dir / filename

        # Open the file in append mode
        try:
            fh = open(filepath, "a", buffering=1)  # line-buffered for real-time
            self.open_files[client_id] = fh

            # Write header
            ts = self._get_timestamp()
            fh.write(f"{'=' * 50}\n")
            fh.write(f"  Player Log: {name}\n")
            fh.write(f"  IP Address: {ip}\n")
            fh.write(f"  Session Start: {date_str} {ts}\n")
            fh.write(f"{'=' * 50}\n\n")
            fh.write(f"[{ts}] [{ip}] [{name}] Connected\n")
            fh.flush()
        except Exception as e:
            pass  # Can't write log, continue silently

    def log_action(self, client_id: str, action: str):
        """
        Log an action for a player. Format: [HH:MM:SS] [IP] [Name] [Action]
        """
        if client_id not in self.client_info:
            return

        ip, name = self.client_info[client_id]
        if not name:
            name = "Unknown"

        ts = self._get_timestamp()
        line = f"[{ts}] [{ip}] [{name}] {action}\n"

        fh = self.open_files.get(client_id)
        if fh:
            try:
                fh.write(line)
                fh.flush()
            except Exception:
                pass

    def close_player(self, client_id: str):
        """Close a player's log file."""
        fh = self.open_files.pop(client_id, None)
        if fh:
            try:
                ip, name = self.client_info.get(client_id, ("?", "?"))
                ts = self._get_timestamp()
                fh.write(f"[{ts}] [{ip}] [{name}] Session ended\n")
                fh.write(f"\n{'=' * 50}\n")
                fh.flush()
                fh.close()
            except Exception:
                pass
        self.client_info.pop(client_id, None)

    def close_all(self):
        """Close all open log files."""
        for client_id in list(self.open_files.keys()):
            self.close_player(client_id)


# =============================================
#  CURSES TUI
# =============================================

class ServerTUI:
    """
    Full ncurses terminal UI with multiple panes:
    - Header: server title, status, address
    - Left pane: system stats (CPU, RAM, connections)
    - Center pane: event log (scrollable)
    - Right pane: connected players list
    - Bottom: keyboard shortcuts help bar
    """

    # Color pair IDs
    C_TITLE = 1
    C_GREEN = 2
    C_RED = 3
    C_BLUE = 4
    C_YELLOW = 5
    C_DIM = 6
    C_BAR_FILL = 7
    C_BAR_EMPTY = 8
    C_HIGHLIGHT = 9

    def __init__(self, stdscr):
        self.stdscr = stdscr
        self.setup_colors()
        curses.curs_set(0)          # hide cursor
        self.stdscr.nodelay(True)   # non-blocking getch
        self.stdscr.timeout(200)    # refresh every 200ms

        # Flush any stale input from terminal
        curses.flushinp()

        # Scroll offset for event log
        self.log_scroll = 0
        self.max_log_scroll = 0

        # Active pane for scrolling: 0=log, 1=players
        self.active_pane = 0

    def setup_colors(self):
        curses.start_color()
        curses.use_default_colors()
        curses.init_pair(self.C_TITLE,     curses.COLOR_BLACK, curses.COLOR_GREEN)
        curses.init_pair(self.C_GREEN,     curses.COLOR_GREEN, -1)
        curses.init_pair(self.C_RED,       curses.COLOR_RED, -1)
        curses.init_pair(self.C_BLUE,      curses.COLOR_CYAN, -1)
        curses.init_pair(self.C_YELLOW,    curses.COLOR_YELLOW, -1)
        curses.init_pair(self.C_DIM,       8, -1)  # bright black = gray
        curses.init_pair(self.C_BAR_FILL,  curses.COLOR_GREEN, curses.COLOR_GREEN)
        curses.init_pair(self.C_BAR_EMPTY, 8, -1)
        curses.init_pair(self.C_HIGHLIGHT, curses.COLOR_BLACK, curses.COLOR_CYAN)

    def draw(self, server):
        """Redraw the entire TUI."""
        try:
            self.stdscr.erase()
            h, w = self.stdscr.getmaxyx()

            if h < 15 or w < 60:
                self.stdscr.addstr(0, 0, "Terminal too small. Resize to at least 60x15.")
                self.stdscr.refresh()
                return

            # === HEADER (2 lines) ===
            self._draw_header(w, server)

            # === MAIN AREA (split into 3 columns) ===
            main_top = 3
            main_height = h - 5   # leave room for bottom bar
            left_width = max(22, w // 5)
            right_width = max(24, w // 4)
            center_width = w - left_width - right_width - 2  # 2 for borders

            # Left pane: System stats
            self._draw_stats_pane(main_top, 0, left_width, main_height, server)

            # Center pane: Event log
            self._draw_log_pane(main_top, left_width + 1, center_width, main_height, server)

            # Right pane: Connected players
            self._draw_players_pane(main_top, left_width + center_width + 2, right_width, main_height, server)

            # === BOTTOM BAR ===
            self._draw_bottom_bar(h - 1, w, server)

            self.stdscr.refresh()
        except curses.error:
            pass  # Terminal resize mid-draw, ignore

    def _safe_addstr(self, y, x, text, attr=0):
        """Write string, clipping to avoid curses errors."""
        h, w = self.stdscr.getmaxyx()
        if y < 0 or y >= h or x >= w:
            return
        max_len = w - x - 1
        if max_len <= 0:
            return
        try:
            self.stdscr.addnstr(y, x, text, max_len, attr)
        except curses.error:
            pass

    # --- HEADER ---

    def _draw_header(self, w, server):
        title = " BACKROOMS GAME SERVER — RASPBERRY PI 5 "
        # Center the title
        pad = max(0, (w - len(title)) // 2)
        full_line = " " * pad + title + " " * (w - pad - len(title))
        self._safe_addstr(0, 0, full_line, curses.color_pair(self.C_TITLE) | curses.A_BOLD)

        status = "RUNNING" if server.running else "STOPPED"
        status_color = curses.color_pair(self.C_GREEN) if server.running else curses.color_pair(self.C_RED)
        self._safe_addstr(1, 1, "Status: ", curses.color_pair(self.C_BLUE))
        self._safe_addstr(1, 9, status, status_color | curses.A_BOLD)

        if server.public_ip:
            addr = f"http://{server.public_ip}:{server.HTTP_PORT}"
        else:
            addr = f"http://0.0.0.0:{server.HTTP_PORT}"
        self._safe_addstr(1, 9 + len(status) + 3, "Game URL: ", curses.color_pair(self.C_BLUE))
        self._safe_addstr(1, 9 + len(status) + 13, addr, curses.color_pair(self.C_YELLOW))

        uptime = ""
        if server.start_time:
            delta = datetime.now() - server.start_time
            mins = int(delta.total_seconds() // 60)
            secs = int(delta.total_seconds() % 60)
            uptime = f"Uptime: {mins}m {secs}s"
        self._safe_addstr(1, max(0, w - len(uptime) - 2), uptime, curses.color_pair(self.C_DIM))

        # Separator
        self._safe_addstr(2, 0, "─" * w, curses.color_pair(self.C_DIM))

    # --- LEFT PANE: System Stats ---

    def _draw_stats_pane(self, top, left, width, height, server):
        # Border
        for row in range(top, top + height):
            self._safe_addstr(row, left + width, "│", curses.color_pair(self.C_DIM))

        self._safe_addstr(top, left + 1, "SYSTEM", curses.color_pair(self.C_BLUE) | curses.A_BOLD)
        self._safe_addstr(top + 1, left + 1, "─" * (width - 2), curses.color_pair(self.C_DIM))

        y = top + 3

        # CPU bar
        self._safe_addstr(y, left + 1, "CPU", curses.color_pair(self.C_YELLOW))
        y += 1
        self._draw_bar(y, left + 1, width - 3, server.cpu_percent)
        y += 2

        # RAM bar
        self._safe_addstr(y, left + 1, "RAM", curses.color_pair(self.C_YELLOW))
        y += 1
        self._draw_bar(y, left + 1, width - 3, server.ram_percent)
        y += 2

        # Separator
        self._safe_addstr(y, left + 1, "─" * (width - 2), curses.color_pair(self.C_DIM))
        y += 1

        # Stats
        self._safe_addstr(y, left + 1, "CONNECTIONS", curses.color_pair(self.C_BLUE) | curses.A_BOLD)
        y += 1
        self._safe_addstr(y, left + 1, "─" * (width - 2), curses.color_pair(self.C_DIM))
        y += 1

        stats = [
            ("Players", str(server.connected_players)),
            ("Lobbies", str(server.active_lobbies)),
            ("Games", str(len(server.active_games))),
        ]

        for label, val in stats:
            if y >= top + height:
                break
            self._safe_addstr(y, left + 2, label, curses.color_pair(self.C_DIM))
            self._safe_addstr(y, left + width - len(val) - 2, val, curses.color_pair(self.C_GREEN) | curses.A_BOLD)
            y += 1

        # Log file count
        y += 1
        if y < top + height:
            self._safe_addstr(y, left + 1, "─" * (width - 2), curses.color_pair(self.C_DIM))
            y += 1
        if y < top + height:
            self._safe_addstr(y, left + 1, "LOG FILES", curses.color_pair(self.C_BLUE) | curses.A_BOLD)
            y += 1
        if y < top + height:
            log_count = str(len(server.player_logger.open_files))
            self._safe_addstr(y, left + 2, "Active", curses.color_pair(self.C_DIM))
            self._safe_addstr(y, left + width - len(log_count) - 2, log_count, curses.color_pair(self.C_GREEN) | curses.A_BOLD)

    def _draw_bar(self, y, x, width, percent):
        """Draw a colored progress bar."""
        bar_width = width - 7  # room for " XX.X%"
        if bar_width < 4:
            bar_width = 4
        filled = int((percent / 100.0) * bar_width)
        empty = bar_width - filled

        self._safe_addstr(y, x, "█" * filled, curses.color_pair(self.C_BAR_FILL))
        self._safe_addstr(y, x + filled, "░" * empty, curses.color_pair(self.C_BAR_EMPTY))

        pct_str = f" {percent:5.1f}%"
        color = self.C_GREEN if percent < 70 else (self.C_YELLOW if percent < 90 else self.C_RED)
        self._safe_addstr(y, x + bar_width, pct_str, curses.color_pair(color))

    # --- CENTER PANE: Event Log ---

    def _draw_log_pane(self, top, left, width, height, server):
        # Border
        for row in range(top, top + height):
            self._safe_addstr(row, left + width, "│", curses.color_pair(self.C_DIM))

        pane_label = "EVENT LOG"
        if self.active_pane == 0:
            pane_label = "EVENT LOG (active)"
        self._safe_addstr(top, left + 1, pane_label, curses.color_pair(self.C_BLUE) | curses.A_BOLD)
        self._safe_addstr(top + 1, left + 1, "─" * (width - 2), curses.color_pair(self.C_DIM))

        log_area_height = height - 3
        events = list(server.event_log)
        total = len(events)

        self.max_log_scroll = max(0, total - log_area_height)
        # Auto-scroll to bottom unless user scrolled up
        if self.log_scroll > self.max_log_scroll:
            self.log_scroll = self.max_log_scroll

        start_idx = max(0, total - log_area_height - self.log_scroll)
        end_idx = start_idx + log_area_height

        y = top + 2
        for i in range(start_idx, min(end_idx, total)):
            if y >= top + height:
                break
            event = events[i]
            # Color based on content
            if "Connected" in event or "joined" in event:
                attr = curses.color_pair(self.C_GREEN)
            elif "Disconnected" in event or "left" in event:
                attr = curses.color_pair(self.C_RED)
            elif "created" in event or "started" in event:
                attr = curses.color_pair(self.C_YELLOW)
            elif "CHAT" in event:
                attr = curses.color_pair(self.C_BLUE)
            else:
                attr = curses.color_pair(self.C_DIM)

            line = event[:width - 3]
            self._safe_addstr(y, left + 1, line, attr)
            y += 1

        # Scroll indicator
        if self.max_log_scroll > 0:
            indicator = f"[{total - self.log_scroll - log_area_height + 1}-{total - self.log_scroll}/{total}]"
            self._safe_addstr(top + height - 1, left + 1, indicator, curses.color_pair(self.C_DIM))

    # --- RIGHT PANE: Connected Players ---

    def _draw_players_pane(self, top, left, width, height, server):
        player_label = "PLAYERS"
        if self.active_pane == 1:
            player_label = "PLAYERS (active)"
        self._safe_addstr(top, left + 1, player_label, curses.color_pair(self.C_BLUE) | curses.A_BOLD)
        self._safe_addstr(top + 1, left + 1, "─" * (width - 2), curses.color_pair(self.C_DIM))

        y = top + 2

        if not server.client_ips:
            self._safe_addstr(y, left + 2, "No players", curses.color_pair(self.C_DIM))
            return

        for client_id, ip in server.client_ips.items():
            if y >= top + height - 1:
                break

            name = server.client_names.get(client_id, "...")
            lobby = ""
            if client_id in server.client_player_ids:
                pid = server.client_player_ids[client_id]
                lb = server.lobby_manager.get_player_lobby(pid)
                if lb:
                    lobby = f" [{lb.name[:10]}]"

            # Player entry
            self._safe_addstr(y, left + 1, "●", curses.color_pair(self.C_GREEN))
            name_str = f" {name}"
            self._safe_addstr(y, left + 2, name_str[:width - 4], curses.color_pair(self.C_YELLOW) | curses.A_BOLD)
            y += 1

            if y < top + height - 1:
                detail = f"  {ip}{lobby}"
                self._safe_addstr(y, left + 1, detail[:width - 3], curses.color_pair(self.C_DIM))
                y += 1

    # --- BOTTOM BAR ---

    def _draw_bottom_bar(self, y, w, server):
        self._safe_addstr(y - 1, 0, "─" * w, curses.color_pair(self.C_DIM))

        shortcuts = " [TAB] Switch pane  [↑↓] Scroll  [Q] Quit "
        pad = max(0, (w - len(shortcuts)) // 2)
        full_line = " " * pad + shortcuts + " " * (w - pad - len(shortcuts))
        self._safe_addstr(y, 0, full_line, curses.color_pair(self.C_HIGHLIGHT))

    # --- INPUT HANDLING ---

    def handle_input(self):
        """Process keyboard input. Returns False if should quit."""
        try:
            key = self.stdscr.getch()
        except Exception:
            return True

        if key == -1:
            return True

        if key == ord('q') or key == ord('Q'):
            return False

        if key == 9:  # TAB
            self.active_pane = (self.active_pane + 1) % 2

        if key == curses.KEY_UP:
            if self.active_pane == 0:
                self.log_scroll = min(self.log_scroll + 1, self.max_log_scroll)

        if key == curses.KEY_DOWN:
            if self.active_pane == 0:
                self.log_scroll = max(self.log_scroll - 1, 0)

        return True


# =============================================
#  GAME SERVER
# =============================================

class BackroomsGameServer:
    """Main WebSocket server for the Backrooms multiplayer game."""

    HOST = "0.0.0.0"
    PORT = 7778
    HTTP_PORT = 8080
    MAX_MEMORY_MB = 3000
    WEB_ROOT = Path.home() / "Desktop" / "BackroomsGame"

    UI_UPDATE_INTERVAL = 1.0
    LOBBY_BROADCAST_INTERVAL = 1.0

    def __init__(self):
        self.host = self.HOST
        self.port = self.PORT

        # Debug log file for startup issues
        self._debug_log = open(Path.home() / "Desktop" / "logs" / "server_debug.log", "w", buffering=1)
        self._debug("Server object created")

        # Set resource limits
        try:
            soft, hard = resource.getrlimit(resource.RLIMIT_AS)
            resource.setrlimit(resource.RLIMIT_AS, (self.MAX_MEMORY_MB * 1024 * 1024, hard))
        except Exception:
            pass

        # Client tracking
        self.clients: Dict[str, WebSocketServerProtocol] = {}
        self.client_names: Dict[str, str] = {}        # client_id -> name
        self.client_ips: Dict[str, str] = {}           # client_id -> ip
        self.client_player_ids: Dict[str, str] = {}    # client_id -> player_id

        # Lobby and game management
        self.lobby_manager = LobbyManager()
        self.active_games: Dict[str, GameSession] = {}

        # Event log (for TUI display)
        self.event_log: deque = deque(maxlen=200)

        # System monitoring
        self.cpu_percent = 0.0
        self.ram_percent = 0.0
        self.connected_players = 0
        self.active_lobbies = 0

        # Per-player logger
        self.player_logger = PlayerLogger()

        # Server state
        self.running = False
        self.start_time: Optional[datetime] = None
        self.public_ip: Optional[str] = None
        self.upnp_mapped = False

        # TUI reference (set during start)
        self.tui: Optional[ServerTUI] = None

    def _debug(self, msg: str):
        """Write to debug log file."""
        try:
            ts = datetime.now().strftime("%H:%M:%S.%f")
            self._debug_log.write(f"[{ts}] {msg}\n")
            self._debug_log.flush()
        except Exception:
            pass

    def _log_event(self, event: str) -> None:
        """Log an event to the scrolling event log."""
        timestamp = datetime.now().strftime("%H:%M:%S")
        self.event_log.append(f"[{timestamp}] {event}")

    def _log_player_action(self, client_id: str, action: str) -> None:
        """Log an action both to the TUI and to the player's log file."""
        ip = self.client_ips.get(client_id, "?")
        name = self.client_names.get(client_id, "?")
        self._log_event(f"[{ip}] [{name}] {action}")
        self.player_logger.log_action(client_id, action)

    def _generate_client_id(self) -> str:
        return f"client_{len(self.clients)}_{datetime.now().timestamp()}"

    def _get_client_ip(self, websocket) -> str:
        """Extract the IP address from a WebSocket connection."""
        try:
            # websockets v13+
            if hasattr(websocket, 'remote_address') and websocket.remote_address:
                return str(websocket.remote_address[0])
            # fallback: underlying transport
            peername = websocket.transport.get_extra_info('peername')
            if peername:
                return str(peername[0])
        except Exception:
            pass
        return "unknown"

    # =========================================
    #  UPnP & PUBLIC IP
    # =========================================

    def _fetch_public_ip(self) -> Optional[str]:
        """Fetch our public IP from an external service."""
        services = [
            "https://api.ipify.org",
            "https://icanhazip.com",
            "https://checkip.amazonaws.com",
        ]
        for url in services:
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "BackroomsServer/1.0"})
                with urllib.request.urlopen(req, timeout=5) as resp:
                    ip = resp.read().decode().strip()
                    if ip and len(ip) < 50:
                        return ip
            except Exception:
                continue
        return None

    def _setup_upnp(self) -> bool:
        """Set up UPnP port forwarding for the game server."""
        if not HAS_UPNP:
            self._debug("miniupnpc not installed — skipping UPnP")
            self._log_event("UPnP: miniupnpc not installed (pip install miniupnpc)")
            return False

        try:
            u = miniupnpc.UPnP()
            u.discoverdelay = 200
            self._debug("UPnP: discovering devices...")
            self._log_event("UPnP: Discovering router...")
            ndevices = u.discover()
            self._debug(f"UPnP: found {ndevices} device(s)")

            u.selectigd()
            local_ip = u.lanaddr
            self._debug(f"UPnP: local IP = {local_ip}")

            # Forward WebSocket port
            result_ws = u.addportmapping(
                self.port, 'TCP', local_ip, self.port,
                'Backrooms Game Server', ''
            )
            # Forward HTTP port
            result_http = u.addportmapping(
                self.HTTP_PORT, 'TCP', local_ip, self.HTTP_PORT,
                'Backrooms HTTP Server', ''
            )

            if result_ws:
                self._debug(f"UPnP: mapped WS port {self.port} -> {local_ip}:{self.port}")
                self._log_event(f"UPnP: Port {self.port} (WS) forwarded OK")
                self.upnp_mapped = True
            if result_http:
                self._debug(f"UPnP: mapped HTTP port {self.HTTP_PORT} -> {local_ip}:{self.HTTP_PORT}")
                self._log_event(f"UPnP: Port {self.HTTP_PORT} (HTTP) forwarded OK")

            if result_ws or result_http:
                return True
            else:
                self._log_event("UPnP: Port mapping failed")
                return False

        except Exception as e:
            self._debug(f"UPnP error: {e}")
            self._log_event(f"UPnP: {e}")
            return False

    def _cleanup_upnp(self):
        """Remove UPnP port mappings on shutdown."""
        if not self.upnp_mapped or not HAS_UPNP:
            return
        try:
            u = miniupnpc.UPnP()
            u.discoverdelay = 200
            u.discover()
            u.selectigd()
            u.deleteportmapping(self.port, 'TCP')
            u.deleteportmapping(self.HTTP_PORT, 'TCP')
            self._debug(f"UPnP: removed port mappings for {self.port} and {self.HTTP_PORT}")
        except Exception as e:
            self._debug(f"UPnP cleanup error: {e}")

    def _write_server_config(self):
        """Write public IP to a config file for the client to discover."""
        if not self.public_ip:
            return
        config_path = Path.home() / "Desktop" / "BackroomsGame" / "server_config.json"
        try:
            config = {"address": f"ws://{self.public_ip}:{self.port}"}
            with open(config_path, "w") as f:
                json.dump(config, f)
            self._debug(f"Wrote server_config.json: {config}")
        except Exception as e:
            self._debug(f"Failed to write server_config.json: {e}")

    def _start_http_server(self):
        """Start a simple HTTP file server in a daemon thread to serve the game client."""
        web_root = str(self.WEB_ROOT)

        class QuietHandler(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=web_root, **kwargs)

            def log_message(self, format, *args):
                pass  # Suppress HTTP logs from cluttering ncurses

            def end_headers(self):
                # Add CORS headers so WebSocket connections work
                self.send_header('Access-Control-Allow-Origin', '*')
                super().end_headers()

        try:
            httpd = HTTPServer((self.host, self.HTTP_PORT), QuietHandler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            self._debug(f"HTTP server started on port {self.HTTP_PORT}")
            self._log_event(f"HTTP server on port {self.HTTP_PORT}")
            return httpd
        except Exception as e:
            self._debug(f"HTTP server failed: {e}")
            self._log_event(f"HTTP server error: {e}")
            return None

    # =========================================
    #  BROADCAST
    # =========================================

    async def _broadcast_lobby_list(self) -> None:
        lobby_list = self.lobby_manager.get_lobby_list()
        message = json.dumps({"type": "lobby_list", "lobbies": lobby_list})

        disconnected = []
        for client_id, websocket in self.clients.items():
            try:
                await websocket.send(message)
            except Exception:
                disconnected.append(client_id)

        for client_id in disconnected:
            await self._handle_disconnect(client_id)

    async def _broadcast_game_state(self, lobby_id: str, game_state: dict) -> None:
        message = json.dumps({
            "type": "game_state",
            "lobby_id": lobby_id,
            "data": game_state
        })

        lobby = self.lobby_manager.lobbies.get(lobby_id)
        if not lobby:
            return

        disconnected = []
        for player in lobby.players.values():
            client_id = None
            for cid, pid in self.client_player_ids.items():
                if pid == player.id:
                    client_id = cid
                    break

            if client_id and client_id in self.clients:
                try:
                    await self.clients[client_id].send(message)
                except Exception:
                    disconnected.append(client_id)

        for client_id in disconnected:
            await self._handle_disconnect(client_id)

    # =========================================
    #  MESSAGE HANDLERS
    # =========================================

    async def _handle_set_name(self, client_id: str, data: dict) -> None:
        name = data.get("name", "Player")[:20]
        self.client_names[client_id] = name
        ip = self.client_ips.get(client_id, "unknown")

        # Create the player's log file now that we have a name
        self.player_logger.register_name(client_id, name)

        self._log_player_action(client_id, "Set name")

    async def _handle_create_lobby(self, client_id: str, data: dict) -> None:
        if client_id not in self.client_names:
            return

        player_name = self.client_names[client_id]
        player = Player(id=client_id, name=player_name)
        lobby = self.lobby_manager.create_lobby(player, data.get("name"))

        if lobby:
            self.client_player_ids[client_id] = player.id
            self._log_player_action(client_id, f"Created lobby '{lobby.name}'")
            await self._broadcast_lobby_list()

    async def _handle_join_lobby(self, client_id: str, data: dict) -> None:
        if client_id not in self.client_names:
            return

        lobby_id = data.get("lobby_id")
        player_name = self.client_names[client_id]
        player = Player(id=client_id, name=player_name)

        if self.lobby_manager.join_lobby(player, lobby_id):
            self.client_player_ids[client_id] = player.id
            lobby = self.lobby_manager.lobbies.get(lobby_id)
            lobby_name = lobby.name if lobby else lobby_id
            self._log_player_action(client_id, f"Joined lobby '{lobby_name}'")
            await self._broadcast_lobby_list()
        else:
            await self.clients[client_id].send(json.dumps({
                "type": "error",
                "message": "Could not join lobby"
            }))

    async def _handle_leave_lobby(self, client_id: str, data: dict) -> None:
        if client_id not in self.client_player_ids:
            return

        player_id = self.client_player_ids[client_id]
        if self.lobby_manager.leave_lobby(player_id):
            del self.client_player_ids[client_id]
            self._log_player_action(client_id, "Left lobby")
            await self._broadcast_lobby_list()

    async def _handle_start_game(self, client_id: str, data: dict) -> None:
        lobby_id = data.get("lobby_id")
        lobby = self.lobby_manager.lobbies.get(lobby_id)

        if not lobby or lobby.host_player_id != self.client_player_ids.get(client_id):
            return

        if self.lobby_manager.start_game(lobby_id):
            players_dict = {p.id: p.name for p in lobby.players.values()}
            game_session = GameSession(lobby_id, players_dict)
            self.active_games[lobby_id] = game_session

            self._log_player_action(client_id, f"Started game in '{lobby.name}'")

            game_session.start(
                lambda state: self._broadcast_game_state(lobby_id, state)
            )

    async def _handle_player_input(self, client_id: str, data: dict) -> None:
        if client_id not in self.client_player_ids:
            return

        player_id = self.client_player_ids[client_id]
        lobby = self.lobby_manager.get_player_lobby(player_id)

        if lobby and lobby.id in self.active_games:
            game = self.active_games[lobby.id]
            game.set_player_input(player_id, data)

    async def _handle_chat(self, client_id: str, data: dict) -> None:
        if client_id not in self.client_names:
            return

        message = data.get("message", "")[:200]
        self._log_player_action(client_id, f"CHAT: {message}")

    async def _handle_disconnect(self, client_id: str) -> None:
        if client_id not in self.clients:
            return

        # Log before removing
        self._log_player_action(client_id, "Disconnected")

        # Clean up
        if client_id in self.clients:
            del self.clients[client_id]
        if client_id in self.client_names:
            del self.client_names[client_id]

        if client_id in self.client_player_ids:
            player_id = self.client_player_ids[client_id]
            self.lobby_manager.leave_lobby(player_id)
            del self.client_player_ids[client_id]

        # Close the player's log file
        self.player_logger.close_player(client_id)

        if client_id in self.client_ips:
            del self.client_ips[client_id]

        self.connected_players = len(self.clients)
        await self._broadcast_lobby_list()

    # =========================================
    #  CLIENT HANDLER
    # =========================================

    async def handle_client(self, websocket) -> None:
        client_id = self._generate_client_id()
        ip = self._get_client_ip(websocket)

        self.clients[client_id] = websocket
        self.client_ips[client_id] = ip
        self.connected_players = len(self.clients)

        # Register the connection (IP only, name comes later)
        self.player_logger.register_connection(client_id, ip)
        self._log_event(f"[{ip}] New connection")

        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                    msg_type = data.get("type")

                    if msg_type == "set_name":
                        await self._handle_set_name(client_id, data)
                    elif msg_type == "create_lobby":
                        await self._handle_create_lobby(client_id, data)
                    elif msg_type == "join_lobby":
                        await self._handle_join_lobby(client_id, data)
                    elif msg_type == "leave_lobby":
                        await self._handle_leave_lobby(client_id, data)
                    elif msg_type == "start_game":
                        await self._handle_start_game(client_id, data)
                    elif msg_type == "player_input":
                        await self._handle_player_input(client_id, data)
                    elif msg_type == "chat":
                        await self._handle_chat(client_id, data)
                    elif msg_type == "list_lobbies":
                        await self._broadcast_lobby_list()

                except json.JSONDecodeError:
                    pass

        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            await self._handle_disconnect(client_id)

    # =========================================
    #  BACKGROUND TASKS
    # =========================================

    async def _update_system_stats(self) -> None:
        while self.running:
            try:
                process = psutil.Process()
                self.cpu_percent = process.cpu_percent(interval=None)
                self.ram_percent = process.memory_percent()
                self.connected_players = len(self.clients)
                self.active_lobbies = len(self.lobby_manager.lobbies)
            except Exception:
                pass
            await asyncio.sleep(self.UI_UPDATE_INTERVAL)

    async def _broadcast_loop(self) -> None:
        while self.running:
            try:
                await self._broadcast_lobby_list()
            except Exception:
                pass
            await asyncio.sleep(self.LOBBY_BROADCAST_INTERVAL)

    async def _tui_loop(self) -> None:
        """Redraw the TUI and handle keyboard input."""
        while self.running:
            if self.tui:
                self.tui.draw(self)
                if not self.tui.handle_input():
                    self.running = False
                    break
            await asyncio.sleep(0.1)

    # =========================================
    #  START
    # =========================================

    async def start(self, stdscr) -> None:
        """Start the server with curses TUI."""
        self._debug("start() called")
        self.running = True
        self.start_time = datetime.now()

        self._debug("Creating TUI...")
        self.tui = ServerTUI(stdscr)
        self._debug("TUI created OK")

        monitor_task = asyncio.create_task(self._update_system_stats())
        broadcast_task = asyncio.create_task(self._broadcast_loop())
        cleanup_task = asyncio.create_task(self.lobby_manager.start_cleanup_loop())
        tui_task = asyncio.create_task(self._tui_loop())

        self._log_event("Server starting...")
        self._debug(f"About to bind ws://{self.host}:{self.port}")

        # Start HTTP file server for the game client
        self._start_http_server()

        # Set up UPnP port forwarding
        self._setup_upnp()

        # Fetch public IP
        self._log_event("Fetching public IP...")
        self.public_ip = self._fetch_public_ip()
        if self.public_ip:
            self._log_event(f"Public IP: {self.public_ip}")
            self._debug(f"Public IP: {self.public_ip}")
            self._write_server_config()
        else:
            self._log_event("Could not determine public IP")
            self._debug("Public IP fetch failed")

        try:
            async with websockets.serve(self.handle_client, self.host, self.port):
                self._debug("WebSocket server bound OK")
                self._log_event(f"Listening on ws://{self.host}:{self.port}")

                # Wait until TUI signals quit
                while self.running:
                    await asyncio.sleep(0.5)

                self._debug("Main loop exited (running=False)")

        except Exception as e:
            self._debug(f"Exception in serve: {type(e).__name__}: {e}")
            self._log_event(f"Server error: {e}")
        finally:
            self._debug("Entering finally block")
            self.running = False
            monitor_task.cancel()
            broadcast_task.cancel()
            cleanup_task.cancel()
            tui_task.cancel()
            self.lobby_manager.stop_cleanup_loop()

            for game in self.active_games.values():
                game.stop()

            self._cleanup_upnp()
            self.player_logger.close_all()
            self._debug("Shutdown complete")


# =============================================
#  MAIN ENTRY POINT
# =============================================

def main():
    server = BackroomsGameServer()
    error_msg = None

    def curses_main(stdscr):
        nonlocal error_msg
        try:
            asyncio.run(server.start(stdscr))
        except Exception as e:
            error_msg = str(e)

    try:
        curses.wrapper(curses_main)
    except KeyboardInterrupt:
        pass
    except Exception as e:
        error_msg = str(e)
    finally:
        server.player_logger.close_all()
        print("\nBackrooms server shut down.")
        print(f"Logs saved in: {Path.home() / 'Desktop' / 'logs'}")
        if error_msg:
            print(f"Error: {error_msg}")


if __name__ == "__main__":
    main()
