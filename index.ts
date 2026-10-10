// Punkt wejścia po stronie serwera OpenCode.
//
// Cała logika siedzi w `./finish.js` (czysty ESM, bez zależności), a czyste
// funkcje pomocnicze w `./core.js`. Ten podział pozwala testować plugin
// zwykłym Node (`npm test`), bez uruchamiania OpenCode.
export { default } from "./finish.js"
