"""Pinned offline Silero v5 package worker: JSON stdin -> 48k mono PCM16 stdout."""

import hashlib
import json
from pathlib import Path
import sys


def main():
    request = json.load(sys.stdin)
    path = Path(request["model"])
    if hashlib.sha256(path.read_bytes()).hexdigest() != request["sha256"]:
        raise ValueError("MODEL_HASH_MISMATCH")
    import torch

    # Local package only: unlike torch.hub.load this cannot download a model.
    model = torch.package.PackageImporter(str(path)).load_pickle("tts_models", "model")
    model.to(torch.device("cpu"))
    audio = model.apply_tts(
        text=request["text"], speaker=request["speaker"], sample_rate=48000
    )
    pcm = (
        (audio.detach().cpu().clamp(-1, 1) * 32767)
        .to(torch.int16)
        .numpy()
        .astype("<i2")
        .tobytes()
    )
    sys.stdout.buffer.write(pcm)


if __name__ == "__main__":
    main()
