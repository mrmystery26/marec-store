extends Control
## The smallest game that uses the MAREC SDK. Copy this pattern into your first scene.
## (It looks the SDK up by name so this file still loads in projects where the plugin is not on.)


func _ready() -> void:
	var sdk = get_node_or_null("/root/MarecSDK")
	if sdk == null:
		push_error("Enable the MAREC SDK plugin first (Project > Project Settings > Plugins).")
		return

	if not await sdk.ensure_authorized():
		return  # the SDK has already told the player why and is closing the game

	var label := Label.new()
	label.text = "Welcome! This game was started as: %s" % sdk.info.get("kind", "?")
	add_child(label)
