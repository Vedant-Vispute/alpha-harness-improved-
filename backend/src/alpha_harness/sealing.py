"""Sealing secrets at rest.

Secrets (the BRAIN password, Google API keys) are sealed with AES-256-GCM and stored as
opaque blobs in SQLite. The key lives in a single file created ``0600`` under the data
directory.

Threat model: this protects against casual disclosure — a stray backup, an accidental
`git add`, someone reading the database file — but **not** against an attacker who already
has your user account, since the key is readable by it. That is the deliberate trade for a
tool that must resume polling unattended after a restart without prompting for a passphrase.
"""

import contextlib
import os
import secrets
from typing import TYPE_CHECKING

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

if TYPE_CHECKING:
    from pathlib import Path

KEY_BYTES = 32  # AES-256
NONCE_BYTES = 12  # GCM standard


class SealError(RuntimeError):
    """Raised when a secret cannot be sealed or opened."""


def load_or_create_key(path: Path) -> bytes:
    """Return the master key, creating it 0600 on first use.

    The key is written and fsynced to a temporary file, then hard-linked into place. The
    link never overwrites, so ``path`` only ever appears complete, and a process that loses
    a first-start race reads the winner's key instead of keeping its own.
    """
    if path.exists():
        key = path.read_bytes()
        if len(key) != KEY_BYTES:
            raise SealError(
                f"Key at {path} is {len(key)} bytes, expected {KEY_BYTES}. "
                "Refusing to guess. Move it aside to generate a fresh one — "
                "stored secrets will need to be re-entered."
            )
        _tighten_permissions(path)
        return key

    key = secrets.token_bytes(KEY_BYTES)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(8)}")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(key)
            fh.flush()
            os.fsync(fh.fileno())
        try:
            os.link(tmp, path)
        except FileExistsError:
            return load_or_create_key(path)
    finally:
        tmp.unlink(missing_ok=True)
    # Best effort: Windows cannot open a directory (NTFS journals the link anyway), and
    # some mounts refuse fsync on one. The key is already in place either way.
    if os.name != "nt":
        with contextlib.suppress(OSError):
            dir_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
    return key


def _tighten_permissions(path: Path) -> None:
    mode = path.stat().st_mode & 0o777
    if mode & 0o077:
        # Tighten rather than merely complain; the user cannot act on a log line.
        path.chmod(0o600)


class Sealer:
    """Seals and opens secrets with a single AES-GCM key."""

    def __init__(self, key_path: Path) -> None:
        self._aead = AESGCM(load_or_create_key(key_path))

    def seal(self, plaintext: str, *, context: str) -> bytes:
        """Encrypt ``plaintext``.

        ``context`` is bound as additional authenticated data, so a blob sealed for one
        purpose cannot be silently substituted into another.
        """
        nonce = secrets.token_bytes(NONCE_BYTES)
        ct = self._aead.encrypt(nonce, plaintext.encode("utf-8"), context.encode("utf-8"))
        return nonce + ct

    def open(self, blob: bytes, *, context: str) -> str:
        """Decrypt a blob produced by :meth:`seal`."""
        if len(blob) <= NONCE_BYTES:
            raise SealError("Ciphertext is too short to contain a nonce")
        nonce, ct = blob[:NONCE_BYTES], blob[NONCE_BYTES:]
        try:
            return self._aead.decrypt(nonce, ct, context.encode("utf-8")).decode("utf-8")
        except InvalidTag as exc:
            raise SealError(
                "Could not decrypt secret: wrong key, wrong context, or corrupted data"
            ) from exc
