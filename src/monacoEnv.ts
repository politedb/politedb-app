import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

(self as any).MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};
