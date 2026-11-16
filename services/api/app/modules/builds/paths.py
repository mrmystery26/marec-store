import re

# Scripts and installers have no place inside a game build. (This is a policy check, not a
# malware scan: executables such as the game's own .exe are allowed.)
BLOCKED_EXTENSIONS = frozenset(
    {
        ".bat",
        ".cmd",
        ".ps1",
        ".vbs",
        ".vbe",
        ".wsf",
        ".hta",
        ".scr",
        ".msi",
        ".lnk",
        ".com",
        ".pif",
        ".reg",
        ".jar",
    }
)
_RESERVED = frozenset(
    {"con", "prn", "aux", "nul"}
    | {f"com{n}" for n in range(1, 10)}
    | {f"lpt{n}" for n in range(1, 10)}
)
_FORBIDDEN_CHARS = re.compile(r'[\x00-\x1f\x7f\\:*?"<>|]')


def validate_path(path: str) -> str | None:
    """Returns an error message, or None if the path is safe to install on Windows.
    Blocks traversal (..), absolute paths, drive letters, reserved device names and alternate
    data streams, because the launcher writes these paths onto the player's disk."""
    if not path or len(path) > 240:
        return "Path must be 1 to 240 characters."
    if _FORBIDDEN_CHARS.search(path):
        return "Path contains a forbidden character (use / as the separator)."
    if path.startswith("/"):
        return "Path must be relative."
    for segment in path.split("/"):
        if segment in ("", ".", ".."):
            return "Path contains an empty, . or .. segment."
        if segment.endswith((".", " ")) or segment.startswith(" "):
            return "Path segments cannot start with a space or end with a dot or space."
        if segment.split(".", 1)[0].lower() in _RESERVED:
            return "Path uses a reserved Windows name."
    dot = path.rfind(".")
    if dot > path.rfind("/") and path[dot:].lower() in BLOCKED_EXTENSIONS:
        return f"Files of type {path[dot:].lower()} are not allowed in game builds."
    return None
