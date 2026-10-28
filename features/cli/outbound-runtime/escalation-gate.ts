import { escalationGateEnforced } from "../args"

// Shared verdict for BOTH escalation-format checks of the send pipeline (the parse-time
// warning attached by parseArgs, and the --table final-body check): print the
// checklist, then either hard-stop (DEFAULT, deny-by-default) or — under the
// one documented escape ESCALATION_GATE_ENFORCE=0 — downgrade to advisory and
// let the send proceed.
export function enforceEscalationGate(checklist: string, tag: string, env: NodeJS.ProcessEnv): void {
  console.error(checklist)
  if (escalationGateEnforced(env)) {
    console.error(
      `Blocked: --tag ${tag} must follow the decision-request format ` +
        "(deny-by-default). Fix the sections listed above and resend. " +
        "Genuine non-escalation / urgent edge case only: ESCALATION_GATE_ENFORCE=0 downgrades this to a warning.",
    )
    process.exit(1)
  }
  console.error("Advisory only (ESCALATION_GATE_ENFORCE=0) — sending anyway.")
}
