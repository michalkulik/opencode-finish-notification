import assert from "node:assert/strict"
import { test } from "node:test"

import {
  DEFAULTS,
  assistantText,
  buildNotification,
  excerpt,
  normalizeOptions,
  notificationKey,
  parseTags,
} from "../core.js"

test("normalizeOptions: domyślny temat to opencode-finish-notification", () => {
  assert.equal(normalizeOptions().ntfyTopic, DEFAULTS.ntfyTopic)
})

test("normalizeOptions: scala z domyślnymi i odrzuca bzdury", () => {
  const cfg = normalizeOptions({
    ntfyTopic: "  inny-temat  ",
    priority: 99,
    failurePriority: 5,
    summaryMaxChars: -3,
    includeSubagents: true,
    notifyOnFailure: false,
  })
  assert.equal(cfg.ntfyTopic, "inny-temat")
  assert.equal(cfg.priority, DEFAULTS.priority, "nieprawidłowy priorytet zignorowany")
  assert.equal(cfg.failurePriority, 5)
  assert.equal(cfg.summaryMaxChars, DEFAULTS.summaryMaxChars, "ujemny limit zignorowany")
  assert.equal(cfg.includeSubagents, true)
  assert.equal(cfg.notifyOnFailure, false)
})

test("parseTags: przyjmuje string i tablicę, czyści dwukropki", () => {
  assert.deepEqual(parseTags("white_check_mark, warning"), ["white_check_mark", "warning"])
  assert.deepEqual(parseTags([":rocket:", "tada"]), ["rocket", "tada"])
  assert.deepEqual(parseTags(""), [])
})

test("assistantText: zbiera tylko części tekstowe", () => {
  const message = {
    type: "assistant",
    content: [
      { type: "reasoning", text: "hmm" },
      { type: "text", text: "Gotowe." },
      { type: "tool", name: "edit" },
      { type: "text", text: "Zmieniłem dwa pliki." },
    ],
  }
  assert.equal(assistantText(message), "Gotowe.\n\nZmieniłem dwa pliki.")
  assert.equal(assistantText(undefined), "")
})

test("excerpt: spłaszcza białe znaki i skraca", () => {
  assert.equal(excerpt("  a\n\nb   c ", 0), "a b c")
  assert.equal(excerpt("abcdef", 3), "abc…")
  assert.equal(excerpt("abc", 10), "abc")
})

test("notificationKey: preferuje id komunikatu, potem czas bezczynności", () => {
  assert.equal(notificationKey({ id: "msg_1" }, 123), "msg:msg_1")
  assert.equal(notificationKey(undefined, 123), "idle:123")
})

test("buildNotification: sukces zawiera folder, model, sesję i skrót", () => {
  const payload = buildNotification({
    session: {
      id: "ses_abc",
      title: "Napraw bug w parserze",
      model: { providerID: "commandcode", id: "deepseek-v4.1-flash" },
      location: { directory: "/root/sources/projekt" },
    },
    outcome: "succeeded",
    summary: "Poprawiłem parser i dodałem test.",
    cfg: normalizeOptions(),
  })
  assert.equal(payload.title, "Napraw bug w parserze")
  assert.match(payload.message, /Zakończono pracę/)
  assert.match(payload.message, /Folder: \/root\/sources\/projekt/)
  assert.match(payload.message, /Model: commandcode\/deepseek-v4\.1-flash/)
  assert.match(payload.message, /Sesja: ses_abc/)
  assert.match(payload.message, /Poprawiłem parser/)
  assert.deepEqual(payload.tags, ["white_check_mark"])
  assert.equal(payload.priority, 3)
})

test("buildNotification: brak tytułu schodzi do nazwy folderu", () => {
  const payload = buildNotification({
    session: { id: "ses_x", location: { directory: "/root/sources/opencode-finish-notification/" } },
    outcome: "succeeded",
    summary: "",
    cfg: normalizeOptions(),
  })
  assert.equal(payload.title, "opencode-finish-notification")
})

test("buildNotification: błąd ma inny tag, priorytet i opis błędu", () => {
  const payload = buildNotification({
    session: { id: "ses_err", title: "Zadanie", location: { directory: "/tmp/x" } },
    outcome: "failed",
    error: { type: "provider.quota", message: "Rate limit exceeded" },
    summary: "cokolwiek",
    cfg: normalizeOptions(),
  })
  assert.match(payload.message, /Zakończono z błędem/)
  assert.match(payload.message, /Błąd: provider\.quota — Rate limit exceeded/)
  assert.deepEqual(payload.tags, ["warning"])
  assert.equal(payload.priority, 4)
})
