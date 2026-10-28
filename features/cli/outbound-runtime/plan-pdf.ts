// code-as-pdf / md-as-pdf passes of the send plan (tg-cli#817, baseline `tg` 2665-2747).
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FeatureMap } from "../../auto-attach/feature-flags"
import type { SendPlan } from "../../auto-attach/types"
import { applyCodePdfToPlan, convertCodeToPdf, resolveDevice } from "../../code-pdf/convert"
import { convertMdToPdf, isConvertibleMd, type ConvertDeps } from "../../md-pdf/convert"
import type { MergedEnv } from "./types"

function fileSizeOrMinusOne(p: string): number {
  try {
    return statSync(p).size
  } catch {
    return -1
  }
}

function runConverter(cmd: string[], timeoutMs: number): { exitCode: number; stderr: string } | null {
  try {
    const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs })
    return { exitCode: proc.exitCode ?? 1, stderr: proc.stderr.toString() }
  } catch {
    return null
  }
}

/**
 * Shared deps for both PDF passes (code-as-pdf + md-as-pdf). Pure I/O thunks; the feature modules stay
 * pure and testable.
 */
export function makePdfDeps(env: MergedEnv): ConvertDeps {
  return {
    run: runConverter,
    makeTempDir: () => mkdtempSync(join(tmpdir(), "tg-pdf-")),
    writeFile: (p, c) => writeFileSync(p, c),
    readFile: (p) => readFileSync(p, "utf8"),
    fileExists: (p) => existsSync(p),
    fileSize: fileSizeOrMinusOne,
    whichCmd: (name) => Bun.which(name),
    env,
  }
}

function removeDirBestEffort(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
}

export interface CodePdfOptions {
  noPdf: boolean | undefined
  pdfDevice: string | undefined
  withOriginal: boolean | undefined
}

/**
 * code-as-pdf: render disk-sourced code/config docs to a mobile PDF (features/code-pdf/convert.ts).
 * Telegram iOS previews raw .ts/.json/.yaml… uselessly; a wrapped, syntax-highlighted, phone-sized PDF
 * is the readable artifact. BY DEFAULT only the PDF is sent — the original is dropped (the CTO rule "по
 * умолчанию оригинал не шли"). `--with-original` keeps the raw file too; `--no-pdf` (or --no-feature
 * code-as-pdf) skips the render and attaches the original (today's behavior). Runs BEFORE md-as-pdf and
 * AFTER the marker swap. Markdown stays on the md-pdf path (detectCodeLang→null).
 */
export function applyCodePdfPass(
  plan: SendPlan,
  features: FeatureMap,
  opts: CodePdfOptions,
  deps: ConvertDeps,
  env: MergedEnv,
  pdfTempDirs: string[],
): void {
  if (features["code-as-pdf"] === false || opts.noPdf) return
  const device = resolveDevice(opts.pdfDevice, env)
  if (device.unknown) {
    const where = device.source === "env" ? "TG_PDF_DEVICE" : "--pdf-device"
    console.error(
      `tg: unknown ${where} '${device.requested}' — using ${device.name}. ` +
        "Known: iphone15pro, iphone15promax, iphonese, a4.",
    )
  }
  const result = applyCodePdfToPlan(
    plan.documents,
    { convert: (codePath) => convertCodeToPdf(codePath, deps, device.preset) },
    { withOriginal: opts.withOriginal === true },
  )
  plan.documents = result.documents
  pdfTempDirs.push(...result.tmpDirs) // removed after transmit
  // Failed renders leave no artifact on the wire — drop their temp dirs NOW
  // (otherwise a box with Chrome but no pandoc leaks /tmp on every send).
  for (const dir of result.failedTmpDirs) removeDirBestEffort(dir)
  for (const f of result.failures) {
    console.error(`Warning: code-as-pdf: ${f.path}: ${f.error} — attaching the original file`)
  }
}

/**
 * md-as-pdf: convert disk-sourced markdown documents to PDF (features/md-pdf/convert.ts). Runs AFTER
 * the marker swap, so a line-spec'd .md (now a memory marker copy) is intentionally left as markdown —
 * its marker comments would be invisible in a PDF. Conversion failure attaches the original .md
 * unchanged (BOM'd later for the preview).
 */
export function applyMdPdfPass(
  plan: SendPlan,
  features: FeatureMap,
  deps: ConvertDeps,
  pdfTempDirs: string[],
): void {
  if (features["md-as-pdf"] === false) return
  for (const doc of plan.documents) {
    if (!isConvertibleMd(doc) || doc.source.kind !== "disk") continue
    const { pdfPath, error, tmpDir } = convertMdToPdf(doc.source.path, deps)
    if (pdfPath) {
      doc.source = { kind: "disk", path: pdfPath }
      if (tmpDir) pdfTempDirs.push(tmpDir) // removed after transmit
    } else {
      console.error(`Warning: md-as-pdf: ${doc.source.path}: ${error} — attaching the original .md`)
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
    }
  }
}
