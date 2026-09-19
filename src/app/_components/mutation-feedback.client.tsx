"use client";

export type MutationFeedbackKind = "error" | "success" | "warning" | "info";

const feedbackTitles: Readonly<Record<MutationFeedbackKind, string>> = {
  error: "Action could not be completed",
  success: "Change saved",
  warning: "Review required",
  info: "Working on your request",
};

export function MutationFeedback({
  kind,
  message,
  onDismiss,
  title,
}: Readonly<{
  kind: MutationFeedbackKind;
  message: string;
  onDismiss?: () => void;
  title?: string;
}>) {
  return (
    <aside
      className={`mutation-notification mutation-notification-${kind}`}
      role={kind === "error" ? "alert" : "status"}
      aria-live={kind === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      data-testid="mutation-feedback"
      data-kind={kind}
    >
      <span className="mutation-notification-icon" aria-hidden="true">
        {kind === "error" ? "!" : kind === "success" ? "✓" : kind === "warning" ? "!" : "i"}
      </span>
      <div className="mutation-notification-copy">
        <strong>{title ?? feedbackTitles[kind]}</strong>
        <p>{message}</p>
      </div>
      {onDismiss && (
        <button
          type="button"
          className="mutation-notification-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss notification"
        >
          ×
        </button>
      )}
    </aside>
  );
}
