"use client";

export function ReplayToolbar() {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900 p-3">
      <button className="rounded-md bg-neutral-800 px-3 py-2 text-sm">Play</button>
      <button className="rounded-md bg-neutral-800 px-3 py-2 text-sm">Pause</button>
      <button className="rounded-md bg-neutral-800 px-3 py-2 text-sm">Next</button>
      <button className="rounded-md bg-neutral-800 px-3 py-2 text-sm">Prev</button>
    </div>
  );
}
