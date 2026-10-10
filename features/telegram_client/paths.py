"""Where the MTProto sidecar keeps state: inside tg's own config dir.

`install.sh` clones the tg-cli repo to ~/.local/share/tg-cli, so that directory is a git
checkout; sessions (each one IS the account) must never live there.
"""

import os
from pathlib import Path


def config_dir(env=os.environ):
    return Path(env.get("TG_CTL_CONFIG_DIR") or Path.home() / ".config" / "tg-cli")


def default_store(env=os.environ):
    return config_dir(env) / "mtproto"


def receipt_path(env=os.environ):
    return config_dir(env) / "ntgcalls-runtime-receipt.json"
