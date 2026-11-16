extends Node
## MarecSDK: checks that this game was started from the MAREC Launcher by a player who owns it.
##
## Add it as an autoload by enabling the plugin, fill in marec_config.gd, then at the start of
## your first scene:
##
##     func _ready() -> void:
##         if not await MarecSDK.ensure_authorized():
##             return  # the SDK has already told the player why and is closing the game
##
## How it works: the launcher starts the game with MAREC_LAUNCH_ADDR and MAREC_LAUNCH_SECRET in
## its environment. The SDK connects to that local address, shows the secret, and receives a
## signed token. It checks the signature with the public key in marec_config.gd, and (for online
## tokens) asks the MAREC store to mark the token as used, so a copied token cannot be reused.
##
## This is a deterrent against casual sharing, not copy protection: anyone who edits the game's
## scripts can remove it. Put things that matter on a server (cloud saves, multiplayer).

signal authorized(details: Dictionary)
signal denied(code: String, message: String)
signal finished

const Verifier := preload("res://addons/marec_sdk/marec_verifier.gd")
const Config := preload("res://addons/marec_sdk/marec_config.gd")
const CLOCK_FILE := "user://marec_clock.dat"
const TOKEN_WAIT_MS := 10000
const PLACEHOLDER_GAME_ID := "00000000-0000-0000-0000-000000000000"
const MESSAGES := {
	"NETWORK_ERROR": "Could not reach the MAREC store to confirm this game. Check your internet connection and try again.",
	"TOKEN_ALREADY_USED": "This launch was already used. Please start the game again from the MAREC Launcher.",
	"TOKEN_REVOKED": "This launch was cancelled. Please start the game again from the MAREC Launcher.",
	"TOKEN_EXPIRED": "This launch took too long. Please start the game again from the MAREC Launcher.",
	"NOT_OWNED": "This account does not own this game.",
	"BUILD_UNAVAILABLE": "This version of the game is no longer available. Please update it in the MAREC Launcher.",
	"GAME_UNAVAILABLE": "This game is not available right now.",
	"DEVICE_MISMATCH": "This launch was prepared for a different PC. Please start the game again from the MAREC Launcher.",
}

## True once the launch has been accepted.
var is_authorized: bool = false
## Id of the player's account (empty when running in the editor).
var user_id: String = ""
## Details of the result: kind ("online", "dev", "lease" or "editor"), session_id, and so on.
var info: Dictionary = {}

var _finished: bool = false


func _ready() -> void:
	_run.call_deferred()


## Waits for the check to finish and returns true if the game may continue.
func ensure_authorized() -> bool:
	if not _finished:
		await finished
	return is_authorized


func _run() -> void:
	# Pressing Play in the Godot editor: there is no launcher, so allow it. Exported games
	# never report the "editor" feature, so this cannot be switched on for players.
	if Config.EDITOR_BYPASS and OS.has_feature("editor"):
		_allow({"kind": "editor", "editor": true, "user_id": ""})
		return
	if Config.GAME_ID == PLACEHOLDER_GAME_ID:
		_deny("BAD_CONFIG", "The MAREC SDK has not been set up for this game (marec_config.gd).")
		return

	var address := OS.get_environment("MAREC_LAUNCH_ADDR")
	var secret := OS.get_environment("MAREC_LAUNCH_SECRET")
	if address.is_empty() or secret.is_empty():
		_deny("NOT_LAUNCHED", "Please start this game from the MAREC Launcher.")
		return

	var token: String = await _receive_token(address, secret)
	if token.is_empty():
		_deny("LAUNCHER_TIMEOUT", "The MAREC Launcher did not answer. Please start the game again from the launcher.")
		return

	var now := Time.get_unix_time_from_system()
	var result := Verifier.verify(token, Config.PUBLIC_KEY_PEM, Config.GAME_ID, now, _read_clock())
	if not result["ok"]:
		_deny(result["code"], result["message"])
		return
	var claims: Dictionary = result["claims"]

	# The launcher tells the game a hash of this PC's id. A token issued for another PC does not match.
	var device_hash := OS.get_environment("MAREC_DEVICE_HASH")
	if not device_hash.is_empty() and str(claims.get("dh", "")) != device_hash:
		_deny("DEVICE_MISMATCH", MESSAGES["DEVICE_MISMATCH"])
		return

	# Online and developer tokens are confirmed (and used up) with the store. A lease is checked
	# offline, which is its whole purpose.
	if claims["kind"] != "lease":
		var redeemed: Dictionary = await _redeem(token)
		if not redeemed["ok"]:
			_deny(redeemed["code"], redeemed["message"])
			return

	_write_clock(maxf(now, float(claims["iat"])))
	_allow(
		{
			"kind": claims["kind"],
			"user_id": claims["sub"],
			"session_id": claims["jti"],
			"dev": claims.get("dev", false),
			"editor": false,
		}
	)


