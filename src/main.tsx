import { render } from "preact";
import { platform } from "@tauri-apps/plugin-os";

import App from "./App";
import "./styles.css";

const p = platform(); // "macos" | "windows" | "linux"
document.documentElement.dataset.platform = p;

render(<App />, document.getElementById("root")!);
