"""Speaks advisor lines in a cloned voice with F5-TTS (run by tools/gen-advisor.ts).

Reads jobs as JSON on stdin: [{"ref": clip, "refText": transcript or "", "text": line, "out": wav path}]
and loads the model once for all of them. An empty refText makes F5-TTS transcribe
the clip with Whisper (a big download the first time).
"""

import json
import sys

from f5_tts.api import F5TTS


def main() -> None:
    jobs = json.load(sys.stdin)
    if not jobs:
        return
    tts = F5TTS()
    for i, job in enumerate(jobs, 1):
        tts.infer(
            ref_file=job["ref"],
            ref_text=job["refText"],
            gen_text=job["text"],
            file_wave=job["out"],
            remove_silence=True,
        )
        print(f"  [{i}/{len(jobs)}] {job['text']}", flush=True)


if __name__ == "__main__":
    main()
