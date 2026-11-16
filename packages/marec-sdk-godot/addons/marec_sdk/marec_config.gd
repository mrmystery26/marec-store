extends RefCounted
## Edit these values for your game. This is a script (not a .cfg or .pem file) on purpose:
## Godot always exports scripts, so the values are guaranteed to be inside your exported game.

## Your game's id (a UUID) from the MAREC store.
const GAME_ID := "00000000-0000-0000-0000-000000000000"

## Address of the MAREC store API that confirms launches, with no trailing slash.
const API_BASE := "https://api.example.com"

## The launch public key: the entry with "use": "launch" from GET /v1/launch/public-keys.
## It is a PUBLIC key, so it is fine for it to be inside your game.
const PUBLIC_KEY_PEM := """-----BEGIN PUBLIC KEY-----
REPLACE_WITH_THE_LAUNCH_PUBLIC_KEY
-----END PUBLIC KEY-----"""

## When you press Play inside the Godot editor there is no launcher. With this on, the game
## runs anyway, but only inside the editor. Exported games never use this.
const EDITOR_BYPASS := true

## Show a message and close the game when the check fails.
const QUIT_ON_DENIED := true
