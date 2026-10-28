# Problem report actions and results

Every `tg --tag problem` report must say what the author has already done, what
actually happened, and what recovery action is being attempted now. This also applies
to `--automated`, stdin bodies, and senders without an agent identity. The same final
body is checked before sending or returning from `--dry-run`.

For example, this is a **sample format**, not evidence that these actions occurred:

```html
<h3>Context</h3><p>The watched chat is absent from Guardian's browser.</p><hr>
<h3>Already tried</h3>
<p>Listed browser tabs twice; result: chat 6ae07d22 was absent.</p><hr>
<h3>Doing now</h3>
<p>Opening the saved chat URL and verifying its chat identifier.</p><hr>
<h3>Where to look</h3><p><code>browser.tabs: chat 6ae07d22 missing</code></p>
```

Use the author's actual facts in the body. Plain `Already tried:` / `Doing now:` or
`Уже сделал:` / `Сейчас делаю:` labels work for automated reports. Agent reports also
keep the existing context/evidence and rich layout checks. A request to the user is
optional; the agent may be working autonomously.

If recovery cannot proceed, state the real failed attempts or access checks and their
results, why further action is blocked, the exact external dependency, and the retry or
verification to perform when it clears. Never claim to have run a check that was not run.
“Under observation,” an empty heading, “I checked,” or “I will investigate later” does
not satisfy the requirement. Quoted examples and code samples are not author actions;
command names and observed output in code/pre blocks remain usable evidence when the
author describes the action outside the literal.

A line break or `<br>` inside one sentence does not end it: "I am not<br>checking …" is
still a negation, while separate sentences, list items and labelled lines never share one.
Words such as `output` or `result` inside a code literal or file name (`output.log`,
`result.json`) name the checked target; only the author's own "result:" statement is the
observed result. Russian recovery verbs such as «чиню/чиним» count as current work unless
negated, future, quoted or empty.

A short report is enough. One named object plus an observed result satisfies the action
requirement: «Уже сделал: Перезапустил браузер; результат: вкладка не появилась» and
"Already tried: Restarted Chrome; result: the tab is still missing" both pass, and so does a
bare "exit 1" or "unknown host". Filler words ("the situation", "it", "this") name nothing,
and a result that is itself a deferral ("unknown.", "pending.", "позже", "will know later",
"TBD") has not been observed; an observed status such as "still pending after 20 minutes"
counts. The deterministic check is a content gate, not a grammar parser: Laya's score is the
second opinion. Scans are bounded (a clause, target or result is read within a fixed window
and only the nearest result markers are tried), so validation time is linear in the body
size: a 32 KiB body of repeated actions validates in milliseconds.

## Laya and offline operation

`laya-socket.ts` reuses task-cli's warm local classifier and the existing
`TG_LAYA_SOCKET`/discovery, `TG_LAYA`, and `TG_LAYA_TIMEOUT_MS` settings. It does not select
a provider/model, spawn a server, or call Telegram. Problem questions ask separately for
completed action plus observed result (`has_done`) and current recovery or an exact hard
dependency (`has_current`). A confident negative (probability at most 0.1) for either is a
rejection. Probabilities between 0.1 and 0.9 are inconclusive: live probes returned
middling scores for valid recovery reports, so those scores leave the deterministic
evidence check in charge. Positive scores never clear a deterministic failure:
future-only statements can fool the model.
This is a content check, not independent proof that an author's actions occurred.

The default problem inference deadline is 3000 ms (the older ask hint remains 1200 ms).
Disabled inference, no safe socket, timeout, connection errors, malformed replies, or an
oversized request produce an explicit unavailable diagnostic. Deterministic valid reports
still pass. The request is at most 16 KiB of serialized UTF-8, including both questions;
the full action sections are selected even after the first 2000 characters. Oversized
evidence is not truncated and then treated as missing. Only the author's own text is
submitted: no synthetic action headings are added to a bare symptom. The classifier
adapter persists neither the body nor a body hash.

`--dry-run` makes no classifier/socket/network call and needs no credentials. It checks
the deterministic contract and explicitly reports that semantic inference was skipped.
`ESCALATION_GATE_ENFORCE=0` cannot bypass this requirement. A rejected message exits 1
before the Bot API; the error names the missing evidence without fabricating a remedy.

## Monitoring incidents and internal delivery

`tg-ctl alert send` treats warning and critical alerts as problem reports. A raw signal
without the required evidence is withheld from Telegram and routed internally to its
exclusive source holder. A suspended or unreachable holder keeps the incident pending
(exit 5); subscribers are eligible only when the holder slot is vacant. No holder or
subscribed session means an explicit local failure (exit 3), with no delivery claim.
Internal acceptance confirms transport receipt, not that investigation or recovery began.

Complete reports still pass through `tg` and its report checks. If the owner post fails
or has no usable receipt, the incident is also routed internally with owner delivery
marked unconfirmed; the command exits 1 and leaves the owner retry eligible. Internal
receipts have separate throttle keys, so a later complete report with the same incident
key can reach Telegram independently.

Internal delivery persists the original incident text, claim identity, and recipient
state before I/O in the local alert throttle store. Retries keep that original text,
retain unconfirmed recipients, and skip acknowledged recipients across session resumes
and subscription changes. Replacement subscribers can receive the pending incident.
Before writing a send frame, the sender durably records that recipient's endpoint
generation. A lost acknowledgement can be reconciled by retrying the same live endpoint,
whose receipt cache deduplicates the request. A restarted endpoint has lost that cache:
an unresolved attempt returns `UNCERTAIN`, stays pending, and is not automatically replayed.
The same applies if acceptance was received but saving it failed. A host callback error
also leaves delivery uncertain because the callback may have performed part of its work.
Failures before connection record no attempt, so those recipients can retry after resume.
Missing or corrupt generation history is treated as uncertain. Check the session history
and reconcile the previous attempt before using an explicit `--force` for a fresh delivery;
the tool does not claim that uncertainty means successful delivery or completed recovery.
Unresolved internal receipts are preserved independently of ordinary throttle history:
neither age nor unrelated alerts may erase a possibly accepted delivery. This includes
an unresolved attempt to a recipient whose subscription was withdrawn. Up to 200
unresolved incidents are retained; when that budget is full, a new internal claim fails
before delivery and leaves all existing receipts intact. Acknowledgement releases that
protected slot. Ordinary history keeps its separate 24-hour/latest-200 limit, so complete
owner reports remain eligible. These records are distinct from the classifier adapter,
which stores no report body.

## Scope and Python migration

The current Python facade has no send handler and executes this checkout's TypeScript
sender. A regression invokes that facade and proves the same rejection. When Python
gains its own send implementation, retain these fixtures and the unconditional explicit
problem rule in the text-lint integration; the earlier port design's automated format
exemption must not become a remediation exemption.

This change addresses the explicit problem-tag action/result requirement from tg#25035
and tg#25331 and the corresponding part of tg-cli#800. It does not claim the broader
issue's all-tag semantic detection, per-item classification, metrics/audit, or justified
override work is complete. Existing untagged blocker/report follow-up handling remains
in the intent gate. The one shared change: the problem layout check (also used for an
untagged agent body the gate recognizes as a blocker) no longer requires an explicit
request to the human and requires the remediation facts above instead; untagged bodies
are still never sent to Laya for these questions.
