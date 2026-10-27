"""Recapture exact TS white-box outputs with Bun; pytest itself never needs Bun.

Run from any cwd: BUN=/path/to/bun python tests/py/fixtures/render/capture.py.
Original test callbacks and their assertions are executed unchanged, except
imports of this task's helpers are wrapped to record arguments and full results.
Black-box sender/transport behavior belongs to the facade's parity gate.
"""

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
DESTINATION = Path(__file__).resolve().parent
MODULES = [
    "render/html",
    "render/tag",
    "render/rich",
    "render/table",
    "render/format-help",
    "render/help-color",
    "render/prefix",
    "prefix-style/style",
    "util/regex",
    "branding/emoji",
]
SUITES = [
    "render",
    "html-sanitize",
    "rich",
    "table",
    "tag",
    "prefix-agent",
    "prefix-style",
    "format-help",
    "help-color",
    "decomp-contracts",
]
HARNESS = (
    "\n"
    "import {expect} from 'bun:test';\n"
    "import * as emoji from '../features/branding/emoji';\n"
    "import * as tag from '../features/render/tag';\n"
    "import * as rich from '../features/render/rich';\n"
    "import * as help from '../features/render/format-help';\n"
    "import * as color from '../features/render/help-color';\n"
    "export {expect};\n"
    "let current:any;\n"
    "let suite='';\n"
    "const tests:any[]=[];\n"
    "const states:any[]=[];\n"
    "export function setSuite(name:string){suite=name;}\n"
    "export function test(name:string, callback:any){\n"
    "  // This transport case has no render invocations and belongs to Task 9.\n"
    "  if(name.startsWith('createTelegramTransport '))return;\n"
    "  tests.push({suite,name,callback});\n"
    "}\n"
    "export function record(module:string,fn:string,args:any[],out:any){\n"
    " const normalized=args.map(a=>typeof a==='function'?{callback:a('&<>\"\\'')}:a);\n"
    " const state={pills:emoji.TAG_PILL_IDS,embeddable:emoji.EMBEDDABLE_EMOJI_MAP,uni"
    "code:emoji.UNICODE_EMOJI_MAP};\n"
    " const snapshot=JSON.stringify(state);\n"
    " let index=states.findIndex(s=>JSON.stringify(s)===snapshot);\n"
    " if(index<0){index=states.length;states.push(JSON.parse(snapshot));}\n"
    " current.calls.push(JSON.parse(JSON.stringify({module,fn,args:normalized,out:out"
    "===undefined?null:out,state:index})));\n"
    "}\n"
    "export async function run(){\n"
    " const cases=[];\n"
    " for(const t of tests){current={suite:t.suite,name:t.name,calls:[]};await t.call"
    "back();cases.push(current);}\n"
    " const constants={\n"
    " 'branding.emoji':Object.fromEntries(Object.entries(emoji).filter(([k,v])=>typeo"
    "f v!=='function').map(([k,v])=>[k,v instanceof Set?[...v]:v])),\n"
    " 'render.tag':{CANONICAL_TAGS:tag.CANONICAL_TAGS,ACCEPTED_TAGS:tag.ACCEPTED_TAGS"
    ",ACCEPTED_TAGS_LIST:tag.ACCEPTED_TAGS_LIST,ESCALATION_TAGS:tag.ESCALATION_TAGS,R"
    "EMOVED_QUESTION_TAG_HINT:tag.REMOVED_QUESTION_TAG_HINT},\n"
    " 'render.rich':{RICH_LIMITS:rich.RICH_LIMITS,RICH_ONLY_TAGS:rich.RICH_ONLY_TAGS}"
    ",\n"
    " 'render.format_help':{FORMAT_HELP:help.FORMAT_HELP},\n"
    " 'render.help_color':{RESET:color.RESET,BOLD:color.BOLD,CYAN:color.CYAN,GREEN:co"
    "lor.GREEN}};\n"
    " await Bun.write(process.env.VECTOR_DEST!,JSON.stringify({cases,states,constants"
    "},null,2)+'\\n');\n"
    " process.stdout.write(`${cases.length} callbacks, ${cases.reduce((n,c)=>n+c.calls.length,"
    "0)} calls` + '\\n');\n"
    "}\n"
)


def main():
    bun = os.environ.get("BUN", "bun")
    with tempfile.TemporaryDirectory(prefix="capture-render-", dir=ROOT) as raw:
        capture = Path(raw)
        (capture / "harness.ts").write_text(HARNESS)
        for module in MODULES:
            source = (ROOT / f"features/{module}.ts").read_text()
            names = re.findall(r"export function (\w+)", source)
            code = (
                f'import * as original from "../features/{module}";\n'
                'import {record} from "./harness";\n'
            )
            for name in names:
                code += (
                    f"export const {name} = (...args:any[]) => {{"
                    f"const out=(original.{name} as any)(...args);"
                    f'record("{module}","{name}",args,out);return out;}};\n'
                )
            for name in re.findall(r"export const (\w+)", source):
                code += f"export const {name} = original.{name};\n"
            (capture / (module.replace("/", "_") + ".ts")).write_text(code)
        for suite in SUITES:
            source = (ROOT / f"tests/{suite}.test.ts").read_text()
            source = source.replace("from 'bun:test'", "from './harness'")
            source = re.sub(
                r"(['\"])\.\./features/(render/[^'\"]+|prefix-style/style|util/regex|branding/emoji)\1",
                lambda m: repr("./" + m[2].replace("/", "_")),
                source,
            )
            (capture / f"{suite}.ts").write_text(source)
        runner = 'import {run,setSuite} from "./harness";\n'
        runner += "\n".join(f'setSuite("{suite}");await import("./{suite}");' for suite in SUITES)
        runner += "\nawait run();\n"
        (capture / "runner.ts").write_text(runner)
        subprocess.run(
            [bun, "run", str(capture / "runner.ts")],
            cwd=ROOT,
            env={**os.environ, "VECTOR_DEST": str(DESTINATION / "ts_vectors.json")},
            check=True,
        )
    # Capture the requested CLI stdout, including console.log's final newline.
    result = subprocess.check_output([bun, "tg", "help", "format"], cwd=ROOT)
    (DESTINATION / "format_help_stdout.json").write_text(
        json.dumps({"stdout": result.decode()}, ensure_ascii=False, indent=2) + "\n"
    )
    data = json.loads((DESTINATION / "ts_vectors.json").read_bytes())
    data["source"] = "218a7a4"
    (DESTINATION / "ts_vectors.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
