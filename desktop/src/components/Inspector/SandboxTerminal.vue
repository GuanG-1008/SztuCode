<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { sandboxExecute } from "../../services/sztu-runtime";

const props = defineProps<{ workspacePath: string }>();

const terminalRoot = ref<HTMLElement | null>(null);
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let command = "";
let busy = false;
let historyIndex = 0;
const history: string[] = [];

function prompt() {
  return `PS ${props.workspacePath}> `;
}

function writePrompt() {
  terminal?.write(prompt());
}

function replaceCommand(next: string) {
  if (!terminal) return;
  terminal.write(`\r\x1b[2K${prompt()}${next}`);
  command = next;
}

function writeOutput(value: string) {
  if (!terminal || !value) return;
  const normalized = value.replace(/\r?\n/g, "\r\n").replace(/\r\n$/, "");
  terminal.write(normalized);
  if (normalized) terminal.write("\r\n");
}

async function runCommand() {
  if (!terminal || busy) return;
  const submitted = command.trim();
  terminal.write("\r\n");
  command = "";
  if (!submitted) {
    writePrompt();
    return;
  }

  history.push(submitted);
  historyIndex = history.length;
  busy = true;
  try {
    const result = await sandboxExecute(props.workspacePath, submitted);
    writeOutput(result.stdout);
    writeOutput(result.stderr);
  } catch (error) {
    writeOutput(error instanceof Error ? error.message : String(error));
  } finally {
    busy = false;
    writePrompt();
  }
}

function handleData(data: string) {
  if (!terminal) return;
  if (data === "\r") {
    void runCommand();
    return;
  }
  if (busy) return;
  if (data === "\u0003") {
    terminal.write("^C\r\n");
    command = "";
    writePrompt();
    return;
  }
  if (data === "\u000c") {
    terminal.clear();
    writePrompt();
    return;
  }
  if (data === "\u007f") {
    if (command.length) {
      command = command.slice(0, -1);
      terminal.write("\b \b");
    }
    return;
  }
  if (data === "\u001b[A") {
    if (!history.length) return;
    historyIndex = Math.max(0, historyIndex - 1);
    replaceCommand(history[historyIndex] ?? "");
    return;
  }
  if (data === "\u001b[B") {
    if (!history.length) return;
    historyIndex = Math.min(history.length, historyIndex + 1);
    replaceCommand(history[historyIndex] ?? "");
    return;
  }
  if (data.startsWith("\u001b") || /[\u0000-\u001f]/.test(data)) return;
  command += data;
  terminal.write(data);
}

onMounted(() => {
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
  writePrompt();
  terminal.onData(handleData);
  terminalRoot.value.addEventListener("pointerdown", () => terminal?.focus());

  resizeObserver = new ResizeObserver(() => {
    requestAnimationFrame(() => fitAddon?.fit());
  });
  resizeObserver.observe(terminalRoot.value);
  requestAnimationFrame(() => {
    fitAddon?.fit();
    terminal?.focus();
  });
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  terminal?.dispose();
  resizeObserver = null;
  fitAddon = null;
  terminal = null;
});
</script>

<template>
  <div ref="terminalRoot" class="xterm-shell" aria-label="PowerShell 终端" />
</template>
