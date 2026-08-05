<script setup lang="ts">
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { onBeforeUnmount, onMounted, ref } from "vue";
import "@xterm/xterm/css/xterm.css";
import {
  sandboxPtyClose,
  sandboxPtyResize,
  sandboxPtyStart,
  sandboxPtyWrite,
} from "../../services/sztu-runtime";

const props = defineProps<{ workspacePath: string }>();
type PtyOutput = { session_id: string; data: number[] };

const terminalRoot = ref<HTMLElement | null>(null);
const sessionId = crypto.randomUUID();
const decoder = new TextDecoder();
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let unlistenOutput: UnlistenFn | null = null;
let inputDisposable: { dispose(): void } | null = null;
let resizeDisposable: { dispose(): void } | null = null;
let writeQueue = Promise.resolve();
const pendingInput: string[] = [];
let started = false;
let disposed = false;

function showError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  terminal?.writeln(`\r\n${message}`);
}

function sendInput(data: string) {
  if (!started) {
    pendingInput.push(data);
    return;
  }
  writeQueue = writeQueue.then(() => sandboxPtyWrite(sessionId, data)).catch(showError);
}

async function initialize() {
  if (!terminalRoot.value) return;
  terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: "block",
    convertEol: true,
    fontFamily: "Consolas, monospace",
    fontSize: 14,
    lineHeight: 1.08,
    letterSpacing: 0,
    scrollback: 3000,
    theme: {
      background: "#ffffff",
      foreground: "#111111",
      cursor: "#111111",
      cursorAccent: "#ffffff",
      selectionBackground: "#cfe2ff",
      black: "#111111",
      red: "#b42318",
      green: "#18794e",
      yellow: "#8a6116",
      blue: "#175cd3",
      magenta: "#8e3ba8",
      cyan: "#087e8b",
      white: "#f5f5f5",
      brightBlack: "#666666",
      brightRed: "#d92d20",
      brightGreen: "#16803d",
      brightYellow: "#a66f00",
      brightBlue: "#1570ef",
      brightMagenta: "#a445b8",
      brightCyan: "#0891a6",
      brightWhite: "#ffffff",
    },
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalRoot.value);
  terminal.writeln("Windows PowerShell");
  terminal.writeln("Copyright (C) Microsoft Corporation. All rights reserved.");
  terminal.writeln("");

  try {
    unlistenOutput = await listen<PtyOutput>("sandbox:pty-output", ({ payload }) => {
      if (payload.session_id !== sessionId || disposed) return;
      terminal?.write(decoder.decode(Uint8Array.from(payload.data), { stream: true }));
    });
    inputDisposable = terminal.onData(sendInput);
    fitAddon.fit();
    await sandboxPtyStart(sessionId, props.workspacePath, terminal.cols, terminal.rows);
    if (disposed) {
      await sandboxPtyClose(sessionId);
      return;
    }
    started = true;
    for (const data of pendingInput.splice(0)) sendInput(data);
    resizeDisposable = terminal.onResize(({ cols, rows }) => {
      void sandboxPtyResize(sessionId, cols, rows).catch(showError);
    });
    terminal.focus();
  } catch (error) {
    showError(error);
  }
}

onMounted(() => {
  if (!terminalRoot.value) return;
  terminalRoot.value.addEventListener("pointerdown", () => terminal?.focus());
  resizeObserver = new ResizeObserver(() => {
    requestAnimationFrame(() => {
      if (terminalRoot.value?.clientWidth && terminalRoot.value.clientHeight) fitAddon?.fit();
    });
  });
  resizeObserver.observe(terminalRoot.value);
  void initialize();
});

onBeforeUnmount(() => {
  disposed = true;
  resizeObserver?.disconnect();
  inputDisposable?.dispose();
  resizeDisposable?.dispose();
  unlistenOutput?.();
  if (started) void sandboxPtyClose(sessionId);
  terminal?.dispose();
  resizeObserver = null;
  inputDisposable = null;
  resizeDisposable = null;
  unlistenOutput = null;
  fitAddon = null;
  terminal = null;
});
</script>

<template>
  <div ref="terminalRoot" class="xterm-shell" aria-label="PowerShell 终端" />
</template>
