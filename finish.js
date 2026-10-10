// Plugin OpenCode V2: powiadomienie na ntfy po zakończeniu pracy modelu.
//
// Problem: gdy model skończy pracę w sesji (i podsumuje, co zrobił), nic nas o
// tym nie informuje — trzeba pilnować terminala. Ten plugin nasłuchuje zdarzeń
// serwera i wysyła na ntfy krótkie powiadomienie z tym, czego dotyczyła sesja
// (jej tytuł) oraz w jakim folderze roboczym praca się odbyła.
//
// Ten plik nie importuje `@opencode/plugin` — lokalny katalog pluginu nie ma
// `node_modules`, a loader OpenCode przyjmuje zwykły obiekt `{ id, setup }`.

import { assistantText, buildNotification, normalizeOptions, notificationKey } from "./core.js"

const PREFIX = "[finish-notification]"

// Wszystkie instancje pluginu dzielą jeden proces serwera OpenCode (plugin
// ładuje się raz na lokalizację, a przy zmianach potrafi doładować się
// ponownie). Każda subskrybuje cały strumień zdarzeń, więc bez wspólnej
// deduplikacji to samo zdarzenie wysyła N powiadomień. Rejestr na `globalThis`
// jest wspólny dla procesu, a sprawdzenie i zapis klucza wykonujemy
// synchronicznie — zanim jakikolwiek `await` pozwoli innym instancjom wejść.
const REGISTRY_KEY = "__opencodeFinishNotification"

function registry() {
  if (!globalThis[REGISTRY_KEY]) globalThis[REGISTRY_KEY] = { claims: new Map() }
  return globalThis[REGISTRY_KEY]
}

// Zwraca `true` tylko dla pierwszej instancji, która widzi dane zdarzenie.
// Kluczem jest identyfikator zdarzenia (`event.id`); gdy go nie ma, używa
// krótkiego okna czasowego na parę typ+sesja.
export function claim(event) {
  const reg = registry()
  const now = Date.now()
  const eventID = typeof event?.id === "string" && event.id.length > 0 ? event.id : undefined

  if (eventID) {
    const key = `id:${eventID}`
    if (reg.claims.has(key)) return false
    reg.claims.set(key, now)
  } else {
    const key = `dyn:${event?.type ?? "?"}:${event?.data?.sessionID ?? "?"}`
    const previous = reg.claims.get(key)
    if (previous !== undefined && now - previous < 1500) return false
    reg.claims.set(key, now)
  }

  // Sprzątanie starych wpisów, by mapa nie rosła w nieskończoność.
  if (reg.claims.size > 2000) {
    for (const [key, time] of reg.claims) {
      if (now - time > 10 * 60_000) reg.claims.delete(key)
    }
  }
  return true
}

export default {
  id: "opencode-finish-notification",

  async setup(ctx) {
    const cfg = normalizeOptions(ctx.options)
    const log = (...args) => console.log(PREFIX, ...args)
    const warn = (...args) => console.warn(PREFIX, ...args)

    if (!cfg.enabled) {
      log("wyłączony w konfiguracji")
      return
    }

    // Publikacja przez JSON ntfy (pole `topic` w treści) — pozwala na tytuł z
    // dowolnymi znakami (polskie znaki, emoji), inaczej niż nagłówki HTTP.
    const publish = async (payload) => {
      if (!cfg.ntfyTopic) return
      const endpoint = `${cfg.ntfyUrl.replace(/\/+$/, "")}/`
      const headers = { "Content-Type": "application/json; charset=utf-8" }
      if (cfg.ntfyToken) headers.Authorization = `Bearer ${cfg.ntfyToken}`
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ topic: cfg.ntfyTopic, ...payload }),
      })
      if (!response.ok) throw new Error(`ntfy HTTP ${response.status}`)
    }

    // Deduplikacja: kilka instancji pluginu (po jednej na lokalizację) widzi
    // to samo zdarzenie. Pamiętamy ostatnio powiadomiony klucz na sesję —
    // w pamięci i w trwałym magazynie pluginu (chroni też przed restartem).
    const lastSeen = new Map()
    const inflight = new Set()

    const alreadySent = async (sessionID, key) => {
      if (lastSeen.get(sessionID) === key) return true
      if (!cfg.dedupe || !ctx.storage) return false
      try {
        return (await ctx.storage.get(`notified/${sessionID}`)) === key
      } catch {
        return false
      }
    }

    const remember = async (sessionID, key) => {
      lastSeen.set(sessionID, key)
      if (!cfg.dedupe || !ctx.storage) return
      try {
        await ctx.storage.set(`notified/${sessionID}`, key)
      } catch {
        // brak magazynu nie może blokować powiadomienia
      }
    }

    const report = async (sessionID, outcome, error) => {
      if (inflight.has(sessionID)) return
      inflight.add(sessionID)
      try {
        let session
        try {
          session = await ctx.session.get({ sessionID })
        } catch (err) {
          warn(`sesja ${sessionID}: nie mogę odczytać metadanych (${err?.message ?? err})`)
          return
        }
        if (!session) return
        if (!cfg.includeSubagents && session.parentID) return

        let lastAssistant
        try {
          const messages = await ctx.session.context({ sessionID })
          lastAssistant = [...messages].reverse().find((message) => message.type === "assistant")
        } catch {
          // brak historii nie blokuje powiadomienia
        }

        const key = notificationKey(lastAssistant, session.time?.idle)
        if (await alreadySent(sessionID, key)) return

        const payload = buildNotification({
          session,
          outcome,
          error,
          summary: lastAssistant ? assistantText(lastAssistant) : "",
          cfg,
        })

        try {
          await publish(payload)
          await remember(sessionID, key)
          log(`sesja ${sessionID}: powiadomiono (${outcome}) — ${payload.title}`)
        } catch (err) {
          warn(`sesja ${sessionID}: powiadomienie nieudane (${err?.message ?? err})`)
        }
      } finally {
        inflight.delete(sessionID)
      }
    }

    const handle = async (event) => {
      const data = event?.data
      if (!data || typeof data.sessionID !== "string") return
      // Deduplikacja jeszcze przed jakimkolwiek `await` — inaczej równoległe
      // instancje zdążą wysłać powiadomienie zanim zobaczą wpis drugiej.
      if (!claim(event)) return
      switch (event.type) {
        case "session.execution.succeeded":
          await report(data.sessionID, "succeeded", data.error)
          break
        case "session.execution.failed":
          if (cfg.notifyOnFailure) await report(data.sessionID, "failed", data.error)
          break
        default:
          break
      }
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          void handle(event).catch((err) => warn(`obsługa zdarzenia: ${err?.message ?? err}`))
        }
      } catch (err) {
        if (!controller.signal.aborted) warn(`strumień zdarzeń zakończony: ${err?.message ?? err}`)
      }
    })()

    log(`aktywny (temat: ${cfg.ntfyTopic || "—"}, błędy: ${cfg.notifyOnFailure ? "tak" : "nie"})`)

    return () => controller.abort()
  },
}
