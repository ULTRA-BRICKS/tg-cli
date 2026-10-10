# Prepared calbot consumer (not deployed)

`call-lib.ts` is a Bun/TypeScript adapter, ready to be copied/imported by the calbot
consumer during a separately planned migration. It imports no calendar code and
runs the independent installed wheel through a supplied Python executable:

```ts
const command = ['/absolute/independent/runtime/bin/python', '-m', 'telegram_client.bridge'];
const info = await callLib(command, {protocol: 1, action: 'describe'});
// info.library identifies tg-call-lib 0.1.0 and the exact installed module file.
```

For a separately authorized call, `action: 'start'` carries a providers config,
independent authstore path, and three explicit consent booleans. The adapter owns
its child process, forwards cancellation as SIGTERM, and escalates only its own
child after five seconds. The Python runner cancels the shared call owner, which
hangs up and releases auth/resources. No calbot application API is called.

The Python runner and the `tg-call start` CLI both invoke
`telegram_client.call_lib.start_conversation`. They do not duplicate call logic.
Install the same wheel in the chosen independent runtime and pass that runtime to
both consumers. Do not point at the calbot venv or import its business agent into
call-lib. Existing running calbot is unchanged by this prepared adapter.

## Agent wrapper v1

An agent command receives one JSON request via stdin, closes stdin, and emits one
JSON object on stdout. Logs go to stderr. The metadata request is:

```json
{"action":"describe","protocol":"call-agent-json-v1"}
```

A real wrapper must answer without model calls:

```json
{"protocol":"call-agent-json-v1","backend":"production","ready":true}
```

Turn requests remain `{"userId":123,"transcript":"..."}` and replies are
`{"responseText":"...","endCall":false}`. The wrapper owns the selected agent's
persistent context and policies. `call-agent-mock` implements this protocol with
fixed text; its metadata says `backend: "mock"`, which the live owner rejects.
Metadata is a configured wrapper's assertion, not proof of paid-model connectivity.
No production wrapper/backend is selected or installed by this change.
