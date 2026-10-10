// Czysta logika pluginu — bez zależności od API OpenCode.
// Dzięki temu można ją testować zwykłym Node (`node --test`).
//
// Plugin wysyła powiadomienie na ntfy, gdy model zakończy pracę nad sesją.
// Zdarzenia serwera OpenCode 2.x:
//   - `session.execution.succeeded` — krok agenta zakończony sukcesem,
//     `data = { sessionID }` (to moment „po podsumowaniu pracy”),
//   - `session.execution.failed`    — krok zakończony błędem,
//     `data = { sessionID, error }`.
//
// Metadane sesji pochodzą z `ctx.session.get(...)` (schema `Session.Info`):
// `title`, `location.directory`, `model`, `cost`, `parentID`, `time.idle`.

export const DEFAULTS = {
  enabled: true,
  // Temat ntfy. Pusty string wyłącza powiadomienia.
  ntfyTopic: "opencode-finish-notification",
  ntfyUrl: "https://ntfy.sh",
  ntfyToken: "", // opcjonalny token dostępu (Bearer) do chronionego tematu
  // Powiadamiaj także, gdy praca zakończy się błędem.
  notifyOnFailure: true,
  // Powiadamiaj o sesjach subagentów (mają ustawione `parentID`).
  includeSubagents: false,
  // Dołącz skrót ostatniej wypowiedzi asystenta (podsumowanie pracy).
  includeSummary: true,
  summaryMaxChars: 400,
  // Priorytet ntfy: 1=min, 2=low, 3=default, 4=high, 5=urgent.
  priority: 3,
  failurePriority: 4,
  // Emoji/tagi ntfy (bez dwukropków).
  tags: ["white_check_mark"],
  failureTags: ["warning"],
  // Blokuj powtórne powiadomienie o tym samym zakończeniu (kilka instancji
  // pluginu — po jednej na lokalizację — widzi to samo zdarzenie).
  dedupe: true,
}

function finiteInt(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined
}

// Zamienia string ("a,b c") albo tablicę na listę niepustych tagów.
export function parseTags(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/) : []
  return list
    .filter((tag) => typeof tag === "string")
    .map((tag) => tag.trim().replace(/^:|:$/g, ""))
    .filter((tag) => tag.length > 0)
}

// Scala opcje użytkownika z domyślnymi, odrzucając wartości bez sensu.
export function normalizeOptions(raw) {
  const input = raw && typeof raw === "object" ? raw : {}
  const cfg = { ...DEFAULTS }

  if (input.enabled === false) cfg.enabled = false
  if (input.notifyOnFailure === false) cfg.notifyOnFailure = false
  if (input.includeSubagents === true) cfg.includeSubagents = true
  if (input.includeSummary === false) cfg.includeSummary = false
  if (input.dedupe === false) cfg.dedupe = false

  const summaryMaxChars = finiteInt(input.summaryMaxChars)
  if (summaryMaxChars !== undefined && summaryMaxChars >= 0) cfg.summaryMaxChars = summaryMaxChars

  const priority = finiteInt(input.priority)
  if (priority !== undefined && priority >= 1 && priority <= 5) cfg.priority = priority
  const failurePriority = finiteInt(input.failurePriority)
  if (failurePriority !== undefined && failurePriority >= 1 && failurePriority <= 5) cfg.failurePriority = failurePriority

  for (const key of ["ntfyTopic", "ntfyUrl", "ntfyToken"]) {
    if (typeof input[key] === "string") cfg[key] = input[key].trim()
  }
  if (cfg.ntfyUrl.length === 0) cfg.ntfyUrl = DEFAULTS.ntfyUrl

  if (input.tags !== undefined) {
    const tags = parseTags(input.tags)
    if (tags.length > 0) cfg.tags = tags
  }
  if (input.failureTags !== undefined) {
    const tags = parseTags(input.failureTags)
    if (tags.length > 0) cfg.failureTags = tags
  }

  return cfg
}

// Zbiera tekst z części komunikatu asystenta (pomija rozumowanie i narzędzia).
export function assistantText(message) {
  if (!message || !Array.isArray(message.content)) return ""
  return message.content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n\n")
    .trim()
}

// Skraca tekst do `maxChars`, spłaszczając białe znaki. 0 = bez skracania.
export function excerpt(text, maxChars) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
  if (!flat) return ""
  if (!maxChars || maxChars <= 0 || flat.length <= maxChars) return flat
  return flat.slice(0, maxChars).trimEnd() + "…"
}

function basename(directory) {
  if (typeof directory !== "string") return ""
  const parts = directory.replace(/\/+$/, "").split("/")
  return parts[parts.length - 1] ?? ""
}

// Buduje treść powiadomienia dla ntfy. `outcome` to "succeeded" | "failed".
export function buildNotification({ session, outcome, error, summary, cfg }) {
  const failed = outcome === "failed"
  const directory = session?.location?.directory ?? "?"
  const title = (typeof session?.title === "string" && session.title.trim()) || basename(directory) || "Sesja OpenCode"
  const model = session?.model ? `${session.model.providerID}/${session.model.id}` : undefined

  const lines = []
  lines.push(`${failed ? "❌ Zakończono z błędem" : "✅ Zakończono pracę"}`)
  lines.push(`Folder: ${directory}`)
  if (model) lines.push(`Model: ${model}`)
  lines.push(`Sesja: ${session?.id ?? "?"}`)
  if (failed && error) lines.push(`Błąd: ${error.type ?? "?"}${error.message ? ` — ${error.message}` : ""}`)

  const text = cfg.includeSummary ? excerpt(summary, cfg.summaryMaxChars) : ""
  if (text) {
    lines.push("")
    lines.push(text)
  }

  return {
    title,
    message: lines.join("\n"),
    tags: failed ? cfg.failureTags : cfg.tags,
    priority: failed ? cfg.failurePriority : cfg.priority,
  }
}

// Klucz deduplikacji: ostatni komunikat asystenta albo czas bezczynności.
export function notificationKey(lastAssistant, idleTime) {
  if (lastAssistant && typeof lastAssistant.id === "string" && lastAssistant.id.length > 0) {
    return `msg:${lastAssistant.id}`
  }
  return `idle:${idleTime ?? 0}`
}
