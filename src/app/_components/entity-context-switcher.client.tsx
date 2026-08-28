"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkspaceEntityContext } from "@/modules/workspace/entity-context";

export function EntityContextSwitcher({
  context,
}: {
  context: WorkspaceEntityContext;
}) {
  const router = useRouter();
  const selectId = useId();
  const detailId = useId();
  const errorId = useId();
  const serverSelectedId = context.selectedEntity?.id ?? "";
  const [selection, setSelection] = useState(() => ({
    serverId: serverSelectedId,
    selectedId: serverSelectedId,
  }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const selectedId = selection.serverId === serverSelectedId
    ? selection.selectedId
    : serverSelectedId;

  if (!context.selectedEntity) {
    return (
      <div className="entity-context-empty" role="status">
        <strong>No legal entity</strong>
        <span>Complete organization setup to choose a working company.</span>
      </div>
    );
  }

  const selectedEntity = context.options.find((entity) => entity.id === selectedId) ??
    context.selectedEntity;

  async function updateSelection(entityId: string) {
    const previousId = selectedId;
    setSelection({ serverId: serverSelectedId, selectedId: entityId });
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/workspace/entity-context", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId }),
      });
      if (response.status === 401) {
        router.refresh();
        return;
      }
      if (!response.ok) {
        let message = "The legal entity selection could not be saved.";
        try {
          const body: unknown = await response.json();
          if (typeof body === "object" && body !== null && "error" in body &&
              typeof body.error === "string") {
            message = body.error;
          }
        } catch {
          // Keep the safe fallback when an upstream response is not JSON.
        }
        throw new Error(message);
      }
      router.refresh();
    } catch (cause) {
      setSelection({ serverId: serverSelectedId, selectedId: previousId });
      setError(cause instanceof Error ? cause.message : "The legal entity selection could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="entity-context-switcher" aria-label="Working legal entity">
      <label htmlFor={selectId}>
        <span>Working entity</span>
        <select
          id={selectId}
          value={selectedId}
          disabled={pending || context.options.length < 2}
          aria-describedby={`${detailId}${error ? ` ${errorId}` : ""}`}
          onChange={(event) => void updateSelection(event.target.value)}
        >
          {context.options.map((entity) => (
            <option key={entity.id} value={entity.id}>
              {entity.code} — {entity.displayName}
            </option>
          ))}
        </select>
      </label>
      <span id={detailId} className="entity-context-detail">
        <strong>{selectedEntity.functionalCurrency}</strong>
        <span>{selectedEntity.periodLabel ?? "No current period"}{selectedEntity.periodState
          ? ` · ${selectedEntity.periodState.replaceAll("_", " ")}`
          : ""}</span>
        {pending && <span role="status">Switching…</span>}
      </span>
      {error && <span id={errorId} className="entity-context-error" role="alert">{error}</span>}
    </div>
  );
}
