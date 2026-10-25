import type { SentenceLine } from "@tappet/workflow";

/**
 * Shows a workflow as editable sentences. Each phrase will become a control
 * that edits the underlying definition; for now they're read-only.
 */
export function SentenceView({ lines }: { lines: SentenceLine[] }) {
  return (
    <ol className="space-y-2">
      {lines.map((line, i) => (
        <li
          key={`${line.at}-${line.phrase}-${i}`}
          className="flex items-baseline gap-2"
          style={{ paddingLeft: `${line.depth * 1.5}rem` }}
        >
          <span className="shrink-0 rounded-md bg-accent-soft px-2 py-0.5 text-sm font-medium text-accent">
            {line.phrase}
          </span>
          {line.text && (
            <button
              type="button"
              className="rounded-md border-b border-dashed border-muted/50 text-left hover:border-accent"
              title="Editing phrases is coming soon"
            >
              {line.text}
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
