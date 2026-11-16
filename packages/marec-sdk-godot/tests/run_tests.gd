extends SceneTree
## Run from the command line (no window):
##   godot --headless --path packages/marec-sdk-godot --script res://tests/run_tests.gd
## Exit code 0 means every check passed.

const Verifier := preload("res://addons/marec_sdk/marec_verifier.gd")

var _checks := 0
var _failures := 0


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if not condition:
		_failures += 1
		printerr("FAIL: %s" % message)


func _initialize() -> void:
	var vectors = JSON.parse_string(FileAccess.get_file_as_string("res://tests/fixtures/vectors.json"))
	if typeof(vectors) != TYPE_DICTIONARY:
		printerr("Could not read tests/fixtures/vectors.json")
		quit(2)
		return

	for entry in vectors["cases"]:
		var result := Verifier.verify(
			entry["token"],
			vectors["public_key_pem"],
			entry["game_id"],
			float(entry["now"]),
			float(entry["last_seen"])
		)
		var got: String = result["code"]
		_check(got == entry["expect"], "%s: expected %s, got %s" % [entry["name"], entry["expect"], got])

	_test_claims_are_returned(vectors)
	_test_base64url()
	_test_bad_key(vectors)

	print("%d checks, %d failed" % [_checks, _failures])
	quit(1 if _failures > 0 else 0)


func _test_claims_are_returned(vectors: Dictionary) -> void:
	for entry in vectors["cases"]:
		if entry["name"] == "valid online token":
			var result := Verifier.verify(
				entry["token"], vectors["public_key_pem"], entry["game_id"], float(entry["now"])
			)
			_check(result["ok"], "the valid token should be accepted")
			_check(result["claims"]["kind"] == "online", "claims should include the kind")
			_check(result["claims"]["sub"] == "22222222-2222-4222-8222-222222222222", "claims should include the user")
			return
	_check(false, "the 'valid online token' vector is missing")


func _test_base64url() -> void:
	_check(Verifier.b64url_decode("aGVsbG8").get_string_from_utf8() == "hello", "base64url without padding")
	_check(Verifier.b64url_decode("aGVsbG8h").get_string_from_utf8() == "hello!", "base64url, no padding needed")
	var bytes := Verifier.b64url_decode("-_8")
	_check(bytes.size() == 2 and bytes[0] == 251 and bytes[1] == 255, "the - and _ characters decode as + and /")


func _test_bad_key(vectors: Dictionary) -> void:
	var entry: Dictionary = vectors["cases"][0]
	var result := Verifier.verify(entry["token"], "not a key", entry["game_id"], float(entry["now"]))
	_check(result["code"] == "BAD_CONFIG", "an unusable public key is reported as a setup problem")
