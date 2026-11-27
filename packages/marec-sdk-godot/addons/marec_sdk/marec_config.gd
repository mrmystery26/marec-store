extends RefCounted
## This file is generated for each game. Do not fill it in by hand:
## open the MAREC Store launcher, go to Publisher portal > your game > "Download SDK config",
## and replace this file with the one you get. It contains your game's id, the store's address
## and the launch public key (a PUBLIC key, so it is fine for it to be inside your game).
##
## It is a script (not a .cfg or .pem file) on purpose: Godot always exports scripts, so the
## values are guaranteed to be inside your exported game.
##
## Until the real file is in place the SDK refuses to run and says BAD_CONFIG.

## Your game's id in the MAREC store.
const GAME_ID := ""

## Address of the MAREC store API that confirms launches, with no trailing slash.
const API_BASE := ""

## The launch public key (the entry with "use": "launch" from GET /v1/launch/public-keys).
const PUBLIC_KEY_PEM := ""

## When you press Play inside the Godot editor there is no launcher. With this on, the game
## runs anyway, but only inside the editor. Exported games never use this.
const EDITOR_BYPASS := true

## Show a message and close the game when the check fails.
const QUIT_ON_DENIED := true
