import assert from "node:assert/strict"
import { test } from "node:test"

import finish from "../finish.js"

// Kolejka zdarzeń + zamockowany `fetch`, żeby sprawdzić całą ścieżkę wtyczki:
// zdarzenie -> pobranie sesji -> publikacja ntfy.
function makeHarness({ options = {}, session, messages = [], events } = {}) {
  const published = []
  const storage = new Map()
  const queue = [...(events ?? [])]
  const state = { session, messages }
  let wake

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    published.push({ url, body: JSON.parse(init.body), headers: init.headers })
    return { ok: true, status: 200 }
  }

  const ctx = {
    options,
    storage: {
      async get(key) {
        return storage.get(key)
      },
      async set(key, value) {
        storage.set(key, value)
      },
    },
    session: {
      async get() {
        return state.session
      },
      async context() {
        return state.messages
      },
    },
    event: {
      async *subscribe(opts) {
        const signal = opts?.signal
        signal?.addEventListener("abort", () => {
          const resolve = wake
          wake = undefined
          resolve?.()
        })
        while (!signal?.aborted) {
          while (queue.length > 0) yield queue.shift()
          if (signal?.aborted) return
          await new Promise((resolve) => {
            wake = resolve
          })
        }
      },
    },
  }

  return {
    ctx,
    published,
    storage,
    state,
    emit(event) {
      queue.push(event)
      const resolve = wake
      wake = undefined
      resolve?.()
    },
    restore() {
      globalThis.fetch = originalFetch
    },
  }
}

// Czeka, aż warunek będzie spełniony (pętla zdarzeń działa asynchronicznie).
async function waitFor(check, timeoutMs = 1500) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout oczekiwania")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test("wtyczka publikuje powiadomienie po session.execution.succeeded", async () => {
  const h = makeHarness({
    session: {
      id: "ses_1",
      title: "Dodaj powiadomienie ntfy",
      model: { providerID: "commandcode", id: "deepseek-v4.1-flash" },
      location: { directory: "/root/sources/opencode-finish-notification" },
      time: { idle: 42 },
    },
    messages: [{ type: "assistant", id: "msg_1", content: [{ type: "text", text: "Gotowe, wtyczka działa." }] }],
  })
  let stop
  try {
    stop = await finish.setup(h.ctx)
    h.emit({ id: "evt_1", type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
    await waitFor(() => h.published.length > 0)
    assert.equal(h.published.length, 1)
    const body = h.published[0].body
    assert.equal(body.topic, "opencode-finish-notification")
    assert.equal(body.title, "Dodaj powiadomienie ntfy")
    assert.match(body.message, /Folder: \/root\/sources\/opencode-finish-notification/)
    assert.match(body.message, /Gotowe, wtyczka działa\./)
    assert.equal(h.storage.get("notified/ses_1"), "msg:msg_1")
  } finally {
    stop?.()
    h.restore()
  }
})

test("wtyczka pomija sesje subagentów", async () => {
  const h = makeHarness({
    session: { id: "ses_child", parentID: "ses_root", location: { directory: "/tmp" } },
    messages: [{ type: "assistant", id: "msg_3", content: [{ type: "text", text: "sub" }] }],
  })
  let stop
  try {
    stop = await finish.setup(h.ctx)
    h.emit({ id: "evt_child", type: "session.execution.succeeded", data: { sessionID: "ses_child" } })
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(h.published.length, 0)
  } finally {
    stop?.()
    h.restore()
  }
})

test("wiele instancji pluginu wysyła powiadomienie tylko raz", async () => {
  delete globalThis.__opencodeFinishNotification
  const event = { id: "evt_dup_1", type: "session.execution.succeeded", data: { sessionID: "ses_dup" } }
  const session = { id: "ses_dup", title: "Wiele instancji", location: { directory: "/tmp/dup" } }
  const messages = [{ type: "assistant", id: "msg_dup", content: [{ type: "text", text: "ok" }] }]

  const instances = Array.from({ length: 6 }, () => makeHarness({ session, messages }))
  const stops = []
  try {
    for (const h of instances) stops.push(await finish.setup(h.ctx))
    for (const h of instances) h.emit(event)
    await new Promise((resolve) => setTimeout(resolve, 120))
    const total = instances.reduce((sum, h) => sum + h.published.length, 0)
    assert.equal(total, 1, "tylko jedna instancja ma wysłać powiadomienie")
  } finally {
    for (const stop of stops) stop()
    for (const h of instances) h.restore()
  }
})

test("kolejne zakończenie w tej samej sesji powiadamia ponownie", async () => {
  delete globalThis.__opencodeFinishNotification
  const session = { id: "ses_multi", title: "Dwa kroki", location: { directory: "/tmp/multi" } }
  const h = makeHarness({ session, messages: [{ type: "assistant", id: "msg_a", content: [{ type: "text", text: "krok 1" }] }] })
  let stop
  try {
    stop = await finish.setup(h.ctx)
    h.emit({ id: "evt_a", type: "session.execution.succeeded", data: { sessionID: "ses_multi" } })
    await waitFor(() => h.published.length === 1)

    h.state.messages = [{ type: "assistant", id: "msg_b", content: [{ type: "text", text: "krok 2" }] }]
    h.emit({ id: "evt_b", type: "session.execution.succeeded", data: { sessionID: "ses_multi" } })
    await waitFor(() => h.published.length === 2)
    assert.match(h.published[1].body.message, /krok 2/)
  } finally {
    stop?.()
    h.restore()
  }
})

test("wtyczka powiadamia o błędzie tylko, gdy włączone", async () => {
  const failedEvent = { id: "evt_fail", type: "session.execution.failed", data: { sessionID: "ses_4", error: { type: "provider.quota" } } }
  const disabled = makeHarness({
    options: { notifyOnFailure: false },
    session: { id: "ses_4", title: "E", location: { directory: "/tmp" } },
  })
  let stopDisabled
  try {
    stopDisabled = await finish.setup(disabled.ctx)
    disabled.emit(failedEvent)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(disabled.published.length, 0)
  } finally {
    stopDisabled?.()
    disabled.restore()
  }

  const enabled = makeHarness({
    session: { id: "ses_4", title: "E", location: { directory: "/tmp" } },
    messages: [{ type: "assistant", id: "msg_4", content: [] }],
  })
  let stopEnabled
  try {
    stopEnabled = await finish.setup(enabled.ctx)
    enabled.emit({ ...failedEvent, id: "evt_fail_2" })
    await waitFor(() => enabled.published.length > 0)
    assert.deepEqual(enabled.published[0].body.tags, ["warning"])
  } finally {
    stopEnabled?.()
    enabled.restore()
  }
})
