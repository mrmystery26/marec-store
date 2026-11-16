extends RefCounted
## Decides whether a launch token or offline lease is acceptable. It uses no scene tree and no
## network: give it the token, the public key, the game id and the time, and it answers.
##
## The rules are written down in tests/fixtures/vectors.json, which the tests check this file
## against. Change the rules there and in the backend first.

const ISSUER := "marec-store-api"
const KINDS := ["online", "dev", "lease"]
## Online tokens last 2 minutes. This much slack allows for a PC clock that is a little off; the
## backend makes the real decision when the token is redeemed.
const CLOCK_SKEW_ONLINE := 300.0
## How far the PC clock may sit behind what the lease or an earlier launch showed.
const ROLLBACK_TOLERANCE := 300.0


static func b64url_decode(text: String) -> PackedByteArray:
	var padded := text.replace("-", "+").replace("_", "/")
	while padded.length() % 4 != 0:
		padded += "="
	return Marshalls.base64_to_raw(padded)


static func _fail(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message, "claims": {}}


## Returns {"ok": bool, "code": String, "message": String, "claims": Dictionary}.
## `last_seen` is the latest server-side time this PC has seen before (0 if none), used to notice
## the clock being set back to stretch an offline lease.
static func verify(
	token: String,
	public_key_pem: String,
	game_id: String,
	now: float,
	last_seen: float = 0.0
) -> Dictionary:
	var parts := token.split(".")
	if parts.size() != 3:
		return _fail("INVALID_TOKEN", "The launch token is not valid. Please start the game again from the MAREC Launcher.")

	# Only RS256 is accepted. This closes the "alg: none" and "HS256 with the public key" tricks.
	var header = JSON.parse_string(b64url_decode(parts[0]).get_string_from_utf8())
	if typeof(header) != TYPE_DICTIONARY or header.get("alg", "") != "RS256":
		return _fail("INVALID_TOKEN", "The launch token is not valid. Please start the game again from the MAREC Launcher.")

	var key := CryptoKey.new()
	if key.load_from_string(public_key_pem, true) != OK:
		return _fail("BAD_CONFIG", "This game's MAREC public key is not set up correctly.")
	var digest := (parts[0] + "." + parts[1]).sha256_buffer()
	var crypto := Crypto.new()
	if not crypto.verify(HashingContext.HASH_SHA256, digest, b64url_decode(parts[2]), key):
		return _fail("INVALID_SIGNATURE", "The launch token could not be verified. Please start the game again from the MAREC Launcher.")

	var claims = JSON.parse_string(b64url_decode(parts[1]).get_string_from_utf8())
	if typeof(claims) != TYPE_DICTIONARY:
		return _fail("INVALID_TOKEN", "The launch token is not valid. Please start the game again from the MAREC Launcher.")
	for name in ["iss", "aud", "sub", "jti", "kind"]:
		if typeof(claims.get(name)) != TYPE_STRING or claims[name] == "":
			return _fail("INVALID_TOKEN", "The launch token is not valid. Please start the game again from the MAREC Launcher.")
	for name in ["exp", "iat"]:
		var kind_of_value := typeof(claims.get(name))
		if kind_of_value != TYPE_FLOAT and kind_of_value != TYPE_INT:
			return _fail("INVALID_TOKEN", "The launch token is not valid. Please start the game again from the MAREC Launcher.")
	if not KINDS.has(claims["kind"]):
		return _fail("INVALID_TOKEN", "The launch token is not valid. Please start the game again from the MAREC Launcher.")
	if claims["iss"] != ISSUER:
		return _fail("WRONG_ISSUER", "The launch token did not come from the MAREC store.")
	if claims["aud"] != game_id:
		return _fail("WRONG_GAME", "This launch token is for a different game.")

	var issued_at := float(claims["iat"])
	var expires_at := float(claims["exp"])
	if claims["kind"] == "lease":
		if now < issued_at - ROLLBACK_TOLERANCE:
			return _fail("CLOCK_ROLLBACK", "The date on this PC looks wrong. Set the correct date and connect to the internet once.")
		if last_seen > 0.0 and now < last_seen - ROLLBACK_TOLERANCE:
			return _fail("CLOCK_ROLLBACK", "The date on this PC looks wrong. Set the correct date and connect to the internet once.")
		if now > expires_at:
			return _fail("LEASE_EXPIRED", "Offline play has expired. Connect to the internet once to renew it.")
	elif now > expires_at + CLOCK_SKEW_ONLINE:
		return _fail("TOKEN_EXPIRED", "This launch took too long. Please start the game again from the MAREC Launcher.")

	return {"ok": true, "code": "ok", "message": "", "claims": claims}
