// Minimal toast helper. Queues into #toast-stack if present, otherwise
// lazily creates the container.

import { sentence } from "./ui.js";

function ensureStack() {
  let stack = document.getElementById("toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "toast-stack";
    stack.className = "toast-stack";
    document.body.appendChild(stack);
  }
  return stack;
}

/** A detail, such as what Sophos answered, goes on its own line under the message, so the message stays plain. */
export function toast(message, variant = "info", timeoutMs = 4000, detail = "") {
  const stack = ensureStack();
  const el = document.createElement("div");
  el.className = `toast toast-${variant}`;
  el.textContent = message;
  if (detail) {
    const d = document.createElement("div");
    d.className = "toast-detail";
    d.dataset.toastDetail = "";
    d.textContent = `Detail: ${sentence(detail)}`;
    el.appendChild(d);
  }
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast-fade");
    setTimeout(() => el.remove(), 400);
  }, timeoutMs);
}
