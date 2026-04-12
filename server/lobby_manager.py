"""
Lobby Management System for Backrooms Game Server

Handles creation, joining, and cleanup of game lobbies.
Each lobby can hold up to 4 players.
"""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional, Set
from uuid import uuid4


class LobbyState(Enum):
    """Lobby state enumeration."""
    WAITING = "waiting"
    PLAYING = "playing"


@dataclass
class Player:
    """Represents a player in the system."""
    id: str
    name: str
    connected: bool = True
    timestamp: datetime = field(default_factory=datetime.now)


@dataclass
class Lobby:
    """Represents a game lobby."""
    id: str
    name: str
    host_player_id: str
    host_name: str
    players: Dict[str, Player] = field(default_factory=dict)
    max_players: int = 4
    state: LobbyState = LobbyState.WAITING
    created_at: datetime = field(default_factory=datetime.now)
    last_activity: datetime = field(default_factory=datetime.now)

    def add_player(self, player: Player) -> bool:
        """Add a player to the lobby. Returns True if successful."""
        if len(self.players) >= self.max_players:
            return False
        if self.state != LobbyState.WAITING:
            return False

        self.players[player.id] = player
        self.last_activity = datetime.now()
        return True

    def remove_player(self, player_id: str) -> bool:
        """Remove a player from the lobby. Returns True if successful."""
        if player_id in self.players:
            del self.players[player_id]
            self.last_activity = datetime.now()
            return True
        return False

    def get_player_count(self) -> int:
        """Get current player count."""
        return len(self.players)

    def is_empty(self) -> bool:
        """Check if lobby is empty."""
        return len(self.players) == 0

    def to_dict(self) -> dict:
        """Convert lobby to dictionary for transmission."""
        return {
            "id": self.id,
            "name": self.name,
            "host_name": self.host_name,
            "player_count": len(self.players),
            "max_players": self.max_players,
            "state": self.state.value,
            "players": [
                {"id": p.id, "name": p.name}
                for p in self.players.values()
            ]
        }


class LobbyManager:
    """
    Manages all game lobbies on the server.
    Handles creation, joining, leaving, and cleanup of lobbies.
    """

    def __init__(self):
        """Initialize the lobby manager."""
        self.lobbies: Dict[str, Lobby] = {}
        self.player_to_lobby: Dict[str, str] = {}  # player_id -> lobby_id
        self.cleanup_task: Optional[asyncio.Task] = None
        self.broadcast_callbacks: List[callable] = []

    def register_broadcast_callback(self, callback: callable) -> None:
        """Register a callback for lobby list broadcasts."""
        self.broadcast_callbacks.append(callback)

    async def _notify_lobby_update(self) -> None:
        """Notify all clients of lobby list update."""
        for callback in self.broadcast_callbacks:
            await callback(self.get_lobby_list())

    def create_lobby(self, host_player: Player, name: Optional[str] = None) -> Optional[Lobby]:
        """
        Create a new lobby.

        Args:
            host_player: The player creating the lobby
            name: Optional custom name; defaults to "[Name]'s Lobby"

        Returns:
            Created Lobby object, or None if player is already in a lobby
        """
        # Check if player is already in a lobby
        if host_player.id in self.player_to_lobby:
            return None

        lobby_id = str(uuid4())[:8]
        lobby_name = name if name else f"{host_player.name}'s Lobby"

        lobby = Lobby(
            id=lobby_id,
            name=lobby_name,
            host_player_id=host_player.id,
            host_name=host_player.name
        )

        # Add host to their own lobby
        lobby.add_player(host_player)
        self.lobbies[lobby_id] = lobby
        self.player_to_lobby[host_player.id] = lobby_id

        return lobby

    def join_lobby(self, player: Player, lobby_id: str) -> bool:
        """
        Join a player to an existing lobby.

        Args:
            player: The player joining
            lobby_id: The lobby ID to join

        Returns:
            True if successful, False otherwise
        """
        # Check if player is already in a lobby
        if player.id in self.player_to_lobby:
            return False

        # Check if lobby exists
        if lobby_id not in self.lobbies:
            return False

        lobby = self.lobbies[lobby_id]

        # Try to add player
        if lobby.add_player(player):
            self.player_to_lobby[player.id] = lobby_id
            return True

        return False

    def leave_lobby(self, player_id: str) -> bool:
        """
        Remove a player from their current lobby.
        If the host leaves, transfer host to another player or destroy lobby.

        Args:
            player_id: The player ID to remove

        Returns:
            True if successful, False if player wasn't in a lobby
        """
        if player_id not in self.player_to_lobby:
            return False

        lobby_id = self.player_to_lobby[player_id]
        lobby = self.lobbies.get(lobby_id)

        if not lobby:
            del self.player_to_lobby[player_id]
            return False

        # Remove the player
        lobby.remove_player(player_id)
        del self.player_to_lobby[player_id]

        # If lobby is now empty, mark it for cleanup
        if lobby.is_empty():
            del self.lobbies[lobby_id]
            return True

        # If the host left, transfer host to another player
        if lobby.host_player_id == player_id:
            remaining_player = next(iter(lobby.players.values()))
            lobby.host_player_id = remaining_player.id
            lobby.host_name = remaining_player.name

        return True

    def get_lobby_list(self) -> List[dict]:
        """
        Get a list of all active lobbies.

        Returns:
            List of lobby dictionaries suitable for transmission
        """
        return [lobby.to_dict() for lobby in self.lobbies.values()]

    def get_player_lobby(self, player_id: str) -> Optional[Lobby]:
        """
        Get the lobby a player is currently in.

        Args:
            player_id: The player ID

        Returns:
            Lobby object or None if player is not in a lobby
        """
        if player_id not in self.player_to_lobby:
            return None

        lobby_id = self.player_to_lobby[player_id]
        return self.lobbies.get(lobby_id)

    def start_game(self, lobby_id: str) -> bool:
        """
        Start the game in a lobby.

        Args:
            lobby_id: The lobby ID

        Returns:
            True if successful, False if lobby doesn't exist or isn't in waiting state
        """
        if lobby_id not in self.lobbies:
            return False

        lobby = self.lobbies[lobby_id]
        if lobby.state != LobbyState.WAITING:
            return False

        lobby.state = LobbyState.PLAYING
        return True

    def end_game(self, lobby_id: str) -> bool:
        """
        End the game in a lobby.

        Args:
            lobby_id: The lobby ID

        Returns:
            True if successful, False if lobby doesn't exist
        """
        if lobby_id not in self.lobbies:
            return False

        lobby = self.lobbies[lobby_id]
        lobby.state = LobbyState.WAITING
        return True

    async def start_cleanup_loop(self) -> None:
        """
        Start the automatic cleanup loop.
        Removes lobbies that have been empty for more than 15 seconds.
        """
        try:
            while True:
                await asyncio.sleep(5)  # Check every 5 seconds

                now = datetime.now()
                lobbies_to_remove = []

                for lobby_id, lobby in self.lobbies.items():
                    if lobby.is_empty():
                        time_since_empty = (now - lobby.last_activity).total_seconds()
                        if time_since_empty > 15:
                            lobbies_to_remove.append(lobby_id)

                for lobby_id in lobbies_to_remove:
                    del self.lobbies[lobby_id]
                    await self._notify_lobby_update()

        except asyncio.CancelledError:
            pass

    def stop_cleanup_loop(self) -> None:
        """Stop the automatic cleanup loop."""
        if self.cleanup_task:
            self.cleanup_task.cancel()
