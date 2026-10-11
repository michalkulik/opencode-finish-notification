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
  // Powiadom, gdy model zada użytkownikowi pytanie (formularz kind="question").
  notifyOnQuestion: true,
  // Powiadom o dowolnym innym formularzu (np. formularz integracji).
  notifyOnForms: false,
  // Powiadom, gdy OpenCode poprosi o zgodę (permission.asked).
  notifyOnPermission: false,
  // Dołącz skrót ostatniej wypowiedzi asystenta (podsumowanie pracy).
  includeSummary: true,
  summaryMaxChars: 400,
  // Priorytet ntfy: 1=min, 2=low, 3=default, 4=high, 5=urgent.
  priority: 3,
  failurePriority: 4,
  questionPriority: 4,
  permissionPriority: 4,
  // Emoji/tagi ntfy (bez dwukropków).
  tags: ["white_check_mark"],
  failureTags: ["warning"],
  questionTags: ["question"],
  formTags: ["clipboard"],
  permissionTags: ["lock"],
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
  if (input.notifyOnQuestion === false) cfg.notifyOnQuestion = false
  if (input.notifyOnForms === true) cfg.notifyOnForms = true
  if (input.notifyOnPermission === true) cfg.notifyOnPermission = true

  const summaryMaxChars = finiteInt(input.summaryMaxChars)
  if (summaryMaxChars !== undefined && summaryMaxChars >= 0) cfg.summaryMaxChars = summaryMaxChars

  const priority = finiteInt(input.priority)
  if (priority !== undefined && priority >= 1 && priority <= 5) cfg.priority = priority
  const failurePriority = finiteInt(input.failurePriority)
  if (failurePriority !== undefined && failurePriority >= 1 && failurePriority <= 5) cfg.failurePriority = failurePriority
  const questionPriority = finiteInt(input.questionPriority)
  if (questionPriority !== undefined && questionPriority >= 1 && questionPriority <= 5) cfg.questionPriority = questionPriority
  const permissionPriority = finiteInt(input.permissionPriority)
  if (permissionPriority !== undefined && permissionPriority >= 1 && permissionPriority <= 5) cfg.permissionPriority = permissionPriority

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
  if (input.questionTags !== undefined) {
    const tags = parseTags(input.questionTags)
    if (tags.length > 0) cfg.questionTags = tags
  }
  if (input.formTags !== undefined) {
    const tags = parseTags(input.formTags)
    if (tags.length > 0) cfg.formTags = tags
  }
  if (input.permissionTags !== undefined) {
    const tags = parseTags(input.permissionTags)
    if (tags.length > 0) cfg.permissionTags = tags
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

// Nazwa sesji do tytułu powiadomienia: tytuł, potem nazwa folderu.
function sessionTitle(session, directory) {
  const fromSession = typeof session?.title === "string" ? session.title.trim() : ""
  return fromSession || basename(session?.location?.directory ?? directory) || "Sesja OpenCode"
}

// Etykiety wszystkich wariantów z pól formularza (np. opcji pytania).
function formOptionLabels(form) {
  const fields = Array.isArray(form?.fields) ? form.fields : []
  const labels = []
  for (const field of fields) {
    for (const option of Array.isArray(field?.options) ? field.options : []) {
      const label = typeof option?.label === "string" && option.label.trim() ? option.label.trim() : option?.value
      if (label) labels.push(String(label))
    }
  }
  return labels
}

// Powiadomienie, gdy model zadaje pytanie / pokazuje formularz.
// `kind` to `form.metadata.kind` ("question" dla toola „question”).
export function buildFormNotification({ session, form, kind, directory, cfg }) {
  const dir = session?.location?.directory ?? directory ?? "?"
  const isQuestion = kind === "question"
  const lines = [isQuestion ? "❓ Pytanie do użytkownika" : "📋 Formularz od modelu"]

  const question = typeof form?.title === "string" ? form.title.trim() : ""
  if (question) {
    lines.push("")
    lines.push(excerpt(question, 400))
  }

  const options = formOptionLabels(form)
  if (options.length > 0) {
    lines.push("")
    lines.push(`Warianty: ${excerpt(options.join(" / "), 300)}`)
  }

  lines.push("")
  lines.push(`Folder: ${dir}`)
  if (session?.id) lines.push(`Sesja: ${session.id}`)

  return {
    title: sessionTitle(session, directory),
    message: lines.join("\n"),
    tags: isQuestion ? cfg.questionTags : cfg.formTags,
    priority: cfg.questionPriority,
  }
}

// Powiadomienie, gdy OpenCode prosi użytkownika o zgodę (permission.asked).
export function buildPermissionNotification({ session, request, directory, cfg }) {
  const dir = session?.location?.directory ?? directory ?? "?"
  const action = typeof request?.action === "string" && request.action.trim() ? request.action.trim() : "operacja"
  const resources = Array.isArray(request?.resources)
    ? request.resources
    : request?.resources
      ? [request.resources]
      : []

  const lines = ["🔐 Prośba o zgodę", "", action]
  for (const resource of resources.slice(0, 10)) lines.push(`• ${excerpt(String(resource), 200)}`)
  if (resources.length > 10) lines.push(`… i ${resources.length - 10} więcej`)
  lines.push("")
  lines.push(`Folder: ${dir}`)
  if (session?.id) lines.push(`Sesja: ${session.id}`)

  return {
    title: sessionTitle(session, directory),
    message: lines.join("\n"),
    tags: cfg.permissionTags,
    priority: cfg.permissionPriority,
  }
}

// Klucz deduplikacji: ostatni komunikat asystenta albo czas bezczynności.
export function notificationKey(lastAssistant, idleTime) {  if (lastAssistant && typeof lastAssistant.id === "string" && lastAssistant.id.length > 0) {
    return `msg:${lastAssistant.id}`
  }
  return `idle:${idleTime ?? 0}`
}
