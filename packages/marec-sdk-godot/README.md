# MAREC SDK for Godot

A small addon that makes your game check that **the player owns it and started it from the MAREC
Launcher**. Written in GDScript for Godot 4.7.2. This is protection level 1 ("launcher-gated").

**Status: prototype.** The rules it follows are written down as test vectors, and a separate Node
program is checked against them on every push. The GDScript itself has not been run in Godot yet:
its first real run is the *Godot SDK* workflow on GitHub, which runs the same vectors in Godot
4.7.2 with no window. The parts that need a real launcher (the local handover and the call to the
store) can only be checked by the manual test at the bottom.

## What protection this gives (and does not)

It stops casual sharing: a copied game folder will not start without the launcher and an account
that owns the game. It does **not** stop someone who edits the game's scripts or .pck file and
removes the check. No client-side check can. If something matters, keep it on a server (cloud saves,
multiplayer, leaderboards) so a cracked copy cannot use it.

## Add it to your game

1. Copy the `addons/marec_sdk` folder into your project's `addons` folder.
2. **Project > Project Settings > Plugins:** enable **MAREC SDK**. This adds the `MarecSDK`
   autoload.
3. Open `addons/marec_sdk/marec_config.gd` and fill in:
   - `GAME_ID`: your game's id in the MAREC store.
   - `API_BASE`: the store's API address.
   - `PUBLIC_KEY_PEM`: the `launch` public key from `GET <API_BASE>/v1/launch/public-keys` (the
     entry with `"use": "launch"`). It is a public key, so it is safe inside the game.
4. At the start of your first scene, wait for the check:

   ```gdscript
   func _ready() -> void:
       if not await MarecSDK.ensure_authorized():
           return  # the SDK has told the player why and is closing the game
       # ...start your game
   ```
5. Export as usual (Windows, x86_64). The config is a script, so Godot always exports it.
6. Upload the export with `tools/upload-build` and install it through the launcher.

See `example/main.gd` for the smallest possible use.

## Running and testing

- **Inside the Godot editor** (F5): there is no launcher, so with `EDITOR_BYPASS = true` the game
  runs anyway. This works only in the editor; an exported game never takes this path.
- **Outside the launcher** (double-clicking the exported .exe): the game shows "Please start this
  game from the MAREC Launcher." and closes.
- **From the launcher:** it passes the game a one-time local address and secret in
  `MAREC_LAUNCH_ADDR` and `MAREC_LAUNCH_SECRET`.

## How a launch is checked

1. The SDK connects to the launcher's local address and shows the secret. A program that does not
   know the secret gets nothing.
2. It receives a token signed by the store (RS256, a JWT).
3. `marec_verifier.gd` checks it: only RS256 is accepted, the signature must verify with your
   public key, the issuer and game id must match, and it must not be expired. (Godot can verify RSA
   signatures with its built-in `Crypto`, which is why launch tokens use RSA.)
4. The token's PC hash must match `MAREC_DEVICE_HASH` from the launcher.
5. For an online launch the SDK calls `POST /v1/launch/redeem`. The store marks the token as used, so
   a copied token cannot be replayed, and re-checks ownership.
6. An **offline lease** (a longer-lived signed pass the launcher can supply) is checked with no
   network. The SDK remembers the latest time it has seen, to notice the PC clock being set back.
   (The launcher does not deliver leases yet.)

## If it says no

| Code | Meaning |
|---|---|
| `NOT_LAUNCHED` | Started without the launcher. |
| `LAUNCHER_TIMEOUT` | The launcher did not answer within 10 seconds. |
| `INVALID_TOKEN`, `INVALID_SIGNATURE`, `WRONG_ISSUER` | The token is damaged or not from the store. |
| `WRONG_GAME` | The token is for another game (check `GAME_ID`). |
| `TOKEN_EXPIRED` | The launch took too long; start again. |
| `DEVICE_MISMATCH` | The token was issued for another PC. |
| `NOT_OWNED`, `BUILD_UNAVAILABLE`, `GAME_UNAVAILABLE`, `TOKEN_REVOKED` | The store refused (shown with a clear message). |
| `NETWORK_ERROR` | The store could not be reached to confirm the launch. |
| `LEASE_EXPIRED`, `CLOCK_ROLLBACK` | Offline pass ended, or the PC date looks wrong. |
| `BAD_CONFIG` | `marec_config.gd` is not filled in, or the public key is not valid. |

Connect to `MarecSDK.denied` or `MarecSDK.authorized` if you want to react yourself. Set
`QUIT_ON_DENIED = false` to handle the message in your own screen.

## Tests

```
node packages/marec-sdk-godot/tests/vectors.test.js          # the reference check (Node 22)
godot --headless --path packages/marec-sdk-godot --import
godot --headless --path packages/marec-sdk-godot --script res://tests/run_tests.gd
```

`tests/fixtures/vectors.json` holds 20 tokens (valid, expired, forged, algorithm tricks, wrong game,
clock tricks) and the result the SDK must give for each. Regenerate it with
`node tests/make-fixtures.js` if the token format ever changes, and change the backend first.

## Manual end-to-end check (needs the launcher and a backend)

1. Fill in `marec_config.gd` with your real values and export the example project as Windows.
2. Upload it as a build, publish it, add it to your library and install it in the launcher.
3. Press **Play**. You should see "Welcome! This game was started as: online".
4. Double-click the installed `.exe` directly. You should get the "start from the launcher" message.
5. Replay protection: get a token from `POST /v1/launch/authorizations` and call
   `POST /v1/launch/redeem` with it twice. The second answer must be `TOKEN_ALREADY_USED` (the backend
   tests cover this too).

## Not built yet

Developer test launches from the launcher (the backend supports `dev` tokens), delivering offline
leases from the launcher, a hardened GDExtension (level 2), periodic checks while playing and
server-side features (level 3).
