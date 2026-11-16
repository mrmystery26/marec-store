@tool
extends EditorPlugin
## Enabling the plugin (Project Settings > Plugins) adds the MarecSDK autoload for you.

const AUTOLOAD_NAME := "MarecSDK"
const AUTOLOAD_PATH := "res://addons/marec_sdk/marec_sdk.gd"


func _enable_plugin() -> void:
	add_autoload_singleton(AUTOLOAD_NAME, AUTOLOAD_PATH)


func _disable_plugin() -> void:
	remove_autoload_singleton(AUTOLOAD_NAME)
