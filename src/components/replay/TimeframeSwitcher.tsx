"use client";

export function TimeframeSwitcher() {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900 p-3">
      <button className="rounded-md bg-neutral-800 px-3 py-2 text-sm">M1</button>
      <button className="rounded-md bg-neutral-800 px-3 py-2 text-sm">M5</button>
      <button className="rounded-md bg-neutral-800 px-3 py-2 text-sm">M15</button>
      <button className="rounded-md bg-neutral-800 px-3 py-2 text-sm">H1</button>
      <button className="rounded-md bg-neutral-800 px-3 py-2 text-sm">H4</button>
    </div>
  );
}
