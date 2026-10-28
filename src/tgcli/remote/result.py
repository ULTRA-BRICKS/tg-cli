"""What a subcommand hands the CLI: an exit code and the one JSON object it prints."""

from dataclasses import dataclass
from typing import Final

from tgcli.remote.protocol import JsonObject

# sysexits.h names, so the codes mean the same thing to every caller.
EXIT_USAGE: Final = 64
EXIT_DATA: Final = 65
EXIT_UNREACHABLE: Final = 69
EXIT_IO: Final = 74
EXIT_UNCERTAIN: Final = 75
EXIT_REFUSED: Final = 76
EXIT_CONFIG: Final = 78


@dataclass(frozen=True)
class Result:
    exit_code: int
    body: JsonObject