func _receive_token(address: String, secret: String) -> String:
	var parts := address.split(":")
	if parts.size() != 2 or not parts[1].is_valid_int():
		return ""
	var peer := StreamPeerTCP.new()
	if peer.connect_to_host(parts[0], int(parts[1])) != OK:
		return ""

	var deadline := Time.get_ticks_msec() + TOKEN_WAIT_MS
	var sent := false
	var received := ""
	while Time.get_ticks_msec() < deadline:
		peer.poll()
		var status := peer.get_status()
		if status == StreamPeerTCP.STATUS_CONNECTED:
			if not sent:
				peer.put_data((secret + "\n").to_utf8_buffer())
				sent = true
			var available := peer.get_available_bytes()
			if available > 0:
				var chunk := peer.get_data(available)
				if chunk[0] == OK:
					received += (chunk[1] as PackedByteArray).get_string_from_utf8()
				if received.contains("\n"):
					peer.disconnect_from_host()
					return received.strip_edges()
		elif status == StreamPeerTCP.STATUS_ERROR:
			break
		await get_tree().create_timer(0.05).timeout
	peer.disconnect_from_host()
	return ""


func _redeem(token: String) -> Dictionary:
	var request := HTTPRequest.new()
	request.timeout = 15.0
	add_child(request)
	var url := Config.API_BASE.trim_suffix("/") + "/v1/launch/redeem"
	var headers := PackedStringArray(["Content-Type: application/json"])
	var error := request.request(url, headers, HTTPClient.METHOD_POST, JSON.stringify({"token": token}))
	if error != OK:
		request.queue_free()
		return {"ok": false, "code": "NETWORK_ERROR", "message": MESSAGES["NETWORK_ERROR"]}

	var response: Array = await request.request_completed
	request.queue_free()
	if response[0] != HTTPRequest.RESULT_SUCCESS:
		return {"ok": false, "code": "NETWORK_ERROR", "message": MESSAGES["NETWORK_ERROR"]}

	var data = JSON.parse_string((response[3] as PackedByteArray).get_string_from_utf8())
	if response[1] == 200 and typeof(data) == TYPE_DICTIONARY and data.get("ok", false) == true:
		return {"ok": true}
	var failure: Dictionary = {}
	if typeof(data) == TYPE_DICTIONARY and typeof(data.get("error")) == TYPE_DICTIONARY:
		failure = data["error"]
	var code := str(failure.get("code", "HTTP_%d" % response[1]))
	var message: String = MESSAGES.get(code, "The MAREC store did not allow this launch (%s)." % code)
	return {"ok": false, "code": code, "message": message}


func _read_clock() -> float:
	var file := FileAccess.open(CLOCK_FILE, FileAccess.READ)
	if file == null:
		return 0.0
	return file.get_as_text().to_float()


func _write_clock(value: float) -> void:
	var file := FileAccess.open(CLOCK_FILE, FileAccess.WRITE)
	if file != null:
		file.store_string(str(value))


func _allow(details: Dictionary) -> void:
	if _finished:
		return
	_finished = true
	is_authorized = true
	info = details
	user_id = str(details.get("user_id", ""))
	authorized.emit(details)
	finished.emit()


func _deny(code: String, message: String) -> void:
	if _finished:
		return
	_finished = true
	is_authorized = false
	info = {"code": code, "message": message}
	push_warning("MAREC SDK: launch denied (%s)" % code)
	denied.emit(code, message)
	finished.emit()
	if Config.QUIT_ON_DENIED:
		OS.alert(message, "MAREC")
		get_tree().quit(1)
