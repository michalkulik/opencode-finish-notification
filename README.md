# opencode-finish-notification

Plugin OpenCode V2, który **wysyła powiadomienie na [ntfy](https://ntfy.sh)**,
gdy model zakończy pracę nad sesją. Powiadomienie zawiera:

- **czego dotyczyła sesja** — jej tytuł (np. „Napraw bug w parserze”),
- **folder roboczy** — katalog, w którym toczyła się praca,
- model, identyfikator sesji oraz skrót ostatniej wypowiedzi asystenta
  (podsumowanie pracy).

Domyślnie wysyła też powiadomienie, gdy praca zakończy się **błędem**.

## Jak to działa

1. Plugin subskrybuje strumień zdarzeń serwera (`ctx.event.subscribe`).
2. Nasłuchuje `session.execution.succeeded` (zakończenie pracy). Opcjonalnie
   także `session.execution.failed` (błąd).
3. Pobiera metadane sesji (`ctx.session.get`) — tytuł, folder, model — oraz
   ostatni komunikat asystenta (`ctx.session.context`).
4. Publikuje powiadomienie przez JSON ntfy (pole `topic` w treści), dzięki
   czemu tytuł może zawierać polskie znaki i emoji.

Sesje subagentów (mające `parentID`) są domyślnie pomijane, żeby nie dublować
powiadomień.

### Dlaczego powiadomienie nie mnoży się przez liczbę projektów

OpenCode ładuje plugin po jednej instancji na **lokalizację** (projekt), a
każda instancja subskrybuje cały strumień zdarzeń serwera. Bez wspólnej
deduplikacji to samo zakończenie wysyłałoby jedno powiadomienie na każdy
otwarty projekt. Plugin trzyma więc rejestr przetworzonych zdarzeń na
`globalThis` (wspólnym dla procesu serwera) i **synchronicznie** rezerwuje
`event.id`, zanim jakikolwiek `await` pozwoli wejść pozostałym instancjom.
Dzięki temu powiadomienie wysyła dokładnie jedna instancja, niezależnie od
tego, ile projektów ma załadowany plugin.

## Instalacja

Wpisz plugin w globalnym `~/.config/opencode/opencode.json` (działa wtedy dla
wszystkich sesji i projektów):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/root/sources/opencode-finish-notification",
      "options": {
        "ntfyTopic": "opencode-finish-notification"
      }
    }
  ]
}
```

Po zmianie konfiguracji zrestartuj usługę: `opencode service restart`.

## Opcje

| Opcja              | Domyślnie                          | Znaczenie                                             |
| ------------------ | ---------------------------------- | ----------------------------------------------------- |
| `enabled`          | `true`                             | Wyłącza cały plugin.                                  |
| `ntfyTopic`        | `"opencode-finish-notification"`   | Temat ntfy. Pusty = brak powiadomień.                 |
| `ntfyUrl`          | `"https://ntfy.sh"`                | Adres serwera ntfy (własny też).                      |
| `ntfyToken`        | `""`                               | Token dostępu (Bearer) do chronionego tematu.         |
| `notifyOnFailure`  | `true`                             | Powiadamiaj też o zakończeniu z błędem.               |
| `includeSubagents` | `false`                            | Powiadamiaj o sesjach subagentów (`parentID`).        |
| `includeSummary`   | `true`                             | Dołącz skrót ostatniej wypowiedzi asystenta.          |
| `summaryMaxChars`  | `400`                              | Długość skrótu (0 = bez skracania).                   |
| `priority`         | `3`                                | Priorytet ntfy dla sukcesu (1–5).                     |
| `failurePriority`  | `4`                                | Priorytet ntfy dla błędu (1–5).                       |
| `tags`             | `["white_check_mark"]`             | Tagi/emoji ntfy dla sukcesu.                          |
| `failureTags`      | `["warning"]`                      | Tagi/emoji ntfy dla błędu.                            |
| `dedupe`           | `true`                             | Blokuj powtórzenia tego samego zakończenia.           |

## Testy

```sh
npm test
```
