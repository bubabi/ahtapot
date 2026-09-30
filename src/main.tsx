import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/jetbrains-mono";
import ReactDOM from "react-dom/client";
import App, { ErrorBoundary } from "./App";
import "./styles.css";

const fonts = ["13px 'Instrument Sans Variable'", "12.5px 'JetBrains Mono Variable'"].map((f) => document.fonts.load(f));

Promise.allSettled(fonts).then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
});
