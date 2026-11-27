"""The MAREC SDK's marec_config.gd, filled in for one game so nothing is edited by hand."""

_TEMPLATE = '''extends RefCounted
## Filled in by MAREC Store for this game. Put this file in addons/marec_sdk (replace the old one).
## It is a script (not a .cfg or .pem file) on purpose: Godot always exports scripts, so the
## values are guaranteed to be inside your exported game.

## Your game's id in the MAREC store.
const GAME_ID := "{game_id}"

## Address of the MAREC store API that confirms launches, with no trailing slash.
const API_BASE := "{api_base}"

## The launch public key from GET /v1/launch/public-keys (the entry with "use": "launch").
## It is a PUBLIC key, so it is fine for it to be inside your game.
const PUBLIC_KEY_PEM := """{public_pem}"""

## When you press Play inside the Godot editor there is no launcher. With this on, the game
## runs anyway, but only inside the editor. Exported games never use this.
const EDITOR_BYPASS := true

## Show a message and close the game when the check fails.
const QUIT_ON_DENIED := true
'''


def render(game_id: str, api_base: str, public_pem: str) -> str:
    for value in (game_id, api_base):
        if '"' in value or "\\" in value or "\n" in value:
            raise ValueError("Unsafe value for the SDK config.")
    return _TEMPLATE.format(
        game_id=game_id, api_base=api_base.rstrip("/"), public_pem=public_pem.strip()
    )
