"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { GuidanceFile } from "@/modules/agent-guidance/service";

export function PlatformGuidanceEditor({ file }: { file: GuidanceFile | null }) {
  const router = useRouter();
  const [path, setPath] = useState(file?.path ?? "");
  const [summary, setSummary] = useState(file?.summary ?? "");
  const [content, setContent] = useState(file?.content ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function send(method: "PUT" | "DELETE") {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/platform/guidance", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(method === "PUT"
          ? { path, summary, content, expectedVersion: file?.version ?? 0 }
          : { path, expectedVersion: file?.version ?? 0 }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not save the file");
      setMessage(method === "PUT" ? "Saved a new version." : "File retired.");
      if (method === "PUT" && !file) router.push(`/app/platform/guidance?path=${encodeURIComponent(path)}`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update the file");
    } finally { setBusy(false); }
  }

  return <div className="form-stack">
    <label>Markdown path<input value={path} onChange={(event) => setPath(event.target.value)}
      readOnly={Boolean(file)} placeholder="tax/ontario.md" maxLength={120} /></label>
    <label>Short summary<input value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={240} /></label>
    <label>Plain Markdown<textarea value={content} onChange={(event) => setContent(event.target.value)}
      rows={16} maxLength={12_000} spellCheck={false} /></label>
    <p className="panel-note">Version {file?.version ?? 0} · each file is limited to 3,000 estimated tokens. Use references such as <code>platform:tax/ontario.md</code> to split topics.</p>
    <div className="button-row">
      <button className="primary-button" type="button" disabled={busy || !path || !summary || !content}
        onClick={() => { void send("PUT"); }}>Save version</button>
      {file && <button className="secondary-button" type="button" disabled={busy}
        onClick={() => { void send("DELETE"); }}>Retire file</button>}
    </div>
    {message && <p role="status">{message}</p>}
  </div>;
}
