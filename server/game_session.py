"""
Game Session Management for Backrooms Game Server

Handles the server-authoritative game logic including:
- Player movement and collision detection
- Game state synchronization
- Physics simulation
- Trip mechanics
"""

import asyncio
import random
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional
from math import cos, sin, pi


class PlayerState(Enum):
    """Player movement state."""
    IDLE = "idle"
    WALKING = "walking"
    RUNNING = "running"
    CROUCHING = "crouching"
    TRIPPING = "tripping"
    SPAWNING = "spawning"


@dataclass
class Vector3:
    """3D vector representation."""
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0

    def __add__(self, other: "Vector3") -> "Vector3":
        """Add two vectors."""
        return Vector3(self.x + other.x, self.y + other.y, self.z + other.z)

    def __mul__(self, scalar: float) -> "Vector3":
        """Multiply vector by scalar."""
        return Vector3(self.x * scalar, self.y * scalar, self.z * scalar)

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {"x": self.x, "y": self.y, "z": self.z}


@dataclass
class Rotation:
    """Player rotation (yaw and pitch)."""
    yaw: float = 0.0  # Rotation around Y axis
    pitch: float = 0.0  # Rotation around X axis

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {"yaw": self.yaw, "pitch": self.pitch}


@dataclass
class PlayerSession:
    """Represents a player's session in an active game."""
    player_id: str
    player_name: str
    position: Vector3 = field(default_factory=Vector3)
    rotation: Rotation = field(default_factory=Rotation)
    velocity: Vector3 = field(default_factory=Vector3)
    state: PlayerState = PlayerState.SPAWNING
    stamina: float = 100.0
    max_stamina: float = 100.0
    spawn_time: float = 0.0  # Time spent in spawn animation
    trip_duration: float = 0.0  # Time left in trip state

    def to_dict(self) -> dict:
        """Convert to dictionary for transmission."""
        return {
            "player_id": self.player_id,
            "player_name": self.player_name,
            "position": self.position.to_dict(),
            "rotation": self.rotation.to_dict(),
            "velocity": self.velocity.to_dict(),
            "state": self.state.value,
            "stamina": self.stamina,
        }


class GameSession:
    """
    Server-authoritative game session managing one active game.
    Runs at 20 ticks per second (50ms per tick).
    """

    # Movement constants (match client)
    WALK_SPEED = 4.5
    SPRINT_SPEED = 7.8
    CROUCH_SPEED = 2.0
    JUMP_FORCE = 15.0

    # Stamina constants
    SPRINT_DRAIN_RATE = 30.0  # Stamina points per second
    STAMINA_REGEN_RATE = 15.0  # Stamina points per second
    MIN_STAMINA_TO_SPRINT = 10.0

    # Spawn animation
    SPAWN_DURATION = 2.0  # Seconds

    # Trip mechanics
    TRIP_DURATION = 2.0  # Seconds
    TRIP_CHANCE_PER_SECOND = 0.02  # 2% chance per second

    # Gravity and physics
    GRAVITY = 20.0  # Units per second squared
    GROUND_FRICTION = 0.85

    # Level bounds (simple grid-based collision)
    LEVEL_WIDTH = 100
    LEVEL_HEIGHT = 100
    COLLISION_DISTANCE = 0.5  # Distance to check for collisions

    def __init__(self, lobby_id: str, players: Dict[str, str]):
        """
        Initialize a game session.

        Args:
            lobby_id: The lobby ID this game is for
            players: Dict of player_id -> player_name
        """
        self.lobby_id = lobby_id
        self.game_time = 0.0
        self.tick_rate = 20  # 20 ticks per second
        self.tick_duration = 1.0 / self.tick_rate

        # Initialize player sessions
        # Default spawn at level center: tile (7,7) * tileSize 4 + offset 2 = (30, 2, 30)
        self.players: Dict[str, PlayerSession] = {}

        for player_id, player_name in players.items():
            player_session = PlayerSession(
                player_id=player_id,
                player_name=player_name,
                position=Vector3(x=30.0, y=2.0, z=30.0),
            )
            self.players[player_id] = player_session

        # Player input buffer
        self.player_inputs: Dict[str, dict] = {}

        # Props in the level
        self.props: List[dict] = []

        # Game state
        self.active = True
        self.run_task: Optional[asyncio.Task] = None

    def set_player_input(self, player_id: str, input_data: dict) -> None:
        """
        Set the input for a player.
        If the client sends position/state, update the player directly
        (client-authoritative model — the client has the real physics).

        Args:
            player_id: The player ID
            input_data: Dict with 'keys', 'mouse', and optionally 'position', 'state'
        """
        if player_id not in self.players:
            return

        self.player_inputs[player_id] = input_data

        player = self.players[player_id]

        # Use client-reported position if available (client has real collision/physics)
        pos = input_data.get("position")
        if pos:
            player.position.x = pos.get("x", player.position.x)
            player.position.y = pos.get("y", player.position.y)
            player.position.z = pos.get("z", player.position.z)

        # Use client-reported movement state if available
        state_str = input_data.get("state")
        if state_str:
            try:
                player.state = PlayerState(state_str)
            except ValueError:
                pass

        # Always update rotation from mouse
        mouse = input_data.get("mouse", {})
        if mouse:
            player.rotation.yaw = mouse.get("yaw", player.rotation.yaw)
            player.rotation.pitch = mouse.get("pitch", player.rotation.pitch)

    def _calculate_movement_direction(self, keys: dict) -> tuple[float, float]:
        """
        Calculate movement direction from input keys.

        Returns:
            Tuple of (forward_component, strafe_component) normalized to [-1, 1]
        """
        forward = 0.0
        strafe = 0.0

        if keys.get("forward"):
            forward += 1.0
        if keys.get("backward"):
            forward -= 1.0
        if keys.get("right"):
            strafe += 1.0
        if keys.get("left"):
            strafe -= 1.0

        # Normalize diagonal movement
        magnitude = (forward ** 2 + strafe ** 2) ** 0.5
        if magnitude > 0:
            forward /= magnitude
            strafe /= magnitude

        return forward, strafe

    def _check_collision(self, position: Vector3) -> bool:
        """
        Check if a position collides with level geometry.

        Args:
            position: Position to check

        Returns:
            True if collision detected, False otherwise
        """
        # Simple bounds check
        if position.x < 0 or position.x > self.LEVEL_WIDTH:
            return True
        if position.z < 0 or position.z > self.LEVEL_HEIGHT:
            return True

        # Simple grid-based collision (walls at boundaries)
        # This is a simplified version; a full implementation would have detailed level data
        grid_x = int(position.x / 5)
        grid_z = int(position.z / 5)

        # Define some simple wall areas (rough collision grid)
        walls = [
            (0, 0), (0, 1), (0, 2),
            (19, 0), (19, 1), (19, 2),
        ]

        if (grid_x, grid_z) in walls:
            return True

        return False

    def _update_player(self, player: PlayerSession, delta_time: float) -> None:
        """
        Update a single player's state.

        The client is authoritative for position and movement state
        (since it has the real level geometry and physics). The server
        just relays what clients report. If a client hasn't sent input
        yet (e.g. still loading), handle spawn state server-side.
        """
        input_data = self.player_inputs.get(player.player_id)

        if input_data and input_data.get("position"):
            # Client is sending real data — trust it (already applied in set_player_input)
            # Just update stamina based on state
            if player.state == PlayerState.RUNNING:
                player.stamina = max(0, player.stamina - self.SPRINT_DRAIN_RATE * delta_time)
            else:
                player.stamina = min(self.max_stamina, player.stamina + self.STAMINA_REGEN_RATE * delta_time)
        else:
            # No client input yet — handle spawn animation server-side
            if player.state == PlayerState.SPAWNING:
                player.spawn_time += delta_time
                if player.spawn_time >= self.SPAWN_DURATION:
                    player.state = PlayerState.IDLE
                    player.spawn_time = 0.0

    def get_state(self) -> dict:
        """Public accessor for current game state."""
        return self._get_game_state()

    def _get_game_state(self) -> dict:
        """
        Get the current game state.

        Returns:
            Dictionary containing all player data
        """
        return {
            "game_time": self.game_time,
            "players": {
                player_id: player.to_dict()
                for player_id, player in self.players.items()
            },
            "props": self.props
        }

    async def update_tick(self) -> dict:
        """
        Perform one game tick update.

        Returns:
            Game state dictionary to send to clients
        """
        # Update all players
        for player in self.players.values():
            self._update_player(player, self.tick_duration)

        self.game_time += self.tick_duration

        return self._get_game_state()

    async def run(self, state_callback: callable) -> None:
        """
        Run the game session loop.

        Args:
            state_callback: Async function to call with game state each tick
        """
        try:
            while self.active:
                state = await self.update_tick()
                await state_callback(state)
                await asyncio.sleep(self.tick_duration)
        except asyncio.CancelledError:
            pass
        finally:
            self.active = False

    def start(self, state_callback: callable) -> asyncio.Task:
        """
        Start the game session.

        Args:
            state_callback: Async function to call with game state each tick

        Returns:
            The asyncio task running the game
        """
        self.run_task = asyncio.create_task(self.run(state_callback))
        return self.run_task

    def stop(self) -> None:
        """Stop the game session."""
        self.active = False
        if self.run_task:
            self.run_task.cancel()

    def add_player(self, player_id: str, player_name: str) -> None:
        """Add a new player to an in-progress game (late join)."""
        if player_id not in self.players:
            player_session = PlayerSession(
                player_id=player_id,
                player_name=player_name,
                position=Vector3(x=30.0, y=2.0, z=30.0),
            )
            self.players[player_id] = player_session

    def remove_player(self, player_id: str) -> bool:
        """
        Remove a player from the game.

        Args:
            player_id: The player ID to remove

        Returns:
            True if successful, False if player not found
        """
        if player_id in self.players:
            del self.players[player_id]
            if player_id in self.player_inputs:
                del self.player_inputs[player_id]
            return True
        return False

    def get_player_count(self) -> int:
        """Get the number of active players."""
        return len(self.players)
